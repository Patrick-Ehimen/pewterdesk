import type { VenueId } from "@pewterdesk/core";
import type { RsiFrame } from "@pewterdesk/ui";
import { useCallback, useEffect, useRef, useSyncExternalStore } from "react";
import { loadRsi, rsiState, subscribeRsi } from "../lib/rsiStore";

/**
 * Every market's RSI(14) at `frame`, from `rsiStore`: what's kept shows at
 * once (also after a reload), and a pass starts while `enabled` if the kept
 * values are stale or have gaps. Leaving doesn't stop a pass, so there's
 * nothing to load again on the way back.
 */
export function useRsiMap(
  venue: VenueId,
  markets: readonly string[],
  frame: RsiFrame,
  enabled: boolean,
) {
  const subscribe = useCallback(
    (listener: () => void) => subscribeRsi(venue, frame, listener),
    [venue, frame],
  );
  const state = useSyncExternalStore(subscribe, () => rsiState(venue, frame));
  const marketsRef = useRef(markets);
  marketsRef.current = markets;
  const ready = markets.length > 0;

  // biome-ignore lint/correctness/useExhaustiveDependencies: starts once the market list is in, and again when a pass ends stale
  useEffect(() => {
    if (enabled && ready) loadRsi(venue, frame, marketsRef.current);
  }, [venue, frame, enabled, ready, state.loading]);

  const refresh = useCallback(
    () => loadRsi(venue, frame, marketsRef.current, true),
    [venue, frame],
  );
  return { ...state, refresh };
}
