import type { VenueId } from "@pewterdesk/core";
import { type LiqEvent, mergeLiquidations } from "@pewterdesk/ui";
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { venueClient } from "../api/venueClient";
import { okxLiqState, subscribeOkxLiquidations } from "../lib/okxLiquidations";

const STORAGE_PREFIX = "pd.liquidations.";
/** The venues with a public live liquidation feed for every market. */
export const LIVE_LIQUIDATION_VENUES: readonly VenueId[] = ["bybit", "binance"];
/**
 * Whose live feed is read: the venue on screen's, where it has one, and
 * Bybit's (which covers every Bybit market) on a venue that doesn't.
 */
export const liveLiquidationSource = (venue: VenueId): VenueId =>
  LIVE_LIQUIDATION_VENUES.includes(venue) ? venue : "bybit";
/** A market's base coin: `BTCUSDT` and `BTCPERP` are both BTC. */
const baseOf = (market: string) => market.replace(/(USDT|USDC|PERP|USD)$/, "");
/** How often the kept feed is written to storage. */
const SAVE_EVERY_MS = 5000;

interface Stored {
  since: number;
  events: LiqEvent[];
}

function load(source: VenueId): Stored | undefined {
  try {
    const saved: unknown = JSON.parse(localStorage.getItem(STORAGE_PREFIX + source) ?? "null");
    if (typeof saved !== "object" || saved === null) return undefined;
    const { since, events } = saved as Partial<Stored>;
    if (typeof since !== "number" || !Array.isArray(events)) return undefined;
    const kept = mergeLiquidations(events, [], Date.now());
    // Nothing left from last time (it was over a day ago): collecting starts now.
    return kept.length > 0 ? { since, events: kept } : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Liquidations while `enabled`, from two exchanges, newest first:
 *
 * - `source`'s public feed, live (see `liveLiquidationSource`), kept for a
 *   day on this device (browser storage, per source) so reopening the page
 *   doesn't start from nothing. `since` is when that collecting began.
 * - OKX's public history of the last day, read when the view opens.
 *   `marketFor` gives the id an OKX coin is grouped under (the
 *   venue's own market for it, if it lists one) and `rank` the order its
 *   markets are read in.
 *
 * `error` is set if the venue's feed failed; `okx` carries OKX's progress.
 */
export function useLiquidations(
  enabled: boolean,
  marketFor: (base: string) => string,
  rank: (base: string) => number,
  /** Changes when `marketFor` would answer differently, e.g. the venue on screen. */
  venueKey: string,
  source: VenueId,
) {
  const [state, setState] = useState<Stored>(
    () => load(source) ?? { since: Date.now(), events: [] },
  );
  const [error, setError] = useState<string>();
  const latest = useRef(state);
  latest.current = state;

  useEffect(() => {
    if (!enabled) return;
    // Another source's feed starts from what was kept of it.
    const kept = load(source) ?? { since: Date.now(), events: [] };
    latest.current = kept;
    setState(kept);
    setError(undefined);
    const stop = venueClient.subscribeLiquidations(source, {
      onUpdate: (batch) =>
        setState((s) => ({ ...s, events: mergeLiquidations(s.events, batch, Date.now()) })),
      onClosed: () => {},
      onError: (message) => setError(message),
    });
    const save = () => {
      try {
        localStorage.setItem(STORAGE_PREFIX + source, JSON.stringify(latest.current));
      } catch {
        // Storage full or unavailable; the feed just starts over next time.
      }
    };
    const id = setInterval(save, SAVE_EVERY_MS);
    return () => {
      clearInterval(id);
      save();
      stop();
    };
  }, [enabled, source]);

  // The latest lookups, without restarting OKX's reading when they change.
  const lookups = useRef({ marketFor, rank });
  lookups.current = { marketFor, rank };
  const okx = useSyncExternalStore(
    useMemo(
      () => (listener: () => void) =>
        enabled
          ? subscribeOkxLiquidations(
              listener,
              (base) => lookups.current.marketFor(base),
              (base) => lookups.current.rank(base),
            )
          : () => {},
      [enabled],
    ),
    okxLiqState,
  );
  // The feed's own market ids become the ids the view groups by, like OKX's.
  // biome-ignore lint/correctness/useExhaustiveDependencies: `venueKey` re-maps when the venue on screen changes
  const events = useMemo(
    () =>
      [
        ...state.events.map((e) => ({ ...e, market: lookups.current.marketFor(baseOf(e.market)) })),
        ...okx.events,
      ].sort((a, b) => b.time - a.time),
    [state.events, okx.events, venueKey],
  );

  return { since: state.since, events, error, okx };
}
