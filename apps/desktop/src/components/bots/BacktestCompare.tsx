import { formatNumber, formatSigned, t } from "@pewterdesk/ui";
import { useMemo, useState } from "react";
import { DEFAULT_EMA, type RunSpec, runStats } from "../../lib/backtest";
import { resultOf, useRuns } from "../../lib/botEngine";
import { runName } from "./Backtest";
import { finite } from "./BacktestOverview";
import { ruleText } from "./CustomRules";
import { EquityChart, type Line } from "./charts";

const MAX_SHOWN = 4;
const pct = (v: number, dp = 1) => `${formatSigned(v * 100, dp)}%`;

/** Runs comparable with `current`: the same market, timeframe, period and template. */
const comparable = (a: RunSpec, b: RunSpec) =>
  a.template === b.template &&
  a.market === b.market &&
  a.venue === b.venue &&
  a.interval === b.interval &&
  a.bars === b.bars &&
  a.seed === b.seed;

interface BacktestCompareProps {
  runs: readonly RunSpec[];
  current: RunSpec;
  onOpen: (run: number) => void;
  onDuplicate: (run: RunSpec) => void;
  onDelete: (ids: readonly number[]) => void;
}

/** The run beside the others on the same market and period: equity, settings and results. */
export function BacktestCompare({
  runs,
  current,
  onOpen,
  onDuplicate,
  onDelete,
}: BacktestCompareProps) {
  const peers = useMemo(() => runs.filter((r) => comparable(r, current)), [runs, current]);
  const version = useRuns();
  // biome-ignore lint/correctness/useExhaustiveDependencies: `version` brings engine runs in
  const results = useMemo(
    () =>
      peers
        .flatMap((spec) => {
          const result = resultOf(spec);
          return result ? [{ spec, result, stats: runStats(result) }] : [];
        })
        .sort((a, b) => b.stats.outOfSample - a.stats.outOfSample),
    [peers, version],
  );
  const [ticked, setTicked] = useState<number[]>(() =>
    [current.id, ...results.map((r) => r.spec.id).filter((id) => id !== current.id)].slice(0, 3),
  );
  const shown = results.filter((r) => ticked.includes(r.spec.id));
  const first = results[0];
  const holdStats = first ? first.stats.buyHold : 0;
  const lines: Line[] = shown.map((r, i) => ({
    values: r.result.equity,
    className: r.spec.id === current.id ? "bt-line-strategy" : `bt-line-run-${i + 1}`,
  }));
  if (first) lines.push({ values: first.result.buyHold, className: "bt-line-hold" });
  const toggle = (id: number) =>
    setTicked((now) =>
      now.includes(id) ? now.filter((x) => x !== id) : now.length >= MAX_SHOWN ? now : [...now, id],
    );
  const beatsHold = results.some((r) => r.stats.return > holdStats);
  const settingRows: { label: string; value: (r: RunSpec) => string }[] =
    current.template === "custom"
      ? [
          {
            label: t("bots.custom.side"),
            value: (r) => t(r.custom?.side === "short" ? "side.short" : "side.long"),
          },
          {
            label: t("bots.custom.entry"),
            value: (r) => (r.custom?.entry ?? []).map(ruleText).join(" · "),
          },
          {
            label: t("bots.custom.exit"),
            value: (r) => (r.custom?.exit ?? []).map(ruleText).join(" · ") || "-",
          },
          {
            label: t("bots.custom.stopLoss"),
            value: (r) => `${formatNumber((r.custom?.stopLoss ?? 0) * 100, 1)}%`,
          },
          {
            label: t("bots.custom.takeProfit"),
            value: (r) => `${formatNumber((r.custom?.takeProfit ?? 0) * 100, 1)}%`,
          },
          {
            label: t("bots.custom.size"),
            value: (r) => `${formatNumber((r.custom?.size ?? 0) * 100, 0)}%`,
          },
          { label: t("bots.ema.interval"), value: (r) => r.interval },
        ]
      : current.template === "grid"
        ? [
            { label: t("bots.grid.lower"), value: (r) => formatNumber(r.grid?.lower ?? 0, 2) },
            { label: t("bots.grid.upper"), value: (r) => formatNumber(r.grid?.upper ?? 0, 2) },
            { label: t("bots.grid.levels"), value: (r) => String(r.grid?.levels ?? "-") },
            {
              label: t("bots.grid.size"),
              value: (r) => formatNumber(r.grid?.sizePerLevel ?? 0, 4),
            },
          ]
        : [
            { label: t("bots.ema.fast"), value: (r) => String((r.ema ?? DEFAULT_EMA).fast) },
            { label: t("bots.ema.slow"), value: (r) => String((r.ema ?? DEFAULT_EMA).slow) },
            {
              label: t("bots.ema.stopShort"),
              value: (r) => formatNumber((r.ema ?? DEFAULT_EMA).stopAtr, 1),
            },
            {
              label: t("bots.ema.risk"),
              value: (r) => `${formatNumber((r.ema ?? DEFAULT_EMA).risk * 100, 1)}%`,
            },
            {
              label: t("bots.ema.leverage"),
              value: (r) => `${(r.ema ?? DEFAULT_EMA).maxLeverage}×`,
            },
            {
              label: t("bots.ema.direction"),
              value: (r) => t(`bots.direction.${(r.ema ?? DEFAULT_EMA).direction}`),
            },
            { label: t("bots.ema.interval"), value: (r) => r.interval },
          ];

  return (
    <div className="bt-compare">
      <section className="bt-panel bt-equity">
        <h2>
          {t("bots.equity")}
          {shown.map((r, i) => (
            <span
              key={r.spec.id}
              className={`bt-legend ${r.spec.id === current.id ? "bt-legend-strategy" : `bt-legend-run-${i + 1}`}`}
            >
              #{r.spec.id} {runName(r.spec)}
            </span>
          ))}
          <span className="bt-legend bt-legend-hold">{t("bots.buyHold")}</span>
          <span className="bt-spacer" />
          <span className="bt-muted">{t("bots.sameEverything")}</span>
        </h2>
        <div className="bt-chart-box">
          {first && (
            <EquityChart
              times={first.result.bars.map((b) => b.time)}
              lines={lines}
              holdOutFrom={first.result.holdOutFrom}
              holdOutLabel={t("bots.outOfSampleDays", { days: current.holdOutDays })}
            />
          )}
        </div>
      </section>

      <section className="bt-panel bt-diff">
        <h2>{t("bots.whatsDifferent")}</h2>
        <p className="bt-muted">{t("bots.whatsDifferentNote")}</p>
        <table className="bt-table bt-compact bt-wrap">
          <thead>
            <tr>
              <th />
              {shown.map((r, i) => (
                <th
                  key={r.spec.id}
                  className={`num ${r.spec.id === current.id ? "bt-text-strategy" : `bt-text-run-${i + 1}`}`}
                >
                  #{r.spec.id}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {settingRows.map((row) => {
              const values = shown.map((r) => row.value(r.spec));
              const differs = new Set(values).size > 1;
              return (
                <tr key={row.label}>
                  <td>{row.label}</td>
                  {values.map((v, i) => (
                    <td
                      // biome-ignore lint/suspicious/noArrayIndexKey: one column per shown run, in order
                      key={i}
                      className="num pd-num"
                      data-changed={(differs && v !== row.value(current)) || undefined}
                    >
                      {v}
                    </td>
                  ))}
                </tr>
              );
            })}
          </tbody>
        </table>
      </section>

      <section className="bt-panel bt-runs">
        <h2>
          {t("bots.runs")}
          <span className="bt-muted">{t("bots.runsNote", { max: MAX_SHOWN })}</span>
          <span className="bt-spacer" />
          <button
            type="button"
            className="bt-button"
            disabled={ticked.filter((id) => id !== current.id).length === 0}
            onClick={() => {
              const ids = ticked.filter((id) => id !== current.id);
              onDelete(ids);
              setTicked([current.id]);
            }}
          >
            {t("bots.deleteSelected")}
          </button>
        </h2>
        <div className="bt-table-wrap">
          <table className="bt-table">
            <thead>
              <tr>
                <th />
                <th>{t("bots.run")}</th>
                <th>{t("bots.settings")}</th>
                <th className="num">{t("bots.stat.return")}</th>
                <th className="num">{t("bots.col.maxDd")}</th>
                <th className="num">{t("bots.stat.sharpe")}</th>
                <th className="num">{t("bots.col.pf")}</th>
                <th className="num">{t("bots.col.trades")}</th>
                <th className="num">{t("bots.col.win")}</th>
                <th className="num">{t("bots.stat.outOfSample")}</th>
                <th className="num">{t("bots.stat.fees")}</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {results.map((r) => {
                const index = shown.findIndex((s) => s.spec.id === r.spec.id);
                return (
                  <tr key={r.spec.id} aria-selected={r.spec.id === current.id || undefined}>
                    <td>
                      <input
                        type="checkbox"
                        aria-label={t("bots.compareRun", { id: r.spec.id })}
                        checked={ticked.includes(r.spec.id)}
                        disabled={!ticked.includes(r.spec.id) && ticked.length >= MAX_SHOWN}
                        onChange={() => toggle(r.spec.id)}
                      />
                    </td>
                    <td className="pd-num">
                      <span
                        className={`bt-swatch ${
                          index === -1
                            ? ""
                            : r.spec.id === current.id
                              ? "bt-swatch-strategy"
                              : `bt-swatch-run-${index + 1}`
                        }`}
                        aria-hidden
                      />
                      #{r.spec.id}
                    </td>
                    <td>
                      {runName(r.spec)}
                      {r.spec.id === current.id && (
                        <span className="bt-muted"> {t("bots.thisRun")}</span>
                      )}
                    </td>
                    <td className="num pd-num" data-trend={r.stats.return >= 0 ? "up" : "down"}>
                      {pct(r.stats.return)}
                    </td>
                    <td className="num pd-num">{pct(r.stats.drawdown.max)}</td>
                    <td className="num pd-num">{formatNumber(r.stats.sharpe, 2)}</td>
                    <td className="num pd-num">{finite(r.stats.profitFactor)}</td>
                    <td className="num pd-num">{r.stats.trades}</td>
                    <td className="num pd-num">{`${formatNumber(r.stats.winRate * 100, 0)}%`}</td>
                    <td
                      className="num pd-num"
                      data-trend={r.stats.outOfSample >= 0 ? "up" : "down"}
                    >
                      {pct(r.stats.outOfSample)}
                    </td>
                    <td className="num pd-num">{formatSigned(r.stats.fees)}</td>
                    <td className="bt-row-actions">
                      <button type="button" className="bt-button" onClick={() => onOpen(r.spec.id)}>
                        {t("bots.open")}
                      </button>
                      <button
                        type="button"
                        className="bt-button"
                        onClick={() => onDuplicate(r.spec)}
                      >
                        {t("bots.duplicate")}
                      </button>
                    </td>
                  </tr>
                );
              })}
              {first && (
                <tr className="bt-ref">
                  <td />
                  <td>{t("bots.ref")}</td>
                  <td>{t("bots.refHold", { market: current.market })}</td>
                  <td className="num pd-num">{pct(first.stats.buyHold)}</td>
                  <td className="num pd-num">-</td>
                  <td className="num pd-num">-</td>
                  <td className="num pd-num">-</td>
                  <td className="num pd-num">-</td>
                  <td className="num pd-num">-</td>
                  <td className="num pd-num">-</td>
                  <td className="num pd-num">-</td>
                  <td />
                </tr>
              )}
            </tbody>
          </table>
        </div>
        <p className="bt-footnote">
          {beatsHold ? t("bots.someBeatHold") : t("bots.noneBeatHold", { market: current.market })}
        </p>
      </section>
    </div>
  );
}
