import { HEAT_SECTORS, type HeatGroup } from "@pewterdesk/ui";
import { useEffect, useState } from "react";
import { coinClient } from "../api/venueClient";

/** How long a full set of sectors stays fresh before it's read again. */
const FRESH_MS = 5 * 60_000;
/** How soon the sectors that failed (usually CoinGecko's rate limit) are tried again. */
const RETRY_MS = 60_000;

/** Kept for the session, so leaving the heatmap and coming back shows it at once. */
let kept: { groups: HeatGroup[]; fetchedAt?: number } = { groups: [] };

/**
 * The market heatmap's coins: each sector's largest by market cap, from
 * CoinGecko, one sector at a time (Rust spaces the requests out), filling
 * in as they arrive. Kept for the session and read again once stale, the
 * old figures staying up meanwhile. `error` is the last failure, if any
 * sector couldn't be read.
 */
export function useCoinSectors(enabled: boolean) {
  const [groups, setGroups] = useState<HeatGroup[]>(kept.groups);
  const [done, setDone] = useState(kept.groups.length);
  const [error, setError] = useState<string>();

  useEffect(() => {
    if (!enabled) return;
    let live = true;
    const load = async () => {
      if (kept.fetchedAt && Date.now() - kept.fetchedAt < FRESH_MS) return;
      const next = new Map(kept.groups.map((g) => [g.sector, g]));
      const retrying = kept.fetchedAt === undefined && next.size > 0;
      let failed: string | undefined;
      let read = 0;
      for (const sector of HEAT_SECTORS) {
        // A retry only asks for what's missing; a refresh asks for everything.
        if (retrying && next.has(sector)) {
          read += 1;
          continue;
        }
        try {
          const coins = await coinClient.markets(sector);
          next.set(sector, { sector, coins });
        } catch (err) {
          failed = err instanceof Error ? err.message : String(err);
        }
        read += 1;
        kept = { ...kept, groups: HEAT_SECTORS.flatMap((s) => next.get(s) ?? []) };
        if (!live) return;
        setGroups(kept.groups);
        setDone(read);
      }
      // A pass with failures leaves the set unstamped, so the next tick
      // fills the gaps; a clean one is good for FRESH_MS.
      kept = { ...kept, fetchedAt: failed ? undefined : Date.now() };
      if (live) setError(failed);
    };
    let running = false;
    const tick = async () => {
      if (running) return;
      running = true;
      await load();
      running = false;
    };
    void tick();
    const id = setInterval(tick, RETRY_MS);
    return () => {
      live = false;
      clearInterval(id);
    };
  }, [enabled]);

  return { groups, done, total: HEAT_SECTORS.length, error };
}
