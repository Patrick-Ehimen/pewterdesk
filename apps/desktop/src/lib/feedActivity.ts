import type { VenueId } from "@pewterdesk/core";

// What each open venue stream is doing: when it last delivered, whether it
// ended, and (for the order book) how far behind the venue's own timestamp
// it arrives. Fed by venueClient's `subscribe`, read by the connection panel
// and the order book's stale overlay.

/** The subscription commands, as the panel names them. */
export type FeedKind =
  | "book"
  | "trades"
  | "stats"
  | "candles"
  | "summaries"
  | "history"
  | "account";

const KIND_OF: Record<string, FeedKind> = {
  subscribe_order_book: "book",
  subscribe_trades: "trades",
  subscribe_market_stats: "stats",
  subscribe_candles: "candles",
  subscribe_market_summaries: "summaries",
  subscribe_market_history: "history",
  subscribe_account: "account",
};

/**
 * How long each feed may go quiet before it's late. The book and stats tick
 * every second or so; trades and candles only move when something trades,
 * and the screener's streams are paced.
 */
export const FEED_TIMEOUT_MS: Record<FeedKind, number> = {
  book: 10_000,
  stats: 10_000,
  trades: 60_000,
  candles: 60_000,
  summaries: 20_000,
  history: 30_000,
  account: 30_000,
};

export interface FeedEntry {
  kind: FeedKind;
  venue: VenueId;
  started: number;
  /** When it last delivered; unset until the first update. */
  last?: number;
  /** Arrival time minus the venue's timestamp, for feeds that carry one. */
  lagMs?: number;
  ended?: "closed" | "error";
}

const feeds = new Map<number, FeedEntry>();
let next = 1;

/** Registers an opened stream; the returned calls report on it. */
export function trackFeed(command: string, venue: VenueId, now: () => number = Date.now) {
  const kind = KIND_OF[command];
  if (!kind) return { update() {}, closed() {}, failed() {}, stop() {} };
  const id = next++;
  const entry: FeedEntry = { kind, venue, started: now() };
  feeds.set(id, entry);
  return {
    update(data?: unknown) {
      entry.last = now();
      entry.ended = undefined;
      const time = (data as { time?: unknown } | undefined)?.time;
      if (kind === "book" && typeof time === "number") entry.lagMs = entry.last - time;
    },
    closed() {
      entry.ended = "closed";
    },
    failed() {
      entry.ended = "error";
    },
    stop() {
      feeds.delete(id);
    },
  };
}

/** The open feeds, one per kind (the most recent if a kind is open twice). */
export function feedSnapshot(venue?: VenueId): FeedEntry[] {
  const byKind = new Map<FeedKind, FeedEntry>();
  for (const f of feeds.values()) {
    if (venue && f.venue !== venue) continue;
    const seen = byKind.get(f.kind);
    if (!seen || f.started >= seen.started) byKind.set(f.kind, { ...f });
  }
  const order = Object.keys(FEED_TIMEOUT_MS) as FeedKind[];
  return order.flatMap((k) => {
    const f = byKind.get(k);
    return f ? [f] : [];
  });
}

export type FeedHealth = "live" | "late" | "waiting" | "down";

/** Green, orange, grey or red in the panel. */
export function feedHealth(f: FeedEntry, now: number): FeedHealth {
  if (f.ended) return "down";
  if (f.last === undefined) return now - f.started > FEED_TIMEOUT_MS[f.kind] ? "late" : "waiting";
  return now - f.last > FEED_TIMEOUT_MS[f.kind] ? "late" : "live";
}

/** Forgets every feed; for tests. */
export function resetFeeds() {
  feeds.clear();
}
