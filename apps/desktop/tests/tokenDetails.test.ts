import type { Candle, Market } from "@pewterdesk/core";
import { describe, expect, it } from "vitest";
import { changeOver, lowHigh, matchesSearch, namesToken } from "../src/lib/tokenDetails";

const candle = (openTime: number, close: number, low = close, high = close): Candle =>
  ({
    openTime,
    open: String(close),
    high: String(high),
    low: String(low),
    close: String(close),
    volume: "1",
  }) as unknown as Candle;

describe("token details", () => {
  it("finds the range's low and high, and when", () => {
    const range = lowHigh([candle(1, 10, 9, 11), candle(2, 12, 8, 13), candle(3, 11, 10, 12)]);
    expect(range).toEqual({ low: { price: 8, time: 2 }, high: { price: 13, time: 2 } });
    expect(lowHigh([])).toBeUndefined();
  });

  it("compares today with the close days before", () => {
    const daily = Array.from({ length: 31 }, (_, i) => candle(i, 100 + i));
    expect(changeOver(daily, 7, 130)).toBeCloseTo(130 / 123 - 1);
    expect(changeOver(daily, 30, 130)).toBeCloseTo(0.3);
    expect(changeOver(daily.slice(-5), 7, 130)).toBeUndefined();
  });

  it("knows a headline names a token by its ticker or its name", () => {
    expect(
      namesToken("Solana faces Binance hacker's swap - can SOL defend $90?", "SOL", "Solana"),
    ).toBe(true);
    expect(namesToken("$ETH breaks out", "ETH")).toBe(true);
    expect(namesToken("ethereum ETF flows turn", "ETH", "Ethereum")).toBe(true);
    expect(namesToken("SOLVE raises a round", "SOL", "Solana")).toBe(false);
    expect(namesToken("Bitcoin slips", "ETH", "Ethereum")).toBe(false);
    // Two letters is too common a word to go by.
    expect(namesToken("OP says it will", "OP")).toBe(false);
  });

  it("searches a market by its symbol or base", () => {
    const m = { id: "ETHUSDT", symbol: "ETH-USDT", base: "ETH" } as Market;
    expect(matchesSearch(m, "eth")).toBe(true);
    expect(matchesSearch(m, " ETH-U ")).toBe(true);
    expect(matchesSearch(m, "")).toBe(true);
    expect(matchesSearch(m, "btc")).toBe(false);
  });
});
