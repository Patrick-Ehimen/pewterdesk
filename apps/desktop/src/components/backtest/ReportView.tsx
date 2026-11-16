import type { RunResult } from "@pewterdesk/core";
import { MonthlyChart, t } from "@pewterdesk/ui";
import { useMemo } from "react";
import {
  drawdowns,
  type LabStrategy,
  monteCarlo,
  monthly,
  partStats,
  stats,
} from "../../lib/backtestLab";
import { day, held, money, pct, tone } from "./parts";

export function ReportView({ strategy, run }: { strategy: LabStrategy; run: RunResult }) {
  const s = useMemo(() => stats(run), [run]);
  const tin = useMemo(() => partStats(run, false), [run]);
  const tout = useMemo(() => partStats(run, true), [run]);
  const months = useMemo(() => monthly(run), [run]);
  const falls = useMemo(() => drawdowns(run), [run]);
  const mc = useMemo(() => monteCarlo(run), [run]);
  const labels = useMemo(() => ({ run: strategy.name, hold: t("bt.v.holding") }), [strategy.name]);
  const hasOut = strategy.holdOutDays > 0 && run.holdOutFrom < run.bars.length;
  const reasons = useMemo(() => {
    const by = new Map<string, { n: number; pnl: number }>();
    for (const tr of run.trades) {
      const e = by.get(tr.exitReason) ?? { n: 0, pnl: 0 };
      e.n += 1;
      e.pnl += tr.pnl;
      by.set(tr.exitReason, e);
    }
    return [...by].sort((a, b) => b[1].n - a[1].n);
  }, [run]);
  const wins = run.trades.filter((tr) => tr.pnl > 0);
  const losses = run.trades.filter((tr) => tr.pnl <= 0);
  const avgHeld = (xs: typeof wins) =>
    xs.length ? xs.reduce((a, tr) => a + tr.closeTime - tr.openTime, 0) / xs.length : 0;
  const beat = months.filter((m) => m.ret > m.hold).length;

  const row = (label: string, a: string, b: string) => (
    <tr>
      <td className="l lab-mut">{label}</td>
      <td>{a}</td>
      {hasOut && <td className="lab-info">{b}</td>}
    </tr>
  );
  const verdict = !hasOut
    ? t("bt.report.noHoldOut")
    : tout.trades < 10
      ? t("bt.report.tooFew", { n: tout.trades })
      : tout.ret < 0
        ? t("bt.report.failed")
        : tout.avgR < tin.avgR / 2
          ? t("bt.report.weaker")
          : t("bt.report.heldUp");

  return (
    <div className="lab-report">
      <section className="lab-panel lab-split-panel">
        <div>
          <div className="lab-ph">
            <h2>{t("bt.report.split")}</h2>
            <span className="lab-dim">{t("bt.report.splitHint")}</span>
          </div>
          <table className="lab-table">
            <thead>
              <tr>
                <th className="l" />
                <th>{t("bt.report.tunedOn", { n: Math.round(tin.days) })}</th>
                {hasOut && (
                  <th className="lab-info">
                    {t("bt.report.heldOut", { n: Math.round(tout.days) })}
                  </th>
                )}
              </tr>
            </thead>
            <tbody>
              {row(t("bt.v.return"), pct(tin.ret), pct(tout.ret))}
              {row(t("bt.v.trades"), String(tin.trades), String(tout.trades))}
              {row(
                t("bt.v.winRate"),
                `${Math.round(tin.winRate * 100)}%`,
                `${Math.round(tout.winRate * 100)}%`,
              )}
              {row(
                t("bt.v.pf"),
                tin.profitFactor?.toFixed(2) ?? "–",
                tout.profitFactor?.toFixed(2) ?? "–",
              )}
              {row(
                t("bt.report.avgTrade"),
                `${tin.avgR >= 0 ? "+" : ""}${tin.avgR.toFixed(2)}R`,
                `${tout.avgR >= 0 ? "+" : ""}${tout.avgR.toFixed(2)}R`,
              )}
              {row(t("bt.v.maxDd"), pct(tin.maxDrawdown), pct(tout.maxDrawdown))}
            </tbody>
          </table>
        </div>
        <div className="lab-callout">
          <span className="lab-pill info">{t("bt.report.verdictTag")}</span>
          <p>{verdict}</p>
          {mc && (
            <div className="lab-tiles two">
              <div className="lab-tile">
                <span>{t("bt.mc.losing")}</span>
                <b>{Math.round(mc.losing * 100)}%</b>
                <small>{t("bt.mc.losingHint")}</small>
              </div>
              <div className="lab-tile">
                <span>{t("bt.mc.ddBad")}</span>
                <b className="dn">{pct(mc.dd95)}</b>
                <small>{t("bt.mc.ddBadHint", { dd: pct(s.maxDrawdown) })}</small>
              </div>
              <div className="lab-tile">
                <span>{t("bt.mc.badYear")}</span>
                <b className={tone(mc.bad)}>{pct(mc.bad)}</b>
                <small>{t("bt.mc.median", { ret: pct(mc.median) })}</small>
              </div>
              <div className="lab-tile">
                <span>{t("bt.mc.goodYear")}</span>
                <b className={tone(mc.good)}>{pct(mc.good)}</b>
                <small>{t("bt.mc.drawn")}</small>
              </div>
            </div>
          )}
        </div>
      </section>

      <section className="lab-panel lab-month-panel">
        <div className="lab-ph">
          <h2>{t("bt.report.months")}</h2>
          <span className="lab-dim">{t("bt.report.monthsHint", { beat, n: months.length })}</span>
        </div>
        <MonthlyChart months={months} labels={labels} />
      </section>

      <div className="lab-report-row">
        <section className="lab-panel">
          <div className="lab-ph">
            <h2>{t("bt.report.exits")}</h2>
          </div>
          <table className="lab-table">
            <thead>
              <tr>
                <th className="l">{t("bt.trades.why")}</th>
                <th>{t("bt.v.trades")}</th>
                <th>{t("bt.trades.pnl")}</th>
              </tr>
            </thead>
            <tbody>
              {reasons.map(([why, e]) => (
                <tr key={why}>
                  <td className="l lab-mut">{t(`bt.reason.${why}` as "bt.reason.stop")}</td>
                  <td>
                    {e.n} · {Math.round((e.n / Math.max(1, run.trades.length)) * 100)}%
                  </td>
                  <td className={tone(e.pnl)}>{money(e.pnl, true)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="lab-kv lab-kv-tight">
            <span>{t("bt.report.winnersHeld")}</span>
            <b>{held(avgHeld(wins))}</b>
            <span>{t("bt.report.losersHeld")}</span>
            <b>{held(avgHeld(losses))}</b>
            <span>{t("bt.report.streak")}</span>
            <b>{s.worstStreak}</b>
            <span>{t("bt.report.avgWinLoss")}</span>
            <b>
              {s.avgWinR >= 0 ? "+" : ""}
              {s.avgWinR.toFixed(2)}R / {s.avgLossR.toFixed(2)}R
            </b>
          </div>
        </section>
        <section className="lab-panel">
          <div className="lab-ph">
            <h2>{t("bt.report.falls")}</h2>
            <span className="lab-dim">{t("bt.report.fallsHint")}</span>
          </div>
          <table className="lab-table">
            <thead>
              <tr>
                <th className="l">{t("bt.report.depth")}</th>
                <th className="l">{t("bt.report.from")}</th>
                <th>{t("bt.report.falling")}</th>
                <th>{t("bt.report.back")}</th>
              </tr>
            </thead>
            <tbody>
              {falls.map((f) => (
                <tr key={f.from}>
                  <td className="l dn">{pct(f.depth)}</td>
                  <td className="l lab-mut">{day(f.from)}</td>
                  <td>{held(f.low - f.from)}</td>
                  <td>
                    {f.back ? (
                      held(f.back - f.low)
                    ) : (
                      <span className="lab-warn">{t("bt.report.notYet")}</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {falls[0] && (
            <p className="lab-dim lab-pad">{t("bt.report.sizeFor", { dd: pct(falls[0].depth) })}</p>
          )}
        </section>
      </div>
    </div>
  );
}
