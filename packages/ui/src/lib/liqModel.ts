// An estimate of where positions would be liquidated, after coinglass's
// liquidation heatmap model: each hour's new open interest is assumed opened
// at that hour's price, half long and half short, across typical leverages;
// each lot's liquidation price follows from its leverage. Levels the price
// has since reached are taken off (those positions are gone), and a fall in
// open interest shrinks every level alike. It's a model, not data: no venue
// publishes where its positions would be liquidated.

import type { Candle, OpenInterestPoint } from "@pewterdesk/core";

/** The leverages assumed, and the share of new positions at each. */
export const LEVERAGE_MIX: readonly { leverage: number; share: number }[] = [
  { leverage: 10, share: 0.35 },
  { leverage: 25, share: 0.3 },
  { leverage: 50, share: 0.2 },
  { leverage: 100, share: 0.15 },
];
/** Maintenance margin, as a share of the position: liquidation comes this much early. */
const MAINTENANCE = 0.005;

export interface LiqMap {
  /** Each column's hour (ms), oldest first. */
  times: number[];
  /** The price at each row's centre, lowest first. */
  prices: number[];
  /** Estimated notional (quote asset) waiting to be liquidated, `[column][row]`. */
  cells: Float64Array[];
  /** The largest cell, for scaling the colours. */
  max: number;
  /** Each column's candle, for drawing the price over the levels. */
  candles: { open: number; high: number; low: number; close: number }[];
}

/**
 * An open-interest history for a venue that publishes none: today's open
 * interest (base units) spread back over the candles in proportion to each
 * hour's traded volume, as if positions were opened as the market traded.
 * Always rising, so the model only ever adds positions and lets the price
 * clear them.
 */
export function openInterestFromVolume(
  candles: readonly Candle[],
  openInterestNow: number,
): OpenInterestPoint[] {
  const volumes = candles.map((c) => Math.max(Number(c.volume), 0));
  const total = volumes.reduce((a, b) => a + b, 0);
  if (!(total > 0) || !(openInterestNow > 0)) return [];
  let seen = 0;
  // One point before the first candle, so the first hour counts as new too.
  const points: OpenInterestPoint[] = [
    { time: (candles[0]?.openTime ?? 0) - 3_600_000, openInterest: "0" },
  ];
  candles.forEach((c, i) => {
    seen += volumes[i] ?? 0;
    points.push({ time: c.openTime, openInterest: String((openInterestNow * seen) / total) });
  });
  return points;
}

/** Long and short liquidation prices for a position opened at `price` with `leverage`. */
export function liquidationPrices(
  price: number,
  leverage: number,
): { long: number; short: number } {
  return {
    long: price * (1 - 1 / leverage + MAINTENANCE),
    short: price * (1 + 1 / leverage - MAINTENANCE),
  };
}

/**
 * The heatmap from hourly `candles` and hourly `openInterest` (base units),
 * both oldest first, on `rows` price rows spanning the candles' range plus
 * a margin.
 */
export function liquidationMap(
  candles: readonly Candle[],
  openInterest: readonly OpenInterestPoint[],
  rows = 140,
): LiqMap | undefined {
  if (candles.length < 2 || openInterest.length < 2) return undefined;
  const lows = candles.map((c) => Number(c.low));
  const highs = candles.map((c) => Number(c.high));
  const lo = Math.min(...lows) * 0.9;
  const hi = Math.max(...highs) * 1.1;
  if (!(hi > lo) || !(lo > 0)) return undefined;
  const step = (hi - lo) / rows;
  const rowOf = (price: number) => Math.min(Math.max(Math.floor((price - lo) / step), 0), rows - 1);
  const prices = Array.from({ length: rows }, (_, i) => lo + (i + 0.5) * step);

  // Open interest at or before each candle.
  const oiAt = (time: number) => {
    let found: number | undefined;
    for (const p of openInterest) {
      if (p.time <= time) found = Number(p.openInterest);
      else break;
    }
    return found;
  };

  const longs = new Float64Array(rows);
  const shorts = new Float64Array(rows);
  const cells: Float64Array[] = [];
  let max = 0;
  let prevOi: number | undefined;
  for (const c of candles) {
    const close = Number(c.close);
    const low = Number(c.low);
    const high = Number(c.high);
    const oi = oiAt(c.openTime + 3_600_000 - 1) ?? oiAt(c.openTime);
    if (oi !== undefined && prevOi !== undefined && prevOi > 0) {
      const delta = oi - prevOi;
      if (delta > 0) {
        const typical = (high + low + close) / 3;
        const notional = delta * typical;
        for (const { leverage, share } of LEVERAGE_MIX) {
          const at = liquidationPrices(typical, leverage);
          longs[rowOf(at.long)] = (longs[rowOf(at.long)] ?? 0) + (notional * share) / 2;
          shorts[rowOf(at.short)] = (shorts[rowOf(at.short)] ?? 0) + (notional * share) / 2;
        }
      } else if (delta < 0) {
        const keep = oi / prevOi;
        for (let r = 0; r < rows; r++) {
          longs[r] = (longs[r] ?? 0) * keep;
          shorts[r] = (shorts[r] ?? 0) * keep;
        }
      }
    }
    if (oi !== undefined) prevOi = oi;
    // The hour's range reached these levels: those positions are gone.
    for (let r = 0; r < rows; r++) {
      const price = prices[r] ?? 0;
      if (price >= low) longs[r] = 0;
      if (price <= high) shorts[r] = 0;
    }
    const column = new Float64Array(rows);
    for (let r = 0; r < rows; r++) {
      column[r] = (longs[r] ?? 0) + (shorts[r] ?? 0);
      if ((column[r] ?? 0) > max) max = column[r] ?? 0;
    }
    cells.push(column);
  }
  return {
    times: candles.map((c) => c.openTime),
    prices,
    cells,
    max,
    candles: candles.map((c) => ({
      open: Number(c.open),
      high: Number(c.high),
      low: Number(c.low),
      close: Number(c.close),
    })),
  };
}
