import type { MarketStats, VenueId } from "@pewterdesk/core";
import { formatSigned, type MessageKey, t } from "@pewterdesk/ui";
import { useEffect, useState } from "react";
import { useFeedAge } from "../../hooks/useFeedAge";
import { countdown, type SessionId, sessionStates, untilText } from "../../lib/sessions";
import { ago } from "../ConnectionPanel";
import { BarPopover } from "./BarPopover";

/** The time now, re-read every second. */
function useNow() {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);
  return now;
}

/**
 * The open market's funding rate and the time to its next payment. If an
 * update is late, it keeps counting through later intervals rather than
 * sitting at zero (as the stats bar does).
 */
export function Funding({ stats, market }: { stats?: MarketStats; market?: string }) {
  const now = useNow();
  if (!stats) return null;
  const interval = stats.fundingIntervalSecs * 1000;
  let next = stats.nextFundingTime;
  while (interval > 0 && next <= now) next += interval;
  const rate = Number(stats.fundingRate) * 100;
  return (
    <span
      className="app-bar-info"
      title={t("bar.fundingHint", {
        market: market ?? "",
        hours: Math.round(stats.fundingIntervalSecs / 3600),
      })}
    >
      <span className="app-bar-info-label">{t("bar.funding")}</span>
      <span className="pd-num">{formatSigned(rate, 4)}%</span>
      <span className="app-bar-info-sep" aria-hidden>
        ·
      </span>
      <span className="pd-num">{countdown(next - now)}</span>
    </span>
  );
}

/** How far behind the venue's own timestamps the order book arrives. */
export function Latency({ venue }: { venue: VenueId }) {
  const { feed } = useFeedAge("book", venue);
  const lag = feed?.lagMs;
  return (
    <span
      className="app-bar-info"
      data-slow={lag !== undefined && lag > 1000 ? true : undefined}
      title={t("bar.latencyHint")}
    >
      <span className="app-bar-info-label">{t("bar.latency")}</span>
      <span className="pd-num">{lag === undefined ? "-" : ago(Math.max(0, lag))}</span>
    </span>
  );
}

const SESSION_LABEL: Record<SessionId, MessageKey> = {
  tokyo: "session.tokyo",
  london: "session.london",
  newYork: "session.newYork",
};

const time = (ms: number, timeZone?: string) =>
  new Intl.DateTimeFormat("en-GB", {
    timeZone,
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).format(ms);

/**
 * UTC time and which markets are open: crypto always, then whichever
 * stock-market sessions are, e.g. "Crypto · London · New York". Clicking
 * lists each with when it next opens or closes, and the local time.
 */
export function Clock() {
  const now = useNow();
  const states = sessionStates(now);
  const label = [
    t("session.crypto"),
    ...states.filter((s) => s.open).map((s) => t(SESSION_LABEL[s.id])),
  ].join(" · ");
  return (
    <BarPopover
      align="right"
      label={t("clock.title")}
      button={
        <>
          <span className="pd-num">{time(now, "UTC")} UTC</span>
          <span className="app-bar-session" data-open>
            {label}
          </span>
        </>
      }
    >
      {() => (
        <div className="clock-panel">
          <p className="conn-title">{t("clock.title")}</p>
          <ul className="clock-rows">
            <li data-open>
              <span className="conn-dot" aria-hidden />
              <span className="clock-name">{t("session.crypto")}</span>
              <span className="clock-state">{t("session.always")}</span>
            </li>
            {states.map((s) => (
              <li key={s.id} data-open={s.open || undefined}>
                <span className="conn-dot" aria-hidden />
                <span className="clock-name">{t(SESSION_LABEL[s.id])}</span>
                <span className="clock-state">
                  {t(s.open ? "session.open" : "session.closed", {
                    time: untilText(s.untilChange),
                  })}
                </span>
              </li>
            ))}
          </ul>
          <div className="clock-times">
            <span>
              {t("clock.utc")} <strong className="pd-num">{time(now, "UTC")}</strong>
            </span>
            <span>
              {t("clock.local")} <strong className="pd-num">{time(now)}</strong>
            </span>
          </div>
          <p className="conn-note">{t("clock.note")}</p>
        </div>
      )}
    </BarPopover>
  );
}
