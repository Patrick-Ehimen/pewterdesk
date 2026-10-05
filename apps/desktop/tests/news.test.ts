import type { Announcement, Candle, Market, MarketSummary, Position } from "@pewterdesk/core";
import { describe, expect, it } from "vitest";
import {
  buildNews,
  filterNews,
  fundingDue,
  mentionedMarkets,
  priceChart,
  upcoming,
} from "../src/lib/news";

const market = (base: string): Market => ({
  venue: "bybit",
  id: `${base}USDT`,
  symbol: `${base}-USDT`,
  base,
  quote: "USDT",
  tickSize: "0.1",
  sizeStep: "0.001",
  minSize: "0.001",
  maxLeverage: 50,
});
const markets = ["BTC", "ETH", "MON", "AI"].map(market);
const position = (base: string, over: Partial<Position> = {}): Position => ({
  venue: "bybit",
  market: `${base}USDT`,
  side: "long",
  size: "2",
  entryPrice: "100",
  markPrice: "100",
  unrealizedPnl: "0",
  margin: "20",
  ...over,
});
const ann = (over: Partial<Announcement>): Announcement => ({
  venue: "bybit",
  kind: "news",
  title: "Something",
  description: "",
  tags: [],
  time: 1000,
  ...over,
});

describe("mentionedMarkets", () => {
  it("finds market ids and coins, in order, once each", () => {
    expect(mentionedMarkets("New Listing: MONUSDT Perpetual, and ETH, eth again", markets)).toEqual(
      ["MONUSDT", "ETHUSDT"],
    );
  });

  it("only counts words written in capitals", () => {
    const more = [...markets, market("NOW"), market("MOVE"), market("THE")];
    expect(mentionedMarkets("Bybit AI Now Supports Main Account Operations", more)).toEqual([]);
    expect(mentionedMarkets("Make Your Move: the eth giveaway", more)).toEqual([]);
    expect(mentionedMarkets("Bybit to list MOVE", more)).toEqual(["MOVEUSDT"]);
  });

  it("ignores quote coins and two-letter words", () => {
    expect(mentionedMarkets("Bybit AI now pays USDT rewards", markets)).toEqual([]);
    // Written as the market, it counts.
    expect(mentionedMarkets("AIUSDT margin change", markets)).toEqual(["AIUSDT"]);
  });
});

describe("buildNews and filterNews", () => {
  const items = buildNews(
    [
      ann({ kind: "delisting", title: "Delisting of MONUSDT", time: 4 }),
      ann({ kind: "listing", title: "New Listing: BTC options", tags: ["Derivatives"], time: 3 }),
      ann({ kind: "campaign", title: "Win prizes trading ETH", time: 2 }),
      ann({ kind: "maintenance", title: "System upgrade", time: 1 }),
    ],
    markets,
    [position("MON")],
  );
  const show = (over: Partial<Parameters<typeof filterNews>[1]>) =>
    filterNews(items, { filter: "all", query: "", highOnly: false, campaigns: false, ...over }).map(
      (i) => i.time,
    );

  it("marks what you hold and what's high impact", () => {
    expect(items.map((i) => [i.held, i.highImpact])).toEqual([
      [true, true],
      [false, false],
      [false, false],
      [false, true],
    ]);
  });

  it("leaves campaigns out unless asked", () => {
    expect(show({})).toEqual([4, 3, 1]);
    expect(show({ campaigns: true })).toEqual([4, 3, 2, 1]);
  });

  it("filters by kind, holdings, impact and search", () => {
    expect(show({ filter: "listing" })).toEqual([3]);
    expect(show({ filter: "mine" })).toEqual([4]);
    expect(show({ highOnly: true })).toEqual([4, 1]);
    expect(show({ query: "derivatives btc" })).toEqual([3]);
    expect(show({ query: "monusdt" })).toEqual([4]);
  });
});

describe("upcoming", () => {
  const summary = (base: string, intervalSecs: number): MarketSummary => ({
    market: `${base}USDT`,
    markPrice: "100",
    prevDayPrice: "100",
    dayVolume: "0",
    openInterest: "0",
    fundingRate: "0.0001",
    fundingIntervalSecs: intervalSecs,
  });

  it("lists funding on held markets and announcements still to take effect, soonest first", () => {
    const items = buildNews(
      [
        ann({ kind: "listing", title: "MONUSDT opens", startsAt: 9_000_000 }),
        ann({ kind: "maintenance", title: "Done already", startsAt: 50 }),
        ann({ kind: "campaign", title: "Promo", startsAt: 9_500_000 }),
      ],
      markets,
      [],
    );
    // An hour's interval, 20 minutes past the hour: funding at the next hour.
    const out = upcoming(
      items,
      [position("BTC")],
      [summary("BTC", 3600), summary("ETH", 3600)],
      1_200_000,
    );
    expect(out.map((u) => [u.kind, u.time])).toEqual([
      ["funding", 3_600_000],
      ["starts", 9_000_000],
    ]);
  });

  it("works out what funding costs a long and pays a short", () => {
    expect(fundingDue(position("BTC"), 0.0001)).toBeCloseTo(-0.02);
    expect(fundingDue(position("BTC", { side: "short" }), 0.0001)).toBeCloseTo(0.02);
  });
});

describe("priceChart", () => {
  const candle = (openTime: number, close: string): Candle => ({
    openTime,
    open: close,
    high: close,
    low: close,
    close,
    volume: "1",
  });

  it("needs two candles", () => {
    expect(priceChart([candle(0, "1")], 0, 100, 50)).toBeNull();
  });

  it("marks the candle the headline fell in", () => {
    const chart = priceChart([candle(0, "10"), candle(10, "20"), candle(20, "30")], 14, 100, 50);
    expect(chart?.mark).toMatchObject({ x: 50, price: 20 });
    expect(chart?.line.startsWith("M0.0,")).toBe(true);
  });

  it("leaves the mark out when the headline is after the last candle", () => {
    expect(priceChart([candle(0, "10"), candle(10, "20")], 99, 100, 50)?.mark).toBeUndefined();
  });
});
