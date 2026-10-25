import type { VenueId } from "@pewterdesk/core";

// Bots on the page: what the Bots panel and the Bots page show, and the
// arithmetic over it. A bot runs a strategy that was backtested and saved,
// on the backtest account (a dry run: live prices, nothing sent) or live
// through the engine's router like any other order. The engine that runs
// them is not in this build (`lib/botSource.ts`); this file only describes.
// No React.

export type BotMode = "live" | "dry";
export type BotStatus = "running" | "paused" | "stopped";
/** Why a bot is paused: the trader, a halt, a trading rule's refusal, or lost data. */
export type BotPauseReason = "user" | "halt" | "rule" | "stale";
export type BotExit = "signal" | "stop" | "target" | "manual";
export type BotEventKind =
  | "started"
  | "signal"
  | "fill"
  | "refused"
  | "paused"
  | "resumed"
  | "stopped"
  | "reconnected";

/** One point of a curve: net P&L since the bot started, in the quote currency. */
export interface BotPoint {
  t: number;
  value: number;
}

export interface BotTrade {
  id: string;
  side: "long" | "short";
  entryAt: number;
  exitAt?: number;
  entry: number;
  exit?: number;
  size: number;
  /** Net of fees; for an open trade, what it would be at the mark. */
  pnl: number;
  fees: number;
  slippageBps: number;
  exitBy?: BotExit;
}

export interface BotPosition {
  side: "long" | "short";
  size: number;
  entry: number;
  upnl: number;
}

/** What the backtest it was started from made of the same bars. */
export interface BacktestFigures {
  curve: readonly BotPoint[];
  winRate: number;
  trades: number;
  slippageBps: number;
  fees: number;
  maxDrawdown: number;
}

export interface BotView {
  id: string;
  name: string;
  /** The strategy and its settings, in words: "EMA 12 / 34 · both ways". */
  strategy: string;
  venue: VenueId;
  market: string;
  interval: string;
  /** The account it trades for; unset for a dry run (the backtest account). */
  account?: string;
  mode: BotMode;
  status: BotStatus;
  reason?: BotPauseReason;
  /** A rule's code, or what went wrong, when it paused on its own. */
  detail?: string;
  startedAt: number;
  capital: number;
  sizePct: number;
  maxDailyLoss: number;
  curve: readonly BotPoint[];
  trades: readonly BotTrade[];
  position?: BotPosition;
  backtest?: BacktestFigures;
  /** Set on the demo source's bots, so they can never pass for real ones. */
  demo?: boolean;
}

export interface BotEvent {
  id: string;
  botId: string;
  at: number;
  kind: BotEventKind;
  text: string;
}

/** A backtest saved to start bots from. */
export interface SavedRun {
  id: string;
  name: string;
  venue: VenueId;
  market: string;
  interval: string;
  /** Its settings in a line: "4h · stop 4%". */
  summary: string;
  net: number;
  /** As a fraction: -0.062 for 6.2% down from the peak. */
  maxDrawdown: number;
  trades: number;
}

/** What the New bot form sends. */
export interface BotDraft {
  runId: string;
  venue: VenueId;
  market: string;
  mode: BotMode;
  account?: string;
  sizePct: number;
  maxDailyLoss: number;
}

/** Closed trades before its live run is set against the backtest's. */
export const MIN_COMPARE_TRADES = 10;
/** A gap to the backtest within this many points of return is in line with it. */
export const DRIFT_POINTS = 3;
export const MAX_SIZE_PCT = 100;

export const BOT_PERIODS = ["7d", "30d", "90d", "all"] as const;
export type BotPeriod = (typeof BOT_PERIODS)[number];
const PERIOD_MS: Record<BotPeriod, number> = {
  "7d": 7 * 86_400_000,
  "30d": 30 * 86_400_000,
  "90d": 90 * 86_400_000,
  all: Number.POSITIVE_INFINITY,
};

const ORDER: Record<BotStatus, number> = { running: 0, paused: 1, stopped: 2 };

/** Running first, then paused, then stopped; newest first within each. */
export function sortBots(bots: readonly BotView[]): BotView[] {
  return [...bots].sort((a, b) => ORDER[a.status] - ORDER[b.status] || b.startedAt - a.startedAt);
}

/** `bots` with `bot` in place of the one with its id, or added. */
export function withBot(bots: readonly BotView[], bot: BotView): BotView[] {
  const i = bots.findIndex((b) => b.id === bot.id);
  return sortBots(i < 0 ? [...bots, bot] : bots.map((b) => (b.id === bot.id ? bot : b)));
}

export const isActive = (bot: Pick<BotView, "status">) => bot.status !== "stopped";

/** The bots trading `market` on `venue`. */
export const botsOn = (bots: readonly BotView[], venue: VenueId, market: string | undefined) =>
  bots.filter((b) => b.venue === venue && b.market === market);

/** Net P&L since it started: the curve's last point. */
export const netOf = (bot: Pick<BotView, "curve">) => bot.curve.at(-1)?.value ?? 0;

const dayStart = (t: number) => t - (t % 86_400_000);

/** P&L since 00:00 UTC. */
export function todayOf(bot: Pick<BotView, "curve">, now: number): number {
  const start = dayStart(now);
  let before = 0;
  for (const p of bot.curve) {
    if (p.t >= start) break;
    before = p.value;
  }
  return netOf(bot) - before;
}

/** The points within `period` of the last one. */
export function inPeriod<T extends { t: number }>(points: readonly T[], period: BotPeriod): T[] {
  const last = points.at(-1)?.t;
  if (last === undefined) return [];
  const from = last - PERIOD_MS[period];
  return points.filter((p) => p.t >= from);
}

/** Net P&L of each UTC day the curve covers, oldest first. */
export function dailyPnl(curve: readonly BotPoint[]): { day: number; pnl: number }[] {
  const out: { day: number; pnl: number }[] = [];
  let before = 0;
  let last = 0;
  let day: number | undefined;
  for (const p of curve) {
    const d = dayStart(p.t);
    if (day !== undefined && d !== day) {
      out.push({ day, pnl: last - before });
      before = last;
    }
    day = d;
    last = p.value;
  }
  if (day !== undefined) out.push({ day, pnl: last - before });
  return out;
}

/** The deepest fall from a peak of `capital` plus the curve, as a fraction (0 or less). */
export function maxDrawdownOf(curve: readonly BotPoint[], capital: number): number {
  let peak = capital;
  let worst = 0;
  for (const p of curve) {
    const equity = capital + p.value;
    peak = Math.max(peak, equity);
    if (peak > 0) worst = Math.min(worst, equity / peak - 1);
  }
  return worst;
}

export interface BotStats {
  net: number;
  /** Net as a fraction of the capital it started with. */
  ret: number;
  closed: number;
  /** Fraction of closed trades that made money; undefined before the first. */
  winRate?: number;
  /** Money won over money lost; undefined until something was lost. */
  profitFactor?: number;
  maxDrawdown: number;
  fees: number;
  slippageBps?: number;
}

export function statsOf(bot: Pick<BotView, "curve" | "trades" | "capital">): BotStats {
  const closed = bot.trades.filter((tr) => tr.exitAt !== undefined);
  let won = 0;
  let lost = 0;
  for (const tr of closed) {
    if (tr.pnl > 0) won += tr.pnl;
    else lost -= tr.pnl;
  }
  const net = netOf(bot);
  return {
    net,
    ret: bot.capital > 0 ? net / bot.capital : 0,
    closed: closed.length,
    winRate:
      closed.length > 0 ? closed.filter((tr) => tr.pnl > 0).length / closed.length : undefined,
    profitFactor: lost > 0 ? won / lost : undefined,
    maxDrawdown: maxDrawdownOf(bot.curve, bot.capital),
    fees: bot.trades.reduce((sum, tr) => sum + tr.fees, 0),
    slippageBps:
      bot.trades.length > 0
        ? bot.trades.reduce((sum, tr) => sum + tr.slippageBps, 0) / bot.trades.length
        : undefined,
  };
}

/** The backtest's net P&L at time `t`: its last point at or before it. */
export function backtestAt(curve: readonly BotPoint[], t: number): number {
  let value = 0;
  for (const p of curve) {
    if (p.t > t) break;
    value = p.value;
  }
  return value;
}

export type Drift = "early" | "inLine" | "behind" | "ahead";

/**
 * How the live run compares with its backtest over the same bars: too early
 * to say before `MIN_COMPARE_TRADES` closed trades, else in line within
 * `DRIFT_POINTS` points of return, or behind or ahead of it.
 */
export function driftOf(bot: BotView): { drift: Drift; gap: number } {
  const stats = statsOf(bot);
  const bt = bot.backtest;
  const last = bot.curve.at(-1);
  if (!bt || !last || stats.closed < MIN_COMPARE_TRADES) return { drift: "early", gap: 0 };
  const gap = bot.capital > 0 ? (last.value - backtestAt(bt.curve, last.t)) / bot.capital : 0;
  const points = gap * 100;
  return {
    drift: Math.abs(points) <= DRIFT_POINTS ? "inLine" : points < 0 ? "behind" : "ahead",
    gap,
  };
}

/** Net P&L by the UTC hour each trade opened in. */
export function pnlByHour(trades: readonly BotTrade[]): number[] {
  const hours = Array.from({ length: 24 }, () => 0);
  for (const tr of trades) {
    const h = new Date(tr.entryAt).getUTCHours();
    hours[h] = (hours[h] ?? 0) + tr.pnl;
  }
  return hours;
}

export type DraftProblem = "noRun" | "size" | "loss" | "noAccount" | "liveOff";

/**
 * Why the New bot form can't go on, or undefined. A live bot needs the
 * account's live trading on, as the ticket does; a dry run needs neither.
 */
export function draftProblem(
  draft: Partial<BotDraft>,
  live: { account?: string; tradingOn: boolean },
): DraftProblem | undefined {
  if (!draft.runId) return "noRun";
  if (!draft.sizePct || draft.sizePct <= 0 || draft.sizePct > MAX_SIZE_PCT) return "size";
  if (!draft.maxDailyLoss || draft.maxDailyLoss <= 0) return "loss";
  if (draft.mode === "live") {
    if (!live.account) return "noAccount";
    if (!live.tradingOn) return "liveOff";
  }
  return undefined;
}
