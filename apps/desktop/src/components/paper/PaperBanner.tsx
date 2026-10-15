import type { AccountSnapshot } from "@pewterdesk/core";
import { formatNumber, formatSigned, t } from "@pewterdesk/ui";
import { LuFlaskConical } from "react-icons/lu";

interface PaperBannerProps {
  venue: string;
  /** The quote asset the account is in, e.g. "USDC". */
  quote: string;
  snapshot?: AccountSnapshot;
  /** What has been put in, for its P&L. */
  start: number;
  /** Opens the dialog to add or take out funds. */
  onFunds: () => void;
  /** Opens the reset confirmation. */
  onReset: () => void;
  onLive: () => void;
}

/**
 * The strip above the workspace in paper mode: that orders are simulated,
 * the paper account's equity and P&L, its funds, a reset, and the way back
 * to live.
 */
export function PaperBanner({
  venue,
  quote,
  snapshot,
  start,
  onFunds,
  onReset,
  onLive,
}: PaperBannerProps) {
  const equity = snapshot ? Number(snapshot.equity) : start;
  const pnl = equity - start;
  return (
    <div className="app-banner paper-banner" role="status">
      <LuFlaskConical className="app-banner-icon" size={16} aria-hidden />
      <p className="app-banner-text">
        <strong>{t("paper.bannerTitle", { venue })}</strong>
        <span>{t("paper.bannerText")}</span>
      </p>
      <dl className="paper-figures">
        <div>
          <dt>{t("paper.equity")}</dt>
          <dd className="pd-num">{`${formatNumber(equity, 2)} ${quote}`}</dd>
        </div>
        <div>
          <dt>{t("paper.pnl")}</dt>
          <dd className="pd-num" data-trend={pnl > 0 ? "up" : pnl < 0 ? "down" : undefined}>
            {`${formatSigned(pnl)} · ${formatSigned((pnl / (start || 1)) * 100)}%`}
          </dd>
        </div>
      </dl>
      <button type="button" className="rules-link" onClick={onFunds}>
        {t("paper.funds")}
      </button>
      <button type="button" className="rules-link" onClick={onReset}>
        {t("paper.reset")}
      </button>
      <button type="button" className="rules-link" onClick={onLive}>
        {t("paper.toLive")}
      </button>
    </div>
  );
}
