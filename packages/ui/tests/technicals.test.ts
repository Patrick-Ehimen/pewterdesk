import type { Candle } from "@pewterdesk/core";
import { describe, expect, it } from "vitest";
import { techBreakdown, techScores } from "../src/lib/technicals";

const HOUR = 3_600_000;
const run = (closes: number[], spread = 0.2) =>
  closes.map(
    (close, i) =>
      ({
        openTime: i * HOUR,
        open: String(close),
        high: String(close + spread),
        low: String(close - spread),
        close: String(close),
        volume: "100",
      }) as unknown as Candle,
  );

describe("TradingView's technical rating", () => {
  it("reads all twenty-six indicators once there are candles enough", () => {
    const { ma, osc } = techBreakdown(run(Array.from({ length: 300 }, (_, i) => 100 + i)));
    expect(Object.keys(ma)).toHaveLength(15);
    expect(Object.keys(osc)).toHaveLength(11);
  });

  it("leaves out what it can't read yet, rather than calling it neutral", () => {
    const { ma } = techBreakdown(run(Array.from({ length: 60 }, (_, i) => 100 + i)));
    expect(ma.sma50).toBe(1);
    expect(ma.sma100).toBeUndefined();
    expect(ma.ema200).toBeUndefined();
  });

  it("votes an average below the price a buy, above it a sell", () => {
    const up = techBreakdown(run(Array.from({ length: 250 }, (_, i) => 100 + i)));
    const down = techBreakdown(run(Array.from({ length: 250 }, (_, i) => 400 - i)));
    for (const key of ["sma10", "ema50", "sma200", "vwma20"] as const) {
      expect(up.ma[key]).toBe(1);
      expect(down.ma[key]).toBe(-1);
    }
    // The Hull average has no lag on a straight line: it sits on the price.
    expect(up.ma.hma9).toBe(0);
    // A steady rise is overbought: the ultimate oscillator reads it a buy (over 70).
    expect(up.osc.uo).toBe(1);
  });

  it("scores each group and the summary as their mean", () => {
    const s = techScores(techBreakdown(run(Array.from({ length: 250 }, (_, i) => 100 + i))));
    // Thirteen buys; Ichimoku (no cross) and the Hull average (on the price) neutral.
    expect(s?.ma).toBeCloseTo(13 / 15);
    expect(s?.all).toBeCloseTo(((s?.ma ?? 0) + (s?.osc ?? 0)) / 2);
    expect(techScores({ ma: {}, osc: {} })).toBeUndefined();
  });
});
