import type { Candle, CandleInterval, VenueId } from "@pewterdesk/core";

// Candles are public market data, so browser storage is fine. The cache only
// lets the chart draw at once on launch; the venue's history replaces it a
// moment later, so a lost or stale cache costs nothing but that moment.

/** Candles kept per series: the venue sends this many as history anyway. */
export const CACHED_CANDLES = 500;
/** Series kept, most recently viewed first; about 60 KB each. */
export const CACHED_SERIES = 16;

const PREFIX = "pd.candles.";
const INDEX_KEY = `${PREFIX}index`;

type Store = Pick<Storage, "getItem" | "setItem" | "removeItem">;

const seriesKey = (venue: VenueId, market: string, interval: CandleInterval) =>
  `${PREFIX}${venue}:${interval}:${market}`;

const isCandle = (c: unknown): c is Candle =>
  typeof c === "object" &&
  c !== null &&
  typeof (c as Candle).openTime === "number" &&
  ["open", "high", "low", "close", "volume"].every(
    (k) => typeof (c as Record<string, unknown>)[k] === "string",
  );

function readIndex(store: Store): string[] {
  try {
    const parsed: unknown = JSON.parse(store.getItem(INDEX_KEY) ?? "[]");
    return Array.isArray(parsed) ? parsed.filter((k): k is string => typeof k === "string") : [];
  } catch {
    return [];
  }
}

/** The cached series, oldest first, or undefined when there's none (or it's unreadable). */
export function loadCandles(
  venue: VenueId,
  market: string,
  interval: CandleInterval,
  store: Store = localStorage,
): Candle[] | undefined {
  try {
    const parsed: unknown = JSON.parse(store.getItem(seriesKey(venue, market, interval)) ?? "null");
    if (!Array.isArray(parsed) || parsed.length === 0 || !parsed.every(isCandle)) return undefined;
    return parsed;
  } catch {
    return undefined;
  }
}

/**
 * Keeps the newest `CACHED_CANDLES` of `candles`, and drops the least
 * recently saved series beyond `CACHED_SERIES`. If storage is full, older
 * series make room; if it's unavailable, nothing is saved.
 */
export function saveCandles(
  venue: VenueId,
  market: string,
  interval: CandleInterval,
  candles: readonly Candle[],
  store: Store = localStorage,
): void {
  if (candles.length === 0) return;
  const key = seriesKey(venue, market, interval);
  const value = JSON.stringify(candles.slice(-CACHED_CANDLES));
  const index = [key, ...readIndex(store).filter((k) => k !== key)];
  try {
    for (const old of index.splice(CACHED_SERIES)) store.removeItem(old);
    // Full: evict the oldest series until it fits, or give up.
    for (;;) {
      try {
        store.setItem(key, value);
        break;
      } catch {
        const oldest = index.length > 1 ? index.pop() : undefined;
        if (oldest === undefined) return;
        store.removeItem(oldest);
      }
    }
    store.setItem(INDEX_KEY, JSON.stringify(index));
  } catch {
    // Storage unavailable; the chart just loads from the venue next time.
  }
}
