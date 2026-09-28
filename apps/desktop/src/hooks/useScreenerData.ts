import type { Market, MarketHistory, VenueId } from "@pewterdesk/core";
import {
  type MarketState,
  marketState,
  type OiSamples,
  type ScreenerRow,
  type SignalEvent,
  screenerRows,
  signalEvents,
  trackOpenInterest,
} from "@pewterdesk/ui";
import { useEffect, useMemo, useRef, useState } from "react";
import { venueClient } from "../api/venueClient";
import { useMarketSummaries } from "./useVenueFeeds";

/** Signal events kept in the feed. */
const MAX_EVENTS = 40;

export interface ScreenerData {
  rows: ScreenerRow[];
  /** Markets whose candle history has arrived, of all listed. */
  filled: number;
  total: number;
  events: SignalEvent[];
  /** When the summaries last updated (ms), for "updated HH:MM:SS". */
  updatedAt?: number;
  histories: ReadonlyMap<string, MarketHistory>;
  error?: string;
  loading: boolean;
}

/**
 * Everything the screener shows, live: summaries (polled), each market's
 * 7-day hourly history (streamed, busiest first), open-interest changes
 * tracked while it runs, and the signals those produce. Only subscribes
 * while `enabled`.
 */
export function useScreenerData(venue: VenueId, markets: Market[], enabled: boolean): ScreenerData {
  const summaries = useMarketSummaries(venue, enabled);
  const [histories, setHistories] = useState<Map<string, MarketHistory>>(new Map());
  const [events, setEvents] = useState<SignalEvent[]>([]);
  const [oiChanges, setOiChanges] = useState<Map<string, number>>(new Map());
  const [updatedAt, setUpdatedAt] = useState<number>();
  const oiSamples = useRef<OiSamples>(new Map());
  const states = useRef<Map<string, MarketState>>(new Map());

  // Stream candle history in, one market at a time.
  useEffect(() => {
    if (!enabled) return;
    return venueClient.subscribeMarketHistory(venue, {
      onUpdate: (history) => setHistories((prev) => new Map(prev).set(history.market, history)),
      onClosed: () => {},
      onError: () => {},
    });
  }, [venue, enabled]);

  const data =
    summaries.status === "live" || summaries.status === "closed" ? summaries.data : undefined;

  // Each summaries update: track OI, stamp the time.
  useEffect(() => {
    if (!data) return;
    const now = Date.now();
    setOiChanges(trackOpenInterest(oiSamples.current, data, now));
    setUpdatedAt(now);
  }, [data]);

  const rows = useMemo(
    () => (data ? screenerRows(markets, data, histories, oiChanges) : []),
    [markets, data, histories, oiChanges],
  );

  // Compare every market with how it looked last time, and log crossings.
  useEffect(() => {
    if (rows.length === 0) return;
    const next = new Map(
      rows.map((r) => [r.market.id, marketState(r, histories.get(r.market.id))]),
    );
    const byId = new Map(rows.map((r) => [r.market.id, r]));
    const fresh = signalEvents(states.current, next, byId, Date.now());
    states.current = next;
    if (fresh.length) setEvents((prev) => [...fresh, ...prev].slice(0, MAX_EVENTS));
  }, [rows, histories]);

  return {
    rows,
    filled: rows.filter((r) => histories.has(r.market.id)).length,
    total: rows.length,
    events,
    updatedAt,
    histories,
    error: summaries.status === "error" ? summaries.message : undefined,
    loading: summaries.status === "loading",
  };
}
