import type { MarginMode, TradeSettings, VenueId } from "@pewterdesk/core";
import { useCallback, useEffect, useState } from "react";
import { venueClient } from "../api/venueClient";

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
 * trade). Re-read after each change, so the ticket shows what the venue has.
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

  // biome-ignore lint/correctness/useExhaustiveDependencies: `version` re-reads after a change
  useEffect(() => {
    if (!key || !address || !market) return;
    let live = true;
    venueClient.tradeSettings(venue, address, market).then(
      (settings) => live && setState({ key, settings }),
      // Unsupported on this venue, or a failed read: the ticket falls back.
      () => undefined,
    );
    return () => {
      live = false;
    };
  }, [key, venue, address, market, version]);

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
