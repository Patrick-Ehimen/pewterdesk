import type { VenueId } from "@pewterdesk/core";
import { t } from "@pewterdesk/ui";
import { useEffect, useRef } from "react";
import { notifyEvent } from "../lib/notifications";
import { useWatchAlerts } from "../lib/watchAlerts";
import { usePumpWatch } from "./usePumpWatch";

// The pump / dump watch's alerts: while the app runs and they're on, the
// venue on screen is watched every few minutes, and a market that has just
// started a move of the kind asked for says so through `notifyEvent`, with
// the news beside it. The first full round only notes where each market
// stands, so nothing fires for a move already under way when they're turned
// on. Read-only: it places nothing.

/** One market's state notifies once in this long. */
const QUIET_MS = 6 * 3_600_000;

export function usePumpWatchAlerts(venue: VenueId) {
  const alerts = useWatchAlerts();
  const on = alerts !== "off";
  const { rows, progress } = usePumpWatch(venue, on);
  /** Where each market stood at the last look, and when each state last notified. */
  const stood = useRef(new Map<string, string>());
  const sent = useRef(new Map<string, number>());
  const primed = useRef(false);

  // A new venue or a pause starts the noting afresh.
  // biome-ignore lint/correctness/useExhaustiveDependencies: `venue` and `on` reset it
  useEffect(() => {
    stood.current = new Map();
    primed.current = false;
  }, [venue, on]);

  useEffect(() => {
    if (!on) return;
    const now = Date.now();
    for (const row of rows) {
      const key = `${venue}:${row.market.id}`;
      const was = stood.current.get(key);
      stood.current.set(key, row.read.state);
      if (!primed.current || was === row.read.state) continue;
      if (alerts !== "all" && row.read.side !== alerts) continue;
      const sentKey = `${key}:${row.read.state}`;
      if (now - (sent.current.get(sentKey) ?? 0) < QUIET_MS) continue;
      sent.current.set(sentKey, now);
      notifyEvent({
        type: "alert",
        title: t("mapx.watch.alert", {
          symbol: row.market.symbol,
          state: t(`mapx.watch.state.${row.read.state}`),
        }),
        body: row.catalyst
          ? `${row.catalyst.source}: ${row.catalyst.title}`
          : t(`mapx.watch.why.${row.read.state}`),
        tone: row.read.side === "pump" ? "buy" : "sell",
        venue,
        market: row.market.id,
      });
    }
    // Once a whole round is in, what's new from here on is news.
    if (progress.total > 0 && progress.done >= progress.total) primed.current = true;
  }, [rows, progress, on, alerts, venue]);
}
