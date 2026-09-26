import type {
  AccountSnapshot,
  Market,
  MarketStats,
  OrderBook,
  Trade,
  VenueId,
} from "@pewterdesk/core";
import { t } from "@pewterdesk/ui";
import { useEffect, useState } from "react";
import { type StreamHandlers, venueClient } from "../api/venueClient";

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

export function useAccount(venue: VenueId, address: string | undefined): Feed<AccountSnapshot> {
  return useStream(address && `${venue}:${address}`, (handlers) =>
    venueClient.subscribeAccount(venue, address ?? "", handlers),
  );
}
