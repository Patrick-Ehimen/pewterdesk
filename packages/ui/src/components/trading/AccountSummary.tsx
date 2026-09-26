import type { AccountSnapshot } from "@pewterdesk/core";
import { t } from "../../i18n";
import { formatNumber, formatPercent, formatSigned, trendClass } from "../../lib/format";

export interface AccountTotals {
  equity: number;
  available: number;
  unrealizedPnl: number;
  marginUsed: number;
  /** Margin used over equity; 0 when there's no equity. */
  marginRatio: number;
}

export function accountTotals(snapshot: AccountSnapshot): AccountTotals {
  const equity = Number(snapshot.equity);
  let unrealizedPnl = 0;
  let marginUsed = 0;
  for (const p of snapshot.positions) {
    unrealizedPnl += Number(p.unrealizedPnl);
    marginUsed += Number(p.margin);
  }
  return {
    equity,
    available: Number(snapshot.availableMargin),
    unrealizedPnl,
    marginUsed,
    marginRatio: equity > 0 ? marginUsed / equity : 0,
  };
}

interface AccountSummaryProps {
  snapshot: AccountSnapshot;
  /** Quote asset the balances are in, e.g. "USDC". */
  quote: string;
}

export function AccountSummary({ snapshot, quote }: AccountSummaryProps) {
  const totals = accountTotals(snapshot);
  return (
    <dl className="pd-account">
      <div className="pd-account-equity">
        <dt>{t("account.equity")}</dt>
        <dd>
          {formatNumber(totals.equity, 2)} <span className="pd-muted">{quote}</span>
        </dd>
      </div>
      <div>
        <dt>{t("account.upnl")}</dt>
        <dd className={trendClass(totals.unrealizedPnl)}>{formatSigned(totals.unrealizedPnl)}</dd>
      </div>
      <div>
        <dt>{t("account.marginUsed")}</dt>
        <dd>{formatNumber(totals.marginUsed, 2)}</dd>
      </div>
      <div>
        <dt>{t("account.available")}</dt>
        <dd>{formatNumber(totals.available, 2)}</dd>
      </div>
      <div>
        <dt>{t("account.marginRatio")}</dt>
        <dd>{formatPercent(totals.marginRatio)}</dd>
      </div>
      {/* Decorative: the ratio is already read out as text just above. */}
      <div className="pd-meter" aria-hidden>
        <div style={{ width: `${Math.min(totals.marginRatio, 1) * 100}%` }} />
      </div>
    </dl>
  );
}
