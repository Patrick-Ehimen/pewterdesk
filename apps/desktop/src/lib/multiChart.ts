import type { CandleInterval, Market, VenueId } from "@pewterdesk/core";
import {
  ALL_INTERVALS,
  CHART_TYPES,
  type ChartType,
  INDICATORS,
  type IndicatorId,
} from "@pewterdesk/ui";

// The Multi-chart page's state: how many charts, what each one shows, and
// what moves together. Each chart carries its own venue, so one page can
// set a market on one venue beside the same market on another.

/** "1+2" is one large chart with two small ones beside it. */
export const LAYOUTS = ["1x2", "1x3", "2x2", "2x3", "3x3", "1+2"] as const;
export type Layout = (typeof LAYOUTS)[number];

/** How a layout is laid out: its grid, and how many charts it shows. */
export const GRID: Record<Layout, { cols: number; rows: number; charts: number }> = {
  "1x2": { cols: 2, rows: 1, charts: 2 },
  "1x3": { cols: 3, rows: 1, charts: 3 },
  "2x2": { cols: 2, rows: 2, charts: 4 },
  "2x3": { cols: 3, rows: 2, charts: 6 },
  "3x3": { cols: 3, rows: 3, charts: 9 },
  // The first chart takes the two left columns, top to bottom.
  "1+2": { cols: 3, rows: 2, charts: 3 },
};
/** The most charts any layout shows: every cell is kept, shown or not. */
export const MAX_CELLS = 9;

/** How one chart is drawn: the Trade chart's settings, kept per chart here. */
export interface CellSettings {
  grid: boolean;
  logScale: boolean;
  /** The time left on the latest candle, under the last price. */
  countdown: boolean;
  /** The position's and open orders' lines. */
  levels: boolean;
}

export const DEFAULT_CELL_SETTINGS: CellSettings = {
  grid: true,
  logScale: false,
  countdown: true,
  levels: true,
};

/** One chart: everything about it is its own. */
export interface ChartCell {
  venue: VenueId;
  /** `Market::id` on that venue. */
  market: string;
  interval: CandleInterval;
  /** Candles, a line, bars and so on. */
  type: ChartType;
  /** In the order added. None to start with: the charts are small. */
  indicators: IndicatorId[];
  settings: CellSettings;
}

export interface MultiChartState {
  layout: Layout;
  /** Up to `MAX_CELLS`; a smaller layout shows the first few. */
  cells: ChartCell[];
  /** Changing one chart's interval changes them all. Off unless asked for. */
  syncInterval: boolean;
  /** Changing one chart's market changes them all (one market, many timeframes). */
  syncSymbol: boolean;
  /** The moment under the pointer on one chart is marked on them all. */
  syncCrosshair: boolean;
  /** Scrolling or zooming one chart moves the others on its timeframe. */
  syncRange: boolean;
  /** Buy and sell buttons under each chart. Off unless asked for. */
  tradeBar: boolean;
}

/** A named set of charts, to come back to. */
export interface ChartSet {
  name: string;
  layout: Layout;
  cells: ChartCell[];
}

const DEFAULT_INTERVAL: CandleInterval = "15m";
/** With one market on every chart, each gets its own timeframe. */
const SPREAD: readonly CandleInterval[] = ["1m", "5m", "15m", "1h", "4h", "1d", "1w", "30m", "12h"];
/** 3: each chart has its own venue, and one state serves every venue. */
const STATE_KEY = "pd.multichart.3";
const SETS_KEY = "pd.multichart.sets";
/** Longest name a set is kept under, and how many are kept. */
export const SET_NAME_MAX = 24;
const MAX_SETS = 12;
const VENUES: readonly VenueId[] = ["bybit", "hyperliquid", "aster"];

const isInterval = (v: unknown): v is CandleInterval => ALL_INTERVALS.some((i) => i === v);
const isVenue = (v: unknown): v is VenueId => VENUES.some((id) => id === v);

/** A chart on `market`, as new ones start: 15m candles, no indicators. */
const fresh = (venue: VenueId, market: string): ChartCell => ({
  venue,
  market,
  interval: DEFAULT_INTERVAL,
  type: "candles",
  indicators: [],
  settings: DEFAULT_CELL_SETTINGS,
});

/** Saved settings, as far as they read; the default for the rest. */
function settingsFrom(raw: unknown): CellSettings {
  const s = typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>) : {};
  const flag = (key: keyof CellSettings) =>
    typeof s[key] === "boolean" ? s[key] : DEFAULT_CELL_SETTINGS[key];
  return {
    grid: flag("grid"),
    logScale: flag("logScale"),
    countdown: flag("countdown"),
    levels: flag("levels"),
  };
}

/**
 * The first charts for a venue: its majors, then its other markets in the
 * order given, each once.
 */
export function defaultCells(
  venue: VenueId,
  markets: readonly Market[],
  majors: readonly string[],
): ChartCell[] {
  const listed = new Set(markets.map((m) => m.id));
  const ids = [...majors.filter((id) => listed.has(id)), ...markets.map((m) => m.id)];
  return [...new Set(ids)].slice(0, MAX_CELLS).map((market) => fresh(venue, market));
}

/** A saved cell, if it's one: the venue and market taken on trust for now. */
export function cellFrom(raw: unknown): ChartCell | undefined {
  if (typeof raw !== "object" || raw === null) return undefined;
  const c = raw as Record<string, unknown>;
  if (!isVenue(c.venue) || typeof c.market !== "string" || c.market === "") return undefined;
  return {
    venue: c.venue,
    market: c.market,
    interval: isInterval(c.interval) ? c.interval : DEFAULT_INTERVAL,
    type: CHART_TYPES.find((type) => type === c.type) ?? "candles",
    indicators: Array.isArray(c.indicators)
      ? INDICATORS.filter((id) => (c.indicators as unknown[]).includes(id))
      : [],
    settings: settingsFrom(c.settings),
  };
}

const cellsFrom = (raw: unknown): ChartCell[] =>
  (Array.isArray(raw) ? raw : [])
    .map(cellFrom)
    .filter((c): c is ChartCell => c !== undefined)
    .slice(0, MAX_CELLS);

/** The saved state, as far as it reads; its markets are checked by `repaired`. */
export function restore(saved: unknown): MultiChartState {
  const raw = typeof saved === "object" && saved !== null ? (saved as Record<string, unknown>) : {};
  return {
    layout: LAYOUTS.find((l) => l === raw.layout) ?? "2x2",
    cells: cellsFrom(raw.cells),
    syncInterval: raw.syncInterval === true,
    syncSymbol: raw.syncSymbol === true,
    syncCrosshair: raw.syncCrosshair !== false,
    syncRange: raw.syncRange === true,
    tradeBar: raw.tradeBar === true,
  };
}

/**
 * `state` made good against `venue`'s markets, now that they're known: a
 * chart on a market that venue no longer lists takes one of its defaults,
 * and (with `fill`) charts are added, on that venue, until there are
 * `MAX_CELLS`. Charts on other venues are left as they are. The same state
 * if nothing changed.
 */
export function repaired(
  state: MultiChartState,
  venue: VenueId,
  markets: readonly Market[],
  majors: readonly string[],
  /** Whether to add charts on this venue up to `MAX_CELLS`: for the venue on screen. */
  fill = true,
): MultiChartState {
  if (markets.length === 0) return state;
  const listed = new Set(markets.map((m) => m.id));
  const defaults = defaultCells(venue, markets, majors);
  const used = new Set(state.cells.filter((c) => c.venue === venue).map((c) => c.market));
  const spare = () => {
    const next = defaults.find((d) => !used.has(d.market)) ?? defaults[0];
    if (next) used.add(next.market);
    return next;
  };
  let changed = false;
  const cells = state.cells.map((c) => {
    if (c.venue !== venue || listed.has(c.market)) return c;
    const next = spare();
    if (!next) return c;
    changed = true;
    return { ...c, market: next.market };
  });
  while (fill && cells.length < MAX_CELLS) {
    const next = spare();
    if (!next) break;
    cells.push(next);
    changed = true;
  }
  return changed ? { ...state, cells } : state;
}

export function loadMultiChart(): MultiChartState {
  try {
    return restore(JSON.parse(localStorage.getItem(STATE_KEY) ?? "null"));
  } catch {
    return restore(undefined);
  }
}

export function saveMultiChart(state: MultiChartState): void {
  try {
    localStorage.setItem(STATE_KEY, JSON.stringify(state));
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

/**
 * `state` with chart `index` on `market` of `venue`, or all of them when
 * markets move together.
 */
export function withMarket(
  state: MultiChartState,
  index: number,
  venue: VenueId,
  market: string,
): MultiChartState {
  return {
    ...state,
    cells: state.cells.map((c, i) =>
      state.syncSymbol || i === index ? { ...c, venue, market } : c,
    ),
  };
}

/**
 * The market on `markets` (another venue's) closest to `cell`'s: the same
 * coin if that venue lists it, or else `fallback`.
 */
export function sameCoin(
  base: string | undefined,
  markets: readonly Market[],
  fallback: string,
): string {
  const wanted = base?.toUpperCase();
  return markets.find((m) => m.base.toUpperCase() === wanted)?.id ?? fallback;
}

/** `state` with chart `index` changed, and no other. */
export function withCell(
  state: MultiChartState,
  index: number,
  change: Partial<Pick<ChartCell, "type" | "indicators" | "settings">>,
): MultiChartState {
  return { ...state, cells: state.cells.map((c, i) => (i === index ? { ...c, ...change } : c)) };
}

/** `state` with the charts at `a` and `b` in each other's place. */
export function swapped(state: MultiChartState, a: number, b: number): MultiChartState {
  const one = state.cells[a];
  const other = state.cells[b];
  if (a === b || !one || !other) return state;
  return {
    ...state,
    cells: state.cells.map((c, i) => (i === a ? other : i === b ? one : c)),
  };
}

/**
 * `state` with the charts on `venue`'s markets in `held` (the account's
 * positions, biggest first), then whatever they showed before that isn't
 * one of those. Each chart keeps its own timeframe, style and indicators.
 */
export function withPositions(
  state: MultiChartState,
  venue: VenueId,
  held: readonly string[],
): MultiChartState {
  const same = (c: ChartCell, market: string) => c.venue === venue && c.market === market;
  const rest = state.cells.filter((c) => !held.some((market) => same(c, market)));
  const order = [
    ...held.map((market) => ({ venue, market })),
    ...rest.map(({ venue: v, market }) => ({ venue: v, market })),
  ];
  return {
    ...state,
    syncSymbol: false,
    cells: state.cells.map((c, i) => ({ ...c, ...(order[i] ?? {}) })),
  };
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
      venue: first.venue,
      market: first.market,
      interval: SPREAD[i % SPREAD.length] ?? DEFAULT_INTERVAL,
    })),
  };
}

/** A set's name as kept: trimmed, single-spaced and no longer than `SET_NAME_MAX`. */
export const setName = (name: string) => name.trim().replace(/\s+/g, " ").slice(0, SET_NAME_MAX);

export function setsFrom(saved: unknown): ChartSet[] {
  return (Array.isArray(saved) ? saved : [])
    .map((raw): ChartSet | undefined => {
      if (typeof raw !== "object" || raw === null) return undefined;
      const s = raw as Record<string, unknown>;
      const name = typeof s.name === "string" ? setName(s.name) : "";
      const cells = cellsFrom(s.cells);
      const layout = LAYOUTS.find((l) => l === s.layout);
      return name && layout && cells.length > 0 ? { name, layout, cells } : undefined;
    })
    .filter((s): s is ChartSet => s !== undefined)
    .slice(0, MAX_SETS);
}

export function loadSets(): ChartSet[] {
  try {
    return setsFrom(JSON.parse(localStorage.getItem(SETS_KEY) ?? "[]"));
  } catch {
    return [];
  }
}

export function saveSets(sets: readonly ChartSet[]): void {
  try {
    localStorage.setItem(SETS_KEY, JSON.stringify(sets));
  } catch {
    // Private mode or a full store: the sets last for this session.
  }
}

/**
 * `sets` with the charts of `state` kept under `name`, replacing a set of
 * that name. Unchanged for an empty name. The newest `MAX_SETS` are kept.
 */
export function withSet(
  sets: readonly ChartSet[],
  name: string,
  state: MultiChartState,
): ChartSet[] {
  const kept = setName(name);
  if (!kept) return [...sets];
  const saved: ChartSet = { name: kept, layout: state.layout, cells: state.cells };
  return [...sets.filter((s) => s.name !== kept), saved].slice(-MAX_SETS);
}

export const withoutSet = (sets: readonly ChartSet[], name: string) =>
  sets.filter((s) => s.name !== name);

/** `state` showing `set`'s charts in its layout; the syncs are left as they are, bar symbol. */
export function applySet(state: MultiChartState, set: ChartSet): MultiChartState {
  return { ...state, layout: set.layout, cells: set.cells, syncSymbol: false };
}

/** The set `state` is showing unchanged, if it's one of them. */
export function currentSet(
  sets: readonly ChartSet[],
  state: MultiChartState,
): ChartSet | undefined {
  const now = JSON.stringify([state.layout, state.cells]);
  return sets.find((s) => JSON.stringify([s.layout, s.cells]) === now);
}

const POPOUT_KEY = "pd.multichart.popout";

/**
 * Leaves `cell` for the window about to open on it: the window's address
 * says which venue, market and interval, and this the rest (its style,
 * indicators and settings).
 */
export function leavePopout(cell: ChartCell) {
  try {
    localStorage.setItem(POPOUT_KEY, JSON.stringify(cell));
  } catch {
    // Storage unavailable; the window opens with the defaults.
  }
}

/**
 * The chart a window opened at `hash` (`#chart?venue=…&market=…&interval=…`)
 * shows: what was left for it if that's the same chart, a fresh one if not.
 */
export function popoutCell(hash: string, left: unknown = leftPopout()): ChartCell | undefined {
  const query = new URLSearchParams(hash.slice(hash.indexOf("?") + 1));
  const named = cellFrom({
    venue: query.get("venue"),
    market: query.get("market"),
    interval: query.get("interval"),
  });
  if (!named) return undefined;
  const saved = cellFrom(left);
  const same =
    saved?.venue === named.venue &&
    saved.market === named.market &&
    saved.interval === named.interval;
  return same ? saved : named;
}

function leftPopout(): unknown {
  try {
    return JSON.parse(localStorage.getItem(POPOUT_KEY) ?? "null");
  } catch {
    return null;
  }
}
