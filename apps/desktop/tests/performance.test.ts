import type { ClosedTrade } from "@pewterdesk/core";
import { describe, expect, it } from "vitest";
import {
  bucketOf,
  closeReturn,
  currentStreak,
  curvePath,
  dayKey,
  nearestDot,
  performance,
  pnlCalendar,
  pnlCurve,
} from "../src/lib/performance";

const at = (y: number, m: number, d: number, h = 12) => new Date(y, m, d, h).getTime();
const close = (time: number, pnl: number, over: Partial<ClosedTrade> = {}): ClosedTrade => ({
  venue: "bybit",
  market: "BTCUSDT",
  side: "long",
  size: "1",
  entryPrice: "100",
  exitPrice: "100",
  closedPnl: String(pnl),
  entryValue: "1000",
  leverage: "10",
  time,
  ...over,
});

describe("performance", () => {
  const trades = [
    close(at(2026, 9, 1), 50),
    close(at(2026, 9, 2), -20),
    close(at(2026, 9, 2, 15), 30),
    close(at(2026, 9, 3), -100),
    // Before the window.
    close(at(2026, 8, 1), 999),
  ];
  const since = at(2026, 9, 1, 0);

  it("adds up the window: realized, wins and losses, best and worst", () => {
    const p = performance(trades, since);
    expect(p).toMatchObject({ realized: -40, trades: 4, wins: 2, losses: 2, winRate: 0.5 });
    expect([p.best, p.worst, p.avgWin, p.avgLoss]).toEqual([50, -100, 40, -60]);
    expect(performance([], since)).toMatchObject({ realized: 0, trades: 0, winRate: 0, best: 0 });
  });

  it("sorts each close by its return on the margin it used", () => {
    // 1,000 at 10x is 100 of margin.
    expect(closeReturn(close(0, 50))).toBe(50);
    expect(bucketOf(close(0, 50))).toBe("gain");
    expect(bucketOf(close(0, 250))).toBe("over200");
    expect(bucketOf(close(0, 600))).toBe("over500");
    expect(bucketOf(close(0, -20))).toBe("loss");
    expect(bucketOf(close(0, -80))).toBe("under50");
    // No leverage given: the whole cost is the margin.
    expect(closeReturn(close(0, 50, { leverage: undefined }))).toBe(5);
    expect(performance(trades, since).buckets).toEqual({
      over500: 0,
      over200: 0,
      gain: 2,
      loss: 1,
      under50: 1,
    });
  });

  it("draws the running total from zero, stepping at each close", () => {
    const now = at(2026, 9, 4);
    const curve = pnlCurve(trades, since, now);
    expect(curve.map((p) => p.total)).toEqual([0, 50, 30, 60, -40, -40]);
    expect(curve[0]?.time).toBe(since);
    expect(curve.at(-1)?.time).toBe(now);
    const path = curvePath(curve, 600, 200);
    expect(path?.line.startsWith("M0.0,")).toBe(true);
    // Zero sits between the best and the worst of it.
    expect(path?.zero).toBeGreaterThan(16);
    expect(path?.zero).toBeLessThan(184);
    // The area runs down to the bottom edge, under the whole line.
    expect(path?.area.endsWith("L600,200L0,200Z")).toBe(true);
    // Each point says what it added, and the pointer finds the nearest.
    expect(path?.dots.map((d) => d.change)).toEqual([0, 50, -20, 30, -100, 0]);
    const dots = path?.dots ?? [];
    expect(nearestDot(dots, -50)).toBe(dots[0]);
    expect(nearestDot(dots, 9999)).toBe(dots.at(-1));
    expect(nearestDot(dots, (dots[3]?.x ?? 0) + 0.2)).toBe(dots[3]);
    expect(curvePath([{ time: 0, total: 0 }], 600, 200)).toBeUndefined();
  });
});

describe("PnL calendar", () => {
  const trades = [
    close(at(2026, 9, 5), 10),
    close(at(2026, 9, 6), 5),
    close(at(2026, 9, 6, 20), 1),
    close(at(2026, 9, 7), -2.441),
    close(at(2026, 9, 8), 4),
    close(at(2026, 8, 30), 77),
  ];
  const now = at(2026, 9, 8, 18);

  it("lays out a month, Monday first, with each day's result", () => {
    const cal = pnlCalendar(trades, 2026, 9, now);
    // October 2026 starts on a Thursday: three blanks before it.
    expect(cal.lead).toBe(3);
    expect(cal.days).toHaveLength(31);
    expect(cal.days[5]).toMatchObject({ day: 6, pnl: 6, trades: 2, future: false });
    expect(cal.days[6]?.pnl).toBeCloseTo(-2.441);
    expect(cal.days[8]?.future).toBe(true);
    expect(cal.total).toBeCloseTo(17.559);
    expect([cal.upDays, cal.downDays, cal.activeDays]).toEqual([3, 1, 4]);
    expect(cal.upTotal).toBe(20);
    expect(cal.downTotal).toBeCloseTo(-2.441);
    // The 5th and 6th, before the 7th broke it.
    expect(cal.bestStreak).toBe(2);
    // September has its own day, and none of October's.
    expect(pnlCalendar(trades, 2026, 8, now).total).toBe(77);
  });

  it("counts the streak still running", () => {
    expect(currentStreak(trades, now)).toBe(1);
    // Nothing closed today yet: yesterday's run still stands.
    expect(currentStreak(trades.slice(0, 3), at(2026, 9, 7, 9))).toBe(2);
    // A losing day, or a day off, ends it.
    expect(currentStreak(trades.slice(0, 4), at(2026, 9, 7, 18))).toBe(0);
    expect(currentStreak(trades.slice(0, 3), at(2026, 9, 9, 9))).toBe(0);
    expect(dayKey(at(2026, 0, 5))).toBe("2026-01-05");
  });
});
