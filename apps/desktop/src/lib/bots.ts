import type { VenueId } from "@pewterdesk/core";
import { type RunSpec, runBacktest, runStats } from "./backtest";

// The Bots page's preview (after the Bots mockups in `design/`): what a bot
// is, and how it moves from a backtest to paper trading to live. It starts
// empty; bots come from the user's own backtests. Nothing here runs: the engine that will is planned
// in Rust (`docs/bots/`), and every order a bot asks for will go through the
// same trading gate as the ticket's. Kept in this browser's storage.

export type BotKind = "grid" | "dca" | "trend" | "custom";
/**
 * Where a bot is in its life: a backtest first, then paper trading (orders
 * simulated against live prices) for `PAPER_DAYS`, and only then live.
 */
export type BotMode = "backtest" | "paper" | "live";
export type BotState = "running" | "paused" | "stopped" | "limit";

/** Paper trading lasts this long before a bot can go live. */
export const PAPER_DAYS = 7;

export interface BotPosition {
  side: "long" | "short";
  size: number;
  base: string;
  entry: number;
}

/** What a bot last did, said in the page's language from a message and its values. */
export interface BotEvent {
  /** Unix ms. */
  time: number;
  /** `halted`: stopped by the engine, with its reason (`values.reason`). */
  kind: "bought" | "paused" | "stoppedByLimit" | "backtestDone" | "started" | "stopped" | "halted";
  values?: Record<string, string>;
}

/** The limit nearest to stopping the bot, and how close it is. */
export interface BotLimit {
  kind: "position" | "lossToday";
  used: number;
  max: number;
  unit: string;
}

export interface Bot {
  id: string;
  kind: BotKind;
  /** The name it was given, if any; otherwise it goes by its kind. */
  name?: string;
  venue: VenueId;
  market: string;
  mode: BotMode;
  state: BotState;
  /** Undefined for a backtest. */
  pnlToday?: number;
  /** P&L since it started, or the backtest's result for a backtest. */
  sinceStart: number;
  /** Days it has run (or the backtest's span). */
  days: number;
  /** For a paper bot: which of its `PAPER_DAYS` it's on. */
  paperDay?: number;
  position?: BotPosition;
  event?: BotEvent;
  limit?: BotLimit;
  /** The backtest run behind it. */
  run?: number;
}

export interface BotsState {
  bots: Bot[];
  runs: RunSpec[];
  /** The id the next run takes. */
  nextRun: number;
}

// A new key: what the earlier preview kept (its sample bots) is left behind.
const KEY = "pd.bots";

/** Nothing yet: no bots and no runs. */
export const emptyState = (): BotsState => ({ bots: [], runs: [], nextRun: 1 });

export function loadBots(): BotsState {
  try {
    const saved = JSON.parse(localStorage.getItem(KEY) ?? "null") as BotsState | null;
    if (saved && Array.isArray(saved.bots) && Array.isArray(saved.runs)) return saved;
  } catch {
    // Unreadable: start empty.
  }
  return emptyState();
}

export function saveBots(state: BotsState): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(state));
  } catch {
    // Storage unavailable: it lasts for this session.
  }
}

/** Which of the card's buttons apply in a state. */
export function botActions(bot: Bot) {
  const live = bot.state === "running";
  return {
    start: bot.mode !== "backtest" && (bot.state === "paused" || bot.state === "stopped"),
    pause: live,
    stop: live || bot.state === "paused",
    flatten: bot.position !== undefined && (live || bot.state === "paused"),
    startPaper: bot.mode === "backtest",
    /** Live only after a full run of paper trading. */
    goLive: bot.mode === "paper" && (bot.paperDay ?? 0) >= PAPER_DAYS,
  };
}

export function withBot(state: BotsState, id: string, change: Partial<Bot>): BotsState {
  return { ...state, bots: state.bots.map((b) => (b.id === id ? { ...b, ...change } : b)) };
}

/** A bot moved from its backtest to paper trading, on its first day. */
export function startPaper(state: BotsState, id: string, now: number): BotsState {
  return withBot(state, id, {
    mode: "paper",
    state: "running",
    paperDay: 1,
    days: 0,
    pnlToday: 0,
    sinceStart: 0,
    position: undefined,
    event: { time: now, kind: "started" },
  });
}

/** A new run, with the next id; it's the newest in the list. */
export function withRun(state: BotsState, spec: Omit<RunSpec, "id">): [BotsState, RunSpec] {
  const run = { ...spec, id: state.nextRun } as RunSpec;
  return [{ ...state, runs: [...state.runs, run], nextRun: state.nextRun + 1 }, run];
}

/** A bot for a run (made from its settings), as a backtest until it's paper traded. */
export function botForRun(state: BotsState, run: RunSpec, now: number): [BotsState, Bot] {
  const existing = state.bots.find((b) => b.run === run.id);
  if (existing) return [state, existing];
  const stats = runStats(runBacktest(run));
  const bot: Bot = {
    id: `run-${run.id}`,
    kind: run.template === "grid" ? "grid" : run.template === "custom" ? "custom" : "trend",
    ...(run.name ? { name: run.name } : {}),
    venue: run.venue as VenueId,
    market: run.market,
    mode: "backtest",
    state: "stopped",
    sinceStart: stats.net,
    days: Math.round(stats.days),
    event: {
      time: now,
      kind: "backtestDone",
      values: {
        trades: String(stats.trades),
        drawdown: `${(stats.drawdown.max * 100).toFixed(1)}%`,
      },
    },
    run: run.id,
  };
  return [{ ...state, bots: [bot, ...state.bots] }, bot];
}

export function withoutRuns(state: BotsState, ids: readonly number[]): BotsState {
  return { ...state, runs: state.runs.filter((r) => !ids.includes(r.id)) };
}
