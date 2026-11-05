import type { ClosedTrade, Fill, VenueId } from "@pewterdesk/core";

/**
 * The trading plan, playbooks, the daily journal and trade notes: what the
 * trader writes about their trading, kept in PewterDesk Cloud
 * (`api/cloudClient.ts`), one record per thing. Trades themselves stay the
 * venue's: a note names its trade by `tradeKey` and keeps a copy of its
 * figures (`TradeFigures`) so the analytics read without the venue.
 *
 * Everything read back goes through a `normalize*` first: a record written by
 * another version of the app, or by hand, still reads as a whole one.
 */

// ---- shapes ------------------------------------------------------------------

export const MOODS = [
  "calm",
  "focused",
  "patient",
  "confident",
  "excited",
  "impatient",
  "anxious",
  "tired",
  "frustrated",
  "fomo",
  "satisfied",
] as const;
export type Mood = (typeof MOODS)[number];

/** Rule breaks the trader marks on a trade (the app's own are on `ruleEvents`). */
export const BREAKS = [
  "noPlaybook",
  "outsideSession",
  "pastMaxTrades",
  "offPlanMarket",
  "sizeOver",
  "movedStop",
] as const;
export type Break = (typeof BREAKS)[number];

export type Bias = "long" | "neutral" | "short";
export type Direction = "long" | "short" | "both";

export interface ChecklistItem {
  id: string;
  text: string;
  required: boolean;
}

export interface Playbook {
  name: string;
  status: "active" | "draft" | "retired";
  direction: Direction;
  timeframe: string;
  markets: string[];
  thesis: string;
  /** "In play when" conditions. */
  context: string[];
  trigger: string;
  invalidIf: string;
  /** Cancel an unfilled entry after this many candles; 0 for never. */
  cancelAfter: number;
  checklist: ChecklistItem[];
  stop: string;
  target: string;
  /** Share of the account risked per trade, in percent. */
  riskPct: number;
  minRR: number;
  management: string[];
  version: number;
  versions: { version: number; at: number; note: string }[];
}

export interface PlanSessions {
  /** Monday first. */
  days: boolean[];
  /** UTC, "HH:MM". */
  start: string;
  end: string;
}

export interface Plan {
  name: string;
  goal: string;
  /** Profit target, in the account's quote asset; 0 for none. */
  target: number;
  /** The balance the plan started from; 0 where it isn't set. */
  startBalance: number;
  /** Share of the account one trade risks (1R), in percent. */
  riskPct: number;
  /** 0 for no limit. */
  maxTradesPerDay: number;
  /** In quote; 0 for none. */
  dailyStop: number;
  maxLossesInRow: number;
  sessions: PlanSessions;
  markets: string[];
  playbookIds: string[];
  routine: { before: string[]; after: string[] };
  /** "My job is to..." */
  creed: string;
  ifThens: { when: string; action: string }[];
  version: number;
  changes: { version: number; at: number; note: string }[];
}

/** A market in the day's intent: how it's read, and what it may risk. */
/** What a key level is to the trader. */
export const LEVEL_KINDS = ["support", "resistance", "entry", "target", "stop", "level"] as const;
export type LevelKind = (typeof LEVEL_KINDS)[number];

/** One key level on a watched market: its kind, its price as typed, a word on it. */
export interface DayLevel {
  kind: LevelKind;
  /** A name of the trader's own ("Weekly open"), shown in place of the kind's. */
  label?: string;
  price: string;
  note: string;
}

export interface DayBias {
  bias: Bias;
  /** The thesis. */
  note: string;
  /**
   * The key levels as one line of text. Written from `levelList` where there
   * is one (`levelsText`), so everything that reads this keeps working.
   */
  levels: string;
  /** The key levels one by one, as the watchlist's editor keeps them. */
  levelList?: DayLevel[];
  /** When the market went on the day's watchlist (ms). */
  addedAt?: number;
  /** 1-5. */
  conviction?: number;
  /** The most this market may lose today, all its trades together, in % of the account. */
  riskPct?: number;
  maxTrades?: number;
}

/** The day as a whole, before the session. */
export interface DayIntent {
  bias?: Bias;
  /** 1-5. */
  conviction?: number;
  /** What the day may risk across every market, in % of the account. */
  riskCap?: number;
  maxTrades?: number;
}

export interface JournalDay {
  checkin: {
    planRead?: number;
    newsChecked?: boolean;
    levelsMarked?: boolean;
    sleep?: number;
    /** 1-5. */
    focus?: number;
    /** 1-10. */
    energy?: number;
    mind: string;
    moods: Mood[];
  };
  markets: Record<string, DayBias>;
  intent: DayIntent;
  /** The pre-market plan, in the trader's words. */
  plan: string;
  noTrade: string[];
  /** When the session was started; the pre-market part is locked from then. */
  startedAt?: number;
  /** Addenda to a locked pre-market, kept with their time. */
  addenda: { at: number; text: string }[];
  notes: { at: number; text: string; mood?: Mood }[];
  review: {
    adherence?: number;
    process?: number;
    outcome?: number;
    right: string;
    wrong: string;
    lesson: string;
    tomorrow: string;
    tags: string[];
    tilt?: number;
    confidence?: number;
    energyLeft?: number;
    savedAt?: number;
  };
  finalizedAt?: number;
  pinned?: boolean;
  attachments: string[];
  /**
   * When the day was cleared from the journal: what was written then was
   * deleted, and the venue's trades closed up to this time are hidden here
   * (the venue keeps them). Trades closed after it still show.
   */
  clearedAt?: number;
}

/** A closed trade's figures, as the venue reported them, kept with its note. */
export interface TradeFigures {
  venue: VenueId;
  market: string;
  side: "long" | "short";
  size: number;
  entryPrice: number;
  exitPrice: number;
  /** After fees, in quote. */
  pnl: number;
  entryValue: number;
  leverage?: number;
  openedAt?: number;
  closedAt: number;
  fees?: number;
  funding?: number;
  /** Best and worst prices while it was open, from the candles. */
  best?: number;
  worst?: number;
}

export interface TradeNote {
  trade: TradeFigures;
  playbookId?: string;
  playbookVersion?: number;
  /** The planned levels; the stop makes 1R. */
  plannedEntry?: number;
  plannedStop?: number;
  plannedTarget?: number;
  /** 1R in quote, where no stop was written: the plan's risk at the time. */
  riskAmount?: number;
  thesis: string;
  invalidIf: string;
  checklist: (ChecklistItem & { checked: boolean })[];
  conviction?: number;
  sleep?: number;
  energy?: number;
  focus?: number;
  moods: Mood[];
  tags: string[];
  breaks: Break[];
  /** Breaks the trader marked as intended (a warning sent with a reason). */
  intended: Break[];
  notes: string;
  attachments: string[];
  reflection: {
    right: string;
    wrong: string;
    lesson: string;
    adherence?: number;
    process?: number;
    outcome?: number;
    savedAt?: number;
  };
}

// ---- defaults ----------------------------------------------------------------

export const newPlan = (): Plan => ({
  name: "",
  goal: "",
  target: 0,
  startBalance: 0,
  riskPct: 0.5,
  maxTradesPerDay: 4,
  dailyStop: 0,
  maxLossesInRow: 2,
  sessions: { days: [true, true, true, true, true, false, false], start: "12:00", end: "16:00" },
  markets: [],
  playbookIds: [],
  routine: { before: [], after: [] },
  creed: "",
  ifThens: [],
  version: 1,
  changes: [],
});

export const newPlaybook = (): Playbook => ({
  name: "",
  status: "draft",
  direction: "long",
  timeframe: "1h",
  markets: [],
  thesis: "",
  context: [],
  trigger: "",
  invalidIf: "",
  cancelAfter: 3,
  checklist: [],
  stop: "",
  target: "",
  riskPct: 0.5,
  minRR: 2,
  management: [],
  version: 1,
  versions: [],
});

export const newDay = (): JournalDay => ({
  checkin: { mind: "", moods: [] },
  markets: {},
  intent: {},
  plan: "",
  noTrade: [],
  addenda: [],
  notes: [],
  review: { right: "", wrong: "", lesson: "", tomorrow: "", tags: [] },
  attachments: [],
});

export const newNote = (trade: TradeFigures): TradeNote => ({
  trade,
  thesis: "",
  invalidIf: "",
  checklist: [],
  moods: [],
  tags: [],
  breaks: [],
  intended: [],
  notes: "",
  attachments: [],
  reflection: { right: "", wrong: "", lesson: "" },
});

// ---- reading back --------------------------------------------------------------

const obj = (raw: unknown): Record<string, unknown> =>
  typeof raw === "object" && raw !== null && !Array.isArray(raw)
    ? (raw as Record<string, unknown>)
    : {};
const str = (raw: unknown, max = 4000) => (typeof raw === "string" ? raw.slice(0, max) : "");
const num = (raw: unknown, min = -1e15, max = 1e15): number | undefined =>
  typeof raw === "number" && Number.isFinite(raw) && raw >= min && raw <= max ? raw : undefined;
const strs = (raw: unknown, max = 200, each = 400) =>
  Array.isArray(raw)
    ? raw
        .filter((x): x is string => typeof x === "string")
        .slice(0, max)
        .map((x) => x.slice(0, each))
    : [];
const oneOf = <T extends string>(raw: unknown, options: readonly T[], fallback: T): T =>
  options.includes(raw as T) ? (raw as T) : fallback;
const some = <T extends string>(raw: unknown, options: readonly T[]): T[] =>
  strs(raw).filter((x): x is T => options.includes(x as T));
const time = (raw: unknown) => num(raw, 0, 1e14);
const versions = (raw: unknown) =>
  (Array.isArray(raw) ? raw : []).slice(0, 100).map((v) => {
    const o = obj(v);
    return { version: num(o.version, 1, 1e6) ?? 1, at: time(o.at) ?? 0, note: str(o.note, 500) };
  });
const checklist = (raw: unknown): ChecklistItem[] =>
  (Array.isArray(raw) ? raw : []).slice(0, 30).map((c, i) => {
    const o = obj(c);
    return { id: str(o.id, 40) || `c${i}`, text: str(o.text, 300), required: o.required !== false };
  });
const hhmm = (raw: unknown, fallback: string) =>
  typeof raw === "string" && /^([01]\d|2[0-3]):[0-5]\d$/.test(raw) ? raw : fallback;

/**
 * Lists saved before market rules were cut when read back: a plan's at 100
 * markets, a playbook's at 50. One exactly that long, every market of one
 * quote, came from "All USDT" (or USDC) and nothing else, so it's that rule
 * again. A market id with no quote in its name is Hyperliquid's, in USDC.
 */
function repairCut(list: string[], cut: number): string[] {
  if (list.length !== cut || list.some(isMarketRule)) return list;
  const quotes = new Set(
    list.map((id) => /(USDT|USDC)$/.exec(id.replace(/-?PERP$/, "USDC"))?.[1] ?? "USDC"),
  );
  const [quote] = [...quotes];
  return quotes.size === 1 && quote ? [allOf(quote)] : list;
}

/**
 * "All USDT pairs" and "All USDC pairs", as saved before, are "All markets":
 * a plan or playbook isn't one venue's, and a quote one venue lists another
 * may not (Hyperliquid's are all USDC).
 */
function allMarketsRule(list: string[]): string[] {
  return list.some(isMarketRule) ? [ALL_MARKETS, ...list.filter((id) => !isMarketRule(id))] : list;
}

export function normalizePlan(raw: unknown): Plan {
  const o = obj(raw);
  const base = newPlan();
  const sessions = obj(o.sessions);
  const days =
    Array.isArray(sessions.days) && sessions.days.length === 7
      ? sessions.days.map(Boolean)
      : base.sessions.days;
  const routine = obj(o.routine);
  return {
    name: str(o.name, 120),
    goal: str(o.goal, 500),
    target: num(o.target, 0) ?? 0,
    startBalance: num(o.startBalance, 0) ?? 0,
    riskPct: num(o.riskPct, 0, 100) ?? base.riskPct,
    maxTradesPerDay: num(o.maxTradesPerDay, 0, 1000) ?? base.maxTradesPerDay,
    dailyStop: num(o.dailyStop, 0) ?? 0,
    maxLossesInRow: num(o.maxLossesInRow, 0, 100) ?? base.maxLossesInRow,
    sessions: {
      days,
      start: hhmm(sessions.start, base.sessions.start),
      end: hhmm(sessions.end, base.sessions.end),
    },
    markets: allMarketsRule(repairCut(strs(o.markets, 1000, 80), 100)),
    playbookIds: strs(o.playbookIds, 100, 40),
    routine: { before: strs(routine.before, 30), after: strs(routine.after, 30) },
    creed: str(o.creed, 1000),
    ifThens: (Array.isArray(o.ifThens) ? o.ifThens : []).slice(0, 20).map((x) => {
      const i = obj(x);
      return { when: str(i.when, 300), action: str(i.action, 300) };
    }),
    version: num(o.version, 1, 1e6) ?? 1,
    changes: versions(o.changes),
  };
}

export function normalizePlaybook(raw: unknown): Playbook {
  const o = obj(raw);
  const base = newPlaybook();
  return {
    name: str(o.name, 120),
    status: oneOf(o.status, ["active", "draft", "retired"] as const, "draft"),
    direction: oneOf(o.direction, ["long", "short", "both"] as const, "long"),
    timeframe: str(o.timeframe, 60) || base.timeframe,
    markets: allMarketsRule(repairCut(strs(o.markets, 1000, 80), 50)),
    thesis: str(o.thesis, 2000),
    context: strs(o.context, 20, 300),
    trigger: str(o.trigger, 1000),
    invalidIf: str(o.invalidIf, 500),
    cancelAfter: num(o.cancelAfter, 0, 1000) ?? base.cancelAfter,
    checklist: checklist(o.checklist),
    stop: str(o.stop, 300),
    target: str(o.target, 300),
    riskPct: num(o.riskPct, 0, 100) ?? base.riskPct,
    minRR: num(o.minRR, 0, 100) ?? base.minRR,
    management: strs(o.management, 20, 300),
    version: num(o.version, 1, 1e6) ?? 1,
    versions: versions(o.versions),
  };
}

/** A level's price as typed ("81,450", " 0.0123 ") as a number, where it is one. */
export function levelPrice(text: string): number | undefined {
  const n = Number(text.replace(/[,\s]/g, ""));
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

/** A watched market's levels as read back: at most 12, each checked. */
function dayLevels(raw: unknown): DayLevel[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const list = raw.slice(0, 12).map((x) => {
    const l = obj(x);
    const label = str(l.label, 40).trim();
    return {
      kind: oneOf(l.kind, LEVEL_KINDS, "level"),
      ...(label && { label }),
      price: str(l.price, 40),
      note: str(l.note, 120),
    };
  });
  return list.length ? list : undefined;
}

/**
 * The levels as the one line `DayBias.levels` keeps: "Support 81,450 ·
 * Target 84,000 (prior high)". Levels with no price are left out.
 */
export function levelsText(list: readonly DayLevel[], label: (kind: LevelKind) => string): string {
  return list
    .filter((l) => l.price.trim())
    .map(
      (l) =>
        `${l.label?.trim() || label(l.kind)} ${l.price.trim()}${l.note.trim() ? ` (${l.note.trim()})` : ""}`,
    )
    .join(" · ")
    .slice(0, 300);
}

export function normalizeDay(raw: unknown): JournalDay {
  const o = obj(raw);
  const checkin = obj(o.checkin);
  const review = obj(o.review);
  const markets: Record<string, DayBias> = {};
  for (const [market, value] of Object.entries(obj(o.markets)).slice(0, 30)) {
    const m = obj(value);
    markets[market.slice(0, 80)] = {
      bias: oneOf(m.bias, ["long", "neutral", "short"] as const, "neutral"),
      note: str(m.note, 2000),
      levels: str(m.levels, 300),
      levelList: dayLevels(m.levelList),
      addedAt: time(m.addedAt),
      conviction: num(m.conviction, 1, 5),
      riskPct: num(m.riskPct, 0, 100),
      maxTrades: num(m.maxTrades, 0, 1000),
    };
  }
  const timed = (raw: unknown) =>
    (Array.isArray(raw) ? raw : []).slice(0, 200).map((x) => {
      const n = obj(x);
      const mood = MOODS.includes(n.mood as Mood) ? (n.mood as Mood) : undefined;
      return { at: time(n.at) ?? 0, text: str(n.text, 4000), ...(mood && { mood }) };
    });
  return {
    checkin: {
      planRead: time(checkin.planRead),
      newsChecked: checkin.newsChecked === true || undefined,
      levelsMarked: checkin.levelsMarked === true || undefined,
      sleep: num(checkin.sleep, 0, 24),
      focus: num(checkin.focus, 1, 5),
      energy: num(checkin.energy, 1, 10),
      mind: str(checkin.mind, 500),
      moods: some(checkin.moods, MOODS),
    },
    markets,
    intent: (() => {
      const i = obj(o.intent);
      return {
        bias:
          i.bias === undefined
            ? undefined
            : oneOf(i.bias, ["long", "neutral", "short"] as const, "neutral"),
        conviction: num(i.conviction, 1, 5),
        riskCap: num(i.riskCap, 0, 100),
        maxTrades: num(i.maxTrades, 0, 1000),
      };
    })(),
    plan: str(o.plan, 4000),
    noTrade: strs(o.noTrade, 20, 200),
    startedAt: time(o.startedAt),
    addenda: timed(o.addenda),
    notes: timed(o.notes),
    review: {
      adherence: num(review.adherence, 0, 100),
      process: num(review.process, 0, 10),
      outcome: num(review.outcome, 0, 10),
      right: str(review.right),
      wrong: str(review.wrong),
      lesson: str(review.lesson, 500),
      tomorrow: str(review.tomorrow),
      tags: strs(review.tags, 30, 60),
      tilt: num(review.tilt, 0, 10),
      confidence: num(review.confidence, 0, 10),
      energyLeft: num(review.energyLeft, 0, 10),
      savedAt: time(review.savedAt),
    },
    finalizedAt: time(o.finalizedAt),
    pinned: o.pinned === true || undefined,
    attachments: strs(o.attachments, 20, 120),
    clearedAt: time(o.clearedAt),
  };
}

/** A trade the journal hides: closed on a cleared day, by the time it was cleared. */
export function clearedTrade(
  days: ReadonlyMap<string, { data: JournalDay }>,
  closedAt: number,
): boolean {
  const at = days.get(utcDay(closedAt))?.data.clearedAt;
  return at !== undefined && closedAt <= at;
}

/** A cleared day nothing has been written in since: it lists nothing of its own. */
export function isBlankDay(day: JournalDay): boolean {
  return (
    day.clearedAt !== undefined &&
    day.startedAt === undefined &&
    day.finalizedAt === undefined &&
    day.review.savedAt === undefined &&
    day.checkin.planRead === undefined &&
    day.checkin.sleep === undefined &&
    day.checkin.moods.length === 0 &&
    Object.keys(day.markets).length === 0 &&
    day.notes.length === 0 &&
    day.addenda.length === 0 &&
    day.plan === "" &&
    day.review.lesson === "" &&
    day.attachments.length === 0
  );
}

export function normalizeNote(raw: unknown): TradeNote | undefined {
  const o = obj(raw);
  const t = obj(o.trade);
  const closedAt = time(t.closedAt);
  const size = num(t.size, 0);
  if (closedAt === undefined || size === undefined || typeof t.market !== "string")
    return undefined;
  const reflection = obj(o.reflection);
  const items = (Array.isArray(o.checklist) ? o.checklist : []).slice(0, 30);
  return {
    trade: {
      venue: str(t.venue, 30) as VenueId,
      market: str(t.market, 80),
      side: t.side === "short" ? "short" : "long",
      size,
      entryPrice: num(t.entryPrice, 0) ?? 0,
      exitPrice: num(t.exitPrice, 0) ?? 0,
      pnl: num(t.pnl) ?? 0,
      entryValue: num(t.entryValue, 0) ?? 0,
      leverage: num(t.leverage, 0, 1000),
      openedAt: time(t.openedAt),
      closedAt,
      fees: num(t.fees),
      funding: num(t.funding),
      best: num(t.best, 0),
      worst: num(t.worst, 0),
    },
    playbookId: typeof o.playbookId === "string" ? o.playbookId.slice(0, 40) : undefined,
    playbookVersion: num(o.playbookVersion, 1, 1e6),
    plannedEntry: num(o.plannedEntry, 0),
    plannedStop: num(o.plannedStop, 0),
    plannedTarget: num(o.plannedTarget, 0),
    riskAmount: num(o.riskAmount, 0),
    thesis: str(o.thesis, 2000),
    invalidIf: str(o.invalidIf, 500),
    checklist: checklist(items).map((c, i) => ({ ...c, checked: obj(items[i]).checked === true })),
    conviction: num(o.conviction, 1, 5),
    sleep: num(o.sleep, 0, 24),
    energy: num(o.energy, 1, 10),
    focus: num(o.focus, 1, 10),
    moods: some(o.moods, MOODS),
    tags: strs(o.tags, 30, 60),
    breaks: some(o.breaks, BREAKS),
    intended: some(o.intended, BREAKS),
    notes: str(o.notes, 20_000),
    attachments: strs(o.attachments, 20, 120),
    reflection: {
      right: str(reflection.right),
      wrong: str(reflection.wrong),
      lesson: str(reflection.lesson, 500),
      adherence: num(reflection.adherence, 0, 100),
      process: num(reflection.process, 0, 10),
      outcome: num(reflection.outcome, 0, 10),
      savedAt: time(reflection.savedAt),
    },
  };
}

// ---- keys and figures ------------------------------------------------------------

/** Whose journal: the account on screen (`venue:address`, or `paper:venue`). */
export type AccountKey = string;

/** A closed trade's key: its market, side, opening and closing times. */
export function tradeKey(c: Pick<ClosedTrade, "market" | "side" | "openedAt" | "time">): string {
  return `${c.market}:${c.side}:${c.openedAt ?? 0}:${c.time}`;
}

/** `YYYY-MM-DD` in UTC. */
export function utcDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/** Midnight UTC of a `YYYY-MM-DD`. */
export function dayStart(day: string): number {
  return Date.parse(`${day}T00:00:00Z`);
}

export function addDays(day: string, n: number): string {
  return utcDay(dayStart(day) + n * 86_400_000);
}

/** A closed trade's figures, as kept with its note. */
export function figuresOf(c: ClosedTrade, fills?: readonly Fill[]): TradeFigures {
  const own = fills ? tradeFills(c, fills) : [];
  const fees = own.length ? own.reduce((sum, f) => sum + Number(f.fee), 0) : undefined;
  return {
    venue: c.venue,
    market: c.market,
    side: c.side,
    size: Number(c.size),
    entryPrice: Number(c.entryPrice),
    exitPrice: Number(c.exitPrice),
    pnl: Number(c.closedPnl),
    entryValue: Number(c.entryValue),
    leverage: c.leverage ? Number(c.leverage) : undefined,
    openedAt: c.openedAt,
    closedAt: c.time,
    fees,
  };
}

/** The fills that opened and closed `c`: its market, within its time (a second either side). */
export function tradeFills(
  c: Pick<ClosedTrade, "market" | "side" | "openedAt" | "time">,
  fills: readonly Fill[],
): Fill[] {
  const from = (c.openedAt ?? c.time) - 1000;
  const to = c.time + 1000;
  const opens = c.side === "long" ? ["openLong", "shortToLong"] : ["openShort", "longToShort"];
  const closes = c.side === "long" ? ["closeLong", "longToShort"] : ["closeShort", "shortToLong"];
  return fills
    .filter(
      (f) =>
        f.market === c.market &&
        f.time >= from &&
        f.time <= to &&
        (opens.includes(f.effect) || closes.includes(f.effect)),
    )
    .sort((a, b) => a.time - b.time);
}

/** 1R for the trade, in quote: from the planned stop, or the risk written down. */
export function riskOf(
  note: Pick<TradeNote, "trade" | "plannedStop" | "riskAmount">,
): number | undefined {
  const { trade } = note;
  if (note.plannedStop !== undefined && note.plannedStop > 0) {
    // From where it was actually entered: the stop is the trade's stop loss.
    const risk = Math.abs(trade.entryPrice - note.plannedStop) * trade.size;
    if (risk > 0) return risk;
  }
  return note.riskAmount !== undefined && note.riskAmount > 0 ? note.riskAmount : undefined;
}

/** The trade's result in R, where its risk is known. */
export function rOf(note: TradeNote): number | undefined {
  const risk = riskOf(note);
  return risk ? note.trade.pnl / risk : undefined;
}

/** How far the trade went for and against it, in R (MFE, MAE). */
export function excursions(note: TradeNote): { mfe?: number; mae?: number } {
  const risk = riskOf(note);
  const { trade } = note;
  if (!risk) return {};
  const sign = trade.side === "long" ? 1 : -1;
  const r = (price: number | undefined) =>
    price === undefined ? undefined : (sign * (price - trade.entryPrice) * trade.size) / risk;
  return { mfe: r(trade.best), mae: r(trade.worst) };
}

/** The planned reward to risk. */
export function plannedRR(note: TradeNote): number | undefined {
  const entry = note.trade.entryPrice;
  if (!note.plannedStop || !note.plannedTarget) return undefined;
  const risk = Math.abs(entry - note.plannedStop);
  return risk > 0 ? Math.abs(note.plannedTarget - entry) / risk : undefined;
}

/** Required checklist items left unticked. */
export function skippedItems(note: TradeNote): number {
  return note.checklist.filter((c) => c.required && !c.checked).length;
}

/** By the book: a playbook, every required item ticked, nothing broken. */
export function byTheBook(note: TradeNote): boolean {
  return note.playbookId !== undefined && skippedItems(note) === 0 && note.breaks.length === 0;
}

/**
 * A letter for the trade's process (not its result): A by the book, then a
 * step down for each skipped item or break, and the trader's own process
 * grade where given.
 */
export function gradeOf(note: TradeNote): "A" | "B" | "C" | "D" | "F" {
  let points = 4 - skippedItems(note) - note.breaks.length * 2 - (note.playbookId ? 0 : 1);
  if (note.reflection.process !== undefined && note.reflection.process < 5) points -= 1;
  return points >= 4 ? "A" : points === 3 ? "B" : points === 2 ? "C" : points === 1 ? "D" : "F";
}

/** Minutes past midnight of an "HH:MM". */
export function minutesOf(hhmm: string): number {
  const [h = 0, m = 0] = hhmm.split(":").map(Number);
  return h * 60 + m;
}

/** Whether the time falls inside the plan's session (UTC). */
export function inSession(plan: Plan, ms: number): boolean {
  const d = new Date(ms);
  const weekday = (d.getUTCDay() + 6) % 7;
  if (!plan.sessions.days[weekday]) return false;
  const minutes = d.getUTCHours() * 60 + d.getUTCMinutes();
  const start = minutesOf(plan.sessions.start);
  const end = minutesOf(plan.sessions.end);
  return start <= end ? minutes >= start && minutes < end : minutes >= start || minutes < end;
}

/**
 * Breaks the app can see by itself, from the plan: no playbook, outside the
 * session, a market not in the plan, past the day's trade count.
 */
// ---- market lists: names and rules ------------------------------------------

/**
 * A plan's or playbook's markets hold market ids and rules: "all:USDT" for
 * every market quoted in USDT, "all:*" for every market, so picking a venue's
 * hundreds of pairs keeps one entry and takes in what it lists later.
 */
export const ALL_MARKETS = "all:*";
export const allOf = (quote: string) => `all:${quote}`;
export const isMarketRule = (id: string) => id.startsWith("all:");
/** The quote a rule takes in ("USDT"), or "*" for every market. */
export const ruleQuote = (id: string) => id.slice(4);

/** A market's quote where only its id is known: from its name, else the venue's usual. */
export function quoteGuess(venue: VenueId, market: string): string {
  const named = /(USDT|USDC|USDE|USDH|USD)$/.exec(market.replace(/-?PERP$/, "USDC"));
  if (named?.[1]) return named[1];
  return venue === "hyperliquid" ? "USDC" : "USDT";
}

/** Whether a market is in a list of ids and rules. */
export function marketIn(
  list: readonly string[],
  m: { venue: VenueId; market: string },
  quote = quoteGuess(m.venue, m.market),
): boolean {
  return list.some((id) =>
    isMarketRule(id) ? ruleQuote(id) === "*" || ruleQuote(id) === quote : id === m.market,
  );
}

/** A list of ids and rules as the venue's market ids it covers, in the venue's order. */
export function expandMarkets(
  list: readonly string[],
  markets: readonly { id: string; quote: string }[],
): string[] {
  const rules = list.filter(isMarketRule).map(ruleQuote);
  const ids = new Set(list.filter((id) => !isMarketRule(id)));
  if (rules.length === 0) return [...ids];
  const out = markets
    .filter((m) => ids.has(m.id) || rules.includes("*") || rules.includes(m.quote))
    .map((m) => m.id);
  const listed = new Set(out);
  return [...out, ...[...ids].filter((id) => !listed.has(id))];
}

export function detectedBreaks(note: TradeNote, plan: Plan | undefined, nthOfDay: number): Break[] {
  const out: Break[] = [];
  if (!note.playbookId) out.push("noPlaybook");
  if (!plan) return out;
  const opened = note.trade.openedAt ?? note.trade.closedAt;
  if (!inSession(plan, opened)) out.push("outsideSession");
  if (plan.markets.length > 0 && !marketIn(plan.markets, note.trade)) out.push("offPlanMarket");
  if (plan.maxTradesPerDay > 0 && nthOfDay > plan.maxTradesPerDay) out.push("pastMaxTrades");
  return out;
}

/**
 * The day's discipline score, from 100: 12 off for each rule break, 8 for each
 * skipped required item, 10 while the day's review isn't written.
 */
export function disciplineScore(day: JournalDay | undefined, notes: readonly TradeNote[]): number {
  const breaks = notes.reduce((n, note) => n + note.breaks.length, 0);
  const skipped = notes.reduce((n, note) => n + skippedItems(note), 0);
  const unreviewed = notes.length > 0 && !day?.review.savedAt ? 10 : 0;
  return Math.max(0, 100 - 12 * breaks - 8 * skipped - unreviewed);
}

/** A unique id for a new checklist item or playbook. */
export function newId(): string {
  return crypto.randomUUID();
}
