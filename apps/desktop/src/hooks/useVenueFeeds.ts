import type {
  AccountSnapshot,
  Candle,
  CandleInterval,
  Fill,
  FundingPayment,
  FundingRate,
  Market,
  MarketStats,
  MarketSummary,
  Order,
  OrderBook,
  Trade,
  VenueId,
} from "@pewterdesk/core";
import { t } from "@pewterdesk/ui";
import { useCallback, useEffect, useRef, useState } from "react";
import { type StreamHandlers, venueClient } from "../api/venueClient";
import { loadCandles, saveCandles } from "../lib/candleCache";
import { mergeCandles, prependCandles } from "../lib/candles";

/** How often a live series is written back to the cache, at most. */
const CACHE_SAVE_MS = 30_000;

export type Feed<T> =
  | { status: "idle" }
  | { status: "loading" }
  /** `closed`: the venue ended the stream; `data` is the last value it sent. */
  | { status: "live" | "closed"; data: T }
  | { status: "error"; message: string };

export function useMarkets(venue: VenueId): Feed<Market[]> {
  const [feed, setFeed] = useState<Feed<Market[]>>({ status: "loading" });
  useEffect(() => {
    let current = true;
    setFeed({ status: "loading" });
    venueClient.markets(venue).then(
      (data) => current && setFeed({ status: "live", data }),
      (e: Error) => current && setFeed({ status: "error", message: e.message }),
    );
    return () => {
      current = false;
    };
  }, [venue]);
  return feed;
}

/**
 * Keeps a subscription open while `key` is set and the component is mounted,
 * resubscribing whenever `key` changes.
 */
function useStream<T>(
  key: string | undefined,
  start: (handlers: StreamHandlers<T>) => () => void,
): Feed<T> {
  const [feed, setFeed] = useState<Feed<T>>({ status: "idle" });
  // `start` is rebuilt every render; `key` is what identifies the stream.
  // biome-ignore lint/correctness/useExhaustiveDependencies: see above
  useEffect(() => {
    if (key === undefined) {
      setFeed({ status: "idle" });
      return;
    }
    setFeed({ status: "loading" });
    return start({
      onUpdate: (data) => setFeed({ status: "live", data }),
      onClosed: () =>
        setFeed((prev) =>
          prev.status === "live"
            ? { status: "closed", data: prev.data }
            : { status: "error", message: t("error.feedClosed") },
        ),
      onError: (message) => setFeed({ status: "error", message }),
    });
  }, [key]);
  return feed;
}

export function useOrderBook(venue: VenueId, market: string | undefined): Feed<OrderBook> {
  return useStream(market && `${venue}:${market}`, (handlers) =>
    venueClient.subscribeOrderBook(venue, market ?? "", handlers),
  );
}

/** Recent trades, newest first. Pass no market to stay unsubscribed. */
export function useTrades(venue: VenueId, market: string | undefined): Feed<Trade[]> {
  return useStream(market && `${venue}:${market}`, (handlers) =>
    venueClient.subscribeTrades(venue, market ?? "", handlers),
  );
}

/** Mark, index, the day's range and volume, open interest and funding. */
export function useMarketStats(venue: VenueId, market: string | undefined): Feed<MarketStats> {
  return useStream(market && `${venue}:${market}`, (handlers) =>
    venueClient.subscribeMarketStats(venue, market ?? "", handlers),
  );
}

/** Candles fetched per step back, when a chart is scrolled past its oldest. */
const OLDER_PAGE = 1000;

export interface CandleFeed {
  feed: Feed<Candle[]>;
  /**
   * Fetches the page before the oldest candle and joins it on. Safe to call
   * often: one fetch at a time, and none once the venue has no more.
   */
  loadOlder: () => void;
}

/**
 * A market's candles at `interval`, as one series: the history, then live
 * updates merged in, and older pages joined on when asked. Resubscribes when
 * the market or interval changes.
 *
 * The last series seen is cached on this machine, so the chart draws at once
 * (on launch, or back on a market) while the venue's history loads; the
 * history then replaces it.
 */
export function useCandles(
  venue: VenueId,
  market: string | undefined,
  interval: CandleInterval,
): CandleFeed {
  const [feed, setFeed] = useState<Feed<Candle[]>>({ status: "idle" });
  // Shared by the stream and `loadOlder`; reset per market and interval.
  const series = useRef<Candle[] | undefined>(undefined);
  const loading = useRef(false);
  const exhausted = useRef(false);
  const generation = useRef(0);

  useEffect(() => {
    generation.current += 1;
    series.current = undefined;
    loading.current = false;
    exhausted.current = false;
    if (market === undefined) {
      setFeed({ status: "idle" });
      return;
    }
    const cached = loadCandles(venue, market, interval);
    setFeed(cached ? { status: "live", data: cached } : { status: "loading" });
    let savedAt = 0;
    const save = (force: boolean) => {
      const current = series.current;
      if (!current || (!force && Date.now() - savedAt < CACHE_SAVE_MS)) return;
      savedAt = Date.now();
      saveCandles(venue, market, interval, current);
    };
    const unsubscribe = venueClient.subscribeCandles(venue, market, interval, {
      onUpdate: (batch) => {
        // The first batch is the history, which replaces anything cached;
        // later ones are live candles.
        const first = series.current === undefined;
        series.current = first ? batch : mergeCandles(series.current ?? [], batch);
        setFeed({ status: "live", data: series.current });
        save(first);
      },
      onClosed: () =>
        setFeed(
          series.current
            ? { status: "closed", data: series.current }
            : { status: "error", message: t("error.feedClosed") },
        ),
      // Keep showing the cached candles rather than an error over nothing new.
      onError: (message) =>
        setFeed(cached ? { status: "closed", data: cached } : { status: "error", message }),
    });
    return () => {
      unsubscribe();
      save(true);
    };
  }, [venue, market, interval]);

  const loadOlder = useCallback(() => {
    const oldest = series.current?.[0];
    if (market === undefined || !oldest || loading.current || exhausted.current) return;
    loading.current = true;
    const asked = generation.current;
    venueClient.candles(venue, market, interval, oldest.openTime, OLDER_PAGE).then(
      (older) => {
        // A switch of market or interval since: this page belongs to neither.
        if (asked !== generation.current) return;
        loading.current = false;
        const joined = prependCandles(series.current ?? [], older);
        if (joined.added === 0) {
          exhausted.current = true;
          return;
        }
        series.current = joined.series;
        setFeed((prev) => ({
          status: prev.status === "closed" ? "closed" : "live",
          data: joined.series,
        }));
      },
      () => {
        if (asked === generation.current) loading.current = false;
      },
    );
  }, [venue, market, interval]);

  return { feed, loadOlder };
}

/** An account's history refreshes this often while its tab is open. */
const HISTORY_REFRESH_MS = 30_000;
/** Funding payments shown: the last 30 days. */
const ACCOUNT_FUNDING_DAYS = 30;

/**
 * Loads `load()` while `key` is set, then again every 30 seconds. A failed
 * refresh keeps the last data rather than replacing it with an error.
 */
function usePolled<T>(key: string | undefined, load: () => Promise<T>): Feed<T> {
  const [feed, setFeed] = useState<Feed<T>>({ status: "idle" });
  // `load` is rebuilt every render; `key` is what identifies the data.
  // biome-ignore lint/correctness/useExhaustiveDependencies: see above
  useEffect(() => {
    if (key === undefined) {
      setFeed({ status: "idle" });
      return;
    }
    let current = true;
    setFeed({ status: "loading" });
    const run = () =>
      load().then(
        (data) => current && setFeed({ status: "live", data }),
        (e: Error) =>
          current &&
          setFeed((prev) =>
            prev.status === "live" ? prev : { status: "error", message: e.message },
          ),
      );
    void run();
    const id = setInterval(run, HISTORY_REFRESH_MS);
    return () => {
      current = false;
      clearInterval(id);
    };
  }, [key]);
  return feed;
}

/** The watched account's fills, newest first, while `enabled`. */
export function useAccountFills(venue: VenueId, address: string | undefined, enabled: boolean) {
  return usePolled<Fill[]>(enabled && address ? `${venue}:${address}` : undefined, () =>
    venueClient.fills(venue, address ?? ""),
  );
}

/** Funding paid or received by the watched account in the last 30 days, while `enabled`. */
export function useAccountFunding(venue: VenueId, address: string | undefined, enabled: boolean) {
  return usePolled<FundingPayment[]>(enabled && address ? `${venue}:${address}` : undefined, () =>
    venueClient.fundingPayments(
      venue,
      address ?? "",
      Date.now() - ACCOUNT_FUNDING_DAYS * 86_400_000,
    ),
  );
}

/** The watched account's recent orders in any state, while `enabled`. */
export function useOrderHistory(venue: VenueId, address: string | undefined, enabled: boolean) {
  return usePolled<Order[]>(enabled && address ? `${venue}:${address}` : undefined, () =>
    venueClient.orderHistory(venue, address ?? ""),
  );
}

/** Funding history shown in the Charts tab: the last 30 days. */
const FUNDING_DAYS = 30;
/** Payments are hourly, so this is plenty fresh. */
const FUNDING_REFRESH_MS = 10 * 60_000;

/**
 * A market's funding payments over the last 30 days, oldest first, refreshed
 * every 10 minutes while `market` is set. Keeps the last data on a failed
 * refresh.
 */
export function useFundingHistory(venue: VenueId, market: string | undefined): Feed<FundingRate[]> {
  const [feed, setFeed] = useState<Feed<FundingRate[]>>({ status: "idle" });
  useEffect(() => {
    if (market === undefined) {
      setFeed({ status: "idle" });
      return;
    }
    let current = true;
    setFeed({ status: "loading" });
    const load = () =>
      venueClient.fundingHistory(venue, market, Date.now() - FUNDING_DAYS * 86_400_000).then(
        (data) => current && setFeed({ status: "live", data }),
        (e: Error) =>
          current &&
          setFeed((prev) =>
            prev.status === "live" ? prev : { status: "error", message: e.message },
          ),
      );
    void load();
    const id = setInterval(load, FUNDING_REFRESH_MS);
    return () => {
      current = false;
      clearInterval(id);
    };
  }, [venue, market]);
  return feed;
}

/**
 * One summaries subscription per venue, shared by every component that
 * wants it (the screener, the market picker), so each extra user costs no
 * extra polling of the venue. Started by the first, stopped by the last.
 */
interface SharedSummaries {
  listeners: Set<(feed: Feed<MarketSummary[]>) => void>;
  last: Feed<MarketSummary[]>;
  stop?: () => void;
}
const sharedSummaries = new Map<VenueId, SharedSummaries>();

/** Every market's summary, for the screener and market picker; `enabled: false` lets go of it. */
export function useMarketSummaries(venue: VenueId, enabled: boolean): Feed<MarketSummary[]> {
  const [feed, setFeed] = useState<Feed<MarketSummary[]>>({ status: "idle" });
  useEffect(() => {
    if (!enabled) {
      setFeed({ status: "idle" });
      return;
    }
    let shared = sharedSummaries.get(venue);
    if (!shared) {
      shared = { listeners: new Set(), last: { status: "loading" } };
      sharedSummaries.set(venue, shared);
    }
    const stream = shared;
    const emit = (next: Feed<MarketSummary[]>) => {
      stream.last = next;
      for (const listener of stream.listeners) listener(next);
    };
    stream.listeners.add(setFeed);
    setFeed(stream.last);
    stream.stop ??= venueClient.subscribeMarketSummaries(venue, {
      onUpdate: (data) => emit({ status: "live", data }),
      onClosed: () =>
        emit(
          stream.last.status === "live"
            ? { status: "closed", data: stream.last.data }
            : { status: "error", message: t("error.feedClosed") },
        ),
      onError: (message) => emit({ status: "error", message }),
    });
    return () => {
      stream.listeners.delete(setFeed);
      if (stream.listeners.size === 0) {
        stream.stop?.();
        sharedSummaries.delete(venue);
      }
    };
  }, [venue, enabled]);
  return feed;
}

export function useAccount(venue: VenueId, address: string | undefined): Feed<AccountSnapshot> {
  return useStream(address && `${venue}:${address}`, (handlers) =>
    venueClient.subscribeAccount(venue, address ?? "", handlers),
  );
}
