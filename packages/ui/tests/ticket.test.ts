import type { Position } from "@pewterdesk/core";
import { describe, expect, it } from "vitest";
import {
  marketFill,
  positionLeverage,
  sizeFromPercent,
  slippageOf,
  ticketOrder,
} from "../src/lib/ticket";

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

describe("ticket orders", () => {
  const base = {
    market: { id: "BTCUSDT", sizeStep: "0.001" },
    side: "buy" as const,
    sizeBase: 0.0129,
    limitPrice: "",
    trigger: "",
    reduceOnly: false,
    tpsl: false,
    maxSlippage: 0.05,
  };

  it("sends a market order with its slippage bound, size cut to the step", () => {
    expect(ticketOrder({ ...base, type: "market" })).toEqual({
      request: {
        market: "BTCUSDT",
        side: "buy",
        size: "0.012",
        reduceOnly: false,
        type: "market",
        maxSlippageBps: 500,
      },
    });
    const wide = ticketOrder({ ...base, type: "market", maxSlippage: 0.5 });
    expect("request" in wide && wide.request).toMatchObject({ maxSlippageBps: 1000 });
  });

  it("sends limit and trigger orders with their prices as typed", () => {
    expect(ticketOrder({ ...base, type: "limit", limitPrice: " 80000.5 " })).toMatchObject({
      request: { type: "limit", price: "80000.5" },
    });
    expect(
      ticketOrder({
        ...base,
        side: "sell",
        type: "stopMarket",
        trigger: "79000",
        reduceOnly: true,
      }),
    ).toMatchObject({ request: { type: "trigger", triggerPrice: "79000", reduceOnly: true } });
    expect(
      ticketOrder({ ...base, type: "stopLimit", trigger: "85000", limitPrice: "85100" }),
    ).toMatchObject({ request: { type: "trigger", triggerPrice: "85000", limitPrice: "85100" } });
  });

  it("says what's missing or not available", () => {
    expect(ticketOrder({ ...base, type: "market", sizeBase: 0.0004 })).toEqual({ blocked: "size" });
    expect(ticketOrder({ ...base, type: "limit", limitPrice: "0" })).toEqual({ blocked: "price" });
    expect(ticketOrder({ ...base, type: "takeMarket" })).toEqual({ blocked: "trigger" });
    expect(ticketOrder({ ...base, type: "takeLimit", trigger: "90000" })).toEqual({
      blocked: "price",
    });
    expect(ticketOrder({ ...base, type: "twap" })).toEqual({ blocked: "type" });
    expect(ticketOrder({ ...base, type: "scale" })).toEqual({ blocked: "type" });
    expect(ticketOrder({ ...base, type: "market", tpsl: true })).toEqual({ blocked: "tpsl" });
  });
});
