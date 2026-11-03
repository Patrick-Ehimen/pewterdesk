import type { Candle, Market, MarketSummary } from "@pewterdesk/core";
import type { DivergenceKind, RegimeKind } from "./mapScans";
import { divergence, levelsRead, regimeRead, stretchRead, volRank } from "./mapScans";
import { atrShare, bandRead, changeSince, closesEvery, rangePlace, realisedVol } from "./mapStats";
import { fundingApr, rsi } from "./screener";
import { techBreakdown, techScores, type Vote } from "./technicals";

// The Screener page: a table of a venue's markets with the columns and
// filters the trader picks, from data the app already reads (each market's
// summary and its last 7 days of hourly candles). Display only: a screen
// names markets, it places nothing.

/** How a column's values read, and are typed into a filter. */
export type ScreenUnit =
  /** A price, in the market's quote. */
  | "price"
  /** A fraction, shown and typed as a percentage (0.05 is 5). */
  | "pct"
  /** A quote amount, typed with k / m / b if wanted. */
  | "usd"
  /** A plain number: RSI, ADX, standard deviations. */
  | "num"
  /** One of a few states. */
  | "enum"
  /** A score from -1 (all sell) to 1 (all buy), shown as a rating. */
  | "rating";

export const SCREEN_COLUMNS = [
  "price",
  "change1h",
  "change4h",
  "change24h",
  "change7d",
  "volume",
  "oi",
  "funding",
  "rsi1h",
  "rsi4h",
  "adx",
  "efficiency",
  "regime",
  "realisedVol",
  "atr",
  "volRank",
  "vwapZ",
  "fromEma",
  "level",
  "rangePos",
  "percentB",
  "divergence",
  "rating",
  "maRating",
  "oscRating",
] as const;
export type ScreenColumn = (typeof SCREEN_COLUMNS)[number];

export const SCREEN_UNIT: Record<ScreenColumn, ScreenUnit> = {
  price: "price",
  change1h: "pct",
  change4h: "pct",
  change24h: "pct",
  change7d: "pct",
  volume: "usd",
  oi: "usd",
  funding: "pct",
  rsi1h: "num",
  rsi4h: "num",
  adx: "num",
  efficiency: "pct",
  regime: "enum",
  realisedVol: "pct",
  atr: "pct",
  volRank: "pct",
  vwapZ: "num",
  fromEma: "pct",
  level: "pct",
  rangePos: "pct",
  percentB: "pct",
  divergence: "enum",
  rating: "rating",
  maRating: "rating",
  oscRating: "rating",
};

export const RATINGS = ["strongSell", "sell", "neutral", "buy", "strongBuy"] as const;
export type Rating = (typeof RATINGS)[number];

/** A score as a rating: half way or more is strong, a tenth either way leans. */
export function ratingOf(score: number): Rating {
  if (score >= 0.5) return "strongBuy";
  if (score >= 0.1) return "buy";
  if (score <= -0.5) return "strongSell";
  if (score <= -0.1) return "sell";
  return "neutral";
}

/** The states an enum column takes. */
export const SCREEN_STATES: Partial<Record<ScreenColumn, readonly string[]>> = {
  regime: ["trendUp", "trendDown", "ranging", "choppy"] satisfies RegimeKind[],
  divergence: ["bullish", "bearish", "none"] satisfies (DivergenceKind | "none")[],
  rating: RATINGS,
  maRating: RATINGS,
  oscRating: RATINGS,
};

/** Columns read from the summary alone: there from the start, before any history. */
const SUMMARY_COLUMNS = new Set<ScreenColumn>(["price", "change24h", "volume", "oi", "funding"]);
export const needsHistory = (column: ScreenColumn) => !SUMMARY_COLUMNS.has(column);

/** One market, as a screen reads it. */
export interface ScreenInput {
  market: Market;
  summary?: MarketSummary;
  /** Oldest first, hourly, up to 7 days. */
  candles?: readonly Candle[];
  now: number;
}

export type ScreenValue = number | string | undefined;

const finite = (v: number | undefined) => (v !== undefined && Number.isFinite(v) ? v : undefined);

/** One column's value for one market; undefined where it can't be read yet. */
export function screenValue(column: ScreenColumn, input: ScreenInput): ScreenValue {
  const s = input.summary;
  const price = s ? Number(s.markPrice) : undefined;
  const candles = input.candles;
  const priced = price !== undefined && price > 0 ? price : undefined;
  switch (column) {
    case "price":
      return finite(priced);
    case "change24h": {
      const prev = s ? Number(s.prevDayPrice) : undefined;
      if (priced !== undefined && prev !== undefined && prev > 0) return finite(priced / prev - 1);
      return candles ? changeSince(candles, 24, priced) : undefined;
    }
    case "volume":
      return finite(s ? Number(s.dayVolume) : undefined);
    case "oi":
      return priced !== undefined && s ? finite(Number(s.openInterest) * priced) : undefined;
    case "funding":
      return s ? finite(fundingApr(Number(s.fundingRate), s.fundingIntervalSecs)) : undefined;
  }
  if (!candles || candles.length === 0) return undefined;
  const closes = () => candles.map((c) => Number(c.close));
  switch (column) {
    case "change1h":
      return changeSince(candles, 1, priced);
    case "change4h":
      return changeSince(candles, 4, priced);
    case "change7d":
      return changeSince(candles, 168, priced);
    case "rsi1h":
      return rsi(closes());
    case "rsi4h":
      return rsi(closesEvery(candles, 4));
    case "adx":
      return regimeRead(candles)?.adx;
    case "efficiency":
      return regimeRead(candles)?.efficiency;
    case "regime":
      return regimeRead(candles)?.kind;
    case "realisedVol":
      return realisedVol(candles, 24);
    case "atr":
      return atrShare(candles);
    case "volRank":
      return volRank(candles)?.rank;
    case "divergence":
      return divergence(candles, 1)?.kind ?? "none";
    case "rating":
      return techRating(candles)?.all;
    case "maRating":
      return techRating(candles)?.ma;
    case "oscRating":
      return techRating(candles)?.osc;
  }
  if (priced === undefined) return undefined;
  switch (column) {
    case "vwapZ":
      return stretchRead(candles, priced)?.z;
    case "fromEma":
      return stretchRead(candles, priced)?.fromEma;
    case "level":
      return levelsRead(candles, priced, input.now)?.nearest.distance;
    case "rangePos":
      return rangePlace(candles, 168, priced)?.position;
    case "percentB":
      return bandRead(candles, priced, 1)?.percentB;
  }
}

export type ScreenOp = "above" | "below" | "between" | "is";
export const SCREEN_OPS: readonly ScreenOp[] = ["above", "below", "between", "is"];

/** Which comparisons a column takes. */
export const opsFor = (column: ScreenColumn): readonly ScreenOp[] =>
  SCREEN_UNIT[column] === "enum" || SCREEN_UNIT[column] === "rating"
    ? ["is"]
    : ["above", "below", "between"];

/**
 * One condition. Numbers are as typed, in the column's display units: a
 * percentage for a "pct" column (5 is 5%), a quote amount for "usd".
 */
export interface ScreenFilter {
  column: ScreenColumn;
  op: ScreenOp;
  value: number | string;
  /** The top of a "between". */
  to?: number;
}

/** A display-unit number as the column's own value: percentages back to fractions. */
const fromDisplay = (column: ScreenColumn, n: number) =>
  SCREEN_UNIT[column] === "pct" ? n / 100 : n;

/** Whether a market's value passes a filter. An unknown value passes none. */
export function passesFilter(filter: ScreenFilter, value: ScreenValue): boolean {
  if (value === undefined) return false;
  if (filter.op === "is") {
    return typeof value === "number" ? ratingOf(value) === filter.value : value === filter.value;
  }
  if (typeof value !== "number" || typeof filter.value !== "number") return false;
  const line = fromDisplay(filter.column, filter.value);
  if (filter.op === "above") return value > line;
  if (filter.op === "below") return value < line;
  if (filter.to === undefined) return false;
  const top = fromDisplay(filter.column, filter.to);
  return value >= Math.min(line, top) && value <= Math.max(line, top);
}

export type ScreenScope = "crypto" | "all";

export interface ScreenSort {
  column: ScreenColumn;
  desc: boolean;
}

/** A screen: what it shows, what passes, in what order. */
export interface Screen {
  id: string;
  name: string;
  columns: ScreenColumn[];
  filters: ScreenFilter[];
  sort: ScreenSort;
  scope: ScreenScope;
}

/** A row of the table: its market, and the values of the columns asked for. */
export interface ScreenRow {
  market: Market;
  values: Partial<Record<ScreenColumn, ScreenValue>>;
}

/** The columns a screen reads: those shown, filtered on, and sorted by. */
export function screenColumns(screen: Screen): ScreenColumn[] {
  return [
    ...new Set([...screen.columns, ...screen.filters.map((f) => f.column), screen.sort.column]),
  ];
}

const isCrypto = (m: Market) => !m.category || m.category === "innovation";

/** Whether a market is in a screen's scope: crypto only, or everything. */
export const inScope = (m: Market, scope: ScreenScope) => scope === "all" || isCrypto(m);

/** The rows that pass every filter, in the screen's order (unknowns last). */
export function runScreen(screen: Screen, inputs: readonly ScreenInput[]): ScreenRow[] {
  const columns = screenColumns(screen);
  const rows: ScreenRow[] = [];
  for (const input of inputs) {
    if (!inScope(input.market, screen.scope)) continue;
    const values: ScreenRow["values"] = {};
    for (const c of columns) values[c] = screenValue(c, input);
    if (screen.filters.every((f) => passesFilter(f, values[f.column]))) {
      rows.push({ market: input.market, values });
    }
  }
  const { column, desc } = screen.sort;
  return rows.sort((a, b) => compareValues(a.values[column], b.values[column], desc));
}

function compareValues(a: ScreenValue, b: ScreenValue, desc: boolean): number {
  if (a === undefined) return b === undefined ? 0 : 1;
  if (b === undefined) return -1;
  const order =
    typeof a === "number" && typeof b === "number" ? a - b : String(a).localeCompare(String(b));
  return desc ? -order : order;
}

/** A number typed into a filter: "5", "-1.5", "2m", "1.2b", "500k". */
export function parseScreenNumber(text: string): number | undefined {
  const m = /^\s*(-?\d+(?:\.\d+)?)\s*([kmb])?\s*$/i.exec(text.replace(/,/g, ""));
  if (!m) return undefined;
  const scale = { k: 1e3, m: 1e6, b: 1e9 }[(m[2] ?? "").toLowerCase() as "k" | "m" | "b"] ?? 1;
  return Number(m[1]) * scale;
}

/** The column set most screens start from. */
export const DEFAULT_COLUMNS: ScreenColumn[] = [
  "price",
  "change1h",
  "change24h",
  "change7d",
  "volume",
  "oi",
  "funding",
  "rsi1h",
  "rating",
];

const preset = (
  id: string,
  columns: ScreenColumn[],
  filters: ScreenFilter[],
  sort: ScreenSort,
): Screen => ({ id: `preset:${id}`, name: id, columns, filters, sort, scope: "crypto" });

/** Liquid enough to matter: a day's volume over $1M. */
const LIQUID: ScreenFilter = { column: "volume", op: "above", value: 1_000_000 };

/** Screens that come with the app; their names are message keys' last part. */
export const SCREEN_PRESETS: readonly Screen[] = [
  preset("all", DEFAULT_COLUMNS, [], { column: "volume", desc: true }),
  preset(
    "movers",
    ["price", "change1h", "change24h", "volume", "rsi1h", "regime"],
    [{ column: "volume", op: "above", value: 5_000_000 }],
    { column: "change24h", desc: true },
  ),
  preset(
    "oversold",
    ["price", "rsi1h", "rsi4h", "change24h", "vwapZ", "divergence", "volume"],
    [{ column: "rsi1h", op: "below", value: 30 }, LIQUID],
    { column: "rsi1h", desc: false },
  ),
  preset(
    "overbought",
    ["price", "rsi1h", "rsi4h", "change24h", "vwapZ", "divergence", "volume"],
    [{ column: "rsi1h", op: "above", value: 70 }, LIQUID],
    { column: "rsi1h", desc: true },
  ),
  preset(
    "breakouts",
    ["price", "rangePos", "change24h", "change7d", "volume", "adx"],
    [{ column: "rangePos", op: "above", value: 95 }, LIQUID],
    { column: "change24h", desc: true },
  ),
  preset(
    "trending",
    ["price", "regime", "adx", "efficiency", "change24h", "change7d", "volume"],
    [
      { column: "adx", op: "above", value: 25 },
      { column: "efficiency", op: "above", value: 30 },
      LIQUID,
    ],
    { column: "adx", desc: true },
  ),
  preset(
    "squeeze",
    ["price", "volRank", "atr", "adx", "percentB", "volume"],
    [{ column: "volRank", op: "below", value: 20 }, LIQUID],
    { column: "volRank", desc: false },
  ),
  preset(
    "funding",
    ["price", "funding", "change24h", "oi", "volume"],
    [{ column: "funding", op: "above", value: 30 }, LIQUID],
    { column: "funding", desc: true },
  ),
  preset(
    "negativeFunding",
    ["price", "funding", "change24h", "oi", "volume"],
    [{ column: "funding", op: "below", value: -10 }, LIQUID],
    { column: "funding", desc: false },
  ),
  preset(
    "strongBuy",
    ["price", "rating", "maRating", "oscRating", "change24h", "rsi1h", "volume"],
    [{ column: "rating", op: "is", value: "strongBuy" }, LIQUID],
    { column: "rating", desc: true },
  ),
  preset(
    "strongSell",
    ["price", "rating", "maRating", "oscRating", "change24h", "rsi1h", "volume"],
    [{ column: "rating", op: "is", value: "strongSell" }, LIQUID],
    { column: "rating", desc: false },
  ),
];

export const isPreset = (screen: Pick<Screen, "id">) => screen.id.startsWith("preset:");

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null;
const isColumn = (v: unknown): v is ScreenColumn => SCREEN_COLUMNS.some((c) => c === v);

function filterFrom(v: unknown): ScreenFilter | undefined {
  if (!isRecord(v) || !isColumn(v.column)) return undefined;
  const ops = opsFor(v.column);
  const op = ops.find((o) => o === v.op);
  if (!op) return undefined;
  if (op === "is") {
    const states = SCREEN_STATES[v.column] ?? [];
    return typeof v.value === "string" && states.includes(v.value)
      ? { column: v.column, op, value: v.value }
      : undefined;
  }
  if (typeof v.value !== "number" || !Number.isFinite(v.value)) return undefined;
  if (op === "between") {
    if (typeof v.to !== "number" || !Number.isFinite(v.to)) return undefined;
    return { column: v.column, op, value: v.value, to: v.to };
  }
  return { column: v.column, op, value: v.value };
}

/** The most filters and columns a kept screen takes. */
const MAX_FILTERS = 12;

/** A kept screen, if it reads as one; what doesn't read is dropped. */
export function screenFrom(v: unknown): Screen | undefined {
  if (!isRecord(v) || typeof v.id !== "string" || typeof v.name !== "string") return undefined;
  const columns = Array.isArray(v.columns) ? [...new Set(v.columns.filter(isColumn))] : [];
  const filters = Array.isArray(v.filters)
    ? v.filters.flatMap((f) => filterFrom(f) ?? []).slice(0, MAX_FILTERS)
    : [];
  const sort =
    isRecord(v.sort) && isColumn(v.sort.column)
      ? { column: v.sort.column, desc: v.sort.desc !== false }
      : { column: "volume" as const, desc: true };
  return {
    id: v.id,
    name: v.name.slice(0, 40),
    columns: columns.length > 0 ? columns : [...DEFAULT_COLUMNS],
    filters,
    sort,
    scope: v.scope === "all" ? "all" : "crypto",
  };
}

export interface TechRating {
  /** Price against fifteen moving averages. */
  ma: number;
  /** Eleven oscillators, each at an extreme and turning, or crossing. */
  osc: number;
  /** The two together. */
  all: number;
}

/** Candles a rating needs: the 100 averages', and a little more. */
const RATING_CANDLES = 101;

/**
 * A technical rating: TradingView's, the one Bybit's coin pages show
 * (`technicals.ts`), on whatever candles it's given. Fifteen moving averages
 * and eleven oscillators, each a vote, averaged per group and then together;
 * one without enough candles casts none. Scores from -1 to 1; `ratingOf`
 * names them. A reading of where the indicators stand, not a forecast.
 */
export function techRating(candles: readonly Candle[]): TechRating | undefined {
  if (candles.length < RATING_CANDLES) return undefined;
  return techScores(techBreakdown(candles));
}

/** How a rating's indicators voted, counted: the gauge's Sell, Neutral and Buy. */
export interface TechVotes {
  sell: number;
  neutral: number;
  buy: number;
}

/** Votes counted: every indicator once, or one group's. */
export function countVotes(votes: readonly Vote[]): TechVotes {
  return {
    sell: votes.filter((v) => v === -1).length,
    neutral: votes.filter((v) => v === 0).length,
    buy: votes.filter((v) => v === 1).length,
  };
}

/** The votes behind `techRating`, every indicator counted once. */
export function techVotes(candles: readonly Candle[]): TechVotes | undefined {
  if (candles.length < RATING_CANDLES) return undefined;
  const { ma, osc } = techBreakdown(candles);
  return countVotes([...Object.values(ma), ...Object.values(osc)]);
}
