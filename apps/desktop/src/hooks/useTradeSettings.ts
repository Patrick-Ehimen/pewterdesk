import type { MarginMode, TradeSettings, VenueId } from "@pewterdesk/core";
import { useCallback, useEffect, useRef, useState } from "react";
import { venueClient } from "../api/venueClient";

/** How often the venue is asked again, so a change made there shows up here. */
const REFRESH_MS = 10_000;

export interface TradeSettingsState {
  /** The account's margin mode and leverage on the market; unset until read, or where unsupported. */
  settings?: TradeSettings;
  /** Unset where the account can't trade. */
  setLeverage?: (leverage: number) => Promise<void>;
  setMarginMode?: (mode: MarginMode) => Promise<void>;
}

/**
 * The ticket's margin mode and leverage for `market`: read for the account
 * on screen, and changeable only through `trading` (an account Rust lets
 * trade). Re-read after each change, every few seconds, and when the window
 * comes back into focus, so the ticket shows what the venue has - including
 * a leverage or margin mode changed on the venue's own site.
 */
export function useTradeSettings(
  venue: VenueId,
  address: string | undefined,
  market: string | undefined,
  trading: { venue: VenueId; id: string } | undefined,
): TradeSettingsState {
  const key = address && market ? `${venue}:${address}:${market}` : undefined;
  const [state, setState] = useState<{ key: string; settings: TradeSettings }>();
  const [version, setVersion] = useState(0);
  // A venue that can't answer isn't asked again every few seconds.
  const unanswered = useRef<string>(undefined);

  // biome-ignore lint/correctness/useExhaustiveDependencies: `version` re-reads after a change
  useEffect(() => {
    if (!key || !address || !market) return;
    let live = true;
    venueClient.tradeSettings(venue, address, market).then(
      (settings) => {
        unanswered.current = undefined;
        if (live) setState({ key, settings });
      },
      // Unsupported on this venue, or a failed read: the ticket falls back.
      () => {
        unanswered.current = key;
      },
    );
    return () => {
      live = false;
    };
  }, [key, venue, address, market, version]);

  useEffect(() => {
    if (!key) return;
    const refresh = () => {
      // Not while hidden: nobody's looking, and it's a signed request.
      if (document.visibilityState === "visible" && unanswered.current !== key) {
        setVersion((v) => v + 1);
      }
    };
    const id = setInterval(refresh, REFRESH_MS);
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", refresh);
    return () => {
      clearInterval(id);
      window.removeEventListener("focus", refresh);
      document.removeEventListener("visibilitychange", refresh);
    };
  }, [key]);

  const tradingId = trading?.id;
  const tradingVenue = trading?.venue;
  const setLeverage = useCallback(
    async (leverage: number) => {
      if (!tradingId || !tradingVenue || !market) return;
      await venueClient.setLeverage(tradingVenue, tradingId, market, String(leverage));
      setVersion((v) => v + 1);
    },
    [tradingId, tradingVenue, market],
  );
  const setMarginMode = useCallback(
    async (mode: MarginMode) => {
      if (!tradingId || !tradingVenue || !market) return;
      await venueClient.setMarginMode(tradingVenue, tradingId, market, mode);
      setVersion((v) => v + 1);
    },
    [tradingId, tradingVenue, market],
  );

  const canChange = trading !== undefined && trading.id === address && market !== undefined;
  return {
    settings: state && state.key === key ? state.settings : undefined,
    setLeverage: canChange ? setLeverage : undefined,
    setMarginMode: canChange ? setMarginMode : undefined,
  };
}
