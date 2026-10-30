import type { ClosedTrade, VenueId } from "@pewterdesk/core";
import { useEffect, useMemo, useState } from "react";
import { venueClient } from "../api/venueClient";

// Closed trades that came without a leverage - Hyperliquid's, Aster's and
// Binance's, built from fills, which carry none - take the account's
// leverage on that market now (the ticket's own read, `trade_settings`),
// so their margin and ROI can be shown. It's the market's setting today,
// not a record of the trade's, so the table says so beside it.

/** A market's leverage is read again after this long at most. */
const FRESH_MS = 60_000;

const known = new Map<string, { leverage?: string; at: number }>();

export interface ClosedWithLeverage {
  trades: ClosedTrade[];
  /** The trades whose leverage is the market's setting now, not the venue's record. */
  estimated: ReadonlySet<ClosedTrade>;
}

export function useClosedLeverage(
  venue: VenueId,
  address: string | undefined,
  trades: readonly ClosedTrade[] | undefined,
): ClosedWithLeverage {
  const [version, setVersion] = useState(0);
  const missing = useMemo(
    () => [...new Set((trades ?? []).filter((c) => !c.leverage).map((c) => c.market))].sort(),
    [trades],
  );
  const wanted = missing.join(",");

  // biome-ignore lint/correctness/useExhaustiveDependencies: `wanted` is `missing`, by value
  useEffect(() => {
    if (!address || missing.length === 0) return;
    let live = true;
    const now = Date.now();
    const due = missing.filter((m) => {
      const had = known.get(`${venue}:${address}:${m}`);
      return !had || now - had.at > FRESH_MS;
    });
    // One market at a time: a venue's signed reads are rate-limited.
    void (async () => {
      for (const market of due) {
        const key = `${venue}:${address}:${market}`;
        try {
          const settings = await venueClient.tradeSettings(venue, address, market);
          known.set(key, { leverage: settings.leverage, at: Date.now() });
        } catch {
          // Unsupported or failed: the table keeps "-" for it.
          known.set(key, { at: Date.now() });
        }
        if (live) setVersion((v) => v + 1);
      }
    })();
    return () => {
      live = false;
    };
  }, [venue, address, wanted]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: `version` brings in what was read
  return useMemo(() => {
    const estimated = new Set<ClosedTrade>();
    const out = (trades ?? []).map((c) => {
      if (c.leverage || !address) return c;
      const leverage = known.get(`${venue}:${address}:${c.market}`)?.leverage;
      if (!leverage || !(Number(leverage) > 0)) return c;
      const filled = { ...c, leverage };
      estimated.add(filled);
      return filled;
    });
    return { trades: out, estimated };
  }, [trades, venue, address, version]);
}
