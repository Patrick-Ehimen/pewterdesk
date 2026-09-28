import type { Candle } from "@pewterdesk/core";
import { describe, expect, it } from "vitest";
import { joinedCandle, joinedCandles } from "../src/lib/chart";

const candle = (open: string, high: string, low: string, close: string): Candle => ({
  openTime: 0,
  open,
  high,
  low,
  close,
  volume: "1",
});

describe("joined candles", () => {
  it("opens each candle at the previous close", () => {
    const drawn = joinedCandles([
      candle("10", "12", "9", "11"),
      candle("11.5", "12", "11.2", "11.8"),
    ]);
    expect(drawn[0]).toEqual({ open: 10, high: 12, low: 9, close: 11 });
    // Opened at 11.5 on the venue; drawn from 11, so the low stretches to 11.
    expect(drawn[1]).toEqual({ open: 11, high: 12, low: 11, close: 11.8 });
  });

  it("turns a one-trade dash into a body from the previous close", () => {
    expect(joinedCandle(candle("0.1435", "0.1435", "0.1435", "0.1435"), 0.1431)).toEqual({
      open: 0.1431,
      high: 0.1435,
      low: 0.1431,
      close: 0.1435,
    });
  });

  it("keeps the first candle's own open", () => {
    expect(joinedCandle(candle("5", "6", "4", "5.5"))).toEqual({
      open: 5,
      high: 6,
      low: 4,
      close: 5.5,
    });
  });
});
