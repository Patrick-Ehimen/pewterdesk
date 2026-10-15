import { describe, expect, it } from "vitest";
import {
  type Bar,
  DEFAULT_EMA,
  drawdown,
  emaLine,
  type GridParams,
  gridLevels,
  holdOutFor,
  MONTE_CARLO_BUCKETS,
  monteCarlo,
  R_BUCKETS,
  type RunSpec,
  rBuckets,
  readiness,
  rsiLine,
  ruleHolds,
  runBacktest,
  runDays,
  runStats,
  sampleBars,
  seeded,
  smaLine,
  type Trade,
  verdict,
  withPeriod,
} from "../src/lib/backtest";

const HOUR = 3_600_000;
const END = Date.UTC(2026, 9, 14);

const spec = (over: Partial<RunSpec> = {}): RunSpec => ({
  id: 1,
  template: "ema",
  ema: DEFAULT_EMA,
  venue: "hyperliquid",
  market: "HYPE",
  interval: "4h",
  bars: 540,
  end: END,
  holdOutDays: 30,
  capital: 10_000,
  fee: 0.00045,
  slippageBps: 2,
  seed: 42,
  startPrice: 30,
  ...over,
});

const trade = (pnl: number, r = pnl / 100): Trade => ({
  n: 1,
  side: "long",
  openTime: 0,
  closeTime: HOUR,
  entry: 100,
  exit: 100,
  size: 1,
  pnl,
  r,
  risk: 100,
  fees: 0,
  funding: 0,
  slippage: 0,
  exitReason: "cross",
  outOfSample: false,
  mfe: 0,
  mae: 0,
});

describe("sample candles", () => {
  it("are the same for the same seed", () => {
    expect(sampleBars(7, 50, END, HOUR, 100)).toEqual(sampleBars(7, 50, END, HOUR, 100));
    expect(seeded(1)()).toBe(seeded(1)());
  });

  it("end at `end`, one interval apart, with highs and lows around the body", () => {
    const bars = sampleBars(7, 50, END, HOUR, 100);
    expect(bars).toHaveLength(50);
    expect(bars.at(-1)?.time).toBe(END);
    expect((bars[1] as Bar).time - (bars[0] as Bar).time).toBe(HOUR);
    for (const b of bars) {
      expect(b.high).toBeGreaterThanOrEqual(Math.max(b.open, b.close));
      expect(b.low).toBeLessThanOrEqual(Math.min(b.open, b.close));
    }
  });

  it("scale with the start price", () => {
    const a = sampleBars(7, 20, END, HOUR, 100);
    const b = sampleBars(7, 20, END, HOUR, 1000);
    expect((b.at(-1) as Bar).close).toBeCloseTo((a.at(-1) as Bar).close * 10, 6);
  });
});

describe("emaLine", () => {
  it("is undefined until the period fills, then follows the values", () => {
    const line = emaLine([1, 2, 3, 4, 5, 6], 3);
    expect(line.slice(0, 2)).toEqual([undefined, undefined]);
    expect(line[2]).toBeCloseTo(2);
    expect(emaLine([5, 5, 5, 5], 2).at(-1)).toBeCloseTo(5);
  });
});

describe("gridLevels", () => {
  it("spaces the levels evenly from lower to upper", () => {
    expect(gridLevels({ lower: 100, upper: 110, levels: 6 })).toEqual([
      100, 102, 104, 106, 108, 110,
    ]);
  });
});

describe("runBacktest", () => {
  it("is deterministic, and its equity has one point per candle", () => {
    const a = runBacktest(spec());
    expect(runBacktest(spec())).toEqual(a);
    expect(a.equity).toHaveLength(540);
    expect(a.buyHold[0]).toBeCloseTo(10_000);
  });

  it("ends with the capital plus every trade's P&L", () => {
    const run = runBacktest(spec());
    const total = run.trades.reduce((s, t) => s + t.pnl, 0);
    expect(run.trades.length).toBeGreaterThan(0);
    expect(run.equity.at(-1)).toBeCloseTo(10_000 + total, 6);
  });

  it("marks trades opened in the held-out days as out of sample", () => {
    const run = runBacktest(spec());
    const holdOutStart = (run.bars[run.holdOutFrom] as Bar).time;
    for (const t of run.trades) expect(t.outOfSample).toBe(t.openTime >= holdOutStart);
  });

  const grid = (over: Partial<GridParams> = {}): RunSpec =>
    spec({
      template: "grid",
      ema: undefined,
      interval: "1h",
      bars: 24 * 14,
      startPrice: 100,
      grid: {
        lower: 90,
        upper: 110,
        levels: 11,
        sizePerLevel: 1,
        stopBelow: 1,
        stopAbove: 1000,
        ...over,
      },
    });

  it("runs a grid long-only, and flat at the end", () => {
    const run = runBacktest(grid());
    expect(run.stoppedOut).toBeUndefined();
    expect(run.trades.length).toBeGreaterThan(0);
    expect(run.trades.every((t) => t.side === "long")).toBe(true);
    const total = run.trades.reduce((s, t) => s + t.pnl, 0);
    expect(run.equity.at(-1)).toBeCloseTo(10_000 + total, 6);
  });

  it("stops a grid out on the first candle past a stop, and trades no more", () => {
    const run = runBacktest(grid({ stopBelow: 99.99, stopAbove: 100.01 }));
    expect(run.stoppedOut?.index).toBe(0);
    expect(run.trades).toHaveLength(0);
  });
});

describe("runStats", () => {
  it("counts wins and losses and splits the return in and out of sample", () => {
    const run = runBacktest(spec());
    const stats = runStats(run);
    expect(stats.trades).toBe(run.trades.length);
    expect(stats.wins + stats.losses).toBe(stats.trades);
    expect(stats.net).toBeCloseTo((run.equity.at(-1) as number) - 10_000, 6);
    expect(stats.drawdown.max).toBeLessThanOrEqual(0);
  });
});

describe("drawdown", () => {
  it("finds the deepest fall from a peak, and says if it's still open", () => {
    const d = drawdown([100, 120, 90, 110, 130], [0, 1, 2, 3, 4]);
    expect(d.max).toBeCloseTo(-0.25);
    expect(d.at).toBe(2);
    expect(d.open).toBe(false);
    expect(drawdown([100, 80], [0, 1]).open).toBe(true);
  });
});

describe("rBuckets", () => {
  it("puts each trade in the bucket from its lower edge up", () => {
    const counts = rBuckets([
      trade(0, -3),
      trade(0, -1),
      trade(0, 0.2),
      trade(0, 1.5),
      trade(0, 9),
    ]);
    expect(counts).toHaveLength(R_BUCKETS.length);
    expect(counts.reduce((a, b) => a + b, 0)).toBe(5);
    expect(counts[0]).toBe(1); // below -1.5 goes to the first bucket
    expect(counts[R_BUCKETS.indexOf(-1)]).toBe(1);
    expect(counts[R_BUCKETS.indexOf(0)]).toBe(1);
    expect(counts[R_BUCKETS.indexOf(1)]).toBe(1);
    expect(counts.at(-1)).toBe(1);
  });
});

describe("monteCarlo", () => {
  it("is repeatable and covers every ordering it ran", () => {
    const trades = [100, -200, 150, -50, 300, -120].map((p) => trade(p));
    const a = monteCarlo(trades, 10_000, -0.02, 200);
    expect(monteCarlo(trades, 10_000, -0.02, 200)).toEqual(a);
    expect(a.buckets).toHaveLength(MONTE_CARLO_BUCKETS);
    expect(a.buckets.reduce((s, n) => s + n, 0)).toBe(200);
    expect(a.p99).toBeLessThanOrEqual(a.p95);
    expect(a.p95).toBeLessThanOrEqual(a.median);
  });

  it("has no drawdown with only winners", () => {
    const a = monteCarlo([trade(10), trade(20)], 10_000, 0, 50);
    expect(a.median).toBe(0);
    expect(a.worseThanRun).toBe(0);
  });
});

describe("readiness", () => {
  it("fails a run that rests on one trade", () => {
    const stats = runStats(runBacktest(spec()));
    const lopsided = { ...stats, net: 1000 };
    const r = readiness(lopsided, [trade(900), trade(100)], [{ return: 0.1 }]);
    expect(r.concentration.ok).toBe(false);
    expect(r.concentration.share).toBeCloseTo(0.9);
  });

  it("wants most neighbouring settings positive", () => {
    const stats = runStats(runBacktest(spec()));
    const cells = (positive: number) =>
      Array.from({ length: 10 }, (_, i) => ({ return: i < positive ? 0.01 : -0.01 }));
    expect(readiness(stats, [], cells(8)).settings.ok).toBe(true);
    expect(readiness(stats, [], cells(7)).settings.ok).toBe(false);
  });
});

describe("periods", () => {
  it("holds out about the last quarter, at least a day", () => {
    expect(holdOutFor(14)).toBe(4);
    expect(holdOutFor(90)).toBe(26);
    expect(holdOutFor(2)).toBe(1);
  });

  it("changes a run's period but keeps its last candle and price", () => {
    const { id: _, ...base } = spec();
    const longer = withPeriod(base, 180);
    expect(runDays(longer)).toBe(180);
    expect(longer.holdOutDays).toBe(holdOutFor(180));
    const a = runBacktest({ ...base, id: 1 }).bars.at(-1) as Bar;
    const b = runBacktest({ ...longer, id: 2 }).bars.at(-1) as Bar;
    expect(b.time).toBe(a.time);
    expect(b.close).toBeCloseTo(a.close, 6);
  });
});

describe("verdict", () => {
  it("counts the failing checks, and sweeps only EMA runs", () => {
    const run = runBacktest(spec());
    const v = verdict(run, runStats(run));
    const checks = [
      v.checks.settings,
      v.checks.outOfSample,
      v.checks.concentration,
      v.checks.costs,
    ];
    expect(v.failing).toBe(checks.filter((c) => !c.ok).length);
    expect(v.cells).toHaveLength(25);
  });
});

describe("custom rules", () => {
  it("reads moving averages and RSI", () => {
    expect(smaLine([1, 2, 3, 4], 2)).toEqual([undefined, 1.5, 2.5, 3.5]);
    const up = rsiLine([1, 2, 3, 4, 5, 6], 3);
    expect(up.slice(0, 3)).toEqual([undefined, undefined, undefined]);
    expect(up.at(-1)).toBe(100);
  });

  it("tells a cross from a level", () => {
    const left = [1, 2, 3];
    const right = [2, 2, 2];
    expect(ruleHolds("crossesAbove", left, right, 2)).toBe(true);
    expect(ruleHolds("crossesAbove", left, right, 1)).toBe(false);
    expect(ruleHolds("above", left, right, 2)).toBe(true);
    expect(ruleHolds("below", left, right, 0)).toBe(true);
    expect(ruleHolds("crossesBelow", [3, 1], right, 1)).toBe(true);
  });

  const custom = (over: Partial<NonNullable<RunSpec["custom"]>> = {}) =>
    spec({
      template: "custom",
      ema: undefined,
      custom: {
        side: "long",
        entry: [
          {
            left: { kind: "ema", period: 9 },
            op: "crossesAbove",
            right: { kind: "ema", period: 26 },
          },
        ],
        exit: [
          {
            left: { kind: "ema", period: 9 },
            op: "crossesBelow",
            right: { kind: "ema", period: 26 },
          },
        ],
        stopLoss: 0.03,
        takeProfit: 0.06,
        size: 1,
        ...over,
      },
    });

  it("trades its own side, and ends flat with its P&L in the equity", () => {
    const run = runBacktest(custom());
    expect(run.trades.length).toBeGreaterThan(0);
    expect(run.trades.every((t) => t.side === "long")).toBe(true);
    const total = run.trades.reduce((s, t) => s + t.pnl, 0);
    expect(run.equity.at(-1)).toBeCloseTo(10_000 + total, 6);
    expect(runBacktest(custom({ side: "short" })).trades.every((t) => t.side === "short")).toBe(
      true,
    );
  });

  it("exits at its stop or target, never past them", () => {
    const run = runBacktest(custom());
    for (const t of run.trades) {
      if (t.exitReason === "stop") expect(t.exit).toBeLessThan(t.entry);
      if (t.exitReason === "target") expect(t.exit).toBeGreaterThan(t.entry);
    }
    expect(run.trades.some((t) => t.exitReason === "stop" || t.exitReason === "target")).toBe(true);
  });

  it("never trades without an entry rule", () => {
    expect(runBacktest(custom({ entry: [] })).trades).toHaveLength(0);
  });
});
