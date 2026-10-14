import type { Candle, CandleInterval, VenueId } from "@pewterdesk/core";
import { type BarSource, INTERVAL_MS } from "@pewterdesk/ui";
import { venueClient } from "../api/venueClient";
import { loadCandles, saveCandles } from "./candleCache";
import { mergeCandles, prependCandles } from "./candles";

/** Series kept in memory for the session, most recently used last. */
export const SESSION_SERIES = 40;

/**
 * Every chart's candles for this session, history and live updates merged,
 * so a chart built again (back on a page, or on a market seen before) draws
 * what was already loaded at once and only asks the venue for what's new.
 * Public market data; gone when the app quits.
 */
export class SessionCandles {
  private readonly series = new Map<string, Candle[]>();

  constructor(private readonly limit = SESSION_SERIES) {}

  get(key: string): Candle[] | undefined {
    const found = this.series.get(key);
    if (found) this.touch(key, found);
    return found;
  }

  /** Newer candles (a history page reaching the present, or live ones) joined on. */
  merge(key: string, candles: readonly Candle[]) {
    if (candles.length === 0) return;
    this.touch(key, mergeCandles(this.series.get(key) ?? [], candles));
  }

  /** An older page joined on before the oldest held. */
  prepend(key: string, older: readonly Candle[]) {
    const held = this.series.get(key);
    if (!held) return;
    this.touch(key, prependCandles(held, older).series);
  }

  private touch(key: string, candles: Candle[]) {
    this.series.delete(key);
    this.series.set(key, candles);
    for (const oldest of this.series.keys()) {
      if (this.series.size <= this.limit) break;
      this.series.delete(oldest);
    }
  }
}

const session = new SessionCandles();
const keyOf = (venue: VenueId, market: string, interval: CandleInterval) =>
  `${venue}:${interval}:${market}`;

/**
 * A venue's candles for the price chart, over the venue commands. A stream
 * that ends or fails just stops: the chart keeps the history it has and asks
 * again on its next reload. What has been loaded is kept for the session
 * (`SessionCandles`), and the latest history on this machine too
 * (`candleCache`), so a chart of that market draws at once.
 */
export function venueBarSource(venue: VenueId): BarSource {
  return {
    history: async (market, interval, before, count) => {
      const candles = await venueClient.candles(venue, market, interval, before, count);
      const key = keyOf(venue, market, interval);
      // The newest page joins (and is kept on disk); an older one goes before.
      if (before > Date.now() - INTERVAL_MS[interval]) {
        session.merge(key, candles);
        saveCandles(venue, market, interval, candles);
      } else {
        session.prepend(key, candles);
      }
      return candles;
    },
    cached: (market, interval) =>
      session.get(keyOf(venue, market, interval)) ?? loadCandles(venue, market, interval),
    subscribe: (market, interval, onCandles) => {
      const key = keyOf(venue, market, interval);
      return venueClient.subscribeCandles(venue, market, interval, {
        onUpdate: (candles) => {
          session.merge(key, candles);
          onCandles(candles);
        },
        onClosed: () => {},
        onError: () => {},
      });
    },
  };
}
