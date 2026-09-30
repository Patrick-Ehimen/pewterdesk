import { describe, expect, it } from "vitest";
import {
  ALL_INTERVALS,
  bollinger,
  ema,
  heikinAshi,
  macd,
  rsi,
  sma,
  vwap,
} from "../src/lib/indicators";

const close = (xs: (number | undefined)[]) => xs.map((x) => (x === undefined ? x : +x.toFixed(4)));

describe("indicators", () => {
  it("averages the last n values", () => {
    expect(sma([1, 2, 3, 4, 5], 3)).toEqual([undefined, undefined, 2, 3, 4]);
  });

  it("seeds the EMA with the simple average, then weights recent values", () => {
    // k = 2 / (3 + 1) = 0.5
    expect(ema([1, 2, 3, 4, 5], 3)).toEqual([undefined, undefined, 2, 3, 4]);
    expect(close(ema([2, 4, 6, 10], 2))).toEqual([undefined, 3, 5, 8.3333]);
    // Leading gaps (another indicator warming up) are skipped.
    expect(ema([undefined, 1, 2, 3], 2)).toEqual([undefined, undefined, 1.5, 2.5]);
  });

  it("puts Bollinger Bands mult standard deviations either side", () => {
    const [, , band] = bollinger([2, 4, 6], 3, 2);
    // mean 4, population sd sqrt(8/3)
    expect(band?.middle).toBe(4);
    expect(band?.upper).toBeCloseTo(4 + 2 * Math.sqrt(8 / 3));
    expect(band?.lower).toBeCloseTo(4 - 2 * Math.sqrt(8 / 3));
  });

  it("computes RSI with Wilder smoothing", () => {
    // Only rises: 100. Only falls: 0. Flat: 50.
    expect(rsi([1, 2, 3, 4], 3).at(-1)).toBe(100);
    expect(rsi([4, 3, 2, 1], 3).at(-1)).toBe(0);
    expect(rsi([1, 1, 1, 1], 3).at(-1)).toBe(50);
    const r = rsi([1, 2, 3, 2, 3], 2);
    // First at index 2: gains 1,1 → avg gain 1, loss 0 → 100; then a fall of 1:
    // gain (1*1+0)/2 = 0.5, loss (0+1)/2 = 0.5 → 50.
    expect(r.slice(0, 4)).toEqual([undefined, undefined, 100, 50]);
    expect(rsi([1, 2], 3)).toEqual([undefined, undefined]);
  });

  it("builds MACD from two EMAs and a signal line", () => {
    const values = Array.from({ length: 40 }, (_, i) => i);
    const out = macd(values, 3, 6, 3);
    // A straight line: the EMAs lag by a fixed amount, so MACD settles and the
    // histogram goes to zero.
    const last = out.at(-1);
    expect(last?.macd).toBeCloseTo(1.5);
    expect(last?.signal).toBeCloseTo(1.5);
    expect(last?.histogram).toBeCloseTo(0);
    expect(out[4]?.macd).toBeUndefined();
  });

  it("restarts VWAP each UTC day", () => {
    const day = 86_400_000;
    const out = vwap([
      { openTime: 0, high: 12, low: 8, close: 10, volume: 1 },
      { openTime: 3_600_000, high: 22, low: 18, close: 20, volume: 3 },
      { openTime: day, high: 6, low: 4, close: 5, volume: 2 },
    ]);
    expect(out[0]).toBe(10);
    expect(out[1]).toBe((10 * 1 + 20 * 3) / 4);
    expect(out[2]).toBe(5);
  });

  it("smooths candles into Heikin-Ashi", () => {
    const [a, b] = heikinAshi([
      { open: 10, high: 12, low: 9, close: 11 },
      { open: 11, high: 13, low: 10, close: 12 },
    ]);
    expect(a).toEqual({ open: 10.5, high: 12, low: 9, close: 10.5 });
    expect(b?.open).toBe(10.5);
    expect(b?.close).toBe(11.5);
    expect(b?.high).toBe(13);
    expect(b?.low).toBe(10);
  });

  it("offers every interval the venues serve, in order", () => {
    expect(ALL_INTERVALS).toEqual([
      "1m",
      "3m",
      "5m",
      "15m",
      "30m",
      "1h",
      "2h",
      "4h",
      "8h",
      "12h",
      "1d",
      "3d",
      "1w",
    ]);
  });
});
