import type { Market, Order, Position } from "@pewterdesk/core";
import { describe, expect, it } from "vitest";
import {
  findMarket,
  orderFor,
  parseCommand,
  protectionFor,
  scaledOrders,
  searchMarkets,
  withRecent,
} from "../src/lib/commands";

const market = (base: string, sizeStep = "0.01"): Market => ({
  venue: "bybit",
  id: `${base}USDT`,
  symbol: `${base}-USDT`,
  base,
  quote: "USDT",
  tickSize: "0.1",
  sizeStep,
  minSize: sizeStep,
  maxLeverage: 50,
});
const markets = [market("BTC", "0.001"), market("ETH"), market("HYPE"), market("HYPER")];
const position = (base: string): Position => ({
  venue: "bybit",
  market: `${base}USDT`,
  side: "long",
  size: "2",
  entryPrice: "100",
  markPrice: "100",
  unrealizedPnl: "0",
  margin: "20",
});
const order = (base: string, id: string) => ({ id, market: `${base}USDT` }) as Order;
const ctx = {
  markets,
  current: markets[1],
  positions: [position("ETH")],
  orders: [order("HYPE", "1"), order("HYPE", "2"), order("BTC", "3")],
};
const read = (text: string) => parseCommand(text, ctx);

describe("parseCommand", () => {
  it("reads an order, at a limit when a price follows", () => {
    expect(read("buy 100 hype at 38.2")).toEqual({
      kind: "order",
      side: "buy",
      market: markets[2],
      size: "100.00",
      price: "38.2",
    });
    expect(read("Short BTC 0.0105 @ 80,000")).toMatchObject({
      side: "sell",
      market: markets[0],
      size: "0.010",
      price: "80000",
    });
    expect(read("sell 2 eth @2500")).toMatchObject({ side: "sell", size: "2.00", price: "2500" });
  });

  it("takes the market on screen when no coin is named", () => {
    expect(read("long 1.5")).toMatchObject({ market: markets[1], size: "1.50", price: undefined });
  });

  it("is no order when it can't be one", () => {
    for (const text of [
      "buy",
      "buy hype",
      "buy 100 nope",
      "buy 0 hype",
      "buy 0.0001 btc",
      "buy 100 hype at",
      "buy 100 hype at cheap",
      "buy 100 200 hype",
      "buy 100 hype now please",
      "bought 100 hype",
    ]) {
      expect(read(text), text).toBeUndefined();
    }
  });

  it("closes only a position that's open", () => {
    expect(read("close eth")).toMatchObject({ kind: "close", position: ctx.positions[0] });
    expect(read("close")).toMatchObject({ kind: "close" });
    expect(read("close btc")).toBeUndefined();
  });

  it("cancels every open order, or one market's", () => {
    expect(read("cancel all")).toMatchObject({ kind: "cancel", orders: ctx.orders });
    const hype = read("cancel all hype");
    expect(hype?.kind === "cancel" && hype.orders.map((o) => o.id)).toEqual(["1", "2"]);
    expect(read("cancel btc")).toMatchObject({ orders: [ctx.orders[2]] });
    expect(read("cancel eth")).toBeUndefined();
    expect(read("cancel")).toBeUndefined();
  });
});

describe("orderFor", () => {
  const intent = read("buy 100 hype at 38.2");
  if (intent?.kind !== "order") throw new Error("not an order");

  it("is a limit at the price typed, or a bounded market order", () => {
    expect(orderFor(intent, 500)).toEqual({
      market: "HYPEUSDT",
      side: "buy",
      size: "100.00",
      reduceOnly: false,
      type: "limit",
      price: "38.2",
    });
    expect(orderFor(intent, 500, true)).toMatchObject({ type: "market", maxSlippageBps: 500 });
  });
});

describe("markets and recents", () => {
  it("finds a market by coin, id or symbol, the exact coin first", () => {
    expect(findMarket("hype", markets)).toBe(markets[2]);
    expect(findMarket("ethusdt", markets)).toBe(markets[1]);
    expect(searchMarkets("hyp", markets).map((m) => m.base)).toEqual(["HYPE", "HYPER"]);
    expect(searchMarkets("hyper", markets)[0]).toBe(markets[3]);
    expect(searchMarkets("buy 1", markets)).toEqual([]);
  });

  it("keeps what was run, newest first, once each", () => {
    const one = withRecent([], " Close ETH ", 1);
    const two = withRecent(one, "cancel all", 2);
    expect(withRecent(two, "close eth", 3).map((r) => r.text)).toEqual(["close eth", "cancel all"]);
    expect(withRecent(two, "  ", 4)).toEqual(two);
  });
});

describe("palette extras", () => {
  it("takes a share off a position, only from the side that closes it", () => {
    expect(read("sell 50% eth")).toMatchObject({ kind: "reduce", fraction: 0.5, price: undefined });
    expect(read("sell 100% eth at 2500")).toMatchObject({ fraction: 1, price: "2500" });
    // The position is long: buying isn't taking it off. And BTC has none.
    expect(read("buy 50% eth")).toBeUndefined();
    expect(read("sell 50% btc")).toBeUndefined();
    expect(read("sell 150% eth")).toBeUndefined();
    expect(read("sell 0% eth")).toBeUndefined();
  });

  it("sets or removes a take-profit or stop-loss, keeping the other exits", () => {
    const tp = read("tp eth 2600");
    expect(tp).toMatchObject({ kind: "protect", exit: "tp", price: "2600" });
    if (tp?.kind !== "protect") throw new Error("not a protect");
    expect(protectionFor(tp)).toEqual({
      takeProfit: { action: "set", price: "2600" },
      stopLoss: { action: "keep" },
      trailingStop: { action: "keep" },
    });
    const off = read("sl off");
    if (off?.kind !== "protect") throw new Error("not a protect");
    expect(protectionFor(off).stopLoss).toEqual({ action: "remove" });
    expect(read("tp btc 90000")).toBeUndefined();
    expect(read("tp eth soon")).toBeUndefined();
  });

  it("spreads a scaled order evenly, on the tick, in equal parts", () => {
    const scaled = read("buy 100 hype at 38.2 to 37.8");
    expect(scaled).toMatchObject({ kind: "order", price: "38.2", to: "37.8", count: 5 });
    if (scaled?.kind !== "order") throw new Error("not an order");
    const orders = scaledOrders(scaled) ?? [];
    expect(orders.map((o) => o.type === "limit" && o.price)).toEqual([
      "38.2",
      "38.1",
      "38.0",
      "37.9",
      "37.8",
    ]);
    expect(orders.every((o) => o.size === "20.00" && !o.reduceOnly)).toBe(true);
    expect(read("sell 3 eth @2500 to 2600 x3")).toMatchObject({ count: 3 });
    expect(read("sell 3 eth at 2500 to 2600 in 2 orders")).toMatchObject({ count: 2 });
    // Too many parts, parts under the minimum, or no real range.
    expect(read("buy 100 hype at 38.2 to 37.8 x50")).toBeUndefined();
    expect(read("buy 0.002 btc at 80000 to 79000 x5")).toBeUndefined();
    expect(read("buy 100 hype at 38.2 to 38.2")).toBeUndefined();
    expect(read("buy 100 hype at 38.2 37.8")).toBeUndefined();
  });
});
