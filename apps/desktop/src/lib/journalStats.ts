import {
  type Break,
  byTheBook,
  disciplineScore,
  type JournalDay,
  type Mood,
  rOf,
  skippedItems,
  type TradeNote,
  utcDay,
} from "./journal";

/**
 * The journal's analytics: arithmetic over the trade notes (and their days),
 * for the Review, Insights and Playbooks views. Results are counted in R where
 * a trade's risk is known; a trade without one counts in the money totals and
 * the win rate, not in R.
 */

export interface Group {
  trades: number;
  wins: number;
  /** Trades with a known R. */
  withR: number;
  totalR: number;
  pnl: number;
}

export const emptyGroup = (): Group => ({ trades: 0, wins: 0, withR: 0, totalR: 0, pnl: 0 });

export function add(group: Group, note: TradeNote): Group {
  const r = rOf(note);
  group.trades += 1;
  group.pnl += note.trade.pnl;
  if (note.trade.pnl > 0) group.wins += 1;
  if (r !== undefined) {
    group.withR += 1;
    group.totalR += r;
  }
  return group;
}

export function groupOf(notes: readonly TradeNote[]): Group {
  return notes.reduce(add, emptyGroup());
}

export const winRate = (g: Group) => (g.trades ? g.wins / g.trades : 0);
export const avgR = (g: Group) => (g.withR ? g.totalR / g.withR : undefined);
export const avgPnl = (g: Group) => (g.trades ? g.pnl / g.trades : 0);

/** Notes in time order (by close). */
export function chronological(notes: readonly TradeNote[]): TradeNote[] {
  return [...notes].sort((a, b) => a.trade.closedAt - b.trade.closedAt);
}

export interface CurvePoint {
  at: number;
  /** Running total. */
  r: number;
  kind: "followed" | "skipped" | "break";
}

/** Cumulative R, one point per trade with a known R, marked by how it was taken. */
export function cumulativeR(notes: readonly TradeNote[]): CurvePoint[] {
  let total = 0;
  const points: CurvePoint[] = [];
  for (const note of chronological(notes)) {
    const r = rOf(note);
    if (r === undefined) continue;
    total += r;
    points.push({
      at: note.trade.closedAt,
      r: total,
      kind: note.breaks.length > 0 ? "break" : skippedItems(note) > 0 ? "skipped" : "followed",
    });
  }
  return points;
}

/** Each playbook's trades, and those with none under `""`. */
export function byPlaybook(
  notes: readonly TradeNote[],
): Map<string, { group: Group; followed: number }> {
  const out = new Map<string, { group: Group; followed: number }>();
  for (const note of notes) {
    const id = note.playbookId ?? "";
    const entry = out.get(id) ?? { group: emptyGroup(), followed: 0 };
    add(entry.group, note);
    if (note.checklist.length > 0 && skippedItems(note) === 0) entry.followed += 1;
    out.set(id, entry);
  }
  return out;
}

/** Trades taken with the checklist followed, with an item skipped, and with no playbook. */
export function followedVsSkipped(notes: readonly TradeNote[]) {
  const followed = emptyGroup();
  const skipped = emptyGroup();
  const none = emptyGroup();
  for (const note of notes) {
    if (!note.playbookId) add(none, note);
    else if (skippedItems(note) > 0) add(skipped, note);
    else add(followed, note);
  }
  return { followed, skipped, none };
}

export type Habit =
  | { kind: "break"; key: Break }
  | { kind: "skipped" }
  | { kind: "tag"; key: string };

/** What each habit cost (or made): the trades carrying it, biggest effect first. */
export function habitCosts(notes: readonly TradeNote[]): { habit: Habit; group: Group }[] {
  const groups = new Map<string, { habit: Habit; group: Group }>();
  const put = (id: string, habit: Habit, note: TradeNote) => {
    const entry = groups.get(id) ?? { habit, group: emptyGroup() };
    add(entry.group, note);
    groups.set(id, entry);
  };
  for (const note of notes) {
    if (skippedItems(note) > 0) put("skipped", { kind: "skipped" }, note);
    for (const b of note.breaks) put(`break:${b}`, { kind: "break", key: b }, note);
  }
  return [...groups.values()].sort((a, b) => Math.abs(b.group.pnl) - Math.abs(a.group.pnl));
}

/** Process against outcome: by the book or not, won or lost. */
export function processOutcome(notes: readonly TradeNote[]) {
  const cells = {
    earned: emptyGroup(),
    goodLoss: emptyGroup(),
    lucky: emptyGroup(),
    paid: emptyGroup(),
  };
  for (const note of notes) {
    const won = note.trade.pnl > 0;
    const book = byTheBook(note);
    add(book ? (won ? cells.earned : cells.goodLoss) : won ? cells.lucky : cells.paid, note);
  }
  return cells;
}

/** Notes by their UTC day. */
export function notesByDay(notes: readonly TradeNote[]): Map<string, TradeNote[]> {
  const out = new Map<string, TradeNote[]>();
  for (const note of notes) {
    const day = utcDay(note.trade.closedAt);
    out.set(day, [...(out.get(day) ?? []), note]);
  }
  return out;
}

/** Average R per trade by the moods logged at that day's check-in. */
export function byMood(
  notes: readonly TradeNote[],
  days: ReadonlyMap<string, JournalDay>,
): { mood: Mood; days: number; group: Group }[] {
  const out = new Map<Mood, { days: Set<string>; group: Group }>();
  for (const [day, dayNotes] of notesByDay(notes)) {
    const moods = new Set<Mood>([
      ...(days.get(day)?.checkin.moods ?? []),
      ...dayNotes.flatMap((n) => n.moods),
    ]);
    for (const mood of moods) {
      const entry = out.get(mood) ?? { days: new Set(), group: emptyGroup() };
      entry.days.add(day);
      for (const note of dayNotes) add(entry.group, note);
      out.set(mood, entry);
    }
  }
  return [...out.entries()]
    .map(([mood, e]) => ({ mood, days: e.days.size, group: e.group }))
    .sort((a, b) => (avgR(b.group) ?? 0) - (avgR(a.group) ?? 0));
}

/** By the UTC hour each trade was entered. */
export function byEntryHour(notes: readonly TradeNote[]): { hour: number; group: Group }[] {
  const out = new Map<number, Group>();
  for (const note of notes) {
    const hour = new Date(note.trade.openedAt ?? note.trade.closedAt).getUTCHours();
    out.set(hour, add(out.get(hour) ?? emptyGroup(), note));
  }
  return [...out.entries()].sort((a, b) => a[0] - b[0]).map(([hour, group]) => ({ hour, group }));
}

/** Trades after short nights against the rest; a trade's own sleep, or its day's. */
export function bySleep(
  notes: readonly TradeNote[],
  days: ReadonlyMap<string, JournalDay>,
  under = 6.5,
) {
  const short = { days: new Set<string>(), group: emptyGroup() };
  const rested = { days: new Set<string>(), group: emptyGroup() };
  for (const note of notes) {
    const day = utcDay(note.trade.closedAt);
    const sleep = note.sleep ?? days.get(day)?.checkin.sleep;
    if (sleep === undefined) continue;
    const side = sleep < under ? short : rested;
    side.days.add(day);
    add(side.group, note);
  }
  return { short, rested };
}

/** Each playbook's last `last` trades against all of them. */
export function edgeDecay(notes: readonly TradeNote[], last = 8) {
  const byId = new Map<string, TradeNote[]>();
  for (const note of chronological(notes)) {
    if (!note.playbookId) continue;
    byId.set(note.playbookId, [...(byId.get(note.playbookId) ?? []), note]);
  }
  return [...byId.entries()].map(([id, list]) => {
    const all = groupOf(list);
    const recent = groupOf(list.slice(-last));
    const a = avgR(all);
    const r = avgR(recent);
    return { id, all, recent, change: a !== undefined && r !== undefined ? r - a : undefined };
  });
}

export interface DaySummary {
  day: string;
  notes: TradeNote[];
  group: Group;
  score: number;
  breaks: number;
  skipped: number;
}

/** Each day with trades or an entry, newest first. */
export function daySummaries(
  notes: readonly TradeNote[],
  days: ReadonlyMap<string, JournalDay>,
): DaySummary[] {
  const grouped = notesByDay(notes);
  const all = new Set([...grouped.keys(), ...days.keys()]);
  return [...all]
    .sort()
    .reverse()
    .map((day) => {
      const list = grouped.get(day) ?? [];
      return {
        day,
        notes: list,
        group: groupOf(list),
        score: disciplineScore(days.get(day), list),
        breaks: list.reduce((n, x) => n + x.breaks.length, 0),
        skipped: list.reduce((n, x) => n + skippedItems(x), 0),
      };
    });
}

/**
 * Days in a row, back from today (or yesterday, before today's is written),
 * with a journal entry whose review is saved. Days without trades and without
 * an entry are skipped over, not counted against it.
 */
export function journalStreak(
  summaries: readonly DaySummary[],
  days: ReadonlyMap<string, JournalDay>,
  today: string,
): number {
  let streak = 0;
  for (const s of summaries) {
    if (days.get(s.day)?.review.savedAt !== undefined) streak += 1;
    else if (s.day === today) continue;
    else if (s.notes.length > 0) break;
  }
  return streak;
}

/** "Worth a look": short, factual observations for the review. */
export type Finding =
  | { kind: "skippedMost"; playbookId: string; skipped: number; trades: number }
  | { kind: "worstDay"; day: string; pnl: number; trades: number }
  | { kind: "gaveBack"; day: string; peakR: number; endR: number }
  | { kind: "luckyWins"; count: number };

export function findings(notes: readonly TradeNote[]): Finding[] {
  const out: Finding[] = [];
  let worstSkip: Finding | undefined;
  for (const [id, entry] of byPlaybook(notes)) {
    if (!id) continue;
    const skipped = notes.filter((n) => n.playbookId === id && skippedItems(n) > 0).length;
    if (
      skipped > 0 &&
      (!worstSkip ||
        (worstSkip.kind === "skippedMost" &&
          skipped / entry.group.trades > worstSkip.skipped / worstSkip.trades))
    ) {
      worstSkip = { kind: "skippedMost", playbookId: id, skipped, trades: entry.group.trades };
    }
  }
  if (worstSkip) out.push(worstSkip);
  const byDay = notesByDay(notes);
  let worst: { day: string; pnl: number; trades: number } | undefined;
  for (const [day, list] of byDay) {
    const pnl = list.reduce((s, n) => s + n.trade.pnl, 0);
    if (pnl < 0 && (!worst || pnl < worst.pnl)) worst = { day, pnl, trades: list.length };
    // A day that was up a good deal and gave a third or more of it back.
    let run = 0;
    let peak = 0;
    for (const note of chronological(list)) {
      run += rOf(note) ?? 0;
      peak = Math.max(peak, run);
    }
    if (peak >= 2 && run <= peak * 0.67)
      out.push({ kind: "gaveBack", day, peakR: peak, endR: run });
  }
  if (worst) out.push({ kind: "worstDay", ...worst });
  const lucky = processOutcome(notes).lucky.trades;
  if (lucky > 0) out.push({ kind: "luckyWins", count: lucky });
  return out;
}
