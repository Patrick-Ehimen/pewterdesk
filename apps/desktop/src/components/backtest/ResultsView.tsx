import type { BotTrade, RunResult } from "@pewterdesk/core";
import {
  type BacktestBar,
  BacktestChart,
  type BacktestChartTrade,
  type ChartLine,
  EquityStrip,
  TokenIcon,
  t,
} from "@pewterdesk/ui";
import {
  type KeyboardEvent,
  type PointerEvent,
  type ReactNode,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { LuCheck, LuChevronDown, LuCircleAlert, LuInfo, LuPlay } from "react-icons/lu";
import {
  allMarkets,
  LAB_INTERVALS,
  type LabInterval,
  type LabStrategy,
  PERIODS,
  periodRange,
  type RunStats,
  stats,
  TEMPLATES,
  type Template,
  VENUE_FEES,
} from "../../lib/backtestLab";
import { VENUES } from "../../lib/venues";
import { defaultConfig } from "./BuilderView";
import {
  day,
  dayTime,
  held,
  MarketPicker,
  marketName,
  money,
  pct,
  price,
  Seg,
  Sentence,
  tone,
  useVenueMarkets,
} from "./parts";

type TradeFilter = "all" | "won" | "lost" | "out";

const DAY = 86_400_000;

interface Check {
  kind: "ok" | "warn" | "info";
  title: string;
  body: string;
}

function checks(s: RunStats, holdOutDays: number): Check[] {
  const out: Check[] = [];
  const gap = (s.buyHold - s.ret) * 100;
  out.push(
    s.ret >= s.buyHold
      ? {
          kind: "ok",
          title: t("bt.check.beatHold"),
          body: t("bt.check.beatHoldBody", { pts: (-gap).toFixed(1) }),
        }
      : {
          kind: "warn",
          title: t("bt.check.holdBetter"),
          body: t("bt.check.holdBetterBody", {
            pts: gap.toFixed(1),
            dd: pct(s.maxDrawdown),
            holdDd: pct(s.buyHoldDrawdown, 0),
          }),
        },
  );
  if (holdOutDays > 0) {
    out.push(
      s.tradesOut < 10
        ? {
            kind: "warn",
            title: t("bt.check.fewOut", { n: s.tradesOut, ret: pct(s.retOut) }),
            body: t("bt.check.fewOutBody"),
          }
        : s.retOut < 0
          ? {
              kind: "warn",
              title: t("bt.check.lostOut", { ret: pct(s.retOut) }),
              body: t("bt.check.lostOutBody"),
            }
          : {
              kind: "ok",
              title: t("bt.check.heldUp", { ret: pct(s.retOut) }),
              body: t("bt.check.heldUpBody", { n: s.tradesOut }),
            },
    );
  } else {
    out.push({ kind: "info", title: t("bt.check.noHoldOut"), body: t("bt.check.noHoldOutBody") });
  }
  if (s.best && s.net > 0 && s.best.pnl / s.net > 0.5) {
    out.push({
      kind: "info",
      title: t("bt.check.oneTrade", { share: Math.round((s.best.pnl / s.net) * 100) }),
      body: t("bt.check.oneTradeBody", { n: s.best.n, rest: money(s.net - s.best.pnl, true) }),
    });
  }
  out.push(
    s.trades >= 30
      ? { kind: "ok", title: t("bt.check.enough", { n: s.trades }), body: t("bt.check.enoughBody") }
      : { kind: "warn", title: t("bt.check.few", { n: s.trades }), body: t("bt.check.fewBody") },
  );
  const cost = s.fees + s.funding + s.slippage;
  if (s.gross > 0) {
    const share = Math.round((cost / s.gross) * 100);
    out.push(
      cost > s.gross
        ? {
            kind: "warn",
            title: t("bt.check.costsAll"),
            body: t("bt.check.costsAllBody", { gross: money(s.gross), cost: money(cost) }),
          }
        : cost / s.gross < 0.5
          ? { kind: "ok", title: t("bt.check.costs", { share }), body: t("bt.check.costsBody") }
          : {
              kind: "warn",
              title: t("bt.check.costsHigh", { share }),
              body: t("bt.check.costsHighBody"),
            },
    );
  }
  return out;
}

const ICON: Record<Check["kind"], ReactNode> = {
  ok: <LuCheck size={12} aria-hidden />,
  warn: <LuCircleAlert size={12} aria-hidden />,
  info: <LuInfo size={12} aria-hidden />,
};

/** What the results page can do to the strategy, and the library beside it. */
export interface ResultsActions {
  /** A change to the strategy's setup: saved as a new version, run after. */
  onEdit: (patch: Partial<LabStrategy>) => void;
  /** The builder, on the strategy with a change if given (not saved yet). */
  onBuild: (patch?: Partial<LabStrategy>) => void;
  onRun: () => void;
  canRun: boolean;
  running: boolean;
  /** Every strategy in the library, for the runs list. */
  library: readonly LabStrategy[];
  onOpen: (id: string) => void;
  onLibrary: () => void;
}

/** The trades as a CSV file, saved through the webview's download. */
export function exportCsv(name: string, trades: readonly BotTrade[]) {
  const head = [
    "n",
    "side",
    "opened_utc",
    "closed_utc",
    "entry",
    "exit",
    "size",
    "exit_reason",
    "held_out",
    "r",
    "pnl",
    "fees",
    "funding",
    "slippage",
    "best",
    "worst",
  ];
  const iso = (ms: number) => new Date(ms).toISOString();
  const rows = trades.map((tr) =>
    [
      tr.n,
      tr.side,
      iso(tr.openTime),
      iso(tr.closeTime),
      tr.entry,
      tr.exit,
      tr.size,
      tr.exitReason,
      tr.outOfSample,
      tr.r.toFixed(4),
      tr.pnl.toFixed(2),
      tr.fees.toFixed(2),
      tr.funding.toFixed(2),
      tr.slippage.toFixed(2),
      tr.mfe.toFixed(2),
      tr.mae.toFixed(2),
    ].join(","),
  );
  const blob = new Blob([[head.join(","), ...rows].join("\n")], { type: "text/csv" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `${name.replace(/[^\w.-]+/g, "-").replace(/^-+|-+$/g, "") || "backtest"}-trades.csv`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function ResultsView({
  strategy,
  base,
  run,
  ranAt,
  actions,
}: {
  /** The strategy as it ran on this market (its share of the balance). */
  strategy: LabStrategy;
  /** The strategy as saved, for its setup. */
  base: LabStrategy;
  run: RunResult;
  ranAt: number;
  actions: ResultsActions;
}) {
  const s = useMemo(() => stats(run), [run]);
  const markets = useVenueMarkets(strategy.venue);
  const name = marketName(markets, strategy.market);
  const [focus, setFocus] = useState<number | undefined>(() => s.best?.n);
  const [filter, setFilter] = useState<TradeFilter>("all");
  const [view, setView] = useState<{ from: number; to: number }>();
  const [shown_, setShown] = useState<{ from: number; to: number }>();
  const range = periodRange(strategy, ranAt);

  // ⌘↵ / Ctrl+Enter runs the backtest again.
  const runRef = useRef(actions);
  runRef.current = actions;
  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
        const a = runRef.current;
        if (a.canRun && !a.running) {
          e.preventDefault();
          a.onRun();
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const bars = useMemo<BacktestBar[]>(() => run.bars, [run]);
  const lines = useMemo<ChartLine[]>(() => {
    const out: ChartLine[] = [];
    if (strategy.strategy.template === "ema") {
      if (run.fastLine)
        out.push({ values: run.fastLine, tone: "info", label: `EMA ${strategy.strategy.fast}` });
      if (run.slowLine)
        out.push({ values: run.slowLine, tone: "warning", label: `EMA ${strategy.strategy.slow}` });
    }
    return out;
  }, [run, strategy.strategy]);
  const trades = useMemo<BacktestChartTrade[]>(
    () =>
      run.trades.map((tr) => ({
        n: tr.n,
        side: tr.side,
        openTime: tr.openTime,
        closeTime: tr.closeTime,
        entry: tr.entry,
        exit: tr.exit,
        r: tr.r,
        pnl: tr.pnl,
        stop: tr.initialStop,
      })),
    [run],
  );
  const shown = run.trades.filter((tr) =>
    filter === "won"
      ? tr.pnl > 0
      : filter === "lost"
        ? tr.pnl <= 0
        : filter === "out"
          ? tr.outOfSample
          : true,
  );
  const focused = run.trades.find((tr) => tr.n === focus);
  const ratio = s.maxDrawdown < 0 ? s.buyHoldDrawdown / s.maxDrawdown : 0;
  const holdOut =
    strategy.holdOutDays > 0 && run.holdOutFrom < run.bars.length ? run.holdOutFrom : undefined;
  // The worst and best any trade saw while open: one scale for every row's bar.
  const extent = useMemo(() => {
    let lo = 0;
    let hi = 0;
    for (const tr of run.trades) {
      lo = Math.min(lo, tr.mae, tr.pnl);
      hi = Math.max(hi, tr.mfe, tr.pnl);
    }
    return { lo, hi: hi > lo ? hi : lo + 1 };
  }, [run]);
  const onScreen = (() => {
    if (!shown_ || bars.length === 0) return undefined;
    const a = bars[Math.max(0, Math.min(bars.length - 1, Math.round(shown_.from)))];
    const b = bars[Math.max(0, Math.min(bars.length - 1, Math.round(shown_.to)))];
    return a && b ? `${shortDay(a.time)} – ${shortDay(b.time)}` : undefined;
  })();
  const stopLabel =
    strategy.strategy.template === "ema"
      ? t("bt.chart.stopAtr", { x: strategy.strategy.stopAtr.toFixed(1) })
      : t("bt.chart.stop");

  return (
    <div className="lab-results">
      <SetupRail strategy={strategy} base={base} run={run} ranAt={ranAt} actions={actions} />

      <div className="lab-col lab-main">
        <section className="lab-panel lab-verdict">
          <div className="lab-verdict-head">
            <span className="lab-label">{t("bt.v.afterCosts", { name: strategy.name })}</span>
            <div className="lab-big">
              <b className={tone(s.ret)}>{pct(s.ret)}</b>
              <span>
                {t("bt.v.holding").toLowerCase()} <span className="lab-num">{pct(s.buyHold)}</span>
              </span>
            </div>
            <p>
              {s.ret >= s.buyHold
                ? t("bt.v.ahead", { pts: ((s.ret - s.buyHold) * 100).toFixed(0) })
                : ratio > 1.5
                  ? t("bt.v.behindSafer", {
                      pts: ((s.buyHold - s.ret) * 100).toFixed(0),
                      x: ratio.toFixed(1),
                    })
                  : t("bt.v.behind", { pts: ((s.buyHold - s.ret) * 100).toFixed(0) })}
            </p>
            <span className="lab-dim">
              {day(range.since)} – {day(range.until)} · {t("bt.v.tradesN", { n: s.trades })} ·{" "}
              {t("bt.v.inMarket", { n: Math.round(s.inMarket * 100) })}
            </span>
          </div>
          <div className="lab-tiles four">
            <div className="lab-tile">
              <span>{t("bt.v.net")}</span>
              <b className={tone(s.net)}>{money(s.net, true)}</b>
              <small>{t("bt.v.on", { capital: money(strategy.capital) })}</small>
            </div>
            <div className="lab-tile">
              <span>{t("bt.v.maxDd")}</span>
              <b>{pct(s.maxDrawdown)}</b>
              <small>{t("bt.v.holdFell", { dd: pct(s.buyHoldDrawdown, 0) })}</small>
            </div>
            <div className="lab-tile">
              <span>{t("bt.v.pf")}</span>
              <b>{s.profitFactor === undefined ? "–" : s.profitFactor.toFixed(2)}</b>
              <small>{t("bt.v.pfHint")}</small>
            </div>
            <div className="lab-tile">
              <span>{t("bt.v.winRate")}</span>
              <b>{Math.round(s.winRate * 100)}%</b>
              <small>
                {s.avgWinR > 0
                  ? t("bt.v.avgWin", { r: `+${s.avgWinR.toFixed(1)}R` })
                  : t("bt.v.tradesN", { n: s.trades })}
              </small>
            </div>
          </div>
        </section>

        <section className="lab-panel lab-chart-panel">
          <div className="lab-ph">
            <h2 className="lab-chart-name">{name}</h2>
            <span className="lab-dim">{strategy.interval}</span>
            <span className="lab-legend">
              {lines.map((l) => (
                <span key={l.label} className={`lab-line-key ${l.tone}`}>
                  <i />
                  {l.label}
                </span>
              ))}
              <span className="lab-key buy">▲ {t("bt.chart.entry")}</span>
              <span className="lab-key exit">▼ {t("bt.chart.exit")}</span>
            </span>
            <span className="lab-ph-r">
              {onScreen && <span className="lab-dim">{onScreen}</span>}
              <span className="lab-seg lab-trade-nav">
                <button
                  type="button"
                  disabled={!focus || focus <= 1}
                  onClick={() => setFocus((f) => Math.max(1, (f ?? 2) - 1))}
                >
                  ‹ {t("bt.chart.prev")}
                </button>
                <button
                  type="button"
                  disabled={!run.trades.length || (focus ?? 0) >= run.trades.length}
                  onClick={() => setFocus((f) => Math.min(run.trades.length, (f ?? 0) + 1))}
                >
                  {t("bt.chart.next")} ›
                </button>
                <button
                  type="button"
                  className={focus === undefined ? "on" : undefined}
                  onClick={() => setFocus(undefined)}
                >
                  {t("bt.chart.all")}
                </button>
              </span>
            </span>
          </div>
          <BacktestChart
            bars={bars}
            lines={lines}
            trades={trades}
            holdOutFrom={holdOut}
            holdOutLabel={t("bt.chart.heldOutFrom")}
            focus={focus}
            focusLabel={
              focused
                ? t("bt.chart.focus", { n: focused.n, pnl: money(focused.pnl, true) })
                : undefined
            }
            stopLabel={stopLabel}
            onPickTrade={setFocus}
            view={view}
            onRange={(from, to) => setShown({ from, to })}
            watermark={name}
          />
          <div className="lab-strip">
            <div className="lab-strip-head">
              <span className="lab-label">{t("bt.strip.title")}</span>
              <span className="lab-strip-key run">
                <i />
                {t("bt.strip.run")}
              </span>
              <span className="lab-strip-key hold">
                <i />
                {t("bt.strip.hold")}
              </span>
              <span className="lab-strip-key dd">
                <i />
                {t("bt.strip.dd")}
              </span>
              <span className="lab-dim lab-strip-hint">{t("bt.strip.hint")}</span>
            </div>
            <EquityStrip
              equity={run.equity}
              buyHold={run.buyHold}
              holdOutFrom={holdOut}
              holdOutLabel={
                holdOut !== undefined
                  ? t("bt.builder.heldOutDays", { n: strategy.holdOutDays })
                  : undefined
              }
              window={shown_}
              onWindow={(from, to) => setView({ from, to })}
              money={(v) => compactMoney(v)}
              label={t("bt.strip.label")}
            />
          </div>
        </section>

        <section className="lab-panel lab-trades">
          <div className="lab-ph">
            <h2>{t("bt.trades.title")}</h2>
            <span className="lab-dim">{run.trades.length}</span>
            <span className="lab-seg">
              {(["all", "won", "lost", "out"] as const).map((f) => (
                <button
                  key={f}
                  type="button"
                  className={filter === f ? "on" : undefined}
                  onClick={() => setFilter(f)}
                >
                  {t(`bt.trades.${f}`)}
                </button>
              ))}
            </span>
            <span className="lab-ph-r">
              <span className="lab-dim">{t("bt.trades.hint")}</span>
              <button
                type="button"
                className="lab-btn small"
                disabled={run.trades.length === 0}
                onClick={() => exportCsv(`${strategy.name}-${name}`, run.trades)}
              >
                {t("bt.trades.export")}
              </button>
            </span>
          </div>
          <div className="lab-table-wrap">
            <table className="lab-table">
              <thead>
                <tr>
                  <th className="l">#</th>
                  <th className="l">{t("bt.trades.side")}</th>
                  <th>{t("bt.trades.opened")}</th>
                  <th>{t("bt.trades.held")}</th>
                  <th>{t("bt.trades.entry")}</th>
                  <th>{t("bt.trades.exit")}</th>
                  <th className="l">{t("bt.trades.why")}</th>
                  <th className="l">{t("bt.trades.range")}</th>
                  <th>R</th>
                  <th>{t("bt.trades.pnl")}</th>
                </tr>
              </thead>
              <tbody>
                {shown.map((tr) => (
                  <tr
                    key={tr.n}
                    className={tr.n === focus ? "sel" : undefined}
                    onClick={() => setFocus(tr.n)}
                    tabIndex={0}
                    onKeyDown={(e) => e.key === "Enter" && setFocus(tr.n)}
                  >
                    <td className="l lab-dim">{tr.n}</td>
                    <td className="l">
                      <span className={tr.side === "long" ? "up" : "dn"}>
                        {tr.side === "long" ? "▲" : "▼"} {t(`bt.side.${tr.side}`)}
                      </span>
                      {tr.outOfSample && (
                        <span className="lab-pill info">{t("bt.trades.heldOutTag")}</span>
                      )}
                    </td>
                    <td className="lab-mut">{dayTime(tr.openTime)}</td>
                    <td className="lab-mut">{held(tr.closeTime - tr.openTime)}</td>
                    <td>{price(tr.entry)}</td>
                    <td>{price(tr.exit)}</td>
                    <td className="l lab-mut">{t(`bt.reason.${tr.exitReason}`)}</td>
                    <td className="l">
                      <RangeBar trade={tr} lo={extent.lo} hi={extent.hi} />
                    </td>
                    <td className={tone(tr.r)}>
                      {tr.r >= 0 ? "+" : ""}
                      {tr.r.toFixed(2)}R
                    </td>
                    <td className={tone(tr.pnl)}>{money(tr.pnl, true)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {shown.length === 0 && <p className="lab-empty">{t("bt.trades.none")}</p>}
          </div>
        </section>
      </div>

      <div className="lab-col lab-side">
        <Checks s={s} holdOutDays={strategy.holdOutDays} />
        <MoneyBars s={s} />
        <Runs actions={actions} current={base.id} />
      </div>
    </div>
  );
}

const shortDay = (ms: number) =>
  new Date(ms).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });

/** $15k, $9.8k, $1.2M: the strip's axis. */
function compactMoney(v: number) {
  const a = Math.abs(v);
  const sign = v < 0 ? "−" : "";
  if (a >= 1e6) return `${sign}$${(a / 1e6).toFixed(a >= 1e7 ? 0 : 1)}M`;
  if (a >= 1e3) return `${sign}$${(a / 1e3).toFixed(a >= 1e4 ? 0 : 1)}k`;
  return `${sign}$${a.toFixed(0)}`;
}

/** A trade's worst and best while open, red below zero and green above, a tick where it closed. */
function RangeBar({ trade, lo, hi }: { trade: BotTrade; lo: number; hi: number }) {
  const at = (v: number) => `${((v - lo) / (hi - lo)) * 100}%`;
  const worst = Math.min(0, trade.mae, trade.pnl);
  const best = Math.max(0, trade.mfe, trade.pnl);
  return (
    <span
      className="lab-range"
      title={t("bt.trades.rangeTip", {
        mae: money(worst, true),
        mfe: money(best, true),
        pnl: money(trade.pnl, true),
      })}
    >
      <span className="dn" style={{ left: at(worst), width: `calc(${at(0)} - ${at(worst)})` }} />
      <span className="up" style={{ left: at(0), width: `calc(${at(best)} - ${at(0)})` }} />
      <i style={{ left: at(trade.pnl) }} />
    </span>
  );
}

export function Checks({ s, holdOutDays }: { s: RunStats; holdOutDays: number }) {
  const list = checks(s, holdOutDays);
  return (
    <section className="lab-panel">
      <div className="lab-ph">
        <h2>{t("bt.check.title")}</h2>
        <span className="lab-ph-r lab-dim">{t("bt.check.count", { n: list.length })}</span>
      </div>
      <div className="lab-checks">
        {list.map((c) => (
          <div key={c.title} className="lab-check">
            <span className={`lab-ic ${c.kind}`}>{ICON[c.kind]}</span>
            <div>
              <b>{c.title}</b>
              <p>{c.body}</p>
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}

export function MoneyBars({ s }: { s: RunStats }) {
  const rows = [
    { key: "moves", label: t("bt.money.moves"), v: s.gross, kind: s.gross >= 0 ? "up" : "dn" },
    { key: "fees", label: t("bt.money.fees"), v: -s.fees, kind: "cost" },
    { key: "funding", label: t("bt.money.funding"), v: -s.funding, kind: "cost" },
    { key: "slippage", label: t("bt.money.slippage"), v: -s.slippage, kind: "cost" },
    { key: "kept", label: t("bt.money.kept"), v: s.net, kind: "kept" },
  ];
  const most = Math.max(1, ...rows.map((r) => Math.abs(r.v)));
  return (
    <section className="lab-panel">
      <div className="lab-ph">
        <h2>{t("bt.money.title")}</h2>
      </div>
      <div className="lab-money">
        {rows.map((r) => (
          <div key={r.key} className={`lab-money-row ${r.kind}`}>
            <span>{r.label}</span>
            <span className="lab-money-track">
              <i style={{ width: `${Math.max(1.5, (Math.abs(r.v) / most) * 100)}%` }} />
            </span>
            <b className={r.kind === "cost" ? "lab-mut" : tone(r.v)}>{money(r.v, true)}</b>
          </div>
        ))}
      </div>
    </section>
  );
}

export function Runs({ actions, current }: { actions: ResultsActions; current: string }) {
  const list = actions.library
    .filter((x) => x.last)
    .sort((a, b) => (b.last?.at ?? 0) - (a.last?.at ?? 0));
  const week = list.filter((x) => (x.last?.at ?? 0) > Date.now() - 7 * DAY).length;
  return (
    <section className="lab-panel lab-runs">
      <div className="lab-ph">
        <h2>{t("bt.runs.title")}</h2>
        <span className="lab-ph-r lab-dim">{t("bt.runs.week", { n: week })}</span>
      </div>
      {list.length === 0 ? (
        <p className="lab-dim lab-pad">{t("bt.runs.none")}</p>
      ) : (
        <div className="lab-runs-list">
          {list.map((x) => (
            <RunRow key={x.id} s={x} on={x.id === current} onOpen={() => actions.onOpen(x.id)} />
          ))}
        </div>
      )}
    </section>
  );
}

function RunRow({ s, on, onOpen }: { s: LabStrategy; on: boolean; onOpen: () => void }) {
  const markets = useVenueMarkets(s.venue);
  const last = s.last;
  if (!last) return null;
  return (
    <button type="button" className={`lab-run${on ? " on" : ""}`} onClick={onOpen}>
      <span className="lab-run-v">v{s.version}</span>
      <span className="lab-run-name">
        <b>{s.name}</b>
        <span className="lab-dim">
          {t("bt.runs.meta", {
            market: marketName(markets, s.market),
            interval: s.interval,
            n: last.trades,
          })}
        </span>
      </span>
      <span className="lab-run-fig">
        <b className={tone(last.ret)}>{pct(last.ret)}</b>
        <span className="lab-dim">{t("bt.runs.dd", { dd: pct(last.maxDrawdown) })}</span>
      </span>
    </button>
  );
}

/** The run's setup down the left: market, candles, period, strategy, costs, and Run. */
export function SetupRail({
  strategy,
  base,
  run,
  ranAt,
  actions,
}: {
  strategy: LabStrategy;
  base: LabStrategy;
  run: RunResult;
  ranAt: number;
  actions: ResultsActions;
}) {
  const markets = useVenueMarkets(strategy.venue);
  const many = allMarkets(base).length;
  const range = periodRange(base, ranAt);
  const days = Math.max(1, Math.round((range.until - range.since) / DAY));
  const fees = VENUE_FEES[strategy.venue];
  const tpl = base.strategy.template;
  const near = run.bars.at(-1)?.close ?? 100;
  return (
    <aside className="lab-col lab-rail lab-panel">
      <div className="lab-rail-sec">
        <div className="lab-rail-h">
          <span className="lab-label">{t("bt.rail.market")}</span>
          <span className="lab-dim">{VENUES[strategy.venue].label}</span>
        </div>
        {many > 1 ? (
          <div className="lab-input lab-rail-market">
            <TokenIcon market={markets?.find((m) => m.id === strategy.market)} size={22} />
            <span>
              <b>{marketName(markets, strategy.market)}</b>
              <span className="lab-dim">{t("bt.rail.moreMarkets", { n: many - 1 })}</span>
            </span>
          </div>
        ) : (
          <MarketPicker
            venue={strategy.venue}
            value={base.market}
            list={markets}
            onChange={(market) => market !== base.market && actions.onEdit({ market })}
          />
        )}
        <span className="lab-dim">
          {t("bt.rail.candles", {
            n: run.bars.length.toLocaleString("en-US"),
            venue: VENUES[strategy.venue].label,
          })}
        </span>
        <Seg<LabInterval>
          label={t("bt.builder.timeframe")}
          value={base.interval}
          onChange={(interval) => interval !== base.interval && actions.onEdit({ interval })}
          options={LAB_INTERVALS.map((v) => ({ value: v, label: v }))}
        />
      </div>

      <div className="lab-rail-sec">
        <div className="lab-rail-h">
          <span className="lab-label">{t("bt.rail.period")}</span>
          <span className="lab-dim">
            {day(range.since)} – {day(range.until)}
          </span>
        </div>
        <fieldset className="lab-seg" aria-label={t("bt.rail.period")}>
          {PERIODS.map((p) => (
            <button
              key={p}
              type="button"
              aria-pressed={base.period === p}
              className={base.period === p ? "on" : undefined}
              onClick={() =>
                p === "custom"
                  ? actions.onBuild()
                  : p !== base.period && actions.onEdit({ period: p })
              }
            >
              {t(`bt.periodShort.${p}`)}
            </button>
          ))}
        </fieldset>
        <SplitBar
          days={days}
          holdOut={base.holdOutDays}
          onChange={(holdOutDays) =>
            holdOutDays !== base.holdOutDays && actions.onEdit({ holdOutDays })
          }
        />
      </div>

      <div className="lab-rail-sec">
        <div className="lab-rail-h">
          <span className="lab-label">{t("bt.rail.strategy")}</span>
          <button type="button" className="lab-link" onClick={actions.onLibrary}>
            {t("bt.rail.library")} <LuChevronDown size={11} aria-hidden />
          </button>
        </div>
        <fieldset className="lab-seg" aria-label={t("bt.rail.strategy")}>
          {TEMPLATES.map((x: Template) => (
            <button
              key={x}
              type="button"
              aria-pressed={tpl === x}
              className={tpl === x ? "on" : undefined}
              onClick={() =>
                x === tpl
                  ? actions.onBuild()
                  : actions.onBuild({ strategy: defaultConfig(x, near) })
              }
            >
              {t(`bt.tplShort.${x}`)}
            </button>
          ))}
        </fieldset>
        <button
          type="button"
          className="lab-rail-sentence lab-sentence"
          title={t("bt.rail.edit")}
          onClick={() => actions.onBuild()}
        >
          <Sentence config={base.strategy} />
        </button>
      </div>

      <div className="lab-rail-sec">
        <span className="lab-label">{t("bt.builder.costs")}</span>
        <div className="lab-kv lab-rail-kv">
          <span>{t("bt.builder.capital")}</span>
          <b>{money(base.capital)}</b>
          <span>{t("bt.builder.fees", { venue: VENUES[strategy.venue].label })}</span>
          <b>
            {(fees[0] * 100).toFixed(3).replace(/0$/, "")}% /{" "}
            {(fees[1] * 100).toFixed(3).replace(/0$/, "")}%
          </b>
          <span>{t("bt.builder.slippage")}</span>
          <b>{base.slippageBps} bps</b>
          <span>{t("bt.rail.funding")}</span>
          <b className="lab-rail-on" title={t("bt.rail.fundingOn")}>
            <i aria-hidden />
            <span className="sr-only">{t("bt.rail.fundingOn")}</span>
          </b>
        </div>
      </div>

      <div className="lab-rail-foot">
        <button
          type="button"
          className="lab-btn primary lab-rail-run"
          disabled={!actions.canRun || actions.running}
          onClick={actions.onRun}
        >
          <LuPlay size={12} aria-hidden />
          {actions.running ? t("bt.running") : t("bt.runBacktest")}
          <kbd>⌘↵</kbd>
        </button>
        <span className="lab-dim">{t("bt.rail.note", { name: base.name, v: base.version })}</span>
      </div>
    </aside>
  );
}

/** The period split into the days tuned on and the days held out; its handle drags the split. */
function SplitBar({
  days,
  holdOut,
  onChange,
}: {
  days: number;
  holdOut: number;
  onChange: (holdOutDays: number) => void;
}) {
  const [live, setLive] = useState<number>();
  const value = live ?? holdOut;
  const barRef = useRef<HTMLDivElement>(null);
  const max = Math.max(0, days - 1);
  const at = (clientX: number) => {
    const r = barRef.current?.getBoundingClientRect();
    if (!r || r.width === 0) return value;
    const frac = Math.max(0, Math.min(1, (clientX - r.left) / r.width));
    return Math.max(0, Math.min(max, Math.round(days * (1 - frac))));
  };
  const onDown = (e: PointerEvent) => {
    e.currentTarget.setPointerCapture(e.pointerId);
    setLive(at(e.clientX));
  };
  const onMove = (e: PointerEvent) => {
    if (live !== undefined) setLive(at(e.clientX));
  };
  const onUp = () => {
    if (live !== undefined) onChange(live);
    setLive(undefined);
  };
  const onKey = (e: KeyboardEvent) => {
    const by = e.key === "ArrowLeft" ? 1 : e.key === "ArrowRight" ? -1 : 0;
    if (!by) return;
    e.preventDefault();
    setLive(Math.max(0, Math.min(max, value + by * (e.shiftKey ? 10 : 1))));
  };
  const tune = days - value;
  return (
    <div className="lab-rail-split">
      <div
        ref={barRef}
        className="lab-rail-splitbar"
        role="slider"
        tabIndex={0}
        aria-label={t("bt.rail.split")}
        aria-valuemin={0}
        aria-valuemax={max}
        aria-valuenow={value}
        onPointerDown={onDown}
        onPointerMove={onMove}
        onPointerUp={onUp}
        onPointerCancel={() => setLive(undefined)}
        onKeyDown={onKey}
        onKeyUp={(e) => (e.key === "ArrowLeft" || e.key === "ArrowRight") && onUp()}
        onBlur={onUp}
      >
        <span className="tune" style={{ width: `${(tune / days) * 100}%` }} />
        <span className="out" style={{ width: `${(value / days) * 100}%` }} />
        <i style={{ left: `${(tune / days) * 100}%` }} />
      </div>
      <div className="lab-rail-splitkey">
        <span className="tune">{t("bt.rail.tune", { n: tune })}</span>
        <span className="out">{t("bt.rail.heldOut", { n: value })}</span>
      </div>
    </div>
  );
}
