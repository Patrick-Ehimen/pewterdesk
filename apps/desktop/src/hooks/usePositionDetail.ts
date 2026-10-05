import type { Candle, FundingPayment, Position, VenueId } from "@pewterdesk/core";
import {
  INTERVAL_MS,
  intervalFor,
  type PnlPoint,
  type PositionFills,
  pnlSeries,
  positionFills,
  positionFunding,
} from "@pewterdesk/ui";
import { useEffect, useMemo, useState } from "react";
import { venueClient } from "../api/venueClient";
import { useAccountFills, useAccountFunding } from "./useVenueFeeds";

/** Where the fills don't show when a position opened, its PnL covers this long. */
const FALLBACK_SPAN_MS = 24 * 3_600_000;
/** Candles fetched for the PnL chart, at most. */
const MAX_CANDLES = 500;

export interface PositionDetail {
  fills?: PositionFills;
  funding?: FundingPayment[];
  pnl?: PnlPoint[];
}

/**
 * What the position drawer shows beyond the position itself: the fills that
 * built it, the funding it has paid since, and its PnL over that time
 * (from candles fetched once per open; the last point follows the position).
 * Loads only while `position` is set.
 */
export function usePositionDetail(
  venue: VenueId,
  address: string | undefined,
  position: Position | undefined,
): PositionDetail {
  const open = position !== undefined;
  const fillsFeed = useAccountFills(venue, address, open);
  const fundingFeed = useAccountFunding(venue, address, open);
  const allFills =
    fillsFeed.status === "live" || fillsFeed.status === "closed" ? fillsFeed.data : undefined;
  const allFunding =
    fundingFeed.status === "live" || fundingFeed.status === "closed" ? fundingFeed.data : undefined;

  const fills = useMemo(
    () => (allFills && position ? positionFills(allFills, position) : undefined),
    [allFills, position],
  );
  // Fixed once the fills are in, so the fallback doesn't move every render.
  const loaded = fills !== undefined;
  const openedAt = fills?.openedAt;
  const market = position?.market;
  // biome-ignore lint/correctness/useExhaustiveDependencies: `market` resets the fallback for another position
  const since = useMemo(
    () => (loaded ? (openedAt ?? Date.now() - FALLBACK_SPAN_MS) : undefined),
    [loaded, openedAt, market],
  );
  const funding = useMemo(
    () =>
      allFunding && position && since !== undefined
        ? positionFunding(allFunding, position.market, since)
        : undefined,
    [allFunding, position, since],
  );

  // The candles for the PnL chart: refetched only when the position or
  // when it opened changes, not on every mark tick.
  const [candles, setCandles] = useState<{ key: string; data: Candle[] }>();
  const key = market && since !== undefined ? `${venue}:${market}:${since}` : undefined;
  useEffect(() => {
    if (!key || !market || since === undefined) return;
    let live = true;
    const now = Date.now();
    const interval = intervalFor(now - since);
    const step = INTERVAL_MS[interval];
    const count = Math.min(MAX_CANDLES, Math.ceil((now - since) / step) + 2);
    venueClient.candles(venue, market, interval, now + step, count).then(
      (data) => live && setCandles({ key, data }),
      () => live && setCandles({ key, data: [] }),
    );
    return () => {
      live = false;
    };
  }, [key, venue, market, since]);

  const pnl =
    position && since !== undefined && candles && candles.key === key
      ? pnlSeries(candles.data, position, since, Date.now())
      : undefined;

  return { fills, funding, pnl };
}
