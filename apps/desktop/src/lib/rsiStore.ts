// Every market's RSI for the Maps page's heatmap, read once and kept: in
// memory for the session and in browser storage across reloads, per venue
// and timeframe. A pass (one candle request per market, a few at a time)
// carries on in the background if the page is left, so coming back shows
// what's there instead of starting over.

import type { CandleInterval, VenueId } from "@pewterdesk/core";
import { RSI_CANDLES, type RsiFrame, rsiNowAndBefore } from "@pewterdesk/ui";
import { venueClient } from "../api/venueClient";

/** RSI(14) for one market: now, and one candle earlier. */
export interface RsiValue {
  value: number;
  previous?: number;
}

export interface RsiState {
  values: ReadonlyMap<string, RsiValue>;
  /** A pass is running; `done` of `total` markets read so far. */
  loading: boolean;
  done: number;
  total: number;
}

/** Candle requests in flight at once: inside the venue's public rate limits. */
const CONCURRENCY = 6;
/** How often listeners hear about values streaming in. */
const NOTIFY_MS = 400;
/** How long a finished pass stays fresh, per timeframe, before the next one. */
const FRESH_MS: Record<RsiFrame, number> = {
  "5m": 60_000,
  "15m": 3 * 60_000,
  "1h": 5 * 60_000,
  "4h": 10 * 60_000,
  "12h": 15 * 60_000,
  "1d": 30 * 60_000,
  "1w": 60 * 60_000,
};
const STORAGE_PREFIX = "pd.rsi.";

interface Entry {
  values: Map<string, RsiValue>;
  /** When the last full pass finished; unset until one has. */
  fetchedAt?: number;
  /** Markets that gave no reading since then (too new, or the request failed): not retried until the next full pass. */
  empty: Set<string>;
  running: boolean;
  done: number;
  total: number;
  listeners: Set<() => void>;
  snapshot: RsiState;
}

const entries = new Map<string, Entry>();
const keyOf = (venue: VenueId, frame: RsiFrame) => `${venue}:${frame}`;

function stored(key: string): Pick<Entry, "values" | "fetchedAt"> {
  try {
    const saved: unknown = JSON.parse(localStorage.getItem(STORAGE_PREFIX + key) ?? "null");
    if (typeof saved !== "object" || saved === null) return { values: new Map() };
    const { fetchedAt, values } = saved as { fetchedAt?: unknown; values?: unknown };
    const out = new Map<string, RsiValue>();
    if (Array.isArray(values)) {
      for (const row of values) {
        if (!Array.isArray(row)) continue;
        const [id, value, previous] = row as unknown[];
        if (typeof id !== "string" || typeof value !== "number" || !Number.isFinite(value))
          continue;
        out.set(id, { value, previous: typeof previous === "number" ? previous : undefined });
      }
    }
    return { values: out, fetchedAt: typeof fetchedAt === "number" ? fetchedAt : undefined };
  } catch {
    return { values: new Map() };
  }
}

function persist(key: string, entry: Entry) {
  try {
    const values = [...entry.values].map(([id, v]) => [
      id,
      Math.round(v.value * 100) / 100,
      v.previous === undefined ? null : Math.round(v.previous * 100) / 100,
    ]);
    localStorage.setItem(
      STORAGE_PREFIX + key,
      JSON.stringify({ fetchedAt: entry.fetchedAt, values }),
    );
  } catch {
    // Storage full or unavailable; the values just reload next time.
  }
}

function entryFor(key: string): Entry {
  let entry = entries.get(key);
  if (!entry) {
    const saved = stored(key);
    entry = {
      ...saved,
      empty: new Set(),
      running: false,
      done: 0,
      total: 0,
      listeners: new Set(),
      snapshot: { values: saved.values, loading: false, done: 0, total: 0 },
    };
    entries.set(key, entry);
  }
  return entry;
}

function publish(entry: Entry) {
  entry.snapshot = {
    values: new Map(entry.values),
    loading: entry.running,
    done: entry.done,
    total: entry.total,
  };
  for (const listener of entry.listeners) listener();
}

/** The current values and progress for a venue and timeframe. */
export function rsiState(venue: VenueId, frame: RsiFrame): RsiState {
  return entryFor(keyOf(venue, frame)).snapshot;
}

/** Calls `listener` whenever the values or progress change; returns the unsubscribe. */
export function subscribeRsi(venue: VenueId, frame: RsiFrame, listener: () => void): () => void {
  const entry = entryFor(keyOf(venue, frame));
  entry.listeners.add(listener);
  return () => entry.listeners.delete(listener);
}

/**
 * Reads every market's RSI unless a fresh pass is already kept (or `force`).
 * Markets with no value yet go first, then `markets` in the order given. One
 * pass at a time per venue and timeframe; it runs to the end even if nobody
 * is listening.
 */
export function loadRsi(
  venue: VenueId,
  frame: RsiFrame,
  markets: readonly string[],
  force = false,
): void {
  const key = keyOf(venue, frame);
  const entry = entryFor(key);
  if (entry.running || markets.length === 0) return;
  const missing = markets.filter((m) => !entry.values.has(m) && !entry.empty.has(m));
  const fresh = entry.fetchedAt !== undefined && Date.now() - entry.fetchedAt < FRESH_MS[frame];
  if (!force && fresh && missing.length === 0) return;
  // Still fresh but with gaps (new listings, or a pass cut short by a
  // reload): only the gaps. Otherwise everything, the gaps first.
  const gapsOnly = !force && fresh;
  if (!gapsOnly) entry.empty.clear();
  const unread = markets.filter((m) => !entry.values.has(m));
  const queue = gapsOnly ? missing : [...unread, ...markets.filter((m) => entry.values.has(m))];
  entry.running = true;
  entry.done = 0;
  entry.total = queue.length;
  publish(entry);
  const notify = setInterval(() => publish(entry), NOTIFY_MS);
  const save = setInterval(() => persist(key, entry), 5000);
  const worker = async () => {
    for (;;) {
      const market = queue.shift();
      if (!market) return;
      try {
        const candles = await venueClient.candles(
          venue,
          market,
          frame as CandleInterval,
          Date.now() + 1,
          RSI_CANDLES,
        );
        const reading = rsiNowAndBefore(candles.map((c) => Number(c.close)));
        if (reading) entry.values.set(market, reading);
        else entry.empty.add(market);
      } catch {
        // One market failing (delisted, rate-limited) keeps its old value.
        entry.empty.add(market);
      }
      entry.done += 1;
    }
  };
  void Promise.all(Array.from({ length: CONCURRENCY }, worker)).then(() => {
    clearInterval(notify);
    clearInterval(save);
    entry.running = false;
    entry.fetchedAt = Date.now();
    persist(key, entry);
    publish(entry);
  });
}

const ORDER_PREFIX = "pd.rsi.order.";

/** The markets' columns on the heatmap (ids, left to right), as last saved for `venue`. */
export function loadRsiOrder(venue: VenueId): string[] | undefined {
  try {
    const saved: unknown = JSON.parse(localStorage.getItem(ORDER_PREFIX + venue) ?? "null");
    return Array.isArray(saved) && saved.every((id) => typeof id === "string") ? saved : undefined;
  } catch {
    return undefined;
  }
}

export function saveRsiOrder(venue: VenueId, order: readonly string[]) {
  try {
    localStorage.setItem(ORDER_PREFIX + venue, JSON.stringify(order));
  } catch {
    // Storage unavailable; the columns are just ranked again next time.
  }
}
