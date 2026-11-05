import { dateFormat, t } from "@pewterdesk/ui";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  LuChevronLeft,
  LuChevronRight,
  LuFlame,
  LuLock,
  LuMoon,
  LuPin,
  LuRadio,
  LuStar,
  LuTrash2,
  LuX,
} from "react-icons/lu";
import { addDays, type JournalDay, MOODS, type Mood, newDay } from "../../lib/journal";
import { type DaySummary, type Group, groupOf, winRate } from "../../lib/journalStats";
import { Stars } from "./intent";
import type { PlanContext } from "./PlanPage";
import {
  Card,
  ChipPicker,
  ConfirmButton,
  Money,
  moodLabel,
  Pill,
  pct,
  RText,
  ScoreRing,
  tagStyle,
  weekStartOf,
} from "./parts";

// The journal's days, four ways (cards, a list, a month, a timeline by week),
// the filters they share, and the things every day can do: open, pin, delete.

export const QUICK = [
  "all",
  "week",
  "month",
  "pinned",
  "green",
  "red",
  "breaks",
  "skipped",
  "lessons",
  "lowSleep",
  "unreviewed",
] as const;
export type Quick = (typeof QUICK)[number];
export const SCORES = ["90", "70", "40", "0"] as const;
export type ScoreBand = (typeof SCORES)[number];

export interface DayFilters {
  quick: Quick;
  moods: Mood[];
  tags: string[];
  score?: ScoreBand;
}
export const NO_FILTERS: DayFilters = { quick: "all", moods: [], tags: [] };
export const activeFilters = (f: DayFilters) =>
  (f.quick === "all" ? 0 : 1) + f.moods.length + f.tags.length + (f.score ? 1 : 0);

const inBand = (score: number, band: ScoreBand) =>
  band === "90"
    ? score >= 90
    : band === "70"
      ? score >= 70 && score < 90
      : band === "40"
        ? score >= 40 && score < 70
        : score < 40;

/** What each quick view keeps. */
export function quickTest(
  days: ReadonlyMap<string, JournalDay>,
  today: string,
): Record<Quick, (s: DaySummary) => boolean> {
  const week = weekStartOf(Date.now());
  const month = today.slice(0, 7);
  return {
    all: () => true,
    week: (s) => s.day >= week,
    month: (s) => s.day.startsWith(month),
    pinned: (s) => days.get(s.day)?.pinned === true,
    green: (s) => s.group.pnl > 0,
    red: (s) => s.group.pnl < 0,
    breaks: (s) => s.breaks > 0,
    skipped: (s) => s.skipped > 0,
    lessons: (s) => (days.get(s.day)?.review.lesson ?? "") !== "",
    lowSleep: (s) => (days.get(s.day)?.checkin.sleep ?? 99) < 6.5,
    unreviewed: (s) =>
      s.day < today && s.group.trades > 0 && days.get(s.day)?.review.savedAt === undefined,
  };
}

const moodsOf = (s: DaySummary, d?: JournalDay) => [
  ...new Set([...(d?.checkin.moods ?? []), ...s.notes.flatMap((n) => n.moods)]),
];
const tagsOf = (s: DaySummary, d?: JournalDay) => [
  ...new Set([...(d?.review.tags ?? []), ...s.notes.flatMap((n) => n.tags)]),
];

export function filterDays(
  summaries: readonly DaySummary[],
  days: ReadonlyMap<string, JournalDay>,
  f: DayFilters,
  search: string,
  today: string,
): DaySummary[] {
  const test = quickTest(days, today)[f.quick];
  const q = search.trim().toLowerCase();
  return summaries.filter((s) => {
    const d = days.get(s.day);
    if (!test(s)) return false;
    if (f.score && !inBand(s.score, f.score)) return false;
    if (f.moods.length && !f.moods.some((m) => moodsOf(s, d).includes(m))) return false;
    if (f.tags.length && !f.tags.some((x) => tagsOf(s, d).includes(x))) return false;
    if (q) {
      const text = [
        d?.plan,
        d?.review.lesson,
        d?.review.right,
        d?.review.wrong,
        ...Object.values(d?.markets ?? {}).map((m) => m.note),
        ...(d?.notes.map((n) => n.text) ?? []),
        ...tagsOf(s, d),
        ...s.notes.map((n) => n.notes),
      ]
        .join(" ")
        .toLowerCase();
      if (!text.includes(q)) return false;
    }
    return true;
  });
}

export type DayStatus = "finalized" | "reviewed" | "live" | "locked" | "draft" | "none";

export function dayStatus(d: JournalDay | undefined, day: string, today: string): DayStatus {
  if (!d) return "none";
  if (d.finalizedAt) return "finalized";
  if (d.review.savedAt) return "reviewed";
  if (d.startedAt) return day === today ? "live" : "locked";
  return "draft";
}

/** What the day's card leads with: the intent before the session, the lesson after it. */
const leadOf = (d?: JournalDay) =>
  d?.review.lesson
    ? { label: t("plan.lesson"), text: d.review.lesson }
    : d?.plan
      ? { label: t("plan.in.intentLabel"), text: d.plan }
      : undefined;

/** Open, pin and delete, the same from every view. */
export interface DayActions {
  open: (day: string) => void;
  pin: (day: string) => void;
  remove: (day: string) => void;
}

export function useDayActions(ctx: PlanContext, onDay: (day: string) => void): DayActions {
  return {
    open: onDay,
    pin: (day) => {
      const d = ctx.journal.data.days.get(day)?.data ?? newDay();
      void ctx.journal.saveDay(day, { ...d, pinned: !d.pinned || undefined }).catch(() => {});
    },
    remove: (day) => {
      void ctx.journal.clearDays([day]).catch(() => {});
    },
  };
}

function RowActions({
  day,
  pinned,
  actions,
}: {
  day: string;
  pinned: boolean;
  actions: DayActions;
}) {
  return (
    <span className="jr-row-actions">
      <button
        type="button"
        className="jr-icon"
        aria-pressed={pinned}
        aria-label={pinned ? t("plan.j.unpin") : t("plan.j.pin")}
        title={pinned ? t("plan.j.unpin") : t("plan.j.pin")}
        onClick={() => actions.pin(day)}
      >
        <LuPin size={14} aria-hidden />
      </button>
      <ConfirmButton
        className="jr-icon jr-icon-danger"
        label={t("plan.clear.thisDay")}
        title={t("plan.confirm.dayTitle")}
        body={t("plan.confirm.dayBody")}
        action={t("plan.delete")}
        danger
        onConfirm={() => actions.remove(day)}
      >
        <LuTrash2 size={14} aria-hidden />
      </ConfirmButton>
    </span>
  );
}

function StatusLine({ status }: { status: DayStatus }) {
  if (status === "none") return <span className="jr-muted">{t("plan.j.status.none")}</span>;
  return (
    <span className="jr-status" data-status={status}>
      {status === "live" ? (
        <LuRadio size={12} aria-hidden />
      ) : status === "locked" || status === "finalized" ? (
        <LuLock size={11} aria-hidden />
      ) : null}
      {t(`plan.j.status.${status}` as const)}
    </span>
  );
}

const ROW_DATE: Intl.DateTimeFormatOptions = {
  weekday: "short",
  day: "2-digit",
  month: "short",
  timeZone: "UTC",
};
const MONTH: Intl.DateTimeFormatOptions = { month: "long", year: "numeric", timeZone: "UTC" };
const DATE: Intl.DateTimeFormatOptions = {
  weekday: "short",
  day: "2-digit",
  month: "short",
  timeZone: "UTC",
};
function dateParts(day: string) {
  const parts = dateFormat(DATE).formatToParts(Date.parse(day));
  const part = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  return { weekday: part("weekday"), day: part("day"), month: part("month") };
}

export function DayCards({
  ctx,
  shown,
  days,
  today,
  actions,
}: {
  ctx: PlanContext;
  shown: readonly DaySummary[];
  days: ReadonlyMap<string, JournalDay>;
  today: string;
  actions: DayActions;
}) {
  return (
    <div className="jr-dcards">
      {shown.map((s) => {
        const d = days.get(s.day);
        const p = dateParts(s.day);
        const status = dayStatus(d, s.day, today);
        const lead = leadOf(d);
        const isToday = s.day === today;
        const bias = d?.intent.bias;
        const lowSleep = d?.checkin.sleep !== undefined && d.checkin.sleep < 6.5;
        const chips = [
          ...moodsOf(s, d).map((m) => ({ key: m, label: moodLabel(m) })),
          ...tagsOf(s, d).map((x) => ({ key: x, label: x })),
        ];
        const r = s.group.withR ? s.group.totalR : undefined;
        const tone = s.score >= 90 ? "good" : s.score >= 70 ? "fair" : "poor";
        return (
          <article
            key={s.day}
            className="jr-dcard"
            data-bias={bias}
            data-today={isToday || undefined}
            data-flag={s.breaks > 0 || undefined}
          >
            <button
              type="button"
              className="jr-hit"
              aria-label={t("plan.j.openDay", {
                day: dateFormat({ dateStyle: "full", timeZone: "UTC" }).format(Date.parse(s.day)),
              })}
              onClick={() => actions.open(s.day)}
            />
            <header className="jr-dcard-head">
              <span className="jr-dcard-date">
                <span>{p.weekday}</span>
                <strong>{p.day}</strong>
                <span>{p.month}</span>
              </span>
              <span className="jr-dcard-tags">
                <span className="jr-dcard-pills">
                  {bias && (
                    <span className="jr-biaspill" data-bias={bias}>
                      {t(`plan.bias.${bias}` as const)}
                    </span>
                  )}
                  {isToday && status !== "none" && (
                    <span className="jr-todaypill" data-status={status}>
                      <span aria-hidden />
                      {t(
                        `plan.j.todayPill.${status === "finalized" ? "reviewed" : status === "locked" ? "live" : status}` as const,
                      )}
                    </span>
                  )}
                  {s.breaks > 0 && <Pill tone="warn">{t("plan.j.breaksN", { n: s.breaks })}</Pill>}
                </span>
                <span className="jr-dcard-sub">
                  {d?.intent.conviction !== undefined && (
                    <Stars value={d.intent.conviction} label={t("plan.td.conviction")} size={12} />
                  )}
                  {d?.checkin.sleep !== undefined && (
                    <span>{t("plan.j.sleepH", { h: d.checkin.sleep.toFixed(1) })}</span>
                  )}
                </span>
              </span>
              <span className="jr-dcard-side">
                <button
                  type="button"
                  className="jr-icon jr-pin"
                  aria-pressed={d?.pinned === true}
                  aria-label={d?.pinned ? t("plan.j.unpin") : t("plan.j.pin")}
                  title={d?.pinned ? t("plan.j.unpin") : t("plan.j.pin")}
                  onClick={() => actions.pin(s.day)}
                >
                  <LuStar size={14} aria-hidden />
                </button>
                <span className="jr-dcard-ring" data-tone={tone}>
                  <ScoreRing score={s.score} size={44} />
                </span>
              </span>
            </header>
            {lead ? (
              <div className="jr-dcard-lead">
                <span className="jr-label">{lead.label}</span>
                <p>{lead.text}</p>
              </div>
            ) : (
              <p className="jr-dcard-empty">{t("plan.j.noLesson")}</p>
            )}
            {(chips.length > 0 || lowSleep) && (
              <div className="jr-dcard-chips">
                {chips.slice(0, 6).map((c) => (
                  <span key={c.key} className="jr-tag" style={tagStyle(c.key)}>
                    {c.label}
                  </span>
                ))}
                {lowSleep && (
                  <span className="jr-tag" data-tone="warn">
                    {t("plan.j.sleptUnder")}
                  </span>
                )}
                {chips.length > 6 && <span className="jr-muted">+{chips.length - 6}</span>}
              </div>
            )}
            <footer className="jr-dcard-foot">
              <StatusLine status={status} />
              <span className="jr-dcard-foot-right">
                {s.group.trades > 0 && (
                  <span className="jr-dcard-result">
                    <Money value={s.group.pnl} />
                    {r !== undefined && <RText r={r} digits={1} />}
                    <span className="jr-muted">{t("plan.tradesN", { n: s.group.trades })}</span>
                  </span>
                )}
                <ConfirmButton
                  className="jr-icon jr-icon-danger"
                  label={t("plan.clear.thisDay")}
                  title={t("plan.confirm.dayTitle")}
                  body={t("plan.confirm.dayBody")}
                  action={t("plan.delete")}
                  danger
                  onConfirm={() => actions.remove(s.day)}
                >
                  <LuTrash2 size={14} aria-hidden />
                </ConfirmButton>
              </span>
            </footer>
          </article>
        );
      })}
    </div>
  );
}

/** The chips a day shows: its moods and tags, and short sleep. */
function DayChips({ s, d, max = 6 }: { s: DaySummary; d?: JournalDay; max?: number }) {
  const chips = [
    ...moodsOf(s, d).map((m) => ({ key: m, label: moodLabel(m) })),
    ...tagsOf(s, d).map((x) => ({ key: x, label: x })),
  ];
  const lowSleep = d?.checkin.sleep !== undefined && d.checkin.sleep < 6.5;
  if (chips.length === 0 && !lowSleep) return null;
  return (
    <div className="jr-dcard-chips">
      {chips.slice(0, max).map((c) => (
        <span key={c.key} className="jr-tag" style={tagStyle(c.key)}>
          {c.label}
        </span>
      ))}
      {lowSleep && (
        <span className="jr-tag" data-tone="warn">
          {t("plan.j.sleptUnder")}
        </span>
      )}
      {chips.length > max && <span className="jr-muted">+{chips.length - max}</span>}
    </div>
  );
}

function BiasPill({ bias }: { bias?: JournalDay["intent"]["bias"] }) {
  if (!bias) return null;
  return (
    <span className="jr-biaspill" data-bias={bias}>
      {t(`plan.bias.${bias}` as const)}
    </span>
  );
}

const scoreTone = (score: number) => (score >= 90 ? "good" : score >= 70 ? "fair" : "poor");

export function DayList({
  shown,
  days,
  today,
  actions,
}: {
  shown: readonly DaySummary[];
  days: ReadonlyMap<string, JournalDay>;
  today: string;
  actions: DayActions;
}) {
  const format = dateFormat({ month: "short", day: "2-digit", timeZone: "UTC" });
  return (
    <div className="jr-dlist">
      {shown.map((s) => {
        const d = days.get(s.day);
        const lead = leadOf(d);
        const status = dayStatus(d, s.day, today);
        const p = dateParts(s.day);
        return (
          <div
            key={s.day}
            className="jr-dlist-row"
            data-today={s.day === today || undefined}
            data-bias={d?.intent.bias}
          >
            <button
              type="button"
              className="jr-hit"
              aria-label={t("plan.j.openDay", { day: s.day })}
              onClick={() => actions.open(s.day)}
            />
            <span className="jr-dlist-dot" data-status={status} aria-hidden />
            <span className="jr-dlist-date">
              <strong>{format.format(Date.parse(s.day)).toUpperCase()}</strong>
              <span>
                {p.weekday.toUpperCase()}
                {s.day === today && ` · ${t("plan.tab.today").toLowerCase()}`}
              </span>
            </span>
            <span className="jr-dlist-main">
              <span className={lead ? "jr-dlist-text" : "jr-dlist-text jr-muted"}>
                {lead?.text ?? t("plan.j.noLesson")}
              </span>
              <span className="jr-dlist-meta">
                {d?.checkin.sleep !== undefined && (
                  <span>
                    <span aria-hidden>😴</span>{" "}
                    {t("plan.j.sleepLine", { h: d.checkin.sleep.toFixed(1) })}
                  </span>
                )}
                {s.group.trades > 0 && (
                  <span>
                    <Money value={s.group.pnl} /> · {t("plan.tradesN", { n: s.group.trades })}
                  </span>
                )}
              </span>
            </span>
            <span className="jr-dlist-score pd-num" data-tone={scoreTone(s.score)}>
              D {s.score}
            </span>
            <span className="jr-dlist-bias">
              <BiasPill bias={d?.intent.bias} />
            </span>
            <RowActions day={s.day} pinned={d?.pinned === true} actions={actions} />
          </div>
        );
      })}
    </div>
  );
}

/** A month of days, each tinted by its bias, a dot where it was journaled. */
export function DayMonth({
  shown,
  days,
  today,
  actions,
}: {
  shown: readonly DaySummary[];
  days: ReadonlyMap<string, JournalDay>;
  today: string;
  actions: DayActions;
}) {
  const [month, setMonth] = useState(today.slice(0, 7));
  const byDay = useMemo(() => new Map(shown.map((s) => [s.day, s])), [shown]);
  const first = `${month}-01`;
  const lead = (new Date(Date.parse(first)).getUTCDay() + 6) % 7;
  const cells: string[] = [];
  for (let d = first; d.startsWith(month); d = addDays(d, 1)) cells.push(d);
  const shift = (n: number) => {
    const d = new Date(Date.parse(first));
    d.setUTCMonth(d.getUTCMonth() + n);
    setMonth(d.toISOString().slice(0, 7));
  };
  const weekdays = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"] as const;
  return (
    <section className="jr-bigcal">
      <header className="jr-bigcal-head">
        <h3>{dateFormat(MONTH).format(Date.parse(first))}</h3>
        <span className="jr-grow" />
        <span className="jr-bigcal-legend">
          <span data-kind="long">{t("plan.bias.long")}</span>
          <span data-kind="short">{t("plan.bias.short")}</span>
          <span data-kind="journaled">{t("plan.journaled")}</span>
        </span>
        <button
          type="button"
          className="jr-icon jr-icon-lg"
          aria-label={t("plan.j.prevMonth")}
          onClick={() => shift(-1)}
        >
          <LuChevronLeft size={16} aria-hidden />
        </button>
        <button
          type="button"
          className="jr-icon jr-icon-lg"
          aria-label={t("plan.j.nextMonth")}
          disabled={month >= today.slice(0, 7)}
          onClick={() => shift(1)}
        >
          <LuChevronRight size={16} aria-hidden />
        </button>
      </header>
      <div className="jr-bigcal-grid">
        {weekdays.map((d) => (
          <span key={d} className="jr-bigcal-wd">
            {t(`plan.day.${d}` as const)}
          </span>
        ))}
        {cells.map((d, i) => {
          const s = byDay.get(d);
          const entry = days.get(d);
          const journaled = entry?.review.savedAt !== undefined;
          return (
            <button
              key={d}
              type="button"
              className="jr-bigcal-day"
              data-bias={s ? entry?.intent.bias : undefined}
              data-today={d === today || undefined}
              data-has={s ? true : undefined}
              disabled={d > today}
              style={i === 0 && lead ? { gridColumnStart: lead + 1 } : undefined}
              onClick={() => actions.open(d)}
            >
              <span className="jr-bigcal-n">
                {Number(d.slice(8))}
                {journaled && <span className="jr-bigcal-dot" title={t("plan.journaled")} />}
                {entry?.pinned && <LuStar size={11} aria-hidden className="jr-bigcal-pin" />}
              </span>
              {s && (
                <span className="jr-bigcal-body">
                  {entry?.intent.bias && <BiasPill bias={entry.intent.bias} />}
                  {s.group.trades > 0 && <Money value={s.group.pnl} />}
                  <span className="jr-bigcal-meta pd-num" data-tone={scoreTone(s.score)}>
                    D {s.score}
                    {s.group.trades > 0 && ` · ${t("plan.j.trShort", { n: s.group.trades })}`}
                  </span>
                </span>
              )}
            </button>
          );
        })}
      </div>
    </section>
  );
}

/** The days by week on one line, newest first: the date on the left, the day's card beside it. */
export function DayTimeline({
  shown,
  days,
  today,
  actions,
}: {
  shown: readonly DaySummary[];
  days: ReadonlyMap<string, JournalDay>;
  today: string;
  actions: DayActions;
}) {
  const weekStart = weekStartOf(Date.now());
  const weeks: { start: string; items: DaySummary[] }[] = [];
  for (const s of shown) {
    const start = weekStartOf(Date.parse(s.day));
    const last = weeks[weeks.length - 1];
    if (last && last.start === start) last.items.push(s);
    else weeks.push({ start, items: [s] });
  }
  const short = dateFormat({ month: "short", day: "numeric", timeZone: "UTC" });
  return (
    <div className="jr-tl">
      {weeks.map((w) => (
        <section key={w.start} className="jr-tl-week">
          <h3 className="jr-tl-label">
            {w.start === weekStart
              ? t("plan.r.week")
              : t("plan.j.weekOf", { date: short.format(Date.parse(w.start)) })}
          </h3>
          {w.items.map((s) => {
            const d = days.get(s.day);
            const p = dateParts(s.day);
            const status = dayStatus(d, s.day, today);
            const lead = leadOf(d);
            return (
              <div
                key={s.day}
                className="jr-tl-item"
                data-bias={d?.intent.bias}
                data-today={s.day === today || undefined}
              >
                <span className="jr-tl-node" data-status={status} aria-hidden />
                <span className="jr-tl-date">
                  <strong>
                    {p.weekday.toUpperCase()} {p.day}
                  </strong>
                  <span>{p.month.toUpperCase()}</span>
                  <span className="pd-num" data-tone={scoreTone(s.score)}>
                    D {s.score}
                  </span>
                </span>
                <div className="jr-tl-card">
                  <button
                    type="button"
                    className="jr-hit"
                    aria-label={t("plan.j.openDay", { day: s.day })}
                    onClick={() => actions.open(s.day)}
                  />
                  <div className="jr-tl-top">
                    <BiasPill bias={d?.intent.bias} />
                    {status !== "none" && (
                      <span className="jr-todaypill jr-statuspill" data-status={status}>
                        <span aria-hidden />
                        {t(`plan.j.short.${status}` as const)}
                      </span>
                    )}
                    {d?.checkin.sleep !== undefined && (
                      <span className="jr-tl-sleep">
                        <span aria-hidden>😴</span> {d.checkin.sleep.toFixed(1)}h
                      </span>
                    )}
                    {s.group.trades > 0 && (
                      <span className="jr-tl-result">
                        <Money value={s.group.pnl} />
                        <span className="jr-muted">{t("plan.tradesN", { n: s.group.trades })}</span>
                      </span>
                    )}
                  </div>
                  <p className={lead ? "jr-tl-text" : "jr-tl-text jr-muted"}>
                    {lead?.text ?? t("plan.j.noLesson")}
                  </p>
                  <DayChips s={s} d={d} max={8} />
                </div>
              </div>
            );
          })}
        </section>
      ))}
    </div>
  );
}

/** The filters, the jump-to-date calendar and the streak, in a drawer. */
export function FilterDrawer({
  open,
  onClose,
  summaries,
  days,
  today,
  filters,
  onFilters,
  streak,
  calendar,
}: {
  open: boolean;
  onClose: () => void;
  summaries: readonly DaySummary[];
  days: ReadonlyMap<string, JournalDay>;
  today: string;
  filters: DayFilters;
  onFilters: (f: DayFilters) => void;
  streak: number;
  calendar: React.ReactNode;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    else if (!open && d.open) d.close();
  }, [open]);
  const tests = quickTest(days, today);
  const month = summaries.filter((s) => s.day.startsWith(today.slice(0, 7)));
  const avg = month.length
    ? Math.round(month.reduce((n, s) => n + s.score, 0) / month.length)
    : undefined;
  const count = <T,>(has: (s: DaySummary) => readonly T[], v: T) =>
    summaries.filter((s) => has(s).includes(v)).length;
  const allTags = [...new Set(summaries.flatMap((s) => tagsOf(s, days.get(s.day))))];
  return (
    <dialog
      ref={ref}
      className="jr-drawer"
      aria-labelledby="jr-drawer-title"
      onClose={onClose}
      onClick={(e) => e.target === e.currentTarget && onClose()}
      onKeyDown={(e) => e.key === "Escape" && onClose()}
    >
      <header className="jr-drawer-head">
        <h2 id="jr-drawer-title">{t("plan.j.filtersTitle")}</h2>
        <button
          type="button"
          className="jr-icon"
          aria-label={t("plan.clear.close")}
          onClick={onClose}
        >
          <LuX size={15} aria-hidden />
        </button>
      </header>
      <div className="jr-drawer-body">
        <div className="jr-streakcard">
          <span className="jr-streakcard-n">
            <LuFlame size={16} aria-hidden data-on={streak > 0 || undefined} />
            <strong className="pd-num">{streak}</strong> {t("plan.j.streak")}
          </span>
          <span className="jr-muted">
            {t("plan.j.entriesMonth", { n: month.length })}
            {avg !== undefined && ` · ${t("plan.j.avgD", { n: avg })}`}
          </span>
        </div>

        <section>
          <h3 className="jr-label">{t("plan.j.jump")}</h3>
          {calendar}
        </section>

        <section>
          <h3 className="jr-label">{t("plan.j.quick")}</h3>
          <ul className="jr-quick">
            {QUICK.map((q) => {
              const n = summaries.filter(tests[q]).length;
              return (
                <li key={q}>
                  <button
                    type="button"
                    className="jr-quick-item"
                    aria-pressed={filters.quick === q}
                    onClick={() => onFilters({ ...filters, quick: q })}
                  >
                    <span>{t(`plan.j.quick.${q}` as const)}</span>
                    {n > 0 && <span className="jr-quick-n pd-num">{n}</span>}
                  </button>
                </li>
              );
            })}
          </ul>
        </section>

        <section>
          <h3 className="jr-label">{t("plan.j.byMood")}</h3>
          <ChipPicker
            label={t("plan.j.byMood")}
            colored
            options={MOODS}
            picked={filters.moods}
            render={(m) => {
              const n = count((s) => moodsOf(s, days.get(s.day)), m);
              return n ? `${moodLabel(m)} ${n}` : moodLabel(m);
            }}
            onChange={(moods) => onFilters({ ...filters, moods })}
          />
        </section>

        {allTags.length > 0 && (
          <section>
            <h3 className="jr-label">{t("plan.j.byTag")}</h3>
            <ChipPicker
              label={t("plan.j.byTag")}
              colored
              options={allTags}
              picked={filters.tags}
              onChange={(tags) => onFilters({ ...filters, tags })}
            />
          </section>
        )}

        <section>
          <h3 className="jr-label">{t("plan.j.byScore")}</h3>
          <div className="jr-chips">
            {SCORES.map((b) => {
              const n = summaries.filter((s) => inBand(s.score, b)).length;
              return (
                <button
                  key={b}
                  type="button"
                  className="jr-chip"
                  aria-pressed={filters.score === b}
                  onClick={() =>
                    onFilters({ ...filters, score: filters.score === b ? undefined : b })
                  }
                >
                  {t(`plan.j.score.${b}` as const)}
                  {n > 0 && <span className="jr-muted"> {n}</span>}
                </button>
              );
            })}
          </div>
        </section>
      </div>
      <footer className="jr-drawer-foot">
        <button
          type="button"
          className="jr-button jr-quiet"
          disabled={activeFilters(filters) === 0}
          onClick={() => onFilters(NO_FILTERS)}
        >
          {t("plan.j.resetFilters")}
        </button>
        <button type="button" className="jr-button jr-primary" onClick={onClose}>
          {t("plan.j.showN", {
            n: summaries.filter((s) => filterDays([s], days, filters, "", today).length).length,
          })}
        </button>
      </footer>
    </dialog>
  );
}
export function DayRow({
  ctx,
  summary: s,
  entry,
  today,
  onOpen,
}: {
  ctx: PlanContext;
  summary: DaySummary;
  entry?: JournalDay;
  today: string;
  onOpen: () => void;
}) {
  const parts = dateFormat(ROW_DATE).formatToParts(Date.parse(s.day));
  const part = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  const moods = [...new Set([...(entry?.checkin.moods ?? []), ...s.notes.flatMap((n) => n.moods)])];
  const tags = [...new Set([...(entry?.review.tags ?? []), ...s.notes.flatMap((n) => n.tags)])];
  const chips = [
    ...moods.map((m) => ({ key: m, label: moodLabel(m) })),
    ...tags.map((x) => ({ key: x, label: x })),
  ];
  const r = s.group.withR ? s.group.totalR : undefined;
  const reviewed = s.notes.filter((n) => n.reflection.savedAt).length;
  const stages = [
    { on: entry?.startedAt !== undefined, label: t("plan.j.premarket") },
    {
      on: s.notes.length > 0 && reviewed === s.notes.length,
      label: t("plan.j.reviewedN", { n: reviewed, of: s.notes.length }),
    },
    { on: entry?.review.savedAt !== undefined, label: t("plan.j.eodDone") },
  ];
  return (
    <button
      type="button"
      className="jr-dayrow"
      data-flag={s.breaks > 0 || undefined}
      data-today={s.day === today || undefined}
      onClick={onOpen}
    >
      <span className="jr-date">
        <span>{part("weekday")}</span>
        <strong>{part("day")}</strong>
        <span>{part("month")}</span>
      </span>
      <span className="jr-dayrow-main">
        <span className="jr-dayrow-top">
          <span className="jr-dayrow-pnl">
            <Money value={s.group.pnl} quote={ctx.quote ? ` ${ctx.quote}` : ""} />
          </span>
          {r !== undefined && <RText r={r} digits={1} />}
          {s.breaks > 0 && <Pill tone="warn">{t("plan.j.breaksN", { n: s.breaks })}</Pill>}
          {entry?.pinned && <LuPin size={12} aria-label={t("plan.j.quick.pinned")} />}
        </span>
        <span className="jr-dayrow-lesson" data-empty={!entry?.review.lesson || undefined}>
          {entry?.review.lesson || t("plan.j.noLesson")}
        </span>
        <span className="jr-dayrow-meta">
          <span>
            {t("plan.tradesN", { n: s.group.trades })}
            {s.group.trades > 0 && ` · ${t("plan.winPct", { v: pct(winRate(s.group)) })}`}
            {entry?.checkin.sleep !== undefined &&
              ` · ${t("plan.j.slept", { h: entry.checkin.sleep })}`}
          </span>
          {s.skipped > 0 && (
            <span className="jr-warn">{t("plan.j.skippedN", { n: s.skipped })}</span>
          )}
          {chips.slice(0, 3).map((c) => (
            <span key={c.key} className="jr-tag" style={tagStyle(c.key)}>
              {c.label}
            </span>
          ))}
          {chips.length > 3 && <span className="jr-muted">+{chips.length - 3}</span>}
        </span>
      </span>
      <span className="jr-stages" title={stages.map((x) => x.label).join(" · ")}>
        {stages.map((x) => (
          <span key={x.label} data-on={x.on || undefined} />
        ))}
      </span>
      <ScoreRing score={s.score} />
    </button>
  );
}

/** A month of days, each tinted by its P&L; a dot where the day was journaled. */
export function MonthCalendar({
  summaries,
  days,
  today,
  onDay,
}: {
  summaries: DaySummary[];
  days: ReadonlyMap<string, JournalDay>;
  today: string;
  onDay: (day: string) => void;
}) {
  const [month, setMonth] = useState(today.slice(0, 7));
  const byDay = useMemo(() => new Map(summaries.map((s) => [s.day, s])), [summaries]);
  const first = `${month}-01`;
  const lead = (new Date(Date.parse(first)).getUTCDay() + 6) % 7;
  const cells: string[] = [];
  for (let d = first; d.startsWith(month); d = addDays(d, 1)) cells.push(d);
  const inMonth = summaries.filter((s) => s.day.startsWith(month));
  const net = inMonth.reduce((sum, s) => sum + s.group.pnl, 0);
  const green = inMonth.filter((s) => s.group.pnl > 0).length;
  const red = inMonth.filter((s) => s.group.pnl < 0).length;
  const shift = (n: number) => {
    const d = new Date(Date.parse(first));
    d.setUTCMonth(d.getUTCMonth() + n);
    setMonth(d.toISOString().slice(0, 7));
  };
  const weekdays = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"] as const;
  return (
    <Card
      title={dateFormat(MONTH).format(Date.parse(first))}
      aside={
        <span className="jr-cal-nav">
          <button
            type="button"
            className="jr-icon"
            aria-label={t("plan.j.prevMonth")}
            onClick={() => shift(-1)}
          >
            <LuChevronLeft size={14} aria-hidden />
          </button>
          <button
            type="button"
            className="jr-icon"
            aria-label={t("plan.j.nextMonth")}
            disabled={month >= today.slice(0, 7)}
            onClick={() => shift(1)}
          >
            <LuChevronRight size={14} aria-hidden />
          </button>
        </span>
      }
    >
      <div className="jr-cal">
        {weekdays.map((d) => (
          <span key={d} className="jr-cal-wd" aria-hidden>
            {t(`plan.day.${d}` as const).slice(0, 2)}
          </span>
        ))}
        {cells.map((d, i) => {
          const s = byDay.get(d);
          const tone = s ? (s.group.pnl > 0 ? "up" : s.group.pnl < 0 ? "down" : "flat") : undefined;
          return (
            <button
              key={d}
              type="button"
              className="jr-cal-day"
              data-tone={tone}
              data-today={d === today || undefined}
              data-journaled={days.get(d)?.review.savedAt !== undefined || undefined}
              disabled={d > today}
              style={i === 0 && lead ? { gridColumnStart: lead + 1 } : undefined}
              title={s ? `${d} · ${s.group.pnl.toFixed(2)}` : d}
              onClick={() => onDay(d)}
            >
              {Number(d.slice(8))}
            </button>
          );
        })}
      </div>
      <div className="jr-cal-foot">
        <span>
          <span className="jr-label">{t("plan.net")}</span>
          <Money value={net} />
        </span>
        <span>
          <span className="jr-label">{t("plan.j.greenRed")}</span>
          <span className="pd-num">
            <span className="pd-up">{green}</span> / <span className="pd-down">{red}</span>
          </span>
        </span>
      </div>
    </Card>
  );
}
