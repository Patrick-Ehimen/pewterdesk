import type { MarketSummary } from "@pewterdesk/core";
import { describe, expect, it } from "vitest";
import { topMovers, venueMovement } from "../src/lib/movement";

const s = (market: string, mark: string, prev: string, vol: string, oi = "0"): MarketSummary => ({
  market,
  markPrice: mark,
  prevDayPrice: prev,
  dayVolume: vol,
  openInterest: oi,
  fundingRate: "0",
  fundingIntervalSecs: 3600,
});

describe("market movement", () => {
  it("totals a venue: volume, OI at the mark, breadth and weighted change", () => {
    const m = venueMovement([
      s("A", "110", "100", "300", "2"),
      s("B", "90", "100", "100", "1"),
      s("C", "5", "5", "0"),
    ]);
    expect(m.volume).toBe(400);
    expect(m.openInterest).toBe(2 * 110 + 1 * 90);
    expect([m.up, m.down, m.flat]).toEqual([1, 1, 1]);
    // (0.1 * 300 - 0.1 * 100) / 400
    expect(m.change).toBeCloseTo(0.05);
  });

  it("is all zeros with nothing to total", () => {
    expect(venueMovement([])).toEqual({
      volume: 0,
      openInterest: 0,
      up: 0,
      down: 0,
      flat: 0,
      change: 0,
    });
  });

  it("ranks movers across venues, skipping thin markets", () => {
    const movers = topMovers(
      [
        { venue: "hl", summaries: [s("A", "120", "100", "1000"), s("THIN", "300", "100", "5")] },
        { venue: "as", summaries: [s("B", "80", "100", "1000"), s("C", "105", "100", "1000")] },
      ],
      2,
      100,
    );
    expect(movers.up.map((m) => `${m.venue}:${m.market}`)).toEqual(["hl:A", "as:C"]);
    expect(movers.down.map((m) => m.market)).toEqual(["B"]);
    expect(movers.down[0]?.change).toBeCloseTo(-0.2);
  });
});
