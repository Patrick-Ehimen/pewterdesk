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
export function marketOfSymbol(
  markets: readonly Market[],
  chartSymbol: string,
): Market | undefined {
  const symbol = chartSymbol.split(CURRENCY_MARK)[0] ?? chartSymbol;
  return (
    markets.find((m) => m.id === symbol) ??
    markets.find((m) => m.id.toUpperCase() === symbol.toUpperCase())
  );
}

/** Up to `count` candles of a market that opened before `before` (UTC seconds), as the chart's. */
export async function barsBefore(
  source: BarSource,
  market: string,
  interval: CandleInterval,
  before: number,
  count: number,
): Promise<Bar[]> {
  return (await source.history(market, interval, before * 1000, clampCount(count))).map(toBar);
}

function clampCount(count: number) {
  return Math.min(MAX_BARS_PAGE, Math.max(1, Math.ceil(count)));
}

/** Exchange rates a chart can be shown in: display only, never an order's. */
export interface FxSource {
  /** Codes on offer, beside the market's own quote. */
  currencies: readonly string[];
  /** What a dollar is worth in `currency` at a UTC second, over this range. */
  rates: (currency: string, from: number, to: number) => Promise<(time: number) => number>;
}

/**
 * A chart in another currency is a symbol of its own ("BTC@NGN"): its candles
 * are converted, and its drawings, in those prices, stay apart from the market's.
 */
const CURRENCY_MARK = "@";

export const chartSymbol = (market: string, currency?: string) =>
  currency ? `${market}${CURRENCY_MARK}${currency}` : market;

export const symbolCurrency = (symbol: string): string | undefined =>
  symbol.split(CURRENCY_MARK)[1];

/** `bars` in the currency `rate` gives, each at its own time's rate. */
export function convertBars(bars: readonly Bar[], rate: (time: number) => number): Bar[] {
  return bars.map((bar) => {
    const r = rate(bar.time);
    return {
      ...bar,
      open: bar.open * r,
      high: bar.high * r,
      low: bar.low * r,
      close: bar.close * r,
    };
  });
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
  fx?: FxSource,
): DataFeed {
  /** The chart's candles in its currency: as they came, without one. */
  const inCurrency = async (req: BarsRequest, bars: Bar[]) => {
    const currency = symbolCurrency(req.symbol);
    const first = bars[0];
    const last = bars.at(-1);
    if (!currency || !first || !last) return bars;
    if (!fx) throw new Error(`No rates for ${currency}`);
    return convertBars(bars, await fx.rates(currency, first.time, last.time));
  };
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
      if (symbolCurrency(req.symbol)) return undefined;
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
      const bars = await inCurrency(req, candles.map(toBar));
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
      const bars = await inCurrency(req, candles.map(toBar));
      const oldest = bars[0];
      return oldest ? { bars, hasMore: true, nextBefore: oldest.time } : { bars, hasMore: false };
    },

    subscribeBars(req, onBar, opts) {
      const found = resolve(req);
      if (!found) return () => {};
      // The chart takes only the tail here: nothing older than what it has.
      let newest = opts?.seedFrom?.time ?? Number.NEGATIVE_INFINITY;
      let first = true;
      // Live candles take today's rate, and wait for it.
      const currency = symbolCurrency(req.symbol);
      let live: number | undefined;
      if (currency && fx) {
        const now = Math.floor(Date.now() / 1000);
        void fx.rates(currency, now, now).then(
          (rate) => {
            live = rate(now);
          },
          () => {},
        );
      }
      return source.subscribe(found.market, found.interval, (candles) => {
        // The first batch is the history the chart loaded for itself; only
        // its forming candle is news.
        const batch = first ? candles.slice(-1) : candles;
        first = false;
        for (const candle of batch) {
          const raw = toBar(candle);
          if (currency && live === undefined) continue;
          const bar =
            live === undefined ? raw : (convertBars([raw], () => live as number)[0] ?? raw);
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
  /** The chart's background: a plate behind each level's words, so lines don't run through them. */
  background?: string;
}

/** Ids of the analyst's drawings on a chart start with this. */
export const ANALYSIS_ID = "pd:ai:";

/** Bars a support or resistance line starts before the latest candle, and an open zone runs past it. */
const LEVEL_BARS_BACK = 12;
const ZONE_BARS_AHEAD = 1;
/** A trade plan's position box runs this many bars past the latest candle. */
const PLAN_BARS = 8;
/** Level labels sit this far right of the latest candle: past the plan's box, by the price axis. */
const LABEL_BARS_AHEAD = PLAN_BARS + 2;
/** The fib ratios drawn: the ones a trader reads, not every one the tool knows. */
const FIB_SHOWN = [0, 0.382, 0.5, 0.618, 0.786, 1];
/** How strongly zones are shaded: enough to see, light enough to read candles through. */
const ZONE_FILL = 0.08;
/** A level within this share of the drawing's price range of a fib line is that line. */
const ON_FIB = 0.004;
/** Names are kept at least this share of the drawing's price range apart: a line each. */
const LABEL_GAP = 0.035;

/** A trade plan read from the levels: where in, where wrong, how far it could go. */
export interface TradePlan {
  side: "long" | "short";
  entry: number;
  stop: number;
  /** The furthest target on the profit side. */
  target: number;
}

/**
 * The trade the analyst laid out, when its levels make one: an entry (the
 * middle of an entry range), the invalidation nearest it as the stop, and
 * targets on the far side. Long when the targets are above the entry and the
 * stop below; short the other way; nothing when they don't agree.
 */
export function tradePlan(levels: readonly AnalysisLevel[]): TradePlan | undefined {
  const of = (kind: AnalysisKind) =>
    levels.filter((l) => l.kind === kind && Number.isFinite(l.price)).map((l) => l.price);
  const entries = of("entry");
  const stops = of("invalidation");
  const targets = of("target");
  if (!entries.length || !stops.length || !targets.length) return undefined;
  const entry = (Math.min(...entries) + Math.max(...entries)) / 2;
  const stop = stops.reduce((a, b) => (Math.abs(b - entry) < Math.abs(a - entry) ? b : a));
  const side = stop < entry ? "long" : stop > entry ? "short" : undefined;
  if (!side) return undefined;
  const ahead = targets.filter((t) => (side === "long" ? t > entry : t < entry));
  if (!ahead.length) return undefined;
  const target = side === "long" ? Math.max(...ahead) : Math.min(...ahead);
  return { side, entry, stop, target };
}

/** A price as a label shows it: at most 8 significant figures, no trailing zeros. */
function priceText(price: number): string {
  return String(Number(price.toPrecision(8)));
}

/** A level's label, where it goes, and whether it draws a line of its own. */
export interface LevelLabel {
  /** The price it names: a level's, or a zone's middle. */
  price: number;
  /** Where its words go: its price, or eased off it to stay clear of the next. */
  at: number;
  text: string;
  color: string;
}

/** Every price the analysis draws at, and their spread. */
function priceRange(analysis: ChartAnalysis): number {
  const prices = [
    ...analysis.levels.map((l) => l.price),
    ...(analysis.zones ?? []).flatMap((z) => [z.top, z.bottom]),
    ...(analysis.fibs ?? []).flatMap((f) => [f.from.price, f.to.price]),
  ].filter(Number.isFinite);
  return prices.length ? Math.max(...prices) - Math.min(...prices) : 0;
}

/** Whether a fib line already sits at `price`, so a level there needs no line of its own. */
export function onFibLine(analysis: ChartAnalysis, price: number): boolean {
  const range = priceRange(analysis);
  return (analysis.fibs ?? []).some((f) =>
    FIB_SHOWN.some((r) => {
      const line = f.from.price + (f.to.price - f.from.price) * r;
      return range > 0 ? Math.abs(line - price) <= range * ON_FIB : line === price;
    }),
  );
}

/**
 * The names on the chart, laid out to be read: every level's and every
 * zone's, in one column by the price axis, highest first. Each says its
 * price (a zone, its band). Words that would touch are eased apart - each
 * kept at least `LABEL_GAP` of the drawing's range below the one above -
 * so every one gets a line of its own.
 */
export function levelLabels(
  analysis: ChartAnalysis,
  colorOf: (level: AnalysisLevel) => string,
  zoneColor: (zone: AnalysisZone) => string = () => "",
  /** The least price apart that reads apart on screen, where the chart can say. */
  minGap = 0,
): LevelLabel[] {
  const range = priceRange(analysis);
  const labels = [
    ...analysis.levels
      .filter((l) => Number.isFinite(l.price))
      .map((l) => ({
        price: l.price,
        text: l.label ? `${l.label} · ${priceText(l.price)}` : priceText(l.price),
        color: colorOf(l),
      })),
    ...(analysis.zones ?? [])
      .filter((z) => Number.isFinite(z.top) && Number.isFinite(z.bottom))
      .map((z) => {
        const band = `${priceText(Math.min(z.top, z.bottom))}–${priceText(Math.max(z.top, z.bottom))}`;
        return {
          price: (z.top + z.bottom) / 2,
          text: z.label ? `${z.label} · ${band}` : band,
          color: zoneColor(z),
        };
      }),
  ].sort((a, b) => b.price - a.price);
  const gap = Math.max(range * LABEL_GAP, minGap);
  const out: LevelLabel[] = [];
  for (const label of labels) {
    const above = out[out.length - 1];
    const at = above && gap > 0 ? Math.min(label.price, above.at - gap) : label.price;
    out.push({ ...label, at });
  }
  return out;
}

/**
 * The analyst's analysis as the chart's own drawings, pinned to time and
 * price, in three lanes so nothing written sits on anything else: on the
 * left the fib's ratios; from the latest candle the trade, as a position box
 * with its percentages; and past it, by the price axis, every level's and
 * zone's name, eased apart. Zones are shaded rectangles that stop at the
 * latest candle (so the lanes stay clear), levels rays. The trader can move,
 * reshape and delete them like their own; they aren't saved, and a new
 * analysis, market or interval draws them afresh. `last` is the latest
 * candle's time and `bar` one candle's length, both in seconds.
 */
export function analysisDrawings(
  analysis: ChartAnalysis,
  colors: AnalysisColors,
  view: {
    last: number;
    bar: number;
    /** How much price a line of label text takes on screen, where known. */
    labelGap?: number;
  },
): DrawingInput[] {
  const out: DrawingInput[] = [];
  const base = (tool: string, points: DrawingInput["points"], style: DrawingStyle) => ({
    id: `${ANALYSIS_ID}${out.length}`,
    tool,
    points,
    style,
    paneIndex: 0,
    policy: { editable: true, persistent: false },
  });
  const sec = (ms: number) => Math.floor(ms / 1000);
  const zoneColor = (z: AnalysisZone) => (z.kind === "demand" ? colors.buy : colors.sell);
  for (const z of analysis.zones ?? []) {
    const color = zoneColor(z);
    // A live zone runs to the latest candle; its name is in the column by the axis.
    const end = z.end === null ? view.last + ZONE_BARS_AHEAD * view.bar : sec(z.end);
    out.push(
      base(
        "rectangle",
        [
          { time: sec(z.start), price: z.top },
          { time: Math.max(end, sec(z.start) + view.bar), price: z.bottom },
        ],
        { color, lineWidth: 1, fill: true, fillColor: color, fillOpacity: ZONE_FILL },
      ),
    );
  }
  for (const f of analysis.fibs ?? []) {
    out.push(
      base(
        "fib-retracement",
        [
          { time: sec(f.from.time), price: f.from.price },
          { time: sec(f.to.time), price: f.to.price },
        ],
        {
          color: colors.muted,
          lineWidth: 1,
          showLabels: true,
          fill: false,
          // The ratios a trader reads, in one quiet colour, unshaded.
          levels: FIB_SHOWN.map((ratio) => ({ ratio, color: colors.muted })),
        },
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
        { color: colors.muted, lineWidth: 1 },
      ),
    );
  }
  const from = view.last - LEVEL_BARS_BACK * view.bar;
  const colorOf = (level: AnalysisLevel) =>
    level.kind === "support" || level.kind === "target"
      ? colors.buy
      : level.kind === "resistance"
        ? colors.sell
        : level.kind === "invalidation"
          ? colors.warning
          : colors.muted;
  // The trade, as a trader would draw it: a position box from the latest
  // candle, profit to the furthest target, loss to the stop, with its
  // percentages and risk/reward (not the tool's sizing example).
  const plan = tradePlan(analysis.levels);
  if (plan) {
    const end = view.last + PLAN_BARS * view.bar;
    out.push({
      ...base(
        plan.side === "long" ? "long-position" : "short-position",
        [
          { time: view.last, price: plan.entry },
          { time: end, price: plan.target },
          { time: end, price: plan.stop },
        ],
        { color: colors.muted, lineWidth: 1, showLabels: true, fillOpacity: 0.1 },
      ),
      props: { profitColor: colors.buy, lossColor: colors.sell, showLossSize: false },
    });
  }
  const inPlan = (level: AnalysisLevel) =>
    plan !== undefined &&
    (level.kind === "entry" || level.kind === "target" || level.kind === "invalidation");
  // A line for each level a fib line doesn't already mark: the plan's from
  // the latest candle on (the box carries them), support and resistance from
  // a little before it. No price label of its own: its name says it.
  for (const level of analysis.levels) {
    if (!Number.isFinite(level.price) || onFibLine(analysis, level.price)) continue;
    out.push(
      base("horizontal-ray", [{ time: inPlan(level) ? view.last : from, price: level.price }], {
        color: colorOf(level),
        lineWidth: 1,
        lineStyle: inPlan(level) ? "solid" : "dotted",
        showLabels: false,
      }),
    );
  }
  // The names, in one column past the box, on a plate of the chart's own
  // background, eased apart so each has a line of its own.
  const at = view.last + LABEL_BARS_AHEAD * view.bar;
  for (const label of levelLabels(analysis, colorOf, zoneColor, view.labelGap)) {
    out.push({
      ...base("text", [{ time: at, price: label.at }], { color: label.color }),
      text: {
        value: label.text,
        color: label.color,
        fontSize: 11,
        valign: "middle",
        ...(colors.background
          ? { background: true, backgroundColor: colors.background, backgroundOpacity: 0.9 }
          : {}),
      },
    });
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
