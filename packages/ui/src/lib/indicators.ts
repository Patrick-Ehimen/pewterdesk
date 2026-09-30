import type { CandleInterval } from "@pewterdesk/core";
import type { DrawnCandle } from "./chart";

// The chart toolbar's options and the maths behind its indicators. Display
// only: everything goes through JS numbers.

/** How the main series is drawn. */
export type ChartType = "bars" | "candles" | "hollow" | "heikinAshi" | "line" | "area" | "baseline";
export const CHART_TYPES: readonly ChartType[] = [
  "bars",
  "candles",
  "hollow",
  "heikinAshi",
  "line",
  "area",
  "baseline",
];

/** The interval menu, grouped as in TradingView. */
export const INTERVAL_GROUPS: readonly {
  id: "minutes" | "hours" | "days";
  intervals: readonly CandleInterval[];
}[] = [
  { id: "minutes", intervals: ["1m", "3m", "5m", "15m", "30m"] },
  { id: "hours", intervals: ["1h", "2h", "4h", "8h", "12h"] },
  { id: "days", intervals: ["1d", "3d", "1w"] },
];
export const ALL_INTERVALS: readonly CandleInterval[] = INTERVAL_GROUPS.flatMap((g) => g.intervals);

export type IndicatorId = "volume" | "sma" | "ema" | "bollinger" | "vwap" | "rsi" | "macd";
export const INDICATORS: readonly IndicatorId[] = [
  "volume",
  "sma",
  "ema",
  "bollinger",
  "vwap",
  "rsi",
  "macd",
];
/** Indicators drawn below the price in a pane of their own; the rest overlay it. */
export const PANE_INDICATORS: readonly IndicatorId[] = ["rsi", "macd"];

/** Each indicator's settings: the usual defaults. */
export const PARAMS = {
  sma: 20,
  ema: 50,
  bollinger: { period: 20, mult: 2 },
  rsi: 14,
  macd: { fast: 12, slow: 26, signal: 9 },
} as const;

/** One value per input point; `undefined` until there's enough history. */
export type Series = (number | undefined)[];

/** Simple moving average of the last `period` values. */
export function sma(values: readonly number[], period: number): Series {
  const out: Series = [];
  let sum = 0;
  values.forEach((v, i) => {
    sum += v;
    if (i >= period) sum -= values[i - period] as number;
    out.push(i >= period - 1 ? sum / period : undefined);
  });
  return out;
}

/**
 * Exponential moving average, seeded with the simple average of the first
 * `period` values. Leading `undefined`s in `values` are skipped, so it can
 * run over another indicator's output (MACD's signal line).
 */
export function ema(values: readonly (number | undefined)[], period: number): Series {
  const out: Series = [];
  const k = 2 / (period + 1);
  let prev: number | undefined;
  let seed: number[] = [];
  for (const v of values) {
    if (v === undefined) {
      out.push(undefined);
      continue;
    }
    if (prev === undefined) {
      seed.push(v);
      if (seed.length < period) {
        out.push(undefined);
        continue;
      }
      prev = seed.reduce((a, b) => a + b, 0) / period;
      seed = [];
    } else {
      prev = v * k + prev * (1 - k);
    }
    out.push(prev);
  }
  return out;
}

export interface Band {
  upper: number;
  middle: number;
  lower: number;
}

/** Bollinger Bands: the moving average, `mult` standard deviations either side. */
export function bollinger(
  values: readonly number[],
  period: number,
  mult: number,
): (Band | undefined)[] {
  const middle = sma(values, period);
  return middle.map((m, i) => {
    if (m === undefined) return undefined;
    let sq = 0;
    for (let j = i - period + 1; j <= i; j++) sq += ((values[j] as number) - m) ** 2;
    const sd = Math.sqrt(sq / period);
    return { upper: m + mult * sd, middle: m, lower: m - mult * sd };
  });
}

/** Relative strength index with Wilder's smoothing, 0 to 100. */
export function rsi(values: readonly number[], period: number): Series {
  const out: Series = values.map(() => undefined);
  if (values.length <= period) return out;
  let gain = 0;
  let loss = 0;
  for (let i = 1; i <= period; i++) {
    const d = (values[i] as number) - (values[i - 1] as number);
    if (d > 0) gain += d;
    else loss -= d;
  }
  gain /= period;
  loss /= period;
  const value = () => (loss === 0 ? (gain === 0 ? 50 : 100) : 100 - 100 / (1 + gain / loss));
  out[period] = value();
  for (let i = period + 1; i < values.length; i++) {
    const d = (values[i] as number) - (values[i - 1] as number);
    gain = (gain * (period - 1) + Math.max(d, 0)) / period;
    loss = (loss * (period - 1) + Math.max(-d, 0)) / period;
    out[i] = value();
  }
  return out;
}

export interface MacdPoint {
  macd?: number;
  signal?: number;
  histogram?: number;
}

/** MACD: fast EMA minus slow EMA, its EMA as the signal, and the gap between. */
export function macd(
  values: readonly number[],
  fast: number,
  slow: number,
  signal: number,
): MacdPoint[] {
  const f = ema(values, fast);
  const s = ema(values, slow);
  const line: Series = f.map((v, i) => {
    const w = s[i];
    return v === undefined || w === undefined ? undefined : v - w;
  });
  const sig = ema(line, signal);
  return line.map((m, i) => {
    const g = sig[i];
    return {
      macd: m,
      signal: g,
      histogram: m === undefined || g === undefined ? undefined : m - g,
    };
  });
}

export interface VwapInput {
  openTime: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

const DAY_MS = 86_400_000;

/**
 * Volume-weighted average price over each UTC day, restarting at midnight:
 * the typical price (high + low + close) / 3 weighted by volume.
 */
export function vwap(candles: readonly VwapInput[]): Series {
  let day = -1;
  let pv = 0;
  let vol = 0;
  return candles.map((c) => {
    const d = Math.floor(c.openTime / DAY_MS);
    if (d !== day) {
      day = d;
      pv = 0;
      vol = 0;
    }
    pv += ((c.high + c.low + c.close) / 3) * c.volume;
    vol += c.volume;
    return vol > 0 ? pv / vol : undefined;
  });
}

/** Heikin-Ashi candles: each averages its own prices with the one before. */
export function heikinAshi(candles: readonly DrawnCandle[]): DrawnCandle[] {
  const out: DrawnCandle[] = [];
  candles.forEach((c, i) => {
    const close = (c.open + c.high + c.low + c.close) / 4;
    const prev = out[i - 1];
    const open = prev ? (prev.open + prev.close) / 2 : (c.open + c.close) / 2;
    out.push({
      open,
      high: Math.max(c.high, open, close),
      low: Math.min(c.low, open, close),
      close,
    });
  });
  return out;
}
