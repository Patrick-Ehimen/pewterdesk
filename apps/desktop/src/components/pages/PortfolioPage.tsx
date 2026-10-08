import type { AccountSnapshot, ClosedTrade, Market } from "@pewterdesk/core";
import {
  ClosedTradesTable,
  dateFormat,
  EmptyState,
  formatNumber,
  formatPercent,
  formatSigned,
  SummarySkeleton,
  TableSkeleton,
  TokenIcon,
  Tooltip,
  t,
  trendClass,
} from "@pewterdesk/ui";
import { useEffect, useMemo, useState } from "react";
import { LuCalendarDays, LuCircleDollarSign, LuClock } from "react-icons/lu";
import { useStoredChoice } from "../../hooks/useStoredChoice";
import type { Feed } from "../../hooks/useVenueFeeds";
import { type Edge, edge, extremes, type Group, RETURN_EDGES } from "../../lib/edge";
import {
  BUCKETS,
  type Bucket,
  type CurveDot,
  closedSince,
  curvePath,
  HISTORY_MS,
  nearestDot,
  performance,
  pnlCurve,
  RANGE_MS,
  RANGES,
  type Range,
} from "../../lib/performance";
import { portfolioSummary } from "../../lib/portfolio";
import { EdgeBreakdown, HOLD_LABEL, SIZE_LABEL } from "./EdgeBreakdown";
import { PnlCalendar } from "./PnlCalendar";

const CHART_W = 600;
const CHART_H = 220;
const TIP_TIME: Intl.DateTimeFormatOptions = {
  month: "short",
  day: "numeric",
  hour: "2-digit",
  minute: "2-digit",
};
const VIEWS = ["realized", "edge"] as const;
type View = (typeof VIEWS)[number];
const TABS = ["open", "history"] as const;
type Tab = (typeof TABS)[number];

const BUCKET_LABEL = {
  over500: "portfolio.bucket.over500",
  over200: "portfolio.bucket.over200",
  gain: "portfolio.bucket.gain",
  loss: "portfolio.bucket.loss",
  under50: "portfolio.bucket.under50",
} as const satisfies Record<Bucket, string>;

interface PortfolioPageProps {
  account: Feed<AccountSnapshot>;
  /** The account's closed positions over the last `HISTORY_MS`. */
  closed: Feed<ClosedTrade[]>;
  markets: Market[];
  /** The venue's display name, e.g. "Hyperliquid". */
  venue: string;
  /** How the venue connects, which the empty state names. */
  connectAuth: "wallet" | "apiKey";
  onConnect: () => void;
  onShare?: (trade: ClosedTrade) => void;
}

/**
 * One of a pair of cards: the group that did best, or worst. Hovering says
 * how many trades it is and what a typical one made; clicking opens every
 * group side by side.
 */
function EdgeCard({
  group,
  name,
  label,
  onOpen,
}: {
  group?: Group;
  name?: string;
  label: string;
  onOpen: () => void;
}) {
  const body = (
    <>
      <strong className="pd-num">
        {group ? (
          <>
            {name}{" "}
            <span className={trendClass(group.medianReturn)}>
              {formatSigned(group.medianReturn, 1)}%
            </span>
          </>
        ) : (
          "-"
        )}
      </strong>
      <span className="pf-label">{label}</span>
    </>
  );
  if (!group) {
    return (
      <button type="button" className="pf-edge-card" onClick={onOpen}>
        {body}
      </button>
    );
  }
  return (
    <Tooltip
      className="pf-edge-card"
      onClick={onOpen}
      content={
        <dl className="pf-tip-rows">
          <dt>{t("tab.trades")}</dt>
          <dd className="pd-num">{group.trades}</dd>
          <dt>{t("edge.medianPnl")}</dt>
          <dd className={`pd-num ${trendClass(group.medianReturn)}`}>
            {formatSigned(group.medianReturn, 1)}%
          </dd>
          <dt>{t("portfolio.winRate")}</dt>
          <dd className="pd-num">{formatPercent(group.winRate, 0)}</dd>
        </dl>
      }
    >
      <span className="pf-edge-card-in" data-trend={trendClass(group.medianReturn)}>
        {body}
      </span>
    </Tooltip>
  );
}

/** A figure that may not be measurable yet. */
const maybe = (v: number | undefined, show: (v: number) => string) =>
  v === undefined || !Number.isFinite(v) ? "-" : show(v);

/** The return histogram: one bar per range, losses red, gains green. */
function ReturnBars({ counts }: { counts: number[] }) {
  const most = Math.max(1, ...counts);
  return (
    <div className="pf-bars-wrap">
      <div className="pf-bars" aria-hidden>
        {counts.map((count, i) => (
          <span
            key={RETURN_EDGES[i]}
            className="pf-bar"
            data-side={(RETURN_EDGES[i] ?? 0) < 0 ? "down" : "up"}
            data-empty={count === 0 || undefined}
            title={`${RETURN_EDGES[i]}%+ · ${count}`}
            style={{ height: `${count === 0 ? 2 : Math.max(8, (count / most) * 100)}%` }}
          />
        ))}
      </div>
      <div className="pf-bars-axis" aria-hidden>
        <span>-100%</span>
        {/* Where the bars turn from losses to gains, not the middle. */}
        <span
          className="pf-bars-zero"
          style={{
            left: `${(RETURN_EDGES.filter((e) => e < 0).length / RETURN_EDGES.length) * 100}%`,
          }}
        >
          0%
        </span>
        <span>+500%</span>
      </div>
    </div>
  );
}

function Stat({ label, value, tone }: { label: string; value: string; tone?: string }) {
  return (
    <div className="pf-stat">
      <span className="pf-label">{label}</span>
      <strong className={`pd-num pf-value ${tone ?? ""}`}>{value}</strong>
    </div>
  );
}

/**
 * The connected account: what it's worth and holds now, and how its closed
 * positions have gone - the realized PnL over time, how the trades went,
 * and each day's result in the PnL calendar. One venue at a time; the
 * history is whatever that venue serves (Bybit's, so far).
 */
export function PortfolioPage({
  account,
  closed,
  markets,
  venue,
  connectAuth,
  onConnect,
  onShare,
}: PortfolioPageProps) {
  const quote = markets[0]?.quote ?? "USDC";
  const marketOf = (id: string) => markets.find((m) => m.id === id);
  const baseOf = (id: string) => marketOf(id)?.base ?? id;
  const [range, setRange] = useStoredChoice<Range>("pd.portfolio.range", RANGES, "30d");
  const [tab, setTab] = useState<Tab>("open");
  const [view, setView] = useStoredChoice<View>("pd.portfolio.view", VIEWS, "realized");
  const [calendarOpen, setCalendarOpen] = useState(false);
  const [breakdownOpen, setBreakdownOpen] = useState(false);
  // The point of the chart under the pointer.
  const [hovered, setHovered] = useState<CurveDot>();
  // The windows move with the clock, a minute at a time.
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(id);
  }, []);

  const trades = closed.status === "live" || closed.status === "closed" ? closed.data : undefined;
  const since = now - RANGE_MS[range];
  const perf = useMemo(() => performance(trades ?? [], since), [trades, since]);
  const chart = useMemo(
    () => curvePath(pnlCurve(trades ?? [], since, now), CHART_W, CHART_H),
    [trades, since, now],
  );
  const edges: Edge = useMemo(() => edge(trades ?? [], since), [trades, since]);
  const inRange = useMemo(() => closedSince(trades ?? [], since).reverse(), [trades, since]);
  const money = (v: number) => `${formatSigned(v)} ${quote}`;

  if (account.status === "idle") {
    return (
      <div className="page">
        <header className="page-head">
          <h1>{t("nav.portfolio")}</h1>
          <span>{t("portfolio.subtitle")}</span>
        </header>
        <div className="page-empty">
          <p>
            {connectAuth === "apiKey"
              ? t("portfolio.emptyApiKey", { venue })
              : t("portfolio.empty")}
          </p>
          <button type="button" className="settings-button" data-primary onClick={onConnect}>
            {t(connectAuth === "apiKey" ? "apiKey.connect" : "wallet.connect")}
          </button>
        </div>
      </div>
    );
  }

  const snapshot =
    account.status === "live" || account.status === "closed" ? account.data : undefined;
  const s = snapshot && portfolioSummary(snapshot);
  const bias = !s
    ? ""
    : Math.abs(s.net) < 0.005
      ? t("portfolio.netFlat")
      : t(s.net > 0 ? "portfolio.netLong" : "portfolio.netShort");
  // Why there's no history, where there isn't one to draw.
  const noHistory =
    closed.status === "error" ? (
      <EmptyState>{t("portfolio.noSource", { venue })}</EmptyState>
    ) : trades === undefined ? undefined : null;
  const decided = perf.wins + perf.losses;

  const holds = extremes(edges.holds);
  const sizes = extremes(edges.sizes);
  const holdName = (g?: Group) => (g ? t(HOLD_LABEL[g.id] ?? "edge.hold.under1m") : undefined);
  const sizeName = (g?: Group) =>
    g ? `${t(SIZE_LABEL[g.id] ?? "edge.size.under100")} ${quote}` : undefined;
  const openBreakdown = () => setBreakdownOpen(true);
  const verdict =
    edges.expectancy > 0
      ? "edge.verdict.up"
      : edges.expectancy < 0
        ? "edge.verdict.down"
        : "edge.verdict.flat";
  const edgeTop = (
    <div className="pf-top">
      <section className="page-panel pf-panel" aria-labelledby="pf-edge">
        <h2 className="pf-title" id="pf-edge">
          {t("edge.title")}
        </h2>
        {noHistory ??
          (trades === undefined ? (
            <SummarySkeleton rows={7} />
          ) : (
            <>
              <p className="pf-edge-lead">
                <strong className={`pd-num pf-big ${trendClass(edges.expectancy)}`}>
                  {money(edges.expectancy)}
                </strong>
                <span className="pf-label">{t("edge.perTrade")}</span>
                <span className={trendClass(edges.expectancy)}>{t(verdict)}</span>
              </p>
              <div className="pf-stats">
                <span className="pf-group">{t("edge.style")}</span>
                <Stat
                  label={t("edge.profitFactor")}
                  value={maybe(edges.profitFactor, (v) => `${formatNumber(v, 2)}x`)}
                  tone={edges.profitFactor === undefined ? "" : trendClass(edges.profitFactor - 1)}
                />
                <Stat label={t("portfolio.winRate")} value={formatPercent(edges.winRate, 1)} />
                <Stat
                  label={t("edge.payoff")}
                  value={maybe(edges.payoff, (v) => `${formatNumber(v, 2)}x`)}
                />
              </div>
              <div className="pf-stats">
                <span className="pf-group">{t("edge.risk")}</span>
                <Stat
                  label={t("edge.var")}
                  value={maybe(edges.var95, (v) => `${formatSigned(v, 1)}%`)}
                  tone={trendClass(edges.var95 ?? 0)}
                />
                <Stat
                  label={t("edge.cvar")}
                  value={maybe(edges.cvar95, (v) => `${formatSigned(v, 1)}%`)}
                  tone={trendClass(edges.cvar95 ?? 0)}
                />
                <Stat
                  label={t("edge.drawdown")}
                  value={money(edges.maxDrawdown)}
                  tone={trendClass(edges.maxDrawdown)}
                />
              </div>
            </>
          ))}
      </section>

      <section className="page-panel pf-panel pf-curve" aria-labelledby="pf-edge-groups">
        <header className="pf-curve-head">
          <h2 className="pd-visually-hidden" id="pf-edge-groups">
            {t("portfolio.edge")}
          </h2>
          <div className="pf-views" role="tablist" aria-label={t("portfolio.view")}>
            {VIEWS.map((v) => (
              <button
                key={v}
                type="button"
                role="tab"
                aria-selected={view === v}
                className="pf-view"
                onClick={() => setView(v)}
              >
                {t(v === "realized" ? "col.rpnl" : "portfolio.edge")}
              </button>
            ))}
          </div>
        </header>
        {noHistory ??
          (trades === undefined ? (
            <div className="pd-skel pf-chart" />
          ) : edges.trades === 0 ? (
            <EmptyState>{t("portfolio.noHistory", { range })}</EmptyState>
          ) : (
            <div className="pf-edge-groups">
              <h3 className="pf-group pf-group-icon">
                <LuClock size={14} aria-hidden />
                {t("edge.hold")}
              </h3>
              <div className="pf-edge-pair">
                <EdgeCard
                  group={holds.best}
                  name={holdName(holds.best)}
                  label={t("edge.bestHold")}
                  onOpen={openBreakdown}
                />
                <EdgeCard
                  group={holds.worst}
                  name={holdName(holds.worst)}
                  label={t("edge.worstHold")}
                  onOpen={openBreakdown}
                />
              </div>
              <h3 className="pf-group pf-group-icon">
                <LuCircleDollarSign size={14} aria-hidden />
                {t("edge.amount")}
              </h3>
              <div className="pf-edge-pair">
                <EdgeCard
                  group={sizes.best}
                  name={sizeName(sizes.best)}
                  label={t("edge.bestSize")}
                  onOpen={openBreakdown}
                />
                <EdgeCard
                  group={sizes.worst}
                  name={sizeName(sizes.worst)}
                  label={t("edge.worstSize")}
                  onOpen={openBreakdown}
                />
              </div>
            </div>
          ))}
        <p className="pf-note">{t("edge.note")}</p>
      </section>

      <section className="page-panel pf-panel" aria-labelledby="pf-tilt">
        <h2 className="pf-title" id="pf-tilt">
          {t("edge.tilt")}
        </h2>
        {noHistory ??
          (trades === undefined ? (
            <SummarySkeleton rows={6} />
          ) : (
            <>
              <div className="pf-trio">
                <div className="pf-trio-cell">
                  <strong className="pd-num">{edges.revenge}</strong>
                  <span className="pf-label">{t("edge.revenge")}</span>
                </div>
                <div className="pf-trio-cell">
                  <strong className="pd-num">
                    {maybe(edges.afterLossWinRate, (v) => formatPercent(v, 0))}
                  </strong>
                  <span className="pf-label">{t("edge.afterLoss")}</span>
                </div>
                <div className="pf-trio-cell">
                  <strong className="pd-num">
                    <span className="pd-up">{edges.winStreak}W</span> /{" "}
                    <span className="pd-down">{edges.lossStreak}L</span>
                  </strong>
                  <span className="pf-label">{t("edge.streaks")}</span>
                </div>
              </div>
              <div className="pf-stats">
                <Stat
                  label={t("edge.streakiness")}
                  value={maybe(edges.streakiness, (v) => formatNumber(v, 2))}
                />
                <Stat
                  label={t("edge.tiltRatio")}
                  value={maybe(edges.tiltRatio, (v) => `${formatNumber(v, 2)}x`)}
                  tone={edges.tiltRatio !== undefined && edges.tiltRatio > 1.25 ? "pd-down" : ""}
                />
                <Stat
                  label={t("edge.martingale")}
                  value={maybe(edges.martingale, (v) => formatNumber(v, 2))}
                />
              </div>
              <ReturnBars counts={edges.histogram} />
            </>
          ))}
      </section>
    </div>
  );

  return (
    <div className="page pf">
      <header className="page-head pf-head">
        <h1>{t("nav.portfolio")}</h1>
        <span>{venue}</span>
        <div className="pf-ranges" role="radiogroup" aria-label={t("portfolio.range")}>
          {RANGES.map((r) => (
            // biome-ignore lint/a11y/useSemanticElements: a segmented choice, like the app's others
            <button
              key={r}
              type="button"
              role="radio"
              aria-checked={range === r}
              className="pf-range"
              onClick={() => setRange(r)}
            >
              {r}
            </button>
          ))}
        </div>
        <button
          type="button"
          className="pf-cal-open"
          disabled={!trades}
          onClick={() => setCalendarOpen(true)}
        >
          <LuCalendarDays size={15} aria-hidden />
          {t("portfolio.calendar")}
        </button>
      </header>

      {account.status === "closed" && (
        <p className="pd-stale" role="status">
          {t("feed.closed")}
        </p>
      )}
      {account.status === "error" && <EmptyState error>{account.message}</EmptyState>}

      {view === "edge" ? (
        edgeTop
      ) : (
        <div className="pf-top">
          <section className="page-panel pf-panel" aria-labelledby="pf-balance">
            <h2 className="pf-title" id="pf-balance">
              {t("portfolio.balance")}
            </h2>
            {s ? (
              <>
                <div className="pf-figure">
                  <span className="pf-label">{t("portfolio.totalValue")}</span>
                  <strong className="pd-num pf-big">
                    {formatNumber(s.equity, 2)} {quote}
                  </strong>
                </div>
                <div className="pf-figure">
                  <span className="pf-label">{t("account.upnl")}</span>
                  <strong className={`pd-num pf-big ${trendClass(s.unrealizedPnl)}`}>
                    {money(s.unrealizedPnl)}
                  </strong>
                </div>
                <div className="pf-stats">
                  <Stat
                    label={t("account.available")}
                    value={formatNumber(Number(snapshot?.availableMargin ?? 0), 2)}
                  />
                  <Stat
                    label={t("account.marginUsed")}
                    value={`${formatNumber(s.marginUsed, 2)} · ${formatPercent(s.marginRatio)}`}
                  />
                  <Stat
                    label={t("portfolio.gross")}
                    value={`${formatNumber(s.gross, 2)} · ${formatNumber(s.grossRatio, 2)}x`}
                  />
                  <Stat label={t("portfolio.net")} value={`${formatSigned(s.net)} · ${bias}`} />
                </div>
              </>
            ) : (
              <SummarySkeleton rows={5} />
            )}
          </section>

          <section className="page-panel pf-panel pf-curve" aria-labelledby="pf-realized">
            <header className="pf-curve-head">
              <h2 className="pd-visually-hidden" id="pf-realized">
                {t("col.rpnl")}
              </h2>
              <div className="pf-views" role="tablist" aria-label={t("portfolio.view")}>
                {VIEWS.map((v) => (
                  <button
                    key={v}
                    type="button"
                    role="tab"
                    aria-selected={view === v}
                    className="pf-view"
                    onClick={() => setView(v)}
                  >
                    {t(v === "realized" ? "col.rpnl" : "portfolio.edge")}
                  </button>
                ))}
              </div>
              {trades && (
                <strong className={`pd-num pf-curve-total ${trendClass(perf.realized)}`}>
                  {money(perf.realized)}
                </strong>
              )}
            </header>
            {noHistory ??
              (trades === undefined || !chart ? (
                <div className="pd-skel pf-chart" />
              ) : (
                <div
                  className="pf-chart-wrap"
                  onPointerMove={(e) => {
                    const box = e.currentTarget.getBoundingClientRect();
                    const x = ((e.clientX - box.left) / Math.max(box.width, 1)) * CHART_W;
                    setHovered(nearestDot(chart.dots, x));
                  }}
                  onPointerLeave={() => setHovered(undefined)}
                >
                  <svg
                    className="pf-chart"
                    viewBox={`0 0 ${CHART_W} ${CHART_H}`}
                    preserveAspectRatio="none"
                    data-trend={perf.realized >= 0 ? "up" : "down"}
                    role="img"
                    aria-label={`${t("col.rpnl")} ${range}: ${money(perf.realized)}`}
                  >
                    <defs>
                      <linearGradient id="pf-fill" x1="0" x2="0" y1="0" y2="1">
                        <stop className="pf-chart-stop" offset="0" stopOpacity="0.38" />
                        <stop className="pf-chart-stop" offset="1" stopOpacity="0.02" />
                      </linearGradient>
                    </defs>
                    <path className="pf-chart-area" d={chart.area} />
                    <line
                      className="pf-chart-zero"
                      x1="0"
                      x2={CHART_W}
                      y1={chart.zero}
                      y2={chart.zero}
                    />
                    <path className="pf-chart-line" d={chart.line} />
                    {hovered && (
                      <line
                        className="pf-chart-cursor"
                        x1={hovered.x}
                        x2={hovered.x}
                        y1="0"
                        y2={CHART_H}
                      />
                    )}
                  </svg>
                  {hovered && (
                    <>
                      <span
                        className="pf-chart-dot"
                        data-trend={hovered.total >= 0 ? "up" : "down"}
                        style={{
                          left: `${(hovered.x / CHART_W) * 100}%`,
                          top: `${(hovered.y / CHART_H) * 100}%`,
                        }}
                        aria-hidden
                      />
                      <div
                        className="pd-map-card pf-chart-tip"
                        data-side={hovered.x > CHART_W / 2 ? "left" : "right"}
                        style={{ left: `${(hovered.x / CHART_W) * 100}%` }}
                        aria-hidden
                      >
                        <dl>
                          <dt>{t("col.time")}</dt>
                          <dd className="pd-num">{dateFormat(TIP_TIME).format(hovered.time)}</dd>
                          <dt>{t("col.rpnl")}</dt>
                          <dd className={`pd-num ${trendClass(hovered.total)}`}>
                            {money(hovered.total)}
                          </dd>
                          {hovered.change !== 0 && (
                            <>
                              <dt>{t("portfolio.tipClose")}</dt>
                              <dd className={`pd-num ${trendClass(hovered.change)}`}>
                                {money(hovered.change)}
                              </dd>
                            </>
                          )}
                        </dl>
                      </div>
                    </>
                  )}
                </div>
              ))}
            <p className="pf-note">{t("portfolio.realizedNote")}</p>
          </section>

          <section className="page-panel pf-panel" aria-labelledby="pf-performance">
            <h2 className="pf-title" id="pf-performance">
              {t("portfolio.performance")}
            </h2>
            {noHistory ??
              (trades === undefined ? (
                <SummarySkeleton rows={6} />
              ) : (
                <>
                  <div className="pf-stats">
                    <Stat
                      label={t("portfolio.rangeRealized", { range })}
                      value={money(perf.realized)}
                      tone={trendClass(perf.realized)}
                    />
                    <div className="pf-stat">
                      <span className="pf-label">{t("portfolio.trades", { range })}</span>
                      <strong className="pd-num pf-value">
                        {perf.trades} <span className="pd-up">{perf.wins}</span> /{" "}
                        <span className="pd-down">{perf.losses}</span>
                      </strong>
                    </div>
                    <Stat label={t("portfolio.winRate")} value={formatPercent(perf.winRate, 1)} />
                    <Stat
                      label={t("portfolio.best")}
                      value={money(perf.best)}
                      tone={trendClass(perf.best)}
                    />
                    <Stat
                      label={t("portfolio.worst")}
                      value={money(perf.worst)}
                      tone={trendClass(perf.worst)}
                    />
                  </div>
                  <ul className="pf-buckets">
                    {BUCKETS.map((b) => (
                      <li key={b} data-bucket={b}>
                        <span className="pf-dot" aria-hidden />
                        {t(BUCKET_LABEL[b])}
                        <strong className="pd-num pf-count">{perf.buckets[b]}</strong>
                      </li>
                    ))}
                  </ul>
                  <div className="pf-split" aria-hidden>
                    <span
                      className="pf-split-part"
                      data-side="up"
                      style={{ flexGrow: decided ? perf.wins / decided : 0 }}
                    />
                    <span
                      className="pf-split-part"
                      data-side="down"
                      style={{ flexGrow: decided ? perf.losses / decided : 0 }}
                    />
                  </div>
                </>
              ))}
          </section>
        </div>
      )}

      <section className="page-panel pf-table">
        <div className="pf-tabs" role="tablist" aria-label={t("nav.portfolio")}>
          {TABS.map((id) => (
            <button
              key={id}
              type="button"
              role="tab"
              aria-selected={tab === id}
              className="pf-tab"
              onClick={() => setTab(id)}
            >
              {id === "open"
                ? t("portfolio.open", { count: s?.positions ?? 0 })
                : t("portfolio.history", { count: inRange.length })}
            </button>
          ))}
          <span className="pf-tabs-note">
            {tab === "open" ? t("portfolio.byAssetNote") : t("portfolio.historyNote", { range })}
          </span>
        </div>
        {tab === "open" ? (
          !s ? (
            <TableSkeleton columns={5} />
          ) : s.byAsset.length === 0 ? (
            <EmptyState>{t("positions.empty")}</EmptyState>
          ) : (
            <table className="pd-table">
              <thead>
                <tr>
                  <th>{t("portfolio.col.asset")}</th>
                  <th>{t("portfolio.col.venue")}</th>
                  <th className="pd-num">{t("portfolio.col.netSize")}</th>
                  <th className="pd-num">{t("portfolio.col.netNotional")}</th>
                  <th className="pd-num">{t("portfolio.col.share")}</th>
                </tr>
              </thead>
              <tbody>
                {s.byAsset.map((a) => (
                  <tr key={`${a.venue}:${a.market}`}>
                    <td className="pd-strong page-asset">
                      <span className="page-asset-name">
                        <TokenIcon market={marketOf(a.market)} size={20} />
                        {baseOf(a.market)}
                      </span>
                    </td>
                    <td className="pd-muted">{venue}</td>
                    <td className={`pd-num ${trendClass(a.netSize)}`}>
                      {formatSigned(a.netSize, 4).replace(/\.?0+$/, "")}
                    </td>
                    <td className="pd-num">{formatNumber(a.netNotional, 2)}</td>
                    <td className="pd-num">{formatPercent(a.share, 1)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )
        ) : (
          (noHistory ??
          (trades === undefined ? (
            <TableSkeleton columns={6} />
          ) : inRange.length === 0 ? (
            <EmptyState>{t("portfolio.noHistory", { range })}</EmptyState>
          ) : (
            <ClosedTradesTable
              trades={inRange}
              symbolFor={(id) => marketOf(id)?.symbol ?? id}
              baseFor={baseOf}
              quoteFor={(id) => marketOf(id)?.quote ?? quote}
              onShare={onShare}
            />
          )))
        )}
      </section>

      <EdgeBreakdown
        open={breakdownOpen}
        onClose={() => setBreakdownOpen(false)}
        holds={edges.holds}
        sizes={edges.sizes}
        quote={quote}
        undated={edges.undated}
      />
      <PnlCalendar
        open={calendarOpen}
        onClose={() => setCalendarOpen(false)}
        trades={trades ?? []}
        quote={quote}
        since={now - HISTORY_MS}
      />
    </div>
  );
}
