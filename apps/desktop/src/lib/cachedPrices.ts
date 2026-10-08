import type { VenueId } from "@pewterdesk/core";
import { loadSummaries } from "./trayCache";

// The last price seen for a market on any venue, from the summaries the app
// keeps between sessions (`trayCache`). Used to tell whether two markets
// with the same ticker are the same asset: only then do they trade at the
// same price.

/** A venue's summaries are re-read from storage at most this often. */
const FRESH_MS = 30_000;

const cache = new Map<VenueId, { at: number; prices: Map<string, number> }>();

/** `market`'s last known price on `venue`, or undefined if none is kept. */
export function cachedPrice(venue: VenueId, market: string, now = Date.now()): number | undefined {
  let entry = cache.get(venue);
  if (!entry || now - entry.at > FRESH_MS) {
    const prices = new Map<string, number>();
    try {
      for (const s of loadSummaries(venue)) {
        const price = Number(s.markPrice);
        if (price > 0) prices.set(s.market, price);
      }
    } catch {
      // No storage: nothing is known, which callers treat as "can't tell".
    }
    entry = { at: now, prices };
    cache.set(venue, entry);
  }
  return entry.prices.get(market);
}
