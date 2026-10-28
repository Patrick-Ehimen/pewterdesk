import type { Bar } from "openalgo-charts";
import { describe, expect, it } from "vitest";
import {
  barWidth,
  isProfileType,
  rowSize,
  SESSION_PROFILE_TYPE,
  sessionKey,
  TPO_TYPE,
} from "../src/components/trading/SessionProfiles";

const bar = (time: number, low: number, high: number): Bar => ({
  time,
  open: low,
  high,
  low,
  close: high,
  volume: 1,
});

describe("session profiles", () => {
  it("knows its own chart types", () => {
    expect(isProfileType(SESSION_PROFILE_TYPE)).toBe(true);
    expect(isProfileType(TPO_TYPE)).toBe(true);
    expect(isProfileType("candlestick")).toBe(false);
  });

  it("reads the bars' width from the commonest gap", () => {
    const bars = [0, 900, 1800, 2700, 7200, 8100].map((t) => bar(t, 1, 2));
    expect(barWidth(bars)).toBe(900);
  });

  it("groups by the UTC calendar, weeks from Monday", () => {
    // 2024-01-07 is a Sunday, 2024-01-08 a Monday.
    const sunday = Date.UTC(2024, 0, 7, 23) / 1000;
    const monday = Date.UTC(2024, 0, 8, 1) / 1000;
    expect(sessionKey(sunday, "day")).not.toBe(sessionKey(monday, "day"));
    expect(sessionKey(sunday, "week")).toBe(sessionKey(monday, "week") - 1);
    expect(sessionKey(Date.UTC(2024, 0, 31) / 1000, "month")).toBe(
      sessionKey(Date.UTC(2024, 0, 1) / 1000, "month"),
    );
  });

  it("splits a usual session's range into round rows of whole ticks", () => {
    const day = 86_400;
    // Three days ranging 100, 120 and 80: the median, 100, in about 40 rows.
    const bars = [bar(0, 1000, 1100), bar(day, 1000, 1120), bar(2 * day, 1000, 1080)];
    expect(rowSize(bars, "day", 40, 0.1)).toBe(2.5);
    // Never under a tick.
    expect(rowSize(bars, "day", 40, 5)).toBe(5);
  });
});
