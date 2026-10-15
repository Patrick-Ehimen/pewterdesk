import { formatNumber, Select, t } from "@pewterdesk/ui";
import { useMemo } from "react";
import { LuArrowRight, LuCircleAlert, LuCircleCheck } from "react-icons/lu";
import { type RunSpec, runBacktest, runStats, type Verdict, verdict } from "../../lib/backtest";
import { PAPER_DAYS } from "../../lib/bots";
import { BacktestAnalysis } from "./BacktestAnalysis";
import { BacktestCompare } from "./BacktestCompare";
import { BacktestOverview } from "./BacktestOverview";
import { BacktestTrades } from "./BacktestTrades";
import { type Crumb, Crumbs } from "./ui";

export type BacktestTab = "overview" | "trades" | "analysis" | "compare";
const TABS: readonly BacktestTab[] = ["overview", "trades", "analysis", "compare"];

/** "EMA 9/26 · stop 2.0× ATR", "Grid 13 · 79,800 – 83,400" or "Custom · long · 2 rules", after its name if it has one. */
export function runName(spec: RunSpec): string {
  const what = describe(spec);
  return spec.name ? `${spec.name} · ${what}` : what;
}

function describe(spec: RunSpec): string {
  if (spec.template === "custom" && spec.custom) {
    const c = spec.custom;
    return t("bots.run.custom", {
      side: t(c.side === "long" ? "side.long" : "side.short"),
      count: c.entry.length + c.exit.length,
    });
  }
  if (spec.template === "grid" && spec.grid) {
    const g = spec.grid;
    return t("bots.run.grid", {
      levels: g.levels,
      lower: formatNumber(g.lower, g.lower >= 100 ? 0 : 2),
      upper: formatNumber(g.upper, g.upper >= 100 ? 0 : 2),
    });
  }
  const e = spec.ema;
  return t("bots.run.ema", {
    fast: e?.fast ?? 0,
    slow: e?.slow ?? 0,
    stop: formatNumber(e?.stopAtr ?? 0, 1),
  });
}

interface BacktestProps {
  /** The trail back: the page, its section, this run. */
  crumbs: readonly Crumb[];
  runs: readonly RunSpec[];
  run: number;
  tab: BacktestTab;
  onTab: (tab: BacktestTab) => void;
  onRun: (run: number) => void;
  onBack: () => void;
  onNewRun: (spec: Omit<RunSpec, "id">) => void;
  onDelete: (ids: readonly number[]) => void;
  onSaveAsBot: (run: RunSpec) => void;
  onPaperTrade: (run: RunSpec) => void;
  marketLabel: (venue: string, market: string) => string;
  venueLabel: (venue: string) => string;
}

/** One backtest run: its overview, trades, analysis, and how it compares with the others. */
export function Backtest({
  crumbs,
  runs,
  run: runId,
  tab,
  onTab,
  onRun,
  onBack,
  onNewRun,
  onDelete,
  onSaveAsBot,
  onPaperTrade,
  marketLabel,
  venueLabel,
}: BacktestProps) {
  const spec = runs.find((r) => r.id === runId) ?? runs.at(-1);
  const result = useMemo(() => (spec ? runBacktest(spec) : undefined), [spec]);
  const stats = useMemo(() => (result ? runStats(result) : undefined), [result]);
  const assessed = useMemo(
    () => (result && stats ? verdict(result, stats) : undefined),
    [result, stats],
  );
  if (!spec || !result || !stats || !assessed) {
    return (
      <>
        <button type="button" className="bt-button" onClick={onBack}>
          {t("bots.back")}
        </button>
        <p className="pd-empty">{t("bots.noRuns")}</p>
      </>
    );
  }
  const subject = `${marketLabel(spec.venue, spec.market)} · ${venueLabel(spec.venue)} · ${spec.interval}`;
  return (
    <>
      <header className="bt-head">
        <Crumbs items={crumbs} />
        <span className="bt-spacer" />
        <span className="bt-muted pd-num">
          {t("bots.runMeta", { id: spec.id, candles: result.bars.length, trades: stats.trades })}
        </span>
        <button type="button" className="bt-button" onClick={() => onSaveAsBot(spec)}>
          {t("bots.saveAsBot")}
        </button>
        <button
          type="button"
          className="bt-button"
          data-primary
          title={t("bots.paperTradeHint", { days: PAPER_DAYS })}
          onClick={() => onPaperTrade(spec)}
        >
          {t("bots.paperTradeThis")}
        </button>
      </header>
      <div className="bt-subhead">
        <Select
          className="bt-run-select"
          label={t("bots.run")}
          value={String(spec.id)}
          options={[...runs].reverse().map((r) => ({
            value: String(r.id),
            label: `#${r.id} · ${runName(r)} · ${marketLabel(r.venue, r.market)} · ${r.interval}`,
          }))}
          onChange={(v) => onRun(Number(v))}
        />
        <nav className="bt-tabs" aria-label={t("bots.backtest")}>
          {TABS.map((id) => (
            <button
              key={id}
              type="button"
              aria-current={tab === id ? "page" : undefined}
              onClick={() => onTab(id)}
            >
              {t(`bots.tab.${id}`)}
            </button>
          ))}
        </nav>
        <span className="bt-spacer" />
        <span className="bt-subject">{subject}</span>
      </div>
      {tab !== "analysis" && (
        <VerdictStrip verdict={assessed} onDetails={() => onTab("analysis")} />
      )}
      {tab === "overview" && (
        <BacktestOverview
          result={result}
          stats={stats}
          onRerun={onNewRun}
          onOpenTrades={() => onTab("trades")}
        />
      )}
      {tab === "trades" && <BacktestTrades result={result} stats={stats} />}
      {tab === "analysis" && <BacktestAnalysis result={result} stats={stats} verdict={assessed} />}
      {tab === "compare" && (
        <BacktestCompare
          runs={runs}
          current={spec}
          onOpen={onRun}
          onDuplicate={(r) => {
            const { id: _, ...copy } = r;
            onNewRun(copy);
          }}
          onDelete={onDelete}
        />
      )}
    </>
  );
}

/** The run's verdict in a line, above every tab but the one that explains it. */
function VerdictStrip({ verdict: v, onDetails }: { verdict: Verdict; onDetails: () => void }) {
  const ok = v.failing === 0;
  const failing = [
    !v.checks.settings.ok && t("bots.check.settings"),
    !v.checks.outOfSample.ok && t("bots.check.outOfSample"),
    !v.checks.concentration.ok && t("bots.check.concentration"),
    !v.checks.costs.ok && t("bots.check.costs"),
  ].filter(Boolean);
  return (
    <div className="bt-verdict" data-ok={ok || undefined} role="status">
      {ok ? <LuCircleCheck size={16} aria-hidden /> : <LuCircleAlert size={16} aria-hidden />}
      <strong className="bt-verdict-title">
        {ok ? t("bots.ready.yes") : t("bots.ready.no", { failing: v.failing, total: 4 })}
      </strong>
      <span className="bt-muted">
        {ok ? t("bots.verdict.nextPaper", { days: PAPER_DAYS }) : failing.join(" · ")}
      </span>
      <span className="bt-spacer" />
      <button type="button" className="bt-link" onClick={onDetails}>
        {t("bots.verdict.details")}
        <LuArrowRight size={13} aria-hidden />
      </button>
    </div>
  );
}
