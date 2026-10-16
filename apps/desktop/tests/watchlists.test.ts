import type { MarketAlert } from "@pewterdesk/ui";
import { describe, expect, it } from "vitest";
import {
  lastDay,
  listPerformance,
  marketsOn,
  nearestPriceAlert,
  parseLists,
  rangeShare,
  renamed,
  STARRED,
  toggled,
  withList,
  withoutList,
} from "../src/lib/watchlists";

const empty = parseLists(null);

describe("lists", () => {
  it("start with only the starred list on screen", () => {
    expect(empty).toEqual({ lists: [], active: STARRED });
  });

  it("are made, named, filled and deleted", () => {
    let s = withList(empty, "a", "  Momentum   picks ");
    expect(s.active).toBe("a");
    expect(s.lists[0]).toEqual({ id: "a", name: "Momentum picks", keys: [] });
    s = toggled(s, "a", "hyperliquid:HYPE");
    s = toggled(s, "a", "aster:SOLUSDT");
    expect(s.lists[0]?.keys).toEqual(["hyperliquid:HYPE", "aster:SOLUSDT"]);
    s = toggled(s, "a", "hyperliquid:HYPE");
    expect(s.lists[0]?.keys).toEqual(["aster:SOLUSDT"]);
    s = renamed(s, "a", "Breakouts");
    expect(s.lists[0]?.name).toBe("Breakouts");
    // A blank name changes nothing, and makes no list.
    expect(renamed(s, "a", "   ")).toBe(s);
    expect(withList(s, "b", " ")).toBe(s);
    s = withoutList(s, "a");
    expect(s).toEqual({ lists: [], active: STARRED });
  });

  it("read back only what's sound", () => {
    const raw = JSON.stringify({
      active: "gone",
      lists: [
        { id: "a", name: "Majors", keys: ["hyperliquid:BTC", "hyperliquid:BTC", 5, "nonsense"] },
        { id: "a", name: "Twice" },
        { id: STARRED, name: "Fake starred", keys: [] },
        { id: "b", name: "" },
        "junk",
      ],
    });
    expect(parseLists(raw)).toEqual({
      lists: [{ id: "a", name: "Majors", keys: ["hyperliquid:BTC"] }],
      active: STARRED,
    });
    expect(parseLists("{not json")).toEqual(empty);
  });

  it("show the venue on screen's markets", () => {
    expect(
      marketsOn(["hyperliquid:BTC", "aster:BTCUSDT", "hyperliquid:xyz:TSLA"], "hyperliquid"),
    ).toEqual(["BTC", "xyz:TSLA"]);
  });
});

describe("figures", () => {
  it("weigh a list's markets equally, leaving out unknown ones", () => {
    expect(listPerformance([0.02, -0.01, Number.NaN])).toBeCloseTo(0.005);
    expect(listPerformance([])).toBeUndefined();
  });

  it("read the day's range from the last 24 hourly candles", () => {
    const now = Date.UTC(2026, 9, 15, 12);
    const candle = (hoursAgo: number, low: string, high: string, close: string) => ({
      openTime: now - hoursAgo * 3_600_000,
      open: close,
      high,
      low,
      close,
      volume: "1",
    });
    const day = lastDay(
      {
        market: "BTC",
        interval: "1h",
        candles: [
          candle(30, "1", "999", "500"),
          candle(10, "90", "110", "100"),
          candle(1, "95", "120", "115"),
        ],
      },
      now,
    );
    expect(day).toEqual({ low: 90, high: 120, closes: [100, 115] });
    expect(lastDay(undefined, now)).toBeUndefined();
    expect(rangeShare(105, 90, 120)).toBeCloseTo(0.5);
    expect(rangeShare(200, 90, 120)).toBe(1);
    expect(rangeShare(5, 5, 5)).toBe(0.5);
  });

  it("pick the active price alert nearest the price for a card", () => {
    const alert = (id: string, value: number, extra: Partial<MarketAlert> = {}): MarketAlert => ({
      id,
      kind: "price",
      venue: "hyperliquid",
      market: "BTC",
      symbol: "BTC-USDC",
      condition: "above",
      value,
      repeat: "once",
      notify: ["app"],
      active: true,
      createdAt: 0,
      ...extra,
    });
    const alerts = [
      alert("far", 120_000),
      alert("near", 102_000),
      alert("off", 100_500, { active: false }),
      alert("funding", 100_100, { kind: "funding" }),
      alert("other", 100_200, { market: "ETH" }),
    ];
    expect(nearestPriceAlert(alerts, "hyperliquid", "BTC", 100_000)?.id).toBe("near");
    expect(nearestPriceAlert(alerts, "aster", "BTC", 100_000)).toBeUndefined();
  });
});
