import { dateFormat, formatNumber, formatSigned, type MessageKey, t } from "@pewterdesk/ui";
import { type ReactNode, useState } from "react";
import {
  DEFAULT_EMA,
  type ExitReason,
  holdOutFor,
  PERIODS,
  type RunResult,
  type RunSpec,
  type RunStats,
  runDays,
  type Trade,
  withPeriod,
} from "../../lib/backtest";
import { ruleText } from "./CustomRules";
import { EquityChart } from "./charts";
import { Row } from "./NewBot";
import { HelpTip, TEMPLATE_LABEL } from "./ui";

const pct = (v: number, dp = 1) => `${formatSigned(v * 100, dp)}%`;
const day = () => dateFormat({ day: "numeric", month: "short", timeZone: "UTC" });
const stamp = () =>
  dateFormat({
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZone: "UTC",
  });
export const finite = (v: number, dp = 2) => (Number.isFinite(v) ? formatNumber(v, dp) : "∞");

export const EXIT: Record<ExitReason, MessageKey> = {
  cross: "bots.exit.cross",
  stop: "bots.exit.stop",
  end: "bots.exit.end",
  grid: "bots.exit.grid",
  stopOut: "bots.exit.stopOut",
  rule: "bots.exit.rule",
  target: "bots.exit.target",
};

/** One figure in a tile: a label, the value, and a line under it. */
function Tile({
  label,
  value,
  note,
  tone,
  help,
}: {
  label: string;
  value: string;
  note: ReactNode;
  tone?: "up" | "down";
  /** What the figure means, behind a "?". */
  help?: string;
}) {
  return (
    <div className="bt-tile">
      <span className="bt-tile-label">
        {label}
        {help && <HelpTip title={label} text={help} />}
      </span>
      <strong className="pd-num" data-trend={tone}>
        {value}
      </strong>
      <span className="bt-tile-note">{note}</span>
    </div>
  );
}

const percentOrNone = (v: number) =>
  v > 0 ? `${formatNumber(v * 100, v * 100 < 10 ? 1 : 0)}%` : t("bots.custom.none");

const toneOf = (v: number) => (v > 0 ? "up" : v < 0 ? "down" : undefined);

interface BacktestOverviewProps {
  result: RunResult;
  stats: RunStats;
  onRerun: (spec: Omit<RunSpec, "id">) => void;
  onOpenTrades: () => void;
}

/** The run at a glance: its settings, the headline figures, the equity curve and the latest trades. */
export function BacktestOverview({ result, stats, onRerun, onOpenTrades }: BacktestOverviewProps) {
  const { spec } = result;
  const times = result.bars.map((b) => b.time);
  const decimals = spec.startPrice >= 1000 ? 1 : spec.startPrice >= 10 ? 2 : 3;
  return (
    <div className="bt-overview">
      <Settings key={spec.id} spec={spec} onRerun={onRerun} />
      <div className="bt-tiles">
        <Tile
          label={t("bots.stat.net")}
          value={formatSigned(stats.net)}
          tone={toneOf(stats.net)}
          help={t("bots.help.net")}
          note={t("bots.stat.netNote", { ret: pct(stats.return), hold: pct(stats.buyHold) })}
        />
        <Tile
          label={t("bots.stat.maxDrawdown")}
          value={pct(stats.drawdown.max)}
          tone={stats.drawdown.max < 0 ? "down" : undefined}
          help={t("bots.help.maxDrawdown")}
          note={
            stats.drawdown.open
              ? t("bots.stat.ddOpen", { date: day().format(stats.drawdown.at) })
              : day().format(stats.drawdown.at)
          }
        />
        <Tile
          label={t("bots.stat.sharpe")}
          value={formatNumber(stats.sharpe, 2)}
          help={t("bots.help.sharpe")}
          note={t("bots.stat.sharpeNote", { sortino: formatNumber(stats.sortino, 2) })}
        />
        <Tile
          label={t("bots.stat.profitFactor")}
          value={finite(stats.profitFactor)}
          help={t("bots.help.profitFactor")}
          note={t("bots.stat.profitFactorNote")}
        />
        <Tile
          label={t("bots.stat.winRate")}
          value={`${formatNumber(stats.winRate * 100, 0)}%`}
          help={t("bots.help.winRate")}
          note={t("bots.stat.winRateNote", {
            wins: stats.wins,
            trades: stats.trades,
            ratio: formatNumber(stats.winLossRatio, 1),
          })}
        />
        <Tile
          label={t("bots.stat.outOfSample")}
          value={pct(stats.outOfSample)}
          tone={toneOf(stats.outOfSample)}
          help={t("bots.help.outOfSample")}
          note={t("bots.stat.outOfSampleNote", {
            days: spec.holdOutDays,
            inSample: pct(stats.inSample),
          })}
        />
      </div>
      <section className="bt-panel bt-equity">
        <h2>
          {t("bots.equity")}
          <span className="bt-legend bt-legend-strategy">{t("bots.strategyLine")}</span>
          <span className="bt-legend bt-legend-hold">{t("bots.buyHold")}</span>
          <span className="bt-spacer" />
          {stats.outOfSample < 0 || stats.outOfSample < stats.buyHold ? (
            <span className="bt-flag">
              {stats.outOfSample <= 0 ? t("bots.flag.flatOut") : t("bots.flag.trailsHold")}
            </span>
          ) : null}
        </h2>
        {result.trades.length === 0 && !result.stoppedOut && (
          <p className="bt-warn">
            {t(spec.template === "custom" ? "bots.noTradesCustom" : "bots.noTrades")}
          </p>
        )}
        {result.stoppedOut && (
          <p className="bt-warn">
            {result.stoppedOut.index === 0
              ? t("bots.stoppedAtStart")
              : t("bots.stoppedOut", {
                  date: day().format(times[result.stoppedOut.index] ?? 0),
                  price: formatNumber(result.stoppedOut.price, decimals),
                })}
          </p>
        )}
        <div className="bt-chart-box">
          <EquityChart
            times={times}
            lines={[
              { values: result.equity, className: "bt-line-strategy" },
              { values: result.buyHold, className: "bt-line-hold" },
            ]}
            holdOutFrom={result.holdOutFrom}
            holdOutLabel={t("bots.outOfSampleDays", { days: spec.holdOutDays })}
            drawdown={stats.drawdown.series}
            drawdownLabel={
              <>
                <span>{t("bots.drawdown")}</span>
                <span className="pd-num">
                  {t("bots.maxAt", {
                    value: pct(stats.drawdown.max),
                    date: day().format(stats.drawdown.at),
                  })}
                </span>
              </>
            }
            tagLast
          />
        </div>
      </section>
      <section className="bt-panel bt-stats">
        <h2>{t("bots.statistics")}</h2>
        <dl className="bt-rows">
          <Row label={t("bots.stat.return")}>{pct(stats.return, 2)}</Row>
          <Row label={t("bots.buyHold")}>{pct(stats.buyHold, 2)}</Row>
          <Row label={t("bots.stat.maxDrawdown")}>{pct(stats.drawdown.max, 2)}</Row>
          <Row label={t("bots.stat.longestDrawdown")}>
            {t("bots.days", { days: formatNumber(stats.drawdown.longestDays, 1) })}
          </Row>
          <Row label={t("bots.stat.sharpeSortino")}>
            {`${formatNumber(stats.sharpe, 2)} · ${formatNumber(stats.sortino, 2)}`}
          </Row>
          <Row label={t("bots.stat.calmar")}>{formatNumber(stats.calmar, 2)}</Row>
          <Row label={t("bots.stat.profitFactor")}>{finite(stats.profitFactor)}</Row>
          <Row label={t("bots.stat.expectancy")}>
            {`${formatSigned(stats.expectancy)} · ${formatSigned(stats.expectancyR)}R`}
          </Row>
          <Row label={t("bots.stat.avgWinLoss")}>
            {`${formatSigned(stats.avgWin)} · ${formatSigned(stats.avgLoss)}`}
          </Row>
          <Row label={t("bots.stat.avgHold")}>
            {t("bots.hours", { hours: formatNumber(stats.avgHoldHours, 1) })}
          </Row>
          <Row
            label={t("bots.stat.timeInMarket")}
          >{`${formatNumber(stats.timeInMarket * 100, 0)}%`}</Row>
          <Row label={t("bots.stat.fees")}>{formatSigned(stats.fees)}</Row>
          <Row label={t("bots.stat.funding")}>{formatSigned(stats.funding)}</Row>
          <Row label={t("bots.stat.slippage")}>{formatSigned(stats.slippage)}</Row>
        </dl>
        <p className="bt-muted">{t("bots.statsNote")}</p>
      </section>
      <section className="bt-panel bt-recent">
        <h2>
          {t("bots.trades", { count: stats.trades })}
          <span className="bt-spacer" />
          <button type="button" className="bt-link" onClick={onOpenTrades}>
            {t("bots.openTrades")}
          </button>
        </h2>
        <TradesTable trades={[...result.trades].reverse().slice(0, 6)} decimals={decimals} />
      </section>
    </div>
  );
}

/** Trades, newest first, as a table; one can be picked. */
export function TradesTable({
  trades,
  decimals,
  selected,
  onSelect,
  detailed,
}: {
  trades: readonly Trade[];
  decimals: number;
  selected?: number;
  onSelect?: (n: number) => void;
  detailed?: boolean;
}) {
  return (
    <div className="bt-table-wrap">
      <table className="bt-table">
        <thead>
          <tr>
            <th>#</th>
            <th>{t("bots.col.side")}</th>
            <th>{t("bots.col.opened")}</th>
            <th>{t("bots.col.closed")}</th>
            <th className="num">{t("bots.col.entry")}</th>
            <th className="num">{t("bots.col.exit")}</th>
            <th className="num">{t("bots.col.size")}</th>
            <th className="num">{t("bots.col.pnl")}</th>
            <th className="num">R</th>
            {detailed && <th className="num">{t("bots.col.hold")}</th>}
            {detailed && <th className="num">{t("bots.col.fees")}</th>}
            <th>{t("bots.col.exitReason")}</th>
            {!detailed && <th>{t("bots.col.sample")}</th>}
          </tr>
        </thead>
        <tbody>
          {trades.map((tr) => (
            <tr
              key={tr.n}
              aria-selected={selected === tr.n || undefined}
              onClick={onSelect && (() => onSelect(tr.n))}
              data-clickable={onSelect ? "" : undefined}
            >
              <td className="pd-num">{tr.n}</td>
              <td data-trend={tr.side === "long" ? "up" : "down"}>
                {t(tr.side === "long" ? "side.long" : "side.short")}
              </td>
              <td className="pd-num">{stamp().format(tr.openTime)}</td>
              <td className="pd-num">{stamp().format(tr.closeTime)}</td>
              <td className="num pd-num">{formatNumber(tr.entry, decimals)}</td>
              <td className="num pd-num">{formatNumber(tr.exit, decimals)}</td>
              <td className="num pd-num">{formatNumber(tr.size, tr.size >= 100 ? 1 : 3)}</td>
              <td className="num pd-num" data-trend={toneOf(tr.pnl)}>
                {formatSigned(tr.pnl)}
              </td>
              <td className="num pd-num" data-trend={toneOf(tr.r)}>
                {`${formatSigned(tr.r)}R`}
              </td>
              {detailed && (
                <td className="num pd-num">
                  {t("bots.hoursShort", {
                    hours: formatNumber((tr.closeTime - tr.openTime) / 3_600_000, 0),
                  })}
                </td>
              )}
              {detailed && <td className="num pd-num">{formatSigned(tr.fees)}</td>}
              <td>{t(EXIT[tr.exitReason])}</td>
              {!detailed && <td>{t(tr.outOfSample ? "bots.sample.out" : "bots.sample.in")}</td>}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/**
 * The run's settings, editable: a changed one runs again as a new run, so
 * every run stays as it was made.
 */
function Settings({
  spec,
  onRerun,
}: {
  spec: RunSpec;
  onRerun: (spec: Omit<RunSpec, "id">) => void;
}) {
  const ema = spec.ema ?? DEFAULT_EMA;
  const [draft, setDraft] = useState(() => ({
    fast: String(ema.fast),
    slow: String(ema.slow),
    stopAtr: String(ema.stopAtr),
    risk: String(ema.risk * 100),
    maxLeverage: String(ema.maxLeverage),
    capital: String(spec.capital),
    fee: String(spec.fee * 100),
    slippageBps: String(spec.slippageBps),
    holdOutDays: String(spec.holdOutDays),
  }));
  const [days, setDays] = useState(() => runDays(spec));
  const field = (key: keyof typeof draft, label: string, unit?: string) => (
    <div className="bt-setting">
      <span>{label}</span>
      <span className="bt-input bt-input-small">
        <input
          className="pd-num"
          inputMode="decimal"
          value={draft[key]}
          onChange={(e) => setDraft({ ...draft, [key]: e.target.value.replace(",", ".") })}
        />
        {unit && <em>{unit}</em>}
      </span>
    </div>
  );
  const fixed = (label: string, value: string) => (
    <div className="bt-setting">
      <span>{label}</span>
      <span className="bt-value pd-num">{value}</span>
    </div>
  );
  const n = (k: keyof typeof draft) => Number(draft[k]);
  const periods = PERIODS[spec.template].includes(runDays(spec))
    ? PERIODS[spec.template]
    : [...PERIODS[spec.template], runDays(spec)].sort((a, b) => a - b);
  const valid =
    n("capital") > 0 &&
    n("fee") >= 0 &&
    n("slippageBps") >= 0 &&
    n("holdOutDays") >= 1 &&
    n("holdOutDays") < days &&
    (spec.template !== "ema" ||
      (n("fast") >= 2 &&
        n("slow") > n("fast") &&
        n("stopAtr") > 0 &&
        n("risk") > 0 &&
        n("maxLeverage") >= 1));
  const g = spec.grid;
  return (
    <aside className="bt-panel bt-settings" aria-label={t("bots.settings")}>
      <h3>{t("bots.strategy")}</h3>
      {spec.name && fixed(t("bots.name"), spec.name)}
      {fixed(t("bots.template"), t(TEMPLATE_LABEL[spec.template]))}
      {spec.template === "custom" && spec.custom ? (
        <>
          {fixed(
            t("bots.custom.side"),
            t(spec.custom.side === "long" ? "side.long" : "side.short"),
          )}
          <div className="bt-setting bt-setting-rules">
            <span>{t("bots.custom.entry")}</span>
            <ul>
              {spec.custom.entry.map((r) => (
                <li key={ruleText(r)}>{ruleText(r)}</li>
              ))}
            </ul>
          </div>
          <div className="bt-setting bt-setting-rules">
            <span>{t("bots.custom.exit")}</span>
            <ul>
              {spec.custom.exit.length === 0 ? (
                <li>{t("bots.custom.noExit")}</li>
              ) : (
                spec.custom.exit.map((r) => <li key={ruleText(r)}>{ruleText(r)}</li>)
              )}
            </ul>
          </div>
          {fixed(t("bots.custom.stopLoss"), percentOrNone(spec.custom.stopLoss))}
          {fixed(t("bots.custom.takeProfit"), percentOrNone(spec.custom.takeProfit))}
          {fixed(t("bots.custom.size"), `${formatNumber(spec.custom.size * 100, 0)}%`)}
        </>
      ) : spec.template === "grid" && g ? (
        <>
          {fixed(t("bots.grid.range"), `${formatNumber(g.lower, 2)} – ${formatNumber(g.upper, 2)}`)}
          {fixed(t("bots.grid.levels"), String(g.levels))}
          {fixed(t("bots.grid.size"), formatNumber(g.sizePerLevel, 4))}
          {fixed(
            t("bots.grid.stopOut"),
            `${formatNumber(g.stopBelow, 2)} · ${formatNumber(g.stopAbove, 2)}`,
          )}
        </>
      ) : (
        <>
          {field("fast", t("bots.ema.fast"))}
          {field("slow", t("bots.ema.slow"))}
          {field("stopAtr", t("bots.ema.stop"), "× ATR")}
          {fixed(t("bots.ema.exit"), t("bots.exit.oppositeCross"))}
          {fixed(t("bots.ema.direction"), t(`bots.direction.${ema.direction}`))}
          {field("risk", t("bots.ema.risk"), "%")}
          {field("maxLeverage", t("bots.ema.leverage"), "×")}
        </>
      )}
      <h3>{t("bots.marketData")}</h3>
      {fixed(t("bots.market"), spec.market)}
      {fixed(t("bots.ema.interval"), spec.interval)}
      <div className="bt-setting">
        <span>{t("bots.period")}</span>
        <span className="bt-seg bt-seg-small" role="radiogroup" aria-label={t("bots.period")}>
          {periods.map((d) => (
            // biome-ignore lint/a11y/useSemanticElements: a segmented choice, like the app's others
            <button
              key={d}
              type="button"
              role="radio"
              aria-checked={days === d}
              onClick={() => {
                setDays(d);
                setDraft({ ...draft, holdOutDays: String(holdOutFor(d)) });
              }}
            >
              {t("bots.periodShort", { days: d })}
            </button>
          ))}
        </span>
      </div>
      <h3>{t("bots.executionModel")}</h3>
      {field("capital", t("bots.capital"), "USD")}
      {field("fee", t("bots.fees"), "%")}
      {field("slippageBps", t("bots.slippage"), "bps")}
      {fixed(t("bots.fills"), t("bots.fillsValue"))}
      {fixed(t("bots.funding"), t("bots.fundingValue"))}
      <h3>{t("bots.validation")}</h3>
      {field("holdOutDays", t("bots.holdOut"), t("bots.daysUnit"))}
      {fixed(t("bots.data"), t("bots.dataSample"))}
      <div className="bt-settings-actions">
        <button
          type="button"
          className="bt-button"
          data-primary
          disabled={!valid}
          onClick={() => {
            const { id: _, ...same } = spec;
            const rest = days === runDays(spec) ? same : withPeriod(same, days);
            onRerun({
              ...rest,
              ...(spec.template !== "ema"
                ? {}
                : {
                    ema: {
                      ...ema,
                      fast: Math.round(n("fast")),
                      slow: Math.round(n("slow")),
                      stopAtr: n("stopAtr"),
                      risk: n("risk") / 100,
                      maxLeverage: n("maxLeverage"),
                    },
                  }),
              capital: n("capital"),
              fee: n("fee") / 100,
              slippageBps: n("slippageBps"),
              holdOutDays: Math.round(n("holdOutDays")),
            });
          }}
        >
          {t("bots.runAgain")}
        </button>
      </div>
    </aside>
  );
}
