import type { Market, OrderKind, OrderRequest, Position } from "@pewterdesk/core";

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

/** Why the ticket can't send what's filled in, for the button to say. */
export type TicketBlock = "size" | "price" | "trigger" | "type" | "tpsl";

/** The widest slippage bound a market order carries (10%, as venues allow). */
const MAX_SLIPPAGE_BPS = 1000;

/** Decimal places in a step like "0.001". */
const placesOf = (step: string) => (step.includes(".") ? (step.split(".")[1] ?? "").length : 0);

/** A positive price as typed, or undefined. */
const priceOf = (text: string) => {
  const trimmed = text.trim();
  return Number(trimmed) > 0 ? trimmed : undefined;
};

/**
 * The order the ticket describes, or why it can't be sent. The size is cut
 * down to the market's step (never rounded up past what was asked); prices
 * go as typed, for the venue to check against its tick. Scale and TWAP
 * orders, and TP/SL attached to an order, have no venue form yet.
 */
export function ticketOrder(input: {
  market: Pick<Market, "id" | "sizeStep">;
  type: TicketType;
  side: TicketSide;
  /** In base units, as the ticket worked it out. */
  sizeBase: number;
  limitPrice: string;
  trigger: string;
  reduceOnly: boolean;
  tpsl: boolean;
  /** A market order's bound, as a fraction (0.05 is 5%). */
  maxSlippage: number;
}): { request: OrderRequest } | { blocked: TicketBlock } {
  if (input.type === "scale" || input.type === "twap") return { blocked: "type" };
  if (input.tpsl) return { blocked: "tpsl" };
  const step = Number(input.market.sizeStep);
  const steps = step > 0 ? Math.floor(input.sizeBase / step + 1e-9) : 0;
  if (!(steps > 0)) return { blocked: "size" };
  const size = (steps * step).toFixed(placesOf(input.market.sizeStep));

  let kind: OrderKind;
  if (input.type === "market") {
    const bps = Math.round(input.maxSlippage * 10_000);
    kind = { type: "market", maxSlippageBps: Math.min(MAX_SLIPPAGE_BPS, Math.max(1, bps)) };
  } else if (input.type === "limit") {
    const price = priceOf(input.limitPrice);
    if (!price) return { blocked: "price" };
    kind = { type: "limit", price };
  } else {
    const triggerPrice = priceOf(input.trigger);
    if (!triggerPrice) return { blocked: "trigger" };
    if (hasLimitPrice(input.type)) {
      const limitPrice = priceOf(input.limitPrice);
      if (!limitPrice) return { blocked: "price" };
      kind = { type: "trigger", triggerPrice, limitPrice };
    } else {
      kind = { type: "trigger", triggerPrice };
    }
  }
  return {
    request: {
      market: input.market.id,
      side: input.side,
      size,
      reduceOnly: input.reduceOnly,
      ...kind,
    },
  };
}
