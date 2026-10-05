import type { AccountSnapshot, Order, Position } from "@pewterdesk/core";
import { describe, expect, it } from "vitest";
import { accountEvents } from "../src/lib/accountEvents";

const position = (over: Partial<Position> = {}): Position => ({
  venue: "bybit",
  market: "BTCUSDT",
  side: "long",
  size: "0.01",
  entryPrice: "83000",
  markPrice: "83500",
  unrealizedPnl: "5",
  margin: "83",
  ...over,
});
const order = (over: Partial<Order> = {}): Order => ({
  venue: "bybit",
  id: "a",
  market: "BTCUSDT",
  side: "buy",
  type: "limit",
  size: "120",
  filledSize: "0",
  price: "80000",
  reduceOnly: false,
  status: "open",
  createdAt: 0,
  category: "regular",
  ...over,
});
const snap = (positions: Position[], openOrders: Order[] = []): AccountSnapshot => ({
  venue: "bybit",
  address: "demo:1",
  equity: "1000",
  availableMargin: "900",
  positions,
  openOrders,
  time: 0,
});

describe("accountEvents", () => {
  it("says nothing when nothing changed", () => {
    expect(accountEvents(snap([position()], [order()]), snap([position()], [order()]))).toEqual([]);
  });

  it("reports an open order that filled further", () => {
    const events = accountEvents(snap([], [order()]), snap([], [order({ filledSize: "60" })]));
    expect(events.map((e) => e.kind)).toEqual(["partialFill"]);
  });

  it("doesn't guess at an order that's gone", () => {
    expect(accountEvents(snap([], [order()]), snap([]))).toEqual([]);
  });

  it("reports positions opened, resized and closed", () => {
    const eth = position({ market: "ETHUSDT" });
    const events = accountEvents(
      snap([position(), eth]),
      snap([position({ size: "0.03" }), position({ market: "SOLUSDT", side: "short" })]),
    );
    expect(events).toEqual([
      { kind: "positionResized", position: position({ size: "0.03" }), from: "0.01" },
      { kind: "positionOpened", position: position({ market: "SOLUSDT", side: "short" }) },
      { kind: "positionClosed", position: eth },
    ]);
  });

  it("ignores a size that only changed its text", () => {
    expect(accountEvents(snap([position()]), snap([position({ size: "0.010" })]))).toEqual([]);
  });
});
