import type { Market, Order, Position } from "@pewterdesk/core";
import { describe, expect, it } from "vitest";
import { findMarket, orderFor, parseCommand, searchMarkets, withRecent } from "../src/lib/commands";

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
