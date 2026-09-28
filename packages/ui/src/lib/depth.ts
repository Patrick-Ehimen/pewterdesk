import type { BookLevel, OrderBook } from "@pewterdesk/core";

// Display-only arithmetic over an order book. "Notional" is price × size in
// the quote asset; sizes are in base units.

export interface DepthLevel {
  price: number;
  /** Base units resting at this level. */
  size: number;
  /** price × size. */
  notional: number;
  /** Base units from the best price out to this level, inclusive. */
  cumSize: number;
  /** Notional from the best price out to this level, inclusive. */
  cumulative: number;
  /** At least WALL_FACTOR × the side's median level (by notional). */
  wall: boolean;
}

/** A level this many times the side's median notional counts as a wall. */
export const WALL_FACTOR = 3;

const median = (values: number[]) => {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? (sorted[mid] ?? 0) : ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2;
};

/** Each side's levels from the best price out, with running totals and walls. */
export function depthLevels(book: OrderBook): { bids: DepthLevel[]; asks: DepthLevel[] } {
  const side = (levels: BookLevel[]): DepthLevel[] => {
    const typical = median(levels.map((l) => Number(l.price) * Number(l.size)));
    let cumSize = 0;
    let cumulative = 0;
    return levels.map((l) => {
      const price = Number(l.price);
      const size = Number(l.size);
      const notional = price * size;
      cumSize += size;
      cumulative += notional;
      return {
        price,
        size,
        notional,
        cumSize,
        cumulative,
        wall: typical > 0 && notional >= WALL_FACTOR * typical,
      };
    });
  };
  return { bids: side(book.bids), asks: side(book.asks) };
}

/** Notional within `band` (a fraction) of `mid` on one side. */
export function depthWithin(levels: DepthLevel[], mid: number, band: number): number {
  return levels
    .filter((l) => Math.abs(l.price - mid) <= mid * band)
    .reduce((sum, l) => sum + l.notional, 0);
}

/** Average price from the best level out to (and including) `level` on its side. */
export function avgFillTo(level: DepthLevel): number {
  return level.cumSize > 0 ? level.cumulative / level.cumSize : level.price;
}

export interface Imbalance {
  /** Bid notional over bid + ask notional within the range, 0–1. */
  bidShare: number;
  bids: number;
  asks: number;
}

/** How bid and ask notional compare within `range` (a fraction) of the mid. */
export function imbalance(
  bids: DepthLevel[],
  asks: DepthLevel[],
  mid: number,
  range: number,
): Imbalance {
  const b = depthWithin(bids, mid, range);
  const a = depthWithin(asks, mid, range);
  return { bids: b, asks: a, bidShare: b + a > 0 ? b / (b + a) : 0.5 };
}

export interface Wall {
  side: "bid" | "ask";
  price: number;
  size: number;
  /** Signed distance from the mid, as a fraction. */
  fromMid: number;
}

/** The `count` biggest levels across both sides, by size. */
export function largestWalls(
  bids: DepthLevel[],
  asks: DepthLevel[],
  mid: number,
  count = 3,
): Wall[] {
  return [
    ...bids.map((l) => ({ side: "bid" as const, l })),
    ...asks.map((l) => ({ side: "ask" as const, l })),
  ]
    .sort((a, b) => b.l.size - a.l.size)
    .slice(0, count)
    .map(({ side, l }) => ({ side, price: l.price, size: l.size, fromMid: (l.price - mid) / mid }));
}
