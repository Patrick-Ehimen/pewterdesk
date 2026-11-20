import type { Market, MarketSummary } from "@pewterdesk/core";
import { describe, expect, it } from "vitest";
import { availableChips, chipMarkets, isNew, listedDaysAgo, quoteTabs } from "./screenerGroups";

const DAY = 86_400_000;
const NOW = 1_800_000_000_000;

const market = (id: string, extra: Partial<Market> = {}): Market => ({
  venue: "bybit",
  id,
  symbol: id,
  base: id.replace(/USD[TC]$/, ""),
  quote: id.endsWith("USDC") ? "USDC" : "USDT",
  tickSize: "0.01",
  sizeStep: "0.01",
  minSize: "0.01",
  maxLeverage: 50,
  ...extra,
});

const summary = (id: string, volume: number): MarketSummary => ({
  market: id,
  markPrice: "1",
  prevDayPrice: "1",
  dayVolume: String(volume),
  openInterest: "0",
  fundingRate: "0",
  fundingIntervalSecs: 28_800,
});

const context = (summaries: MarketSummary[] = [], sectors: [string, string[]][] = []) => ({
  now: NOW,
  summaries: new Map(summaries.map((s) => [s.market, s])),
  sectors: new Map(sectors.map(([k, v]) => [k, new Set(v)])) as never,
});

describe("screener groups", () => {
  it("tabs by settlement asset, the most-used first", () => {
    const markets = [market("BTCUSDC"), market("BTCUSDT"), market("ETHUSDT")];
    expect(quoteTabs(markets)).toEqual(["USDT", "USDC"]);
  });

  it("calls a market new for 30 days after its listing", () => {
    const fresh = market("NEWUSDT", { listedAt: NOW - 3 * DAY - 1000 });
    const old = market("OLDUSDT", { listedAt: NOW - 31 * DAY });
    const unknown = market("HYPEUSDT");
    expect([fresh, old, unknown].map((m) => isNew(m, NOW))).toEqual([true, false, false]);
    expect(listedDaysAgo(fresh, NOW)).toBe(3);
    expect(listedDaysAgo(unknown, NOW)).toBeUndefined();
    expect(chipMarkets("new", [fresh, old, unknown], context())).toEqual(new Set(["NEWUSDT"]));
  });

  it("finds a sector's coins whatever the venue calls them", () => {
    const markets = [
      market("1000PEPEUSDT"),
      market("BTCUSDT"),
      market("AAPLUSDT", { base: "PEPE", category: "stock" }),
    ];
    const ctx = context([], [["memes", ["PEPE", "DOGE"]]]);
    expect(chipMarkets("memes", markets, ctx)).toEqual(new Set(["1000PEPEUSDT"]));
  });

  it("trends the busiest markets, and offers only chips with markets", () => {
    const markets = [
      market("BTCUSDT"),
      market("ETHUSDT"),
      market("TSLAUSDT", { category: "stock" }),
    ];
    const ctx = context([summary("BTCUSDT", 10), summary("ETHUSDT", 5)]);
    expect(chipMarkets("trending", markets, ctx)).toEqual(new Set(["BTCUSDT", "ETHUSDT"]));
    expect(availableChips(markets, ctx)).toEqual(["trending", "stock"]);
  });
});
