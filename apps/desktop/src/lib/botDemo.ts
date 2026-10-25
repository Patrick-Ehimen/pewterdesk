import type { BotHandlers, BotSource } from "./botSource";
import type { BotDraft, BotEvent, BotExit, BotPoint, BotTrade, BotView, SavedRun } from "./bots";

// Made-up bots, for development builds only: the Bots panel and page have
// nothing to show until the engine lands, and this lets each of their
// states be seen. Every bot it makes is marked `demo`, and the UI says so on
// it. It sends nothing anywhere; actions change its own copy in memory.

/** What the demo shows: bots as normal, or one of the states around them. */
export const DEMO_STATES = ["normal", "loading", "unreachable", "error", "empty"] as const;
export type DemoState = (typeof DEMO_STATES)[number];

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const DEMO_WALLET = "0x7a3f000000000000000000000000000000d3e0";

function rng(seed: number) {
  let s = seed % 2147483647;
  return () => {
    s = (s * 16807) % 2147483647;
    return (s - 1) / 2147483646;
  };
}

interface Spec {
  id: string;
  name: string;
  strategy: string;
  market: string;
  interval: string;
  live: boolean;
  status: BotView["status"];
  reason?: BotView["reason"];
  detail?: string;
  price: number;
  days: number;
  trades: number;
  /** Leans each trade's move: above 0 makes money on average. */
  edge: number;
  /** The backtest's lean over the same bars. */
  btEdge: number;
  seed: number;
  open?: "long" | "short";
}

const SPECS: readonly Spec[] = [
  {
    id: "demo-ema",
    name: "EMA 12/34",
    strategy: "EMA 12 / 34 · both ways · stop 4%",
    market: "HYPE",
    interval: "4h",
    live: true,
    status: "running",
    price: 37.9,
    days: 41,
    trades: 24,
    edge: 0.08,
    btEdge: 0.1,
    seed: 11,
    open: "long",
  },
  {
    id: "demo-brk",
    name: "Donchian 30/12",
    strategy: "Channel 30 · exit 12 · stop 3%",
    market: "ETH",
    interval: "1h",
    live: false,
    status: "running",
    price: 2431.6,
    days: 12,
    trades: 9,
    edge: 0.06,
    btEdge: 0.04,
    seed: 29,
    open: "short",
  },
  {
    id: "demo-rsi",
    name: "RSI 14 reversion",
    strategy: "RSI 14 · bands 30 / 70 · stop 2%",
    market: "SOL",
    interval: "15m",
    live: true,
    status: "paused",
    reason: "rule",
    detail: "daily-loss",
    price: 187.4,
    days: 3,
    trades: 14,
    edge: -0.08,
    btEdge: 0.03,
    seed: 41,
  },
  {
    id: "demo-trend",
    name: "EMA 20/50 trend",
    strategy: "EMA 20 / 50 · long only",
    market: "BTC",
    interval: "1D",
    live: true,
    status: "stopped",
    price: 104_210,
    days: 90,
    trades: 11,
    edge: 0.01,
    btEdge: 0.05,
    seed: 61,
  },
];

const RUNS: readonly SavedRun[] = [
  {
    id: "run-ema",
    name: "EMA 12/34 · both ways",
    venue: "hyperliquid",
    market: "HYPE",
    interval: "4h",
    summary: "4h · stop 4%",
    net: 1840.22,
    maxDrawdown: -0.062,
    trades: 31,
  },
  {
    id: "run-ema-long",
    name: "EMA 9/21 · long only",
    venue: "hyperliquid",
    market: "HYPE",
    interval: "4h",
    summary: "4h · stop 3%",
    net: 1204.18,
    maxDrawdown: -0.048,
    trades: 19,
  },
  {
    id: "run-brk",
    name: "Donchian 30/12",
    venue: "hyperliquid",
    market: "ETH",
    interval: "1h",
    summary: "1h · stop 3% · target 9%",
    net: 642.9,
    maxDrawdown: -0.091,
    trades: 27,
  },
];

const CAPITAL = 10_000;
const SIZE_PCT = 50;
const EXITS: readonly BotExit[] = ["signal", "stop", "signal", "target"];

function curveOf(trades: readonly BotTrade[], start: number, now: number, noise: () => number) {
  const curve: BotPoint[] = [{ t: start, value: 0 }];
  for (let t = start + 4 * HOUR; t <= now; t += 4 * HOUR) {
    const realized = trades.reduce(
      (sum, tr) => (tr.exitAt !== undefined && tr.exitAt <= t ? sum + tr.pnl : sum),
      0,
    );
    const open = trades.some((tr) => tr.entryAt <= t && (tr.exitAt === undefined || tr.exitAt > t));
    curve.push({ t, value: realized + (open ? (noise() - 0.5) * CAPITAL * 0.01 : 0) });
  }
  return curve;
}

function makeBot(spec: Spec, now: number): BotView {
  const r = rng(spec.seed * 7919);
  const start = now - spec.days * DAY;
  const step = (spec.days * DAY) / (spec.trades + 1);
  const trades: BotTrade[] = [];
  const btTrades: BotTrade[] = [];
  let price = spec.price * (0.9 + r() * 0.1);
  for (let i = 0; i < spec.trades; i++) {
    const entryAt = start + step * (i + 0.5);
    const exitAt = Math.min(entryAt + step * (0.3 + r() * 0.6), now - HOUR);
    const side = r() > 0.5 ? "long" : "short";
    const swing = r() - 0.5;
    const move = (swing + spec.edge) * 0.05;
    const exit = price * (1 + (side === "long" ? move : -move));
    const size = (CAPITAL * (SIZE_PCT / 100) * 3) / price;
    const fees = size * price * 0.00045 * 2;
    const pnl = (side === "long" ? exit - price : price - exit) * size - fees;
    const trade: BotTrade = {
      id: `${spec.id}-${i}`,
      side,
      entryAt,
      exitAt,
      entry: price,
      exit,
      size,
      pnl,
      fees,
      slippageBps: 0.5 + r() * 4,
      exitBy: EXITS[Math.floor(r() * EXITS.length)],
    };
    trades.push(trade);
    // The backtest took the same signals; its fills differ by its own lean.
    btTrades.push({ ...trade, pnl: pnl + (spec.btEdge - spec.edge) * 0.05 * size * price });
    price = exit;
  }
  let position: BotView["position"];
  if (spec.open && spec.status !== "stopped") {
    const size = (CAPITAL * (SIZE_PCT / 100) * 3) / price;
    const upnl = (r() - 0.35) * CAPITAL * 0.02;
    position = { side: spec.open, size, entry: price, upnl };
    trades.push({
      id: `${spec.id}-open`,
      side: spec.open,
      entryAt: now - 4 * HOUR,
      entry: price,
      size,
      pnl: upnl,
      fees: size * price * 0.00045,
      slippageBps: 1.2,
    });
  }
  const closed = btTrades.filter((tr) => tr.exitAt !== undefined);
  const btNoise = rng(spec.seed * 31);
  return {
    id: spec.id,
    name: spec.name,
    strategy: spec.strategy,
    venue: "hyperliquid",
    market: spec.market,
    interval: spec.interval,
    account: spec.live ? DEMO_WALLET : undefined,
    mode: spec.live ? "live" : "dry",
    status: spec.status,
    reason: spec.reason,
    detail: spec.detail,
    startedAt: start,
    capital: CAPITAL,
    sizePct: SIZE_PCT,
    maxDailyLoss: 100,
    curve: curveOf(trades, start, now, r),
    trades,
    position,
    backtest: {
      curve: curveOf(btTrades, start, now, btNoise),
      trades: closed.length,
      winRate: closed.filter((tr) => tr.pnl > 0).length / Math.max(1, closed.length),
      slippageBps: 3,
      fees: closed.reduce((sum, tr) => sum + tr.fees, 0),
      maxDrawdown: -0.05,
    },
    demo: true,
  };
}

function makeEvents(now: number): BotEvent[] {
  const at = (minutes: number) => now - minutes * 60_000;
  return [
    {
      id: "e1",
      botId: "demo-ema",
      at: at(18),
      kind: "fill",
      text: "Buy 120 HYPE @ 37.912 · client id 0x9f…0412-17",
    },
    {
      id: "e2",
      botId: "demo-ema",
      at: at(19),
      kind: "signal",
      text: "EMA 12 crossed above EMA 34 at 37.88",
    },
    {
      id: "e3",
      botId: "demo-rsi",
      at: at(40),
      kind: "refused",
      text: "daily-loss · −96.30 of the −100.00 limit · paused",
    },
    {
      id: "e4",
      botId: "demo-rsi",
      at: at(105),
      kind: "fill",
      text: "Sell 4.2 SOL @ 187.44 · stop",
    },
    {
      id: "e5",
      botId: "demo-brk",
      at: at(180),
      kind: "fill",
      text: "Short 0.8 ETH @ 2,431.6 · backtest account",
    },
    {
      id: "e6",
      botId: "demo-ema",
      at: at(410),
      kind: "reconnected",
      text: "Account feed back; open orders re-read before resuming",
    },
    {
      id: "e7",
      botId: "demo-brk",
      at: at(12 * 60),
      kind: "started",
      text: "Dry run on the backtest account · 10,000.00",
    },
  ];
}

/**
 * The demo source, in `state`: bots as normal; still loading; the engine
 * out of reach after a first answer; the first answer failing; or no bots.
 */
export function demoSource(state: DemoState): BotSource {
  const now = Date.now();
  let bots = state === "empty" ? [] : SPECS.map((s) => makeBot(s, now));
  let events = state === "empty" ? [] : makeEvents(now);
  const listeners = new Set<BotHandlers>();
  const emit = (bot: BotView, kind: BotEvent["kind"], text: string) => {
    bots = bots.map((b) => (b.id === bot.id ? bot : b));
    const event = { id: crypto.randomUUID(), botId: bot.id, at: Date.now(), kind, text };
    events = [event, ...events];
    for (const l of listeners) {
      l.onBot(bot);
      l.onEvent(event);
    }
  };
  const find = (id: string) => {
    const bot = bots.find((b) => b.id === id);
    if (!bot) throw new Error(`No bot ${id}`);
    return bot;
  };
  return {
    engine: true,
    demo: true,
    list: () =>
      state === "loading"
        ? new Promise<BotView[]>(() => {})
        : state === "error"
          ? Promise.reject(new Error("events.sqlite3 · database is locked"))
          : Promise.resolve(bots),
    events: async (limit) => events.slice(0, limit),
    runs: async () => (state === "empty" ? [] : [...RUNS]),
    subscribe: (handlers) => {
      listeners.add(handlers);
      if (state === "unreachable") handlers.onLink(false, now - 4 * 60_000);
      return () => {
        listeners.delete(handlers);
      };
    },
    start: async (draft: BotDraft) => {
      const run = RUNS.find((r) => r.id === draft.runId);
      const bot: BotView = {
        id: `demo-${crypto.randomUUID().slice(0, 8)}`,
        name: run?.name.split(" · ")[0] ?? "Bot",
        strategy: run ? `${run.name} · ${run.summary}` : "",
        venue: draft.venue,
        market: draft.market,
        interval: run?.interval ?? "4h",
        account: draft.mode === "live" ? draft.account : undefined,
        mode: draft.mode,
        status: "running",
        startedAt: Date.now(),
        capital: CAPITAL,
        sizePct: draft.sizePct,
        maxDailyLoss: draft.maxDailyLoss,
        curve: [{ t: Date.now(), value: 0 }],
        trades: [],
        demo: true,
      };
      bots = [...bots, bot];
      emit(bot, "started", run ? `From "${run.name}"` : "");
      return bot;
    },
    pause: async (id) => emit({ ...find(id), status: "paused", reason: "user" }, "paused", ""),
    resume: async (id) =>
      emit({ ...find(id), status: "running", reason: undefined, detail: undefined }, "resumed", ""),
    stop: async (id, close) => {
      const bot = find(id);
      emit(
        {
          ...bot,
          status: "stopped",
          reason: undefined,
          position: close ? undefined : bot.position,
        },
        "stopped",
        close ? "Position closed at market" : "Position kept",
      );
    },
    halt: async () => {
      const active = bots.filter((b) => b.status === "running");
      for (const b of active) emit({ ...b, status: "paused", reason: "halt" }, "paused", "Halt");
      return active.length;
    },
  };
}
