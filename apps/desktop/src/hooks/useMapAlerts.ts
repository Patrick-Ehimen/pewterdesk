import type { Market, VenueId } from "@pewterdesk/core";
import {
  BAND_FRAME_HOURS,
  BAND_FRAMES,
  type BandFrame,
  bandRead,
  confluenceRead,
  formatNumber,
  squeezeRead,
  t,
} from "@pewterdesk/ui";
import { useEffect, useMemo, useRef } from "react";
import { anyMapAlert, useMapAlerts, wantsSide } from "../lib/mapAlerts";
import { notifyEvent } from "../lib/notifications";
import { useMarketHistories } from "./useMapData";
import { useMarketSummaries } from "./useVenueFeeds";

// The Maps page's Bollinger alerts: while the app runs and any is on, every
// market's hourly history is kept fresh for the venue on screen (the stream
// the Maps views read, a full pass every few minutes) and a market that has
// just entered a state says so through `notifyEvent` - in the app, and on the
// desktop when the app isn't in front. A market's first read only notes where
// it stands, so nothing fires for a state it was already in. Read-only: it
// places nothing.

/** One market's state notifies once in this long. */
const QUIET_MS = 6 * 3_600_000;
/** Bands this tight against their own week (the tightest 5%): a squeeze. */
export const ALERT_SQUEEZE_RANK = 0.05;

/** The band interval the Maps views show (`pd.maps.bandFrame`), read fresh each round. */
function bandFrame(): BandFrame {
  try {
    const saved = JSON.parse(localStorage.getItem("pd.maps.bandFrame") ?? "null");
    return BAND_FRAMES.find((f) => f === saved) ?? "1h";
  } catch {
    return "1h";
  }
}

type Kind = "squeeze" | "bandUpper" | "bandLower" | "rsiUpper" | "rsiLower";

export function useMapAlertWatch(venue: VenueId, markets: readonly Market[]) {
  const alerts = useMapAlerts();
  const on = anyMapAlert(alerts);
  const histories = useMarketHistories(venue, on);
  const feed = useMarketSummaries(venue, on);
  const summaries = feed.status === "live" || feed.status === "closed" ? feed.data : undefined;
  const priceOf = useMemo(
    () => new Map((summaries ?? []).map((s) => [s.market, Number(s.markPrice)])),
    [summaries],
  );
  const symbolOf = useMemo(() => new Map(markets.map((m) => [m.id, m.symbol])), [markets]);
  /** Where each market and kind last stood, and when each last notified. */
  const stood = useRef(new Map<string, boolean>());
  const sent = useRef(new Map<string, number>());

  // A new venue, or turning them on, starts the noting afresh.
  // biome-ignore lint/correctness/useExhaustiveDependencies: `venue` and `on` reset it
  useEffect(() => {
    stood.current = new Map();
  }, [venue, on]);

  useEffect(() => {
    if (!on) return;
    const frame = bandFrame();
    const hours = BAND_FRAME_HOURS[frame];
    const now = Date.now();
    const fire = (market: string, kind: Kind, inState: boolean, body: () => string) => {
      const key = `${venue}:${market}:${kind}`;
      const was = stood.current.get(key);
      stood.current.set(key, inState);
      // The first read only notes; a state notifies on the way in.
      if (was === undefined || was || !inState) return;
      if (now - (sent.current.get(key) ?? 0) < QUIET_MS) return;
      sent.current.set(key, now);
      const symbol = symbolOf.get(market) ?? market;
      notifyEvent({
        type: "alert",
        title: t(`mapx.alert.${kind}`, { symbol, frame }),
        body: body(),
        tone:
          kind === "bandUpper" || kind === "rsiLower"
            ? "buy"
            : kind === "squeeze"
              ? "neutral"
              : "sell",
        venue,
        market,
      });
    };

    for (const [market, history] of histories) {
      const price = priceOf.get(market);
      if (!price || !(price > 0)) continue;
      const candles = history.candles;
      if (alerts.squeeze !== "off") {
        const s = squeezeRead(candles);
        if (s)
          fire(market, "squeeze", s.rank <= ALERT_SQUEEZE_RANK, () =>
            t("mapx.alert.squeezeBody", { width: formatNumber(s.bandwidth * 100, 2) }),
          );
      }
      if (alerts.bands !== "off") {
        const b = bandRead(candles, price, hours);
        if (b) {
          const body = () => t("mapx.alert.bandBody", { pb: formatNumber(b.percentB * 100, 0) });
          if (wantsSide(alerts.bands, "upper"))
            fire(market, "bandUpper", b.zone === "aboveUpper", body);
          if (wantsSide(alerts.bands, "lower"))
            fire(market, "bandLower", b.zone === "belowLower", body);
        }
      }
      if (alerts.rsiBands !== "off") {
        const c = confluenceRead(candles, price, hours);
        if (c) {
          const body = () => t("mapx.alert.rsiBody", { rsi: formatNumber(c.rsi, 0) });
          if (wantsSide(alerts.rsiBands, "upper"))
            fire(market, "rsiUpper", c.side === "upper", body);
          if (wantsSide(alerts.rsiBands, "lower"))
            fire(market, "rsiLower", c.side === "lower", body);
        }
      }
    }
  }, [histories, priceOf, symbolOf, alerts, on, venue]);
}
