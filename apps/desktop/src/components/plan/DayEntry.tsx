import { dateFormat, formatNumber, t } from "@pewterdesk/ui";
import { type ReactNode, useState } from "react";
import {
  LuCheck,
  LuChevronLeft,
  LuChevronRight,
  LuCopy,
  LuLightbulb,
  LuLock,
  LuLockOpen,
  LuPin,
  LuPinOff,
  LuShieldCheck,
  LuTrash2,
} from "react-icons/lu";
import { allocation, armedCount, intentIssues, limitsFrom } from "../../lib/dayIntent";
import {
  addDays,
  type Bias,
  type DayBias,
  disciplineScore,
  gradeOf,
  isBlankDay,
  type JournalDay,
  MOODS,
  type Mood,
  minutesOf,
  rOf,
  skippedItems,
  utcDay,
} from "../../lib/journal";
import { type DaySummary, groupOf, journalStreak } from "../../lib/journalStats";
import { tradesTaken } from "../../lib/journalTrades";
import { useDayDraft } from "./drafts";
import { AllocationBar, IntentIssues, MarketPicker, SessionMap, Stars, TokenCard } from "./intent";
import type { PlanContext } from "./PlanPage";
import {
  ActionBar,
  breakLabel,
  Card,
  ChipPicker,
  ConfirmButton,
  Field,
  formatR,
  LinesEditor,
  Money,
  MoodSelect,
  moodLabel,
  NumberInput,
  PageHead,
  Pill,
  Prose,
  Rating,
  RText,
  ScoreRing,
  Segment,
  Slider,
  Stat,
  TagEditor,
  utcTime,
} from "./parts";

const DATE: Intl.DateTimeFormatOptions = {
  weekday: "short",
  month: "short",
  day: "numeric",
  timeZone: "UTC",
};
const BIASES: readonly Bias[] = ["long", "neutral", "short"];

/**
 * One day's journal: its context, the pre-market intent (the day's bias and
 * risk, each market's plan, all against the trader's limits; locked once the
 * session starts, and unlockable), the live session with its trades and
 * notes, and the end-of-day review.
 */
export function DayEntry({
  ctx,
  day,
  onDay,
  summaries,
}: {
  ctx: PlanContext;
  day: string;
  onDay: (day?: string) => void;
  summaries: DaySummary[];
}) {
  const { entry, update, commit, locked } = useDayDraft(ctx, day);
  const [note, setNote] = useState("");
  const [noteMood, setNoteMood] = useState<Mood>();
  const [addendum, setAddendum] = useState("");
  const [copied, setCopied] = useState(false);
  const [openToken, setOpenToken] = useState<string>();
  const today = utcDay(Date.now());
  const isToday = day === today;
  const trades = ctx.trades.filter((x) => utcDay(x.note.trade.closedAt) === day);
  const notes = trades.map((x) => x.note);
  const group = groupOf(notes);
  const breaks = notes.flatMap((n) => n.breaks);
  const skipped = notes.reduce((s, n) => s + skippedItems(n), 0);
  const score = disciplineScore(entry, notes);
  const intentLocked = entry.startedAt !== undefined || locked;
  const plan = ctx.plan;
  const days = new Map(
    [...ctx.journal.data.days].filter(([, s]) => !isBlankDay(s.data)).map(([d, s]) => [d, s.data]),
  );
  const streak = journalStreak(summaries, days, today);
  const limits = limitsFrom(ctx.rules, plan);
  const alloc = allocation(entry, limits);
  const issues = intentIssues(entry, limits);
  const tokens = Object.keys(entry.markets);
  const tradedOn = (m: string) => trades.filter((x) => x.note.trade.market === m);
  const offPlan = (market: string) => tokens.length > 0 && !tokens.includes(market);
  const positions = isToday ? ctx.positions : [];
  // Taken today: what closed today, and on today's page what's still open (a
  // position doesn't say when it opened, so one held from yesterday counts too).
  const takenSplit = tradesTaken(ctx.trades, ctx.openTrades, day, utcDay(Date.now()));
  const taken = takenSplit.total;
  const monthDays = summaries.filter((s) => s.day.slice(0, 7) === day.slice(0, 7) && s.day <= day);

  const setReview = (change: Partial<JournalDay["review"]>) =>
    update((e) => ({ ...e, review: { ...e.review, ...change } }));
  const setCheckin = (change: Partial<JournalDay["checkin"]>) =>
    update((e) => ({ ...e, checkin: { ...e.checkin, ...change } }));
  const setIntent = (change: Partial<JournalDay["intent"]>) =>
    update((e) => ({ ...e, intent: { ...e.intent, ...change } }));
  const setToken = (market: string, change: Partial<DayBias>) =>
    update((e) => ({
      ...e,
      markets: {
        ...e.markets,
        [market]: { bias: "neutral", note: "", levels: "", ...e.markets[market], ...change },
      },
    }));
  const removeToken = (market: string) =>
    update((e) => {
      const { [market]: _, ...rest } = e.markets;
      return { ...e, markets: rest };
    });
  const addToken = (id: string) => {
    if (!entry.markets[id]) {
      // A first guess the trader can change: the day's bias, and one trade at the per-trade limit if it fits.
      const fits =
        limits.perTrade &&
        (alloc.remaining === undefined || alloc.remaining >= limits.perTrade.value);
      setToken(id, {
        bias: entry.intent.bias ?? "neutral",
        riskPct: fits ? limits.perTrade?.value : undefined,
        maxTrades: 1,
      });
    }
    setOpenToken(id);
  };

  const markdown = () =>
    [
      `# ${t("plan.j.mdTitle", { day })}`,
      "",
      `${t("plan.net")}: ${group.pnl.toFixed(2)} · ${formatR(group.withR ? group.totalR : undefined)} · ${t("plan.tradesN", { n: group.trades })}`,
      `${t("plan.j.discipline")}: ${score}`,
      "",
      `## ${t("plan.in.title")}`,
      entry.plan,
      ...tokens.map((m) => {
        const x = entry.markets[m];
        return `- ${ctx.symbolFor(m)}: ${x?.bias ?? "-"} · ${x?.riskPct ?? "-"}% · ${x?.note ?? ""} ${x?.levels ?? ""}`;
      }),
      "",
      `## ${t("plan.j.sessionTitle")}`,
      ...trades.map(
        (x) =>
          `- ${ctx.symbolFor(x.note.trade.market)} ${x.note.trade.side} ${formatR(rOf(x.note))} ${x.note.trade.pnl.toFixed(2)}`,
      ),
      ...entry.notes.map((n) => `- ${utcTime(n.at)} ${n.text}`),
      "",
      `## ${t("plan.j.eodTitle")}`,
      `${t("plan.j.right")}: ${entry.review.right}`,
      `${t("plan.j.wrong")}: ${entry.review.wrong}`,
      `${t("plan.lesson")}: ${entry.review.lesson}`,
      `${t("plan.j.tomorrow")}: ${entry.review.tomorrow}`,
    ].join("\n");

  const moodsOfDay = [
    ...(entry.startedAt && entry.checkin.moods.length > 0
      ? [{ at: entry.startedAt, moods: entry.checkin.moods }]
      : []),
    ...entry.notes.filter((n) => n.mood).map((n) => ({ at: n.at, moods: [n.mood as Mood] })),
  ];
  const sessionWindow = plan
    ? { from: minutesOf(plan.sessions.start) / 60, to: minutesOf(plan.sessions.end) / 60 }
    : undefined;

  return (
    <div className="jr-view">
      <PageHead
        back={{ label: t("plan.j.backToJournal"), onClick: () => onDay(undefined) }}
        title={
          <span className="jr-daytitle">
            <button
              type="button"
              className="jr-icon"
              aria-label={t("plan.j.prevDay")}
              onClick={() => onDay(addDays(day, -1))}
            >
              <LuChevronLeft size={16} aria-hidden />
            </button>
            {t("plan.in.dayContext", { date: dateFormat(DATE).format(Date.parse(day)) })}
            <button
              type="button"
              className="jr-icon"
              aria-label={t("plan.j.nextDay")}
              disabled={day >= today}
              onClick={() => onDay(addDays(day, 1))}
            >
              <LuChevronRight size={16} aria-hidden />
            </button>
          </span>
        }
        meta={
          <>
            {locked && <Pill icon={<LuLock size={10} aria-hidden />}>{t("plan.j.finalized")}</Pill>}
            {plan && (
              <span>
                {t("plan.session", { start: plan.sessions.start, end: plan.sessions.end })}
              </span>
            )}
            <span>{t("plan.in.tradingDayN", { n: Math.max(1, monthDays.length) })}</span>
            <span>{t("plan.j.streakN", { n: streak })}</span>
            <Pill icon={<LuShieldCheck size={11} aria-hidden />} tone="strong">
              {t("plan.in.armed", { n: armedCount(limits, ctx.rules) })}
            </Pill>
          </>
        }
        actions={
          <>
            <button
              type="button"
              className="jr-icon jr-icon-lg"
              aria-pressed={entry.pinned === true}
              aria-label={entry.pinned ? t("plan.j.unpin") : t("plan.j.pin")}
              title={entry.pinned ? t("plan.j.unpin") : t("plan.j.pin")}
              onClick={() => commit((e) => ({ ...e, pinned: !e.pinned || undefined }))}
            >
              {entry.pinned ? <LuPinOff size={15} aria-hidden /> : <LuPin size={15} aria-hidden />}
            </button>
            <button
              type="button"
              className="jr-icon jr-icon-lg"
              aria-label={t("plan.j.exportMd")}
              title={copied ? t("plan.copied") : t("plan.j.exportMd")}
              onClick={() => {
                void navigator.clipboard.writeText(markdown()).then(() => {
                  setCopied(true);
                  setTimeout(() => setCopied(false), 1500);
                });
              }}
            >
              {copied ? <LuCheck size={15} aria-hidden /> : <LuCopy size={15} aria-hidden />}
            </button>
            <ConfirmButton
              className="jr-button jr-danger"
              title={t("plan.confirm.dayTitle")}
              body={t("plan.confirm.dayBody")}
              action={t("plan.delete")}
              danger
              onConfirm={() => {
                // Cleared first, so the draft this view saves as it closes is dropped.
                void ctx.journal.clearDays([day]).catch(() => {});
                onDay(undefined);
              }}
            >
              <LuTrash2 size={13} aria-hidden /> {t("plan.delete")}
            </ConfirmButton>
          </>
        }
      />

      <section className="jr-card jr-context">
        <div className="jr-context-top">
          <div className="jr-mission">
            <span className="jr-label">{t("plan.in.mission")}</span>
            {intentLocked ? (
              <p className={entry.plan ? undefined : "jr-muted"}>
                {entry.plan || t("plan.in.noMission")}
              </p>
            ) : (
              <Prose
                value={entry.plan}
                rows={2}
                label={t("plan.in.mission")}
                placeholder={t("plan.j.planPh")}
                onChange={(text) => update((e) => ({ ...e, plan: text }))}
              />
            )}
          </div>
          <div className="jr-context-figures">
            <Stat
              label={t("plan.j.dayPnl")}
              value={<Money value={group.pnl} />}
              note={`${formatR(group.withR ? group.totalR : undefined)} · ${t("plan.tradesN", { n: group.trades })}`}
            />
          </div>
        </div>
        <SessionMap today={isToday} window={sessionWindow} />
      </section>

      <div className="jr-split">
        <div className="jr-phases">
          <Phase
            n={1}
            title={t("plan.in.title")}
            sub={t("plan.in.sub")}
            done={entry.startedAt !== undefined}
            aside={
              locked ? undefined : intentLocked ? (
                <>
                  <Pill icon={<LuLock size={10} aria-hidden />}>
                    {t("plan.in.lockedAt", { time: utcTime(entry.startedAt ?? 0) })}
                  </Pill>
                  <ConfirmButton
                    className="jr-button jr-quiet"
                    title={t("plan.confirm.unlockTitle")}
                    body={t("plan.confirm.unlockBody")}
                    action={t("plan.in.unlock")}
                    onConfirm={() => commit((e) => ({ ...e, startedAt: undefined }))}
                  >
                    <LuLockOpen size={13} aria-hidden /> {t("plan.in.unlock")}
                  </ConfirmButton>
                </>
              ) : (
                <button
                  type="button"
                  className="jr-button"
                  onClick={() => commit((e) => ({ ...e, startedAt: Date.now() }))}
                >
                  <LuLock size={13} aria-hidden /> {t("plan.in.lock")}
                </button>
              )
            }
          >
            <div className="jr-intent">
              <Field label={t("plan.in.dayBias")}>
                <Segment
                  label={t("plan.in.dayBias")}
                  value={entry.intent.bias}
                  disabled={intentLocked}
                  options={BIASES.map((b) => ({ value: b, label: t(`plan.bias.${b}` as const) }))}
                  onChange={(bias) => setIntent({ bias })}
                />
              </Field>
              <Field label={t("plan.td.conviction")}>
                <Stars
                  value={entry.intent.conviction}
                  label={t("plan.td.conviction")}
                  size={18}
                  disabled={intentLocked}
                  onChange={(conviction) => setIntent({ conviction })}
                />
              </Field>
              <Field
                label={t("plan.in.riskCap")}
                hint={
                  limits.daily
                    ? t(limits.daily.from === "rules" ? "plan.in.dailyRule" : "plan.in.dailyPlan", {
                        v: formatNumber(limits.daily.value),
                      })
                    : undefined
                }
              >
                <NumberInput
                  label={t("plan.in.riskCap")}
                  unit={t("plan.in.ofAccount")}
                  min={0}
                  max={100}
                  value={entry.intent.riskCap}
                  placeholder={limits.daily ? formatNumber(limits.daily.value) : undefined}
                  disabled={intentLocked}
                  onChange={(riskCap) => setIntent({ riskCap })}
                />
              </Field>
              <Field
                label={t("plan.in.maxTradesToday")}
                hint={
                  limits.tradesPerDay
                    ? t(
                        limits.tradesPerDay.from === "rules"
                          ? "plan.in.tradesRule"
                          : "plan.in.tradesPlan",
                        { n: limits.tradesPerDay.value },
                      )
                    : undefined
                }
              >
                <NumberInput
                  label={t("plan.in.maxTradesToday")}
                  min={0}
                  max={1000}
                  step={1}
                  value={entry.intent.maxTrades}
                  placeholder={limits.tradesPerDay ? String(limits.tradesPerDay.value) : undefined}
                  disabled={intentLocked}
                  onChange={(maxTrades) => setIntent({ maxTrades })}
                />
              </Field>
            </div>

            <div className="jr-subhead">{t("plan.j.stateOfMind")}</div>
            <div className="jr-ratings">
              <Slider
                label={t("plan.sleep")}
                hue="sleep"
                min={0}
                max={12}
                step={0.1}
                value={entry.checkin.sleep}
                disabled={intentLocked}
                format={(v) => `${v.toFixed(1)} h`}
                onChange={(sleep) => setCheckin({ sleep })}
              />
              <Rating
                label={t("plan.energy")}
                hue="energy"
                max={10}
                value={entry.checkin.energy}
                disabled={intentLocked}
                onChange={(energy) => setCheckin({ energy })}
              />
              <Rating
                label={t("plan.focus")}
                hue="focus"
                max={5}
                value={entry.checkin.focus}
                disabled={intentLocked}
                onChange={(focus) => setCheckin({ focus })}
              />
            </div>
            <ChipPicker
              label={t("plan.today.mood")}
              colored
              options={MOODS}
              picked={entry.checkin.moods}
              render={moodLabel}
              disabled={intentLocked}
              onChange={(moods) => setCheckin({ moods })}
            />

            <AllocationBar
              a={alloc}
              symbolFor={ctx.symbolFor}
              marketFor={(id) => ctx.markets.find((m) => m.id === id)}
              tradesUsed={trades.length}
            />
            <IntentIssues issues={issues} symbolFor={ctx.symbolFor} onOpenRules={ctx.onOpenRules} />

            <div className="jr-tokens">
              {tokens.map((m) => {
                const done = tradedOn(m);
                return (
                  <TokenCard
                    key={m}
                    market={ctx.markets.find((x) => x.id === m)}
                    symbol={ctx.symbolFor(m)}
                    value={entry.markets[m] as DayBias}
                    locked={intentLocked}
                    traded={done.length}
                    pnl={done.reduce((s, x) => s + x.note.trade.pnl, 0)}
                    perTrade={limits.perTrade?.value}
                    open={openToken === m}
                    onToggle={() => setOpenToken(openToken === m ? undefined : m)}
                    onChange={(change) => setToken(m, change)}
                    onRemove={() => removeToken(m)}
                  />
                );
              })}
              {!intentLocked && (
                <MarketPicker markets={ctx.markets} taken={new Set(tokens)} onPick={addToken} />
              )}
              {tokens.length === 0 && intentLocked && (
                <p className="jr-quiet-note">{t("plan.in.noTokens")}</p>
              )}
            </div>

            <Field label={t("plan.j.noTrade")}>
              {intentLocked ? (
                entry.noTrade.length ? (
                  <ul className="jr-ticks" data-tone="warn">
                    {entry.noTrade.map((x) => (
                      <li key={x}>{x}</li>
                    ))}
                  </ul>
                ) : (
                  <p className="jr-muted">-</p>
                )
              ) : (
                <LinesEditor
                  lines={entry.noTrade}
                  label={t("plan.j.noTrade")}
                  onChange={(noTrade) => update((e) => ({ ...e, noTrade }))}
                  max={10}
                />
              )}
            </Field>

            {intentLocked && (entry.addenda.length > 0 || !locked) && (
              <div className="jr-addenda">
                {entry.addenda.map((a) => (
                  <p key={a.at} className="jr-addendum">
                    <span className="pd-num jr-muted">{utcTime(a.at)}</span> {a.text}
                  </p>
                ))}
                {!locked && (
                  <form
                    className="jr-inline-form"
                    onSubmit={(e) => {
                      e.preventDefault();
                      if (!addendum.trim()) return;
                      commit((x) => ({
                        ...x,
                        addenda: [...x.addenda, { at: Date.now(), text: addendum.trim() }],
                      }));
                      setAddendum("");
                    }}
                  >
                    <input
                      className="pd-input"
                      value={addendum}
                      onChange={(e) => setAddendum(e.target.value)}
                      placeholder={t("plan.j.addendumPh")}
                      aria-label={t("plan.j.addendumPh")}
                    />
                    <button type="submit" className="jr-button">
                      {t("plan.add")}
                    </button>
                  </form>
                )}
              </div>
            )}
          </Phase>

          <Phase
            n={2}
            title={t("plan.j.sessionTitle")}
            done={trades.length > 0 || entry.notes.length > 0}
            aside={
              isToday && entry.startedAt && !locked ? (
                <Pill tone="strong">
                  <span className="jr-live-dot" aria-hidden /> {t("plan.in.live")}
                </Pill>
              ) : undefined
            }
          >
            <div className="jr-live-tiles">
              <Stat
                label={t("plan.in.tradesTaken")}
                value={
                  <span
                    data-tone={
                      alloc.maxTrades !== undefined && taken > alloc.maxTrades ? "warn" : undefined
                    }
                  >
                    {taken}
                    {alloc.maxTrades !== undefined && (
                      <span className="jr-muted"> / {alloc.maxTrades}</span>
                    )}
                  </span>
                }
                note={
                  takenSplit.total > 0
                    ? t("plan.in.takenSplit", {
                        open: takenSplit.open,
                        closed: takenSplit.closed,
                      })
                    : undefined
                }
              />
              <Stat label={t("plan.in.openPositions")} value={isToday ? positions.length : "-"} />
              <Stat
                label={t("plan.in.winLoss")}
                value={
                  <span>
                    <span className="pd-up">{group.wins}W</span> /{" "}
                    <span className="pd-down">{group.trades - group.wins}L</span>
                  </span>
                }
              />
              <Stat label={t("plan.in.disciplineToday")} value={`${score}/100`} />
            </div>

            {positions.length > 0 && (
              <div>
                <span className="jr-label">{t("plan.in.openNow")}</span>
                <ul className="jr-positions">
                  {positions.map((p) => (
                    <li key={`${p.market}:${p.side}`}>
                      <strong>{ctx.symbolFor(p.market)}</strong>
                      <span className={p.side === "long" ? "pd-up" : "pd-down"}>
                        {t(p.side === "long" ? "side.long" : "side.short")}
                      </span>
                      <span className="pd-num jr-muted">
                        {formatNumber(p.size)} @ {formatNumber(p.entryPrice)}
                      </span>
                      {offPlan(p.market) && <Pill tone="warn">{t("plan.in.offPlan")}</Pill>}
                      <Money value={Number(p.unrealizedPnl)} />
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {trades.length > 0 ? (
              <div className="jr-table-wrap">
                <table className="pd-table jr-table jr-rows">
                  <thead>
                    <tr>
                      <th>{t("plan.j.opened")}</th>
                      <th>{t("col.market")}</th>
                      <th>{t("plan.pb.playbook")}</th>
                      <th>{t("plan.checklist")}</th>
                      <th>{t("plan.grade")}</th>
                      <th className="pd-num">R</th>
                      <th className="pd-num">{t("plan.net")}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {trades.map((x) => (
                      <tr key={x.key} onClick={() => ctx.openTrade(x.key)}>
                        <td className="pd-num jr-muted jr-cell-left">
                          {utcTime(x.note.trade.openedAt ?? x.note.trade.closedAt)}
                        </td>
                        <td>
                          <button
                            type="button"
                            className="jr-rowlink"
                            onClick={() => ctx.openTrade(x.key)}
                          >
                            <strong>{ctx.symbolFor(x.note.trade.market)}</strong>
                            <span className={x.note.trade.side === "long" ? "pd-up" : "pd-down"}>
                              {t(x.note.trade.side === "long" ? "side.long" : "side.short")}
                            </span>
                            {offPlan(x.note.trade.market) && (
                              <Pill tone="warn">{t("plan.in.offPlan")}</Pill>
                            )}
                          </button>
                        </td>
                        <td>
                          {x.note.playbookId ? ctx.playbooks.get(x.note.playbookId)?.name : "-"}
                        </td>
                        <td
                          className="pd-num jr-cell-left"
                          data-tone={skippedItems(x.note) ? "warn" : undefined}
                        >
                          {x.note.checklist.length
                            ? `${x.note.checklist.filter((c) => c.checked).length} / ${x.note.checklist.length}`
                            : "-"}
                        </td>
                        <td>
                          {x.written ? <span className="jr-grade">{gradeOf(x.note)}</span> : "-"}
                        </td>
                        <td className="pd-num">
                          <RText r={rOf(x.note)} />
                        </td>
                        <td className="pd-num">
                          <Money value={x.note.trade.pnl} />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <p className="jr-quiet-note">{t("plan.in.noTradesYet", { venue: ctx.venueLabel })}</p>
            )}

            {breaks.length > 0 && (
              <ul className="jr-events">
                {trades.flatMap((x) =>
                  x.note.breaks.map((b) => (
                    <li key={`${x.key}:${b}`} data-tone="warn">
                      <span className="pd-num">
                        {utcTime(x.note.trade.openedAt ?? x.note.trade.closedAt)}
                      </span>
                      <span>
                        {breakLabel(b)} · {ctx.symbolFor(x.note.trade.market)}
                      </span>
                    </li>
                  )),
                )}
              </ul>
            )}

            <div className="jr-subhead">{t("plan.j.sessionNotes")}</div>
            {entry.notes.length > 0 && (
              <ul className="jr-events">
                {entry.notes.map((n) => (
                  <li key={n.at}>
                    <span className="pd-num">{utcTime(n.at)}</span>
                    <span>
                      {n.text}
                      {n.mood && <span className="jr-muted"> · {moodLabel(n.mood)}</span>}
                    </span>
                  </li>
                ))}
              </ul>
            )}
            {!locked && (
              <form
                className="jr-composer"
                onSubmit={(e) => {
                  e.preventDefault();
                  if (!note.trim()) return;
                  commit((x) => ({
                    ...x,
                    notes: [
                      ...x.notes,
                      { at: Date.now(), text: note.trim(), ...(noteMood && { mood: noteMood }) },
                    ],
                  }));
                  setNote("");
                  setNoteMood(undefined);
                }}
              >
                <input
                  value={note}
                  onChange={(e) => setNote(e.target.value)}
                  placeholder={t("plan.in.notePh")}
                  aria-label={t("plan.j.notePh")}
                />
                <MoodSelect value={noteMood} onChange={setNoteMood} />
                <button type="submit" className="jr-button jr-primary" disabled={!note.trim()}>
                  {t("plan.add")}
                </button>
              </form>
            )}
          </Phase>

          <Phase
            n={3}
            title={t("plan.j.eodTitle")}
            done={entry.review.savedAt !== undefined}
            aside={
              entry.review.savedAt ? (
                <Pill icon={<LuCheck size={10} aria-hidden />}>
                  {t("plan.savedAt", { time: utcTime(entry.review.savedAt) })}
                </Pill>
              ) : (
                <Pill>{t("plan.in.draft")}</Pill>
              )
            }
          >
            <div className="jr-ratings">
              <Slider
                label={t("plan.j.followedPlan")}
                hue="adherence"
                min={0}
                max={100}
                step={5}
                value={entry.review.adherence}
                disabled={locked}
                format={(v) => `${v}%`}
                onChange={(adherence) => setReview({ adherence })}
              />
              <Rating
                label={t("plan.process")}
                hue="process"
                max={10}
                value={entry.review.process}
                disabled={locked}
                onChange={(process) => setReview({ process })}
              />
              <Rating
                label={t("plan.outcome")}
                hue="outcome"
                max={10}
                value={entry.review.outcome}
                disabled={locked}
                onChange={(outcome) => setReview({ outcome })}
              />
            </div>
            <div className="jr-two">
              <Field label={t("plan.j.right")}>
                <Prose
                  value={entry.review.right}
                  disabled={locked}
                  rows={3}
                  label={t("plan.j.right")}
                  placeholder={t("plan.j.prompt1")}
                  onChange={(right) => setReview({ right })}
                />
              </Field>
              <Field label={t("plan.j.wrong")}>
                <Prose
                  value={entry.review.wrong}
                  disabled={locked}
                  rows={3}
                  label={t("plan.j.wrong")}
                  placeholder={t("plan.j.prompt3")}
                  onChange={(wrong) => setReview({ wrong })}
                />
              </Field>
            </div>
            <Field label={t("plan.j.lessonOne")}>
              <Prose
                single
                value={entry.review.lesson}
                disabled={locked}
                label={t("plan.lesson")}
                placeholder={t("plan.j.prompt2")}
                onChange={(lesson) => setReview({ lesson })}
              />
            </Field>
            <Field label={t("plan.j.tomorrow")}>
              <Prose
                value={entry.review.tomorrow}
                disabled={locked}
                label={t("plan.j.tomorrow")}
                onChange={(tomorrow) => setReview({ tomorrow })}
              />
            </Field>
            <Field label={t("plan.tags")}>
              <TagEditor
                tags={entry.review.tags}
                label={t("plan.tags")}
                onChange={(tags) => setReview({ tags })}
                suggestions={[...new Set(notes.flatMap((n) => n.tags))]}
              />
            </Field>
            <div className="jr-subhead">{t("plan.j.finishedHow")}</div>
            <div className="jr-ratings">
              <Rating
                label={t("plan.j.energyLeft")}
                hue="energyLeft"
                max={10}
                value={entry.review.energyLeft}
                disabled={locked}
                onChange={(energyLeft) => setReview({ energyLeft })}
              />
              <Rating
                label={t("plan.j.tilt")}
                hue="tilt"
                max={10}
                value={entry.review.tilt}
                disabled={locked}
                onChange={(tilt) => setReview({ tilt })}
              />
              <Rating
                label={t("plan.j.confidence")}
                hue="confidence"
                max={10}
                value={entry.review.confidence}
                disabled={locked}
                onChange={(confidence) => setReview({ confidence })}
              />
            </div>
          </Phase>
        </div>

        <aside className="jr-rail">
          <Card title={t("plan.j.discipline")}>
            <div className="jr-discipline">
              <ScoreRing score={score} size={84} />
              <dl className="jr-kv">
                <dt>{t("plan.j.start")}</dt>
                <dd className="pd-num">100</dd>
                <dt>{t("plan.j.breaksN", { n: breaks.length })}</dt>
                <dd className="pd-num" data-tone={breaks.length ? "warn" : undefined}>
                  {breaks.length ? `−${breaks.length * 12}` : 0}
                </dd>
                <dt>{t("plan.j.skippedN", { n: skipped })}</dt>
                <dd className="pd-num" data-tone={skipped ? "warn" : undefined}>
                  {skipped ? `−${skipped * 8}` : 0}
                </dd>
                <dt>{t("plan.j.journalComplete")}</dt>
                <dd className="pd-num">
                  {entry.review.savedAt || trades.length === 0 ? <LuCheck size={13} /> : "−10"}
                </dd>
              </dl>
            </div>
            <p className="jr-hint">{t("plan.j.scoreHow")}</p>
          </Card>
          <Card title={t("plan.j.moodDay")}>
            {moodsOfDay.length === 0 ? (
              <p className="jr-muted">{t("plan.j.noMoods")}</p>
            ) : (
              <ol className="jr-timeline">
                {moodsOfDay.map((m) => (
                  <li key={m.at}>
                    <span className="jr-timeline-head">
                      <strong className="pd-num">{utcTime(m.at)}</strong>
                      <span>{m.moods.map(moodLabel).join(", ")}</span>
                    </span>
                  </li>
                ))}
              </ol>
            )}
          </Card>
          <Card title={t("plan.j.recentDays")} flush>
            <ul className="jr-recent">
              {summaries
                .filter((s) => s.day !== day)
                .slice(0, 6)
                .map((s) => (
                  <li key={s.day}>
                    <button type="button" onClick={() => onDay(s.day)}>
                      <span>{dateFormat(DATE).format(Date.parse(s.day))}</span>
                      <span className="jr-muted">{days.get(s.day)?.review.tags[0] ?? ""}</span>
                      <Money value={s.group.pnl} />
                    </button>
                  </li>
                ))}
            </ul>
          </Card>
        </aside>
      </div>

      {!locked && (
        <ActionBar
          note={
            <>
              <LuLightbulb size={13} aria-hidden /> {t("plan.j.finalizeNote")}
            </>
          }
        >
          <ConfirmButton
            title={t("plan.confirm.finalizeTitle")}
            body={t("plan.confirm.finalizeBody")}
            action={t("plan.j.finalize")}
            onConfirm={() =>
              commit((e) => ({
                ...e,
                review: { ...e.review, savedAt: e.review.savedAt ?? Date.now() },
                finalizedAt: Date.now(),
              }))
            }
          >
            <LuLock size={13} aria-hidden /> {t("plan.j.finalize")}
          </ConfirmButton>
          <button
            type="button"
            className="jr-button jr-primary"
            onClick={() => commit((e) => ({ ...e, review: { ...e.review, savedAt: Date.now() } }))}
          >
            {t("plan.in.saveEod")}
          </button>
        </ActionBar>
      )}
    </div>
  );
}

/** One part of the day, on the day's timeline. */
function Phase({
  n,
  title,
  sub,
  done,
  aside,
  children,
}: {
  n: number;
  title: string;
  sub?: string;
  done: boolean;
  aside?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="jr-phase" data-done={done || undefined}>
      <span className="jr-phase-mark" aria-hidden>
        {done ? <LuCheck size={12} /> : n}
      </span>
      <div className="jr-card">
        <header className="jr-card-head">
          <div className="jr-phase-title">
            <h3>{title}</h3>
            {sub && <p>{sub}</p>}
          </div>
          {aside && <span className="jr-card-aside">{aside}</span>}
        </header>
        <div className="jr-card-body">{children}</div>
      </div>
    </section>
  );
}
