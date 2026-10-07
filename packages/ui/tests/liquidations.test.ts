import { describe, expect, it } from "vitest";
import { liquidationMap, liquidationPrices, openInterestFromVolume } from "../src/lib/liqModel";
import { liqByMarket, liqTotals, mergeLiquidations } from "../src/lib/liquidations";

const H = 3_600_000;
const liq = (
  market: string,
  side: "long" | "short",
  price: string,
  size: string,
  time: number,
) => ({ market, side, price, size, time });

describe("liquidation feed", () => {
  it("keeps the last day, newest first, and sums windows", () => {
    const now = 100 * H;
    let kept = mergeLiquidations([], [liq("BTC", "long", "100", "2", now - 30 * H)], now);
    expect(kept).toHaveLength(0);
    kept = mergeLiquidations(
      kept,
      [liq("BTC", "long", "100", "2", now - 2 * H), liq("ETH", "short", "10", "5", now - 1000)],
      now,
    );
    expect(kept.map((e) => e.market)).toEqual(["ETH", "BTC"]);
    expect(liqTotals(kept, now, H)).toEqual({ total: 50, long: 0, short: 50, count: 1 });
    expect(liqTotals(kept, now, 4 * H)).toEqual({ total: 250, long: 200, short: 50, count: 2 });
    expect(liqByMarket(kept, now, 4 * H)[0]).toEqual({
      market: "BTC",
      long: 200,
      short: 0,
      total: 200,
    });
  });
});

describe("liquidation model", () => {
  const candle = (i: number, price: number, spread = 0.002) => ({
    openTime: i * H,
    open: String(price),
    high: String(price * (1 + spread)),
    low: String(price * (1 - spread)),
    close: String(price),
    volume: "1",
  });

  it("puts liquidation levels below for longs and above for shorts", () => {
    const { long, short } = liquidationPrices(100, 10);
    expect(long).toBeCloseTo(90.5, 6);
    expect(short).toBeCloseTo(109.5, 6);
  });

  it("builds levels from rising open interest and clears those price reached", () => {
    const candles = [candle(0, 100), candle(1, 100), candle(2, 100), candle(3, 89)];
    // No new positions in the last hour, so nothing is added as it falls.
    const oi = [1000, 1500, 2000, 2000].map((v, i) => ({ time: i * H, openInterest: String(v) }));
    const map = liquidationMap(candles, oi, 200);
    expect(map).toBeDefined();
    if (!map) return;
    const sum = (col: Float64Array, test: (p: number) => boolean) =>
      map.prices.reduce((s, p, r) => (test(p) ? s + (col[r] ?? 0) : s), 0);
    const before = map.cells[2] as Float64Array;
    expect(sum(before, (p) => p < 100)).toBeGreaterThan(0);
    expect(sum(before, (p) => p > 100)).toBeGreaterThan(0);
    // The drop to 89 took out the longs' 10x level (about 90.5) and above.
    const after = map.cells[3] as Float64Array;
    expect(sum(after, (p) => p > 89.5 && p < 100)).toBe(0);
    expect(map.max).toBeGreaterThan(0);
  });

  it("spreads today's open interest back over the candles by volume", () => {
    const candles = [candle(0, 100), candle(1, 100), candle(2, 100)].map((c, i) => ({
      ...c,
      volume: String([1, 3, 0][i]),
    }));
    const points = openInterestFromVolume(candles, 800);
    expect(points.map((p) => Number(p.openInterest))).toEqual([0, 200, 800, 800]);
    expect(points[0]?.time).toBeLessThan(candles[0]?.openTime ?? 0);
    expect(liquidationMap(candles, points)?.max).toBeGreaterThan(0);
    expect(openInterestFromVolume(candles, 0)).toEqual([]);
  });

  it("needs history to draw anything", () => {
    expect(liquidationMap([], [])).toBeUndefined();
  });
});
