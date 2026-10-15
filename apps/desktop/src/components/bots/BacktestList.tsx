import { formatNumber, formatSigned, t } from "@pewterdesk/ui";
import { useMemo, useState } from "react";
import { LuCircleAlert, LuCircleCheck } from "react-icons/lu";
import {
  type RunSpec,
  runBacktest,
  runDays,
  runStats,
  type Template,
  verdict,
} from "../../lib/backtest";
import { runName } from "./Backtest";
import { Empty, TEMPLATE_LABEL } from "./ui";

type Kind = "all" | Template;
const pct = (v: number) => `${formatSigned(v * 100, 1)}%`;
const toneOf = (v: number) => (v > 0 ? "up" : v < 0 ? "down" : undefined);

interface BacktestListProps {
  runs: readonly RunSpec[];
  onOpen: (run: number) => void;
  onNew: () => void;
  marketLabel: (venue: string, market: string) => string;
  venueLabel: (venue: string) => string;
}

/** Every backtest run, newest first, with its headline figures and whether it's ready. */
export function BacktestList({ runs, onOpen, onNew, marketLabel, venueLabel }: BacktestListProps) {
  const [kind, setKind] = useState<Kind>("all");
  const rows = useMemo(
    () =>
      [...runs].reverse().map((spec) => {
        const result = runBacktest(spec);
        const stats = runStats(result);
        return { spec, stats, verdict: verdict(result, stats) };
      }),
    [runs],
  );
  if (runs.length === 0) {
    return (
      <Empty
        title={t("bots.empty.backtestsTitle")}
        text={t("bots.empty.backtestsText")}
        action={t("bots.newBacktest")}
        onAction={onNew}
      />
    );
  }
  const shown = rows.filter((r) => kind === "all" || r.spec.template === kind);
  return (
    <section className="bt-panel bt-library">
      <h2>
        <span className="bt-seg" role="radiogroup" aria-label={t("bots.template")}>
          {(["all", "grid", "ema", "custom"] as const).map((k) => (
            // biome-ignore lint/a11y/useSemanticElements: a segmented choice, like the app's others
            <button
              key={k}
              type="button"
              role="radio"
              aria-checked={kind === k}
              onClick={() => setKind(k)}
            >
              {k === "all" ? t("bots.filter.all") : t(TEMPLATE_LABEL[k])}
            </button>
          ))}
        </span>
        <span className="bt-spacer" />
        <span className="bt-muted">{t("bots.libraryNote")}</span>
      </h2>
      <div className="bt-table-wrap">
        <table className="bt-table">
          <thead>
            <tr>
              <th>{t("bots.run")}</th>
              <th>{t("bots.market")}</th>
              <th className="num">{t("bots.period")}</th>
              <th className="num">{t("bots.col.trades")}</th>
              <th className="num">{t("bots.stat.net")}</th>
              <th className="num">{t("bots.col.maxDd")}</th>
              <th className="num">{t("bots.stat.outOfSample")}</th>
              <th>{t("bots.verdict")}</th>
            </tr>
          </thead>
          <tbody>
            {shown.map(({ spec, stats, verdict: v }) => (
              <tr key={spec.id} data-clickable="" onClick={() => onOpen(spec.id)}>
                <td>
                  <button
                    type="button"
                    className="bt-link"
                    onClick={(e) => {
                      e.stopPropagation();
                      onOpen(spec.id);
                    }}
                  >
                    <span className="pd-num bt-muted">#{spec.id}</span> {runName(spec)}
                  </button>
                </td>
                <td>
                  {`${marketLabel(spec.venue, spec.market)} · ${venueLabel(spec.venue)} · ${spec.interval}`}
                </td>
                <td className="num pd-num">{t("bots.days", { days: runDays(spec) })}</td>
                <td className="num pd-num">{stats.trades}</td>
                <td className="num pd-num" data-trend={toneOf(stats.net)}>
                  {formatSigned(stats.net)}
                </td>
                <td className="num pd-num" data-trend={stats.drawdown.max < 0 ? "down" : undefined}>
                  {`${formatNumber(stats.drawdown.max * 100, 1)}%`}
                </td>
                <td className="num pd-num" data-trend={toneOf(stats.outOfSample)}>
                  {pct(stats.outOfSample)}
                </td>
                <td>
                  <VerdictChip failing={v.failing} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

/** "Ready" or "2 of 4 checks fail", as a chip. */
export function VerdictChip({ failing }: { failing: number }) {
  return (
    <span className="bt-verdict-chip" data-ok={failing === 0 || undefined}>
      {failing === 0 ? (
        <LuCircleCheck size={12} aria-hidden />
      ) : (
        <LuCircleAlert size={12} aria-hidden />
      )}
      {failing === 0 ? t("bots.verdict.ready") : t("bots.verdict.failing", { failing, total: 4 })}
    </span>
  );
}
