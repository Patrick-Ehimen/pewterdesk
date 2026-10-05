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

/**
 * A half-dial: the safe half on the left, the danger half on the right, and
 * a needle that swings from the left (0) to the right (1) with `ratio`. Decorative:
 * the value is read out beside it.
 */
function Gauge({ ratio }: { ratio: number }) {
  // Swings from 150 degrees (0) to 30 (1): clear of the dial's flat edge at
  // both ends, so the needle shows even at zero.
  const angle = (Math.PI / 180) * (150 - 120 * Math.min(1, Math.max(0, ratio)));
  const x = 10 + 7 * Math.cos(angle);
  const y = 10 - 7 * Math.sin(angle);
  return (
    <svg className="pd-gauge" viewBox="0 0 20 11" width={30} height={17} aria-hidden>
      <path className="pd-gauge-safe" d="M1 10 A9 9 0 0 1 10 1 L10 10 Z" />
      <path className="pd-gauge-danger" d="M10 1 A9 9 0 0 1 19 10 L10 10 Z" />
      <line className="pd-gauge-needle" x1="10" y1="10" x2={x.toFixed(2)} y2={y.toFixed(2)} />
      <circle className="pd-gauge-hub" cx="10" cy="10" r="2.2" />
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

/** The account panel: margin ratio, value, PnL, initial and maintenance margin, what's available, and leverage. */
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
            <Term label={t("account.initialMargin")} hint={t("account.initialMarginHint")} />
          </dt>
          <dd>
            {usd(totals?.marginUsed ?? 0)}
            <span className="pd-account-share">{formatPercent(totals?.marginRatio ?? 0)}</span>
          </dd>
        </div>
        <div>
          <dt>
            <Term label={t("account.maintenance")} hint={t("account.maintenanceHint")} />
          </dt>
          <dd>
            {usd(totals?.maintenanceMargin ?? 0)}
            <span className="pd-account-share">{formatPercent(ratio)}</span>
          </dd>
        </div>
        <div>
          <dt>
            <Term label={t("account.available")} hint={t("account.availableHint")} />
          </dt>
          <dd>{usd(totals?.available ?? 0)}</dd>
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
