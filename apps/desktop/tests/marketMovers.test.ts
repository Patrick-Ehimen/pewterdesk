import type { Market, MarketSummary } from "@pewterdesk/core";
import { describe, expect, it } from "vitest";
import { dayChanges, marketForCoin, topMovers, trendDistribution } from "../src/lib/marketMovers";

const market = (base: string, listedBy?: string) =>
  ({ id: `${base}USDT`, symbol: `${base}-USDT`, base, listedBy }) as Market;
const summary = (base: string, now: number, before: number) =>
  ({
    market: `${base}USDT`,
    markPrice: String(now),
    prevDayPrice: String(before),
  }) as MarketSummary;

describe("market movers", () => {
  const markets = ["AAA", "BBB", "CCC", "DDD", "EEE"].map((b) => market(b));
  const summaries = new Map(
    [
      summary("AAA", 110, 100),
      summary("BBB", 90, 100),
      summary("CCC", 100, 100),
      summary("DDD", 130, 100),
      summary("EEE", 50, 0),
    ].map((s) => [s.market, s]),
  );
  const changes = dayChanges(markets, summaries);

  it("reads each market's change, skipping one without a price a day ago", () => {
    expect(changes.map((c) => c.market.base)).toEqual(["AAA", "BBB", "CCC", "DDD"]);
    expect(changes[0]?.change).toBeCloseTo(0.1);
  });

  it("ranks gainers and losers, biggest first", () => {
    const { gainers, losers } = topMovers(changes, 3);
    expect(gainers.map((m) => m.market.base)).toEqual(["DDD", "AAA"]);
    expect(losers.map((m) => m.market.base)).toEqual(["BBB"]);
    expect(topMovers(changes, 1).gainers).toHaveLength(1);
  });

  it("counts up, down and unchanged", () => {
    expect(trendDistribution(changes)).toEqual({ up: 2, down: 1, flat: 1 });
  });

  it("finds the venue's own market for a sector's coin", () => {
    const listed = [market("GMX", "xyz"), market("GMX"), market("UMA")];
    expect(marketForCoin(listed, "gmx")?.listedBy).toBeUndefined();
    expect(marketForCoin(listed, "STX")).toBeUndefined();
  });
});
