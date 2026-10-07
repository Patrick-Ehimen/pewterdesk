import type { VenueId } from "@pewterdesk/core";
import { type LiqEvent, mergeLiquidations } from "@pewterdesk/ui";
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { venueClient } from "../api/venueClient";
import { okxLiqState, subscribeOkxLiquidations } from "../lib/okxLiquidations";

const STORAGE_PREFIX = "pd.liquidations.";
/**
 * Whose public live feed is read. Liquidations here are market data, not
 * the selected venue's: Bybit publishes a live feed for every market, and
 * the view shows it whichever venue is on screen.
 */
const LIVE_VENUE: VenueId = "bybit";
/** A Bybit market's base coin: `BTCUSDT` and `BTCPERP` are both BTC. */
const baseOf = (market: string) => market.replace(/(USDT|USDC|PERP|USD)$/, "");
/** How often the kept feed is written to storage. */
const SAVE_EVERY_MS = 5000;

interface Stored {
  since: number;
  events: LiqEvent[];
}

function load(): Stored | undefined {
  try {
    const saved: unknown = JSON.parse(localStorage.getItem(STORAGE_PREFIX + LIVE_VENUE) ?? "null");
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
 * - Bybit's public feed, live, whichever venue is on screen, kept for a day on this
 *   device (browser storage) so reopening the page doesn't start from
 *   nothing. `since` is when that collecting began.
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
) {
  const [state, setState] = useState<Stored>(() => load() ?? { since: Date.now(), events: [] });
  const [error, setError] = useState<string>();
  const latest = useRef(state);
  latest.current = state;

  useEffect(() => {
    if (!enabled) return;
    const stop = venueClient.subscribeLiquidations(LIVE_VENUE, {
      onUpdate: (batch) =>
        setState((s) => ({ ...s, events: mergeLiquidations(s.events, batch, Date.now()) })),
      onClosed: () => {},
      onError: (message) => setError(message),
    });
    const save = () => {
      try {
        localStorage.setItem(STORAGE_PREFIX + LIVE_VENUE, JSON.stringify(latest.current));
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
  }, [enabled]);

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
