import { EquityChart, type EquityLine, TokenIcon, t } from "@pewterdesk/ui";
import { useMemo, useState } from "react";
import { combine, type LabStrategy, type Part, stats } from "../../lib/backtestLab";
import { dayTime, marketName, money, pct, price, tone, useVenueMarkets } from "./parts";
import { ReportView } from "./ReportView";
import {
  Checks,
  exportCsv,
  MoneyBars,
  type ResultsActions,
  ResultsView,
  Runs,
  SetupRail,
} from "./ResultsView";

/** Lines for several markets: the theme's colours, never green or red. */
const LINE_TONES = ["brass", "info", "warning", "muted", "line"] as const;

/**
 * A backtest's results or report, for one market or several: with several,
 * a tab for the whole (the shared account, or every market side by side)
 * and one per market.
 */
export function PartsView({
  tab,
  strategy,
  parts,
  ranAt,
  actions,
}: {
  tab: "results" | "report";
  strategy: LabStrategy;
  parts: readonly Part[];
  ranAt: number;
  actions: ResultsActions;
}) {
  const markets = useVenueMarkets(strategy.venue);
  const shared = strategy.account === "shared" && parts.length > 1;
  const share = shared ? strategy.capital / parts.length : strategy.capital;
  const combined = useMemo(() => (parts.length > 1 ? combine(parts) : undefined), [parts]);
  // The whole first; a report of every market on its own has no whole to read.
  const hasWhole = parts.length > 1 && (tab === "results" || shared);
  const [view, setView] = useState<string>("all");
  const current =
    view === "all" && hasWhole ? "all" : (parts.find((p) => p.market === view) ?? parts[0])?.market;
  const part = parts.find((p) => p.market === current);
  // A market's own view: the strategy as it ran there, on its share of the balance.
  const asRun = (p: Part): LabStrategy => ({ ...strategy, market: p.market, capital: share });

  const tabs =
    parts.length > 1 ? (
      <div className="lab-parts">
        {hasWhole && (
          <button
            type="button"
            className={current === "all" ? "on" : undefined}
            onClick={() => setView("all")}
          >
            {shared ? t("bt.parts.account") : t("bt.parts.all")}
          </button>
        )}
        {parts.map((p) => (
          <button
            key={p.market}
            type="button"
            className={current === p.market ? "on" : undefined}
            onClick={() => setView(p.market)}
          >
            <TokenIcon market={markets?.find((m) => m.id === p.market)} size={16} />
            {marketName(markets, p.market)}
          </button>
        ))}
        <span className="lab-dim lab-parts-note">
          {shared ? t("bt.parts.sharedNote", { share: money(share) }) : t("bt.parts.eachNote")}
        </span>
      </div>
    ) : null;

  if (current === "all" && combined) {
    return (
      <>
        {tabs}
        {tab === "report" ? (
          <ReportView strategy={strategy} run={combined} />
        ) : (
          <AccountView
            strategy={strategy}
            parts={parts}
            shared={shared}
            share={share}
            onOpen={setView}
            ranAt={ranAt}
            actions={actions}
          />
        )}
      </>
    );
  }
  if (!part) return null;
  return (
    <>
      {tabs}
      {tab === "results" ? (
        <ResultsView
          key={part.market}
          strategy={asRun(part)}
          base={strategy}
          run={part.run}
          ranAt={ranAt}
          actions={actions}
        />
      ) : (
        <ReportView key={part.market} strategy={asRun(part)} run={part.run} />
      )}
    </>
  );
}

/** Every market at once: the shared account's figures, or the markets side by side. */
function AccountView({
  strategy,
  parts,
  shared,
  share,
  onOpen,
  ranAt,
  actions,
}: {
  strategy: LabStrategy;
  parts: readonly Part[];
  shared: boolean;
  share: number;
  onOpen: (market: string) => void;
  ranAt: number;
  actions: ResultsActions;
}) {
  const markets = useVenueMarkets(strategy.venue);
  const combined = useMemo(() => combine(parts), [parts]);
  const s = useMemo(() => stats(combined), [combined]);
  const each = useMemo(() => parts.map((p) => ({ market: p.market, s: stats(p.run) })), [parts]);
  const times = useMemo(() => combined.bars.map((b) => b.time), [combined]);
  // Each market's equity on the account's candle times, carried forward.
  const lines = useMemo<EquityLine[]>(() => {
    const along = (p: Part) => {
      let i = 0;
      return times.map((time) => {
        while (i + 1 < p.run.bars.length && (p.run.bars[i + 1]?.time ?? Infinity) <= time) i++;
        return p.run.equity[(p.run.bars[0]?.time ?? Infinity) <= time ? i : 0] ?? 0;
      });
    };
    if (shared) {
      return [
        { label: t("bt.parts.account"), values: combined.equity, color: "brass" },
        { label: t("bt.v.holding"), values: combined.buyHold, color: "muted", dashed: true },
      ];
    }
    return parts.map((p, k) => ({
      label: marketName(markets, p.market),
      values: along(p),
      color: LINE_TONES[k % LINE_TONES.length] ?? "muted",
    }));
  }, [parts, shared, combined, times, markets]);
  const best = [...each].sort((a, b) => b.s.ret - a.s.ret)[0];

  const first = parts[0];
  return (
    <div className="lab-results">
      {first && (
        <SetupRail
          strategy={{ ...strategy, market: first.market, capital: share }}
          base={strategy}
          run={first.run}
          ranAt={ranAt}
          actions={actions}
        />
      )}
      <div className="lab-col lab-main">
        <section className="lab-panel lab-verdict">
          <div className="lab-verdict-head">
            <span className="lab-label">
              {shared
                ? t("bt.parts.accountOf", { n: parts.length, name: strategy.name })
                : t("bt.parts.allOf", { n: parts.length, name: strategy.name })}
            </span>
            {shared ? (
              <>
                <div className="lab-big">
                  <b className={tone(s.ret)}>{pct(s.ret)}</b>
                  <span>
                    {t("bt.v.holding")} <span className="lab-num">{pct(s.buyHold)}</span>
                  </span>
                </div>
                <p>
                  {t("bt.parts.sharedSays", { capital: money(strategy.capital), n: parts.length })}
                </p>
              </>
            ) : (
              <>
                <div className="lab-big">
                  <b>
                    {t("bt.parts.madeMoney", {
                      n: each.filter((e) => e.s.ret > 0).length,
                      total: parts.length,
                    })}
                  </b>
                </div>
                {best && (
                  <p>
                    {t("bt.parts.best", {
                      market: marketName(markets, best.market),
                      ret: pct(best.s.ret),
                    })}
                  </p>
                )}
              </>
            )}
          </div>
          <div className="lab-tiles four">
            {shared ? (
              <>
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
                  <span>{t("bt.v.heldOut")}</span>
                  <b className={tone(s.retOut)}>{strategy.holdOutDays > 0 ? pct(s.retOut) : "–"}</b>
                  <small>{t("bt.v.neverSeen")}</small>
                </div>
                <div className="lab-tile">
                  <span>{t("bt.v.winRate")}</span>
                  <b>{Math.round(s.winRate * 100)}%</b>
                  <small>{t("bt.v.tradesN", { n: s.trades })}</small>
                </div>
              </>
            ) : (
              <>
                <div className="lab-tile">
                  <span>{t("bt.parts.avgReturn")}</span>
                  <b className={tone(each.reduce((a, e) => a + e.s.ret, 0))}>
                    {pct(each.reduce((a, e) => a + e.s.ret, 0) / each.length)}
                  </b>
                  <small>{t("bt.parts.perMarket")}</small>
                </div>
                <div className="lab-tile">
                  <span>{t("bt.parts.worstDd")}</span>
                  <b>{pct(Math.min(...each.map((e) => e.s.maxDrawdown)))}</b>
                  <small>{t("bt.parts.ofAny")}</small>
                </div>
                <div className="lab-tile">
                  <span>{t("bt.parts.beatHold")}</span>
                  <b>
                    {each.filter((e) => e.s.ret > e.s.buyHold).length} / {each.length}
                  </b>
                  <small>{t("bt.parts.markets")}</small>
                </div>
                <div className="lab-tile">
                  <span>{t("bt.v.trades")}</span>
                  <b>{each.reduce((a, e) => a + e.s.trades, 0)}</b>
                  <small>{t("bt.parts.inAll")}</small>
                </div>
              </>
            )}
          </div>
        </section>

        <section className="lab-panel lab-equity-panel">
          <div className="lab-ph">
            <h2>{t("bt.chart.equity")}</h2>
            <span className="lab-dim">
              {shared
                ? t("bt.chart.equityHint")
                : t("bt.parts.eachEquity", { capital: money(strategy.capital) })}
            </span>
          </div>
          <EquityChart
            times={times}
            lines={lines}
            drawdownOf={shared ? 0 : -1}
            money={(v) => money(v)}
          />
        </section>

        <section className="lab-panel">
          <div className="lab-ph">
            <h2>{t("bt.parts.byMarket")}</h2>
            <span className="lab-dim">{t("bt.parts.byMarketHint")}</span>
          </div>
          <div className="lab-table-wrap">
            <table className="lab-table">
              <thead>
                <tr>
                  <th className="l">{t("bt.builder.marketLabel")}</th>
                  {shared && <th>{t("bt.parts.balance")}</th>}
                  <th>{t("bt.v.return")}</th>
                  <th>{t("bt.v.net")}</th>
                  <th>{t("bt.v.holding")}</th>
                  <th>{t("bt.v.heldOut")}</th>
                  <th>{t("bt.v.maxDd")}</th>
                  <th>{t("bt.v.trades")}</th>
                </tr>
              </thead>
              <tbody>
                {each.map((e) => (
                  <tr
                    key={e.market}
                    tabIndex={0}
                    onClick={() => onOpen(e.market)}
                    onKeyDown={(k) => k.key === "Enter" && onOpen(e.market)}
                  >
                    <td className="l">
                      <span className="lab-cell-market">
                        <TokenIcon market={markets?.find((m) => m.id === e.market)} size={16} />
                        {marketName(markets, e.market)}
                      </span>
                    </td>
                    {shared && <td>{money(share)}</td>}
                    <td className={tone(e.s.ret)}>{pct(e.s.ret)}</td>
                    <td className={tone(e.s.net)}>{money(e.s.net, true)}</td>
                    <td className="lab-mut">{pct(e.s.buyHold)}</td>
                    <td className={tone(e.s.retOut)}>
                      {strategy.holdOutDays > 0 ? pct(e.s.retOut) : "–"}
                    </td>
                    <td>{pct(e.s.maxDrawdown)}</td>
                    <td>{e.s.trades}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>

        <section className="lab-panel lab-trades">
          <div className="lab-ph">
            <h2>{t("bt.trades.title")}</h2>
            <span className="lab-dim">{combined.trades.length}</span>
            <span className="lab-ph-r">
              <span className="lab-dim">{t("bt.parts.byMarketHint")}</span>
              <button
                type="button"
                className="lab-btn small"
                disabled={combined.trades.length === 0}
                onClick={() => exportCsv(strategy.name, combined.trades)}
              >
                {t("bt.trades.export")}
              </button>
            </span>
          </div>
          <div className="lab-table-wrap">
            <table className="lab-table">
              <thead>
                <tr>
                  <th className="l">{t("bt.builder.marketLabel")}</th>
                  <th className="l">{t("bt.trades.side")}</th>
                  <th className="l">{t("bt.trades.opened")}</th>
                  <th>{t("bt.trades.entry")}</th>
                  <th>{t("bt.trades.exit")}</th>
                  <th>R</th>
                  <th>{t("bt.trades.pnl")}</th>
                </tr>
              </thead>
              <tbody>
                {combined.trades.map((tr, i) => {
                  const m = combined.tradeMarkets[i] ?? "";
                  return (
                    <tr
                      key={`${m}:${tr.openTime}:${tr.n}`}
                      tabIndex={0}
                      onClick={() => onOpen(m)}
                      onKeyDown={(k) => k.key === "Enter" && onOpen(m)}
                    >
                      <td className="l lab-mut">{marketName(markets, m)}</td>
                      <td className="l">
                        <span className={tr.side === "long" ? "up" : "dn"}>
                          {t(`bt.side.${tr.side}`)}
                        </span>
                      </td>
                      <td className="l lab-mut">{dayTime(tr.openTime)}</td>
                      <td>{price(tr.entry)}</td>
                      <td>{price(tr.exit)}</td>
                      <td className={tone(tr.r)}>
                        {tr.r >= 0 ? "+" : ""}
                        {tr.r.toFixed(2)}R
                      </td>
                      <td className={tone(tr.pnl)}>{money(tr.pnl, true, 2)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </section>
      </div>
      <div className="lab-col lab-side">
        <Checks s={s} holdOutDays={strategy.holdOutDays} />
        <MoneyBars s={s} />
        <Runs actions={actions} current={strategy.id} />
      </div>
    </div>
  );
}
