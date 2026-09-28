import type { Candle } from "@pewterdesk/core";
import { describe, expect, it } from "vitest";
import { MAX_CANDLES, mergeCandles, prependCandles } from "../src/lib/candles";

const candle = (openTime: number, close = "1"): Candle => ({
  openTime,
  open: "1",
  high: "2",
  low: "0.5",
  close,
  volume: "10",
});

describe("mergeCandles", () => {
  const series = [candle(0), candle(60), candle(120, "1.5")];

  it("replaces the forming candle", () => {
    const merged = mergeCandles(series, [candle(120, "1.7")]);
    expect(merged).toHaveLength(3);
    expect(merged.at(-1)?.close).toBe("1.7");
  });

  it("appends a new candle", () => {
    expect(mergeCandles(series, [candle(180)]).map((c) => c.openTime)).toEqual([0, 60, 120, 180]);
  });

  it("slots a late replay over its match, and drops one it can't place", () => {
    expect(mergeCandles(series, [candle(60, "9")])[1]?.close).toBe("9");
    expect(mergeCandles(series, [candle(30)])).toHaveLength(3);
  });

  it("doesn't mutate the series it was given", () => {
    mergeCandles(series, [candle(120, "3"), candle(180)]);
    expect(series).toHaveLength(3);
    expect(series.at(-1)?.close).toBe("1.5");
  });

  it("keeps at most MAX_CANDLES, dropping the oldest", () => {
    const full = Array.from({ length: MAX_CANDLES }, (_, i) => candle(i));
    const merged = mergeCandles(full, [candle(MAX_CANDLES)]);
    expect(merged).toHaveLength(MAX_CANDLES);
    expect(merged[0]?.openTime).toBe(1);
  });
});

describe("prependCandles", () => {
  const series = [candle(300), candle(360), candle(420)];

  it("joins older candles on the left and counts them", () => {
    const { series: joined, added } = prependCandles(series, [candle(180), candle(240)]);
    expect(joined.map((c) => c.openTime)).toEqual([180, 240, 300, 360, 420]);
    expect(added).toBe(2);
  });

  it("ignores any overlap with what's already there", () => {
    const { series: joined, added } = prependCandles(series, [candle(240), candle(300, "9")]);
    expect(joined.map((c) => c.openTime)).toEqual([240, 300, 360, 420]);
    // The series keeps its own 300, not the page's.
    expect(joined[1]?.close).toBe("1");
    expect(added).toBe(1);
  });

  it("adds nothing once the venue has nothing older", () => {
    expect(prependCandles(series, []).added).toBe(0);
    expect(prependCandles(series, [candle(360)]).added).toBe(0);
  });
});
