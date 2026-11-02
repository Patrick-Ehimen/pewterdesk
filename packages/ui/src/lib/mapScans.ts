import type { Candle, VenueId } from "@pewterdesk/core";
import { type CoinRow, candleProfile, closesEvery, HOUR, mean, pearson } from "./mapStats";

// The Maps page's scans: what a market is doing, how far it has gone, who is
// crowded and how markets move together. Plain arithmetic over the hourly
// candles and summaries the app already reads, as `mapStats` is, so each can
// be tested without a venue. Nothing here reaches an order.

const DAY = 24 * HOUR;
/** Hours in a year, to annualise hourly figures. */
const YEAR_HOURS = 24 * 365;

const num = (v: unknown) => Number(v);
const clamp01 = (v: number) => Math.min(1, Math.max(0, v));

function stdevOf(values: readonly number[]): number | undefined {
  const m = mean(values);
  if (m === undefined || values.length < 2) return undefined;
  return Math.sqrt(values.reduce((a, v) => a + (v - m) ** 2, 0) / (values.length - 1));
}

// --- Regime --------------------------------------------------------------

export type RegimeKind = "trendUp" | "trendDown" | "ranging" | "choppy";
export const REGIME_FILTERS = ["all", "trending", "ranging", "choppy"] as const;
export type RegimeFilter = (typeof REGIME_FILTERS)[number];

export const inRegimeFilter = (kind: RegimeKind, filter: RegimeFilter) =>
  filter === "all" ||
  (filter === "trending" ? kind === "trendUp" || kind === "trendDown" : kind === filter);

export interface RegimeRead {
  kind: RegimeKind;
  /** Average directional index, 0 to 100: how strong any trend is. */
  adx: number;
  /** Net move over the path taken, 0 to 1: 1 is a straight line. */
  efficiency: number;
}

/** A strong trend, and a weak one, by the ADX's usual readings. */
const ADX_TREND = 25;
const ADX_WEAK = 20;
/** Below this a strong ADX is big swings getting nowhere, not a trend. */
const EFFICIENT = 0.2;

/** Wilder's ADX over `n` bars, with which side of it is stronger. */
export function adx(candles: readonly Candle[], n = 14) {
  if (candles.length < n * 2 + 1) return undefined;
  let tr = 0;
  let plus = 0;
  let minus = 0;
  const dx: number[] = [];
  let up = true;
  for (let i = 1; i < candles.length; i++) {
    const c = candles[i] as Candle;
    const p = candles[i - 1] as Candle;
    const high = num(c.high);
    const low = num(c.low);
    const close = num(p.close);
    const range = Math.max(high - low, Math.abs(high - close), Math.abs(low - close));
    const rise = high - num(p.high);
    const fall = num(p.low) - low;
    const plusMove = rise > fall && rise > 0 ? rise : 0;
    const minusMove = fall > rise && fall > 0 ? fall : 0;
    if (i <= n) {
      tr += range;
      plus += plusMove;
      minus += minusMove;
      if (i < n) continue;
    } else {
      tr += range - tr / n;
      plus += plusMove - plus / n;
      minus += minusMove - minus / n;
    }
    if (!(tr > 0)) continue;
    const diPlus = plus / tr;
    const diMinus = minus / tr;
    const sum = diPlus + diMinus;
    dx.push(sum > 0 ? (100 * Math.abs(diPlus - diMinus)) / sum : 0);
    up = diPlus >= diMinus;
  }
  if (dx.length < n) return undefined;
  let value = (mean(dx.slice(0, n)) as number) ?? 0;
  for (const d of dx.slice(n)) value = (value * (n - 1) + d) / n;
  return { adx: value, up };
}

/** The share of the path travelled that ended up as net move, 0 to 1. */
export function efficiency(closes: readonly number[]): number | undefined {
  const first = closes[0];
  const last = closes.at(-1);
  if (first === undefined || last === undefined || closes.length < 2) return undefined;
  let path = 0;
  for (let i = 1; i < closes.length; i++) {
    path += Math.abs((closes[i] as number) - (closes[i - 1] as number));
  }
  return path > 0 ? Math.abs(last - first) / path : 0;
}

/** Whether a market is trending, ranging, or swinging without getting anywhere. */
export function regimeRead(candles: readonly Candle[], hours = 48): RegimeRead | undefined {
  const strength = adx(candles);
  const moved = efficiency(candles.slice(-hours).map((c) => num(c.close)));
  if (!strength || moved === undefined) return undefined;
  const kind: RegimeKind =
    strength.adx >= ADX_TREND && moved >= EFFICIENT
      ? strength.up
        ? "trendUp"
        : "trendDown"
      : strength.adx < ADX_WEAK
        ? "ranging"
        : "choppy";
  return { kind, adx: strength.adx, efficiency: moved };
}

// --- Key levels ----------------------------------------------------------

export type LevelKind = "dayOpen" | "weekOpen" | "prevHigh" | "prevLow" | "weekHigh" | "weekLow";

export interface KeyLevel {
  kind: LevelKind;
  price: number;
  /** From the price to the level, as a fraction of the price. */
  distance: number;
}

export interface LevelsRead {
  levels: KeyLevel[];
  nearest: KeyLevel;
}

/**
 * How far `price` is from the levels traders watch: today's and this week's
 * opens (UTC, weeks from Monday), yesterday's high and low, and the 7-day
 * high and low. Those are what 7 days of hourly candles can show.
 */
export function levelsRead(
  candles: readonly Candle[],
  price: number,
  now: number,
): LevelsRead | undefined {
  if (!(price > 0) || candles.length === 0) return undefined;
  const today = Math.floor(now / DAY);
  const dayStart = today * DAY;
  // 1970-01-01 was a Thursday: three days on from a Monday.
  const weekStart = dayStart - ((today + 3) % 7) * DAY;
  const openFrom = (from: number) => candles.find((c) => c.openTime >= from);
  const yesterday = candles.filter((c) => c.openTime >= dayStart - DAY && c.openTime < dayStart);
  const highs = (list: readonly Candle[]) => list.map((c) => num(c.high));
  const lows = (list: readonly Candle[]) => list.map((c) => num(c.low));
  const entries: [LevelKind, number | undefined][] = [
    ["dayOpen", num(openFrom(dayStart)?.open) || undefined],
    ["weekOpen", num(openFrom(weekStart)?.open) || undefined],
    ["prevHigh", yesterday.length ? Math.max(...highs(yesterday)) : undefined],
    ["prevLow", yesterday.length ? Math.min(...lows(yesterday)) : undefined],
    ["weekHigh", Math.max(...highs(candles))],
    ["weekLow", Math.min(...lows(candles))],
  ];
  const levels = entries.flatMap(([kind, level]) =>
    level !== undefined && level > 0
      ? [{ kind, price: level, distance: (level - price) / price }]
      : [],
  );
  const nearest = [...levels].sort((a, b) => Math.abs(a.distance) - Math.abs(b.distance))[0];
  return nearest && { levels, nearest };
}

// --- RSI divergence ------------------------------------------------------

export function rsiSeries(closes: readonly number[], period = 14): (number | undefined)[] {
  const out: (number | undefined)[] = closes.map(() => undefined);
  if (closes.length < period + 1) return out;
  let gain = 0;
  let loss = 0;
  const at = (g: number, l: number) => (l === 0 ? (g === 0 ? 50 : 100) : 100 - 100 / (1 + g / l));
  for (let i = 1; i < closes.length; i++) {
    const d = (closes[i] as number) - (closes[i - 1] as number);
    if (i <= period) {
      gain += Math.max(d, 0) / period;
      loss += Math.max(-d, 0) / period;
    } else {
      gain = (gain * (period - 1) + Math.max(d, 0)) / period;
      loss = (loss * (period - 1) + Math.max(-d, 0)) / period;
    }
    if (i >= period) out[i] = at(gain, loss);
  }
  return out;
}

export type DivergenceKind = "bullish" | "bearish";

export interface Divergence {
  kind: DivergenceKind;
  /** RSI at the earlier swing and the later one. */
  rsiFrom: number;
  rsiTo: number;
  /** Price from the earlier swing to the later one. */
  priceChange: number;
  /** Bars since the later swing. */
  barsAgo: number;
}

/** Bars each side of a swing that it must stand clear of. */
const SWING_WING = 3;
/** How old the later swing may be, in bars, and how far back the earlier may reach. */
const SWING_RECENT = 12;
const SWING_REACH = 40;

/**
 * Price making a new low that RSI doesn't (bullish), or a new high it
 * doesn't (bearish), between the last two swings of `frameHours`-long bars.
 */
export function divergence(candles: readonly Candle[], frameHours: number) {
  const closes = closesEvery(candles, frameHours);
  const rsis = rsiSeries(closes);
  const last = closes.length - 1;
  const swings = (sign: 1 | -1) => {
    const found: number[] = [];
    for (let i = Math.max(SWING_WING, last - SWING_REACH); i <= last - SWING_WING; i++) {
      const v = (closes[i] as number) * sign;
      let clear = true;
      for (let k = 1; k <= SWING_WING && clear; k++) {
        if ((closes[i - k] as number) * sign >= v || (closes[i + k] as number) * sign >= v) {
          clear = false;
        }
      }
      if (clear && rsis[i] !== undefined) found.push(i);
    }
    return found;
  };
  const read = (kind: DivergenceKind): Divergence | undefined => {
    const list = swings(kind === "bearish" ? 1 : -1);
    const later = list.at(-1);
    const earlier = list.at(-2);
    if (later === undefined || earlier === undefined || last - later > SWING_RECENT) {
      return undefined;
    }
    const p0 = closes[earlier] as number;
    const p1 = closes[later] as number;
    const r0 = rsis[earlier] as number;
    const r1 = rsis[later] as number;
    const split = kind === "bearish" ? p1 > p0 && r1 < r0 : p1 < p0 && r1 > r0;
    return split && p0 > 0
      ? { kind, rsiFrom: r0, rsiTo: r1, priceChange: p1 / p0 - 1, barsAgo: last - later }
      : undefined;
  };
  const both = [read("bullish"), read("bearish")].flatMap((d) => d ?? []);
  return both.sort((a, b) => a.barsAgo - b.barsAgo)[0];
}

// --- Stretched from the mean ---------------------------------------------

export interface Stretch {
  /** Volume-weighted average price over the history. */
  vwap: number;
  /** From the VWAP to the price, in standard deviations of price around it. */
  z: number;
  fromVwap: number;
  /** From the 100-hour EMA to the price, as a fraction. */
  fromEma: number;
}

const STRETCH_EMA = 100;

/** How far `price` has gone from where the market has traded. */
export function stretchRead(candles: readonly Candle[], price: number): Stretch | undefined {
  if (candles.length < STRETCH_EMA || !(price > 0)) return undefined;
  let volume = 0;
  let value = 0;
  for (const c of candles) {
    const v = num(c.volume);
    volume += v;
    value += v * ((num(c.high) + num(c.low) + num(c.close)) / 3);
  }
  if (!(volume > 0)) return undefined;
  const vwap = value / volume;
  let spread = 0;
  for (const c of candles) {
    spread += num(c.volume) * ((num(c.high) + num(c.low) + num(c.close)) / 3 - vwap) ** 2;
  }
  const sd = Math.sqrt(spread / volume);
  if (!(sd > 0)) return undefined;
  const k = 2 / (STRETCH_EMA + 1);
  let ema = num(candles[0]?.close);
  for (const c of candles.slice(1)) ema += (num(c.close) - ema) * k;
  return { vwap, z: (price - vwap) / sd, fromVwap: price / vwap - 1, fromEma: price / ema - 1 };
}

// --- Volatility rank -----------------------------------------------------

export const VOL_RANK_SIDES = ["quiet", "wild"] as const;
export type VolRankSide = (typeof VOL_RANK_SIDES)[number];

export interface VolRank {
  /** The latest ATR as a share of price. */
  atr: number;
  /** Where it sits among the market's own readings, 0 (quietest) to 1. */
  rank: number;
}

/** Today's ATR against the market's own recent history. */
export function volRank(candles: readonly Candle[], n = 14): VolRank | undefined {
  if (candles.length < n * 3) return undefined;
  const shares: number[] = [];
  let atr = 0;
  for (let i = 1; i < candles.length; i++) {
    const c = candles[i] as Candle;
    const close = num(candles[i - 1]?.close);
    const high = num(c.high);
    const low = num(c.low);
    const range = Math.max(high - low, Math.abs(high - close), Math.abs(low - close));
    atr = i <= n ? atr + range / n : (atr * (n - 1) + range) / n;
    if (i >= n && num(c.close) > 0) shares.push(atr / num(c.close));
  }
  const latest = shares.at(-1);
  if (latest === undefined || shares.length < 2) return undefined;
  const earlier = shares.slice(0, -1);
  return { atr: latest, rank: earlier.filter((s) => s <= latest).length / earlier.length };
}

// --- Squeeze risk --------------------------------------------------------

export type CrowdedSide = "longs" | "shorts";

export interface Crowding {
  /** 0 to 100. */
  score: number;
  /** Who is paying to stay in, and so at risk of being flushed. */
  side: CrowdedSide;
  /** Funding, annualised. */
  apr: number;
}

/** Where each part of the score is full: 50% a year, 10% more OI, a 5% move. */
const CROWD_APR = 0.5;
const CROWD_OI = 0.1;
const CROWD_MOVE = 0.05;

/**
 * A crowded market: expensive funding, open interest still building, and a
 * price that hasn't moved to reward it. An unknown open interest counts for
 * nothing, so it can only lower a score.
 */
export function crowding(
  fundingPerHour: number,
  oiChange: number | undefined,
  priceChange: number | undefined,
): Crowding {
  const apr = fundingPerHour * YEAR_HOURS;
  const funding = clamp01(Math.abs(apr) / CROWD_APR);
  const building = oiChange === undefined ? 0 : clamp01(oiChange / CROWD_OI);
  const flat = priceChange === undefined ? 0 : 1 - clamp01(Math.abs(priceChange) / CROWD_MOVE);
  return {
    score: Math.round(100 * (0.45 * funding + 0.35 * building + 0.2 * flat)),
    side: fundingPerHour >= 0 ? "longs" : "shorts",
    apr,
  };
}

// --- Carry ---------------------------------------------------------------

export interface Carry {
  base: string;
  /** Long where funding is lowest, short where it's highest. */
  longVenue: VenueId;
  shortVenue: VenueId;
  /** Funding earned a year on the pair, per unit of one leg, before fees. */
  apr: number;
  /** Taker fees to open and close both legs, as a fraction. */
  cost: number;
  /** Days of today's funding to pay those fees back. */
  breakEvenDays: number;
  /** Price on the short venue over the long one: gained on entry if it closes. */
  priceGap: number;
  /** The thinner leg's 24h volume. */
  volume: number;
}

/** Below this on either venue a pair can't be put on at size. */
export const CARRY_MIN_VOLUME = 1_000_000;

/** The best long-one-venue, short-another pair on a coin, by funding. */
export function carryOf(row: CoinRow, taker: Record<VenueId, number>): Carry | undefined {
  const legs = (Object.entries(row.venues) as [VenueId, NonNullable<CoinRow["venues"][VenueId]>][])
    .filter(([, q]) => q.funding !== undefined && q.dayVolume >= CARRY_MIN_VOLUME)
    .sort(([, a], [, b]) => (a.funding as number) - (b.funding as number));
  const low = legs[0];
  const high = legs.at(-1);
  if (!low || !high || low[0] === high[0]) return undefined;
  const gap = (high[1].funding as number) - (low[1].funding as number);
  if (!(gap > 0)) return undefined;
  const cost = 2 * (taker[low[0]] + taker[high[0]]);
  return {
    base: row.base,
    longVenue: low[0],
    shortVenue: high[0],
    apr: gap * YEAR_HOURS,
    cost,
    breakEvenDays: cost / (gap * 24),
    priceGap: high[1].price / low[1].price - 1,
    volume: Math.min(low[1].dayVolume, high[1].dayVolume),
  };
}

// --- Pairs ---------------------------------------------------------------

/** Pairs need to move together for a stretch between them to mean anything. */
export const PAIR_MIN_CORRELATION = 0.7;
/** Hourly returns two markets need in common. */
const PAIR_MIN_HOURS = 72;

export interface PairInput<M> {
  market: M;
  candles: readonly Candle[];
}

export interface PairRow<M> {
  a: M;
  b: M;
  /** Where the ratio a / b sits against its own history, in standard deviations. */
  z: number;
  correlation: number;
  /** The ratio's change over 24 hours. */
  change24h: number | undefined;
}

/** Candle closes by open time, for lining two markets up hour by hour. */
function closesByTime(candles: readonly Candle[]) {
  return new Map(candles.map((c) => [c.openTime, num(c.close)]));
}

/** Every pair of `inputs` that moves together, most stretched first. */
export function pairSpreads<M>(inputs: readonly PairInput<M>[]): PairRow<M>[] {
  const closes = inputs.map((i) => closesByTime(i.candles));
  const rows: PairRow<M>[] = [];
  for (let i = 0; i < inputs.length; i++) {
    const first = inputs[i] as PairInput<M>;
    for (let j = i + 1; j < inputs.length; j++) {
      const second = inputs[j] as PairInput<M>;
      const other = closes[j] as Map<number, number>;
      const a: number[] = [];
      const b: number[] = [];
      for (const [time, close] of closes[i] as Map<number, number>) {
        const match = other.get(time);
        if (close > 0 && match !== undefined && match > 0) {
          a.push(close);
          b.push(match);
        }
      }
      if (a.length < PAIR_MIN_HOURS) continue;
      const returns = (list: readonly number[]) =>
        list.slice(1).map((v, k) => Math.log(v / (list[k] as number)));
      const correlation = pearson(returns(a), returns(b));
      if (correlation === undefined || correlation < PAIR_MIN_CORRELATION) continue;
      const ratio = a.map((v, k) => Math.log(v / (b[k] as number)));
      const m = mean(ratio);
      const sd = stdevOf(ratio);
      const latest = ratio.at(-1);
      if (m === undefined || sd === undefined || !(sd > 0) || latest === undefined) continue;
      const dayAgo = ratio[ratio.length - 25];
      rows.push({
        a: first.market,
        b: second.market,
        z: (latest - m) / sd,
        correlation,
        change24h: dayAgo === undefined ? undefined : Math.exp(latest - dayAgo) - 1,
      });
    }
  }
  return rows.sort((x, y) => Math.abs(y.z) - Math.abs(x.z));
}

// --- Lead and lag --------------------------------------------------------

/** Hours either way that are tried. */
export const LAG_REACH = 3;
/** How much better a lag must fit than moving together, to count. */
const LAG_MARGIN = 0.05;

export interface LeadLag {
  /** Hours the market trails the benchmark; negative when it moves first. */
  lag: number;
  /** The fit at that lag, and moving together. */
  correlation: number;
  together: number;
}

/**
 * Whether a market tends to move before or after `benchmark`: its hourly
 * returns against the benchmark's a few hours either side.
 */
export function leadLag(
  candles: readonly Candle[],
  benchmark: readonly Candle[],
): LeadLag | undefined {
  const returnsByHour = (list: readonly Candle[]) => {
    const out = new Map<number, number>();
    for (let i = 1; i < list.length; i++) {
      const was = num(list[i - 1]?.close);
      const now = num((list[i] as Candle).close);
      if (was > 0 && now > 0) out.set((list[i] as Candle).openTime, Math.log(now / was));
    }
    return out;
  };
  const own = returnsByHour(candles);
  const other = returnsByHour(benchmark);
  const fitAt = (lag: number) => {
    const a: number[] = [];
    const b: number[] = [];
    for (const [time, value] of own) {
      const match = other.get(time - lag * HOUR);
      if (match !== undefined) {
        a.push(value);
        b.push(match);
      }
    }
    return a.length < PAIR_MIN_HOURS ? undefined : pearson(a, b);
  };
  const together = fitAt(0);
  if (together === undefined) return undefined;
  let lag = 0;
  let best = together;
  for (let k = -LAG_REACH; k <= LAG_REACH; k++) {
    const value = fitAt(k);
    if (k !== 0 && value !== undefined && value > best + LAG_MARGIN) {
      best = value;
      lag = k;
    }
  }
  return { lag, correlation: best, together };
}

// --- Sector rotation -----------------------------------------------------

export const SECTOR_PERIODS = ["1h", "24h", "7d"] as const;
export type SectorPeriod = (typeof SECTOR_PERIODS)[number];

interface SectorCoin {
  symbol: string;
  marketCap: number;
  change1h?: number | null;
  change24h?: number | null;
  change7d?: number | null;
}

export interface SectorRow<S> {
  sector: S;
  /** Each period's change, weighted by market cap. */
  changes: Record<SectorPeriod, number | undefined>;
  /** Share of the sector's coins up over the period picked. */
  upShare: number;
  best?: { symbol: string; change: number };
  worst?: { symbol: string; change: number };
}

const periodChange = (coin: SectorCoin, period: SectorPeriod) =>
  (period === "1h" ? coin.change1h : period === "24h" ? coin.change24h : coin.change7d) ??
  undefined;

/** Every sector's move, strongest over `period` first. */
export function sectorRows<S>(
  groups: readonly { sector: S; coins: readonly SectorCoin[] }[],
  period: SectorPeriod,
): SectorRow<S>[] {
  const weighted = (coins: readonly SectorCoin[], at: SectorPeriod) => {
    let cap = 0;
    let sum = 0;
    for (const coin of coins) {
      const change = periodChange(coin, at);
      if (change === undefined || !(coin.marketCap > 0)) continue;
      cap += coin.marketCap;
      sum += change * coin.marketCap;
    }
    return cap > 0 ? sum / cap : undefined;
  };
  const rows = groups.map(({ sector, coins }) => {
    const known = coins.flatMap((c) => {
      const change = periodChange(c, period);
      return change === undefined ? [] : [{ symbol: c.symbol, change }];
    });
    const sorted = [...known].sort((a, b) => b.change - a.change);
    return {
      sector,
      changes: {
        "1h": weighted(coins, "1h"),
        "24h": weighted(coins, "24h"),
        "7d": weighted(coins, "7d"),
      },
      upShare: known.length ? known.filter((k) => k.change > 0).length / known.length : 0,
      best: sorted[0],
      worst: sorted.at(-1),
    };
  });
  return rows.sort(
    (a, b) =>
      (b.changes[period] ?? Number.NEGATIVE_INFINITY) -
      (a.changes[period] ?? Number.NEGATIVE_INFINITY),
  );
}

// --- Your trading --------------------------------------------------------

export interface EdgeCell {
  pnl: number;
  trades: number;
}

export interface EdgeMarket extends EdgeCell {
  market: string;
  wins: number;
}

export interface EdgeTrade {
  market: string;
  closedPnl: string | number;
  time: number;
}

/** Monday first, and the hour, on this machine's clock. */
const localSlot = (time: number) => {
  const at = new Date(time);
  return { day: (at.getDay() + 6) % 7, hour: at.getHours() };
};

/** A trader's closed P&L by weekday and hour, and by market, best first. */
export function edgeMap(trades: readonly EdgeTrade[], slot = localSlot) {
  const grid: EdgeCell[][] = Array.from({ length: 7 }, () =>
    Array.from({ length: 24 }, () => ({ pnl: 0, trades: 0 })),
  );
  const byMarket = new Map<string, EdgeMarket>();
  let total = 0;
  for (const trade of trades) {
    const pnl = num(trade.closedPnl);
    if (!Number.isFinite(pnl)) continue;
    total += pnl;
    const { day, hour } = slot(trade.time);
    const cell = grid[day]?.[hour];
    if (cell) {
      cell.pnl += pnl;
      cell.trades += 1;
    }
    const row = byMarket.get(trade.market) ?? { market: trade.market, pnl: 0, trades: 0, wins: 0 };
    row.pnl += pnl;
    row.trades += 1;
    if (pnl > 0) row.wins += 1;
    byMarket.set(trade.market, row);
  }
  return { grid, markets: [...byMarket.values()].sort((a, b) => b.pnl - a.pnl), total };
}

/** Positions this closely tied, once their sides are counted, are one bet. */
export const EXPOSURE_CORRELATION = 0.7;

export interface ExposureInput<M> {
  market: M;
  side: "long" | "short";
  /** What it's worth, in the quote asset. */
  value: number;
  candles?: readonly Candle[];
}

export interface ExposureGroup<M> {
  members: ExposureInput<M>[];
  value: number;
  /** Of everything held. */
  share: number;
  /** The tightest tie that holds the group together. */
  correlation?: number;
}

/**
 * Open positions gathered into the bets they really are: a long and a long
 * that move together are one, as are a long and a short that move opposite.
 * A long and a short that move together offset each other, so stay apart.
 */
export function exposureGroups<M>(positions: readonly ExposureInput<M>[]): ExposureGroup<M>[] {
  const parent = positions.map((_, i) => i);
  const find = (i: number): number => {
    let at = i;
    while (parent[at] !== at) at = parent[at] as number;
    return at;
  };
  const tie = new Map<number, number>();
  const returns = (candles: readonly Candle[] | undefined) =>
    new Map(
      (candles ?? []).slice(1).flatMap((c, i) => {
        const was = num(candles?.[i]?.close);
        return was > 0 ? [[c.openTime, num(c.close) / was - 1] as const] : [];
      }),
    );
  const series = positions.map((p) => returns(p.candles));
  for (let i = 0; i < positions.length; i++) {
    for (let j = i + 1; j < positions.length; j++) {
      const a: number[] = [];
      const b: number[] = [];
      for (const [time, value] of series[i] as Map<number, number>) {
        const match = (series[j] as Map<number, number>).get(time);
        if (match !== undefined) {
          a.push(value);
          b.push(match);
        }
      }
      const raw = a.length >= PAIR_MIN_HOURS ? pearson(a, b) : undefined;
      if (raw === undefined) continue;
      const same = positions[i]?.side === positions[j]?.side;
      const signed = same ? raw : -raw;
      if (signed < EXPOSURE_CORRELATION) continue;
      const root = find(j);
      const into = find(i);
      parent[root] = into;
      tie.set(into, Math.min(tie.get(into) ?? 1, tie.get(root) ?? 1, signed));
    }
  }
  const total = positions.reduce((sum, p) => sum + p.value, 0);
  const groups = new Map<number, ExposureInput<M>[]>();
  positions.forEach((p, i) => {
    const root = find(i);
    groups.set(root, [...(groups.get(root) ?? []), p]);
  });
  return [...groups.entries()]
    .map(([root, members]) => {
      const value = members.reduce((sum, p) => sum + p.value, 0);
      return {
        members: [...members].sort((a, b) => b.value - a.value),
        value,
        share: total > 0 ? value / total : 0,
        correlation: members.length > 1 ? tie.get(root) : undefined,
      };
    })
    .sort((a, b) => b.value - a.value);
}

// --- One market, all at once ---------------------------------------------

export interface MarketReadings {
  regime?: RegimeRead;
  levels?: LevelsRead;
  stretch?: Stretch;
  vol?: VolRank;
  divergence?: Divergence;
  /** Funding, annualised, where the venue gives it. */
  fundingApr?: number;
  crowd?: Crowding;
  change24h?: number;
  /** The busiest price of the candles: their volume profile's point of control. */
  poc?: number;
}

/** Everything the scans read of one market, from its hourly candles and summary. */
export function readingsOf(
  candles: readonly Candle[],
  price: number,
  now: number,
  fundingHour?: number,
  change24h?: number,
  oiChange?: number,
): MarketReadings {
  const profile = candleProfile(candles);
  const top = profile?.rows[profile.poc];
  return {
    regime: regimeRead(candles),
    levels: levelsRead(candles, price, now),
    stretch: stretchRead(candles, price),
    vol: volRank(candles),
    divergence: divergence(candles, 1),
    fundingApr: fundingHour === undefined ? undefined : fundingHour * YEAR_HOURS,
    crowd: fundingHour === undefined ? undefined : crowding(fundingHour, oiChange, change24h),
    change24h,
    poc: top && (top.low + top.high) / 2,
  };
}

export const SCAN_NEAR = ["any", "0.5", "1", "2"] as const;
export const SCAN_STRETCH = ["any", "1.5", "2"] as const;
export const SCAN_VOL = ["any", "quiet", "wild"] as const;
export const SCAN_DIVERGENCE = ["any", "bullish", "bearish"] as const;
export const SCAN_FUNDING = ["any", "calm", "crowded"] as const;

export interface ScanFilters {
  regime: RegimeFilter;
  near: (typeof SCAN_NEAR)[number];
  stretch: (typeof SCAN_STRETCH)[number];
  vol: (typeof SCAN_VOL)[number];
  divergence: (typeof SCAN_DIVERGENCE)[number];
  funding: (typeof SCAN_FUNDING)[number];
}

/** Quietest and wildest quarters of a market's own history. */
const VOL_QUARTER = 0.25;
/** Funding a year, either way: under this is calm, over that crowded. */
const FUNDING_CALM = 0.2;
const FUNDING_CROWDED = 0.5;

/** Whether a market's readings pass every filter; one unknown to a filter fails it. */
export function passesScan(r: MarketReadings, f: ScanFilters): boolean {
  if (f.regime !== "all" && !(r.regime && inRegimeFilter(r.regime.kind, f.regime))) return false;
  if (f.near !== "any") {
    const away = r.levels && Math.abs(r.levels.nearest.distance);
    if (away === undefined || away * 100 > Number(f.near)) return false;
  }
  if (f.stretch !== "any" && !(r.stretch && Math.abs(r.stretch.z) >= Number(f.stretch))) {
    return false;
  }
  if (f.vol !== "any") {
    if (!r.vol) return false;
    if (f.vol === "quiet" ? r.vol.rank > VOL_QUARTER : r.vol.rank < 1 - VOL_QUARTER) return false;
  }
  if (f.divergence !== "any" && r.divergence?.kind !== f.divergence) return false;
  if (f.funding !== "any") {
    if (r.fundingApr === undefined) return false;
    const apr = Math.abs(r.fundingApr);
    if (f.funding === "calm" ? apr >= FUNDING_CALM : apr < FUNDING_CROWDED) return false;
  }
  return true;
}

// --- Scan alerts ---------------------------------------------------------

export const SCAN_RULES = ["divergence", "squeeze", "level", "trend"] as const;
export type ScanRule = (typeof SCAN_RULES)[number];

/** A squeeze risk this high, and a level this close, set off their alerts. */
export const ALERT_SQUEEZE_SCORE = 80;
export const ALERT_LEVEL_NEAR = 0.005;

/** Whether a market is in the state a rule watches for. */
export function inRuleState(rule: ScanRule, r: MarketReadings): boolean {
  switch (rule) {
    case "divergence":
      return r.divergence !== undefined;
    case "squeeze":
      return (r.crowd?.score ?? 0) >= ALERT_SQUEEZE_SCORE;
    case "level":
      return r.levels !== undefined && Math.abs(r.levels.nearest.distance) <= ALERT_LEVEL_NEAR;
    case "trend":
      return r.regime?.kind === "trendUp" || r.regime?.kind === "trendDown";
  }
}

/** An alert fires on the way in, not while a market stays there, nor on first sight. */
export const enteredState = (was: boolean | undefined, now: boolean) => was === false && now;
