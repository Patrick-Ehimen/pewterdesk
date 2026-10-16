import type { MarketSummary } from "@pewterdesk/core";
import { describe, expect, it } from "vitest";
import { parseOi, withSummaries } from "../src/lib/oiStore";

const T = Date.UTC(2026, 0, 5);
const M = 60_000;
const summary = (market: string, oi: number, price = 10): MarketSummary =>
  ({
    market,
    markPrice: String(price),
    prevDayPrice: String(price),
    dayVolume: "1",
    openInterest: String(oi),
    fundingRate: "0",
    fundingIntervalSecs: 3600,
  }) as MarketSummary;

describe("open-interest store", () => {
  it("writes at most every 5 minutes, with the price", () => {
    const first = withSummaries({ markets: {} }, [summary("BTC", 100, 50)], T);
    expect(first.markets.BTC).toEqual([{ time: T, oi: 100, price: 50 }]);
    expect(first.since).toBe(T);
    const soon = withSummaries(first, [summary("BTC", 120)], T + 2 * M);
    expect(soon).toBe(first);
    const later = withSummaries(first, [summary("BTC", 120)], T + 6 * M);
    expect(later.markets.BTC).toHaveLength(2);
    expect(later.last).toBe(T + 6 * M);
  });

  it("keeps the largest 150 markets and drops the unlisted", () => {
    const many = Array.from({ length: 200 }, (_, i) => summary(`M${i}`, i + 1));
    const store = withSummaries({ markets: { GONE: [{ time: T - M, oi: 5 }] } }, many, T);
    expect(Object.keys(store.markets)).toHaveLength(150);
    expect(store.markets.M199).toBeDefined();
    expect(store.markets.M0).toBeUndefined();
    expect(store.markets.GONE).toBeUndefined();
  });

  it("reads back only well-formed samples", () => {
    const raw = JSON.stringify({
      since: T,
      last: T,
      markets: {
        BTC: [
          { time: T, oi: 1 },
          { time: "x", oi: 2 },
          { time: T, oi: -1 },
        ],
        BAD: 3,
      },
    });
    expect(parseOi(raw)).toEqual({ since: T, last: T, markets: { BTC: [{ time: T, oi: 1 }] } });
    expect(parseOi("nope")).toEqual({ markets: {} });
  });
});
