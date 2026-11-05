import { dateFormat, formatMoney, t } from "@pewterdesk/ui";
import { useMemo } from "react";
import { LuCheck, LuLightbulb } from "react-icons/lu";
import { rOf, skippedItems, utcDay } from "../../lib/journal";
import {
  avgR,
  byPlaybook,
  cumulativeR,
  findings,
  followedVsSkipped,
  groupOf,
  notesByDay,
  winRate,
} from "../../lib/journalStats";
import type { PlanContext } from "./PlanPage";
import {
  breakLabel,
  Card,
  CumulativeChart,
  CurveLegend,
  formatR,
  groupLine,
  Kpis,
  Money,
  PageHead,
  pct,
  RText,
  Segment,
  Stat,
  useKept,
} from "./parts";

const RANGES = ["week", "plan", "d90"] as const;
type Range = (typeof RANGES)[number];
const SHORT_DATE: Intl.DateTimeFormatOptions = { month: "short", day: "numeric", timeZone: "UTC" };
const BREAK_TIME: Intl.DateTimeFormatOptions = {
  month: "short",
  day: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  timeZone: "UTC",
};

/**
 * The review, after the Review mockup (80): a week, the plan's life, or 90
 * days - R by playbook, followed against skipped, every rule break, and a few
 * plain observations worth a look.
 */
export function ReviewView({ ctx }: { ctx: PlanContext }) {
  const [range, setRange] = useKept<Range>("plan.reviewRange", "week");
  const now = Date.now();
  const planStart = ctx.plan?.changes[0]?.at;
  const from = useMemo(() => {
    if (range === "week")
      return Date.parse(
        `${utcDay(now - ((new Date(now).getUTCDay() + 6) % 7) * 86_400_000)}T00:00:00Z`,
      );
    if (range === "plan" && planStart) return planStart;
    return now - 90 * 86_400_000;
  }, [range, now, planStart]);
  const trades = ctx.trades.filter((x) => x.note.trade.closedAt >= from);
  const notes = trades.map((x) => x.note);
  const all = groupOf(notes);
  const withList = notes.filter((n) => n.checklist.length > 0);
  const followedCount = withList.filter((n) => skippedItems(n) === 0).length;
  const breakNotes = trades.filter((x) => x.note.breaks.length > 0);
  const days = [...notesByDay(notes).entries()].map(([day, list]) => ({
    day,
    pnl: list.reduce((s, n) => s + n.trade.pnl, 0),
  }));
  const worst = days.sort((a, b) => a.pnl - b.pnl)[0];
  const curve = cumulativeR(notes);
  const playbooks = byPlaybook(notes);
  const split = followedVsSkipped(notes);
  const found = findings(notes);
  const plan = ctx.plan;
  const name = (id: string) =>
    id ? (ctx.playbooks.get(id)?.name ?? t("plan.pb.deleted")) : t("plan.pb.noneLabel");

  const rangeText = `${dateFormat(SHORT_DATE).format(from)} – ${dateFormat(SHORT_DATE).format(now)}`;

  return (
    <div className="jr-view">
      <PageHead
        eyebrow={t("plan.tab.review")}
        title={t(`plan.r.${range}` as const)}
        meta={
          <>
            <span className="pd-num">{rangeText}</span>
            {plan && <span>{t("plan.version", { v: plan.version })}</span>}
          </>
        }
        actions={
          <Segment
            label={t("plan.r.range")}
            value={range}
            options={RANGES.filter((r) => r !== "plan" || planStart).map((r) => ({
              value: r,
              label: t(`plan.r.${r}` as const),
            }))}
            onChange={setRange}
          />
        }
      />

      <Kpis>
        <Stat
          label={t("plan.net")}
          value={<Money value={all.pnl} />}
          note={
            plan?.target
              ? t("plan.r.ofTarget", {
                  pct: pct(all.pnl / plan.target, 1),
                  target: formatMoney(plan.target),
                })
              : undefined
          }
        />
        <Stat
          label={t("plan.total")}
          value={<RText r={all.withR ? all.totalR : undefined} />}
          note={t("plan.r.perTrade", { r: formatR(avgR(all)) })}
        />
        <Stat
          label={t("plan.trades")}
          value={all.trades}
          note={t("plan.winPct", { v: pct(winRate(all)) })}
        />
        <Stat
          label={t("plan.r.checklistFollowed")}
          value={withList.length ? pct(followedCount / withList.length) : "-"}
          note={
            withList.length
              ? t("plan.rule.ofN", { n: followedCount, of: withList.length })
              : undefined
          }
        />
        <Stat
          label={t("plan.ruleBreaks")}
          value={
            <span data-tone={breakNotes.length ? "warn" : undefined}>{breakNotes.length}</span>
          }
        />
        <Stat
          label={t("plan.plan.worstDay")}
          value={worst ? <Money value={worst.pnl} /> : "-"}
          note={worst ? dateFormat(SHORT_DATE).format(Date.parse(worst.day)) : undefined}
        />
      </Kpis>

      <section className="jr-findings" aria-label={t("plan.r.worthALook")}>
        <header className="jr-findings-head">
          <h3>
            <LuLightbulb size={14} aria-hidden /> {t("plan.r.worthALook")}
          </h3>
          <span className="jr-grow" />
          <button
            type="button"
            className="jr-button jr-quiet"
            onClick={() => ctx.openDay(utcDay(now))}
          >
            {t("plan.r.addNote")}
          </button>
          <button type="button" className="jr-button jr-quiet" onClick={() => ctx.goTo("plan")}>
            {t("plan.r.changePlan")}
          </button>
        </header>
        {found.length === 0 ? (
          <p className="jr-muted">{t("plan.r.nothing")}</p>
        ) : (
          <ul className="jr-finding-list">
            {found.map((f) => (
              <li key={f.kind + ("day" in f ? f.day : "")} data-kind={f.kind}>
                {f.kind === "skippedMost"
                  ? t("plan.r.skippedMost", {
                      name: name(f.playbookId),
                      n: f.skipped,
                      of: f.trades,
                    })
                  : f.kind === "worstDay"
                    ? t("plan.r.worstDayLine", {
                        day: dateFormat(SHORT_DATE).format(Date.parse(f.day)),
                        pnl: formatMoney(f.pnl),
                        n: f.trades,
                      })
                    : f.kind === "gaveBack"
                      ? t("plan.r.gaveBack", {
                          day: dateFormat(SHORT_DATE).format(Date.parse(f.day)),
                          peak: formatR(f.peakR, 1),
                          end: formatR(f.endR, 1),
                        })
                      : t("plan.r.lucky", { n: f.count })}
              </li>
            ))}
          </ul>
        )}
      </section>

      <div className="jr-split">
        <Card title={t("plan.cumulativeR")} sub={t("plan.r.onePoint")} aside={<CurveLegend />}>
          <CumulativeChart points={curve} />
        </Card>
        <aside className="jr-rail">
          <Card title={t("plan.r.followedVsSkipped")}>
            <div className="jr-vs">
              {(
                [
                  [
                    "followed",
                    t("plan.pb.followedN", { n: split.followed.trades }),
                    split.followed,
                  ],
                  ["skipped", t("plan.pb.skippedN", { n: split.skipped.trades }), split.skipped],
                  ["none", t("plan.r.noPlaybookN", { n: split.none.trades }), split.none],
                ] as const
              ).map(([key, label, g]) => (
                <div key={key} className="jr-vs-row" data-kind={key}>
                  <span className="jr-vs-label">{label}</span>
                  <strong>
                    <RText r={avgR(g)} />
                  </strong>
                  <span className="jr-stat-note">{groupLine(g)}</span>
                </div>
              ))}
            </div>
          </Card>
        </aside>
      </div>

      <div className="jr-grid-2">
        <Card title={t("plan.r.byPlaybook")} foot={t("plan.r.fewTrades")} flush>
          <table className="pd-table jr-table">
            <thead>
              <tr>
                <th>{t("plan.pb.playbook")}</th>
                <th className="pd-num">{t("plan.trades")}</th>
                <th className="pd-num">{t("plan.win")}</th>
                <th className="pd-num">{t("plan.avgR")}</th>
                <th className="pd-num">{t("plan.total")}</th>
                <th className="pd-num">{t("plan.checklist")}</th>
              </tr>
            </thead>
            <tbody>
              {[...playbooks.entries()].map(([id, s]) => (
                <tr key={id || "none"}>
                  <td className={id ? undefined : "jr-muted"}>{name(id)}</td>
                  <td className="pd-num">{s.group.trades}</td>
                  <td className="pd-num">{pct(winRate(s.group))}</td>
                  <td className="pd-num">
                    <RText r={avgR(s.group)} />
                  </td>
                  <td className="pd-num">
                    <RText r={s.group.withR ? s.group.totalR : undefined} digits={1} />
                  </td>
                  <td
                    className="pd-num"
                    data-tone={id && s.followed / s.group.trades < 0.75 ? "warn" : undefined}
                  >
                    {id ? pct(s.followed / s.group.trades) : "-"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
        <Card title={t("plan.ruleBreaks")} sub={String(breakNotes.length)} flush>
          {breakNotes.length === 0 ? (
            <p className="jr-quiet-note jr-pad">
              <LuCheck size={14} aria-hidden /> {t("plan.r.noBreaks")}
            </p>
          ) : (
            <ul className="jr-recent">
              {breakNotes.map((x) => (
                <li key={x.key}>
                  <button type="button" onClick={() => ctx.openTrade(x.key)}>
                    <span className="jr-recent-main">
                      <span className="jr-warn">{x.note.breaks.map(breakLabel).join(", ")}</span>
                      <span className="jr-muted">
                        {dateFormat(BREAK_TIME).format(
                          x.note.trade.openedAt ?? x.note.trade.closedAt,
                        )}{" "}
                        UTC · {name(x.note.playbookId ?? "")} · {ctx.symbolFor(x.note.trade.market)}
                      </span>
                    </span>
                    <RText r={rOf(x.note)} />
                  </button>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>
    </div>
  );
}
