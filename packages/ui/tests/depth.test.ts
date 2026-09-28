import type { OrderBook } from "@pewterdesk/core";
import { describe, expect, it } from "vitest";
import { avgFillTo, depthLevels, depthWithin, imbalance, largestWalls } from "../src/lib/depth";

const book: OrderBook = {
  market: "X",
  bids: [
    { price: "10", size: "1" },
    { price: "9", size: "1" },
    { price: "8", size: "10" },
  ],
  asks: [
    { price: "11", size: "2" },
    { price: "12", size: "1" },
  ],
  time: 0,
};

describe("depthLevels", () => {
  it("accumulates size and notional from the best price out", () => {
    const { bids, asks } = depthLevels(book);
    expect(bids.map((l) => [l.price, l.notional, l.cumulative, l.cumSize])).toEqual([
      [10, 10, 10, 1],
      [9, 9, 19, 2],
      [8, 80, 99, 12],
    ]);
    expect(asks.map((l) => l.cumulative)).toEqual([22, 34]);
  });

  it("flags levels at least 3× the side's median notional as walls", () => {
    // Bid notionals 10, 9, 80: median 10, so only 80 is a wall.
    expect(depthLevels(book).bids.map((l) => l.wall)).toEqual([false, false, true]);
  });

  it("sums notional within a band of the mid", () => {
    // Mid 10.5; a 10% band reaches down to 9.45, taking only the 10 level.
    expect(depthWithin(depthLevels(book).bids, 10.5, 0.1)).toBe(10);
  });

  it("averages the fill down to a level", () => {
    const deepest = depthLevels(book).bids[2];
    expect(deepest && avgFillTo(deepest)).toBeCloseTo(99 / 12);
  });
});

describe("imbalance and walls", () => {
  const { bids, asks } = depthLevels(book);

  it("compares bid and ask notional within the range", () => {
    // Mid 10.5 ±20% spans 8.4–12.6: bids 10 + 9 = 19 (8 is outside); asks 22 + 12 = 34.
    const i = imbalance(bids, asks, 10.5, 0.2);
    expect(i.bids).toBe(19);
    expect(i.asks).toBe(34);
    expect(i.bidShare).toBeCloseTo(19 / 53);
  });

  it("is even when nothing is in range", () => {
    expect(imbalance([], [], 10, 0.01).bidShare).toBe(0.5);
  });

  it("lists the biggest levels by size, both sides", () => {
    const walls = largestWalls(bids, asks, 10.5, 2);
    expect(walls.map((w) => [w.side, w.price, w.size])).toEqual([
      ["bid", 8, 10],
      ["ask", 11, 2],
    ]);
    expect(walls[0]?.fromMid).toBeCloseTo((8 - 10.5) / 10.5);
  });
});
