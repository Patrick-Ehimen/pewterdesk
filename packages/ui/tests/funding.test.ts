import type { FundingRate } from "@pewterdesk/core";
import { describe, expect, it } from "vitest";
import { fundingSeries } from "../src/lib/funding";

const HOUR = 3_600_000;
const DAY0 = Date.UTC(2026, 8, 20);
/** A payment as Hyperliquid stamps it: 41ms after the hour it covers ends. */
const paid = (hourEnding: number, rate: string): FundingRate => ({
  market: "BTC",
  rate,
  time: DAY0 + hourEnding * HOUR + 41,
});

describe("fundingSeries", () => {
  // Payments for the hours ending 01:00 through 24:00 on DAY0.
  const day = Array.from({ length: 24 }, (_, i) => paid(i + 1, i < 8 ? "0.0001" : "-0.00005"));

  it("keeps hourly payments one per hour, under the hour they cover", () => {
    const points = fundingSeries(day, "1h");
    expect(points).toHaveLength(24);
    expect(points[0]?.time).toBe(DAY0);
    expect(points[23]?.time).toBe(DAY0 + 23 * HOUR);
  });

  it("sums into 8h periods at 00, 08 and 16 UTC", () => {
    const points = fundingSeries(day, "8h");
    expect(points.map((p) => p.time)).toEqual([DAY0, DAY0 + 8 * HOUR, DAY0 + 16 * HOUR]);
    expect(points[0]?.rate).toBeCloseTo(0.0008);
    expect(points[1]?.rate).toBeCloseTo(-0.0004);
    // The payment stamped 08:00:00.041 belongs to the first period, not the second.
    expect(fundingSeries([paid(8, "0.0001")], "8h")[0]?.time).toBe(DAY0);
  });

  it("sums whole days and runs a cumulative total", () => {
    const points = fundingSeries([...day, paid(25, "0.0002")], "1d");
    expect(points).toHaveLength(2);
    expect(points[0]?.rate).toBeCloseTo(0.0008 - 0.0008);
    expect(points[1]?.cumulative).toBeCloseTo(0.0002);
  });

  it("skips unreadable rates", () => {
    expect(fundingSeries([paid(1, "x"), paid(2, "0.0001")], "1h")).toHaveLength(1);
  });
});
