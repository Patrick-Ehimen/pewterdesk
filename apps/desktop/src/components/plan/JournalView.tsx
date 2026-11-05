import { dateFormat, formatNumber, t } from "@pewterdesk/ui";
import { useMemo, useState } from "react";
import {
  LuCalendar,
  LuChartLine,
  LuChevronRight,
  LuLayoutGrid,
  LuList,
  LuNotebookPen,
  LuSearch,
  LuSlidersHorizontal,
  LuTable,
  LuTrash2,
  LuWaypoints,
  LuX,
} from "react-icons/lu";
import { gradeOf, isBlankDay, type JournalDay, rOf, skippedItems, utcDay } from "../../lib/journal";
import {
  avgR,
  byEntryHour,
  byMood,
  bySleep,
  type DaySummary,
  daySummaries,
  edgeDecay,
  type Group,
  groupOf,
  habitCosts,
  journalStreak,
  processOutcome,
} from "../../lib/journalStats";
import { openKey } from "../../lib/journalTrades";
import { ClearDialog } from "./ClearDialog";
import { DayEntry } from "./DayEntry";
import {
  activeFilters,
  DayCards,
  type DayFilters,
  DayList,
  DayMonth,
  DayTimeline,
  dayStatus,
  FilterDrawer,
  filterDays,
  MonthCalendar,
  NO_FILTERS,
  useDayActions,
} from "./JournalDays";
import type { PlanContext } from "./PlanPage";
import {
  Bar,
  Blank,
  breakLabel,
  Card,
  Compare,
  formatR,
  groupLine,
  Kpis,
  Money,
  moodLabel,
  PageHead,
  pct,
  RText,
  Segment,
  Stat,
  tagStyle,
  useKept,
  weekStartOf,
} from "./parts";

const VIEWS = ["cards", "list", "calendar", "timeline", "trades", "insights"] as const;
type View = (typeof VIEWS)[number];
const VIEW_ICONS = {
  cards: LuLayoutGrid,
  list: LuList,
  calendar: LuCalendar,
  timeline: LuWaypoints,
  trades: LuTable,
  insights: LuChartLine,
} as const;
const VIEW_KEY = "pd.journal.view";
const SHORT_DATE: Intl.DateTimeFormatOptions = { month: "short", day: "numeric", timeZone: "UTC" };
const TRADE_TIME: Intl.DateTimeFormatOptions = {
  month: "short",
  day: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  timeZone: "UTC",
};

function storedView(): View {
  try {
    const v = localStorage.getItem(VIEW_KEY);
    return VIEWS.includes(v as View) ? (v as View) : "cards";
  } catch {
    return "cards";
  }
}

/**
 * The journal: every day as cards, a list, a month or a timeline, filtered and
 * searched; every trade with its note; and Insights, what the habits cost.
 * A day opens its entry: intent, live session, review.
 */
export function JournalView({
  ctx,
  day,
  onDay,
}: {
  ctx: PlanContext;
  day?: string;
  onDay: (day?: string) => void;
}) {
  const [view, setViewState] = useState<View>(storedView);
  const setView = (v: View) => {
    setViewState(v);
    try {
      localStorage.setItem(VIEW_KEY, v);
    } catch {}
  };
  const [search, setSearch] = useKept("plan.journalSearch", "");
  const [filters, setFilters] = useKept<DayFilters>("plan.journalFilters", NO_FILTERS);
  const [drawer, setDrawer] = useState(false);
  const [clearing, setClearing] = useState(false);
  const allDays = useMemo(
    () => new Map([...ctx.journal.data.days].map(([d, s]) => [d, s.data])),
    [ctx.journal.data.days],
  );
  // A cleared day with nothing written since lists nothing of its own.
  const days = useMemo(() => new Map([...allDays].filter(([, d]) => !isBlankDay(d))), [allDays]);
  const notes = useMemo(() => ctx.trades.map((x) => x.note), [ctx.trades]);
  const summaries = useMemo(() => daySummaries(notes, days), [notes, days]);
  const today = utcDay(Date.now());
  const streak = journalStreak(summaries, days, today);
  const actions = useDayActions(ctx, (d) => onDay(d));
  const shown = useMemo(
    () => filterDays(summaries, days, filters, search, today),
    [summaries, days, filters, search, today],
  );

  if (day) return <DayEntry key={day} ctx={ctx} day={day} onDay={onDay} summaries={summaries} />;

  const month = today.slice(0, 7);
  const thisMonth = summaries.filter((s) => s.day.startsWith(month));
  const recent = summaries.filter((s) => s.day >= utcDay(Date.now() - 30 * 86_400_000));
  const discipline = recent.length
    ? Math.round(recent.reduce((n, s) => n + s.score, 0) / recent.length)
    : undefined;
  const monthGroup = groupOf(thisMonth.flatMap((s) => s.notes));
  const todayEntry = days.get(today);
  const todayTrades = summaries.find((s) => s.day === today)?.group.trades ?? 0;
  const status = dayStatus(todayEntry, today, today);
  const dayView = view === "cards" || view === "list" || view === "calendar" || view === "timeline";
  const nFilters = activeFilters(filters);

  return (
    <div className="jr-view">
      <PageHead
        eyebrow={t("plan.tab.journal")}
        title={t("plan.j.title")}
        meta={<span>{t("plan.j.tagline")}</span>}
        actions={
          <>
            <button type="button" className="jr-button jr-quiet" onClick={() => setClearing(true)}>
              <LuTrash2 size={13} aria-hidden /> {t("plan.clear.open")}
            </button>
            <button type="button" className="jr-button jr-primary" onClick={() => onDay(today)}>
              <LuNotebookPen size={13} aria-hidden /> {t("plan.j.todayEntry")}
            </button>
          </>
        }
      />

      <button
        type="button"
        className="jr-today-cta"
        data-status={status}
        onClick={() => onDay(today)}
      >
        <span className="jr-today-dot" data-on={status !== "none" || undefined} />
        <span className="jr-today-text">
          <strong>
            {t(`plan.j.today.${status === "finalized" ? "reviewed" : status}` as const)}
          </strong>
          <span>
            {[
              todayEntry?.plan && t("plan.j.today.intentSaved"),
              todayEntry?.startedAt &&
                t("plan.j.lockedAt", {
                  time: new Date(todayEntry.startedAt).toISOString().slice(11, 16),
                }),
              t("plan.tradesN", { n: todayTrades }),
            ]
              .filter(Boolean)
              .join(" · ")}
          </span>
        </span>
        <span className="jr-today-go">
          {status === "none"
            ? t("plan.j.today.start")
            : status === "reviewed" || status === "finalized"
              ? t("plan.open")
              : t("plan.j.today.continue")}
          <LuChevronRight size={14} aria-hidden />
        </span>
      </button>

      <Kpis>
        <Stat
          label={t("plan.j.streakTitle")}
          value={`${streak}d`}
          note={streak > 0 ? t("plan.j.keepGoing") : t("plan.j.startStreak")}
        />
        <Stat
          label={t("plan.j.discipline30")}
          value={discipline ?? "-"}
          note={t("plan.j.tradingDaysN", { n: recent.length })}
        />
        <Stat label={t("plan.j.entriesThisMonth")} value={thisMonth.length} />
        <Stat
          label={t("plan.j.netThisMonth")}
          value={<Money value={monthGroup.pnl} />}
          note={[
            monthGroup.withR ? formatR(monthGroup.totalR) : undefined,
            t("plan.tradesN", { n: monthGroup.trades }),
          ]
            .filter(Boolean)
            .join(" · ")}
        />
      </Kpis>

      <div className="jr-toolbar jr-toolbar-panel">
        {view !== "insights" && (
          <label className="jr-search">
            <LuSearch size={13} aria-hidden />
            <input
              type="search"
              value={search}
              placeholder={t("plan.j.search")}
              aria-label={t("plan.j.search")}
              onChange={(e) => setSearch(e.target.value)}
            />
          </label>
        )}
        {dayView && (
          <span className="jr-muted jr-toolbar-count">
            {t("plan.j.entriesN", { n: shown.length })}
          </span>
        )}
        <span className="jr-grow" />
        <Segment
          label={t("plan.j.view")}
          value={view}
          options={VIEWS.map((v) => {
            const Icon = VIEW_ICONS[v];
            return {
              value: v,
              label: (
                <span className="jr-viewopt" data-split={v === "trades" || undefined}>
                  <Icon size={13} aria-hidden />
                  <span>{t(`plan.j.v.${v}` as const)}</span>
                </span>
              ),
            };
          })}
          onChange={setView}
        />
        {dayView && (
          <button type="button" className="jr-button" onClick={() => setDrawer(true)}>
            <LuSlidersHorizontal size={13} aria-hidden /> {t("plan.j.filters")}
            {nFilters > 0 && <span className="jr-count pd-num">{nFilters}</span>}
          </button>
        )}
      </div>

      {dayView && nFilters > 0 && (
        <div className="jr-activefilters">
          {filters.quick !== "all" && (
            <FilterChip
              label={t(`plan.j.quick.${filters.quick}` as const)}
              onRemove={() => setFilters({ ...filters, quick: "all" })}
            />
          )}
          {filters.moods.map((m) => (
            <FilterChip
              key={m}
              hue={m}
              label={moodLabel(m)}
              onRemove={() =>
                setFilters({ ...filters, moods: filters.moods.filter((x) => x !== m) })
              }
            />
          ))}
          {filters.tags.map((x) => (
            <FilterChip
              key={x}
              hue={x}
              label={x}
              onRemove={() => setFilters({ ...filters, tags: filters.tags.filter((y) => y !== x) })}
            />
          ))}
          {filters.score && (
            <FilterChip
              label={t(`plan.j.score.${filters.score}` as const)}
              onRemove={() => setFilters({ ...filters, score: undefined })}
            />
          )}
          <button type="button" className="jr-link" onClick={() => setFilters(NO_FILTERS)}>
            {t("plan.j.resetFilters")}
          </button>
        </div>
      )}

      {dayView && shown.length === 0 ? (
        <Card>
          <Blank
            icon={<LuNotebookPen size={22} aria-hidden />}
            title={summaries.length ? t("plan.j.noMatch") : t("plan.j.emptyTitle")}
          >
            {summaries.length === 0 ? t("plan.j.empty") : undefined}
          </Blank>
        </Card>
      ) : view === "cards" ? (
        <DayCards ctx={ctx} shown={shown} days={days} today={today} actions={actions} />
      ) : view === "list" ? (
        <DayList shown={shown} days={days} today={today} actions={actions} />
      ) : view === "calendar" ? (
        <DayMonth shown={shown} days={days} today={today} actions={actions} />
      ) : view === "timeline" ? (
        <DayTimeline shown={shown} days={days} today={today} actions={actions} />
      ) : view === "trades" ? (
        <TradesList ctx={ctx} search={search} />
      ) : (
        <Insights ctx={ctx} summaries={summaries} days={days} />
      )}

      <FilterDrawer
        open={drawer}
        onClose={() => setDrawer(false)}
        summaries={summaries}
        days={days}
        today={today}
        filters={filters}
        onFilters={setFilters}
        streak={streak}
        calendar={
          <MonthCalendar
            summaries={summaries}
            days={days}
            today={today}
            onDay={(d) => {
              setDrawer(false);
              onDay(d);
            }}
          />
        }
      />
      <ClearDialog
        ctx={ctx}
        open={clearing}
        summaries={summaries}
        days={allDays}
        onClose={() => setClearing(false)}
      />
    </div>
  );
}

function FilterChip({
  label,
  hue,
  onRemove,
}: {
  label: string;
  /** A mood's or tag's own key, to take its colour. */
  hue?: string;
  onRemove: () => void;
}) {
  return (
    <span
      className="jr-chip"
      data-static
      data-strong={hue ? undefined : true}
      data-hue={hue ? true : undefined}
      style={hue ? tagStyle(hue) : undefined}
    >
      {label}
      <button
        type="button"
        className="jr-chip-x"
        aria-label={t("plan.remove", { name: label })}
        onClick={onRemove}
      >
        <LuX size={11} aria-hidden />
      </button>
    </span>
  );
}

function matches(text: string, search: string) {
  return text.toLowerCase().includes(search.trim().toLowerCase());
}

/** The account's trades: what's open now, then every closed one with its note. */
function TradesList({ ctx, search }: { ctx: PlanContext; search: string }) {
  const q = search.trim().toLowerCase();
  const open = ctx.positions.filter((p) => !q || ctx.symbolFor(p.market).toLowerCase().includes(q));
  return (
    <div className="jr-stack">
      {open.length > 0 && (
        <Card
          title={t("plan.j.openNow")}
          sub={String(open.length)}
          aside={
            <span className="jr-pill" data-tone="strong">
              <span className="jr-live-dot" aria-hidden /> {t("plan.in.live")}
            </span>
          }
          flush
        >
          <table className="pd-table jr-table">
            <thead>
              <tr>
                <th>{t("col.market")}</th>
                <th className="pd-num">{t("col.size")}</th>
                <th className="pd-num">{t("col.entry")}</th>
                <th className="pd-num">{t("plan.j.mark")}</th>
                <th className="pd-num">{t("plan.j.unrealized")}</th>
              </tr>
            </thead>
            <tbody>
              {open.map((p) => {
                const key = openKey(p.market, p.side);
                const written = ctx.openTrades.find((x) => x.key === key)?.written;
                return (
                  <tr key={key} onClick={() => ctx.openTrade(key)}>
                    <td>
                      <button
                        type="button"
                        className="jr-rowlink"
                        aria-label={t("plan.j.openTradeOf", { market: ctx.symbolFor(p.market) })}
                        onClick={(e) => {
                          e.stopPropagation();
                          ctx.openTrade(key);
                        }}
                      >
                        <strong>{ctx.symbolFor(p.market)}</strong>
                        <span className={p.side === "long" ? "pd-up" : "pd-down"}>
                          {t(p.side === "long" ? "side.long" : "side.short")}
                        </span>
                        {!written && (
                          <span className="jr-unwritten" title={t("plan.j.notWritten")} />
                        )}
                      </button>
                    </td>
                    <td className="pd-num">{formatNumber(p.size)}</td>
                    <td className="pd-num">{formatNumber(p.entryPrice)}</td>
                    <td className="pd-num">{formatNumber(p.markPrice)}</td>
                    <td className="pd-num">
                      <Money value={Number(p.unrealizedPnl)} />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </Card>
      )}
      <ClosedTrades ctx={ctx} search={search} />
    </div>
  );
}

function ClosedTrades({ ctx, search }: { ctx: PlanContext; search: string }) {
  const shown = ctx.trades.filter((x) => {
    if (!search.trim()) return true;
    const pb = x.note.playbookId ? ctx.playbooks.get(x.note.playbookId)?.name : "";
    return matches(
      [
        ctx.symbolFor(x.note.trade.market),
        pb,
        x.note.notes,
        x.note.reflection.lesson,
        ...x.note.tags,
      ].join(" "),
      search,
    );
  });
  if (shown.length === 0)
    return (
      <Card>
        <Blank
          icon={<LuNotebookPen size={22} aria-hidden />}
          title={ctx.trades.length ? t("plan.j.noMatch") : t("plan.j.noClosedTitle")}
        >
          {ctx.trades.length ? undefined : t("plan.j.noClosed", { venue: ctx.venueLabel })}
        </Blank>
      </Card>
    );
  return (
    <Card title={t("plan.j.trades")} sub={String(shown.length)} flush>
      <table className="pd-table jr-table jr-rows">
        <thead>
          <tr>
            <th>{t("plan.j.closed")}</th>
            <th>{t("col.market")}</th>
            <th>{t("plan.pb.playbook")}</th>
            <th>{t("plan.checklist")}</th>
            <th>{t("plan.grade")}</th>
            <th className="pd-num">R</th>
            <th className="pd-num">{t("plan.net")}</th>
          </tr>
        </thead>
        <tbody>
          {shown.map((x) => {
            const n = x.note;
            const items = n.checklist.length;
            return (
              <tr key={x.key} onClick={() => ctx.openTrade(x.key)}>
                <td className="jr-muted pd-num jr-cell-left">
                  {dateFormat(TRADE_TIME).format(n.trade.closedAt)}
                </td>
                <td>
                  <button type="button" className="jr-rowlink" onClick={() => ctx.openTrade(x.key)}>
                    <strong>{ctx.symbolFor(n.trade.market)}</strong>
                    <span className={n.trade.side === "long" ? "pd-up" : "pd-down"}>
                      {t(n.trade.side === "long" ? "side.long" : "side.short")}
                    </span>
                    {!x.written && <span className="jr-unwritten" title={t("plan.j.notWritten")} />}
                  </button>
                </td>
                <td>
                  {n.playbookId ? (
                    (ctx.playbooks.get(n.playbookId)?.name ?? "-")
                  ) : (
                    <span className="jr-muted">{t("plan.pb.noneLabel")}</span>
                  )}
                </td>
                <td
                  className="pd-num jr-cell-left"
                  data-tone={skippedItems(n) > 0 ? "warn" : undefined}
                >
                  {items
                    ? `${items - n.checklist.filter((c) => !c.checked).length} / ${items}`
                    : "-"}
                </td>
                <td>{x.written ? <span className="jr-grade">{gradeOf(n)}</span> : "-"}</td>
                <td className="pd-num">
                  <RText r={rOf(n)} />
                </td>
                <td className="pd-num">
                  <Money value={n.trade.pnl} />
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </Card>
  );
}

function Insights({
  ctx,
  summaries,
  days,
}: {
  ctx: PlanContext;
  summaries: DaySummary[];
  days: ReadonlyMap<string, JournalDay>;
}) {
  const notes = ctx.trades.map((x) => x.note);
  const all = groupOf(notes);
  const book = groupOf(
    notes.filter((n) => n.playbookId && n.breaks.length === 0 && skippedItems(n) === 0),
  );
  const written = ctx.trades.filter((x) => x.written).length;
  const traded = summaries.filter((s) => s.notes.length > 0);
  const discipline = traded.length
    ? Math.round(traded.reduce((s, d) => s + d.score, 0) / traded.length)
    : undefined;
  const habits = habitCosts(notes);
  const maxHabit = Math.max(1, ...habits.map((h) => Math.abs(h.group.totalR)));
  const cells = processOutcome(notes);
  const moods = byMood(notes, days);
  const maxMood = Math.max(0.1, ...moods.map((m) => Math.abs(avgR(m.group) ?? 0)));
  const hours = byEntryHour(notes);
  const maxHour = Math.max(0.1, ...hours.map((h) => Math.abs(avgR(h.group) ?? 0)));
  const sleep = bySleep(notes, days);
  const decay = edgeDecay(notes);
  const recent = [...traded].reverse().slice(-14);

  if (notes.length === 0)
    return (
      <Card>
        <Blank icon={<LuNotebookPen size={22} aria-hidden />} title={t("plan.j.noTrades")} />
      </Card>
    );
  return (
    <div className="jr-stack">
      <Kpis>
        <Stat
          label={t("plan.j.disciplineAvg")}
          value={discipline ?? "-"}
          note={t("plan.j.tradingDaysN", { n: traded.length })}
        />
        <Stat
          label={t("plan.j.complete")}
          value={pct(written / Math.max(1, notes.length))}
          note={t("plan.j.gradedN", { n: written, of: notes.length })}
        />
        <Stat
          label={t("plan.j.expectancy")}
          value={<RText r={avgR(all)} />}
          note={groupLine(all)}
        />
        <Stat
          label={t("plan.net")}
          value={<Money value={all.pnl} />}
          note={t("plan.tradesN", { n: all.trades })}
        />
        <Stat
          label={t("plan.j.byTheBook")}
          value={<Money value={book.pnl} />}
          note={t("plan.j.ofTrades", { n: book.trades, of: all.trades })}
        />
      </Kpis>
      <div className="jr-grid-2">
        <Card title={t("plan.j.habits")} sub={t("plan.j.habitsSub")}>
          {habits.length === 0 ? (
            <p className="jr-muted">{t("plan.j.noHabits")}</p>
          ) : (
            <ul className="jr-barlist jr-barlist-wide">
              {habits.map((h) => (
                <li key={h.habit.kind === "skipped" ? "skipped" : `${h.habit.kind}:${h.habit.key}`}>
                  <span>
                    {h.habit.kind === "skipped"
                      ? t("plan.checklistSkipped")
                      : h.habit.kind === "break"
                        ? breakLabel(h.habit.key)
                        : h.habit.key}
                    <span className="jr-muted"> · {h.group.trades}</span>
                  </span>
                  <Bar value={h.group.totalR} max={maxHabit} neutral />
                  <RText r={h.group.withR ? h.group.totalR : undefined} />
                  <Money value={h.group.pnl} />
                </li>
              ))}
            </ul>
          )}
        </Card>
        <Card
          title={t("plan.j.process")}
          sub={t("plan.j.processSub")}
          foot={t("plan.j.luckyFirst")}
        >
          <div className="jr-matrix">
            <span />
            <span className="jr-label">{t("plan.j.won")}</span>
            <span className="jr-label">{t("plan.j.lost")}</span>
            <span className="jr-label jr-matrix-row">{t("plan.j.byTheBook")}</span>
            <Cell n={cells.earned.trades} label={t("plan.j.earned")} r={cells.earned.totalR} />
            <Cell
              n={cells.goodLoss.trades}
              label={t("plan.j.goodLoss")}
              r={cells.goodLoss.totalR}
            />
            <span className="jr-label jr-matrix-row">{t("plan.j.broke")}</span>
            <Cell n={cells.lucky.trades} label={t("plan.j.lucky")} r={cells.lucky.totalR} warn />
            <Cell n={cells.paid.trades} label={t("plan.j.paid")} r={cells.paid.totalR} warn />
          </div>
        </Card>
      </div>
      <Card title={t("plan.j.byDay")} sub={t("plan.j.byDaySub")}>
        <DisciplineChart days={recent} />
      </Card>
      <div className="jr-grid-2">
        <Card title={t("plan.j.moodTitle")} sub={t("plan.j.avgRPerTrade")}>
          {moods.length === 0 ? (
            <p className="jr-muted">{t("plan.j.noMoods")}</p>
          ) : (
            <ul className="jr-barlist">
              {moods.map((m) => (
                <li key={m.mood}>
                  <span>
                    {moodLabel(m.mood)}
                    <span className="jr-muted"> · {t("plan.j.daysN", { n: m.days })}</span>
                  </span>
                  <Bar value={avgR(m.group) ?? 0} max={maxMood} />
                  <RText r={avgR(m.group)} />
                </li>
              ))}
            </ul>
          )}
        </Card>
        <Card title={t("plan.j.entryHour")} sub={t("plan.j.avgR")}>
          <ul className="jr-barlist">
            {hours.map((h) => (
              <li key={h.hour}>
                <span className="pd-num">
                  {String(h.hour).padStart(2, "0")}:00
                  <span className="jr-muted"> · {t("plan.j.trShort", { n: h.group.trades })}</span>
                </span>
                <Bar value={avgR(h.group) ?? 0} max={maxHour} />
                <RText r={avgR(h.group)} />
              </li>
            ))}
          </ul>
        </Card>
        <Card title={t("plan.sleep")}>
          <Compare
            items={[
              {
                label: t("plan.j.sleepUnder", { n: sleep.short.days.size }),
                value: <RText r={avgR(sleep.short.group)} />,
                note: t("plan.j.perTrade", { n: sleep.short.group.trades }),
              },
              {
                label: t("plan.j.sleepOver", { n: sleep.rested.days.size }),
                value: <RText r={avgR(sleep.rested.group)} />,
                note: t("plan.j.perTrade", { n: sleep.rested.group.trades }),
              },
            ]}
          />
          {sleep.short.days.size + sleep.rested.days.size < 10 && (
            <p className="jr-hint">{t("plan.j.fewDays")}</p>
          )}
        </Card>
        <Card
          title={t("plan.j.decay")}
          sub={t("plan.j.decaySub")}
          foot={t("plan.j.decayFoot")}
          flush
        >
          <table className="pd-table jr-table">
            <thead>
              <tr>
                <th>{t("plan.pb.playbook")}</th>
                <th className="pd-num">{t("plan.j.all")}</th>
                <th className="pd-num">{t("plan.j.last8")}</th>
                <th className="pd-num">{t("plan.j.change")}</th>
              </tr>
            </thead>
            <tbody>
              {decay.map((d) => (
                <tr key={d.id}>
                  <td>
                    {ctx.playbooks.get(d.id)?.name ?? "-"}{" "}
                    <span className="jr-muted">{d.all.trades}</span>
                  </td>
                  <td className="pd-num">
                    <RText r={avgR(d.all)} />
                  </td>
                  <td className="pd-num">
                    <RText r={avgR(d.recent)} />
                  </td>
                  <td
                    className="pd-num"
                    data-tone={d.change !== undefined && d.change <= -0.3 ? "warn" : undefined}
                  >
                    {d.change === undefined
                      ? "-"
                      : `${d.change >= 0 ? "+" : "−"}${Math.abs(d.change).toFixed(2)}`}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      </div>
    </div>
  );
}

function Cell({ n, label, r, warn }: { n: number; label: string; r: number; warn?: boolean }) {
  return (
    <div className="jr-cell" data-tone={warn ? "warn" : undefined}>
      <strong className="pd-num">{n}</strong>
      <span>{label}</span>
      <RText r={n ? r : undefined} digits={1} />
    </div>
  );
}

/** Each day's score as a line over its R as bars. */
function DisciplineChart({ days }: { days: DaySummary[] }) {
  if (days.length === 0) return <p className="jr-muted">{t("plan.j.noTrades")}</p>;
  const W = 900;
  const H = 200;
  const pad = 24;
  const step = (W - pad * 2) / days.length;
  const maxR = Math.max(1, ...days.map((d) => Math.abs(d.group.totalR)));
  const mid = H / 2 + 10;
  const barH = (r: number) => (Math.abs(r) / maxR) * (H / 2 - 30);
  const scoreY = (s: number) => 14 + ((100 - s) / 100) * (H / 2 - 20);
  const label = dateFormat({ month: "short", day: "numeric", timeZone: "UTC" });
  return (
    <svg
      className="jr-curve"
      viewBox={`0 0 ${W} ${H + 18}`}
      role="img"
      aria-label={t("plan.j.byDay")}
    >
      <line x1={pad} x2={W - pad} y1={mid} y2={mid} className="jr-axis-zero" />
      {days.map((d, i) => {
        const x = pad + step * i + step / 2;
        const h = barH(d.group.totalR);
        return (
          <g key={d.day}>
            <rect
              x={x - Math.min(14, step / 4)}
              width={Math.min(28, step / 2)}
              y={d.group.totalR >= 0 ? mid - h : mid}
              height={h}
              rx={2}
              className="jr-daybar"
              data-tone={d.group.totalR >= 0 ? "up" : "down"}
            >
              <title>{`${d.day} · ${formatR(d.group.totalR)} · ${d.score}`}</title>
            </rect>
            <text x={x} y={H + 14} textAnchor="middle" className="jr-tick">
              {label.format(Date.parse(d.day))}
            </text>
          </g>
        );
      })}
      <path
        className="jr-score-line"
        d={days
          .map((d, i) => `${i ? "L" : "M"}${pad + step * i + step / 2},${scoreY(d.score)}`)
          .join(" ")}
      />
      {days.map((d, i) => (
        <circle
          key={d.day}
          cx={pad + step * i + step / 2}
          cy={scoreY(d.score)}
          r={3.5}
          className="jr-score-dot"
        />
      ))}
    </svg>
  );
}
