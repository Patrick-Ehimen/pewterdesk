import type { Market, OrderRequest, Position } from "@pewterdesk/core";

/**
 * A position this close to its liquidation price sets off the warning (the
 * toast, the desktop notification and the widget's alert): 2% of the mark.
 */
export const RISK_WITHIN = 0.02;
/**
 * Once warned, a position must move back out past this before it can warn
 * again, so one hovering at the threshold doesn't keep setting it off.
 */
export const RISK_CLEAR = 0.03;
/** How long Buy, Sell and the closing buttons must be held before they act. */
export const HOLD_MS = 400;

/** A position's key in the widget: its market and side. */
export const positionKey = (p: Pick<Position, "market" | "side">) => `${p.market}:${p.side}`;

/**
 * How far the mark is from the liquidation price, as a fraction of the mark;
 * undefined where the venue gives no liquidation price.
 */
export function liquidationDistance(position: Position): number | undefined {
  const mark = Number(position.markPrice);
  const liq = Number(position.liquidationPrice);
  if (!position.liquidationPrice || !(mark > 0) || !(liq > 0)) return undefined;
  return Math.abs(mark - liq) / mark;
}

/**
 * The position nearest its liquidation price, if that's within
 * `RISK_WITHIN` and its alert isn't snoozed.
 */
export function riskiest(
  positions: readonly Position[],
  snoozedUntil: Readonly<Record<string, number>>,
  now: number,
): { position: Position; distance: number } | undefined {
  let worst: { position: Position; distance: number } | undefined;
  for (const position of positions) {
    const distance = liquidationDistance(position);
    if (distance === undefined || distance > RISK_WITHIN) continue;
    if ((snoozedUntil[positionKey(position)] ?? 0) > now) continue;
    if (!worst || distance < worst.distance) worst = { position, distance };
  }
  return worst;
}

/**
 * The reduce-only market order that closes `fraction` of `position` (1 for
 * all of it): the other side, cut down to the market's size step. A part
 * smaller than the market's minimum closes the whole position instead, so
 * the order isn't refused.
 */
export function closeRequest(
  position: Position,
  market: Pick<Market, "sizeStep" | "minSize"> | undefined,
  fraction: number,
  maxSlippageBps: number,
): OrderRequest {
  const whole = position.size;
  let size = whole;
  const step = Number(market?.sizeStep);
  if (fraction < 1 && market && step > 0) {
    const places = market.sizeStep.includes(".") ? (market.sizeStep.split(".")[1] ?? "").length : 0;
    const part = Math.floor((Number(whole) * fraction) / step + 1e-9) * step;
    if (part >= Number(market.minSize) && part > 0) size = part.toFixed(places);
  }
  return {
    market: position.market,
    side: position.side === "long" ? "sell" : "buy",
    size,
    reduceOnly: true,
    type: "market",
    maxSlippageBps,
  };
}

/** The slippage bound a venue's fraction (0.05) comes to in basis points. */
export const slippageBps = (maxSlippage: number) =>
  Math.min(1000, Math.max(1, Math.round(maxSlippage * 10_000)));
