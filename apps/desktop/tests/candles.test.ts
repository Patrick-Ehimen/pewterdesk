import type { Candle } from "@pewterdesk/core";
import { describe, expect, it } from "vitest";
import { joinNewestPage, MAX_CANDLES, mergeCandles, prependCandles } from "../src/lib/candles";

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

describe("joinNewestPage", () => {
  const span = 1;
  const at = (t: number[]) => t.map((openTime) => candle(openTime, "1"));
  const times = (series: Candle[]) => series.map((c) => c.openTime);

  it("keeps what's older than the page, the page winning the overlap", () => {
    const joined = joinNewestPage(at([1, 2, 3]), [candle(3, "9"), candle(4, "9")], span);
    expect(times(joined)).toEqual([1, 2, 3, 4]);
    expect(joined[2]?.close).toBe("9");
  });

  it("takes a page reaching further back than the series", () => {
    expect(times(joinNewestPage(at([4, 5]), at([1, 2, 3, 4]), span))).toEqual([1, 2, 3, 4, 5]);
  });

  it("joins a page that starts on the next candle", () => {
    expect(times(joinNewestPage(at([1, 2]), at([3, 4]), span))).toEqual([1, 2, 3, 4]);
  });

  it("replaces the series with a page that doesn't meet it", () => {
    expect(times(joinNewestPage(at([1, 2]), at([9, 10]), span))).toEqual([9, 10]);
  });

  it("changes nothing for an empty page", () => {
    expect(times(joinNewestPage(at([1, 2]), [], span))).toEqual([1, 2]);
  });

  it("keeps at most MAX_CANDLES, dropping the oldest", () => {
    const long = Array.from({ length: MAX_CANDLES }, (_, i) => candle(i, "1"));
    const joined = joinNewestPage(long, [candle(MAX_CANDLES, "1")], span);
    expect(joined).toHaveLength(MAX_CANDLES);
    expect(joined.at(-1)?.openTime).toBe(MAX_CANDLES);
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
