import type { BotTrade, RunResult } from "@pewterdesk/core";
import { describe, expect, it, vi } from "vitest";
import {
  allMarkets,
  combine,
  drawdowns,
  type LabStrategy,
  loadStrategies,
  maxDrawdown,
  monteCarlo,
  monthly,
  periodRange,
  setParam,
  stats,
  steps,
} from "./backtestLab";

const store = new Map<string, string>();
vi.stubGlobal("localStorage", {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => void store.set(k, v),
  removeItem: (k: string) => void store.delete(k),
});

const H = 3_600_000;
const DAY = 24 * H;

function trade(
  n: number,
  pnl: number,
  openTime: number,
  closeTime: number,
  outOfSample = false,
): BotTrade {
  return {
    n,
    side: "long",
    openTime,
    closeTime,
    entry: 100,
    exit: 100 + pnl,
    size: 1,
    pnl,
    r: pnl / 10,
    risk: 10,
    fees: -1,
    funding: -0.5,
    slippage: -0.2,
    exitReason: pnl > 0 ? "cross" : "stop",
    outOfSample,
    mfe: 0,
    mae: 0,
  };
}

/** Ten days of daily candles: equity rises, dips, and recovers; the last 3 held out. */
function run(): RunResult {
  const start = Date.UTC(2026, 0, 30);
  const equity = [1000, 1010, 1030, 1000, 990, 1020, 1040, 1035, 1050, 1060];
  return {
    bars: equity.map((_, i) => ({ time: start + i * DAY, open: 1, high: 1, low: 1, close: 1 })),
    equity,
    buyHold: equity.map((_, i) => 1000 + i * 20),
    holdOutFrom: 7,
    barsInMarket: 5,
    trades: [
      trade(1, 30, start + DAY, start + 2 * DAY),
      trade(2, -40, start + 3 * DAY, start + 4 * DAY),
      trade(3, 50, start + 5 * DAY, start + 6 * DAY),
      trade(4, 25, start + 7 * DAY, start + 9 * DAY, true),
    ],
    asked: [],
  };
}

describe("the backtest lab", () => {
  it("lists a range's values, and refuses a bad one", () => {
    expect(steps(5, 9, 2)).toEqual([5, 7, 9]);
    expect(steps(0.01, 0.03, 0.01)).toEqual([0.01, 0.02, 0.03]);
    expect(steps(9, 5, 1)).toEqual([]);
    expect(steps(1, 100, 1, 20)).toHaveLength(20);
  });

  it("changes one setting, rounding counts", () => {
    const c = setParam(
      {
        template: "ema",
        fast: 9,
        slow: 21,
        stopAtr: 2,
        risk: 0.01,
        maxLeverage: 3,
        direction: "long",
      },
      "fast",
      11.6,
    );
    expect(c).toMatchObject({ fast: 12, slow: 21 });
    expect(setParam(c, "stopAtr", 2.5)).toMatchObject({ stopAtr: 2.5 });
  });

  it("ends a preset at the last closed candle, and a custom one on its last day", () => {
    const now = Date.UTC(2026, 10, 15, 13, 30);
    const s: LabStrategy = {
      id: "s",
      name: "s",
      active: false,
      venue: "binance",
      market: "BTCUSDT",
      interval: "4h",
      period: "90d",
      holdOutDays: 0,
      capital: 10_000,
      slippageBps: 5,
      strategy: { template: "dca", every: 6, amount: 250, takeProfit: 0.08, maxBuys: 12 },
      version: 1,
      updatedAt: 0,
    };
    const r = periodRange(s, now);
    expect(r.until).toBe(Date.UTC(2026, 10, 15, 8));
    expect(r.since).toBe(r.until - 90 * DAY);
    const custom = periodRange(
      { ...s, period: "custom", from: Date.UTC(2026, 0, 1), to: Date.UTC(2026, 2, 31) },
      now,
    );
    expect(custom).toEqual({ since: Date.UTC(2026, 0, 1), until: Date.UTC(2026, 2, 31, 20) });
  });

  it("starts empty, and drops the starters an early build saved", () => {
    localStorage.setItem(
      "pd.backtest.strategies",
      JSON.stringify([
        { id: "seed-trend", strategy: {} },
        { id: "s-1", strategy: {} },
      ]),
    );
    expect(loadStrategies().map((s) => s.id)).toEqual(["s-1"]);
    localStorage.removeItem("pd.backtest.strategies");
    expect(loadStrategies()).toEqual([]);
  });

  it("reads a run's figures", () => {
    const s = stats(run());
    expect(s.ret).toBeCloseTo(0.06);
    expect(s.retIn).toBeCloseTo(0.04);
    expect(s.retOut).toBeCloseTo(1060 / 1040 - 1);
    expect(s.maxDrawdown).toBeCloseTo(990 / 1030 - 1);
    expect(s.trades).toBe(4);
    expect(s.tradesOut).toBe(1);
    expect(s.winRate).toBe(0.75);
    expect(s.profitFactor).toBeCloseTo(105 / 40);
    expect(s.fees).toBeCloseTo(4);
    expect(s.funding).toBeCloseTo(2);
    expect(s.gross).toBeCloseTo(60 + 4 + 2 + 0.8);
    expect(s.best?.n).toBe(3);
    expect(s.stops).toBe(1);
  });

  it("splits a run into calendar months", () => {
    const months = monthly(run());
    expect(months).toHaveLength(2);
    expect(months[0]?.at).toBe(Date.UTC(2026, 0, 1));
    expect(months[0]?.ret).toBeCloseTo(0.01);
    expect(months[1]?.ret).toBeCloseTo(1060 / 1010 - 1);
    expect(months[1]?.heldOut).toBe(true);
  });

  it("finds the deepest fall and when it came back", () => {
    const [worst] = drawdowns(run());
    expect(worst?.depth).toBeCloseTo(990 / 1030 - 1);
    expect(worst?.back).toBe(run().bars[6]?.time);
    expect(maxDrawdown([100, 120, 90, 130])).toBeCloseTo(-0.25);
  });

  it("redraws the trades the same way every time", () => {
    const a = monteCarlo(run(), 500);
    const b = monteCarlo(run(), 500);
    expect(a).toEqual(b);
    expect(a?.losing).toBeGreaterThanOrEqual(0);
    expect(a?.dd95).toBeLessThanOrEqual(a?.ddMedian ?? 0);
  });

  it("lists a strategy's markets once each, the first first", () => {
    expect(allMarkets({ market: "BTCUSDT", extra: ["ETHUSDT", "BTCUSDT", ""] })).toEqual([
      "BTCUSDT",
      "ETHUSDT",
    ]);
    expect(allMarkets({ market: "", extra: [] })).toEqual([]);
  });

  it("adds markets up into one account, carrying each between its candles", () => {
    const a = run();
    const b: RunResult = {
      ...run(),
      // Starts a day later, and only every other day.
      bars: [1, 3, 5, 7, 9].map((i) => ({
        time: run().bars[i]?.time ?? 0,
        open: 1,
        high: 1,
        low: 1,
        close: 1,
      })),
      equity: [1000, 1100, 1200, 1300, 1400],
      buyHold: [1000, 1000, 1000, 1000, 1000],
      holdOutFrom: 3,
      trades: [trade(1, 400, run().bars[1]?.time ?? 0, run().bars[9]?.time ?? 0)],
    };
    const c = combine([
      { market: "A", run: a },
      { market: "B", run: b },
    ]);
    expect(c.bars).toHaveLength(10);
    // Day 0: A's 1000 and B's share still in cash (its first equity).
    expect(c.equity[0]).toBe(1000 + 1000);
    // Day 2: A at 1030, B carried from its day-1 candle (1000); day 3, B's next (1100).
    expect(c.equity[2]).toBe(1030 + 1000);
    expect(c.equity[3]).toBe(1000 + 1100);
    expect(c.equity.at(-1)).toBe(1060 + 1400);
    expect(c.trades.map((t) => t.n)).toEqual([1, 2, 3, 4, 5]);
    expect(c.tradeMarkets).toEqual(["A", "B", "A", "A", "A"]);
    expect(c.holdOutFrom).toBe(7);
  });
});
