import { formatSigned, type MessageKey, t } from "@pewterdesk/ui";
import { useMemo } from "react";
import { type RunSpec, runDays, runStats } from "../../lib/backtest";
import { resultOf, useRuns } from "../../lib/botEngine";
import { type Bot, PAPER_DAYS } from "../../lib/bots";
import { Empty } from "./ui";

const KIND: Record<Bot["kind"], MessageKey> = {
  grid: "bots.kind.grid",
  dca: "bots.kind.dca",
  trend: "bots.kind.trend",
  custom: "bots.kind.custom",
};
const toneOf = (v: number | undefined) =>
  v === undefined || v === 0 ? undefined : v > 0 ? "up" : "down";

interface PaperListProps {
  bots: readonly Bot[];
  runs: readonly RunSpec[];
  onPause: (bot: Bot) => void;
  onResume: (bot: Bot) => void;
  onOpenRun: (run: number) => void;
  /** To the backtests, to pick one to paper trade. */
  onPick: () => void;
  marketLabel: (bot: Bot) => string;
  venueLabel: (bot: Bot) => string;
}

/**
 * The bots on paper: how far into their week they are, and how they're doing
 * against what their backtest made over as many days, the first sign of a
 * backtest that won't hold up.
 */
export function PaperList({
  bots,
  runs,
  onPause,
  onResume,
  onOpenRun,
  onPick,
  marketLabel,
  venueLabel,
}: PaperListProps) {
  // What each run made a day on average, for the comparison.
  const version = useRuns();
  // biome-ignore lint/correctness/useExhaustiveDependencies: `version` brings engine runs in
  const perDay = useMemo(() => {
    const out = new Map<number, number>();
    for (const spec of runs) {
      if (!bots.some((b) => b.run === spec.id)) continue;
      const result = resultOf(spec);
      if (result) out.set(spec.id, runStats(result).net / Math.max(1, runDays(spec)));
    }
    return out;
  }, [runs, bots, version]);

  if (bots.length === 0) {
    return (
      <Empty
        title={t("bots.empty.paperTitle")}
        text={t("bots.empty.paperText", { days: PAPER_DAYS })}
        action={t("bots.empty.paperAction")}
        onAction={onPick}
      />
    );
  }
  return (
    <section className="bt-panel bt-library">
      <h2>
        {t("bots.paper.title")}
        <span className="bt-spacer" />
        <span className="bt-muted">{t("bots.paper.note", { days: PAPER_DAYS })}</span>
      </h2>
      <div className="bt-table-wrap">
        <table className="bt-table">
          <thead>
            <tr>
              <th>{t("bots.paper.bot")}</th>
              <th>{t("bots.paper.progress")}</th>
              <th className="num">{t("bots.paper.pnl")}</th>
              <th className="num">{t("bots.paper.expected")}</th>
              <th>{t("bots.paper.status")}</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {bots.map((bot) => {
              const day = bot.paperDay ?? 1;
              const rate = bot.run === undefined ? undefined : perDay.get(bot.run);
              const expected = rate === undefined ? undefined : rate * bot.days;
              const left = Math.max(0, PAPER_DAYS - day);
              return (
                <tr key={bot.id}>
                  <td>
                    <strong>{bot.name ?? t(KIND[bot.kind])}</strong>{" "}
                    <span className="bt-muted">{`${marketLabel(bot)} · ${venueLabel(bot)}`}</span>
                  </td>
                  <td>
                    <span className="bt-progress">
                      <span className="bt-meter" aria-hidden>
                        <span
                          className="bt-meter-fill bt-meter-brass"
                          style={{ width: `${(Math.min(day, PAPER_DAYS) / PAPER_DAYS) * 100}%` }}
                        />
                      </span>
                      <span className="pd-num">
                        {t("bots.mode.paperDay", { day, days: PAPER_DAYS })}
                      </span>
                      <span className="bt-muted">
                        {left > 0 ? t("bots.paper.daysLeft", { days: left }) : t("bots.paper.done")}
                      </span>
                    </span>
                  </td>
                  <td className="num pd-num" data-trend={toneOf(bot.sinceStart)}>
                    {formatSigned(bot.sinceStart)}
                  </td>
                  <td className="num pd-num" data-trend={toneOf(expected)}>
                    {expected === undefined ? "-" : formatSigned(expected)}
                  </td>
                  <td>{t(`bots.state.${bot.state}`)}</td>
                  <td>
                    <div className="bt-row-actions">
                      {bot.state === "running" ? (
                        <button type="button" className="bt-button" onClick={() => onPause(bot)}>
                          {t("bots.action.pause")}
                        </button>
                      ) : (
                        <button type="button" className="bt-button" onClick={() => onResume(bot)}>
                          {t("bots.action.start")}
                        </button>
                      )}
                      {bot.run !== undefined && (
                        <button
                          type="button"
                          className="bt-button"
                          onClick={() => onOpenRun(bot.run as number)}
                        >
                          {t("bots.action.backtest")}
                        </button>
                      )}
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}
