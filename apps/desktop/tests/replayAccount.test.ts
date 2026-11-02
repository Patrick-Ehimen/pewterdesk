import type { Market, OrderRequest } from "@pewterdesk/core";
import { describe, expect, it } from "vitest";
import {
  type Fees,
  newPaperState,
  type PaperState,
  placeOrder,
  protectPosition,
} from "../src/lib/paper";
import { endSession, pricePath, type ReplayBar, stepBar } from "../src/lib/replayAccount";

const BTC: Market = {
  venue: "bybit",
  id: "BTC",
  symbol: "BTC-USDT",
  base: "BTC",
  quote: "USDT",
  tickSize: "1",
  sizeStep: "0.001",
  minSize: "0.001",
  maxLeverage: 40,
};
const FEES: Fees = { taker: 0, maker: 0 };
const T = 1_700_000_000;
const bar = (open: number, high: number, low: number, close: number, time = T): ReplayBar => ({
  time,
  open,
  high,
  low,
  close,
});
const market = (side: "buy" | "sell", size = "1") =>
  ({
    market: "BTC",
    side,
    size,
    reduceOnly: false,
    type: "market",
    maxSlippageBps: 50,
  }) as OrderRequest;

/** A position opened at `price`, with these exits. */
function open(side: "buy" | "sell", price: number, exits: { tp?: number; sl?: number } = {}) {
  const quotes = { BTC: { mark: price, bid: price, ask: price } };
  const { state } = placeOrder(
    newPaperState("bybit", 1_000_000),
    market(side),
    BTC,
    quotes,
    FEES,
    T,
  );
  const exit = (price?: number) =>
    price === undefined
      ? ({ action: "keep" } as const)
      : ({ action: "set", price: String(price) } as const);
  return protectPosition(state, "BTC", {
    takeProfit: exit(exits.tp),
    stopLoss: exit(exits.sl),
    trailingStop: { action: "keep" },
  }).state;
}
const closedAt = (state: PaperState) => state.fills[0]?.price;

describe("pricePath", () => {
  it("walks the candle, low first or high first", () => {
    expect(pricePath(bar(100, 110, 90, 105), [], true)).toEqual([100, 90, 110, 105]);
    expect(pricePath(bar(100, 110, 90, 105), [], false)).toEqual([100, 110, 90, 105]);
  });

  it("stops at each level on the way, in order", () => {
    expect(pricePath(bar(100, 110, 90, 105), [95, 92], true)).toEqual([
      100, 95, 92, 90, 92, 95, 110, 105,
    ]);
  });
});

describe("stepBar", () => {
  it("fills a stop at its level, not at the candle's extreme", () => {
    const next = stepBar(open("buy", 100, { sl: 95 }), BTC, bar(100, 101, 80, 90), FEES);
    expect(next.positions).toHaveLength(0);
    expect(Number(closedAt(next))).toBeCloseTo(95, 1);
  });

  it("takes the stop when one candle reaches both", () => {
    const long = stepBar(open("buy", 100, { tp: 110, sl: 95 }), BTC, bar(100, 112, 90, 105), FEES);
    expect(Number(closedAt(long))).toBeCloseTo(95, 1);
    const short = stepBar(open("sell", 100, { tp: 90, sl: 105 }), BTC, bar(100, 112, 88, 95), FEES);
    expect(Number(closedAt(short))).toBeCloseTo(105, 1);
  });

  it("fills a gap at the open, past the stop", () => {
    const next = stepBar(open("buy", 100, { sl: 95 }), BTC, bar(90, 91, 88, 90), FEES);
    expect(Number(closedAt(next))).toBeCloseTo(90, 1);
  });

  it("leaves a position alone inside the candle", () => {
    const state = open("buy", 100, { tp: 110, sl: 95 });
    expect(stepBar(state, BTC, bar(100, 105, 97, 102), FEES).positions).toHaveLength(1);
  });

  it("stamps what fills with the candle's own time", () => {
    const next = stepBar(open("buy", 100, { sl: 95 }), BTC, bar(100, 101, 80, 90, T + 3600), FEES);
    expect(next.fills[0]?.time).toBe((T + 3600) * 1000);
  });
});

describe("endSession", () => {
  it("closes what's open at the last close, and books the result", () => {
    const state = open("buy", 100);
    const next = endSession(state, BTC, bar(100, 121, 99, 120), FEES);
    expect(next.positions).toHaveLength(0);
    expect(next.cash).toBeGreaterThan(state.cash);
    expect(next.closed).toHaveLength(1);
  });

  it("cancels what rests", () => {
    const limit = {
      market: "BTC",
      side: "buy",
      size: "1",
      reduceOnly: false,
      type: "limit",
      price: "90",
      postOnly: false,
      tif: "gtc",
    } as unknown as OrderRequest;
    const quotes = { BTC: { mark: 100, bid: 100, ask: 100 } };
    const { state } = placeOrder(newPaperState("bybit"), limit, BTC, quotes, FEES, T);
    expect(state.orders).toHaveLength(1);
    expect(endSession(state, BTC, bar(100, 101, 99, 100), FEES).orders).toHaveLength(0);
  });

  it("leaves an idle account as it was", () => {
    const state = newPaperState("bybit");
    expect(endSession(state, BTC, bar(100, 101, 99, 100), FEES)).toBe(state);
  });
});
