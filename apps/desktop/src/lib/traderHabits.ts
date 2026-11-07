import type { TraderClosedTrade, TraderDetail, TraderRow } from "../api/venueClient";

// How a trader trades, from their closed trades (the last 100 the source
// gives): which side, how long they hold, when in the day they're active,
// how often. Arithmetic only; the trader's page draws it.

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

/** Long and short, as shares of their closed trades (0 to 1). */
export function longShort(closed: readonly TraderClosedTrade[]) {
  const long = closed.filter((t) => t.side === "long").length;
  return closed.length
    ? { long: long / closed.length, short: 1 - long / closed.length }
    : undefined;
}

/** Hold time buckets, upper bounds in ms: under 1h, 4h, 12h, 1d, 3d, 1w, and longer. */
export const HOLD_BUCKETS = [HOUR, 4 * HOUR, 12 * HOUR, DAY, 3 * DAY, 7 * DAY, Infinity] as const;

/** How many closed trades fall in each hold time bucket; only trades whose opening is known. */
export function holdTimes(closed: readonly TraderClosedTrade[]): {
  counts: number[];
  known: number;
} {
  const counts = HOLD_BUCKETS.map(() => 0);
  let known = 0;
  for (const t of closed) {
    if (!t.openedAt || t.openedAt > t.time) continue;
    const held = t.time - t.openedAt;
    const i = HOLD_BUCKETS.findIndex((b) => held < b);
    counts[i] = (counts[i] ?? 0) + 1;
    known += 1;
  }
  return { counts, known };
}

/** The hold time most of their trades fall in: its bucket's index. */
export const usualHold = (counts: readonly number[]) =>
  counts.reduce((best, c, i) => (c > (counts[best] ?? 0) ? i : best), 0);

/** The `span` hours (UTC) of the day in which most of their trades closed: [from, to). */
export function activeHours(closed: readonly TraderClosedTrade[], span = 6) {
  if (closed.length < 5) return undefined;
  const byHour = Array.from({ length: 24 }, () => 0);
  for (const t of closed) {
    const h = new Date(t.time).getUTCHours();
    byHour[h] = (byHour[h] ?? 0) + 1;
  }
  let best = 0;
  let bestCount = -1;
  for (let from = 0; from < 24; from++) {
    let count = 0;
    for (let k = 0; k < span; k++) count += byHour[(from + k) % 24] ?? 0;
    if (count > bestCount) {
      best = from;
      bestCount = count;
    }
  }
  return { from: best, to: (best + span) % 24, share: bestCount / closed.length };
}

/**
 * Their closed trades in the last 30 days, and whether there may be more:
 * the source gives the last 100, so 100 all inside the window means "100+".
 */
export function trades30d(closed: readonly TraderClosedTrade[], limit: number, now = Date.now()) {
  const recent = closed.filter((t) => now - t.time <= 30 * DAY).length;
  return { count: recent, more: closed.length >= limit && recent === closed.length };
}

/** Round trips below which a win rate says more about luck than about them. */
export const MIN_TRADES = 10;

/**
 * A trader's win rate: OKX's own, by trade; on Hyperliquid, the share of
 * their recent round trips (open to flat) that made money, once there are
 * enough of them - null when there aren't.
 */
export function winRateOf(
  okx: boolean,
  row: Pick<TraderRow, "winRate"> | undefined,
  detail: Pick<TraderDetail, "winRate" | "closed"> | undefined,
): number | null {
  if (okx) return row?.winRate ?? detail?.winRate ?? null;
  return detail && detail.closed.length >= MIN_TRADES ? detail.winRate : null;
}
