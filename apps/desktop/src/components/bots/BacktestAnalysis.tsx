import { dateFormat, formatNumber, formatSigned, t } from "@pewterdesk/ui";
import { useMemo } from "react";
import { LuCircleAlert, LuCircleCheck } from "react-icons/lu";
import {
  dailyReturns,
  MONTE_CARLO_STEP,
  monteCarlo,
  R_BUCKETS,
  type RunResult,
  type RunStats,
  rBuckets,
  runDays,
  SWEEP_FAST,
  SWEEP_SLOW,
  segmentStats,
  type Verdict,
  withoutBest,
} from "../../lib/backtest";
import { finite } from "./BacktestOverview";
import { BarsChart } from "./charts";

const pct = (v: number, dp = 1) => `${formatSigned(v * 100, dp)}%`;
const weekday = () => dateFormat({ weekday: "short", timeZone: "UTC" });
const DAY = 86_400_000;
/** A day's return that fills its square's colour. */
const FULL_COLOUR = 0.02;

/** Whether the run is worth paper trading, and the evidence for and against. */
export function BacktestAnalysis({
  result,
  stats,
  verdict,
}: {
  result: RunResult;
  stats: RunStats;
  verdict: Verdict;
}) {
  const { spec, trades } = result;
  const { cells, checks: ready, failing } = verdict;
  const mc = useMemo(
    () => monteCarlo(trades, spec.capital, stats.drawdown.max),
    [trades, spec.capital, stats.drawdown.max],
  );
  const inS = segmentStats(result, false);
  const outS = segmentStats(result, true);
  const buckets = rBuckets(trades);
  const daily = dailyReturns(
    result.equity,
    result.bars.map((b) => b.time),
    spec.capital,
  );
  const holdOutStart = result.bars[result.holdOutFrom]?.time ?? Number.POSITIVE_INFINITY;
  const costs = { fees: stats.fees, slippage: stats.slippage, funding: stats.funding };
  const gross = stats.net - costs.fees - costs.slippage - costs.funding;
  const costShare = gross > 0 ? (gross - stats.net) / gross : 0;
  const best = [...trades].sort((a, b) => b.pnl - a.pnl)[0];
  const inDays = runDays(spec) - spec.holdOutDays;

  return (
    <div className="bt-analysis">
      <section className="bt-panel bt-ready" data-ok={failing === 0 || undefined}>
        <div>
          <span className="bt-tile-label">{t("bots.ready.question")}</span>
          <strong>
            {failing === 0 ? t("bots.ready.yes") : t("bots.ready.no", { failing, total: 4 })}
          </strong>
        </div>
        <Check
          ok={ready.settings.ok}
          title={t("bots.check.settings")}
          text={
            cells.length
              ? t("bots.check.settingsText", {
                  positive: ready.settings.positive,
                  total: ready.settings.total,
                })
              : t("bots.check.settingsNone")
          }
        />
        <Check
          ok={ready.outOfSample.ok}
          title={t("bots.check.outOfSample")}
          text={t("bots.check.outOfSampleText", {
            out: pct(ready.outOfSample.outOfSample),
            in: pct(ready.outOfSample.inSample),
          })}
        />
        <Check
          ok={ready.concentration.ok}
          title={t("bots.check.concentration")}
          text={t("bots.check.concentrationText", {
            n: ready.concentration.trade ?? "-",
            share: formatNumber(ready.concentration.share * 100, 0),
          })}
        />
        <Check
          ok={ready.costs.ok}
          title={t("bots.check.costs")}
          text={t("bots.check.costsText", { share: formatNumber(ready.costs.share * 100, 1) })}
        />
      </section>

      <section className="bt-panel">
        <h2>{t("bots.inVsOut")}</h2>
        <p className="bt-muted">{t("bots.inVsOutNote", { inDays, outDays: spec.holdOutDays })}</p>
        <table className="bt-table bt-compact">
          <thead>
            <tr>
              <th />
              <th className="num">{t("bots.inDays", { days: inDays })}</th>
              <th className="num">{t("bots.outDays", { days: spec.holdOutDays })}</th>
            </tr>
          </thead>
          <tbody>
            <Pair label={t("bots.stat.return")} a={pct(inS.return)} b={pct(outS.return)} />
            <Pair label={t("bots.per30")} a={pct(inS.per30Days)} b={pct(outS.per30Days)} />
            <Pair
              label={t("bots.stat.maxDrawdown")}
              a={pct(inS.maxDrawdown)}
              b={pct(outS.maxDrawdown)}
            />
            <Pair label={t("bots.tradesOpened")} a={String(inS.trades)} b={String(outS.trades)} />
            <Pair
              label={t("bots.stat.winRate")}
              a={`${formatNumber(inS.winRate * 100, 0)}%`}
              b={`${formatNumber(outS.winRate * 100, 0)}%`}
            />
            <Pair
              label={t("bots.stat.profitFactor")}
              a={finite(inS.profitFactor)}
              b={finite(outS.profitFactor)}
            />
            <Pair label={t("bots.buyHold")} a={pct(inS.buyHold)} b={pct(outS.buyHold)} />
          </tbody>
        </table>
        {Number.isFinite(inS.profitFactor) && outS.profitFactor < inS.profitFactor * 0.5 && (
          <p className="bt-warn">
            {t("bots.pfFell", { from: finite(inS.profitFactor), to: finite(outS.profitFactor) })}
          </p>
        )}
      </section>

      <section className="bt-panel">
        <h2>{t("bots.sweep")}</h2>
        <p className="bt-muted">{t("bots.sweepNote", { count: cells.length })}</p>
        {cells.length ? (
          <>
            <div
              className="bt-sweep"
              style={{ gridTemplateColumns: `2.5em repeat(${SWEEP_FAST.length}, 1fr)` }}
            >
              {[...SWEEP_SLOW].reverse().map((slow) => (
                <div key={slow} className="bt-sweep-row">
                  <span className="bt-axis-label pd-num">{slow}</span>
                  {SWEEP_FAST.map((fast) => {
                    const cell = cells.find((c) => c.fast === fast && c.slow === slow);
                    const v = cell?.return ?? 0;
                    const strength = Math.min(1, Math.abs(v) / 0.12);
                    return (
                      <span
                        key={fast}
                        className="bt-sweep-cell pd-num"
                        data-sign={v >= 0 ? "up" : "down"}
                        data-current={
                          (spec.ema?.fast === fast && spec.ema?.slow === slow) || undefined
                        }
                        style={{ "--strength": strength.toFixed(2) } as React.CSSProperties}
                      >
                        {pct(v)}
                      </span>
                    );
                  })}
                </div>
              ))}
              <div className="bt-sweep-row">
                <span />
                {SWEEP_FAST.map((f) => (
                  <span key={f} className="bt-axis-label pd-num">
                    {f}
                  </span>
                ))}
              </div>
            </div>
            <p className="bt-muted bt-split">
              <span>{t("bots.sweepAxes")}</span>
              <span>
                {t("bots.sweepPositive", {
                  positive: ready.settings.positive,
                  total: ready.settings.total,
                })}
              </span>
            </p>
          </>
        ) : (
          <p className="pd-empty">{t("bots.sweepGrid")}</p>
        )}
      </section>

      <section className="bt-panel">
        <h2>{t("bots.rOutcomes")}</h2>
        <p className="bt-muted">{t("bots.rOutcomesNote")}</p>
        <div className="bt-chart-box bt-chart-short">
          <BarsChart
            values={buckets}
            labels={R_BUCKETS.map((r, i) =>
              i === R_BUCKETS.length - 1 ? `+${r}+` : `${r > 0 ? "+" : ""}${r}`,
            )}
            tones={R_BUCKETS.map((r) => (r < 0 ? "sell" : r === 0 ? "muted" : "buy"))}
            showValues
          />
        </div>
        {best && stats.net > 0 && best.pnl / stats.net > 0.5 && (
          <p className="bt-warn">
            {t("bots.withoutBest", {
              n: best.n,
              r: formatSigned(best.r),
              share: formatNumber((best.pnl / stats.net) * 100, 0),
              ret: pct(withoutBest(stats, trades, spec.capital)),
            })}
          </p>
        )}
      </section>

      <section className="bt-panel">
        <h2>{t("bots.dailyReturns")}</h2>
        <p className="bt-muted">{t("bots.dailyReturnsNote")}</p>
        <DailyCalendar days={daily} holdOutStart={holdOutStart} />
        <p className="bt-muted bt-split">
          <span className="bt-scale">
            {t("bots.loss")}
            <i data-v="-2" />
            <i data-v="-1" />
            <i data-v="0" />
            <i data-v="1" />
            <i data-v="2" />
            {t("bots.gainScale", { full: formatNumber(FULL_COLOUR * 100, 0) })}
          </span>
          <span className="pd-num">
            {t("bots.upDown", {
              up: daily.filter((d) => d.value > 0).length,
              down: daily.filter((d) => d.value < 0).length,
            })}
          </span>
        </p>
      </section>

      <section className="bt-panel">
        <h2>{t("bots.grossToNet")}</h2>
        <p className="bt-muted">{t("bots.grossToNetNote")}</p>
        <div className="bt-costs">
          {[
            { label: t("bots.grossPnl"), value: gross, tone: "muted" },
            { label: t("bots.stat.fees"), value: costs.fees, tone: "sell" },
            { label: t("bots.stat.slippage"), value: costs.slippage, tone: "sell" },
            {
              label: t("bots.stat.funding"),
              value: costs.funding,
              tone: costs.funding < 0 ? "sell" : "buy",
            },
            { label: t("bots.stat.net"), value: stats.net, tone: "muted" },
          ].map((row) => (
            <div key={row.label} className="bt-cost">
              <span>{row.label}</span>
              <span className="bt-cost-bar">
                <span
                  data-tone={row.tone}
                  style={{
                    width: `${Math.min(100, (Math.abs(row.value) / Math.max(1, Math.abs(gross))) * 100)}%`,
                  }}
                />
              </span>
              <span className="pd-num">{formatSigned(row.value)}</span>
            </div>
          ))}
        </div>
        <p className="bt-muted">
          {t("bots.costsShare", { share: formatNumber(costShare * 100, 1) })}
          <br />
          {t("bots.fillModel", { bps: spec.slippageBps, fee: formatNumber(spec.fee * 100, 3) })}
        </p>
      </section>

      <section className="bt-panel">
        <h2>{t("bots.monteCarlo")}</h2>
        <p className="bt-muted">
          {t("bots.monteCarloNote", { trades: trades.length, runs: mc.runs })}
        </p>
        <div className="bt-chart-box bt-chart-short">
          <BarsChart
            values={mc.buckets}
            labels={mc.buckets.map((_, i) =>
              i === 0 ? "0" : formatNumber(-i * MONTE_CARLO_STEP * 100, 0),
            )}
            tones={mc.buckets.map((_, i) =>
              Math.floor(-stats.drawdown.max / MONTE_CARLO_STEP) === i ? "run" : "muted",
            )}
          />
        </div>
        <dl className="bt-mc">
          <div>
            <dt>{t("bots.median")}</dt>
            <dd className="pd-num">{pct(mc.median)}</dd>
          </div>
          <div>
            <dt>{t("bots.oneIn", { n: 20 })}</dt>
            <dd className="pd-num">{pct(mc.p95)}</dd>
          </div>
          <div>
            <dt>{t("bots.oneIn", { n: 100 })}</dt>
            <dd className="pd-num">{pct(mc.p99)}</dd>
          </div>
        </dl>
        <p className="bt-muted">
          {t("bots.monteCarloSize", {
            share: formatNumber(mc.worseThanRun * 100, 0),
            size: pct(mc.p95),
            run: pct(stats.drawdown.max),
          })}
        </p>
      </section>
    </div>
  );
}

function Check({ ok, title, text }: { ok: boolean; title: string; text: string }) {
  return (
    <div className="bt-check" data-ok={ok || undefined}>
      {ok ? <LuCircleCheck size={18} aria-hidden /> : <LuCircleAlert size={18} aria-hidden />}
      <div>
        <strong>{title}</strong>
        <span>{text}</span>
      </div>
    </div>
  );
}

function Pair({ label, a, b }: { label: string; a: string; b: string }) {
  return (
    <tr>
      <td>{label}</td>
      <td className="num pd-num">{a}</td>
      <td className="num pd-num">{b}</td>
    </tr>
  );
}

/** Each day of the run as a square, by weekday; the held-out days outlined. */
function DailyCalendar({
  days,
  holdOutStart,
}: {
  days: readonly { day: number; value: number }[];
  holdOutStart: number;
}) {
  const first = days[0]?.day ?? 0;
  // Weeks start on Monday; the first column begins on the first day's Monday.
  const offset = (new Date(first).getUTCDay() + 6) % 7;
  const weeks = Math.ceil((offset + days.length) / 7);
  const byIndex = new Map(days.map((d) => [Math.round((d.day - first) / DAY) + offset, d]));
  const label = (row: number) => weekday().format(new Date(Date.UTC(2024, 0, 1 + row)));
  return (
    <div
      className="bt-calendar"
      style={{ gridTemplateColumns: `3em repeat(${weeks}, minmax(0, 26px))` }}
    >
      {Array.from({ length: 7 }, (_, row) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: a row is its weekday
        <div key={row} className="bt-calendar-row">
          <span className="bt-axis-label">{row % 2 === 0 ? label(row) : ""}</span>
          {Array.from({ length: weeks }, (_, col) => {
            const d = byIndex.get(col * 7 + row);
            // biome-ignore lint/suspicious/noArrayIndexKey: a column is its week
            if (!d) return <span key={col} className="bt-day" data-empty />;
            const strength = Math.min(1, Math.abs(d.value) / FULL_COLOUR);
            return (
              <span
                // biome-ignore lint/suspicious/noArrayIndexKey: a column is its week
                key={col}
                className="bt-day"
                title={`${dateFormat({ day: "numeric", month: "short", timeZone: "UTC" }).format(d.day)} · ${pct(d.value, 2)}`}
                data-sign={d.value > 0 ? "up" : d.value < 0 ? "down" : undefined}
                data-out={d.day >= holdOutStart || undefined}
                style={{ "--strength": strength.toFixed(2) } as React.CSSProperties}
              />
            );
          })}
        </div>
      ))}
    </div>
  );
}
