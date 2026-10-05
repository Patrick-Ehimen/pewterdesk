import type { Market, MarketSummary } from "@pewterdesk/core";
import { describe, expect, it } from "vitest";
import {
  PICKER_PRESETS,
  pickerQuotes,
  pickerRows,
  pickerTabs,
  pickerView,
  presetOf,
  trendingIds,
} from "../src/lib/marketPicker";

const market = (id: string, listedBy?: string): Market => ({
  venue: "hyperliquid",
  id,
  symbol: `${id.split(":").pop()}-USDC`,
  base: id.split(":").pop() ?? id,
  quote: "USDC",
  tickSize: "0.01",
  sizeStep: "0.01",
  minSize: "0.01",
  maxLeverage: 10,
  ...(listedBy ? { listedBy } : {}),
});
const summary = (id: string, mark: string, prev: string, vol: string): MarketSummary => ({
  market: id,
  markPrice: mark,
  prevDayPrice: prev,
  dayVolume: vol,
  openInterest: "0",
  fundingRate: "0",
  fundingIntervalSecs: 3600,
});

const markets = [market("BTC"), market("ETH"), market("HYPE"), market("xyz:TSLA", "xyz")];
const rows = pickerRows(markets, [
  summary("BTC", "101", "100", "900"),
  summary("ETH", "95", "100", "500"),
  summary("xyz:TSLA", "110", "100", "50"),
  // HYPE's summary hasn't arrived.
]);

describe("market picker", () => {
  it("splits the venue's own markets from builder-deployed ones, and favorites", () => {
    const ids = (tab: "perps" | "hip3" | "favorites", starred = new Set<string>()) =>
      pickerView(rows, tab, starred, "", PICKER_PRESETS.top).map((r) => r.market.id);
    expect(ids("perps")).toEqual(["BTC", "ETH", "HYPE"]);
    expect(ids("hip3")).toEqual(["xyz:TSLA"]);
    expect(ids("favorites", new Set(["ETH"]))).toEqual(["ETH"]);
  });

  it("sorts by the presets, with loading rows last either way", () => {
    const ids = (sort = PICKER_PRESETS.top) =>
      pickerView(rows, "perps", new Set(), "", sort).map((r) => r.market.id);
    expect(ids(PICKER_PRESETS.top)).toEqual(["BTC", "ETH", "HYPE"]);
    expect(ids(PICKER_PRESETS.gainers)).toEqual(["BTC", "ETH", "HYPE"]);
    expect(ids(PICKER_PRESETS.losers)).toEqual(["ETH", "BTC", "HYPE"]);
    expect(ids({ by: "name", descending: false })).toEqual(["BTC", "ETH", "HYPE"]);
  });

  it("searches by symbol and by exchange", () => {
    const find = (q: string, tab: "perps" | "hip3") =>
      pickerView(rows, tab, new Set(), q, PICKER_PRESETS.top).map((r) => r.market.id);
    expect(find("eth", "perps")).toEqual(["ETH"]);
    expect(find("xyz", "hip3")).toEqual(["xyz:TSLA"]);
  });

  it("computes the 24h change, and knows which chip a sort is", () => {
    expect(rows[0]?.change24h).toBeCloseTo(0.01);
    expect(rows[2]?.price).toBeUndefined();
    expect(presetOf({ by: "change", descending: false })).toBe("losers");
    expect(presetOf({ by: "price", descending: true })).toBeUndefined();
  });

  it("carries the change in price terms, funding and open interest in the quote asset", () => {
    const [btc] = pickerRows(
      [market("BTC")],
      [{ ...summary("BTC", "101", "100", "900"), openInterest: "2", fundingRate: "0.0001" }],
    );
    expect(btc?.changeAbs).toBeCloseTo(1);
    expect(btc?.funding).toBeCloseTo(0.0001);
    expect(btc?.fundingIntervalSecs).toBe(3600);
    expect(btc?.openInterest).toBeCloseTo(202);
  });

  it("sorts by funding and by open interest", () => {
    const withData = pickerRows(markets, [
      { ...summary("BTC", "100", "100", "1"), fundingRate: "0.0003", openInterest: "1" },
      { ...summary("ETH", "100", "100", "1"), fundingRate: "-0.0001", openInterest: "5" },
      { ...summary("HYPE", "100", "100", "1"), fundingRate: "0.0001", openInterest: "3" },
    ]);
    const by = (key: "funding" | "oi") =>
      pickerView(withData, "perps", new Set(), "", { by: key, descending: true }).map(
        (r) => r.market.id,
      );
    expect(by("funding")).toEqual(["BTC", "HYPE", "ETH"]);
    expect(by("oi")).toEqual(["ETH", "HYPE", "BTC"]);
  });

  it("offers the HIP-3 tab only where there are builder markets", () => {
    expect(pickerTabs(markets)).toEqual(["favorites", "perps", "trending", "hip3"]);
    expect(pickerTabs([market("BTC")])).toEqual(["favorites", "perps", "trending"]);
  });

  describe("categories", () => {
    const DAY = 24 * 60 * 60 * 1000;
    const NOW = 100 * DAY;
    const listed: Market[] = [
      market("BTC"),
      { ...market("NEWCOIN"), listedAt: NOW - 3 * DAY, category: "innovation" },
      { ...market("OLDCOIN"), listedAt: NOW - 90 * DAY },
      { ...market("AAL"), category: "stock", quote: "USDT" },
      { ...market("ARKK"), category: "etf", quote: "USDT" },
    ];
    const listedRows = pickerRows(listed);
    const ids = (tab: Parameters<typeof pickerView>[1], quote?: string) =>
      pickerView(
        listedRows,
        tab,
        new Set(),
        "",
        { by: "name", descending: false },
        { now: NOW, quote },
      ).map((r) => r.market.id);

    it("offers only the tabs the venue has markets for", () => {
      expect(pickerTabs(listed, NOW)).toEqual([
        "favorites",
        "perps",
        "trending",
        "new",
        "innovation",
        "stock",
        "etf",
      ]);
      // Nothing listed in the last 30 days: no New tab.
      expect(pickerTabs(listed, NOW + 60 * DAY)).not.toContain("new");
    });

    it("puts each market under its category, and recent listings under New", () => {
      expect(ids("stock")).toEqual(["AAL"]);
      expect(ids("etf")).toEqual(["ARKK"]);
      expect(ids("innovation")).toEqual(["NEWCOIN"]);
      expect(ids("new")).toEqual(["NEWCOIN"]);
      expect(ids("perps")).toHaveLength(5);
    });

    it("filters by quote coin, the most used first in the list", () => {
      expect(pickerQuotes(listed)).toEqual(["USDC", "USDT"]);
      expect(ids("perps", "USDT")).toEqual(["AAL", "ARKK"]);
      expect(ids("stock", "USDC")).toEqual([]);
    });

    it("picks the biggest movers among the more traded half as trending", () => {
      const moving = pickerRows(
        ["A", "B", "C", "D"].map((id) => market(id)),
        [
          summary("A", "150", "100", "10"), // +50%, but barely traded
          summary("B", "90", "100", "900"), // -10%
          summary("C", "103", "100", "800"), // +3%
          summary("D", "100", "100", "5"),
        ],
      );
      expect([...trendingIds(moving)]).toEqual(["B", "C"]);
      expect(
        pickerView(moving, "trending", new Set(), "", PICKER_PRESETS.top).map((r) => r.market.id),
      ).toEqual(["B", "C"]);
    });
  });
});
