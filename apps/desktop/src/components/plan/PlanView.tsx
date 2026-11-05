import { dateFormat, formatMoney, formatNumber, t } from "@pewterdesk/ui";
import { type ReactNode, useMemo, useState } from "react";
import {
  LuArrowRight,
  LuLock,
  LuPencil,
  LuScrollText,
  LuShieldCheck,
  LuTrash2,
} from "react-icons/lu";
import { isMarketRule, minutesOf, newPlan, type Plan, utcDay } from "../../lib/journal";
import { avgR, byPlaybook, groupOf } from "../../lib/journalStats";
import { MarketPicker } from "./MarketPicker";
import type { PlanContext } from "./PlanPage";
import {
  ActionBar,
  Blank,
  Card,
  ChipGroup,
  ConfirmButton,
  Field,
  FormSection,
  hueOf,
  Kpis,
  LinesEditor,
  Money,
  marketHue,
  marketsLine,
  NumberInput,
  PageHead,
  Pill,
  PLAN_HUES,
  pct,
  ROUTINE_HUES,
  RText,
  SpreadText,
  Stat,
  TextArea,
  tagHue,
  timeframeHue,
  timeframesOf,
  useKept,
  WEEKDAY_HUES,
} from "./parts";

const WEEKDAYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"] as const;
const SHORT_DATE: Intl.DateTimeFormatOptions = { month: "short", day: "numeric", timeZone: "UTC" };

type Mode = "enforced" | "warns" | "reminder";
interface RuleRow {
  from: "rules" | "plan";
  name: string;
  limit: string;
  mode: Mode;
  today?: string;
}

/**
 * The account's trading plan: the goal and how far along it is, the rules
 * (the trading rules Rust enforces, plus the plan's own, which the journal
 * marks), the routine, the session, its playbooks and its history of changes.
 * Edited whole; each save is a new version.
 */
export function PlanView({ ctx }: { ctx: PlanContext }) {
  const [editing, setEditing] = useKept<Plan | undefined>(
    `plan.planEdit:${ctx.accountKey}`,
    undefined,
  );
  const plan = ctx.plan;
  if (editing)
    return (
      <PlanEditor
        ctx={ctx}
        draft={editing}
        onDraft={setEditing}
        onDone={() => setEditing(undefined)}
      />
    );
  if (!plan)
    return (
      <div className="jr-view">
        <PageHead eyebrow={t("plan.tab.plan")} title={t("plan.plan.noneTitle")} />
        <Card className="jr-fill">
          <Blank
            icon={<LuScrollText size={22} aria-hidden />}
            title={t("plan.plan.write")}
            action={
              <button
                type="button"
                className="jr-button jr-primary"
                onClick={() =>
                  setEditing({
                    ...newPlan(),
                    startBalance: Math.round((ctx.equity ?? 0) * 100) / 100,
                  })
                }
              >
                {t("plan.plan.write")}
              </button>
            }
          >
            {t("plan.plan.noneBody")}
          </Blank>
        </Card>
      </div>
    );
  return <PlanSheet ctx={ctx} plan={plan} onEdit={() => setEditing(plan)} />;
}

function ruleRows(ctx: PlanContext, plan: Plan): RuleRow[] {
  const rules = ctx.rules?.on ? ctx.rules.rules : undefined;
  const status = ctx.rulesStatus;
  const rows: RuleRow[] = [];
  if (rules) {
    const size = rules.challenge.size;
    rows.push(
      {
        from: "rules",
        name: t("plan.rule.dailyLoss"),
        limit: `${formatMoney((size * rules.challenge.dailyPct) / 100)} · ${rules.challenge.dailyPct}%`,
        mode: "enforced",
        today: status
          ? t("plan.rule.used", { v: formatMoney(Math.max(0, -status.dayPnl)) })
          : undefined,
      },
      {
        from: "rules",
        name: t("plan.rule.drawdown"),
        limit: `${rules.challenge.maxPct}%`,
        mode: "enforced",
      },
      {
        from: "rules",
        name: t("plan.riskPerTrade"),
        limit: `${rules.tradeLoss.pct}% · ${formatMoney((size * rules.tradeLoss.pct) / 100)}`,
        mode: rules.tradeLoss.mode === "stop" ? "enforced" : "warns",
      },
      {
        from: "rules",
        name: t("plan.rule.tradesPerDay"),
        limit: String(rules.tradesPerDay),
        mode: "enforced",
        today: status
          ? t("plan.rule.ofN", { n: status.tradesToday, of: rules.tradesPerDay })
          : undefined,
      },
      {
        from: "rules",
        name: t("plan.rule.hours"),
        limit: `${rules.hours.from}–${rules.hours.to} UTC`,
        mode: "enforced",
      },
    );
    if (rules.news.on)
      rows.push({
        from: "rules",
        name: t("plan.rule.news"),
        limit: `±${rules.news.minutes} min`,
        mode: "enforced",
      });
    if (rules.challenge.minDays > 0)
      rows.push({
        from: "rules",
        name: t("plan.rule.minDays"),
        limit: String(rules.challenge.minDays),
        mode: "reminder",
        today: status ? t("plan.rule.done", { n: status.tradingDays }) : undefined,
      });
  }
  rows.push(
    {
      from: "plan",
      name: t("plan.rule.session"),
      limit: `${plan.sessions.start}–${plan.sessions.end} UTC`,
      mode: "warns",
    },
    {
      from: "plan",
      name: t("plan.rule.playbooks"),
      limit: t("plan.rule.onlyN", { n: plan.playbookIds.length }),
      mode: "warns",
    },
  );
  if (plan.markets.length)
    rows.push({
      from: "plan",
      name: t("plan.rule.markets"),
      limit: marketsLine(plan.markets, ctx.markets, ctx.symbolFor),
      mode: "warns",
    });
  if (plan.maxTradesPerDay)
    rows.push({
      from: "plan",
      name: t("plan.rule.tradesPerDay"),
      limit: String(plan.maxTradesPerDay),
      mode: "warns",
    });
  if (plan.dailyStop)
    rows.push({
      from: "plan",
      name: t("plan.dailyStop"),
      limit: formatMoney(plan.dailyStop),
      mode: "warns",
    });
  if (plan.maxLossesInRow)
    rows.push({
      from: "plan",
      name: t("plan.lossesInRow"),
      limit: String(plan.maxLossesInRow),
      mode: "warns",
    });
  return rows;
}

function PlanSheet({ ctx, plan, onEdit }: { ctx: PlanContext; plan: Plan; onEdit: () => void }) {
  const notes = ctx.trades.map((x) => x.note);
  const total = groupOf(notes);
  const days = useMemo(() => {
    const byDay = new Map<string, number>();
    for (const n of notes)
      byDay.set(utcDay(n.trade.closedAt), (byDay.get(utcDay(n.trade.closedAt)) ?? 0) + n.trade.pnl);
    return byDay;
  }, [notes]);
  const worst = [...days.entries()].sort((a, b) => a[1] - b[1])[0];
  const stats = byPlaybook(notes);
  const progress = plan.target > 0 ? Math.max(0, Math.min(1, total.pnl / plan.target)) : 0;
  const rows = ruleRows(ctx, plan);
  const enforced = rows.filter((r) => r.from === "rules");
  const own = rows.filter((r) => r.from === "plan");
  const since = plan.changes[0]?.at;

  return (
    <div className="jr-view">
      <PageHead
        eyebrow={
          <>
            {t("plan.tab.plan")} · {t("plan.version", { v: plan.version })}
            {since && ` · ${t("plan.since", { date: dateFormat(SHORT_DATE).format(since) })}`}
          </>
        }
        title={plan.name || t("plan.plan.untitled")}
        actions={
          <>
            <ConfirmButton
              className="jr-button jr-danger"
              title={t("plan.confirm.planTitle")}
              body={t("plan.confirm.planBody")}
              action={t("plan.plan.delete")}
              danger
              onConfirm={() => void ctx.journal.removePlan().catch(() => {})}
            >
              <LuTrash2 size={13} aria-hidden /> {t("plan.plan.delete")}
            </ConfirmButton>
            <button type="button" className="jr-button" onClick={onEdit}>
              <LuPencil size={13} aria-hidden /> {t("plan.plan.edit")}
            </button>
          </>
        }
      />

      {plan.goal.trim() && (
        <SpreadText label={t("plan.plan.goal")} hue={PLAN_HUES.basics} text={plan.goal} />
      )}

      <Kpis>
        <Stat
          label={t("plan.plan.target")}
          value={<Money value={total.pnl} />}
          aside={
            plan.target > 0 && (
              <span className="jr-muted">{t("plan.of", { v: formatMoney(plan.target) })}</span>
            )
          }
          note={
            plan.target > 0 && (
              <span className="jr-progressline">
                <span className="jr-meter-track">
                  <span className="jr-meter-fill" style={{ width: `${progress * 100}%` }} />
                </span>
                {t("plan.plan.there", { pct: pct(progress) })}
              </span>
            )
          }
        />
        <Stat
          label={t("plan.total")}
          value={<RText r={total.withR ? total.totalR : undefined} />}
          note={t("plan.tradesN", { n: total.trades })}
        />
        <Stat
          label={t("plan.plan.worstDay")}
          value={worst ? <Money value={worst[1]} /> : "-"}
          note={worst ? dateFormat(SHORT_DATE).format(Date.parse(worst[0])) : undefined}
        />
        <Stat label={t("plan.plan.tradingDays")} value={days.size} />
      </Kpis>

      <div className="jr-split">
        <div className="jr-stack">
          <Card
            titleHue={PLAN_HUES.rules}
            title={t("plan.plan.rules")}
            sub={t("plan.plan.rulesSub")}
            aside={
              <button type="button" className="jr-link" onClick={ctx.onOpenRules}>
                {t("plan.plan.tradingRules")} <LuArrowRight size={12} aria-hidden />
              </button>
            }
            foot={t("plan.plan.rulesFoot")}
          >
            <RuleGroup
              icon={<LuShieldCheck size={14} aria-hidden />}
              title={t("plan.plan.enforcedGroup")}
              rows={enforced}
              base="enforced"
              empty={t("plan.plan.noRules")}
            />
            <RuleGroup title={t("plan.plan.journalGroup")} rows={own} base="warns" />
          </Card>

          <Card titleHue={PLAN_HUES.routine} title={t("plan.plan.routine")}>
            <div className="jr-two">
              <div>
                <span className="jr-label">{t("plan.plan.before")}</span>
                {plan.routine.before.length ? (
                  <ol className="jr-numbered" data-hue="" style={hueOf(ROUTINE_HUES.before)}>
                    {plan.routine.before.map((x) => (
                      <li key={x}>{x}</li>
                    ))}
                  </ol>
                ) : (
                  <p className="jr-muted">{t("plan.plan.noWords")}</p>
                )}
              </div>
              <div>
                <span className="jr-label">{t("plan.plan.after")}</span>
                {plan.routine.after.length ? (
                  <ol className="jr-numbered" data-hue="" style={hueOf(ROUTINE_HUES.after)}>
                    {plan.routine.after.map((x) => (
                      <li key={x}>{x}</li>
                    ))}
                  </ol>
                ) : (
                  <p className="jr-muted">{t("plan.plan.noWords")}</p>
                )}
              </div>
            </div>
          </Card>

          <Card titleHue={PLAN_HUES.ownWords} title={t("plan.plan.ownWords")}>
            {plan.creed && <blockquote className="jr-creed">{plan.creed}</blockquote>}
            {plan.ifThens.length > 0 && (
              <ul className="jr-ifthens">
                {plan.ifThens.map((x) => (
                  <li key={x.when}>
                    <span>{t("plan.plan.if", { when: x.when })}</span>
                    <span aria-hidden>→</span>
                    <span>{x.action}</span>
                  </li>
                ))}
              </ul>
            )}
            {!plan.creed && plan.ifThens.length === 0 && (
              <p className="jr-muted">{t("plan.plan.noWords")}</p>
            )}
          </Card>
        </div>

        <aside className="jr-rail">
          <Card
            titleHue={PLAN_HUES.sessions}
            title={t("plan.plan.sessions")}
            sub={t("plan.plan.utc")}
          >
            <SessionGrid plan={plan} />
          </Card>
          <Card
            titleHue={PLAN_HUES.playbooks}
            title={t("plan.plan.playbooksIn")}
            sub={String(plan.playbookIds.length)}
            aside={
              <button type="button" className="jr-link" onClick={() => ctx.goTo("playbooks")}>
                {t("plan.manage")}
              </button>
            }
          >
            {plan.playbookIds.length === 0 && (
              <p className="jr-muted">{t("plan.plan.noPlaybooks")}</p>
            )}
            <ul className="jr-list">
              {plan.playbookIds.map((id) => {
                const p = ctx.playbooks.get(id);
                const g = stats.get(id)?.group;
                if (!p) return null;
                return (
                  <li key={id}>
                    <span>
                      <strong>{p.name}</strong>
                      <span className="jr-pb-markets">
                        {p.markets.length > 4 || p.markets.some(isMarketRule) ? (
                          <span className="jr-muted">
                            {marketsLine(p.markets, ctx.markets, ctx.symbolFor, 3)}
                          </span>
                        ) : (
                          p.markets.map((m) => (
                            <span key={m} className="jr-tag" style={hueOf(marketHue(m))}>
                              {ctx.symbolFor(m)}
                            </span>
                          ))
                        )}
                        {timeframesOf(p.timeframe).map((tf) => (
                          <span key={tf} className="jr-tag" style={hueOf(timeframeHue(tf))}>
                            {tf}
                          </span>
                        ))}
                      </span>
                    </span>
                    <RText r={g ? avgR(g) : undefined} />
                  </li>
                );
              })}
            </ul>
          </Card>
          <Card
            titleHue={PLAN_HUES.changes}
            title={t("plan.plan.changes")}
            foot={t("plan.plan.changesFoot")}
          >
            <ol className="jr-timeline">
              {[...plan.changes].reverse().map((c, i) => (
                <li key={c.version} data-current={i === 0 || undefined}>
                  <span className="jr-timeline-head">
                    <strong>v{c.version}</strong>
                    <span className="jr-muted">{dateFormat(SHORT_DATE).format(c.at)}</span>
                  </span>
                  {c.note && <p>{c.note}</p>}
                </li>
              ))}
            </ol>
          </Card>
        </aside>
      </div>
    </div>
  );
}

function RuleGroup({
  icon,
  title,
  rows,
  base,
  empty,
}: {
  icon?: ReactNode;
  title: string;
  rows: RuleRow[];
  base: Mode;
  empty?: string;
}) {
  return (
    <div className="jr-rulegroup">
      <span className="jr-rulegroup-head">
        {icon}
        {title}
      </span>
      {rows.length === 0 ? (
        empty && <p className="jr-hint">{empty}</p>
      ) : (
        <ul className="jr-rules">
          {rows.map((r) => (
            <li key={`${r.from}:${r.name}`}>
              <span className="jr-rule-name">
                {r.name}
                {r.mode !== base && (
                  <Pill
                    tone={r.mode === "warns" ? "warn" : undefined}
                    icon={r.mode === "enforced" ? <LuLock size={10} aria-hidden /> : undefined}
                  >
                    {t(`plan.mode.${r.mode}` as const)}
                  </Pill>
                )}
              </span>
              <span className="jr-rule-limit pd-num">{r.limit}</span>
              <span className="jr-rule-today">{r.today}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function SessionGrid({ plan }: { plan: Plan }) {
  const start = (minutesOf(plan.sessions.start) / 1440) * 100;
  const end = (minutesOf(plan.sessions.end) / 1440) * 100;
  const now = new Date();
  const today = (now.getUTCDay() + 6) % 7;
  const nowAt = ((now.getUTCHours() * 60 + now.getUTCMinutes()) / 1440) * 100;
  const spans: [number, number][] =
    end > start
      ? [[start, end]]
      : [
          [start, 100],
          [0, end],
        ];
  return (
    <div className="jr-sessions" data-hue="">
      {WEEKDAYS.map((d, i) => (
        <div
          key={d}
          className="jr-session-row"
          data-today={i === today || undefined}
          style={hueOf(WEEKDAY_HUES[i] ?? 265)}
        >
          <span>{t(`plan.day.${d}` as const)}</span>
          <span className="jr-session-track">
            {plan.sessions.days[i] &&
              spans.map(([a, b]) => (
                <span
                  key={a}
                  className="jr-session-bar"
                  style={{ left: `${a}%`, width: `${b - a}%` }}
                />
              ))}
            {i === today && <span className="jr-session-now" style={{ left: `${nowAt}%` }} />}
          </span>
        </div>
      ))}
      <div className="jr-session-hours" aria-hidden>
        {["00", "06", "12", "18", "24"].map((h) => (
          <span key={h}>{h}</span>
        ))}
      </div>
    </div>
  );
}

function PlanEditor({
  ctx,
  draft,
  onDraft,
  onDone,
}: {
  ctx: PlanContext;
  draft: Plan;
  onDraft: (plan: Plan) => void;
  onDone: () => void;
}) {
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const set = <K extends keyof Plan>(key: K, value: Plan[K]) => onDraft({ ...draft, [key]: value });
  const isNew = !ctx.plan;
  const playbooks = [...ctx.playbooks.entries()].filter(([, p]) => p.status !== "retired");

  const save = async () => {
    setBusy(true);
    setError(undefined);
    const version = isNew ? 1 : (ctx.plan?.version ?? 0) + 1;
    const next: Plan = {
      ...draft,
      version,
      changes: [
        ...draft.changes,
        {
          version,
          at: Date.now(),
          note: note.trim() || (isNew ? t("plan.plan.created") : t("plan.plan.edited")),
        },
      ],
    };
    try {
      await ctx.journal.savePlan(next);
      onDone();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="jr-view jr-editor">
      <PageHead
        back={{ label: t("plan.tab.plan"), onClick: onDone }}
        title={isNew ? t("plan.plan.write") : t("plan.plan.edit")}
        meta={
          <span>
            {isNew
              ? t("plan.plan.editHint")
              : `${t("plan.version", { v: (ctx.plan?.version ?? 0) + 1 })} · ${t("plan.plan.editHint")}`}
          </span>
        }
      />
      {error && <p className="jr-error">{error}</p>}

      <div className="jr-form">
        <FormSection hue={PLAN_HUES.basics} title={t("plan.plan.basics")}>
          <Field label={t("plan.name")}>
            <input
              className="pd-input"
              value={draft.name}
              onChange={(e) => set("name", e.target.value)}
              placeholder={t("plan.plan.namePh")}
            />
          </Field>
          <Field label={t("plan.plan.goal")}>
            <TextArea
              value={draft.goal}
              onChange={(v) => set("goal", v)}
              placeholder={t("plan.plan.goalPh")}
            />
          </Field>
          <div className="jr-fields-2">
            <Field label={t("plan.plan.target")}>
              <NumberInput
                label={t("plan.plan.target")}
                prefix="$"
                min={0}
                value={draft.target || undefined}
                onChange={(v) => set("target", v ?? 0)}
              />
            </Field>
            <Field label={t("plan.plan.startBalance")}>
              {/* Taken from the account when the plan is written; not edited here. */}
              <input
                className="pd-input pd-num jr-readonly"
                readOnly
                tabIndex={-1}
                aria-label={t("plan.plan.startBalance")}
                value={draft.startBalance ? `$${formatNumber(draft.startBalance, 2)}` : "-"}
              />
            </Field>
          </div>
          <p className="jr-hint">
            {t("plan.plan.equityNow", {
              v: ctx.equity === undefined ? "-" : formatNumber(ctx.equity, 2),
            })}
          </p>
        </FormSection>

        <FormSection
          hue={PLAN_HUES.limits}
          title={t("plan.plan.limits")}
          hint={t("plan.plan.enforceHint")}
        >
          <div className="jr-fields-2">
            <Field label={t("plan.riskPerTrade")}>
              <NumberInput
                label={t("plan.riskPerTrade")}
                unit="%"
                min={0}
                max={100}
                value={draft.riskPct}
                onChange={(v) => set("riskPct", v ?? 0)}
              />
            </Field>
            <Field label={t("plan.rule.tradesPerDay")}>
              <NumberInput
                label={t("plan.rule.tradesPerDay")}
                min={0}
                max={1000}
                step={1}
                value={draft.maxTradesPerDay || undefined}
                onChange={(v) => set("maxTradesPerDay", v ?? 0)}
              />
            </Field>
            <Field label={t("plan.dailyStop")}>
              <NumberInput
                label={t("plan.dailyStop")}
                min={0}
                value={draft.dailyStop || undefined}
                onChange={(v) => set("dailyStop", v ?? 0)}
              />
            </Field>
            <Field label={t("plan.lossesInRow")}>
              <NumberInput
                label={t("plan.lossesInRow")}
                min={0}
                max={100}
                step={1}
                value={draft.maxLossesInRow || undefined}
                onChange={(v) => set("maxLossesInRow", v ?? 0)}
              />
            </Field>
          </div>
        </FormSection>

        <FormSection
          hue={PLAN_HUES.sessions}
          title={t("plan.plan.sessions")}
          hint={t("plan.plan.sessionsHint")}
        >
          <ChipGroup className="jr-chips" label={t("plan.plan.sessions")}>
            {WEEKDAYS.map((d, i) => (
              <button
                key={d}
                type="button"
                className="jr-chip"
                data-pick=""
                style={hueOf(WEEKDAY_HUES[i] ?? 265)}
                aria-pressed={draft.sessions.days[i]}
                onClick={() =>
                  set("sessions", {
                    ...draft.sessions,
                    days: draft.sessions.days.map((on, j) => (j === i ? !on : on)),
                  })
                }
              >
                {t(`plan.day.${d}` as const)}
              </button>
            ))}
          </ChipGroup>
          <div className="jr-fields-2">
            <Field label={t("plan.plan.from")}>
              <input
                className="pd-input"
                type="time"
                value={draft.sessions.start}
                onChange={(e) => set("sessions", { ...draft.sessions, start: e.target.value })}
              />
            </Field>
            <Field label={t("plan.plan.to")}>
              <input
                className="pd-input"
                type="time"
                value={draft.sessions.end}
                onChange={(e) => set("sessions", { ...draft.sessions, end: e.target.value })}
              />
            </Field>
          </div>
        </FormSection>

        <FormSection
          hue={PLAN_HUES.markets}
          title={t("plan.plan.markets")}
          hint={t("plan.plan.marketsHint")}
        >
          <MarketPicker ctx={ctx} picked={draft.markets} onChange={(m) => set("markets", m)} />
        </FormSection>

        <FormSection hue={PLAN_HUES.playbooks} title={t("plan.plan.playbooksIn")}>
          {playbooks.length === 0 && <p className="jr-muted">{t("plan.plan.noPlaybooksYet")}</p>}
          <ChipGroup className="jr-chips" label={t("plan.plan.playbooksIn")}>
            {playbooks.map(([id, p]) => (
              <button
                key={id}
                type="button"
                className="jr-chip"
                data-pick=""
                style={hueOf(tagHue(p.name || id))}
                aria-pressed={draft.playbookIds.includes(id)}
                onClick={() =>
                  set(
                    "playbookIds",
                    draft.playbookIds.includes(id)
                      ? draft.playbookIds.filter((x) => x !== id)
                      : [...draft.playbookIds, id],
                  )
                }
              >
                {p.name || t("plan.playbook.untitled")}
              </button>
            ))}
          </ChipGroup>
        </FormSection>

        <FormSection hue={PLAN_HUES.routine} title={t("plan.plan.routine")}>
          <Field label={t("plan.plan.before")}>
            <LinesEditor
              lines={draft.routine.before}
              label={t("plan.plan.before")}
              hue={ROUTINE_HUES.before}
              onChange={(before) => set("routine", { ...draft.routine, before })}
            />
          </Field>
          <Field label={t("plan.plan.after")}>
            <LinesEditor
              lines={draft.routine.after}
              label={t("plan.plan.after")}
              hue={ROUTINE_HUES.after}
              onChange={(after) => set("routine", { ...draft.routine, after })}
            />
          </Field>
        </FormSection>

        <FormSection hue={PLAN_HUES.ownWords} title={t("plan.plan.ownWords")}>
          <TextArea
            value={draft.creed}
            rows={3}
            onChange={(v) => set("creed", v)}
            placeholder={t("plan.plan.creedPh")}
            label={t("plan.plan.ownWords")}
          />
          {draft.ifThens.map((x, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: lines have no identity but their place
            <div key={i} className="jr-ifthen">
              <input
                className="pd-input"
                value={x.when}
                placeholder={t("plan.plan.whenPh")}
                aria-label={t("plan.plan.whenPh")}
                onChange={(e) =>
                  set(
                    "ifThens",
                    draft.ifThens.map((y, j) => (j === i ? { ...y, when: e.target.value } : y)),
                  )
                }
              />
              <span className="jr-muted" aria-hidden>
                →
              </span>
              <input
                className="pd-input"
                value={x.action}
                placeholder={t("plan.plan.thenPh")}
                aria-label={t("plan.plan.thenPh")}
                onChange={(e) =>
                  set(
                    "ifThens",
                    draft.ifThens.map((y, j) => (j === i ? { ...y, action: e.target.value } : y)),
                  )
                }
              />
            </div>
          ))}
          <button
            type="button"
            className="jr-add"
            onClick={() => set("ifThens", [...draft.ifThens, { when: "", action: "" }])}
          >
            + {t("plan.plan.addIf")}
          </button>
        </FormSection>

        {!isNew && (
          <FormSection hue={PLAN_HUES.changes} title={t("plan.plan.whatChanged")}>
            <input
              className="pd-input"
              value={note}
              aria-label={t("plan.plan.whatChanged")}
              onChange={(e) => setNote(e.target.value)}
              placeholder={t("plan.plan.whatChangedPh")}
            />
          </FormSection>
        )}
      </div>

      <ActionBar note={t("plan.plan.editHint")}>
        <button type="button" className="jr-button" onClick={onDone}>
          {t("plan.discard")}
        </button>
        <button
          type="button"
          className="jr-button jr-primary"
          disabled={busy || !draft.name.trim()}
          onClick={() => void save()}
        >
          {busy ? t("plan.saving") : t("plan.save")}
        </button>
      </ActionBar>
    </div>
  );
}
