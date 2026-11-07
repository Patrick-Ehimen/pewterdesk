import { describe, expect, it } from "vitest";
import type { TraderRow, TraderStats } from "../src/api/venueClient";
import { isOneHit, stylesOf } from "../src/lib/traderStyles";

const row = (over: Partial<TraderRow>): TraderRow => ({
  source: "hyperliquid",
  id: "0x0000000000000000000000000000000000000001",
  name: null,
  accountValue: 1_000_000,
  pnl: 0,
  roi: 0,
  volume: 0,
  winRate: null,
  copiers: null,
  leadDays: null,
  positive: null,
  roiCurve: [],
  ...over,
});

describe("trader styles", () => {
  it("reads turnover a day over the window on screen", () => {
    // $1M account: $45M over 30 days is 1.5× a day.
    expect(stylesOf(row({ volume: 45_000_000 }), "month")).toEqual(["scalper"]);
    // $3M over 30 days is 0.1× a day.
    expect(stylesOf(row({ volume: 3_000_000 }), "month")).toEqual(["swing"]);
    // In between: neither.
    expect(stylesOf(row({ volume: 15_000_000 }), "month")).toEqual([]);
    // All time has no length to divide by; no volume says nothing.
    expect(stylesOf(row({ volume: 45_000_000 }), "allTime")).toEqual([]);
    expect(stylesOf(row({ volume: 0 }), "month")).toEqual([]);
  });

  it("calls the big accounts whales, by each source's own size", () => {
    expect(stylesOf(row({ accountValue: 12_000_000, volume: 1_000_000 }), "month")).toEqual([
      "swing",
      "whale",
    ]);
    const okx = row({
      source: "okx",
      id: "9F25A5FBE6CFF912",
      accountValue: 1_200_000,
      volume: null,
    });
    expect(stylesOf(okx, "month")).toEqual(["whale"]);
    expect(stylesOf({ ...okx, accountValue: 400_000 }, "month")).toEqual([]);
  });

  it("calls a month carried by one day a one-hit wonder, once it's known", () => {
    const stats = (bestDayShare: number | null): TraderStats => ({
      weeks: [],
      maxDrawdown: null,
      curve: [],
      bestDayShare,
      winDays: null,
    });
    expect(isOneHit(stats(0.7))).toBe(true);
    expect(isOneHit(stats(0.3))).toBe(false);
    expect(isOneHit(stats(null))).toBe(false);
    expect(isOneHit(undefined)).toBe(false);
  });
});
