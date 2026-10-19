import type { AccountSnapshot } from "@pewterdesk/core";
import { formatSigned, t } from "@pewterdesk/ui";
import { LuFlaskConical } from "react-icons/lu";

interface PaperBannerProps {
  venue: string;
  /** The quote asset the account is in, e.g. "USDC". */
  quote: string;
  snapshot?: AccountSnapshot;
  /** What has been put in, for its P&L. */
  start: number;
  /** Puts the Paper panel in the layout; unset while it's there. */
  onShowPanel?: () => void;
  /** Opens the funds dialog. */
  onFunds: () => void;
  onLive: () => void;
}

/**
 * The slim strip above the workspace in paper mode: that orders are
 * simulated, the account's P&L, and the way back to live. The account
 * itself - figures, journal, funds and reset - is the Paper panel's;
 * Funds is here too, always to hand.
 */
export function PaperBanner({
  venue,
  quote,
  snapshot,
  start,
  onShowPanel,
  onFunds,
  onLive,
}: PaperBannerProps) {
  const pnl = (snapshot ? Number(snapshot.equity) : start) - start;
  return (
    <div className="app-banner paper-banner" role="status">
      <LuFlaskConical className="app-banner-icon" size={15} aria-hidden />
      <p className="app-banner-text">
        <strong>{t("paper.bannerTitle", { venue })}</strong>
        <span>{t("paper.bannerText")}</span>
      </p>
      <dl className="paper-figures">
        <div>
          <dt>{t("paper.pnl")}</dt>
          <dd className="pd-num" data-trend={pnl > 0 ? "up" : pnl < 0 ? "down" : undefined}>
            {`${formatSigned(pnl)} ${quote} · ${formatSigned((pnl / (start || 1)) * 100)}%`}
          </dd>
        </div>
      </dl>
      <button type="button" className="rules-link" onClick={onFunds}>
        {t("paper.funds")}
      </button>
      {onShowPanel && (
        <button type="button" className="rules-link" onClick={onShowPanel}>
          {t("paperPanel.show")}
        </button>
      )}
      <button type="button" className="rules-link" onClick={onLive}>
        {t("paper.toLive")}
      </button>
    </div>
  );
}
