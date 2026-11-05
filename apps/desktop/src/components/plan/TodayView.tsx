import { dateFormat, formatMoney, t } from "@pewterdesk/ui";
import { type ReactNode, useMemo, useState } from "react";
import {
  LuArrowRight,
  LuCalendarClock,
  LuCalendarRange,
  LuCheck,
  LuChevronDown,
  LuGauge,
  LuHistory,
  LuInfo,
  LuLock,
  LuNewspaper,
  LuPlay,
  LuPlus,
  LuScrollText,
  LuSearch,
  LuShieldCheck,
  LuTriangleAlert,
} from "react-icons/lu";
import {
  type DayBias,
  expandMarkets,
  inSession,
  isBlankDay,
  MOODS,
  minutesOf,
  utcDay,
} from "../../lib/journal";
import { type Group, groupOf } from "../../lib/journalStats";
import { tradesTaken } from "../../lib/journalTrades";
import { useDayDraft } from "./drafts";
import type { PlanContext } from "./PlanPage";
import {
  Blank,
  Card,
  ChipPicker,
  Field,
  heldText,
  hueOf,
  Money,
  marketHue,
  marketsLine,
  moodLabel,
  NumberInput,
  PageHead,
  Pill,
  Rating,
  RText,
  Stat,
  utcTime,
  weekStartOf,
} from "./parts";
import { WatchCard, WatchEditor } from "./Watchlist";

const LONG_DAY: Intl.DateTimeFormatOptions = {
  weekday: "long",
  month: "long",
  day: "numeric",
  timeZone: "UTC",
};
const SHORT_DAY: Intl.DateTimeFormatOptions = {
  weekday: "short",
  month: "short",
  day: "numeric",
  timeZone: "UTC",
};
const STEPS = ["read", "news", "markets", "ready"] as const;
type StepId = (typeof STEPS)[number];

/** Minutes until the session opens (negative once open), or undefined on a day off. */
function sessionClock(ctx: PlanContext, now: number) {
  const plan = ctx.plan;
  if (!plan) return undefined;
  const weekday = (new Date(now).getUTCDay() + 6) % 7;
  if (!plan.sessions.days[weekday]) return undefined;
  const start = Date.parse(`${utcDay(now)}T00:00:00Z`) + minutesOf(plan.sessions.start) * 60_000;
  let end = Date.parse(`${utcDay(now)}T00:00:00Z`) + minutesOf(plan.sessions.end) * 60_000;
  if (end <= start) end += 86_400_000;
  return { start, end, open: inSession(plan, now) };
}

/**
 * The day's check-in: read the plan, check the news, set levels and a bias for
 * each market, say how you are - one step open at a time. Done, it starts the
 * session, which locks the pre-market part of the day's entry.
 */
export function TodayView({ ctx }: { ctx: PlanContext }) {
  const now = Date.now();
  const today = utcDay(now);
  const { entry, update, commit } = useDayDraft(ctx, today);
  const plan = ctx.plan;
  // The plan's markets as the venue's ids: a rule ("all USDT pairs") takes in
  // whatever the venue lists under it now.
  const markets = useMemo(
    () => expandMarkets(plan?.markets ?? [], ctx.markets),
    [plan?.markets, ctx.markets],
  );
  const started = entry.startedAt !== undefined;
  const clock = sessionClock(ctx, now);
  const [chosen, setChosen] = useState<StepId | null>();

  const news = useMemo(
    () =>
      ctx.calendar
        // USD releases only, every impact: the venues trade against the dollar.
        .filter((e) => e.currency === "USD" && utcDay(e.time) === today)
        .sort((a, b) => a.time - b.time),
    [ctx.calendar, today],
  );
  const highNews = news.filter((e) => e.impact === "high").length;
  const newsMinutes = ctx.rules?.rules.news.on ? ctx.rules.rules.news.minutes : 15;

  const bias = (market: string): DayBias =>
    entry.markets[market] ?? { bias: "neutral", note: "", levels: "" };
  const setMarket = (market: string, change: Partial<DayBias>) =>
    update((e) => ({ ...e, markets: { ...e.markets, [market]: { ...bias(market), ...change } } }));

  // Today's watchlist: the pairs picked for the day (the entry's markets),
  // in the order they were added.
  const watched = Object.keys(entry.markets);
  // The pair whose editor is open.
  const [editing, setEditing] = useState<string>();
  const watch = (market: string) => {
    update((e) =>
      e.markets[market]
        ? e
        : {
            ...e,
            markets: {
              ...e.markets,
              [market]: {
                bias: e.intent.bias ?? "neutral",
                note: "",
                levels: "",
                addedAt: Date.now(),
              },
            },
          },
    );
    // Straight into its editor, to set the bias and levels.
    setEditing(market);
  };
  const unwatch = (market: string) =>
    update((e) => {
      const { [market]: _, ...rest } = e.markets;
      return { ...e, markets: rest };
    });
  const marketsSet = watched.filter((m) => bias(m).levels.trim() !== "").length;
  const steps: Record<StepId, boolean> = {
    read: entry.checkin.planRead !== undefined,
    news: entry.checkin.newsChecked === true,
    markets: watched.length > 0 && marketsSet === watched.length,
    ready: entry.checkin.sleep !== undefined && entry.checkin.focus !== undefined,
  };
  const done = STEPS.filter((s) => steps[s]).length;
  const total = STEPS.length;
  const firstOpen = STEPS.find((s) => !steps[s]);
  // The one the trader opened, or else the first not done; `null` closes them all.
  const open = chosen === undefined ? (started ? undefined : firstOpen) : (chosen ?? undefined);
  const toggle = (id: StepId) => setChosen(open === id ? null : id);
  /** After a step's own button: on to the next one not done. */
  const advance = () => setChosen(undefined);

  // Yesterday and this week, from the journal.
  const yesterday = useMemo(() => {
    const days = [...ctx.journal.data.days]
      .filter(([d, s]) => d < today && !isBlankDay(s.data))
      .map(([d]) => d)
      .sort()
      .reverse();
    const day = days[0];
    if (!day) return undefined;
    const notes = ctx.trades
      .filter((x) => utcDay(x.note.trade.closedAt) === day)
      .map((x) => x.note);
    return { day, entry: ctx.journal.data.days.get(day)?.data, group: groupOf(notes) };
  }, [ctx.journal.data.days, ctx.trades, today]);
  const week = useMemo(() => {
    const monday = weekStartOf(now);
    const notes = ctx.trades
      .filter((x) => utcDay(x.note.trade.closedAt) >= monday)
      .map((x) => x.note);
    const days = Array.from({ length: 7 }, (_, i) => {
      const day = utcDay(Date.parse(`${monday}T00:00:00Z`) + i * 86_400_000);
      return { day, group: groupOf(notes.filter((n) => utcDay(n.trade.closedAt) === day)) };
    });
    return {
      from: monday,
      days,
      group: groupOf(notes),
      breaks: notes.filter((n) => n.breaks.length > 0).length,
      skipped: notes.filter((n) => n.checklist.some((c) => c.required && !c.checked)).length,
    };
  }, [ctx.trades, now]);

  const status = ctx.rulesStatus;
  // Trades taken today, where the rules (Rust's count) are off: today's closed
  // trades and what's open now.
  const taken = tradesTaken(ctx.trades, ctx.openTrades, today, today);
  const sessionLine = !plan
    ? t("plan.today.noPlan")
    : !clock
      ? t("plan.today.dayOff")
      : clock.open
        ? t("plan.today.open")
        : now < clock.start
          ? t("plan.today.startsInText", { time: heldText(clock.start - now) })
          : t("plan.today.closed");

  const readiness = [
    entry.checkin.sleep !== undefined && t("plan.j.slept", { h: entry.checkin.sleep }),
    entry.checkin.focus !== undefined && `${t("plan.focus")} ${entry.checkin.focus}/5`,
    entry.checkin.moods.map(moodLabel).join(", "),
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    <div className="jr-view">
      <PageHead
        eyebrow={t("plan.tab.today")}
        title={dateFormat(LONG_DAY).format(now)}
        meta={
          <>
            {plan && (
              <span>
                {t("plan.session", { start: plan.sessions.start, end: plan.sessions.end })}
              </span>
            )}
            <span data-tone={clock?.open ? "live" : undefined}>{sessionLine}</span>
          </>
        }
        actions={
          started ? (
            <Pill icon={<LuLock size={11} aria-hidden />}>
              {t("plan.today.lockedAt", { time: utcTime(entry.startedAt ?? 0) })}
            </Pill>
          ) : (
            plan && (
              <button
                type="button"
                className="jr-button jr-primary jr-start"
                disabled={done < total}
                title={done < total ? t("plan.today.finishFirst") : undefined}
                onClick={() => commit((e) => ({ ...e, startedAt: Date.now() }))}
              >
                <LuPlay size={13} aria-hidden />
                {t("plan.today.start")}
                <span className="jr-start-count pd-num">
                  {done}/{total}
                </span>
              </button>
            )
          )
        }
      />

      <div className="jr-split">
        <div className="jr-stack">
          {!plan ? (
            <Card className="jr-fill">
              <Blank
                icon={<LuScrollText size={22} aria-hidden />}
                title={t("plan.plan.noneTitle")}
                action={
                  <button
                    type="button"
                    className="jr-button jr-primary"
                    onClick={() => ctx.goTo("plan")}
                  >
                    {t("plan.today.writePlan")}
                  </button>
                }
              >
                {t("plan.today.writePlanFirst")}
              </Blank>
            </Card>
          ) : (
            <Card
              title={t("plan.today.checkin")}
              sub={t("plan.today.progress", { done, total })}
              aside={
                <span className="jr-steps-bar" aria-hidden>
                  {STEPS.map((s) => (
                    <span key={s} data-on={steps[s] || undefined} />
                  ))}
                </span>
              }
              flush
            >
              <ol className="jr-steps">
                <Step
                  n={1}
                  id="read"
                  open={open}
                  onToggle={toggle}
                  done={steps.read}
                  title={t("plan.today.read")}
                  summary={
                    steps.read
                      ? `${t("plan.version", { v: plan.version })} · ${t("plan.today.readAt", { time: utcTime(entry.checkin.planRead ?? 0) })}`
                      : t("plan.version", { v: plan.version })
                  }
                >
                  <PlanDigest ctx={ctx} />
                  {!steps.read && (
                    <div className="jr-step-actions">
                      <button
                        type="button"
                        className="jr-button jr-primary"
                        onClick={() => {
                          update((e) => ({
                            ...e,
                            checkin: { ...e.checkin, planRead: Date.now() },
                          }));
                          advance();
                        }}
                      >
                        <LuCheck size={13} aria-hidden /> {t("plan.today.markRead")}
                      </button>
                      <button
                        type="button"
                        className="jr-button jr-quiet"
                        onClick={() => {
                          update((e) => ({
                            ...e,
                            checkin: { ...e.checkin, planRead: Date.now() },
                          }));
                          ctx.goTo("plan");
                        }}
                      >
                        {t("plan.today.openPlan")}
                      </button>
                    </div>
                  )}
                </Step>

                <Step
                  n={2}
                  id="news"
                  open={open}
                  onToggle={toggle}
                  done={steps.news}
                  title={t("plan.today.news")}
                  summary={t("plan.today.usdNews", { n: news.length, high: highNews })}
                  warn={highNews > 0}
                >
                  {news.length === 0 ? (
                    <p className="jr-quiet-note">
                      <LuNewspaper size={14} aria-hidden /> {t("plan.today.noNews")}
                    </p>
                  ) : (
                    <ul className="jr-news">
                      {news.map((e) => (
                        <li key={`${e.title}:${e.time}`} data-impact={e.impact}>
                          <span className="jr-news-time pd-num">{utcTime(e.time)}</span>
                          <span className="jr-news-body">
                            <strong>{e.title}</strong>
                            {e.impact === "high" ? (
                              <span>
                                {t("plan.today.noEntries", {
                                  from: utcTime(e.time - newsMinutes * 60_000),
                                  to: utcTime(e.time + newsMinutes * 60_000),
                                })}
                              </span>
                            ) : (
                              (e.forecast || e.previous) && (
                                <span className="pd-num">
                                  {[
                                    e.forecast && t("plan.today.forecast", { v: e.forecast }),
                                    e.previous && t("plan.today.previous", { v: e.previous }),
                                  ]
                                    .filter(Boolean)
                                    .join(" · ")}
                                </span>
                              )
                            )}
                          </span>
                          <span className="jr-news-impact">
                            {e.impact === "high" && <LuTriangleAlert size={12} aria-hidden />}
                            {t(`calendar.impact.${e.impact}` as const)}
                          </span>
                        </li>
                      ))}
                    </ul>
                  )}
                  {!steps.news && (
                    <div className="jr-step-actions">
                      <button
                        type="button"
                        className="jr-button jr-primary"
                        onClick={() => {
                          update((e) => ({ ...e, checkin: { ...e.checkin, newsChecked: true } }));
                          advance();
                        }}
                      >
                        <LuCheck size={13} aria-hidden /> {t("plan.today.checked")}
                      </button>
                    </div>
                  )}
                </Step>

                <Step
                  n={3}
                  id="markets"
                  open={open}
                  onToggle={toggle}
                  done={steps.markets}
                  title={t("plan.today.markets")}
                  summary={
                    watched.length
                      ? t("plan.today.biasSet", { n: marketsSet, of: watched.length })
                      : t("plan.today.watchPick")
                  }
                >
                  {markets.length === 0 ? (
                    <p className="jr-quiet-note">{t("plan.j.noMarkets")}</p>
                  ) : (
                    <>
                      <p className="jr-hint">{t("plan.today.watchHint")}</p>
                      {watched.length > 0 ? (
                        <div className="jr-watchcards">
                          {watched.map((m) => (
                            <WatchCard
                              key={m}
                              symbol={ctx.symbolFor(m)}
                              marketId={m}
                              market={ctx.marketOf(m)}
                              summary={ctx.summaryOf(m)}
                              value={bias(m)}
                              disabled={started}
                              onOpen={() => setEditing(m)}
                              onRemove={() => unwatch(m)}
                            />
                          ))}
                        </div>
                      ) : (
                        <p className="jr-quiet-note">{t("plan.today.watchNone")}</p>
                      )}
                      {!started && (
                        <WatchPicker ctx={ctx} pool={markets} watched={watched} onWatch={watch} />
                      )}
                      {editing && entry.markets[editing] && (
                        <WatchEditor
                          key={editing}
                          open
                          symbol={ctx.symbolFor(editing)}
                          marketId={editing}
                          market={ctx.marketOf(editing)}
                          summary={ctx.summaryOf(editing)}
                          value={bias(editing)}
                          disabled={started}
                          onSave={(change) => setMarket(editing, change)}
                          onRemove={() => unwatch(editing)}
                          onClose={() => setEditing(undefined)}
                        />
                      )}
                    </>
                  )}
                </Step>

                <Step
                  n={4}
                  id="ready"
                  open={open}
                  onToggle={toggle}
                  done={steps.ready}
                  title={t("plan.today.readiness")}
                  summary={readiness || t("plan.j.notStarted")}
                >
                  <div className="jr-ready">
                    <Field label={t("plan.sleep")}>
                      <NumberInput
                        label={t("plan.sleep")}
                        unit="h"
                        min={0}
                        max={24}
                        value={entry.checkin.sleep}
                        disabled={started}
                        onChange={(sleep) =>
                          update((e) => ({ ...e, checkin: { ...e.checkin, sleep } }))
                        }
                      />
                    </Field>
                    <Rating
                      label={t("plan.today.focusNow")}
                      hue="focus"
                      max={5}
                      value={entry.checkin.focus}
                      disabled={started}
                      onChange={(focus) =>
                        update((e) => ({ ...e, checkin: { ...e.checkin, focus } }))
                      }
                    />
                  </div>
                  <Field label={t("plan.today.mood")}>
                    <ChipPicker
                      label={t("plan.today.mood")}
                      colored
                      options={MOODS}
                      picked={entry.checkin.moods}
                      render={moodLabel}
                      disabled={started}
                      onChange={(moods) =>
                        update((e) => ({ ...e, checkin: { ...e.checkin, moods } }))
                      }
                    />
                  </Field>
                  <Field label={t("plan.today.mind")} hint={t("plan.today.readinessHint")}>
                    <input
                      className="pd-input"
                      value={entry.checkin.mind}
                      disabled={started}
                      placeholder={t("plan.optional")}
                      aria-label={t("plan.today.mind")}
                      onChange={(e) =>
                        update((x) => ({ ...x, checkin: { ...x.checkin, mind: e.target.value } }))
                      }
                    />
                  </Field>
                </Step>
              </ol>
            </Card>
          )}
        </div>

        <aside className="jr-rail">
          <Card
            className="jr-rc"
            data-hue="limits"
            icon={<LuShieldCheck size={15} aria-hidden />}
            title={t("plan.today.limits")}
            sub={plan ? t("plan.fromPlan", { v: plan.version }) : undefined}
            aside={
              <Pill tone={status ? "up" : "down"}>
                <span className="jr-dot" data-on={status ? "" : undefined} aria-hidden />
                {status ? t("plan.today.rulesOn") : t("plan.today.rulesOffPill")}
              </Pill>
            }
            foot={
              !status && plan ? (
                <span className="jr-callout">
                  <LuInfo size={13} aria-hidden />
                  {t("plan.today.rulesOff")}
                </span>
              ) : undefined
            }
          >
            {plan ? (
              <>
                <div className="jr-limit-list">
                  <Limit
                    label={t("plan.dailyStop")}
                    used={Math.max(0, -(status?.dayPnl ?? 0))}
                    cap={plan.dailyStop || undefined}
                    format={formatMoney}
                  />
                  <Limit
                    label={t("plan.trades")}
                    used={status?.tradesToday ?? taken.total}
                    cap={plan.maxTradesPerDay || undefined}
                    count
                    detail={
                      taken.total
                        ? t("plan.in.takenSplit", { open: taken.open, closed: taken.closed })
                        : undefined
                    }
                  />
                  <Limit
                    label={t("plan.lossesInRow")}
                    used={status?.lossStreak ?? 0}
                    cap={plan.maxLossesInRow || undefined}
                    count
                  />
                </div>
                <dl className="jr-limit-risk">
                  <dt>{t("plan.riskPerTrade")}</dt>
                  <dd className="pd-num">
                    {plan.riskPct}%
                    {ctx.equity ? (
                      <span className="jr-muted">
                        {" "}
                        · {formatMoney((ctx.equity * plan.riskPct) / 100)}
                      </span>
                    ) : null}
                  </dd>
                </dl>
              </>
            ) : (
              <RailEmpty
                icon={<LuGauge size={16} aria-hidden />}
                title={t("plan.today.noLimitsTitle")}
                body={t("plan.today.noLimitsBody")}
                action={
                  <button type="button" className="jr-button" onClick={() => ctx.goTo("plan")}>
                    {t("plan.today.setLimits")}
                    <LuArrowRight size={13} aria-hidden />
                  </button>
                }
              />
            )}
          </Card>

          <Card
            className="jr-rc"
            data-hue="yesterday"
            icon={<LuHistory size={15} aria-hidden />}
            title={
              <button
                type="button"
                className="jr-card-titlebtn"
                onClick={() => ctx.goTo("journal")}
              >
                {t("plan.today.yesterday")}
              </button>
            }
            sub={yesterday && dateFormat(SHORT_DAY).format(Date.parse(yesterday.day))}
            aside={
              <>
                {yesterday?.entry?.review.savedAt && (
                  <Pill icon={<LuCheck size={11} aria-hidden />}>{t("plan.journaled")}</Pill>
                )}
                <button
                  type="button"
                  className="jr-link jr-foot-link"
                  onClick={() => ctx.goTo("journal")}
                >
                  {t("plan.past.all")}
                  <LuArrowRight size={12} aria-hidden />
                </button>
              </>
            }
            foot={
              yesterday ? (
                <button
                  type="button"
                  className="jr-link jr-foot-link"
                  onClick={() => ctx.openDay(yesterday.day)}
                >
                  {t("plan.today.openEntry")}
                  <LuArrowRight size={12} aria-hidden />
                </button>
              ) : undefined
            }
          >
            {yesterday ? (
              <>
                <div className="jr-tiles">
                  <Stat label={t("plan.net")} value={<Money value={yesterday.group.pnl} />} />
                  <Stat
                    label={t("plan.today.netR")}
                    value={<RText r={yesterday.group.withR ? yesterday.group.totalR : undefined} />}
                    note={t("plan.tradesN", { n: yesterday.group.trades })}
                  />
                </div>
                {yesterday.entry?.review.lesson && (
                  <blockquote className="jr-quote">{yesterday.entry.review.lesson}</blockquote>
                )}
                {yesterday.entry?.review.tomorrow && (
                  <p className="jr-hint">
                    <strong>{t("plan.j.tomorrow")}:</strong> {yesterday.entry.review.tomorrow}
                  </p>
                )}
              </>
            ) : (
              <RailEmpty
                icon={<LuCalendarClock size={16} aria-hidden />}
                title={t("plan.today.noYesterday")}
                body={t("plan.today.yesterdayHint")}
              />
            )}
          </Card>

          <Card
            className="jr-rc"
            data-hue="week"
            icon={<LuCalendarRange size={15} aria-hidden />}
            title={t("plan.today.week")}
            sub={t("plan.today.weekFrom", {
              date: dateFormat(SHORT_DAY).format(Date.parse(week.from)),
            })}
          >
            <WeekStrip days={week.days} today={today} />
            <div className="jr-tiles">
              <Stat label={t("plan.net")} value={<Money value={week.group.pnl} />} />
              <Stat
                label={t("plan.today.netR")}
                value={<RText r={week.group.withR ? week.group.totalR : undefined} />}
              />
              <Stat label={t("plan.trades")} value={week.group.trades} />
              <Stat
                label={t("plan.ruleBreaks")}
                value={<span data-tone={week.breaks ? "warn" : undefined}>{week.breaks}</span>}
              />
            </div>
            <p className="jr-hint">
              {week.group.trades
                ? t("plan.today.skippedOf", { n: week.skipped, of: week.group.trades })
                : t("plan.today.noTradesWeek")}
            </p>
          </Card>
        </aside>
      </div>
    </div>
  );
}

/** One of today's limits: what's used against the plan's cap, and what's left. */
function Limit({
  label,
  used,
  cap,
  count,
  format = String,
  detail,
}: {
  label: string;
  used: number;
  cap: number | undefined;
  /** A whole-number limit: drawn as one segment per unit when it's small. */
  count?: boolean;
  /** A word after what's left, e.g. "1 open · 1 closed". */
  detail?: string;
  format?: (n: number) => string;
}) {
  const share = cap ? Math.max(0, Math.min(1, used / cap)) : 0;
  const tone = cap && used >= cap ? "stop" : cap && share >= 0.75 ? "warn" : undefined;
  const segments = count && cap && cap <= 12 ? cap : 0;
  return (
    <div className="jr-limit" data-tone={tone}>
      <div className="jr-limit-row">
        <span className="jr-limit-label">{label}</span>
        <span className="pd-num jr-limit-value">
          {format(used)}
          {cap ? <span className="jr-muted"> / {format(cap)}</span> : null}
        </span>
      </div>
      {segments ? (
        <span className="jr-limit-segs" aria-hidden>
          {Array.from({ length: segments }, (_, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: fixed positions
            <span key={i} data-on={i < used ? "" : undefined} />
          ))}
        </span>
      ) : (
        <span className="jr-limit-track" data-off={cap ? undefined : ""} aria-hidden>
          <span style={{ width: `${share * 100}%` }} />
        </span>
      )}
      <span className="jr-limit-note">
        {!cap
          ? t("plan.today.noCap")
          : used >= cap
            ? t("plan.today.atLimit")
            : t("plan.today.limitLeft", { n: format(cap - used) })}
        {detail && <span className="jr-limit-detail"> · {detail}</span>}
      </span>
    </div>
  );
}

/** A rail card with nothing in it yet: what will show, and the way to start. */
function RailEmpty({
  icon,
  title,
  body,
  action,
}: {
  icon: ReactNode;
  title: string;
  body: string;
  action?: ReactNode;
}) {
  return (
    <div className="jr-rail-empty">
      <span className="jr-rail-empty-icon">{icon}</span>
      <div className="jr-rail-empty-text">
        <strong>{title}</strong>
        <p className="jr-hint">{body}</p>
        {action}
      </div>
    </div>
  );
}

const WEEKDAY: Intl.DateTimeFormatOptions = { weekday: "narrow", timeZone: "UTC" };

/** The week by day: each day's P&L as a bar, today marked, days ahead dimmed. */
function WeekStrip({
  days,
  today,
}: {
  days: readonly { day: string; group: Group }[];
  today: string;
}) {
  const peak = Math.max(...days.map((d) => Math.abs(d.group.pnl)), 0);
  const fmt = dateFormat(WEEKDAY);
  const long = dateFormat(SHORT_DAY);
  return (
    <ol className="jr-weekstrip">
      {days.map(({ day, group }) => {
        const at = Date.parse(`${day}T00:00:00Z`);
        const tone = !group.trades
          ? undefined
          : group.pnl > 0
            ? "up"
            : group.pnl < 0
              ? "down"
              : "flat";
        const height = peak && group.trades ? Math.max(0.12, Math.abs(group.pnl) / peak) : 0;
        return (
          <li
            key={day}
            data-today={day === today ? "" : undefined}
            data-ahead={day > today ? "" : undefined}
            title={
              group.trades
                ? t("plan.today.dayPnl", { day: long.format(at), pnl: formatMoney(group.pnl) })
                : long.format(at)
            }
          >
            <span className="jr-weekstrip-bar" data-tone={tone}>
              <span style={{ height: `${height * 100}%` }} />
            </span>
            <span className="jr-weekstrip-day">{fmt.format(at)}</span>
          </li>
        );
      })}
    </ol>
  );
}

/**
 * Adds pairs to today's watchlist, out of the plan's markets: the busiest
 * first, and a search over all of them.
 */
function WatchPicker({
  ctx,
  pool,
  watched,
  onWatch,
}: {
  ctx: PlanContext;
  pool: readonly string[];
  watched: readonly string[];
  onWatch: (market: string) => void;
}) {
  const [query, setQuery] = useState("");
  const q = query.trim().toLowerCase();
  const on = useMemo(() => new Set(watched), [watched]);
  const offer = useMemo(() => {
    const inPlan = new Set(pool);
    const listed = new Set(ctx.markets.map((m) => m.id));
    // The venue's own order (busiest first) for what's in the plan, then any
    // plan market the venue no longer lists.
    const ordered = [
      ...ctx.markets.map((m) => m.id).filter((id) => inPlan.has(id)),
      ...pool.filter((id) => !listed.has(id)),
    ].filter((id) => !on.has(id));
    const matching = q
      ? ordered.filter(
          (id) => ctx.symbolFor(id).toLowerCase().includes(q) || id.toLowerCase().includes(q),
        )
      : ordered;
    return matching.slice(0, q ? 40 : 12);
  }, [ctx, pool, on, q]);
  return (
    <div className="jr-watchadd">
      <div className="jr-watchadd-head">
        <LuPlus size={14} aria-hidden />
        <strong>{watched.length ? t("plan.today.watchAddMore") : t("plan.today.watchAdd")}</strong>
      </div>
      <label className="jr-search jr-watch-search">
        <LuSearch size={13} aria-hidden />
        <input
          value={query}
          placeholder={t("plan.today.watchSearch", { n: pool.length })}
          aria-label={t("plan.today.watchSearch", { n: pool.length })}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            const first = offer[0];
            if (e.key === "Enter" && first) {
              e.preventDefault();
              onWatch(first);
              setQuery("");
            } else if (e.key === "Escape") setQuery("");
          }}
        />
      </label>
      {offer.length > 0 ? (
        <div className="jr-chips">
          {!q && <span className="jr-muted jr-watchadd-quick">{t("plan.today.quickAdd")}</span>}
          {offer.map((m) => (
            <button
              key={m}
              type="button"
              className="jr-chip"
              data-pick=""
              style={hueOf(marketHue(m))}
              aria-pressed={false}
              onClick={() => onWatch(m)}
            >
              <LuPlus size={11} aria-hidden />
              {ctx.symbolFor(m)}
            </button>
          ))}
        </div>
      ) : (
        q && <p className="jr-hint">{t("plan.plan.noMarketMatch", { q: query.trim() })}</p>
      )}
    </div>
  );
}

/** The plan in brief, to read where the check-in is. */
function PlanDigest({ ctx }: { ctx: PlanContext }) {
  const plan = ctx.plan;
  if (!plan) return null;
  return (
    <div className="jr-digest">
      {plan.goal && <p className="jr-digest-goal">{plan.goal}</p>}
      {plan.creed && <blockquote className="jr-quote">{plan.creed}</blockquote>}
      <dl className="jr-digest-facts">
        <dt>{t("plan.riskPerTrade")}</dt>
        <dd className="pd-num">{plan.riskPct}%</dd>
        {plan.maxTradesPerDay > 0 && (
          <>
            <dt>{t("plan.rule.tradesPerDay")}</dt>
            <dd className="pd-num">{plan.maxTradesPerDay}</dd>
          </>
        )}
        {plan.dailyStop > 0 && (
          <>
            <dt>{t("plan.dailyStop")}</dt>
            <dd className="pd-num">{formatMoney(plan.dailyStop)}</dd>
          </>
        )}
        {plan.markets.length > 0 && (
          <>
            <dt>{t("plan.plan.markets")}</dt>
            <dd>{marketsLine(plan.markets, ctx.markets, ctx.symbolFor)}</dd>
          </>
        )}
      </dl>
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
      {plan.routine.before.length > 0 && (
        <div>
          <span className="jr-label">{t("plan.plan.before")}</span>
          <ol className="jr-numbered">
            {plan.routine.before.map((x) => (
              <li key={x}>{x}</li>
            ))}
          </ol>
        </div>
      )}
    </div>
  );
}

function Step({
  n,
  id,
  open,
  onToggle,
  done,
  title,
  summary,
  warn,
  children,
}: {
  n: number;
  id: StepId;
  open: StepId | undefined;
  onToggle: (id: StepId) => void;
  done: boolean;
  title: string;
  summary?: string;
  warn?: boolean;
  children?: ReactNode;
}) {
  const isOpen = open === id;
  const bodyId = `jr-step-${id}`;
  return (
    <li className="jr-step" data-done={done || undefined} data-open={isOpen || undefined}>
      <button
        type="button"
        className="jr-step-head"
        aria-expanded={isOpen}
        aria-controls={bodyId}
        onClick={() => onToggle(id)}
      >
        <span className="jr-step-mark" aria-hidden>
          {done ? <LuCheck size={12} /> : n}
        </span>
        <span className="jr-step-title">
          {title}
          <span className="pd-visually-hidden"> {done ? t("plan.done") : t("plan.notDone")}</span>
        </span>
        {summary && (
          <span className="jr-step-summary" data-tone={warn && !done ? "warn" : undefined}>
            {summary}
          </span>
        )}
        <LuChevronDown size={14} aria-hidden className="jr-step-chev" />
      </button>
      {isOpen && (
        <div className="jr-step-body" id={bodyId}>
          {children}
        </div>
      )}
    </li>
  );
}
