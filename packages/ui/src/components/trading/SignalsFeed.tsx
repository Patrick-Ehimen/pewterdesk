import { dateFormat, type MessageKey, t } from "../../i18n";
import { formatNumber, formatSigned } from "../../lib/format";
import type { SignalEvent, SignalEventKind } from "../../lib/screener";

const LABEL: Record<SignalEventKind, MessageKey> = {
  overbought: "signal.overbought",
  oversold: "signal.oversold",
  fundingNegative: "signal.negativeFunding",
  fundingPositive: "signal.positiveFunding",
  oiSpike: "signal.oiSpike",
  breakout: "signal.breakout",
  volume: "signal.volume",
};

/** Buy-side (green), sell-side (red), or neutral tone for each kind. */
const TONE: Record<SignalEventKind, "up" | "down" | "warn" | "info"> = {
  overbought: "warn",
  oversold: "info",
  fundingNegative: "info",
  fundingPositive: "warn",
  oiSpike: "warn",
  breakout: "up",
  volume: "warn",
};

const TIME: Intl.DateTimeFormatOptions = { hour: "2-digit", minute: "2-digit", hour12: false };

function message(e: SignalEvent, name: string): string {
  switch (e.kind) {
    case "oiSpike":
      return t("event.oiSpike", {
        market: name,
        change: `${formatSigned((e.value ?? 0) * 100, 1)}%`,
      });
    case "breakout":
      return t("event.breakout", { market: name, price: formatNumber(e.value ?? 0) });
    case "volume":
      return t("event.volume", { market: name, ratio: formatNumber(e.value ?? 0, 1) });
    default:
      return t(`event.${e.kind}`, { market: name });
  }
}

/** Threshold crossings spotted while the app is open, newest first. */
export function SignalsFeed({
  events,
  nameOf,
}: {
  events: readonly SignalEvent[];
  /** Display name for a market id, e.g. "HYPE". */
  nameOf: (market: string) => string;
}) {
  return (
    <section className="pd-side-card pd-feed" aria-label={t("feed.title")}>
      <header className="pd-side-head">
        <h3>{t("feed.title")}</h3>
        <span className="pd-feed-live">
          <span className="pd-live-dot" data-live aria-hidden /> {t("feed.live")}
        </span>
      </header>
      {events.length === 0 ? (
        <p className="pd-muted">{t("feed.empty")}</p>
      ) : (
        <ol className="pd-feed-list">
          {events.map((e) => (
            <li key={e.id}>
              <time className="pd-muted">{dateFormat(TIME).format(e.time)}</time>
              <div>
                <p>{message(e, nameOf(e.market))}</p>
                <span className="pd-feed-kind" data-tone={TONE[e.kind]}>
                  {t(LABEL[e.kind])}
                </span>
              </div>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
