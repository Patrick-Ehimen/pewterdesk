import type { AccountSnapshot } from "@pewterdesk/core";
import { formatMoney, formatSignedMoney, t, useDisplayCurrency } from "@pewterdesk/ui";
import { LuHistory } from "react-icons/lu";

interface ReplayBannerProps {
  /** The quote asset of the market on screen, e.g. "USDT". */
  quote: string;
  snapshot?: AccountSnapshot;
  /** The balance when the session began, for its P&L. */
  sessionStart: number;
  /** Stepped back from the newest candle. */
  behind: boolean;
  /** Opens the funds dialog. */
  onFunds: () => void;
}

/** The strip above the workspace while a replay trades its own account. */
export function ReplayBanner({
  quote,
  snapshot,
  sessionStart,
  behind,
  onFunds,
}: ReplayBannerProps) {
  useDisplayCurrency();
  const equity = snapshot ? Number(snapshot.equity) : sessionStart;
  const pnl = equity - sessionStart;
  return (
    <div className="app-banner paper-banner" role="status">
      <LuHistory className="app-banner-icon" size={15} aria-hidden />
      <p className="app-banner-text">
        <strong>{t("replay.account")}</strong>
        <span>{behind ? t("replay.behind") : t("replay.accountText")}</span>
      </p>
      <dl className="paper-figures">
        <div>
          <dt>{t("replay.balance")}</dt>
          <dd className="pd-num">{formatMoney(equity, ` ${quote}`)}</dd>
        </div>
        <div>
          <dt>{t("replay.sessionPnl")}</dt>
          <dd className="pd-num" data-trend={pnl > 0 ? "up" : pnl < 0 ? "down" : undefined}>
            {formatSignedMoney(pnl, ` ${quote}`)}
          </dd>
        </div>
      </dl>
      <button type="button" className="rules-link" onClick={onFunds}>
        {t("paper.funds")}
      </button>
    </div>
  );
}
