import { useEffect, useMemo, useState } from "react";
import {
  type TraderRow,
  type TraderSource,
  type TraderSwept,
  tradersClient,
} from "../api/venueClient";

// The leaderboard's insight cards read the top traders' positions: a dozen
// at a time (Rust spaces the requests, and keeps each look 4 minutes), so the
// cards fill in as they come, and again every 5 minutes while the page is
// open - which is how Hyperliquid's new positions are seen.

/** How many of the board's top traders are read: OKX allows 5 requests per 2 s. */
export const TOP: Record<TraderSource, number> = { hyperliquid: 100, okx: 50 };
const CHUNK = 12;
const AGAIN_MS = 5 * 60_000;

export function useBoardInsights(rows: readonly TraderRow[] | undefined, source: TraderSource) {
  const [got, setGot] = useState<ReadonlyMap<string, TraderSwept>>(new Map());
  const [round, setRound] = useState(0);
  const ids = useMemo(() => rows?.slice(0, TOP[source]).map((r) => r.id) ?? [], [rows, source]);

  useEffect(() => {
    const timer = setInterval(() => setRound((r) => r + 1), AGAIN_MS);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    if (ids.length === 0) return;
    let live = true;
    // `round` reads them all again.
    void round;
    void (async () => {
      for (let i = 0; i < ids.length && live; i += CHUNK) {
        try {
          const part = await tradersClient.sweep(source, ids.slice(i, i + CHUNK));
          if (!live) return;
          setGot((before) => {
            const next = new Map(before);
            for (const s of part) next.set(`${s.source}:${s.id}`, s);
            return next;
          });
        } catch {
          // A part that can't be read leaves the cards with the rest.
        }
      }
    })();
    return () => {
      live = false;
    };
  }, [ids, source, round]);

  const swept = useMemo(
    () => ids.flatMap((id) => got.get(`${source}:${id}`) ?? []),
    [ids, got, source],
  );
  return { swept, total: ids.length, loading: rows === undefined || swept.length === 0 };
}
