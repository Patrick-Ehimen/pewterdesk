import type { Candle, CandleInterval, Market } from "@pewterdesk/core";

// What the Screener's token details read, after Bybit's coin pages: a price
// chart over a range, the change over the days before, and the headlines
// that name the token. Plain arithmetic over candles the venue serves.

export type ChartRange = "24h" | "7d" | "30d" | "90d" | "1y";

export const CHART_RANGES: readonly ChartRange[] = ["24h", "7d", "30d", "90d", "1y"];

/** Each range's candles: about a hundred to a few hundred points. */
export const RANGE_CANDLES: Record<ChartRange, { interval: CandleInterval; count: number }> = {
  "24h": { interval: "15m", count: 96 },
  "7d": { interval: "1h", count: 168 },
  "30d": { interval: "4h", count: 180 },
  "90d": { interval: "1d", count: 90 },
  "1y": { interval: "1d", count: 365 },
};

/** The days the price history compares today with. */
export const HISTORY_DAYS = [7, 14, 30] as const;

/** Daily candles the price history needs: the longest comparison, and today. */
export const HISTORY_CANDLES = 31;

/** The lowest low and highest high, with when each came. */
export function lowHigh(candles: readonly Candle[]) {
  let low: { price: number; time: number } | undefined;
  let high: { price: number; time: number } | undefined;
  for (const c of candles) {
    const l = Number(c.low);
    const h = Number(c.high);
    if (Number.isFinite(l) && (!low || l < low.price)) low = { price: l, time: c.openTime };
    if (Number.isFinite(h) && (!high || h > high.price)) high = { price: h, time: c.openTime };
  }
  return low && high ? { low, high } : undefined;
}

/**
 * The change from the close `days` daily candles back to `price`, as a
 * fraction, or none if the venue's history doesn't go that far.
 */
export function changeOver(daily: readonly Candle[], days: number, price: number) {
  const then = Number(daily[daily.length - 1 - days]?.close);
  return Number.isFinite(then) && then > 0 && Number.isFinite(price) ? price / then - 1 : undefined;
}

const literal = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Whether a headline names the token: its ticker as a word in capitals (a
 * ticker of fewer than three letters is too common a word to go by), or its
 * name as a word in any case.
 */
export function namesToken(text: string, base: string, name?: string) {
  const ticker = base.toUpperCase();
  if (
    ticker.length >= 3 &&
    new RegExp(`(^|[^A-Za-z0-9])\\$?${literal(ticker)}([^A-Za-z0-9]|$)`).test(text)
  ) {
    return true;
  }
  return (
    name !== undefined &&
    name.length >= 3 &&
    new RegExp(`(^|[^A-Za-z0-9])${literal(name)}([^A-Za-z0-9]|$)`, "i").test(text)
  );
}

/** Whether a market is what's typed in the Screener's search: its symbol or base, any case. */
export function matchesSearch(market: Market, query: string) {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return [market.symbol, market.base, market.id].some((s) => s.toLowerCase().includes(q));
}
