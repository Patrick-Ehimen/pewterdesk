import type { AccountSnapshot, ClosedTrade } from "@pewterdesk/core";
import {
  ClosedTradesTable,
  EmptyState,
  FundingHistoryTable,
  formatNumber,
  formatPercent,
  formatSigned,
  type SymbolFor,
  Tabs,
  TradeHistoryTable,
  t,
  trendClass,
} from "@pewterdesk/ui";
import { useEffect, useId, useMemo, useState } from "react";
import { LuFlaskConical } from "react-icons/lu";
import type { PaperState } from "../../lib/paper";
import { paperOverview } from "../../lib/paperOverview";
import { curvePath } from "../../lib/performance";

// The paper account as a workspace panel: what it's worth and made, its
// realized P&L over time, how its trades went, and every fill, close and
// funding payment, with its funds and reset. It reads the paper state only;
// it places nothing, and nothing in it reaches a venue.

const CHART_W = 400;
const CHART_H = 90;
const TABS = ["fills", "closed", "funding"] as const;
type Tab = (typeof TABS)[number];

interface PaperPanelProps {
  /** The venue's display name, e.g. "Hyperliquid". */
  venue: string;
  /** The venue has paper trading (Hyperliquid and Aster; Bybit has demo accounts). */
  available: boolean;
  /** Paper mode is on for the venue on screen. */
  on: boolean;
  state: PaperState;
  snapshot?: AccountSnapshot;
  quote: string;
  symbolFor: SymbolFor;
  quoteFor: (market: string) => string;
  baseFor: (market: string) => string;
  onShare?: (trade: ClosedTrade) => void;
  onFunds: () => void;
  onReset: () => void;
  onPaper: (on: boolean) => void;
}

function Figure({ label, value, tone }: { label: string; value: string; tone?: string }) {
  return (
    <div className="paper-panel-figure">
      <dt>{label}</dt>
      <dd className={`pd-num ${tone ?? ""}`}>{value}</dd>
    </div>
  );
}

export function PaperPanel({
  venue,
  available,
  on,
  state,
  snapshot,
  quote,
  symbolFor,
  quoteFor,
  baseFor,
  onShare,
  onFunds,
  onReset,
  onPaper,
}: PaperPanelProps) {
  const [tab, setTab] = useState<Tab>("fills");
  const fillId = useId();
  // The curve runs to now; a minute at a time is plenty.
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(id);
  }, []);
  const o = useMemo(() => paperOverview(state, snapshot, now), [state, snapshot, now]);
  const chart = useMemo(() => curvePath(o.curve, CHART_W, CHART_H), [o.curve]);

  if (!available) {
    return <EmptyState>{t("paperPanel.unavailable", { venue })}</EmptyState>;
  }
  if (!on) {
    return (
      <div className="paper-panel-off">
        <LuFlaskConical size={22} aria-hidden />
        <p>{t("paperPanel.off", { venue })}</p>
        <button
          type="button"
          className="settings-button"
          data-primary
          onClick={() => onPaper(true)}
        >
          {t("paperPanel.turnOn")}
        </button>
      </div>
    );
  }

  const money = (v: number) => `${formatSigned(v)} ${quote}`;
  const c = o.closes;
  return (
    <div className="paper-panel">
      <header className="paper-panel-head">
        <span className="paper-panel-badge">
          <LuFlaskConical size={13} aria-hidden />
          {t("paper.badge")}
        </span>
        <span className="paper-panel-venue">{venue}</span>
        <span className="paper-panel-actions">
          <button type="button" className="rules-link" onClick={onFunds}>
            {t("paper.funds")}
          </button>
          <button type="button" className="rules-link" onClick={onReset}>
            {t("paper.reset")}
          </button>
          <button type="button" className="rules-link" onClick={() => onPaper(false)}>
            {t("paper.toLive")}
          </button>
        </span>
      </header>

      <div className="paper-panel-top">
        <div className="paper-panel-lead">
          <span className="paper-panel-label">{t("paper.equity")}</span>
          <strong className="pd-num paper-panel-big">
            {formatNumber(o.equity, 2)} <small>{quote}</small>
          </strong>
          <span className={`pd-num ${trendClass(o.pnl)}`}>
            {money(o.pnl)} · {formatSigned(o.pnlPct)}%
          </span>
        </div>
        <dl className="paper-panel-figures">
          <Figure
            label={t("account.upnl")}
            value={formatSigned(o.unrealized)}
            tone={trendClass(o.unrealized)}
          />
          <Figure label={t("account.available")} value={formatNumber(o.available, 2)} />
          <Figure label={t("account.marginUsed")} value={formatNumber(o.marginUsed, 2)} />
          <Figure label={t("paperPanel.fees")} value={formatNumber(o.fees, 2)} />
          <Figure
            label={t("paperPanel.funding")}
            value={formatSigned(o.funding)}
            tone={trendClass(o.funding)}
          />
          <Figure label={t("paperPanel.positions")} value={String(o.openPositions)} />
        </dl>
      </div>

      <div className="paper-panel-curve">
        <span className="paper-panel-label">{t("col.rpnl")}</span>
        {chart && c.trades > 0 ? (
          <svg
            className="pf-chart paper-panel-chart"
            viewBox={`0 0 ${CHART_W} ${CHART_H}`}
            preserveAspectRatio="none"
            data-trend={c.realized >= 0 ? "up" : "down"}
            role="img"
            aria-label={`${t("col.rpnl")}: ${money(c.realized)}`}
          >
            <defs>
              <linearGradient id={fillId} x1="0" x2="0" y1="0" y2="1">
                <stop className="pf-chart-stop" offset="0" stopOpacity="0.32" />
                <stop className="pf-chart-stop" offset="1" stopOpacity="0.02" />
              </linearGradient>
            </defs>
            <path d={chart.area} fill={`url(#${fillId})`} />
            <line className="pf-chart-zero" x1="0" x2={CHART_W} y1={chart.zero} y2={chart.zero} />
            <path className="pf-chart-line" d={chart.line} />
          </svg>
        ) : (
          <p className="paper-panel-empty">{t("paperPanel.noCloses")}</p>
        )}
      </div>

      <dl className="paper-panel-stats">
        <Figure label={t("paperPanel.trades")} value={String(c.trades)} />
        <Figure label={t("portfolio.winRate")} value={formatPercent(c.winRate, 0)} />
        <Figure
          label={t("portfolio.best")}
          value={formatSigned(c.best)}
          tone={trendClass(c.best)}
        />
        <Figure
          label={t("portfolio.worst")}
          value={formatSigned(c.worst)}
          tone={trendClass(c.worst)}
        />
        <Figure
          label={t("paperPanel.avgWin")}
          value={formatSigned(c.avgWin)}
          tone={trendClass(c.avgWin)}
        />
        <Figure
          label={t("paperPanel.avgLoss")}
          value={formatSigned(c.avgLoss)}
          tone={trendClass(c.avgLoss)}
        />
      </dl>

      <Tabs
        variant="sub"
        label={t("paperPanel.journal")}
        active={tab}
        onChange={setTab}
        tabs={[
          { id: "fills", label: `${t("paperPanel.tabFills")} (${state.fills.length})` },
          { id: "closed", label: `${t("tab.closedPnl")} (${state.closed.length})` },
          { id: "funding", label: `${t("paperPanel.funding")} (${state.funding.length})` },
        ]}
      />
      <div className="paper-panel-table app-scroll">
        {tab === "fills" ? (
          <TradeHistoryTable fills={state.fills} symbolFor={symbolFor} />
        ) : tab === "closed" ? (
          <ClosedTradesTable
            trades={state.closed}
            symbolFor={symbolFor}
            baseFor={baseFor}
            quoteFor={quoteFor}
            onShare={onShare}
          />
        ) : (
          <FundingHistoryTable payments={state.funding} symbolFor={symbolFor} />
        )}
      </div>
    </div>
  );
}
