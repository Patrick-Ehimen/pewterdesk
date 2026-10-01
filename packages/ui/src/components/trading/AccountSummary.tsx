import type { AccountSnapshot } from "@pewterdesk/core";
import { t } from "../../i18n";
import { formatNumber, formatPercent, trendClass } from "../../lib/format";
import { Hint } from "../common/ColumnHeader";
import { Tooltip } from "../common/Tooltip";

export interface AccountTotals {
  equity: number;
  available: number;
  unrealizedPnl: number;
  marginUsed: number;
  /** Margin used over equity; 0 when there's no equity. */
  marginRatio: number;
  /** Size times mark, summed over positions. */
  notional: number;
  /** What the positions need to stay open; below it they're liquidated. */
  maintenanceMargin: number;
  /** Maintenance margin over equity: 100% is liquidation. 0 with no equity. */
  maintenanceRatio: number;
  /** Notional over equity; 0 with no equity. */
  leverage: number;
}

/**
 * Totals across the account's positions. Maintenance margin is taken as
 * half the initial margin at the market's maximum leverage (how Hyperliquid
 * sets it); without `maxLeverageFor`, or for a market it doesn't know, half
 * the position's margin stands in.
 */
export function accountTotals(
  snapshot: AccountSnapshot,
  maxLeverageFor?: (market: string) => number | undefined,
): AccountTotals {
  const equity = Number(snapshot.equity);
  let unrealizedPnl = 0;
  let marginUsed = 0;
  let notional = 0;
  let maintenanceMargin = 0;
  for (const p of snapshot.positions) {
    const value = Math.abs(Number(p.size) * Number(p.markPrice));
    const maxLeverage = maxLeverageFor?.(p.market);
    unrealizedPnl += Number(p.unrealizedPnl);
    marginUsed += Number(p.margin);
    notional += value;
    maintenanceMargin +=
      maxLeverage && maxLeverage > 0 ? value / (2 * maxLeverage) : Number(p.margin) / 2;
  }
  return {
    equity,
    available: Number(snapshot.availableMargin),
    unrealizedPnl,
    marginUsed,
    marginRatio: equity > 0 ? marginUsed / equity : 0,
    notional,
    maintenanceMargin,
    maintenanceRatio: equity > 0 ? maintenanceMargin / equity : 0,
    leverage: equity > 0 ? notional / equity : 0,
  };
}

/** How close the account is to liquidation, for the gauge's colour. */
export function ratioLevel(ratio: number): "safe" | "warn" | "danger" {
  if (ratio >= 0.8) return "danger";
  if (ratio >= 0.5) return "warn";
  return "safe";
}

/** A half-circle gauge filled to `ratio` (0-1). Decorative: the value is read out beside it. */
function Gauge({ ratio }: { ratio: number }) {
  const r = 8;
  const length = Math.PI * r;
  const filled = Math.min(1, Math.max(0, ratio)) * length;
  return (
    <svg className="pd-gauge" viewBox="0 0 20 11" width={24} height={13} aria-hidden>
      <path className="pd-gauge-track" d="M2 10 A8 8 0 0 1 18 10" />
      <path
        className="pd-gauge-fill"
        d="M2 10 A8 8 0 0 1 18 10"
        strokeDasharray={`${filled} ${length}`}
      />
    </svg>
  );
}

/** A row label with an explanation on hover. */
function Term({ label, hint }: { label: string; hint: string }) {
  return (
    <Tooltip className="pd-account-hint" content={<Hint title={label}>{hint}</Hint>}>
      {label}
    </Tooltip>
  );
}

interface AccountSummaryProps {
  /** Unset before a wallet is connected: every figure reads zero. */
  snapshot?: AccountSnapshot;
  /** Each market's maximum leverage, for the maintenance margin. */
  maxLeverageFor?: (market: string) => number | undefined;
}

/** The account panel: margin ratio, value, PnL, maintenance margin and leverage. */
export function AccountSummary({ snapshot, maxLeverageFor }: AccountSummaryProps) {
  const totals = snapshot ? accountTotals(snapshot, maxLeverageFor) : undefined;
  const ratio = totals?.maintenanceRatio ?? 0;
  const pnl = totals?.unrealizedPnl ?? 0;
  const usd = (v: number) => `${v < 0 ? "-" : ""}$${formatNumber(Math.abs(v), 2)}`;
  return (
    <section className="pd-account">
      <h3 className="pd-account-title">{t("account.summary")}</h3>
      <dl className="pd-account-rows">
        <div>
          <dt>
            <Term label={t("account.marginRatio")} hint={t("account.marginRatioHint")} />
          </dt>
          <dd className="pd-account-ratio" data-level={ratioLevel(ratio)}>
            <Gauge ratio={ratio} />
            {formatPercent(ratio)}
          </dd>
        </div>
        <div>
          <dt>{t("account.portfolioValue")}</dt>
          <dd>{usd(totals?.equity ?? 0)}</dd>
        </div>
        <div>
          <dt>{t("account.upnl")}</dt>
          <dd className={trendClass(pnl)}>{usd(pnl)}</dd>
        </div>
        <div>
          <dt>
            <Term label={t("account.maintenance")} hint={t("account.maintenanceHint")} />
          </dt>
          <dd>{usd(totals?.maintenanceMargin ?? 0)}</dd>
        </div>
        <div>
          <dt>
            <Term label={t("account.leverage")} hint={t("account.leverageHint")} />
          </dt>
          <dd>{formatNumber(totals?.leverage ?? 0, 2)}x</dd>
        </div>
      </dl>
    </section>
  );
}
