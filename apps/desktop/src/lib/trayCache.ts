import type { Market, MarketSummary } from "@pewterdesk/core";

// What the tray panel last saw, kept on this machine so it opens instantly
// (even right after launch) and refreshes behind it. All of it is public
// market data; a lost or stale cache costs nothing but that moment.

const MARKETS_KEY = "pd.cache.markets";
const SUMMARIES_KEY = "pd.cache.summaries";
const SPARKS_KEY = "pd.cache.sparks";
/** A sparkline this old is fetched again. */
export const SPARK_MAX_AGE_MS = 5 * 60_000;
/** Sparklines kept, most recent first. */
export const SPARKS_KEPT = 24;

type Store = Pick<Storage, "getItem" | "setItem">;

function read<T>(store: Store, key: string, valid: (v: unknown) => v is T): T | undefined {
  try {
    const parsed: unknown = JSON.parse(store.getItem(key) ?? "null");
    return valid(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function write(store: Store, key: string, value: unknown) {
  try {
    store.setItem(key, JSON.stringify(value));
  } catch {
    // Storage full or unavailable: the panel just fetches next time.
  }
}

const isArrayOf =
  <T>(field: keyof T & string) =>
  (v: unknown): v is T[] =>
    Array.isArray(v) && v.every((x) => typeof x === "object" && x !== null && field in x);

export const loadMarkets = (store: Store = localStorage) =>
  read(store, MARKETS_KEY, isArrayOf<Market>("id")) ?? [];
export const saveMarkets = (markets: readonly Market[], store: Store = localStorage) =>
  write(store, MARKETS_KEY, markets);

export const loadSummaries = (store: Store = localStorage) =>
  read(store, SUMMARIES_KEY, isArrayOf<MarketSummary>("market")) ?? [];
export const saveSummaries = (summaries: readonly MarketSummary[], store: Store = localStorage) =>
  write(store, SUMMARIES_KEY, summaries);

interface Spark {
  market: string;
  time: number;
  closes: number[];
}

const isSparks = (v: unknown): v is Spark[] =>
  Array.isArray(v) &&
  v.every(
    (s) =>
      typeof s === "object" &&
      s !== null &&
      typeof (s as Spark).market === "string" &&
      typeof (s as Spark).time === "number" &&
      Array.isArray((s as Spark).closes),
  );

/** `market`'s cached closes and whether they're fresh enough to skip a fetch. */
export function loadSpark(
  market: string,
  now = Date.now(),
  store: Store = localStorage,
): { closes: number[]; fresh: boolean } | undefined {
  const hit = (read(store, SPARKS_KEY, isSparks) ?? []).find((s) => s.market === market);
  return hit && { closes: hit.closes, fresh: now - hit.time < SPARK_MAX_AGE_MS };
}

/** Saves `market`'s closes as the newest, keeping the most recent SPARKS_KEPT. */
export function saveSpark(
  market: string,
  closes: readonly number[],
  now = Date.now(),
  store: Store = localStorage,
) {
  const rest = (read(store, SPARKS_KEY, isSparks) ?? []).filter((s) => s.market !== market);
  write(
    store,
    SPARKS_KEY,
    [{ market, time: now, closes: [...closes] }, ...rest].slice(0, SPARKS_KEPT),
  );
}
