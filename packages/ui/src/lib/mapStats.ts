import type { Candle, MarketSummary, OrderBook, VenueId } from "@pewterdesk/core";

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
