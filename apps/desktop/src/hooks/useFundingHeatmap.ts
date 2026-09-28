import type { VenueId } from "@pewterdesk/core";
import type { HeatmapRow, ScreenerRow } from "@pewterdesk/ui";
import { useEffect, useMemo, useState } from "react";
import { venueClient } from "../api/venueClient";

const HOURS = 12;
const HOUR_MS = 3_600_000;
/** Markets in the heatmap. */
const ROWS = 9;
/** Only markets this high in 24h volume qualify, so thin markets don't crowd it. */
const LIQUID = 60;
/** Funding history changes hourly; refresh well within that. */
const REFRESH_MS = 10 * 60_000;

/**
 * The last 12 hours of funding for the markets with the most extreme funding
 * right now (among the liquid ones), as hourly heatmap rows.
 */
export function useFundingHeatmap(
  venue: VenueId,
  rows: readonly ScreenerRow[],
  enabled: boolean,
): { rows: HeatmapRow[]; start?: number; loading: boolean } {
  // Which markets: recomputed only when the ranking itself changes.
  const picks = useMemo(() => {
    const liquid = [...rows].sort((a, b) => b.volume - a.volume).slice(0, LIQUID);
    return liquid
      .sort((a, b) => Math.abs(b.fundingApr) - Math.abs(a.fundingApr))
      .slice(0, ROWS)
      .map((r) => ({ id: r.market.id, label: r.market.base }));
  }, [rows]);
  const key = picks.map((p) => p.id).join(",");

  const [heat, setHeat] = useState<{ rows: HeatmapRow[]; start?: number }>({ rows: [] });
  const [loading, setLoading] = useState(false);

  // biome-ignore lint/correctness/useExhaustiveDependencies: `key` stands for `picks`
  useEffect(() => {
    if (!enabled || picks.length === 0) return;
    let current = true;
    const load = async () => {
      setLoading(true);
      const now = Date.now();
      const thisHour = Math.floor(now / HOUR_MS) * HOUR_MS;
      const start = thisHour - (HOURS - 1) * HOUR_MS;
      const results = await Promise.all(
        picks.map(async (p) => {
          try {
            const rates = await venueClient.fundingHistory(venue, p.id, start - HOUR_MS);
            // One cell per hour, oldest first; a payment lands just after the hour.
            const cells: (number | undefined)[] = Array.from({ length: HOURS }, () => undefined);
            for (const r of rates) {
              const i = Math.floor((r.time - start) / HOUR_MS);
              if (i >= 0 && i < HOURS) cells[i] = Number(r.rate);
            }
            return { label: p.label, rates: cells };
          } catch {
            return { label: p.label, rates: Array.from({ length: HOURS }, () => undefined) };
          }
        }),
      );
      if (current) {
        setHeat({ rows: results, start });
        setLoading(false);
      }
    };
    void load();
    const id = setInterval(load, REFRESH_MS);
    return () => {
      current = false;
      clearInterval(id);
    };
  }, [venue, key, enabled]);

  return { ...heat, loading };
}
