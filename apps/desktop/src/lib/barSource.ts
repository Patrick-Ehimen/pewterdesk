import type { VenueId } from "@pewterdesk/core";
import { type BarSource, INTERVAL_MS } from "@pewterdesk/ui";
import { venueClient } from "../api/venueClient";
import { loadCandles, saveCandles } from "./candleCache";

/**
 * A venue's candles for the price chart, over the venue commands. A stream
 * that ends or fails just stops: the chart keeps the history it has and asks
 * again on its next reload. The latest history is kept on this machine
 * (`candleCache`), so the next chart of that market draws at once.
 */
export function venueBarSource(venue: VenueId): BarSource {
  return {
    history: async (market, interval, before, count) => {
      const candles = await venueClient.candles(venue, market, interval, before, count);
      // Only the newest page: an older one would replace it with the past.
      if (before > Date.now() - INTERVAL_MS[interval]) {
        saveCandles(venue, market, interval, candles);
      }
      return candles;
    },
    cached: (market, interval) => loadCandles(venue, market, interval),
    subscribe: (market, interval, onCandles) =>
      venueClient.subscribeCandles(venue, market, interval, {
        onUpdate: onCandles,
        onClosed: () => {},
        onError: () => {},
      }),
  };
}
