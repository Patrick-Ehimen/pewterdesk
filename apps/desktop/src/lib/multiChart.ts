import type { CandleInterval, Market, VenueId } from "@pewterdesk/core";
import {
  ALL_INTERVALS,
  CHART_TYPES,
  type ChartType,
  INDICATORS,
  type IndicatorId,
} from "@pewterdesk/ui";

// The Multi-chart page's state: how many charts, what each one shows, and
// what moves together. Kept per venue, since market ids differ between them.

export const LAYOUTS = ["1x2", "2x2", "3x3"] as const;
export type Layout = (typeof LAYOUTS)[number];
/** Columns and rows of each layout. */
export const GRID: Record<Layout, { cols: number; rows: number }> = {
  "1x2": { cols: 2, rows: 1 },
  "2x2": { cols: 2, rows: 2 },
  "3x3": { cols: 3, rows: 3 },
};
/** The most charts any layout shows: every cell is kept, shown or not. */
export const MAX_CELLS = 9;

/** One chart: everything about it is its own. */
export interface ChartCell {
  /** `Market::id`. */
  market: string;
  interval: CandleInterval;
  /** Candles, a line, bars and so on. */
  type: ChartType;
  /** In the order added. None to start with: the charts are small. */
  indicators: IndicatorId[];
}

export interface MultiChartState {
  layout: Layout;
  /** `MAX_CELLS` of them; a smaller layout shows the first few. */
  cells: ChartCell[];
  /** Changing one chart's interval changes them all. Off unless asked for. */
  syncInterval: boolean;
  /** Changing one chart's market changes them all (one market, many timeframes). */
  syncSymbol: boolean;
}

const DEFAULT_INTERVAL: CandleInterval = "15m";
/** With one market on every chart, each gets its own timeframe. */
const SPREAD: readonly CandleInterval[] = ["1m", "5m", "15m", "1h", "4h", "1d", "1w", "30m", "12h"];

/** 2: every chart is its own (intervals no longer move together by default). */
const keyFor = (venue: VenueId) => `pd.multichart.2.${venue}`;

/**
 * The first charts for a venue: its majors, then its other markets in the
 * order given, each once.
 */
export function defaultCells(markets: readonly Market[], majors: readonly string[]): ChartCell[] {
  const listed = new Set(markets.map((m) => m.id));
  const ids = [...majors.filter((id) => listed.has(id)), ...markets.map((m) => m.id)];
  const unique = [...new Set(ids)].slice(0, MAX_CELLS);
  return unique.map((market) => ({
    market,
    interval: DEFAULT_INTERVAL,
    type: "candles",
    indicators: [],
  }));
}

const isInterval = (v: unknown): v is CandleInterval => ALL_INTERVALS.some((i) => i === v);

/**
 * The saved state, made good against the venue's markets: a cell whose
 * market is gone (delisted) takes a default instead, and missing cells are
 * filled in. Before the markets arrive there's nothing to check against,
 * so the saved cells are taken as they are.
 */
export function restore(
  saved: unknown,
  markets: readonly Market[],
  majors: readonly string[],
): MultiChartState {
  const raw = typeof saved === "object" && saved !== null ? (saved as Record<string, unknown>) : {};
  const listed = new Set(markets.map((m) => m.id));
  const fallback = defaultCells(markets, majors);
  const savedCells = Array.isArray(raw.cells) ? raw.cells : [];
  const used = new Set<string>();
  const cells: ChartCell[] = [];
  for (let i = 0; i < MAX_CELLS; i++) {
    const cell = savedCells[i] as Partial<ChartCell> | undefined;
    const known =
      typeof cell?.market === "string" && (markets.length === 0 || listed.has(cell.market));
    // A default not already on another chart, where there is one.
    const spare = fallback.find((f) => !used.has(f.market)) ?? fallback[i % (fallback.length || 1)];
    const market = known ? (cell?.market as string) : spare?.market;
    if (!market) break;
    used.add(market);
    cells.push({
      market,
      interval: isInterval(cell?.interval) ? cell.interval : DEFAULT_INTERVAL,
      type: CHART_TYPES.find((type) => type === cell?.type) ?? "candles",
      indicators: Array.isArray(cell?.indicators)
        ? INDICATORS.filter((id) => (cell.indicators as unknown[]).includes(id))
        : [],
    });
  }
  return {
    layout: LAYOUTS.find((l) => l === raw.layout) ?? "2x2",
    cells,
    syncInterval: raw.syncInterval === true,
    syncSymbol: raw.syncSymbol === true,
  };
}

export function loadMultiChart(
  venue: VenueId,
  markets: readonly Market[],
  majors: readonly string[],
): MultiChartState {
  let saved: unknown;
  try {
    saved = JSON.parse(localStorage.getItem(keyFor(venue)) ?? "null");
  } catch {
    saved = undefined;
  }
  return restore(saved, markets, majors);
}

export function saveMultiChart(venue: VenueId, state: MultiChartState): void {
  try {
    localStorage.setItem(keyFor(venue), JSON.stringify(state));
  } catch {
    // Private mode or a full store: the charts last for this session.
  }
}

/** `state` with chart `index` on `interval`, or all of them when intervals move together. */
export function withInterval(
  state: MultiChartState,
  index: number,
  interval: CandleInterval,
): MultiChartState {
  return {
    ...state,
    cells: state.cells.map((c, i) => (state.syncInterval || i === index ? { ...c, interval } : c)),
  };
}

/** `state` with chart `index` on `market`, or all of them when markets move together. */
export function withMarket(state: MultiChartState, index: number, market: string): MultiChartState {
  return {
    ...state,
    cells: state.cells.map((c, i) => (state.syncSymbol || i === index ? { ...c, market } : c)),
  };
}

/** `state` with chart `index` changed, and no other. */
export function withCell(
  state: MultiChartState,
  index: number,
  change: Partial<Pick<ChartCell, "type" | "indicators">>,
): MultiChartState {
  return { ...state, cells: state.cells.map((c, i) => (i === index ? { ...c, ...change } : c)) };
}

/** `indicators` with `id` added at the end, or taken out. */
export function toggledIndicator(
  indicators: readonly IndicatorId[],
  id: IndicatorId,
): IndicatorId[] {
  return indicators.includes(id) ? indicators.filter((x) => x !== id) : [...indicators, id];
}

/**
 * Turning a sync on brings the charts into line straight away, after the
 * first one. Symbol sync also gives each chart its own timeframe (and lets
 * go of interval sync): one market at one timeframe nine times says nothing.
 */
export function withSync(
  state: MultiChartState,
  which: "interval" | "symbol",
  on: boolean,
): MultiChartState {
  const first = state.cells[0];
  if (which === "interval") {
    return {
      ...state,
      syncInterval: on,
      cells:
        on && first ? state.cells.map((c) => ({ ...c, interval: first.interval })) : state.cells,
    };
  }
  if (!on || !first) return { ...state, syncSymbol: on };
  return {
    ...state,
    syncSymbol: true,
    syncInterval: false,
    cells: state.cells.map((c, i) => ({
      ...c,
      market: first.market,
      interval: SPREAD[i % SPREAD.length] ?? DEFAULT_INTERVAL,
    })),
  };
}
