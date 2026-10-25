import {
  dateFormat,
  formatNumber,
  formatPercent,
  formatSigned,
  type MessageKey,
  t,
  trendClass,
} from "@pewterdesk/ui";
import { type CSSProperties, type ReactNode, useEffect, useState } from "react";
import type { BotBook } from "../../hooks/useBots";
import { useStoredChoice } from "../../hooks/useStoredChoice";
import {
  BOT_PERIODS,
  type BotPeriod,
  type BotPoint,
  type BotView,
  backtestAt,
  dailyPnl,
  driftOf,
  inPeriod,
  MIN_COMPARE_TRADES,
  netOf,
  pnlByHour,
  statsOf,
  todayOf,
} from "../../lib/bots";
import {
  BotNotice,
  DemoControls,
  ModeBadge,
  Money,
  Pct,
  StatusDot,
  useAct,
  whereOf,
} from "../bots/parts";

// The Bots page: every bot, how they're doing together, and one bot at a
// time against the backtest it was started from - the question a bot page
// has to answer is whether it still behaves as it did there. It reads the
// bots only; pause and stop go through the same calls as the panel's.

const DETAIL_TABS = ["trades", "events", "hours"] as const;
type DetailTab = (typeof DETAIL_TABS)[number];
const STAMP: Intl.DateTimeFormatOptions = {
  month: "short",
  day: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
};
const CLOCK: Intl.DateTimeFormatOptions = { hour: "2-digit", minute: "2-digit", hour12: false };

interface BotsPageProps {
  book: BotBook;
  symbolFor: (market: string) => string;
  /** Opens the Trade page, where the Bots panel is. */
  onTrade: () => void;
}

export function BotsPage({ book, symbolFor, onTrade }: BotsPageProps) {
  const [period, setPeriod] = useStoredChoice("pd.bots.period", BOT_PERIODS, "all");
  const [selected, setSelected] = useState<string>();
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(id);
  }, []);
  const bot = book.bots.find((b) => b.id === selected) ?? book.bots[0];
  const offline = !book.link.reachable;

  return (
    <div className="page bots-page">
      <div className="page-head bots-head">
        <h1>{t("nav.bots")}</h1>
        <span>{t("nav.botsDesc")}</span>
        <span className="bots-head-aside">
          {book.source.demo && <DemoControls demo={book.demo} onDemo={book.setDemo} />}
          <span className="pd-segmented" role="radiogroup" aria-label={t("bots.period")}>
            {BOT_PERIODS.map((p) => (
              <label key={p} data-checked={period === p || undefined}>
                <input
                  type="radio"
                  name="bots-period"
                  checked={period === p}
                  onChange={() => setPeriod(p)}
                />
                {t(`bots.period.${p}` as MessageKey)}
              </label>
            ))}
          </span>
        </span>
      </div>

      {offline && (
        <BotNotice
          tone="warn"
          title={t("bots.unreachableTitle")}
          action={
            <button type="button" className="bot-button" onClick={book.retry}>
              {t("bots.retry")}
            </button>
          }
        >
          {t("bots.unreachableBody", { time: dateFormat(CLOCK).format(book.link.at) })}
        </BotNotice>
      )}

      {book.status === "loading" ? (
        <PageSkeleton />
      ) : book.status === "error" ? (
        <div className="bots-center">
          <div className="page-panel bots-message" role="alert">
            <strong>{t("bots.errorTitle")}</strong>
            <span>{t("bots.errorBody")}</span>
            {book.error && <code className="bot-code">{book.error}</code>}
            <div className="bot-actions">
              <button type="button" className="bot-button" onClick={book.retry}>
                {t("bots.retry")}
              </button>
              <button type="button" className="bot-button" onClick={onTrade}>
                {t("bots.toTrade")}
              </button>
            </div>
          </div>
        </div>
      ) : !book.source.engine ? (
        <div className="bots-center">
          <div className="bots-message">
            <strong className="bots-title">{t("bots.unavailableTitle")}</strong>
            <span>{t("bots.unavailableBody")}</span>
            <DemoControls demo={book.demo} onDemo={book.setDemo} />
          </div>
        </div>
      ) : !bot ? (
        <Welcome onTrade={onTrade} />
      ) : (
        <>
          <Totals book={book} now={now} />
          <div className="bots-columns">
            <section className="page-panel bots-list" aria-label={t("bots.list")}>
              <div className="page-panel-head">
                <h2>{t("bots.list")}</h2>
              </div>
              <ul>
                {book.bots.map((b) => (
                  <li key={b.id}>
                    <button
                      type="button"
                      className="bots-row"
                      aria-current={b.id === bot.id || undefined}
                      onClick={() => setSelected(b.id)}
                    >
                      <span className="bots-row-name">
                        <StatusDot bot={b} />
                        <span>{b.name}</span>
                        <ModeBadge bot={b} />
                      </span>
                      <Money value={netOf(b)} />
                      <span className="bot-muted bot-small">
                        {symbolFor(b.market)} · {b.interval} ·{" "}
                        {t(`bots.status.${b.status}` as MessageKey)}
                      </span>
                      <Spark curve={b.curve} />
                    </button>
                  </li>
                ))}
              </ul>
            </section>
            <Detail
              key={bot.id}
              bot={bot}
              book={book}
              period={period}
              offline={offline}
              symbolFor={symbolFor}
            />
          </div>
        </>
      )}
    </div>
  );
}

function Welcome({ onTrade }: { onTrade: () => void }) {
  return (
    <div className="bots-center">
      <div className="bots-message bots-welcome">
        <strong className="bots-title">{t("bots.emptyTitle")}</strong>
        <span>{t("bots.welcomeBody")}</span>
        <ol className="bots-steps">
          {(["1", "2", "3"] as const).map((n) => (
            <li key={n} className="page-panel">
              <span className="pd-num bot-muted">0{n}</span>
              <strong>{t(`bots.step${n}` as MessageKey)}</strong>
              <span className="bot-muted">{t(`bots.step${n}Body` as MessageKey)}</span>
            </li>
          ))}
        </ol>
        <button type="button" className="bot-button" onClick={onTrade}>
          {t("bots.addPanel")}
        </button>
      </div>
    </div>
  );
}

function Totals({ book, now }: { book: BotBook; now: number }) {
  const active = book.bots.filter((b) => b.status !== "stopped");
  const net = book.bots.reduce((sum, b) => sum + netOf(b), 0);
  const today = active.reduce((sum, b) => sum + todayOf(b, now), 0);
  const fees = book.bots.reduce((sum, b) => sum + statsOf(b).fees, 0);
  const refused = book.events.filter((e) => e.kind === "refused").length;
  const cards = [
    {
      label: t("bots.allNet"),
      value: <Money value={net} />,
      note: t("bots.sinceStart"),
    },
    { label: t("bots.today"), value: <Money value={today} />, note: t("bots.todayNote") },
    {
      label: t("bots.runningCard"),
      value: (
        <span className="pd-num">
          {t("bots.runningOf", {
            running: active.filter((b) => b.status === "running").length,
            total: book.bots.length,
          })}
        </span>
      ),
      note: t("bots.pausedCount", { count: active.filter((b) => b.status === "paused").length }),
    },
    {
      label: t("bots.openPositions"),
      value: <span className="pd-num">{active.filter((b) => b.position).length}</span>,
      note: t("bots.openNote"),
    },
    { label: t("bots.refused"), value: <span className="pd-num">{refused}</span>, note: "" },
    {
      label: t("bots.fees"),
      value: <span className="pd-num">{formatNumber(fees, 2)}</span>,
      note: t("bots.sinceStart"),
    },
  ];
  return (
    <div className="page-cards bots-cards">
      {cards.map((c) => (
        <div key={c.label} className="page-card">
          <span className="page-card-label">{c.label}</span>
          <span className="page-card-value bots-card-value">{c.value}</span>
          {c.note && <span className="page-card-note">{c.note}</span>}
        </div>
      ))}
    </div>
  );
}

function Spark({ curve }: { curve: readonly BotPoint[] }) {
  if (curve.length < 2) return <span />;
  const values = curve.map((p) => p.value);
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || 1;
  const step = Math.max(1, Math.floor(values.length / 40));
  const points = values
    .filter((_, i) => i % step === 0 || i === values.length - 1)
    .map(
      (v, i, all) =>
        `${((i / (all.length - 1)) * 100).toFixed(1)},${(22 - ((v - min) / span) * 20).toFixed(1)}`,
    )
    .join(" ");
  return (
    <svg
      className="bots-spark"
      data-up={(values.at(-1) ?? 0) >= 0 || undefined}
      viewBox="0 0 100 24"
      preserveAspectRatio="none"
      aria-hidden
    >
      <polyline points={points} />
    </svg>
  );
}

function Detail({
  bot,
  book,
  period,
  offline,
  symbolFor,
}: {
  bot: BotView;
  book: BotBook;
  period: BotPeriod;
  offline: boolean;
  symbolFor: (market: string) => string;
}) {
  const [tab, setTab] = useStoredChoice<DetailTab>("pd.bots.detail", DETAIL_TABS, "trades");
  const { error, act } = useAct();
  const stats = statsOf(bot);
  const fresh = stats.closed === 0 && bot.curve.length < 3;
  const { drift, gap } = driftOf(bot);
  const symbol = symbolFor(bot.market);
  const events = book.events.filter((e) => e.botId === bot.id);
  const trades = [...bot.trades].reverse();
  const hours = pnlByHour(bot.trades);
  const hourMax = Math.max(1, ...hours.map(Math.abs));
  const statCards: { label: string; value: ReactNode }[] = [
    { label: t("bots.stat.net"), value: fresh ? "-" : <Money value={stats.net} /> },
    { label: t("bots.stat.return"), value: fresh ? "-" : <Pct value={stats.ret} /> },
    {
      label: t("bots.stat.maxDd"),
      value: fresh ? "-" : <Pct value={stats.maxDrawdown} />,
    },
    {
      label: t("bots.winRate"),
      value: stats.winRate === undefined ? "-" : formatPercent(stats.winRate, 1),
    },
    {
      label: t("bots.stat.profitFactor"),
      value: stats.profitFactor === undefined ? "-" : formatNumber(stats.profitFactor, 2),
    },
    { label: t("bots.stat.closed"), value: String(stats.closed) },
    {
      label: t("bots.stat.slippage"),
      value:
        stats.slippageBps === undefined
          ? "-"
          : t("algo.bps", { value: formatNumber(stats.slippageBps, 1) }),
    },
    { label: t("bots.fees"), value: formatNumber(stats.fees, 2) },
  ];

  return (
    <div className="bots-detail">
      <section className="page-panel bots-section">
        <div className="bots-detail-head">
          <h2>{bot.name}</h2>
          <ModeBadge bot={bot} />
          <span className="bot-muted">
            {symbol} · {bot.interval} · {whereOf(bot)} · {bot.strategy}
          </span>
          <span className="bots-head-aside">
            {bot.status !== "stopped" && (
              <button
                type="button"
                className="bot-button"
                disabled={offline}
                onClick={() =>
                  act(() => (bot.status === "paused" ? book.resume(bot.id) : book.pause(bot.id)))
                }
              >
                {t(bot.status === "paused" ? "bots.resume" : "bots.pause")}
              </button>
            )}
          </span>
        </div>
        {error && (
          <p className="bot-reason" role="alert">
            {error}
          </p>
        )}
        <dl className="bots-stats">
          {statCards.map((s) => (
            <div key={s.label}>
              <dt>{s.label}</dt>
              <dd className="pd-num">{s.value}</dd>
            </div>
          ))}
        </dl>
        <EquityChart bot={bot} period={period} fresh={fresh} />
        <Daily bot={bot} period={period} fresh={fresh} />
      </section>

      <div className="bots-lower">
        <section className="page-panel bots-section bots-compare">
          <h3>{t("bots.compareTitle")}</h3>
          {drift === "early" ? (
            <div className="bots-early">
              <span>{t("bots.early")}</span>
              <div className="bots-meter">
                <span
                  style={{ width: `${Math.min(100, (stats.closed / MIN_COMPARE_TRADES) * 100)}%` }}
                />
              </div>
              <span className="pd-num bot-muted bot-small">
                {t("bots.earlyCount", { count: stats.closed, min: MIN_COMPARE_TRADES })}
              </span>
              <span className="bot-muted bot-small">
                {t("bots.earlyBody", { min: MIN_COMPARE_TRADES })}
              </span>
            </div>
          ) : (
            <>
              <Compare bot={bot} />
              <p className="bot-muted bot-small" data-drift={drift}>
                {t(`bots.drift.${drift}` as MessageKey, {
                  gap: `${formatSigned(gap * 100, 1)}%`,
                })}
              </p>
            </>
          )}
        </section>

        <section className="page-panel bots-section bots-tabs">
          <div className="bots-tablist" role="tablist" aria-label={bot.name}>
            {DETAIL_TABS.map((id) => (
              <button
                key={id}
                type="button"
                role="tab"
                className="pd-tab"
                aria-selected={tab === id}
                onClick={() => setTab(id)}
              >
                {id === "trades"
                  ? t("bots.tab.trades", { count: bot.trades.length })
                  : t(`bots.tab.${id}` as MessageKey)}
              </button>
            ))}
          </div>
          <div className="bots-table-wrap">
            {tab === "trades" &&
              (trades.length === 0 ? (
                <p className="bots-none">{t("bots.noTrades")}</p>
              ) : (
                <table className="bots-table pd-num">
                  <thead>
                    <tr>
                      <th>{t("bots.col.opened")}</th>
                      <th>{t("col.side")}</th>
                      <th>{t("col.entry")}</th>
                      <th>{t("bots.col.exit")}</th>
                      <th>{t("bots.col.pnl")}</th>
                      <th>{t("bots.stat.slippage")}</th>
                      <th>{t("bots.col.exitBy")}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {trades.map((tr) => (
                      <tr key={tr.id}>
                        <td className="bot-muted">{dateFormat(STAMP).format(tr.entryAt)}</td>
                        <td className={tr.side === "long" ? "pd-up" : "pd-down"}>
                          {t(tr.side === "long" ? "side.long" : "side.short")}
                        </td>
                        <td>{formatNumber(tr.entry, 3)}</td>
                        <td>{tr.exit === undefined ? "-" : formatNumber(tr.exit, 3)}</td>
                        <td className={trendClass(tr.pnl)}>{formatSigned(tr.pnl, 2)}</td>
                        <td className="bot-muted">
                          {t("algo.bps", { value: formatNumber(tr.slippageBps, 1) })}
                        </td>
                        <td className="bot-muted">
                          {tr.exitBy
                            ? t(`bots.exit.${tr.exitBy}` as MessageKey)
                            : t("bots.exit.open")}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              ))}
            {tab === "events" &&
              (events.length === 0 ? (
                <p className="bots-none">{t("bots.logEmptyBody")}</p>
              ) : (
                <table className="bots-table">
                  <tbody>
                    {events.map((e) => (
                      <tr key={e.id}>
                        <td className="pd-num bot-muted">{dateFormat(STAMP).format(e.at)}</td>
                        <td className="bot-event" data-kind={e.kind}>
                          {t(`bots.event.${e.kind}` as MessageKey)}
                        </td>
                        <td className="pd-num bot-muted bots-wide">{e.text}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              ))}
            {tab === "hours" && (
              <div className="bots-hours-wrap">
                <span className="bot-muted bot-small">{t("bots.hoursNote")}</span>
                <div className="bots-hours">
                  {hours.map((v, h) => (
                    <div
                      // biome-ignore lint/suspicious/noArrayIndexKey: the hour is the key
                      key={h}
                      className="bots-hour"
                      data-sign={v > 0 ? "up" : v < 0 ? "down" : undefined}
                      style={{ "--bots-alpha": Math.abs(v) / hourMax } as CSSProperties}
                      title={`${String(h).padStart(2, "0")}:00 UTC · ${formatSigned(v, 2)}`}
                    >
                      <span className="bot-muted">{String(h).padStart(2, "0")}</span>
                      <span className={`pd-num ${trendClass(v)}`}>
                        {v === 0 ? "·" : formatSigned(v, 0)}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        </section>
      </div>
    </div>
  );
}

/** Live net P&L against the backtest's over the same bars, with a hover readout. */
function EquityChart({ bot, period, fresh }: { bot: BotView; period: BotPeriod; fresh: boolean }) {
  const [hover, setHover] = useState<number>();
  const live = inPeriod(bot.curve, period);
  const base = live[0]?.value ?? 0;
  const btCurve = bot.backtest?.curve ?? [];
  const btBase = live[0] ? backtestAt(btCurve, live[0].t) : 0;
  const rows = live.map((p) => ({
    t: p.t,
    live: p.value - base,
    bt: btCurve.length > 0 ? backtestAt(btCurve, p.t) - btBase : undefined,
  }));
  const values = rows.flatMap((r) => (r.bt === undefined ? [r.live] : [r.live, r.bt]));
  const min = Math.min(0, ...values);
  const max = Math.max(0, ...values);
  const pad = (max - min) * 0.08 || 1;
  const y = (v: number) => ((max + pad - v) / (max - min + 2 * pad)) * 1000;
  const x = (i: number) => (rows.length > 1 ? (i / (rows.length - 1)) * 1000 : 0);
  const line = (pick: (r: (typeof rows)[number]) => number | undefined) =>
    rows
      .map((r, i) => {
        const v = pick(r);
        return v === undefined ? "" : `${x(i).toFixed(1)},${y(v).toFixed(1)}`;
      })
      .filter(Boolean)
      .join(" ");
  const at = hover !== undefined ? rows[hover] : rows.at(-1);

  return (
    <div className="bots-chart-block">
      <div className="bots-legend">
        <strong>{t("bots.liveVsBacktest")}</strong>
        <span className="bots-key" data-line="live">
          {t("bots.legendLive")}
        </span>
        {btCurve.length > 0 && (
          <span className="bots-key" data-line="bt">
            {t("bots.legendBacktest")}
          </span>
        )}
        {at && !fresh && (
          <span className="bots-readout pd-num">
            {dateFormat(STAMP).format(at.t)} · {t("bots.legendLive")} {formatSigned(at.live, 2)}
            {at.bt !== undefined && ` · ${t("bots.legendBacktest")} ${formatSigned(at.bt, 2)}`}
          </span>
        )}
      </div>
      <div
        className="bots-chart"
        role="img"
        aria-label={t("bots.liveVsBacktest")}
        onMouseMove={(e) => {
          if (rows.length < 2) return;
          const r = e.currentTarget.getBoundingClientRect();
          setHover(Math.round(((e.clientX - r.left) / r.width) * (rows.length - 1)));
        }}
        onMouseLeave={() => setHover(undefined)}
      >
        {fresh ? (
          <div className="bots-chart-empty">
            <strong>
              <StatusDot bot={bot} /> {t("bots.waiting")}
            </strong>
            <span className="bot-muted">{t("bots.waitingBody")}</span>
          </div>
        ) : (
          <>
            <svg viewBox="0 0 1000 1000" preserveAspectRatio="none" aria-hidden>
              <line className="bots-zero" x1="0" x2="1000" y1={y(0)} y2={y(0)} />
              {btCurve.length > 0 && <polyline className="bots-bt" points={line((r) => r.bt)} />}
              <polyline className="bots-live" points={line((r) => r.live)} />
            </svg>
            {hover !== undefined && rows.length > 1 && (
              <span
                className="bots-cursor"
                style={{ left: `${(hover / (rows.length - 1)) * 100}%` }}
              />
            )}
          </>
        )}
      </div>
    </div>
  );
}

function Daily({ bot, period, fresh }: { bot: BotView; period: BotPeriod; fresh: boolean }) {
  const days = dailyPnl(inPeriod(bot.curve, period));
  const top = Math.max(1, ...days.map((d) => Math.abs(d.pnl)));
  return (
    <div className="bots-daily-block">
      <strong className="bot-small">{t("bots.daily")}</strong>
      {fresh || days.length === 0 ? (
        <span className="bot-muted bot-small">{t("bots.noDay")}</span>
      ) : (
        <div className="bots-daily">
          {days.map((d) => (
            <span
              key={d.day}
              className="bots-day"
              title={`${dateFormat({ month: "short", day: "numeric" }).format(d.day)} · ${formatSigned(d.pnl, 2)}`}
            >
              <span
                data-sign={d.pnl >= 0 ? "up" : "down"}
                style={{ height: `${(Math.abs(d.pnl) / top) * 50}%` }}
              />
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

function Compare({ bot }: { bot: BotView }) {
  const bt = bot.backtest;
  const stats = statsOf(bot);
  const last = bot.curve.at(-1);
  if (!bt || !last) return null;
  const btRet = bot.capital > 0 ? backtestAt(bt.curve, last.t) / bot.capital : 0;
  const pct = (v: number) => `${v > 0 ? "+" : ""}${formatPercent(v, 2)}`;
  const rows: { label: string; bt: string; live: string; gap: number; better: "up" | "down" }[] = [
    {
      label: t("bots.stat.return"),
      bt: pct(btRet),
      live: pct(stats.ret),
      gap: stats.ret - btRet,
      better: "up",
    },
    {
      label: t("bots.winRate"),
      bt: formatPercent(bt.winRate, 1),
      live: stats.winRate === undefined ? "-" : formatPercent(stats.winRate, 1),
      gap: (stats.winRate ?? 0) - bt.winRate,
      better: "up",
    },
    {
      label: t("bots.stat.slippage"),
      bt: t("algo.bps", { value: formatNumber(bt.slippageBps, 1) }),
      live:
        stats.slippageBps === undefined
          ? "-"
          : t("algo.bps", { value: formatNumber(stats.slippageBps, 1) }),
      gap: (stats.slippageBps ?? 0) - bt.slippageBps,
      better: "down",
    },
    {
      label: t("bots.fees"),
      bt: formatNumber(bt.fees, 2),
      live: formatNumber(stats.fees, 2),
      gap: stats.fees - bt.fees,
      better: "down",
    },
    {
      label: t("bots.stat.maxDd"),
      bt: pct(bt.maxDrawdown),
      live: pct(stats.maxDrawdown),
      gap: stats.maxDrawdown - bt.maxDrawdown,
      better: "up",
    },
  ];
  return (
    <table className="bots-table pd-num">
      <thead>
        <tr>
          <th>{t("bots.col.measure")}</th>
          <th>{t("bots.col.backtest")}</th>
          <th>{t("bots.col.live")}</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => (
          <tr key={r.label}>
            <td className="bot-muted">{r.label}</td>
            <td>{r.bt}</td>
            <td
              className={r.gap === 0 ? "" : r.gap > 0 === (r.better === "up") ? "pd-up" : "pd-down"}
            >
              {r.live}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function PageSkeleton() {
  return (
    <div className="bots-skeleton" role="status" aria-busy="true" aria-label={t("bots.loading")}>
      <div className="page-cards">
        {Array.from({ length: 6 }, (_, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: fixed placeholders
          <div key={i} className="page-card">
            <span className="bot-sk" style={{ width: "50%", height: 10 }} />
            <span className="bot-sk" style={{ width: "70%", height: 20 }} />
          </div>
        ))}
      </div>
      <div className="bots-columns">
        <div className="page-panel bots-section">
          {Array.from({ length: 4 }, (_, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: fixed placeholders
            <span key={i} className="bot-sk" style={{ height: 40 }} />
          ))}
        </div>
        <div className="page-panel bots-section">
          <span className="bot-sk" style={{ width: "30%", height: 20 }} />
          <span className="bot-sk" style={{ height: 240 }} />
          <span className="bot-sk" style={{ height: 80 }} />
        </div>
      </div>
    </div>
  );
}
