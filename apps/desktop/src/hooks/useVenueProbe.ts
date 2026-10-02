import type { VenueId } from "@pewterdesk/core";
import { useEffect, useState } from "react";
import { venueClient } from "../api/venueClient";
import { VENUE_IDS } from "../lib/venues";

export type VenueProbe =
  | { status: "checking" }
  | { status: "up"; ms: number; markets: number }
  | { status: "down"; message: string };

/**
 * Asks each venue for its market list once, timing the answer: whether it's
 * reachable, how fast, and how many markets it lists. For the Venues page
 * and the setup's system check; the trading screen has live feeds instead.
 */
export function useVenueProbe(): Record<VenueId, VenueProbe> {
  const [probes, setProbes] = useState<Record<VenueId, VenueProbe>>(
    () =>
      Object.fromEntries(VENUE_IDS.map((id) => [id, { status: "checking" }])) as Record<
        VenueId,
        VenueProbe
      >,
  );
  useEffect(() => {
    let live = true;
    for (const id of VENUE_IDS) {
      const started = performance.now();
      venueClient.markets(id).then(
        (markets) => {
          if (!live) return;
          const ms = Math.round(performance.now() - started);
          setProbes((p) => ({ ...p, [id]: { status: "up", ms, markets: markets.length } }));
        },
        (e: unknown) => {
          if (!live) return;
          const message = e instanceof Error ? e.message : String(e);
          setProbes((p) => ({ ...p, [id]: { status: "down", message } }));
        },
      );
    }
    return () => {
      live = false;
    };
  }, []);
  return probes;
}
