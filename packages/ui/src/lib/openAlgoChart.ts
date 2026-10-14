import type { Candle, CandleInterval, Market } from "@pewterdesk/core";
import type {
  Bar,
  BarsPage,
  BarsPageRequest,
  BarsRequest,
  DataFeed,
  PriceLineOptions,
} from "openalgo-charts";
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

/** The chart's interval code as one of ours, if it is one. */
export function asInterval(code: string): CandleInterval | undefined {
  return ALL_INTERVALS.find((i) => i === code);
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
 * request, so the feed outlives a refreshed market list.
 */
export function barFeed(source: BarSource, markets: () => readonly Market[]): DataFeed {
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
          onBar(bar);
        }
      });
    },
  };
}

function intervalSeconds(interval: CandleInterval) {
  const unit = { m: 60, h: 3600, d: 86_400, w: 604_800 }[interval.slice(-1)] ?? 60;
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
