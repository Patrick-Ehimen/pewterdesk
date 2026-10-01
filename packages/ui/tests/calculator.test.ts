import { describe, expect, it } from "vitest";
import {
  liquidationPrice,
  maxOpen,
  roundToStep,
  targetPrice,
  tradePnl,
} from "../src/lib/calculator";

describe("trade calculator", () => {
  it("rounds down to the size step", () => {
    expect(roundToStep(19.6559, "0.01")).toEqual({ size: 19.65, text: "19.65" });
    expect(roundToStep(0.3, "0.1")).toEqual({ size: 0.3, text: "0.3" });
    expect(roundToStep(7.9, "1")).toEqual({ size: 7, text: "7" });
    expect(roundToStep(0.004, "0.01").size).toBe(0);
    expect(roundToStep(5, "0").size).toBe(0);
  });

  it("works out PnL, margin and ROI", () => {
    // 2 at 100 is 200 of value: 20 of margin at 10x. Up 5 makes 10, 50% on margin.
    const long = tradePnl("buy", 10, 100, 105, 2);
    expect(long).toMatchObject({ margin: 20, pnl: 10, fees: 0 });
    expect(long?.roi).toBeCloseTo(0.5);
    // The same move loses a short the same.
    expect(tradePnl("sell", 10, 100, 105, 2)?.pnl).toBe(-10);
    // Taker fee on 200 in and 210 out.
    expect(tradePnl("buy", 10, 100, 105, 2, 0.0005)?.fees).toBeCloseTo(0.205);
    expect(tradePnl("buy", 10, 100, 105, 0)).toBeUndefined();
  });

  it("finds the price for a target ROI", () => {
    // 50% at 10x is a 5% move.
    expect(targetPrice("buy", 10, 100, 50)).toBeCloseTo(105);
    expect(targetPrice("sell", 10, 100, 50)).toBeCloseTo(95);
    // A loss target works too.
    expect(targetPrice("buy", 10, 100, -20)).toBeCloseTo(98);
    // A short can't make more than 100% x leverage.
    expect(targetPrice("sell", 1, 100, 100)).toBeUndefined();
  });

  it("estimates the liquidation price", () => {
    // 10x on a 50x market: margin 10%, maintenance 1%, so a 9% move.
    expect(liquidationPrice("buy", 10, 100, 50)).toBeCloseTo(91);
    expect(liquidationPrice("sell", 10, 100, 50)).toBeCloseTo(109);
    // At 1x a long only goes at 1% of the entry, the maintenance margin.
    expect(liquidationPrice("buy", 1, 100, 50)).toBeCloseTo(1);
    expect(liquidationPrice("buy", 0, 100, 50)).toBeUndefined();
  });

  it("finds the most a balance opens", () => {
    // 1,000 at 10x buys 10,000 of value: 100 at 100.
    expect(maxOpen(1000, 10, 100, "0.01")).toEqual({ size: 100, text: "100.00", value: 10_000 });
    // Leaving room for the fee rounds it down.
    const withFee = maxOpen(1000, 10, 100, "0.01", 0.0005);
    expect(withFee?.size).toBe(99.5);
    expect(maxOpen(0, 10, 100, "0.01")).toBeUndefined();
  });
});
