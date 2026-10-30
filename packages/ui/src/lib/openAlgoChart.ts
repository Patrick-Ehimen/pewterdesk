import type { Candle, CandleInterval, Market } from "@pewterdesk/core";
import type {
  Bar,
  BarsPage,
  BarsPageRequest,
  BarsRequest,
  DataFeed,
  PriceLineOptions,
} from "openalgo-charts";
import { registerInterval } from "openalgo-charts";
import type { DrawingInput, DrawingStyle } from "openalgo-charts/draw";
import type { LiveGate } from "../components/trading/ChartReplay";
import { ALL_INTERVALS } from "./indicators";
import type { ChartLevel } from "./tradeMarks";

// What the price chart (OpenAlgo Charts) needs from the app: where its
// bars come from, and how the app's markets and trade levels read in the
// chart's own terms. Display only, so prices go through JS numbers.

/**
 * Where the price chart gets a venue's candles. The app implements it
 * over its venue commands; the chart never reaches a venue itself.
 */
export interface BarSource {
  /** Up to `count` candles that opened before `before` (ms), oldest first; empty when there are no more. */
  history: (
    market: string,
    interval: CandleInterval,
    before: number,
    count: number,
  ) => Promise<Candle[]>;
  /**
   * A market's candles as they change: the first batch is the recent
   * history, later ones the live candles. Returns the unsubscribe.
   */
  subscribe: (
    market: string,
    interval: CandleInterval,
    onCandles: (candles: Candle[]) => void,
  ) => () => void;
  /**
   * The candles last seen for a market on this machine, oldest first, so a
   * chart can draw at once while the venue's history loads.
   */
  cached?: (market: string, interval: CandleInterval) => Candle[] | undefined;
}

/** Most candles asked of a venue in one request. */
export const MAX_BARS_PAGE = 1000;
/** Candles asked for when the chart names neither a count nor a start. */
const DEFAULT_BARS = 500;

export function toBar(candle: Candle): Bar {
  return {
    time: Math.floor(candle.openTime / 1000),
    open: Number(candle.open),
    high: Number(candle.high),
    low: Number(candle.low),
    close: Number(candle.close),
    volume: Number(candle.volume),
  };
}

/**
 * Months, as the chart names them. Its interval codes ignore case, so "1M"
 * would be read as a minute: months go to it as TradingView's "MN".
 */
const MONTH_CODES: Partial<Record<CandleInterval, string>> = {
  "1M": "1MN",
  "3M": "3MN",
  "6M": "6MN",
  "12M": "12MN",
};

let monthsRegistered = false;

/**
 * Tells the chart what the month codes mean: calendar months in UTC, as the
 * venues' candles (and Rust's grouped ones) open on the 1st at 00:00 UTC.
 */
export function registerMonthIntervals() {
  if (monthsRegistered) return;
  monthsRegistered = true;
  for (const [interval, code] of Object.entries(MONTH_CODES)) {
    registerInterval({
      code,
      bucketing: {
        mode: "calendar",
        unit: "month",
        count: Number.parseInt(interval, 10),
        timezone: "UTC",
      },
    });
  }
}

/** One of our intervals as the chart's interval code. */
export function chartCode(interval: CandleInterval): string {
  return MONTH_CODES[interval] ?? interval;
}

/** The chart's interval code as one of ours, if it is one. */
export function asInterval(code: string): CandleInterval | undefined {
  return ALL_INTERVALS.find((i) => chartCode(i) === code);
}

/**
 * The chart upper-cases every symbol it is given, and a venue's market ids
 * are case-sensitive ("kPEPE", "xyz:TSLA"): the market a chart symbol names.
 */
export function marketOfSymbol(markets: readonly Market[], symbol: string): Market | undefined {
  return (
    markets.find((m) => m.id === symbol) ??
    markets.find((m) => m.id.toUpperCase() === symbol.toUpperCase())
  );
}

function clampCount(count: number) {
  return Math.min(MAX_BARS_PAGE, Math.max(1, Math.ceil(count)));
}

/**
 * A `BarSource` as the chart's data feed. `markets` is read on every
 * request, so the feed outlives a refreshed market list. While `gate` is
 * held (a bar replay has the chart) live candles wait in it.
 */
export function barFeed(
  source: BarSource,
  markets: () => readonly Market[],
  gate?: LiveGate,
): DataFeed {
  const resolve = (req: BarsRequest) => {
    const market = marketOfSymbol(markets(), req.symbol);
    const interval = asInterval(req.interval);
    return market && interval ? { market: market.id, interval } : undefined;
  };
  const unknown = (req: BarsRequest) =>
    new Error(`No candles for ${req.symbol} at ${req.interval}`);

  return {
    // What this machine last saw draws at once; the venue's history replaces it.
    async getCachedBars(req: BarsRequest): Promise<Bar[] | undefined> {
      const found = resolve(req);
      const candles = found && source.cached?.(found.market, found.interval);
      return candles?.length ? candles.map(toBar) : undefined;
    },

    async getBars(req: BarsRequest): Promise<Bar[]> {
      const found = resolve(req);
      if (!found) throw unknown(req);
      const to = req.to ?? Math.floor(Date.now() / 1000);
      const seconds = intervalSeconds(found.interval);
      const count =
        req.countBack ?? (req.from === undefined ? DEFAULT_BARS : (to - req.from) / seconds + 1);
      // `before` is exclusive, and a bar opening exactly at `to` belongs.
      const candles = await source.history(
        found.market,
        found.interval,
        (to + 1) * 1000,
        clampCount(count),
      );
      const bars = candles.map(toBar);
      // A count was asked for: the start is only a hint then.
      if (req.countBack !== undefined || req.from === undefined) return bars;
      const from = req.from;
      return bars.filter((b) => b.time >= from);
    },

    async getBarsPage(req: BarsPageRequest): Promise<BarsPage> {
      const found = resolve(req);
      if (!found) throw unknown(req);
      const candles = await source.history(
        found.market,
        found.interval,
        req.before * 1000,
        clampCount(req.countBack),
      );
      const bars = candles.map(toBar);
      const oldest = bars[0];
      return oldest ? { bars, hasMore: true, nextBefore: oldest.time } : { bars, hasMore: false };
    },

    subscribeBars(req, onBar, opts) {
      const found = resolve(req);
      if (!found) return () => {};
      // The chart takes only the tail here: nothing older than what it has.
      let newest = opts?.seedFrom?.time ?? Number.NEGATIVE_INFINITY;
      let first = true;
      return source.subscribe(found.market, found.interval, (candles) => {
        // The first batch is the history the chart loaded for itself; only
        // its forming candle is news.
        const batch = first ? candles.slice(-1) : candles;
        first = false;
        for (const candle of batch) {
          const bar = toBar(candle);
          if (bar.time < newest) continue;
          newest = bar.time;
          if (gate?.held) gate.pending.set(bar.time, () => onBar(bar));
          else onBar(bar);
        }
      });
    },
  };
}

function intervalSeconds(interval: CandleInterval) {
  const unit = { m: 60, h: 3600, d: 86_400, w: 604_800, M: 31 * 86_400 }[interval.slice(-1)] ?? 60;
  return Number.parseInt(interval, 10) * unit;
}

/** The colours a trade level's line is drawn in, as on the standard chart. */
export interface LevelColors {
  buy: string;
  sell: string;
  warning: string;
  /** An open order's line. */
  order: string;
}

function levelColor(level: ChartLevel, colors: LevelColors) {
  switch (level.kind) {
    case "position":
      return level.side === "short" ? colors.sell : colors.buy;
    case "takeProfit":
      return colors.buy;
    case "stopLoss":
      return colors.sell;
    case "liquidation":
      return colors.warning;
    default:
      return colors.order;
  }
}

/** A level's line on the chart is known by this id, in the chart's drag events too. */
export const levelLineId = (level: ChartLevel) => `pd:${level.id}`;

/**
 * How much of the plot, from the price axis, a level's line spans. Like an
 * order line on a trading chart: its label sits clear of the readout in the
 * top-left corner, over the most recent candles.
 */
export const LEVEL_EXTENT = 0.45;

/**
 * Keeps a level's line out of the price scale's fit, so the candles keep
 * their scale: a liquidation price 10% away would otherwise squash them into
 * a band. Out of view, a line is still there when the scale is dragged to it.
 */
export function outOfAutoscale<T extends { autoscaleInfo(): unknown }>(line: T): T {
  line.autoscaleInfo = () => null;
  return line;
}

/**
 * A trade level as one of the chart's price lines, saying `label` (already
 * translated). It has no close button, and only a `movable` one (a TP or SL
 * the caller can set) can be dragged.
 */
export function levelLine(
  level: ChartLevel,
  label: string,
  colors: LevelColors,
  movable = false,
): PriceLineOptions {
  return {
    id: levelLineId(level),
    price: level.price,
    color: levelColor(level, colors),
    lineWidth: 1,
    lineStyle: level.kind === "position" ? "solid" : "dashed",
    leftLabel: label,
    extentFromRight: LEVEL_EXTENT,
    ...(movable ? { cursor: "ns-resize" } : {}),
  };
}

/**
 * A chart's own look as the caller keeps it (the Multi-chart page, per
 * chart): its style, indicators, panes and settings, never its market,
 * interval or the dates on screen.
 */
export interface KeptLayout {
  chartType: string;
  chart: unknown;
}

/** A kept layout read back, if it's one. */
export function keptLayout(saved: string | undefined): KeptLayout | undefined {
  if (!saved) return undefined;
  try {
    const raw: unknown = JSON.parse(saved);
    if (typeof raw !== "object" || raw === null) return undefined;
    const { chartType, chart } = raw as Record<string, unknown>;
    return typeof chartType === "string" && typeof chart === "object" && chart !== null
      ? { chartType, chart }
      : undefined;
  } catch {
    return undefined;
  }
}

/** What an analysis level is: how the AI analyst marked it on the chart. */
export type AnalysisKind = "support" | "resistance" | "entry" | "target" | "invalidation";

/** A level the AI analyst drew: a price and a few words. It isn't an order. */
export interface AnalysisLevel {
  price: number;
  kind: AnalysisKind;
  label: string;
}

/** A supply or demand zone: a price band from the candle it formed at. Times in ms. */
export interface AnalysisZone {
  kind: "supply" | "demand";
  start: number;
  /** Where it ends; null runs it a little past the latest candle. */
  end: number | null;
  top: number;
  bottom: number;
  label: string;
}

/** Two points (times in ms) and a label: a Fibonacci swing, or a trend line. */
export interface AnalysisSpan {
  from: { time: number; price: number };
  to: { time: number; price: number };
  label: string;
}

/** Everything the AI analyst drew on one market. */
export interface ChartAnalysis {
  levels: readonly AnalysisLevel[];
  zones?: readonly AnalysisZone[];
  fibs?: readonly AnalysisSpan[];
  trendLines?: readonly AnalysisSpan[];
}

/** The colours the analyst's drawings are drawn in. */
export interface AnalysisColors {
  buy: string;
  sell: string;
  warning: string;
  muted: string;
}

/** Ids of the analyst's drawings on a chart start with this. */
export const ANALYSIS_ID = "pd:ai:";

/** Bars a level's ray starts before the latest candle, and an open zone runs past it. */
const LEVEL_BARS_BACK = 40;
const ZONE_BARS_AHEAD = 12;

/**
 * The analyst's analysis as the chart's own drawings, pinned to time and
 * price so they stay put as the chart scrolls: zones as shaded rectangles,
 * Fibonacci retracements, trend lines, and each level as a horizontal ray
 * with its label beside it. They're the host's: read-only, and left out of
 * the saved drawings (a copy the trader makes is their own). `last` is the
 * latest candle's time and `bar` one candle's length, both in seconds.
 */
export function analysisDrawings(
  analysis: ChartAnalysis,
  colors: AnalysisColors,
  view: { last: number; bar: number },
): DrawingInput[] {
  const out: DrawingInput[] = [];
  const base = (tool: string, points: DrawingInput["points"], style: DrawingStyle) => ({
    id: `${ANALYSIS_ID}${out.length}`,
    tool,
    points,
    style,
    paneIndex: 0,
    policy: { editable: false, persistent: false },
  });
  const sec = (ms: number) => Math.floor(ms / 1000);
  for (const z of analysis.zones ?? []) {
    const color = z.kind === "demand" ? colors.buy : colors.sell;
    const end = z.end === null ? view.last + ZONE_BARS_AHEAD * view.bar : sec(z.end);
    out.push({
      ...base(
        "rectangle",
        [
          { time: sec(z.start), price: z.top },
          { time: Math.max(end, sec(z.start) + view.bar), price: z.bottom },
        ],
        { color, lineWidth: 1, fill: true, fillColor: color, fillOpacity: 0.14 },
      ),
      text: { value: z.label, color, fontSize: 11 },
    });
  }
  for (const f of analysis.fibs ?? []) {
    out.push(
      base(
        "fib-retracement",
        [
          { time: sec(f.from.time), price: f.from.price },
          { time: sec(f.to.time), price: f.to.price },
        ],
        { color: colors.muted, lineWidth: 1, showLabels: true },
      ),
    );
  }
  for (const l of analysis.trendLines ?? []) {
    out.push(
      base(
        "trend-line",
        [
          { time: sec(l.from.time), price: l.from.price },
          { time: sec(l.to.time), price: l.to.price },
        ],
        { color: colors.muted, lineWidth: 2 },
      ),
    );
  }
  const from = view.last - LEVEL_BARS_BACK * view.bar;
  for (const level of analysis.levels) {
    const color =
      level.kind === "support" || level.kind === "target"
        ? colors.buy
        : level.kind === "resistance"
          ? colors.sell
          : level.kind === "invalidation"
            ? colors.warning
            : colors.muted;
    out.push(
      base("horizontal-ray", [{ time: from, price: level.price }], {
        color,
        lineWidth: 1,
        lineStyle: "dashed",
        showLabels: true,
      }),
    );
    if (level.label) {
      out.push({
        ...base("text", [{ time: from, price: level.price }], { color }),
        text: { value: level.label, color, fontSize: 11 },
      });
    }
  }
  return out;
}

/** An economic release shown on a chart. Text only, as the calendar gives it. */
export interface ChartNewsEvent {
  id: string;
  /** Milliseconds since the Unix epoch. */
  time: number;
  title: string;
  impact: "high" | "medium";
  forecast?: string;
  previous?: string;
}

export interface NewsSpot {
  x: number;
  /** The releases this badge stands for, in time order. */
  ids: string[];
}

/**
 * Where the badges go: one at each release's time, and one for any within
 * `size` of it (the same time, or a chart zoomed out), at the first one's
 * time. Badges that would touch are eased right, to stay `spacing` apart.
 * `spots` run in time order.
 */
export function groupNews(
  spots: readonly { id: string; x: number }[],
  size: number,
  spacing: number,
): NewsSpot[] {
  const out: NewsSpot[] = [];
  let first = Number.NEGATIVE_INFINITY;
  for (const { id, x } of spots) {
    const last = out.at(-1);
    if (last && x - first < size) {
      last.ids.push(id);
      continue;
    }
    first = x;
    out.push({ x: last ? Math.max(x, last.x + spacing) : x, ids: [id] });
  }
  return out;
}
