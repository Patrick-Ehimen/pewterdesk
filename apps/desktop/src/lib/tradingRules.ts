import type { VenueId } from "@pewterdesk/core";

/**
 * The trader's own rules: a prop-firm challenge to hold the account to, the
 * limits they set themselves, and the tilt patterns to watch for. Rust keeps
 * them and checks every order against them before it's signed
 * (`src-tauri/src/trading_rules.rs`, whose `Rules` is this shape); the page
 * edits them and mirrors where the account stands.
 */

/** The challenge the rules start from; "own" is no challenge, just limits. */
export const PRESETS = ["classic", "oneStep", "instant", "own"] as const;
export type Preset = (typeof PRESETS)[number];

/** What reaching a limit does. */
export const BREACH_ACTIONS = ["warn", "warnLock", "lock"] as const;
export type BreachAction = (typeof BREACH_ACTIONS)[number];
/** Where "warn at 80%" warns. */
export const WARN_AT = 0.8;

/** What the day's drawdown is measured from. */
export const DAILY_FROM = ["balance", "equity"] as const;
export type DailyFrom = (typeof DAILY_FROM)[number];

/** How the overall drawdown's floor moves. */
export const MAX_KINDS = ["static", "intraday", "eod"] as const;
export type MaxKind = (typeof MAX_KINDS)[number];

export const HOUR_DAYS = ["weekdays", "everyDay"] as const;
export type HourDays = (typeof HOUR_DAYS)[number];

export interface Challenge {
  /** The balance the challenge starts from, in USD; the percentages are of this. */
  size: number;
  /** 0 where there's no target. */
  targetPct: number;
  dailyPct: number;
  dailyFrom: DailyFrom;
  maxPct: number;
  maxKind: MaxKind;
  /** 0 where there's no minimum, or no time limit. */
  minDays: number;
  maxDays: number;
}

export interface TradingRules {
  preset: Preset;
  breach: BreachAction;
  challenge: Challenge;
  /** The most one trade may risk, as a share of the account size. */
  tradeLoss: { pct: number; mode: "stop" | "warn" };
  position: { usd: number; leverage: number };
  tradesPerDay: number;
  /** UTC, "HH:MM". */
  hours: { days: HourDays; from: string; to: string };
  /** No new trades this long either side of high-impact news. */
  news: { on: boolean; minutes: number };
  coolOff: { losses: number; minutes: number };
  tilt: {
    revenge: { on: boolean; minutes: number; mode: "warn" | "coolOff" };
    sizeCreep: { on: boolean; factor: number };
    overtrading: { on: boolean; factor: number };
  };
}

type Terms = Omit<Challenge, "size">;

/**
 * Terms typical of each kind of challenge: generic starting points, not any
 * firm's official rules, and edited freely afterwards.
 */
export const PRESET_TERMS: Record<Preset, Terms> = {
  classic: {
    targetPct: 8,
    dailyPct: 5,
    dailyFrom: "balance",
    maxPct: 10,
    maxKind: "intraday",
    minDays: 5,
    maxDays: 30,
  },
  oneStep: {
    targetPct: 10,
    dailyPct: 4,
    dailyFrom: "balance",
    maxPct: 6,
    maxKind: "intraday",
    minDays: 3,
    maxDays: 30,
  },
  instant: {
    targetPct: 0,
    dailyPct: 3,
    dailyFrom: "equity",
    maxPct: 6,
    maxKind: "eod",
    minDays: 0,
    maxDays: 0,
  },
  own: {
    targetPct: 0,
    dailyPct: 5,
    dailyFrom: "equity",
    maxPct: 10,
    maxKind: "static",
    minDays: 0,
    maxDays: 0,
  },
};

/** Whether a preset has a profit target and a count of trading days at all. */
export const hasTarget = (preset: Preset) => preset === "classic" || preset === "oneStep";

export const DEFAULT_RULES: TradingRules = {
  preset: "own",
  breach: "warnLock",
  challenge: { size: 10_000, ...PRESET_TERMS.own },
  tradeLoss: { pct: 1, mode: "stop" },
  position: { usd: 25_000, leverage: 10 },
  tradesPerDay: 8,
  hours: { days: "weekdays", from: "07:00", to: "20:00" },
  news: { on: false, minutes: 15 },
  coolOff: { losses: 3, minutes: 30 },
  tilt: {
    revenge: { on: true, minutes: 10, mode: "coolOff" },
    sizeCreep: { on: true, factor: 1.5 },
    overtrading: { on: true, factor: 1.5 },
  },
};

/** `rules` started over from `preset`: its terms, the same account size and limits. */
export function withPreset(rules: TradingRules, preset: Preset): TradingRules {
  return { ...rules, preset, challenge: { size: rules.challenge.size, ...PRESET_TERMS[preset] } };
}

const record = (raw: unknown): Record<string, unknown> =>
  typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>) : {};
const flag = (raw: unknown, fallback: boolean) => (typeof raw === "boolean" ? raw : fallback);
/** A saved number within bounds, or the fallback. */
const amount = (raw: unknown, fallback: number, max = 1e12) =>
  typeof raw === "number" && Number.isFinite(raw) && raw >= 0 && raw <= max ? raw : fallback;
const clock = (raw: unknown, fallback: string) =>
  typeof raw === "string" && /^([01]\d|2[0-3]):[0-5]\d$/.test(raw) ? raw : fallback;
const one = <T extends string>(raw: unknown, allowed: readonly T[], fallback: T): T =>
  allowed.find((a) => a === raw) ?? fallback;

/** The saved rules, as far as they read; the default for anything that doesn't. */
export function restoreRules(saved: unknown): TradingRules {
  const s = record(saved);
  const d = DEFAULT_RULES;
  const c = record(s.challenge);
  const tradeLoss = record(s.tradeLoss);
  const position = record(s.position);
  const hours = record(s.hours);
  const news = record(s.news);
  const coolOff = record(s.coolOff);
  const tilt = record(s.tilt);
  const revenge = record(tilt.revenge);
  const sizeCreep = record(tilt.sizeCreep);
  const overtrading = record(tilt.overtrading);
  return {
    preset: one(s.preset, PRESETS, d.preset),
    breach: one(s.breach, BREACH_ACTIONS, d.breach),
    challenge: {
      size: amount(c.size, d.challenge.size),
      targetPct: amount(c.targetPct, d.challenge.targetPct, 1000),
      dailyPct: amount(c.dailyPct, d.challenge.dailyPct, 100),
      dailyFrom: one(c.dailyFrom, DAILY_FROM, d.challenge.dailyFrom),
      maxPct: amount(c.maxPct, d.challenge.maxPct, 100),
      maxKind: one(c.maxKind, MAX_KINDS, d.challenge.maxKind),
      minDays: amount(c.minDays, d.challenge.minDays, 365),
      maxDays: amount(c.maxDays, d.challenge.maxDays, 3650),
    },
    tradeLoss: {
      pct: amount(tradeLoss.pct, d.tradeLoss.pct, 100),
      mode: one(tradeLoss.mode, ["stop", "warn"] as const, d.tradeLoss.mode),
    },
    position: {
      usd: amount(position.usd, d.position.usd),
      leverage: amount(position.leverage, d.position.leverage, 1000),
    },
    tradesPerDay: amount(s.tradesPerDay, d.tradesPerDay, 10_000),
    hours: {
      days: one(hours.days, HOUR_DAYS, d.hours.days),
      from: clock(hours.from, d.hours.from),
      to: clock(hours.to, d.hours.to),
    },
    news: { on: flag(news.on, d.news.on), minutes: amount(news.minutes, d.news.minutes, 1440) },
    coolOff: {
      losses: amount(coolOff.losses, d.coolOff.losses, 100),
      minutes: amount(coolOff.minutes, d.coolOff.minutes, 1440),
    },
    tilt: {
      revenge: {
        on: flag(revenge.on, d.tilt.revenge.on),
        minutes: amount(revenge.minutes, d.tilt.revenge.minutes, 1440),
        mode: one(revenge.mode, ["warn", "coolOff"] as const, d.tilt.revenge.mode),
      },
      sizeCreep: {
        on: flag(sizeCreep.on, d.tilt.sizeCreep.on),
        factor: amount(sizeCreep.factor, d.tilt.sizeCreep.factor, 100),
      },
      overtrading: {
        on: flag(overtrading.on, d.tilt.overtrading.on),
        factor: amount(overtrading.factor, d.tilt.overtrading.factor, 100),
      },
    },
  };
}

/** The rules' amounts in USD, worked out from the account size. */
export function amounts(rules: TradingRules) {
  const { size, targetPct, dailyPct, maxPct } = rules.challenge;
  return {
    target: (size * targetPct) / 100,
    daily: (size * dailyPct) / 100,
    max: (size * maxPct) / 100,
    tradeLoss: (size * rules.tradeLoss.pct) / 100,
  };
}

const minutesOf = (clockTime: string) =>
  Number(clockTime.slice(0, 2)) * 60 + Number(clockTime.slice(3));

/**
 * Whether the trading hours are open at `now`, and how many minutes until
 * that changes. Hours are UTC; a window that ends before it starts runs
 * over midnight. Undefined minutes: it never changes (a window with no length).
 */
export function hoursNow(
  hours: TradingRules["hours"],
  now: Date,
): { open: boolean; minutes: number | undefined } {
  const from = minutesOf(hours.from);
  const to = minutesOf(hours.to);
  if (from === to) return { open: false, minutes: undefined };
  const openAt = (at: Date) => {
    const m = at.getUTCHours() * 60 + at.getUTCMinutes();
    const within = from < to ? m >= from && m < to : m >= from || m < to;
    if (!within) return false;
    if (hours.days === "everyDay") return true;
    // The day a window belongs to is the one it started on.
    const started = from > to && m < to ? new Date(at.getTime() - 86_400_000) : at;
    const day = started.getUTCDay();
    return day >= 1 && day <= 5;
  };
  const open = openAt(now);
  // A week of minutes at most: the next weekday window is never further.
  for (let ahead = 1; ahead <= 7 * 1440; ahead++) {
    if (openAt(new Date(now.getTime() + ahead * 60_000)) !== open) return { open, minutes: ahead };
  }
  return { open, minutes: undefined };
}

/** One trade of today's, for the dashboard's list. */
export interface DayTrade {
  at: number;
  /** `Market::id`. */
  market: string;
  side: "long" | "short";
  pnl: number;
  tag?: "revenge" | "open" | null;
}

/** Why opening orders are locked, and until when (unset: until started over). */
export interface RulesLock {
  reason: "dailyLoss" | "maxDrawdown";
  until?: number | null;
}

/**
 * Where the account stands against the rules, as Rust works it out from the
 * venue's own account, fills and closed trades (`Status` there).
 */
export interface RulesStatus {
  equity: number;
  /** When the rules were started (ms). */
  startedAt: number;
  /** What the day's drawdown is measured from. */
  dayStart: number;
  /** What the overall drawdown is measured from: the start, or the peak. */
  peak: number;
  dayPnl: number;
  tradesToday: number;
  lossStreak: number;
  /** A cool-off running until then (ms), or already served today. */
  coolOffUntil?: number | null;
  coolOffServed: boolean;
  /** What the newest position risks to its stop, in USD; unset where it has none. */
  lastRisk?: number | null;
  needsStop: boolean;
  /** The largest open position, and the account's exposure over its equity. */
  position?: { notional: number; leverage: number } | null;
  tradingDays: number;
  day: number;
  /** Equity since the rules were started, oldest first. */
  curve: readonly { at: number; equity: number }[];
  /** A revenge trade today: the market re-entered, and how soon after the loss. */
  revenge?: { market: string; minutes: number; count: number } | null;
  /** The last few trades' sizes (USD), oldest first, and the usual size. */
  sizes?: { recent: readonly number[]; usual: number } | null;
  /** Trades so far today against the 30-day average by this time of day. */
  pace?: { today: number; average: number } | null;
  trades: readonly DayTrade[];
  lock?: RulesLock | null;
  /** Share of the daily loss limit used. */
  dailyUsed: number;
  /** Whether that share has reached the warning. */
  dailyWarned: boolean;
  hoursOpen: boolean;
}

/** The account the rules are checked against. */
export interface RulesAccount {
  venue: VenueId;
  id: string;
}

/**
 * One account's rules as Rust keeps them: whether they're on, and any change
 * waiting. Each account has at most one set (a prop firm's, a venue's).
 */
export interface RulesView {
  /** The trader's name for the set; may be empty. */
  name: string;
  on: boolean;
  account: RulesAccount;
  rules: TradingRules;
  /** A loosening, or turning them off: it applies at `at` (the next 00:00 UTC). */
  pending?: { on: boolean; rules: TradingRules; at: number } | null;
}

/** One rule's answer for an order, before it's sent. */
export interface RuleCheck {
  rule: string;
  ok: boolean;
  value: number;
  limit: number;
}

/** Whether two accounts are the same one. */
export const sameAccount = (a: RulesAccount | undefined, b: RulesAccount | undefined) =>
  a !== undefined && b !== undefined && a.venue === b.venue && a.id === b.id;

/** The rules an account starts from before it has any: off, and the defaults. */
export const newRules = (account: RulesAccount): RulesView => ({
  name: "",
  on: false,
  account,
  rules: DEFAULT_RULES,
});
