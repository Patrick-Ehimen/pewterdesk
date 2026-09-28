import type { Position } from "@pewterdesk/core";
import { describe, expect, it } from "vitest";
import { marketFill, positionLeverage, sizeFromPercent, slippageOf } from "../src/lib/ticket";

const asks = [
  { price: 100, size: 1 },
  { price: 101, size: 2 },
  { price: 105, size: 10 },
];

describe("order ticket maths", () => {
  it("fills against the book, level by level", () => {
    expect(marketFill(asks, 1)).toEqual({ avgPrice: 100, complete: true });
    // 1 @ 100 + 2 @ 101 = 302 for 3.
    expect(marketFill(asks, 3)?.avgPrice).toBeCloseTo(302 / 3);
    const tooBig = marketFill(asks, 20);
    expect(tooBig?.complete).toBe(false);
    expect(marketFill(asks, 0)).toBeUndefined();
    expect(marketFill([], 1)).toBeUndefined();
  });

  it("measures slippage from the best price", () => {
    expect(slippageOf(101, 100)).toBeCloseTo(0.01);
    expect(slippageOf(99, 100)).toBeCloseTo(0.01);
  });

  it("turns a percent of available margin into a size", () => {
    // 50% of 1,000 at 10x is 5,000 of notional: 50 at 100.
    expect(sizeFromPercent(50, 1000, 10, 100)).toBeCloseTo(50);
    expect(sizeFromPercent(50, 1000, 10, 0)).toBe(0);
  });

  it("reads a position's leverage from its margin", () => {
    const position = {
      size: "10",
      markPrice: "40",
      margin: "40",
    } as unknown as Position;
    expect(positionLeverage(position)).toBe(10);
    expect(positionLeverage({ ...position, margin: "0" })).toBeUndefined();
  });
});
