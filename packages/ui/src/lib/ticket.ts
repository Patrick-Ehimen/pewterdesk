import type { Position } from "@pewterdesk/core";

export type TicketSide = "buy" | "sell";
/** The order types behind the ticket's Pro menu. */
export type ProType = "scale" | "stopLimit" | "stopMarket" | "takeLimit" | "takeMarket" | "twap";
export const PRO_TYPES: readonly ProType[] = [
  "scale",
  "stopLimit",
  "stopMarket",
  "takeLimit",
  "takeMarket",
  "twap",
];
export type TicketType = "market" | "limit" | ProType;

/** Order types priced at a limit the user enters. */
export const hasLimitPrice = (type: TicketType) =>
  type === "limit" || type === "stopLimit" || type === "takeLimit";
/** Order types that wait for a trigger price. */
export const hasTrigger = (type: TicketType) =>
  type === "stopLimit" || type === "stopMarket" || type === "takeLimit" || type === "takeMarket";

export interface Fill {
  /** Volume-weighted price across the levels taken. */
  avgPrice: number;
  /** False if the levels given run out before `size` is filled. */
  complete: boolean;
}

/**
 * Fills `size` base units against book levels, best first (asks for a buy,
 * bids for a sell). Undefined for no size or an empty book.
 */
export function marketFill(
  levels: readonly { price: number; size: number }[],
  size: number,
): Fill | undefined {
  if (!(size > 0) || levels.length === 0) return undefined;
  let left = size;
  let cost = 0;
  for (const level of levels) {
    const take = Math.min(left, level.size);
    cost += take * level.price;
    left -= take;
    if (left <= 0) break;
  }
  const filled = size - Math.max(left, 0);
  return filled > 0 ? { avgPrice: cost / filled, complete: left <= 1e-12 } : undefined;
}

/** How far a fill's average is from the best price, as a fraction. */
export const slippageOf = (avgPrice: number, best: number) =>
  best > 0 ? Math.abs(avgPrice - best) / best : 0;

/** The size, in base units, that `percent` of available margin buys at `leverage`. */
export function sizeFromPercent(
  percent: number,
  available: number,
  leverage: number,
  price: number,
): number {
  return price > 0 ? (available * leverage * percent) / 100 / price : 0;
}

/** An open position's leverage: its notional over the margin backing it, rounded. */
export function positionLeverage(position: Position): number | undefined {
  const margin = Number(position.margin);
  const notional = Number(position.size) * Number(position.markPrice);
  return margin > 0 && notional > 0 ? Math.max(1, Math.round(notional / margin)) : undefined;
}
