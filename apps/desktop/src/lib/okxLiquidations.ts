// The past day of liquidations for the Maps page, from OKX's public history:
// read per market (busiest first) each time the view is opened, picking up
// from what was read before. What happens after that comes from Bybit's
// live feed. Kept in memory for the session, not in browser storage: it
// can always be read again.

import type { LiqEvent } from "@pewterdesk/ui";
import { okxClient } from "../api/venueClient";

const DAY_MS = 24 * 3_600_000;
/** Markets read at once; Rust spaces the requests out as well. */
const CONCURRENCY = 4;
/** How often listeners hear about events streaming in. */
const NOTIFY_MS = 500;

export interface OkxLiqState {
  /** Newest first. */
  events: readonly LiqEvent[];
  /** The first read of the last day is still running: `done` of `total` markets. */
  loading: boolean;
  done: number;
  total: number;
  error?: string;
}

const byKey = new Map<string, LiqEvent>();
/** The newest liquidation seen per OKX market, so a top-up asks only for later ones. */
const lastSeen = new Map<string, number>();
const listeners = new Set<() => void>();
let snapshot: OkxLiqState = { events: [], loading: false, done: 0, total: 0 };
let running = false;
let filled = false;

function publish(patch: Partial<OkxLiqState> = {}) {
  const cutoff = Date.now() - DAY_MS;
  for (const [key, e] of byKey) if (e.time < cutoff) byKey.delete(key);
  snapshot = {
    ...snapshot,
    ...patch,
    events: [...byKey.values()].sort((a, b) => b.time - a.time),
  };
  for (const listener of listeners) listener();
}

/**
 * One pass over every OKX market. `marketFor` turns a base coin into the
 * id the view groups by (the venue's own market for it, if it lists one);
 * `rank` orders the markets, lowest first.
 */
async function pass(marketFor: (base: string) => string, rank: (base: string) => number) {
  if (running) return;
  running = true;
  try {
    const markets = await okxClient.markets();
    const base = (m: string) => m.split("-")[0] ?? m;
    const queue = [...markets].sort((a, b) => rank(base(a)) - rank(base(b)));
    let done = 0;
    if (!filled) publish({ loading: true, done: 0, total: queue.length, error: undefined });
    const notify = setInterval(() => publish(filled ? {} : { done }), NOTIFY_MS);
    let failed: string | undefined;
    const worker = async () => {
      for (;;) {
        const market = queue.shift();
        if (!market) return;
        try {
          const since = (lastSeen.get(market) ?? Date.now() - DAY_MS) + 1;
          const rows = await okxClient.liquidations(market, since);
          for (const r of rows) {
            const id = marketFor(r.base);
            byKey.set(`${market}|${r.time}|${r.price}|${r.size}|${r.side}`, {
              market: id,
              side: r.side,
              price: String(r.price),
              size: String(r.size),
              time: r.time,
              value: r.price * r.size,
              source: "okx",
            });
          }
          const newest = rows[0]?.time;
          if (newest !== undefined) lastSeen.set(market, newest);
        } catch (err) {
          failed = err instanceof Error ? err.message : String(err);
        }
        done += 1;
      }
    };
    await Promise.all(Array.from({ length: CONCURRENCY }, worker));
    clearInterval(notify);
    filled = true;
    publish({ loading: false, done, total: markets.length, error: failed });
  } catch (err) {
    publish({ loading: false, error: err instanceof Error ? err.message : String(err) });
  } finally {
    running = false;
  }
}

export const okxLiqState = () => snapshot;

/**
 * Reads the past day (or what's new since the last read) and tells
 * `listener` as it arrives; the returned function unsubscribes. What's
 * been read stays for the session.
 */
export function subscribeOkxLiquidations(
  listener: () => void,
  marketFor: (base: string) => string,
  rank: (base: string) => number,
): () => void {
  listeners.add(listener);
  void pass(marketFor, rank);
  return () => {
    listeners.delete(listener);
  };
}
