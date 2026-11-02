import type { Candle, CandleInterval, VenueId } from "@pewterdesk/core";
import { type BarSource, INTERVAL_MS } from "@pewterdesk/ui";
import { venueClient } from "../api/venueClient";
import { loadCandles, saveCandles } from "./candleCache";
import { joinNewestPage, mergeCandles, prependCandles } from "./candles";

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

  /** What a chart was just drawn from, for a series not yet held. */
  seed(key: string, candles: readonly Candle[]) {
    if (!this.series.has(key)) this.touch(key, [...candles]);
  }

  /** The venue's newest page, over what's held. `span`: a candle's longest length. */
  mergeNewest(key: string, page: readonly Candle[], span: number) {
    if (page.length === 0) return;
    this.touch(key, joinNewestPage(this.series.get(key) ?? [], page, span));
  }

  /** An older page joined on before the oldest held, if it reaches that far. */
  prepend(key: string, older: readonly Candle[], span: number) {
    const held = this.series.get(key);
    const newest = older.at(-1);
    const oldest = held?.[0];
    if (!held || !newest || !oldest || oldest.openTime - newest.openTime > span) return;
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
      const span = INTERVAL_MS[interval];
      // The newest page joins (and the whole is kept on disk: a chart drawn
      // from the cache asks only for the last few); an older one goes before.
      if (before > Date.now() - span) {
        session.mergeNewest(key, candles, span);
        saveCandles(venue, market, interval, session.get(key) ?? candles);
      } else {
        session.prepend(key, candles, span);
      }
      return candles;
    },
    cached: (market, interval) => {
      const key = keyOf(venue, market, interval);
      const held = session.get(key);
      if (held) return held;
      // Held from here on, or the page that tops it up would stand for it all.
      const saved = loadCandles(venue, market, interval);
      if (saved) session.seed(key, saved);
      return saved;
    },
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
