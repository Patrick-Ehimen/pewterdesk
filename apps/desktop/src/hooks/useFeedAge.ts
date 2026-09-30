import type { VenueId } from "@pewterdesk/core";
import { useEffect, useState } from "react";
import { type FeedEntry, type FeedKind, feedSnapshot } from "../lib/feedActivity";

/**
 * A feed's record and the time now, re-read every second so a feed going
 * quiet shows without waiting for its next update. `enabled` false stops
 * the ticking.
 */
export function useFeedAge(
  kind: FeedKind,
  venue: VenueId,
  enabled = true,
): { feed?: FeedEntry; now: number; network: boolean } {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!enabled) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [enabled]);
  return {
    feed: feedSnapshot(venue).find((f) => f.kind === kind),
    now,
    network: typeof navigator === "undefined" ? true : navigator.onLine,
  };
}
