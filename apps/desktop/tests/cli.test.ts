import type { Market, Order, Position } from "@pewterdesk/core";
import { describe, expect, it } from "vitest";
import { actionFor, parseLine, restoreSession, withHistory } from "../src/lib/cli";

const market = (base: string) =>
  ({
    venue: "bybit",
    id: `${base}USDT`,
    symbol: `${base}USDT`,
    base,
    quote: "USDT",
    sizeStep: "0.001",
    minSize: "0.001",
    tickSize: "0.1",
  }) as unknown as Market;
const markets = [market("BTC"), market("ETH")];
const position = {
  venue: "bybit",
  market: "ETHUSDT",
  side: "long",
  size: "2",
  entryPrice: "2500",
  markPrice: "2480",
  unrealizedPnl: "-40",
} as unknown as Position;
const order = { id: "o1", market: "BTCUSDT", side: "buy", size: "0.01" } as unknown as Order;
const ctx = { markets, current: markets[0], positions: [position], orders: [order] };

describe("the CLI panel's lines", () => {
  it("reads the plain commands", () => {
    expect(parseLine("help", ctx)).toEqual({ kind: "help" });
    expect(parseLine("  POS ", ctx)).toEqual({ kind: "positions" });
    expect(parseLine("bal", ctx)).toEqual({ kind: "balance" });
    expect(parseLine("clear", ctx)).toEqual({ kind: "clear" });
    expect(parseLine("", ctx)).toBeUndefined();
    expect(parseLine("dance", ctx)).toEqual({ kind: "unknown" });
  });

  it("finds markets and pages by name", () => {
    expect(parseLine("price eth", ctx)).toMatchObject({ kind: "price", market: { base: "ETH" } });
    // No coin: the market on screen.
    expect(parseLine("p", ctx)).toMatchObject({ kind: "price", market: { base: "BTC" } });
    expect(parseLine("market eth", ctx)).toMatchObject({ kind: "market", market: { base: "ETH" } });
    expect(parseLine("price doge", ctx)).toEqual({ kind: "missing", what: "market", word: "doge" });
    expect(parseLine("go portfolio", ctx)).toEqual({ kind: "page", page: "portfolio" });
    expect(parseLine("go settings", ctx)).toEqual({ kind: "page", page: "settings" });
    expect(parseLine("go nowhere", ctx)).toEqual({
      kind: "missing",
      what: "page",
      word: "nowhere",
    });
  });

  it("turns a trading line into what would be sent", () => {
    const trade = (text: string) => {
      const line = parseLine(text, ctx);
      if (line?.kind !== "trade") throw new Error(`not a trade: ${text}`);
      return actionFor(line.intent, 50);
    };
    // No price: a market order within the slippage bound.
    expect(trade("buy 0.01 btc")).toEqual({
      kind: "orders",
      requests: [expect.objectContaining({ market: "BTCUSDT", side: "buy", type: "market" })],
    });
    expect(trade("sell 0.01 btc at 82000")).toEqual({
      kind: "orders",
      requests: [expect.objectContaining({ side: "sell", type: "limit", price: "82000" })],
    });
    // Taking part off, and closing, only ever reduce.
    expect(trade("sell 50% eth")).toEqual({
      kind: "orders",
      requests: [expect.objectContaining({ market: "ETHUSDT", size: "1.000", reduceOnly: true })],
    });
    expect(trade("close eth")).toEqual({
      kind: "orders",
      requests: [expect.objectContaining({ side: "sell", size: "2", reduceOnly: true })],
    });
    expect(trade("cancel all")).toEqual({ kind: "cancel", orders: [order] });
    expect(trade("sl eth 2400")).toMatchObject({ kind: "protect", position });
  });

  it("keeps the lines typed, without repeats in a row", () => {
    expect(withHistory(["help"], "help")).toEqual(["help"]);
    expect(withHistory(["help"], " pos ")).toEqual(["help", "pos"]);
    expect(withHistory(["a", "b", "c"], "d", 3)).toEqual(["b", "c", "d"]);
    expect(withHistory(["a"], "  ")).toEqual(["a"]);
  });

  it("brings a kept session back, as far as it reads", () => {
    const kept = restoreSession({
      lines: [
        { id: 7, tone: "in", text: "positions" },
        { id: 7, tone: "ok", text: "ETH long" },
        { tone: "loud", text: "not a line" },
        "nor this",
      ],
      history: ["positions", 4],
      input: "bal",
      pending: true,
    });
    expect(kept).toEqual({
      lines: [
        { id: 0, tone: "in", text: "positions" },
        { id: 1, tone: "ok", text: "ETH long" },
      ],
      history: ["positions"],
      input: "bal",
      pending: true,
    });
    expect(restoreSession(null)).toBeUndefined();
    expect(restoreSession({ lines: "no" })).toBeUndefined();
  });
});
