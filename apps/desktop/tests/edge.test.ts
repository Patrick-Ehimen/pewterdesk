import type { ClosedTrade } from "@pewterdesk/core";
import { describe, expect, it } from "vitest";
import { edge, extremes, holdBucket, sizeBucket } from "../src/lib/edge";

const MIN = 60_000;
const close = (
  minute: number,
  pnl: number,
  entryValue = 1000,
  side: "long" | "short" = "long",
): ClosedTrade => ({
  venue: "bybit",
  market: "BTCUSDT",
  side,
  size: "1",
  entryPrice: "100",
  exitPrice: "100",
  closedPnl: String(pnl),
  entryValue: String(entryValue),
  // Margin is a tenth of the value: 1,000 is 100 of margin.
  leverage: "10",
  time: minute * MIN,
});

describe("edge", () => {
  // win, loss, a bigger one straight after (revenge) that wins, loss, loss, win
  const trades = [
    close(0, 50),
    close(60, -40),
    close(70, 30, 2000),
    close(200, -10, 1000, "short"),
    close(400, -100, 500, "short"),
    close(900, 20, 5000),
  ];
  const e = edge(trades, 0);

  it("says whether the trades add up to an advantage", () => {
    expect(e.trades).toBe(6);
    expect(e.expectancy).toBeCloseTo(-50 / 6);
    // 100 won against 150 lost.
    expect(e.profitFactor).toBeCloseTo(100 / 150);
    expect(e.winRate).toBe(0.5);
    // Median win 30 over median loss 40.
    expect(e.payoff).toBeCloseTo(0.75);
  });

  it("measures the risk taken", () => {
    // Returns on margin: 50, -40, 15, -10, -200, 4. The worst one is the tail.
    expect(e.var95).toBe(-200);
    expect(e.cvar95).toBe(-200);
    // From the peak of 50: down to -70 after the fifth close.
    expect(e.maxDrawdown).toBe(-120);
    expect(edge([close(0, 10), close(1, 20)], 0).maxDrawdown).toBe(0);
  });

  it("splits by direction and by size", () => {
    expect([e.long.trades, e.short.trades]).toEqual([4, 2]);
    expect(e.short.pnl).toBe(-110);
    // Every size group is there, in order; these are the ones traded.
    expect(e.sizes).toHaveLength(6);
    expect(e.sizes.filter((g) => g.trades > 0).map((g) => [g.id, g.trades])).toEqual([
      ["under1k", 1],
      ["under5k", 4],
      ["under20k", 1],
    ]);
    expect(sizeBucket(close(0, 0, 99))).toBe("under100");
    expect(sizeBucket(close(0, 0, 25_000))).toBe("over20k");
    // Ranked by the typical return: 500 lost 200%, 5,000 made 4%.
    const { best, worst } = extremes(e.sizes);
    expect([best?.id, worst?.id]).toEqual(["under20k", "under1k"]);
    expect(best).toMatchObject({ medianReturn: 4, winRate: 1 });
    expect(extremes([e.long])).toEqual({ best: e.long, worst: undefined });
  });

  it("groups by how long each was held, where that's known", () => {
    const held = (minutes: number, pnl: number) => ({
      ...close(1000, pnl),
      openedAt: (1000 - minutes) * MIN,
    });
    const dated = edge(
      [held(0.5, 10), held(5, -20), held(8, -40), held(90, 30), close(1000, 1)],
      0,
    );
    expect(dated.holds.map((g) => g.trades)).toEqual([1, 2, 0, 1, 0, 0]);
    // One had no opening on record.
    expect(dated.undated).toBe(1);
    expect(dated.holds[1]).toMatchObject({ id: "under10m", medianReturn: -30, winRate: 0 });
    expect(holdBucket(held(60 * 24 * 10, 1))).toBe("over7d");
    expect(holdBucket(close(0, 1))).toBeUndefined();
    const { best, worst } = extremes(dated.holds);
    expect([best?.id, worst?.id]).toEqual(["under1d", "under10m"]);
  });

  it("reads how it trades after a loss", () => {
    // Only the 2,000 close ten minutes after the first loss is one.
    expect(e.revenge).toBe(1);
    // After losses came: a win, a loss, a win.
    expect(e.afterLossWinRate).toBeCloseTo(2 / 3);
    expect([e.winStreak, e.lossStreak]).toEqual([1, 2]);
    // Sizes after a loss (2,000, 500, 5,000) over sizes after a win (1,000, 1,000).
    expect(e.tiltRatio).toBeCloseTo(2.5);
    // Two of those three were bigger than the loser before them.
    expect(e.martingale).toBeCloseTo(2 / 3);
    expect(e.streakiness).toBeGreaterThanOrEqual(-1);
    expect(e.streakiness).toBeLessThanOrEqual(1);
  });

  it("counts returns into the histogram's bars", () => {
    // -200 lands in the first bar with -40's neighbour... each in its own:
    // -200 -> below -75; -40 -> -50..-25; -10 -> -25..0; 4, 15 -> 0..25; 50 -> 50..100.
    expect(e.histogram).toEqual([1, 0, 1, 1, 2, 0, 1, 0, 0, 0]);
    expect(e.histogram.reduce((a, b) => a + b, 0)).toBe(6);
  });

  it("has nothing to say about no trades, or one", () => {
    const none = edge([], 0);
    expect(none).toMatchObject({ trades: 0, expectancy: 0, winRate: 0, revenge: 0 });
    expect([none.profitFactor, none.payoff, none.var95, none.tiltRatio]).toEqual([
      undefined,
      undefined,
      undefined,
      undefined,
    ]);
    expect(edge([close(0, 5)], 0).streakiness).toBeUndefined();
  });
});
