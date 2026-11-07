import { describe, expect, it } from "vitest";
import { BAND_RANGE, bandFromFloor, isSizeBand, SIZE_BANDS } from "../src/lib/accountSize";
import { MIN_TRADES, winRateOf } from "../src/lib/traderHabits";

describe("account size bands", () => {
  it("cover the sizes from $100 up without gaps between the bands", () => {
    const bands = ["100", "1k", "10k", "100k", "1m", "10m"] as const;
    for (let i = 1; i < bands.length; i++) {
      expect(BAND_RANGE[bands[i] as (typeof bands)[number]].min).toBe(
        BAND_RANGE[bands[i - 1] as (typeof bands)[number]].max,
      );
    }
    expect(BAND_RANGE["10m"].max).toBeNull();
    expect(BAND_RANGE.any).toEqual({ min: 0, max: null });
  });

  it("reads a board saved with a floor as its band", () => {
    expect(bandFromFloor(1_000_000)).toBe("1mUp");
    expect(bandFromFloor(100_000)).toBe("100kUp");
    expect(bandFromFloor(undefined)).toBe("100kUp");
    expect(isSizeBand("1k")).toBe(true);
    expect(isSizeBand("2k")).toBe(false);
    expect(SIZE_BANDS).toContain("any");
  });
});

describe("win rate", () => {
  const trips = (n: number) =>
    Array.from({ length: n }, (_, i) => ({
      market: "BTC",
      side: "long" as const,
      size: 1,
      price: 1,
      pnl: i % 2 ? 1 : -1,
      time: i,
      openedAt: null,
    }));

  it("is OKX's own on OKX, and on Hyperliquid only with enough round trips", () => {
    expect(winRateOf(true, { winRate: 0.65 }, undefined)).toBe(0.65);
    expect(winRateOf(false, undefined, { winRate: 0.5, closed: trips(MIN_TRADES) })).toBe(0.5);
    expect(winRateOf(false, undefined, { winRate: 1, closed: trips(MIN_TRADES - 1) })).toBeNull();
    expect(winRateOf(false, undefined, undefined)).toBeNull();
  });
});
