import type { Candle, MarketSummary, OrderBook, VenueId } from "@pewterdesk/core";
import type { Bar } from "openalgo-charts";
import { rsiZone } from "./marketMaps";
import { rsi } from "./screener";
import { type VolumeProfile, volumeProfile } from "./volumeProfile";

// The Maps page's market-wide views: plain arithmetic over what the venues
// already send (hourly candles, summaries, the order book), so each view is
// a function of its inputs and can be tested without a venue.

export const HOUR = 3_600_000;
/** Hours in a year, to annualise hourly figures. */
const YEAR_HOURS = 24 * 365;

const num = (v: unknown) => Number(v);
const finite = (v: number) => Number.isFinite(v);

/** The mean of the finite values, or undefined when there are none. */
export function mean(values: readonly number[]): number | undefined {
  const known = values.filter(finite);
  return known.length === 0 ? undefined : known.reduce((a, b) => a + b, 0) / known.length;
}

function stdev(values: readonly number[]): number | undefined {
  const m = mean(values);
  if (m === undefined || values.length < 2) return undefined;
  return Math.sqrt(values.reduce((a, v) => a + (v - m) ** 2, 0) / (values.length - 1));
}

/** The median, or undefined for none. */
export function median(values: readonly number[]): number | undefined {
  const sorted = values.filter(finite).sort((a, b) => a - b);
  if (sorted.length === 0) return undefined;
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2;
}

// --- Performance ---------------------------------------------------------

export type PerfWindow = "1h" | "4h" | "24h" | "7d";
export const PERF_WINDOWS: readonly PerfWindow[] = ["1h", "4h", "24h", "7d"];
export const PERF_HOURS: Record<PerfWindow, number> = { "1h": 1, "4h": 4, "24h": 24, "7d": 168 };

/**
 * The change from the close `hours` hours before the last candle opened to
 * `price` (or the last close), from hourly candles. Undefined when the
 * history doesn't reach that far back.
 */
export function changeSince(
  candles: readonly Candle[],
  hours: number,
  price?: number,
): number | undefined {
  const last = candles[candles.length - 1];
  if (!last) return undefined;
  const now = price ?? num(last.close);
  // The candle that opened `hours` hours before the last one: its open is
  // the price `hours` hours ago (its close would be an hour short).
  const from = candles.find((c) => c.openTime >= last.openTime - (hours - 1) * HOUR);
  if (!from || last.openTime - from.openTime < (hours - 1) * HOUR) return undefined;
  const base = num(from.open);
  return base > 0 && finite(now) ? now / base - 1 : undefined;
}

// --- Volatility ----------------------------------------------------------

export type VolMeasure = "vol24h" | "vol7d" | "atr";
export const VOL_MEASURES: readonly VolMeasure[] = ["vol24h", "vol7d", "atr"];

/** Hourly log returns, close to close. */
export function logReturns(candles: readonly Candle[]): number[] {
  const out: number[] = [];
  for (let i = 1; i < candles.length; i++) {
    const a = num(candles[i - 1]?.close);
    const b = num(candles[i]?.close);
    if (a > 0 && b > 0) out.push(Math.log(b / a));
  }
  return out;
}

/** Realised volatility over the last `hours` hourly candles, annualised. */
export function realisedVol(candles: readonly Candle[], hours: number): number | undefined {
  const returns = logReturns(candles.slice(-(hours + 1)));
  if (returns.length < Math.min(hours, 12)) return undefined;
  const sd = stdev(returns);
  return sd === undefined ? undefined : sd * Math.sqrt(YEAR_HOURS);
}

/** The average true range of the last `n` hourly candles, as a share of the last close. */
export function atrShare(candles: readonly Candle[], n = 14): number | undefined {
  if (candles.length < n + 1) return undefined;
  const ranges: number[] = [];
  for (let i = candles.length - n; i < candles.length; i++) {
    const c = candles[i];
    const prev = num(candles[i - 1]?.close);
    if (!c) continue;
    const high = num(c.high);
    const low = num(c.low);
    ranges.push(Math.max(high - low, Math.abs(high - prev), Math.abs(low - prev)));
  }
  const atr = mean(ranges);
  const last = num(candles[candles.length - 1]?.close);
  return atr === undefined || !(last > 0) ? undefined : atr / last;
}

export type VolRegime = "expanding" | "steady" | "contracting";

/** The day's volatility against the week's: rising, falling or about the same. */
export function volRegime(
  day: number | undefined,
  week: number | undefined,
): VolRegime | undefined {
  if (day === undefined || week === undefined || week <= 0) return undefined;
  const ratio = day / week;
  return ratio >= 1.25 ? "expanding" : ratio <= 0.8 ? "contracting" : "steady";
}

// --- Correlation ---------------------------------------------------------

/** Pearson's correlation of two equally long series. */
export function pearson(a: readonly number[], b: readonly number[]): number | undefined {
  const n = Math.min(a.length, b.length);
  if (n < 3) return undefined;
  const ma = mean(a.slice(0, n)) ?? 0;
  const mb = mean(b.slice(0, n)) ?? 0;
  let cov = 0;
  let va = 0;
  let vb = 0;
  for (let i = 0; i < n; i++) {
    const da = (a[i] ?? 0) - ma;
    const db = (b[i] ?? 0) - mb;
    cov += da * db;
    va += da * da;
    vb += db * db;
  }
  return va > 0 && vb > 0 ? cov / Math.sqrt(va * vb) : undefined;
}

/** Hourly log returns keyed by the hour they end on. */
function returnsByHour(candles: readonly Candle[], hours: number): Map<number, number> {
  const out = new Map<number, number>();
  const recent = candles.slice(-(hours + 1));
  for (let i = 1; i < recent.length; i++) {
    const a = num(recent[i - 1]?.close);
    const b = num(recent[i]?.close);
    const time = recent[i]?.openTime;
    if (a > 0 && b > 0 && time !== undefined) out.set(time, Math.log(b / a));
  }
  return out;
}

/**
 * Every pair's correlation of hourly returns over the last `hours` hours,
 * over the hours both markets have. `matrix[i][j]`; undefined where too
 * few hours overlap.
 */
export function correlationMatrix(
  series: readonly (readonly Candle[])[],
  hours: number,
): (number | undefined)[][] {
  const returns = series.map((c) => returnsByHour(c, hours));
  return returns.map((a, i) =>
    returns.map((b, j) => {
      if (i === j) return a.size >= 3 ? 1 : undefined;
      const xs: number[] = [];
      const ys: number[] = [];
      for (const [time, r] of a) {
        const other = b.get(time);
        if (other !== undefined) {
          xs.push(r);
          ys.push(other);
        }
      }
      return xs.length >= Math.min(hours / 2, 12) ? pearson(xs, ys) : undefined;
    }),
  );
}

// --- Funding and prices across venues -------------------------------------

export type FundingUnit = "8h" | "apr";
export const FUNDING_UNITS: readonly FundingUnit[] = ["8h", "apr"];

/** A summary's funding rate per hour (venues settle every 1, 4 or 8 hours). */
export function fundingPerHour(s: Pick<MarketSummary, "fundingRate" | "fundingIntervalSecs">) {
  const rate = num(s.fundingRate);
  const hours = (s.fundingIntervalSecs || 8 * 3600) / 3600;
  return finite(rate) ? rate / hours : undefined;
}

/** An hourly rate in the unit shown: an 8-hour equivalent, or a year's. */
export const fundingIn = (perHour: number, unit: FundingUnit) =>
  perHour * (unit === "8h" ? 8 : YEAR_HOURS);

/** One venue's figures for a coin. */
export interface VenueQuote {
  market: string;
  price: number;
  /** Funding per hour. */
  funding?: number;
  /** Open interest in quote currency. */
  openInterest: number;
  dayVolume: number;
}

/** A coin across the venues that list it. */
export interface CoinRow {
  base: string;
  venues: Partial<Record<VenueId, VenueQuote>>;
  /** Volume over every venue, for ranking. */
  volume: number;
}

/**
 * Each venue's summaries joined by coin (`baseOf` names a market's coin, or
 * undefined to leave it out), busiest across venues first.
 */
export function joinByCoin(
  perVenue: Partial<Record<VenueId, readonly MarketSummary[]>>,
  baseOf: (venue: VenueId, market: string) => string | undefined,
): CoinRow[] {
  const rows = new Map<string, CoinRow>();
  for (const [venue, summaries] of Object.entries(perVenue) as [VenueId, MarketSummary[]][]) {
    for (const s of summaries ?? []) {
      const base = baseOf(venue, s.market);
      const price = num(s.markPrice);
      if (!base || !(price > 0)) continue;
      const row = rows.get(base) ?? { base, venues: {}, volume: 0 };
      const quote: VenueQuote = {
        market: s.market,
        price,
        funding: fundingPerHour(s),
        openInterest: num(s.openInterest) * price || 0,
        dayVolume: num(s.dayVolume) || 0,
      };
      // A venue listing a coin twice (USDT and USDC): keep the busier one.
      const had = row.venues[venue];
      if (!had || quote.dayVolume > had.dayVolume) {
        row.volume += quote.dayVolume - (had?.dayVolume ?? 0);
        row.venues[venue] = quote;
      }
      rows.set(base, row);
    }
  }
  return [...rows.values()].sort((a, b) => b.volume - a.volume);
}

/** The widest gap between venues' funding (per hour), where two or more list it. */
export function fundingGap(row: CoinRow): number | undefined {
  const rates = Object.values(row.venues)
    .map((q) => q?.funding)
    .filter((r): r is number => r !== undefined && finite(r));
  return rates.length < 2 ? undefined : Math.max(...rates) - Math.min(...rates);
}

/** Each venue's price against the coin's median, in basis points. */
export function priceSpreads(row: CoinRow): {
  median: number;
  bps: Partial<Record<VenueId, number>>;
  width: number;
} {
  const entries = Object.entries(row.venues) as [VenueId, VenueQuote][];
  const mid = median(entries.map(([, q]) => q.price)) ?? 0;
  const bps: Partial<Record<VenueId, number>> = {};
  for (const [venue, q] of entries) bps[venue] = mid > 0 ? (q.price / mid - 1) * 10_000 : 0;
  const values = Object.values(bps) as number[];
  return {
    median: mid,
    bps,
    width: values.length < 2 ? 0 : Math.max(...values) - Math.min(...values),
  };
}

// --- Open interest -------------------------------------------------------

export type OiWindow = "1h" | "4h" | "24h";
export const OI_WINDOWS: readonly OiWindow[] = ["1h", "4h", "24h"];
export const OI_HOURS: Record<OiWindow, number> = { "1h": 1, "4h": 4, "24h": 24 };

export interface OiSample {
  time: number;
  /** In base units. */
  oi: number;
  /** The mark price then, where it was recorded with the sample. */
  price?: number;
}

/**
 * The change in open interest from the sample nearest `hours` before the
 * last one, when the samples reach back at least 90% of the way.
 */
export function oiChangeOver(samples: readonly OiSample[], hours: number): number | undefined {
  const last = samples[samples.length - 1];
  if (!last) return undefined;
  const target = last.time - hours * HOUR;
  let best: OiSample | undefined;
  for (const s of samples) {
    if (s.time > last.time - hours * HOUR * 0.9) break;
    if (!best || Math.abs(s.time - target) < Math.abs(best.time - target)) best = s;
  }
  return best && best.oi > 0 ? last.oi / best.oi - 1 : undefined;
}

/**
 * The change in open interest and price from the oldest sample to the last:
 * what's known before the samples cover a whole window. Undefined until
 * they span `minMinutes`.
 */
export function oiChangeSoFar(
  samples: readonly OiSample[],
  minMinutes = 10,
): { oi: number; price?: number; minutes: number } | undefined {
  const first = samples[0];
  const last = samples[samples.length - 1];
  if (!first || !last || first.oi <= 0) return undefined;
  const minutes = (last.time - first.time) / 60_000;
  if (minutes < minMinutes) return undefined;
  return {
    oi: last.oi / first.oi - 1,
    price: first.price && last.price && first.price > 0 ? last.price / first.price - 1 : undefined,
    minutes,
  };
}

/** Hours of samples kept per market: a day and a bit. */
export const OI_KEEP = 26;
/** Samples are kept every 5 minutes for the last 2 hours, then hourly. */
const OI_FINE = 5 * 60_000;
const OI_FINE_SPAN = 2 * HOUR;

/**
 * `samples` with one at `time` added, thinned: one per 5 minutes over the
 * last 2 hours, one per hour before that (the latest in each kept), the last
 * `OI_KEEP` hours in all.
 */
export function withOiSample(
  samples: readonly OiSample[],
  time: number,
  oi: number,
  price?: number,
): OiSample[] {
  if (!(oi > 0)) return [...samples];
  const all = [...samples, price && price > 0 ? { time, oi, price } : { time, oi }]
    .filter((s) => s.time > time - OI_KEEP * HOUR)
    .sort((a, b) => a.time - b.time);
  const bucket = (t: number) =>
    t > time - OI_FINE_SPAN ? `f${Math.floor(t / OI_FINE)}` : `h${Math.floor(t / HOUR)}`;
  // The latest sample in each bucket wins.
  const kept = new Map<string, OiSample>();
  for (const s of all) kept.set(bucket(s.time), s);
  return [...kept.values()];
}

export type OiQuadrant = "newLongs" | "shortCovering" | "newShorts" | "longsClosing";

/** What price and open interest moving together usually mean. */
export function oiQuadrant(priceChange: number, oiChange: number): OiQuadrant {
  if (priceChange >= 0) return oiChange >= 0 ? "newLongs" : "shortCovering";
  return oiChange >= 0 ? "newShorts" : "longsClosing";
}

// --- Seasonality and sessions --------------------------------------------

export interface HourCell {
  /** Mean hourly return. */
  avg: number;
  count: number;
  /** Share of those hours that closed up. */
  upShare: number;
}

/**
 * Mean hourly return by UTC weekday (0 = Monday) and hour: `grid[day][hour]`,
 * undefined where no candle fell.
 */
export function seasonality(candles: readonly Candle[]): (HourCell | undefined)[][] {
  const sums = Array.from({ length: 7 }, () =>
    Array.from({ length: 24 }, () => ({ sum: 0, count: 0, up: 0 })),
  );
  for (const c of candles) {
    const open = num(c.open);
    const close = num(c.close);
    if (!(open > 0) || !finite(close)) continue;
    const d = new Date(c.openTime);
    const cell = sums[(d.getUTCDay() + 6) % 7]?.[d.getUTCHours()];
    if (!cell) continue;
    const r = close / open - 1;
    cell.sum += r;
    cell.count += 1;
    if (r > 0) cell.up += 1;
  }
  return sums.map((row) =>
    row.map((c) =>
      c.count === 0 ? undefined : { avg: c.sum / c.count, count: c.count, upShare: c.up / c.count },
    ),
  );
}

export interface HourProfile {
  hour: number;
  /** Mean return in this UTC hour. */
  avg: number;
  /** Mean high-to-low range, as a share of the open. */
  range: number;
  /** This hour's share of the day's volume. */
  volumeShare: number;
}

/** Each UTC hour's average return, range and share of volume. */
export function hourProfile(candles: readonly Candle[]): HourProfile[] {
  const hours = Array.from({ length: 24 }, () => ({ ret: 0, range: 0, volume: 0, count: 0 }));
  let total = 0;
  for (const c of candles) {
    const open = num(c.open);
    if (!(open > 0)) continue;
    const h = hours[new Date(c.openTime).getUTCHours()];
    if (!h) continue;
    const volume = num(c.volume) * num(c.close) || 0;
    h.ret += num(c.close) / open - 1;
    h.range += (num(c.high) - num(c.low)) / open;
    h.volume += volume;
    h.count += 1;
    total += volume;
  }
  return hours.map((h, hour) => ({
    hour,
    avg: h.count ? h.ret / h.count : 0,
    range: h.count ? h.range / h.count : 0,
    volumeShare: total > 0 ? h.volume / total : 0,
  }));
}

export type SessionId = "asia" | "europe" | "us";
/** The trading sessions in UTC hours, start inclusive, end exclusive. */
export const SESSIONS: readonly { id: SessionId; start: number; end: number }[] = [
  { id: "asia", start: 0, end: 8 },
  { id: "europe", start: 7, end: 16 },
  { id: "us", start: 13, end: 21 },
];

export const inSession = (hour: number, s: { start: number; end: number }) =>
  hour >= s.start && hour < s.end;

/** The sessions open at `time`. */
export const sessionsAt = (time: number) =>
  SESSIONS.filter((s) => inSession(new Date(time).getUTCHours(), s)).map((s) => s.id);

export interface SessionStats {
  id: SessionId;
  /** Share of the day's volume traded in it (sessions overlap, so these sum past 1). */
  volumeShare: number;
  /** Mean hourly range in it. */
  range: number;
  /** Mean return over the session, summed from its hours. */
  drift: number;
}

export function sessionStats(profile: readonly HourProfile[]): SessionStats[] {
  return SESSIONS.map((s) => {
    const hours = profile.filter((h) => inSession(h.hour, s));
    return {
      id: s.id,
      volumeShare: hours.reduce((a, h) => a + h.volumeShare, 0),
      range: mean(hours.map((h) => h.range)) ?? 0,
      drift: hours.reduce((a, h) => a + h.avg, 0),
    };
  });
}

// --- Order book heat -----------------------------------------------------

/** One moment of the book: resting size per price row. */
export interface BookColumn {
  time: number;
  mid: number;
  /** Size (in quote currency) by row index; row 0 is the top price. */
  rows: Float32Array;
}

/**
 * The book's resting size in quote currency, binned into `rows` rows of
 * `step` each, the top row's lower edge at `top`.
 */
export function bookColumn(
  book: Pick<OrderBook, "bids" | "asks">,
  top: number,
  step: number,
  rows: number,
  time: number,
): BookColumn | undefined {
  const bid = num(book.bids[0]?.price);
  const ask = num(book.asks[0]?.price);
  if (!(bid > 0) || !(ask > 0) || !(step > 0)) return undefined;
  const out = new Float32Array(rows);
  for (const level of [...book.bids, ...book.asks]) {
    const price = num(level.price);
    const size = num(level.size);
    const row = Math.floor((top + step - price) / step);
    if (row >= 0 && row < rows && size > 0) out[row] = (out[row] ?? 0) + size * price;
  }
  return { time, mid: (bid + ask) / 2, rows: out };
}

/** A round price step giving about `rows` rows over ±`span` of `mid`. */
export function bookStep(mid: number, span: number, rows: number): number {
  const raw = (mid * span * 2) / rows;
  if (!(raw > 0)) return 0;
  const power = 10 ** Math.floor(Math.log10(raw));
  const unit = [1, 2, 2.5, 5, 10].find((u) => u * power >= raw) ?? 10;
  return unit * power;
}

// --- Relative strength and rotation ----------------------------------------

/**
 * A market's return over a window less the benchmark's (BTC's) over the
 * same window: above 0 it outran the benchmark, below it fell behind.
 */
export function relativeStrength(
  change: number | undefined,
  benchmark: number | undefined,
): number | undefined {
  return change === undefined || benchmark === undefined ? undefined : change - benchmark;
}

/** A rotation chart's two windows: the trend's, and the momentum's within it. */
export type RotationLens = "week" | "day";
export const ROTATION_LENSES: readonly RotationLens[] = ["week", "day"];
export const ROTATION_HOURS: Record<RotationLens, { trend: number; momentum: number }> = {
  week: { trend: 168, momentum: 24 },
  day: { trend: 24, momentum: 4 },
};

export type RotationQuadrant = "leading" | "weakening" | "lagging" | "improving";
export const ROTATION_QUADRANTS: readonly RotationQuadrant[] = [
  "leading",
  "weakening",
  "lagging",
  "improving",
];

/**
 * Where a market sits on the rotation chart: ahead of the benchmark over the
 * trend window or behind it, and gaining on it lately or losing ground.
 */
export function rotationQuadrant(trend: number, momentum: number): RotationQuadrant {
  if (trend >= 0) return momentum >= 0 ? "leading" : "weakening";
  return momentum >= 0 ? "improving" : "lagging";
}

// --- Breakouts -------------------------------------------------------------

export type RangeWindow = "24h" | "7d";
export const RANGE_WINDOWS: readonly RangeWindow[] = ["24h", "7d"];
export const RANGE_HOURS: Record<RangeWindow, number> = { "24h": 24, "7d": 168 };

export interface RangePlace {
  high: number;
  low: number;
  /** Where the price sits in the range: 0 at its low, 1 at its high. */
  position: number;
  /** How far the price is from the high and the low, as shares of it (≤ 0, ≥ 0). */
  toHigh: number;
  toLow: number;
}

/** Where `price` sits in the range of the last `hours` hourly candles. */
export function rangePlace(
  candles: readonly Candle[],
  hours: number,
  price: number,
): RangePlace | undefined {
  const recent = candles.slice(-hours);
  if (recent.length < Math.min(hours, 12) || !(price > 0)) return undefined;
  let high = price;
  let low = price;
  for (const c of recent) {
    high = Math.max(high, num(c.high));
    low = Math.min(low, num(c.low));
  }
  if (!(high > low) || !(low > 0)) return undefined;
  return {
    high,
    low,
    position: (price - low) / (high - low),
    toHigh: price / high - 1,
    toLow: price / low - 1,
  };
}

// --- Volume spikes ---------------------------------------------------------

export type SpikeWindow = "1h" | "4h";
export const SPIKE_WINDOWS: readonly SpikeWindow[] = ["1h", "4h"];
export const SPIKE_HOURS: Record<SpikeWindow, number> = { "1h": 1, "4h": 4 };

export interface VolumeSpike {
  /** The window's volume over what the market usually trades in as long. */
  ratio: number;
  /** The window's volume, in base units. */
  recent: number;
  /** The usual: the median hour of the rest of the history, times the window. */
  usual: number;
  /** The price's change over the window. */
  change?: number;
}

/**
 * The last `hours` whole hours' volume against the market's usual for as
 * long (the median hour of the history before them). The newest candle is
 * left out: it's still forming.
 */
export function volumeSpike(candles: readonly Candle[], hours: number): VolumeSpike | undefined {
  const done = candles.slice(0, -1);
  const recent = done.slice(-hours);
  const before = done.slice(0, -hours);
  if (recent.length < hours || before.length < 24) return undefined;
  const usualHour = median(before.map((c) => num(c.volume)));
  if (usualHour === undefined || !(usualHour > 0)) return undefined;
  const volume = recent.reduce((a, c) => a + num(c.volume), 0);
  const first = num(recent[0]?.open);
  const last = num(recent[recent.length - 1]?.close);
  return {
    ratio: volume / (usualHour * hours),
    recent: volume,
    usual: usualHour * hours,
    change: first > 0 && last > 0 ? last / first - 1 : undefined,
  };
}

// --- Beta to the benchmark -------------------------------------------------

export interface Beta {
  /** How far the market moves for each 1% the benchmark does. */
  beta: number;
  /** How tightly: the correlation of their hourly returns. */
  correlation: number;
  /** The market's own volatility over the window, annualised. */
  vol: number;
}

/**
 * The market's beta to the benchmark over the last `hours` hours: the slope
 * of its hourly returns against the benchmark's, over the hours both have.
 */
export function betaTo(
  candles: readonly Candle[],
  benchmark: readonly Candle[],
  hours: number,
): Beta | undefined {
  const own = returnsByHour(candles, hours);
  const bench = returnsByHour(benchmark, hours);
  const xs: number[] = [];
  const ys: number[] = [];
  for (const [time, r] of own) {
    const b = bench.get(time);
    if (b !== undefined) {
      xs.push(b);
      ys.push(r);
    }
  }
  if (xs.length < Math.min(hours / 2, 12)) return undefined;
  const mx = mean(xs) ?? 0;
  const my = mean(ys) ?? 0;
  let cov = 0;
  let vx = 0;
  for (let i = 0; i < xs.length; i++) {
    cov += ((xs[i] ?? 0) - mx) * ((ys[i] ?? 0) - my);
    vx += ((xs[i] ?? 0) - mx) ** 2;
  }
  const correlation = pearson(xs, ys);
  const sd = stdev(ys);
  if (!(vx > 0) || correlation === undefined || sd === undefined) return undefined;
  return { beta: cov / vx, correlation, vol: sd * Math.sqrt(YEAR_HOURS) };
}

// --- Breadth ---------------------------------------------------------------

/** An exponential moving average of `values`, one per value, seeded with the first. */
export function emaOf(values: readonly number[], period: number): number[] {
  const k = 2 / (period + 1);
  const out: number[] = [];
  let prev: number | undefined;
  for (const v of values) {
    prev = prev === undefined ? v : v * k + prev * (1 - k);
    out.push(prev);
  }
  return out;
}

export interface BreadthNow {
  /** Markets counted: those with enough history. */
  total: number;
  /** Shares of them, 0 to 1. */
  up24h: number;
  aboveEma20: number;
  aboveEma50: number;
  /** Markets at a new 7-day high, and at a new 7-day low, within the last day. */
  newHighs: number;
  newLows: number;
}

/**
 * How broad the market is now: the share of markets up on the day and above
 * their 20- and 50-hour EMAs, and how many made a new 7-day high or low
 * within the last 24 hours.
 */
export function breadthNow(histories: readonly (readonly Candle[])[]): BreadthNow {
  let total = 0;
  let up = 0;
  let above20 = 0;
  let above50 = 0;
  let highs = 0;
  let lows = 0;
  for (const candles of histories) {
    if (candles.length < 60) continue;
    const closes = candles.map((c) => num(c.close));
    const last = closes[closes.length - 1] ?? 0;
    if (!(last > 0)) continue;
    total++;
    const dayAgo = num(candles[candles.length - 25]?.close);
    if (dayAgo > 0 && last > dayAgo) up++;
    if (last > (emaOf(closes, 20).at(-1) ?? Number.POSITIVE_INFINITY)) above20++;
    if (last > (emaOf(closes, 50).at(-1) ?? Number.POSITIVE_INFINITY)) above50++;
    const earlier = candles.slice(0, -24);
    const day = candles.slice(-24);
    const priorHigh = Math.max(...earlier.map((c) => num(c.high)));
    const priorLow = Math.min(...earlier.map((c) => num(c.low)));
    if (Math.max(...day.map((c) => num(c.high))) > priorHigh) highs++;
    if (Math.min(...day.map((c) => num(c.low))) < priorLow) lows++;
  }
  const share = (n: number) => (total > 0 ? n / total : 0);
  return {
    total,
    up24h: share(up),
    aboveEma20: share(above20),
    aboveEma50: share(above50),
    newHighs: highs,
    newLows: lows,
  };
}

export interface BreadthPoint {
  /** The hour, by its candle's open time. */
  time: number;
  /** Share of the markets with that hour whose close was above their 20-hour EMA. */
  aboveEma: number;
  /** Share of them up on the 24 hours before. */
  up24h: number;
  /** Markets counted that hour. */
  count: number;
}

/**
 * Breadth hour by hour over the history: for each hour, the share of
 * markets above their 20-hour EMA and the share up on the day. The first
 * day is left out while the EMAs and the day's change settle.
 */
export function breadthSeries(histories: readonly (readonly Candle[])[]): BreadthPoint[] {
  const by = new Map<number, { above: number; up: number; count: number }>();
  for (const candles of histories) {
    const closes = candles.map((c) => num(c.close));
    const ema = emaOf(closes, 20);
    for (let i = 24; i < candles.length; i++) {
      const time = candles[i]?.openTime;
      const close = closes[i] ?? 0;
      const dayAgo = closes[i - 24] ?? 0;
      if (time === undefined || !(close > 0) || !(dayAgo > 0)) continue;
      const at = by.get(time) ?? { above: 0, up: 0, count: 0 };
      if (close > (ema[i] ?? Number.POSITIVE_INFINITY)) at.above++;
      if (close > dayAgo) at.up++;
      at.count++;
      by.set(time, at);
    }
  }
  const most = Math.max(0, ...[...by.values()].map((v) => v.count));
  return (
    [...by]
      // Hours too few markets reach (the oldest, where histories begin) are left out.
      .filter(([, v]) => v.count >= Math.max(1, most * 0.5))
      .sort(([a], [b]) => a - b)
      .map(([time, v]) => ({
        time,
        aboveEma: v.above / v.count,
        up24h: v.up / v.count,
        count: v.count,
      }))
  );
}

// --- Funding history -------------------------------------------------------

/** Funding over the last 7 days, in 8-hour buckets: 21 of them. */
export const FUNDING_BUCKET_MS = 8 * HOUR;
export const FUNDING_BUCKETS = 21;

/**
 * Funding payments summed into 8-hour buckets from `start`: an hourly
 * venue's eight payments come to its 8-hour rate, an 8-hour venue's one is.
 * Undefined for a bucket with none.
 */
export function fundingBuckets(
  rates: readonly { time: number; rate: number }[],
  start: number,
  bucketMs = FUNDING_BUCKET_MS,
  count = FUNDING_BUCKETS,
): (number | undefined)[] {
  const out: (number | undefined)[] = Array.from({ length: count }, () => undefined);
  for (const r of rates) {
    const i = Math.floor((r.time - start) / bucketMs);
    if (i < 0 || i >= count || !finite(r.rate)) continue;
    out[i] = (out[i] ?? 0) + r.rate;
  }
  return out;
}

// --- Order flow ------------------------------------------------------------

/** A trade as the order-flow views take it. */
export interface FlowTrade {
  id: string;
  /** Milliseconds since the epoch. */
  time: number;
  price: number;
  /** In base units. */
  size: number;
  /** The aggressor: a buy lifted the ask, a sell hit the bid. */
  side: "buy" | "sell";
}

export type FlowBucket = "10s" | "1m" | "5m";
export const FLOW_BUCKETS: readonly FlowBucket[] = ["10s", "1m", "5m"];
export const FLOW_BUCKET_MS: Record<FlowBucket, number> = {
  "10s": 10_000,
  "1m": 60_000,
  "5m": 300_000,
};

export interface FlowPoint {
  /** The bucket's start. */
  time: number;
  /** The last trade's price in it. */
  price: number;
  /** Volume bought and sold by aggressors, in base units. */
  buy: number;
  sell: number;
  /** Cumulative volume delta to the end of the bucket: buys less sells, since the first trade. */
  cvd: number;
}

/** Trades (any order) in buckets, oldest first, with the delta running across them. */
export function cvdSeries(trades: readonly FlowTrade[], bucketMs: number): FlowPoint[] {
  const sorted = [...trades].sort((a, b) => a.time - b.time);
  const out: FlowPoint[] = [];
  let cvd = 0;
  for (const tr of sorted) {
    const time = Math.floor(tr.time / bucketMs) * bucketMs;
    let at = out[out.length - 1];
    if (!at || at.time !== time) {
      at = { time, price: tr.price, buy: 0, sell: 0, cvd };
      out.push(at);
    }
    if (tr.side === "buy") {
      at.buy += tr.size;
      cvd += tr.size;
    } else {
      at.sell += tr.size;
      cvd -= tr.size;
    }
    at.price = tr.price;
    at.cvd = cvd;
  }
  return out;
}

export type LargeShare = "1" | "5" | "10";
export const LARGE_SHARES: readonly LargeShare[] = ["1", "5", "10"];

/**
 * The biggest trades by value: the top `share` of `trades` (by price times
 * size), and the value a trade needed to make it.
 */
export function largeTrades(
  trades: readonly FlowTrade[],
  share: number,
): { threshold: number; trades: FlowTrade[] } {
  if (trades.length === 0) return { threshold: 0, trades: [] };
  const values = trades.map((tr) => tr.price * tr.size).sort((a, b) => b - a);
  const keep = Math.max(1, Math.round(trades.length * share));
  const threshold = values[keep - 1] ?? 0;
  return {
    threshold,
    trades: trades.filter((tr) => tr.price * tr.size >= threshold),
  };
}

// --- Volume profiles across markets ---------------------------------------

/** Rows a market's profile is worked out in. */
const PROFILE_ROWS = 60;
/** The share of the volume in the value area, as on the charts' profiles. */
const VALUE_AREA = 0.7;

const toBars = (candles: readonly Candle[]): Bar[] =>
  candles.map((c) => ({
    time: c.openTime / 1000,
    open: num(c.open),
    high: num(c.high),
    low: num(c.low),
    close: num(c.close),
    volume: num(c.volume),
  }));

/** The volume profile of hourly candles. */
export function candleProfile(
  candles: readonly Candle[],
  rows = PROFILE_ROWS,
): VolumeProfile | undefined {
  return volumeProfile(toBars(candles), rows, VALUE_AREA);
}

export type ValuePlace = "above" | "inside" | "below";

export interface ValueRead {
  /** Point of control: the middle of the busiest row. */
  poc: number;
  /** The value area's top and bottom. */
  vah: number;
  val: number;
  /** Where the price is against the value area. */
  place: ValuePlace;
  /** How far the price is from the point of control, as a share of it. */
  toPoc: number;
}

/** Where `price` sits against the profile of `candles`. */
export function valueRead(candles: readonly Candle[], price: number): ValueRead | undefined {
  if (candles.length < 12 || !(price > 0)) return undefined;
  const profile = candleProfile(candles);
  const pocRow = profile?.rows[profile.poc];
  const top = profile?.rows[profile.valueHigh];
  const bottom = profile?.rows[profile.valueLow];
  if (!pocRow || !top || !bottom) return undefined;
  const poc = (pocRow.low + pocRow.high) / 2;
  const vah = top.high;
  const val = bottom.low;
  return {
    poc,
    vah,
    val,
    place: price > vah ? "above" : price < val ? "below" : "inside",
    toPoc: price / poc - 1,
  };
}

export interface NakedPoc {
  /** The day the point of control is from, by its first candle's open time. */
  time: number;
  price: number;
}

/**
 * Each finished UTC day's point of control that no later candle has traded
 * through: the untested levels price often comes back to. Oldest first.
 */
export function nakedPocs(candles: readonly Candle[]): NakedPoc[] {
  const days = new Map<number, Candle[]>();
  for (const c of candles) {
    const day = Math.floor(c.openTime / (24 * HOUR));
    const list = days.get(day);
    if (list) list.push(c);
    else days.set(day, [c]);
  }
  const sorted = [...days.keys()].sort((a, b) => a - b);
  const out: NakedPoc[] = [];
  // The last day is still forming.
  for (const day of sorted.slice(0, -1)) {
    const list = days.get(day) ?? [];
    const profile = candleProfile(list, 30);
    const row = profile?.rows[profile.poc];
    if (!row) continue;
    const price = (row.low + row.high) / 2;
    const end = (day + 1) * 24 * HOUR;
    const touched = candles.some(
      (c) => c.openTime >= end && num(c.low) <= price && num(c.high) >= price,
    );
    if (!touched) out.push({ time: list[0]?.openTime ?? 0, price });
  }
  return out;
}

// --- Money flow and on-balance volume --------------------------------------

export type FlowWindow = "4h" | "24h" | "7d";
export const FLOW_WINDOWS: readonly FlowWindow[] = ["4h", "24h", "7d"];
export const FLOW_HOURS: Record<FlowWindow, number> = { "4h": 4, "24h": 24, "7d": 168 };

export interface MoneyFlow {
  /** Value traded on up hours less value traded on down hours, in quote currency. */
  net: number;
  /** All the value traded. */
  gross: number;
  /** `net` over `gross`: -1 all selling hours, 1 all buying ones. */
  ratio: number;
}

/** Up-hour against down-hour value over the last `hours` hourly candles. */
export function moneyFlow(candles: readonly Candle[], hours: number): MoneyFlow | undefined {
  const recent = candles.slice(-hours);
  if (recent.length < Math.min(hours, 4)) return undefined;
  let net = 0;
  let gross = 0;
  for (const c of recent) {
    const value = num(c.volume) * num(c.close);
    gross += value;
    net += num(c.close) >= num(c.open) ? value : -value;
  }
  return gross > 0 ? { net, gross, ratio: net / gross } : undefined;
}

export type ObvKind = "bullish" | "bearish";

export interface ObvRead {
  /** Where the price and the OBV sit in their own ranges over the window, 0 to 1. */
  price: number;
  obv: number;
  /** `obv` less `price`: above 0 volume is ahead of price, below it behind. */
  gap: number;
  /** Set when they disagree: price low and OBV high, or the reverse. */
  kind?: ObvKind;
}

/** How far apart they must sit in their ranges to count as a divergence. */
const OBV_GAP = 0.4;

const placeIn = (values: readonly number[]) => {
  const lo = Math.min(...values);
  const hi = Math.max(...values);
  const last = values[values.length - 1] ?? lo;
  return hi > lo ? (last - lo) / (hi - lo) : 0.5;
};

/**
 * On-balance volume (each hour's volume added on an up close, taken off on
 * a down one) against price over the last `hours` hours.
 */
export function obvRead(candles: readonly Candle[], hours: number): ObvRead | undefined {
  const recent = candles.slice(-(hours + 1));
  if (recent.length < Math.min(hours, 12)) return undefined;
  const closes = recent.map((c) => num(c.close));
  const obv = [0];
  for (let i = 1; i < recent.length; i++) {
    const was = obv[i - 1] ?? 0;
    const move = (closes[i] ?? 0) - (closes[i - 1] ?? 0);
    const volume = num(recent[i]?.volume);
    obv.push(move > 0 ? was + volume : move < 0 ? was - volume : was);
  }
  const price = placeIn(closes);
  const volume = placeIn(obv);
  const gap = volume - price;
  const kind =
    Math.abs(gap) < OBV_GAP ? undefined : gap > 0 ? ("bullish" as const) : ("bearish" as const);
  return { price, obv: volume, gap, kind };
}

// --- Volume rotation -------------------------------------------------------

/** Value traded over the last `hours` hourly candles, in quote currency. */
export function quoteVolume(candles: readonly Candle[], hours: number): number {
  return candles.slice(-hours).reduce((a, c) => a + num(c.volume) * num(c.close), 0);
}

export interface VolumeShare {
  /** The market's share of the venue's volume over the last day, and the whole week. */
  day: number;
  week: number;
  /** `day` over `week`, less 1: above 0 it's drawing more of the volume than usual. */
  change: number;
}

/** Each market's share of the volume over the last day against over the week. */
export function volumeShares(
  series: ReadonlyMap<string, readonly Candle[]>,
): Map<string, VolumeShare> {
  let dayTotal = 0;
  let weekTotal = 0;
  const raw = new Map<string, { day: number; week: number }>();
  for (const [id, candles] of series) {
    const day = quoteVolume(candles, 24);
    const week = quoteVolume(candles, 168);
    if (!(day > 0) || !(week > 0)) continue;
    raw.set(id, { day, week });
    dayTotal += day;
    weekTotal += week;
  }
  const out = new Map<string, VolumeShare>();
  for (const [id, v] of raw) {
    const day = v.day / dayTotal;
    const week = v.week / weekTotal;
    out.set(id, { day, week, change: day / week - 1 });
  }
  return out;
}

// --- Momentum --------------------------------------------------------------

/**
 * How well a market's timeframes agree: windows up less windows down, from
 * every window against to every window with. Undefined with none known.
 */
export function alignment(changes: readonly (number | undefined)[]): number | undefined {
  const known = changes.filter((c): c is number => c !== undefined);
  if (known.length === 0) return undefined;
  return known.filter((c) => c > 0).length - known.filter((c) => c < 0).length;
}

export type CrossWindow = "12h" | "24h" | "48h";
export const CROSS_WINDOWS: readonly CrossWindow[] = ["12h", "24h", "48h"];
export const CROSS_HOURS: Record<CrossWindow, number> = { "12h": 12, "24h": 24, "48h": 48 };

export interface EmaCross {
  direction: "up" | "down";
  /** Hours since the cross. */
  hoursAgo: number;
  /** The fast EMA's distance from the slow one now, as a share of it. */
  gap: number;
}

/**
 * The latest cross of the 20- and 50-hour EMAs within the last `within`
 * hours, if there's been one. Crosses in the EMAs' first hours, while
 * they're settling, don't count.
 */
export function emaCross(
  candles: readonly Candle[],
  within: number,
  fast = 20,
  slow = 50,
): EmaCross | undefined {
  if (candles.length < slow + 2) return undefined;
  const closes = candles.map((c) => num(c.close));
  const a = emaOf(closes, fast);
  const b = emaOf(closes, slow);
  const last = closes.length - 1;
  const gapAt = (i: number) => (a[i] ?? 0) - (b[i] ?? 0);
  for (let i = last; i > Math.max(last - within, slow); i--) {
    const now = gapAt(i);
    const before = gapAt(i - 1);
    if ((now > 0 && before <= 0) || (now < 0 && before >= 0)) {
      const slowNow = b[last] ?? 0;
      return {
        direction: now > 0 ? "up" : "down",
        hoursAgo: last - i,
        gap: slowNow > 0 ? gapAt(last) / slowNow : 0,
      };
    }
  }
  return undefined;
}

export interface Squeeze {
  /** Bollinger band width now: four standard deviations over the average. */
  bandwidth: number;
  /** The share of the history's widths at or below it, 0 to 1: low is tight. */
  rank: number;
}

/** How tight a market's 20-hour Bollinger bands are against the rest of its history. */
export function squeezeRead(candles: readonly Candle[], period = 20): Squeeze | undefined {
  const closes = candles.map((c) => num(c.close));
  if (closes.length < period + 24) return undefined;
  const widths: number[] = [];
  for (let i = period; i <= closes.length; i++) {
    const slice = closes.slice(i - period, i);
    const m = mean(slice);
    const sd = stdev(slice);
    if (m !== undefined && m > 0 && sd !== undefined) widths.push((4 * sd) / m);
  }
  const bandwidth = widths[widths.length - 1];
  if (bandwidth === undefined) return undefined;
  return { bandwidth, rank: widths.filter((w) => w <= bandwidth).length / widths.length };
}

// --- Bollinger bands -------------------------------------------------------

export type BandFrame = "1h" | "4h";
export const BAND_FRAMES: readonly BandFrame[] = ["1h", "4h"];
export const BAND_FRAME_HOURS: Record<BandFrame, number> = { "1h": 1, "4h": 4 };

export type BandZone =
  | "aboveUpper"
  | "atUpper"
  | "nearUpper"
  | "middle"
  | "nearLower"
  | "atLower"
  | "belowLower";
export const UPPER_ZONES = ["aboveUpper", "atUpper", "nearUpper"] as const;
export const LOWER_ZONES = ["belowLower", "atLower", "nearLower"] as const;

/** Within this share of the bands' width from a band, price is at it; within the next, near it. */
const BAND_AT = 0.05;
const BAND_NEAR = 0.2;

export interface BandRead {
  upper: number;
  middle: number;
  lower: number;
  /** %B: where the price sits, 0 at the lower band, 1 at the upper, beyond them outside. */
  percentB: number;
  zone: BandZone;
}

/** Which zone a %B falls in. */
export function bandZone(percentB: number): BandZone {
  if (percentB > 1) return "aboveUpper";
  if (percentB < 0) return "belowLower";
  if (percentB >= 1 - BAND_AT) return "atUpper";
  if (percentB <= BAND_AT) return "atLower";
  if (percentB >= 1 - BAND_NEAR) return "nearUpper";
  if (percentB <= BAND_NEAR) return "nearLower";
  return "middle";
}

/** Closes of hourly candles gathered into `hours`-long bars, on UTC multiples of them. */
function closesEvery(candles: readonly Candle[], hours: number): number[] {
  if (hours <= 1) return candles.map((c) => num(c.close));
  const out: number[] = [];
  let bar: number | undefined;
  for (const c of candles) {
    const at = Math.floor(c.openTime / (hours * HOUR));
    if (at === bar) out[out.length - 1] = num(c.close);
    else {
      out.push(num(c.close));
      bar = at;
    }
  }
  return out;
}

/**
 * Where `price` sits against the market's Bollinger bands (`period` bars of
 * `frameHours` hours, two standard deviations either side of their average),
 * the forming bar taken at `price`.
 */
export function bandRead(
  candles: readonly Candle[],
  price: number,
  frameHours: number,
  period = 20,
): BandRead | undefined {
  const closes = closesEvery(candles, frameHours).slice(-period);
  if (closes.length < period || !(price > 0)) return undefined;
  closes[closes.length - 1] = price;
  const middle = mean(closes);
  const sd = stdev(closes);
  if (middle === undefined || sd === undefined || !(sd > 0)) return undefined;
  const upper = middle + 2 * sd;
  const lower = middle - 2 * sd;
  const percentB = (price - lower) / (upper - lower);
  return { upper, middle, lower, percentB, zone: bandZone(percentB) };
}

export interface ConfluenceRead {
  /** RSI(14) on the bands' own bars. */
  rsi: number;
  band: BandRead;
  /** Overbought at or near the upper band, or oversold at or near the lower; else neither. */
  side?: "upper" | "lower";
}

/** A market's RSI and its place against its Bollinger bands, on the same bars. */
export function confluenceRead(
  candles: readonly Candle[],
  price: number,
  frameHours: number,
): ConfluenceRead | undefined {
  const band = bandRead(candles, price, frameHours);
  if (!band) return undefined;
  const closes = closesEvery(candles, frameHours);
  closes[closes.length - 1] = price;
  const value = rsi(closes);
  if (value === undefined) return undefined;
  const zone = rsiZone(value);
  const inside = (zones: readonly BandZone[]) => zones.includes(band.zone);
  const side =
    zone === "overbought" && inside(UPPER_ZONES)
      ? "upper"
      : zone === "oversold" && inside(LOWER_ZONES)
        ? "lower"
        : undefined;
  return { rsi: value, band, side };
}
