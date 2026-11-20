import type { Market } from "@pewterdesk/core";
import { t } from "@pewterdesk/ui";
import { LuArrowRight, LuClock } from "react-icons/lu";

/**
 * In place of the price chart while the venue has stopped trading the market
 * (Bybit's contract adjustments): there are no candles worth drawing, only
 * that it's halted and where the venue says why.
 */
export function HaltedChart({
  market,
  venueName,
  onAnnouncements,
}: {
  market: Market;
  venueName: string;
  /** Opens the venue's announcements, where it explains the halt. */
  onAnnouncements?: () => void;
}) {
  return (
    <div className="halted-chart" role="status">
      <LuClock size={64} strokeWidth={1.5} className="halted-chart-icon" aria-hidden />
      <h3>{t("chart.haltedTitle")}</h3>
      <p>{t("chart.haltedBody", { symbol: market.symbol, venue: venueName })}</p>
      {onAnnouncements && (
        <button type="button" className="halted-chart-link" onClick={onAnnouncements}>
          {t("chart.haltedAnnouncements")}
          <LuArrowRight size={14} aria-hidden />
        </button>
      )}
    </div>
  );
}
