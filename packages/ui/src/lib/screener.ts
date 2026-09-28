import type { Market, MarketHistory, MarketSummary } from "@pewterdesk/core";

// Display-only arithmetic for the screener. Changes are fractions (0.0185 is
// +1.85%); amounts are in the quote asset.

/** Wilder's RSI over `period` changes; undefined without enough closes. */
export function rsi(closes: readonly number[], period = 14): number | undefined {
  if (closes.length < period + 1) return undefined;
  let gain = 0;
  let loss = 0;
  for (let i = 1; i <= period; i++) {
    const d = (closes[i] ?? 0) - (closes[i - 1] ?? 0);
    if (d > 0) gain += d;
    else loss -= d;
  }
  gain /= period;
  loss /= period;
  for (let i = period + 1; i < closes.length; i++) {
    const d = (closes[i] ?? 0) - (closes[i - 1] ?? 0);
    gain = (gain * (period - 1) + Math.max(d, 0)) / period;
    loss = (loss * (period - 1) + Math.max(-d, 0)) / period;
  }
  if (loss === 0) return gain === 0 ? 50 : 100;
  return 100 - 100 / (1 + gain / loss);
}

/** Change from `steps` closes back to the last close; undefined without enough history. */
export function changeOver(closes: readonly number[], steps: number): number | undefined {
  const last = closes.at(-1);
  const then = closes.at(-1 - steps);
  return last !== undefined && then !== undefined && then > 0 ? last / then - 1 : undefined;
}

/** A funding rate per interval, annualised. */
export function fundingApr(rate: number, intervalSecs: number): number {
  return intervalSecs > 0 ? rate * ((365 * 24 * 3600) / intervalSecs) : 0;
}

export type Signal =
  | "overbought"
  | "oversold"
  | "oiSpike"
  | "crowdedLong"
  | "negativeFunding"
  | "momentum";

/** The thresholds the signals use; shown in their tooltips. */
export const SIGNAL_RULES = {
  overbought: 70,
  oversold: 30,
  /** Open interest up this much within OI_WINDOW_MS. */
  oiSpike: 0.03,
  crowdedLongApr: 0.5,
  negativeFundingApr: -0.1,
  momentum24h: 0.03,
  topMover24h: 0.03,
  fundingExtremeApr: 0.5,
  volumeSurge: 2,
} as const;

/** How far back an OI spike is measured. */
export const OI_WINDOW_MS = 15 * 60_000;

/** Markets native to Hyperliquid, for the "HL ecosystem" chip. */
export const HL_ECOSYSTEM = new Set(["HYPE", "PURR"]);

export interface ScreenerRow {
  market: Market;
  price: number;
  /** The price as the venue sent it, for its decimals. */
  rawPrice: string;
  change1h?: number;
  change24h: number;
  change7d?: number;
  /** Hourly closes over the last 7 days, oldest first. */
  spark?: number[];
  volume: number;
  /** Open interest valued at the mark. */
  openInterest: number;
  /** Per funding interval. */
  funding: number;
  fundingApr: number;
  rsi1h?: number;
  /** OI change over the last OI_WINDOW_MS, measured while the app is open. */
  oiChange?: number;
  signal?: Signal;
}

/** The single most notable signal for a row, or none. Checked in this order. */
export function signalFor(row: Omit<ScreenerRow, "signal">): Signal | undefined {
  const r = SIGNAL_RULES;
  if (row.rsi1h !== undefined && row.rsi1h >= r.overbought) return "overbought";
  if (row.rsi1h !== undefined && row.rsi1h <= r.oversold) return "oversold";
  if (row.oiChange !== undefined && row.oiChange >= r.oiSpike) return "oiSpike";
  if (row.fundingApr >= r.crowdedLongApr) return "crowdedLong";
  if (row.fundingApr <= r.negativeFundingApr) return "negativeFunding";
  if (row.change24h >= r.momentum24h) return "momentum";
  return undefined;
}

/** Joins summaries, candle history and session OI changes onto listed markets. */
export function screenerRows(
  markets: readonly Market[],
  summaries: readonly MarketSummary[],
  histories: ReadonlyMap<string, MarketHistory> = new Map(),
  oiChanges: ReadonlyMap<string, number> = new Map(),
): ScreenerRow[] {
  const byId = new Map(summaries.map((s) => [s.market, s]));
  return markets.flatMap((market) => {
    const s = byId.get(market.id);
    if (!s) return [];
    const price = Number(s.markPrice);
    const prev = Number(s.prevDayPrice);
    const closes = histories.get(market.id)?.candles.map((c) => Number(c.close));
    const funding = Number(s.fundingRate);
    const row: Omit<ScreenerRow, "signal"> = {
      market,
      price,
      rawPrice: s.markPrice,
      change1h: closes ? changeOver(closes, 1) : undefined,
      change24h: prev > 0 ? (price - prev) / prev : 0,
      change7d: closes?.[0] ? (closes.at(-1) ?? 0) / closes[0] - 1 : undefined,
      spark: closes,
      volume: Number(s.dayVolume),
      openInterest: Number(s.openInterest) * price,
      funding,
      fundingApr: fundingApr(funding, s.fundingIntervalSecs),
      rsi1h: closes ? rsi(closes) : undefined,
      oiChange: oiChanges.get(market.id),
    };
    return [{ ...row, signal: signalFor(row) }];
  });
}

export type ScreenerFilter = "all" | "movers" | "funding" | "oi" | "hl" | "builder" | "starred";

export const FILTERS: readonly ScreenerFilter[] = [
  "all",
  "movers",
  "funding",
  "oi",
  "hl",
  "builder",
  "starred",
];

/** Whether `market` matches a search: its symbol, or the exchange that listed it. */
export function matchesSearch(market: Market, needle: string): boolean {
  if (!needle) return true;
  const upper = needle.toUpperCase();
  return (
    market.symbol.toUpperCase().includes(upper) ||
    (market.listedBy?.toUpperCase().includes(upper) ?? false)
  );
}

export function matchesFilter(
  row: ScreenerRow,
  filter: ScreenerFilter,
  starred: ReadonlySet<string>,
): boolean {
  const r = SIGNAL_RULES;
  switch (filter) {
    case "all":
      return true;
    case "movers":
      return Math.abs(row.change24h) >= r.topMover24h;
    case "funding":
      return Math.abs(row.fundingApr) >= r.fundingExtremeApr;
    case "oi":
      return row.oiChange !== undefined && row.oiChange >= r.oiSpike;
    case "hl":
      return !row.market.listedBy && HL_ECOSYSTEM.has(row.market.base);
    case "builder":
      return Boolean(row.market.listedBy);
    case "starred":
      return starred.has(row.market.id);
  }
}

export type ScreenerSort =
  | "market"
  | "price"
  | "change1h"
  | "change24h"
  | "change7d"
  | "volume"
  | "openInterest"
  | "funding"
  | "rsi1h";

/** Sorts by a column; rows missing that value go last either way. */
export function sortRows(
  rows: readonly ScreenerRow[],
  by: ScreenerSort,
  descending: boolean,
): ScreenerRow[] {
  const value = (r: ScreenerRow) => (by === "market" ? r.market.symbol : r[by]);
  return [...rows].sort((a, b) => {
    const va = value(a);
    const vb = value(b);
    if (va === undefined || vb === undefined)
      return va === undefined ? (vb === undefined ? 0 : 1) : -1;
    const order =
      typeof va === "string" && typeof vb === "string"
        ? va.localeCompare(vb)
        : (va as number) - (vb as number);
    return descending ? -order : order;
  });
}

// --- Live signals: what changed between one look at the market and the next.

export type SignalEventKind =
  | "overbought"
  | "oversold"
  | "fundingNegative"
  | "fundingPositive"
  | "oiSpike"
  | "breakout"
  | "volume";

export interface SignalEvent {
  id: string;
  time: number;
  market: string;
  kind: SignalEventKind;
  /** The figure the message quotes: an RSI, an OI change, a price, a volume multiple. */
  value?: number;
}

/** What a market looks like at one moment, for spotting transitions. */
export interface MarketState {
  rsi1h?: number;
  fundingSign: -1 | 0 | 1;
  oiSpike: boolean;
  /** Mark above the highest high of the previous 24 closed hours. */
  aboveHigh: boolean;
  /** 24h high being tested, for the message. */
  high24h?: number;
  /** Last closed hour's volume over the 7-day hourly average, when ≥ the surge multiple. */
  volumeSurge?: number;
}

export function marketState(row: ScreenerRow, history?: MarketHistory): MarketState {
  const candles = history?.candles ?? [];
  // The last candle is the forming hour; compare against the 24 closed before it.
  const closed = candles.slice(0, -1);
  const day = closed.slice(-24);
  const high24h = day.length ? Math.max(...day.map((c) => Number(c.high))) : undefined;
  const volumes = closed.map((c) => Number(c.volume));
  const lastVolume = volumes.at(-1);
  const average =
    volumes.length > 1 ? volumes.slice(0, -1).reduce((a, b) => a + b, 0) / (volumes.length - 1) : 0;
  const multiple = lastVolume !== undefined && average > 0 ? lastVolume / average : 0;
  return {
    rsi1h: row.rsi1h,
    fundingSign: row.funding > 0 ? 1 : row.funding < 0 ? -1 : 0,
    oiSpike: row.oiChange !== undefined && row.oiChange >= SIGNAL_RULES.oiSpike,
    aboveHigh: high24h !== undefined && row.price > high24h,
    high24h,
    volumeSurge: multiple >= SIGNAL_RULES.volumeSurge ? multiple : undefined,
  };
}

/**
 * Events for markets whose state crossed a threshold since `before`. A
 * market seen for the first time produces none, so opening the app doesn't
 * flood the feed with everything that's already true.
 */
export function signalEvents(
  before: ReadonlyMap<string, MarketState>,
  after: ReadonlyMap<string, MarketState>,
  rows: ReadonlyMap<string, ScreenerRow>,
  now: number,
): SignalEvent[] {
  const events: SignalEvent[] = [];
  const add = (market: string, kind: SignalEventKind, value?: number) =>
    events.push({ id: `${now}:${market}:${kind}`, time: now, market, kind, value });
  for (const [market, next] of after) {
    const prev = before.get(market);
    if (!prev) continue;
    const r = SIGNAL_RULES;
    if (next.rsi1h !== undefined && prev.rsi1h !== undefined) {
      if (prev.rsi1h < r.overbought && next.rsi1h >= r.overbought)
        add(market, "overbought", next.rsi1h);
      if (prev.rsi1h > r.oversold && next.rsi1h <= r.oversold) add(market, "oversold", next.rsi1h);
    }
    if (prev.fundingSign >= 0 && next.fundingSign < 0) add(market, "fundingNegative");
    if (prev.fundingSign < 0 && next.fundingSign > 0) add(market, "fundingPositive");
    if (!prev.oiSpike && next.oiSpike) add(market, "oiSpike", rows.get(market)?.oiChange);
    if (!prev.aboveHigh && next.aboveHigh) add(market, "breakout", next.high24h);
    if (prev.volumeSurge === undefined && next.volumeSurge !== undefined)
      add(market, "volume", next.volumeSurge);
  }
  return events;
}

/** Open-interest samples per market, for the change over OI_WINDOW_MS. */
export type OiSamples = Map<string, { time: number; oi: number }[]>;

/** Records the latest OI and returns each market's change across the window, once it spans it. */
export function trackOpenInterest(
  samples: OiSamples,
  summaries: readonly MarketSummary[],
  now: number,
): Map<string, number> {
  const changes = new Map<string, number>();
  for (const s of summaries) {
    const oi = Number(s.openInterest);
    const list = samples.get(s.market) ?? [];
    list.push({ time: now, oi });
    while (list.length > 1 && (list[1]?.time ?? now) <= now - OI_WINDOW_MS) list.shift();
    samples.set(s.market, list);
    const first = list[0];
    if (first && now - first.time >= OI_WINDOW_MS * 0.9 && first.oi > 0) {
      changes.set(s.market, oi / first.oi - 1);
    }
  }
  return changes;
}
