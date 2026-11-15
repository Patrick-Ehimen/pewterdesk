import type {
  BotSpec,
  BotView,
  CandleInterval,
  RunResult as EngineRun,
  StrategyConfig,
  VenueId,
} from "@pewterdesk/core";
import { type MessageKey, t } from "@pewterdesk/ui";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useEffect, useState, useSyncExternalStore } from "react";
import { asVenueError, describeVenueError } from "../api/venueClient";
import { DEFAULT_EMA, intervalMs, type RunResult, type RunSpec, runBacktest } from "./backtest";
import { type Bot, PAPER_DAYS } from "./bots";

// The Bots page on the engine (`crates/strategy`, the bot host in
// `crates/engine/src/bot/`): a backtest on the venue's own candles, run in
// Rust, and bots that paper trade and go live there - every live order
// through the trading gate. Without the app's Rust side (`make dev-ui`), runs
// are the page's own simulations on sample candles, as before.

/** Whether the engine is here to run backtests and bots. */
export const engineHere = () => isTauri();

async function call<T>(command: string, args: Record<string, unknown> = {}): Promise<T> {
  try {
    return await invoke<T>(command, args);
  } catch (e) {
    throw new Error(describeVenueError(asVenueError(e)));
  }
}

/** A run's strategy as the engine takes it. */
export function strategyOf(spec: RunSpec): StrategyConfig {
  if (spec.template === "grid" && spec.grid) return { template: "grid", ...spec.grid };
  if (spec.template === "custom" && spec.custom) return { template: "custom", ...spec.custom };
  return { template: "ema", ...(spec.ema ?? DEFAULT_EMA) };
}

const INTERVAL: Record<RunSpec["interval"], CandleInterval> = { "1h": "1h", "4h": "4h" };

/** A run's settings as a bot: on `account` (for when it goes live). */
export function botSpecOf(spec: RunSpec, account = ""): BotSpec {
  return {
    ...(spec.name && { name: spec.name }),
    venue: spec.venue as VenueId,
    account,
    market: spec.market,
    interval: INTERVAL[spec.interval],
    strategy: strategyOf(spec),
    limits: { ordersPerMinute: 20, flattenOnStop: true },
    paperCapital: spec.capital,
    // The venue's market-order bound (the app's `VENUES[venue].maxSlippage`).
    maxSlippageBps: spec.venue === "hyperliquid" ? 800 : 500,
  };
}

/** The engine's run as the page's: its lines' gaps as `undefined`. */
export function fromEngine(spec: RunSpec, run: EngineRun): RunResult {
  const line = (values?: (number | null)[]) => values?.map((v) => v ?? undefined);
  return {
    spec,
    bars: run.bars,
    trades: run.trades.map((trade, i) => ({ ...trade, n: i + 1 })),
    equity: run.equity,
    buyHold: run.buyHold,
    holdOutFrom: run.holdOutFrom,
    barsInMarket: run.barsInMarket,
    fastLine: line(run.fastLine as (number | null)[] | undefined),
    slowLine: line(run.slowLine as (number | null)[] | undefined),
    stoppedOut: run.stoppedOut,
  } as RunResult;
}

// ---- Runs: one result per spec, shared by every screen that shows it ----

type Kept = { result: RunResult } | { loading: true } | { error: string };
const kept = new Map<string, Kept>();
const listeners = new Set<() => void>();
let version = 0;
const changed = () => {
  version += 1;
  for (const l of listeners) l();
};

/** What makes two specs the same run (not its id or name). */
function keyOf(spec: RunSpec): string {
  const { id: _id, name: _name, ...rest } = spec;
  return JSON.stringify(rest);
}

/**
 * A run's result: at once for one on sample candles; for one on the
 * venue's (`source: "venue"`), once the engine has run it - undefined
 * until then, and asked for the first time it's wanted.
 */
export function resultOf(spec: RunSpec): RunResult | undefined {
  const key = keyOf(spec);
  const have = kept.get(key);
  if (have && "result" in have) return have.result;
  if (have) return undefined;
  if (spec.source !== "venue" || !engineHere()) {
    const result = runBacktest(spec);
    kept.set(key, { result });
    return result;
  }
  kept.set(key, { loading: true });
  const step = intervalMs(spec.interval);
  call<EngineRun>("bot_backtest", {
    spec: botSpecOf(spec),
    since: spec.end - spec.bars * step,
    holdOutDays: spec.holdOutDays,
  }).then(
    (run) => {
      kept.set(key, { result: fromEngine(spec, run) });
      changed();
    },
    (e: Error) => {
      kept.set(key, { error: e.message });
      changed();
    },
  );
  return undefined;
}

/** Why a run couldn't be made, if it couldn't. */
export function runError(spec: RunSpec): string | undefined {
  const have = kept.get(keyOf(spec));
  return have && "error" in have ? have.error : undefined;
}

/** Re-renders when a run comes back from the engine. */
export function useRuns(): number {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => version,
  );
}

// ---- Bots ----

const DAY = 86_400_000;

/** The engine's codes for why a bot stopped; anything else is its own words. */
const REASONS = ["dailyLoss", "maxPosition", "ordersPerMinute", "stopOut", "appClosed"];

/** Why a bot stopped, in words. */
export const botReason = (reason: string | undefined) =>
  !reason ? "" : REASONS.includes(reason) ? t(`bots.reason.${reason}` as MessageKey) : reason;

/** The engine's bot as the page's card shows it. */
export function cardOf(view: BotView, base: string, runs: Record<string, number>): Bot {
  const kind = view.spec.strategy.template === "ema" ? "trend" : view.spec.strategy.template;
  const since = view.mode === "live" ? view.liveSince : view.paperSince;
  const days = since ? Math.max(0, Math.floor((Date.now() - since) / DAY)) : 0;
  const state: Bot["state"] =
    view.status === "running"
      ? "running"
      : view.status === "paused"
        ? "paused"
        : view.status === "limit"
          ? "limit"
          : "stopped";
  const eventKind =
    view.status === "paused" ? "paused" : view.status === "running" ? "started" : "stopped";
  return {
    id: view.id,
    kind,
    ...(view.spec.name && { name: view.spec.name }),
    venue: view.spec.venue,
    market: view.spec.market,
    mode: view.mode,
    state,
    pnlToday: view.pnlToday,
    sinceStart: view.pnlTotal,
    days,
    ...(view.mode === "paper" && view.paperSince && { paperDay: Math.min(PAPER_DAYS, days + 1) }),
    ...(view.position !== 0 && {
      position: {
        side: view.position > 0 ? "long" : "short",
        size: Math.abs(view.position),
        base,
        entry: view.entry,
      },
    }),
    event: view.reason
      ? {
          time: since ?? view.createdAt,
          kind: "halted",
          values: { reason: botReason(view.reason) },
        }
      : { time: since ?? view.createdAt, kind: eventKind },
    ...(runs[view.id] !== undefined && { run: runs[view.id] }),
  } as Bot;
}

export const botEngine = {
  list: () => call<BotView[]>("bots"),
  create: (spec: BotSpec) => call<BotView>("bot_create", { spec }),
  start: (id: string) => call<BotView>("bot_start", { id }),
  goLive: (id: string) => call<BotView>("bot_go_live", { id }),
  pause: (id: string) => call<void>("bot_pause", { id }),
  resume: (id: string) => call<void>("bot_resume", { id }),
  stop: (id: string, flatten: boolean) => call<void>("bot_stop", { id, flatten }),
  remove: (id: string) => call<void>("bot_delete", { id }),
};

/** The engine's bots, kept up to date by its `bot` events. */
export function useEngineBots(): { bots: BotView[]; error?: string; refresh: () => void } {
  const [bots, setBots] = useState<BotView[]>([]);
  const [error, setError] = useState<string>();
  const [tick, setTick] = useState(0);
  // biome-ignore lint/correctness/useExhaustiveDependencies: `tick` asks again
  useEffect(() => {
    if (!engineHere()) return;
    let live = true;
    botEngine.list().then(
      (list) => live && setBots(list),
      (e: Error) => live && setError(e.message),
    );
    const off = listen<BotView>("bot", (event) => {
      if (!live) return;
      setBots((now) => {
        const next = now.filter((b) => b.id !== event.payload.id);
        return [...next, event.payload].sort((a, b) => a.createdAt - b.createdAt);
      });
    });
    return () => {
      live = false;
      void off.then((stop) => stop());
    };
  }, [tick]);
  return { bots, error, refresh: () => setTick((n) => n + 1) };
}
