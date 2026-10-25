import { describe, expect, it } from "vitest";
import {
  type BotTrade,
  type BotView,
  backtestAt,
  botsOn,
  dailyPnl,
  draftProblem,
  driftOf,
  inPeriod,
  MIN_COMPARE_TRADES,
  maxDrawdownOf,
  pnlByHour,
  sortBots,
  statsOf,
  todayOf,
  withBot,
} from "../src/lib/bots";

const DAY = 86_400_000;
const T0 = Date.UTC(2026, 9, 1);

function trade(pnl: number, at = T0, closed = true): BotTrade {
  return {
    id: `t${at}${pnl}`,
    side: "long",
    entryAt: at,
    exitAt: closed ? at + 3_600_000 : undefined,
    entry: 10,
    exit: closed ? 11 : undefined,
    size: 1,
    pnl,
    fees: 0.5,
    slippageBps: 2,
  };
}

function bot(over: Partial<BotView> = {}): BotView {
  return {
    id: "b",
    name: "EMA",
    strategy: "",
    venue: "hyperliquid",
    market: "HYPE",
    interval: "4h",
    mode: "dry",
    status: "running",
    startedAt: T0,
    capital: 1000,
    sizePct: 50,
    maxDailyLoss: 100,
    curve: [],
    trades: [],
    ...over,
  };
}

describe("sortBots and withBot", () => {
  it("puts running first, then paused, then stopped, newest first within each", () => {
    const sorted = sortBots([
      bot({ id: "s", status: "stopped", startedAt: T0 + 3 }),
      bot({ id: "p", status: "paused", startedAt: T0 + 2 }),
      bot({ id: "r1", startedAt: T0 }),
      bot({ id: "r2", startedAt: T0 + 1 }),
    ]);
    expect(sorted.map((b) => b.id)).toEqual(["r2", "r1", "p", "s"]);
  });

  it("replaces a bot by id, or adds it", () => {
    const one = withBot([bot({ id: "a" })], bot({ id: "a", status: "paused" }));
    expect(one).toHaveLength(1);
    expect(one[0]?.status).toBe("paused");
    expect(withBot(one, bot({ id: "b" }))).toHaveLength(2);
  });

  it("finds the bots on a market", () => {
    const bots = [
      bot({ id: "a" }),
      bot({ id: "b", market: "ETH" }),
      bot({ id: "c", venue: "aster" }),
    ];
    expect(botsOn(bots, "hyperliquid", "HYPE").map((b) => b.id)).toEqual(["a"]);
    expect(botsOn(bots, "hyperliquid", undefined)).toEqual([]);
  });
});

describe("curves", () => {
  const curve = [
    { t: T0, value: 0 },
    { t: T0 + DAY / 2, value: 50 },
    { t: T0 + DAY, value: 40 },
    { t: T0 + DAY + 3_600_000, value: 70 },
  ];

  it("counts today's P&L from 00:00 UTC", () => {
    expect(todayOf({ curve }, T0 + DAY + 7_200_000)).toBe(20);
    expect(todayOf({ curve: [] }, T0)).toBe(0);
  });

  it("splits the curve into UTC days", () => {
    expect(dailyPnl(curve)).toEqual([
      { day: T0, pnl: 50 },
      { day: T0 + DAY, pnl: 20 },
    ]);
    expect(dailyPnl([])).toEqual([]);
  });

  it("keeps the points within a period of the last one", () => {
    const long = [
      { t: T0, value: 0 },
      { t: T0 + 10 * DAY, value: 1 },
    ];
    expect(inPeriod(long, "7d")).toEqual([{ t: T0 + 10 * DAY, value: 1 }]);
    expect(inPeriod(long, "all")).toEqual(long);
    expect(inPeriod([], "7d")).toEqual([]);
  });

  it("measures the deepest fall from a peak of capital plus P&L", () => {
    // Peak 1050, low 1040: down about 0.95%.
    expect(maxDrawdownOf(curve, 1000)).toBeCloseTo(1040 / 1050 - 1);
    expect(maxDrawdownOf([{ t: T0, value: 10 }], 1000)).toBe(0);
  });

  it("reads the backtest at a time as its last point at or before it", () => {
    expect(backtestAt(curve, T0 + DAY)).toBe(40);
    expect(backtestAt(curve, T0 - 1)).toBe(0);
  });
});

describe("statsOf", () => {
  it("leaves win rate and profit factor unset until there is something to measure", () => {
    const s = statsOf(bot());
    expect(s.winRate).toBeUndefined();
    expect(s.profitFactor).toBeUndefined();
    expect(s.slippageBps).toBeUndefined();
    expect(s.net).toBe(0);
  });

  it("counts closed trades only, and every trade's fees", () => {
    const s = statsOf(
      bot({
        curve: [{ t: T0, value: 100 }],
        trades: [trade(30), trade(-10), trade(20), trade(5, T0, false)],
      }),
    );
    expect(s.closed).toBe(3);
    expect(s.winRate).toBeCloseTo(2 / 3);
    expect(s.profitFactor).toBe(5);
    expect(s.fees).toBe(2);
    expect(s.ret).toBe(0.1);
  });
});

describe("driftOf", () => {
  const trades = Array.from({ length: MIN_COMPARE_TRADES }, (_, i) => trade(1, T0 + i));
  const backtest = {
    curve: [{ t: T0, value: 100 }],
    winRate: 0.5,
    trades: MIN_COMPARE_TRADES,
    slippageBps: 3,
    fees: 1,
    maxDrawdown: -0.05,
  };

  it("is too early to say before enough closed trades", () => {
    expect(driftOf(bot({ trades: trades.slice(1), backtest })).drift).toBe("early");
    expect(driftOf(bot({ trades })).drift).toBe("early");
  });

  it("is in line within the threshold, else behind or ahead", () => {
    const at = (value: number) => driftOf(bot({ trades, backtest, curve: [{ t: T0, value }] }));
    expect(at(120).drift).toBe("inLine");
    expect(at(50).drift).toBe("behind");
    expect(at(50).gap).toBeCloseTo(-0.05);
    expect(at(200).drift).toBe("ahead");
  });
});

describe("pnlByHour", () => {
  it("adds each trade's P&L to the UTC hour it opened in", () => {
    const hours = pnlByHour([trade(5, T0 + 3 * 3_600_000), trade(-2, T0 + 3 * 3_600_000 + 60_000)]);
    expect(hours).toHaveLength(24);
    expect(hours[3]).toBe(3);
    expect(hours[4]).toBe(0);
  });
});

describe("draftProblem", () => {
  const ok = { runId: "r", sizePct: 25, maxDailyLoss: 100, mode: "dry" as const };
  const live = { account: "0xabc", tradingOn: true };

  it("accepts a dry run without an account or live trading", () => {
    expect(draftProblem(ok, { tradingOn: false })).toBeUndefined();
  });

  it("names the first thing wrong", () => {
    expect(draftProblem({ ...ok, runId: undefined }, live)).toBe("noRun");
    expect(draftProblem({ ...ok, sizePct: 0 }, live)).toBe("size");
    expect(draftProblem({ ...ok, sizePct: 101 }, live)).toBe("size");
    expect(draftProblem({ ...ok, maxDailyLoss: 0 }, live)).toBe("loss");
  });

  it("needs an account with live trading on for a live bot", () => {
    expect(draftProblem({ ...ok, mode: "live" }, { tradingOn: true })).toBe("noAccount");
    expect(draftProblem({ ...ok, mode: "live" }, { ...live, tradingOn: false })).toBe("liveOff");
    expect(draftProblem({ ...ok, mode: "live" }, live)).toBeUndefined();
  });
});
