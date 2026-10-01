import type { Decimal } from "@pewterdesk/core";
import { decimalsOf } from "./format";
import type { TicketSide } from "./ticket";

// The order ticket's calculator, after the exchanges' usual one: PnL for a
// trade, the price that hits a target ROI, the liquidation price at a
// leverage, and the most a balance can open. Display maths only; nothing
// here is sent to a venue.

const direction = (side: TicketSide) => (side === "buy" ? 1 : -1);

/** Rounds down to a whole number of steps, and formats to the step's decimals. */
export function roundToStep(value: number, step: Decimal): { size: number; text: string } {
  const s = Number(step);
  const dp = decimalsOf(step);
  if (!(s > 0) || !(value > 0)) return { size: 0, text: (0).toFixed(dp) };
  // A hair of tolerance so 0.3 / 0.1 counts as 3 steps, not 2.999...
  const steps = Math.floor(value / s + 1e-9);
  const text = (steps * s).toFixed(dp);
  return { size: Number(text), text };
}

export interface PnlResult {
  /** Margin to open: the position's value over the leverage. */
  margin: number;
  /** Before fees. */
  pnl: number;
  /** PnL over the margin, as a fraction. */
  roi: number;
  /** Taker fee on opening and on closing. */
  fees: number;
}

/** What a trade from `entry` to `exit` makes or loses; unset until the inputs make sense. */
export function tradePnl(
  side: TicketSide,
  leverage: number,
  entry: number,
  exit: number,
  size: number,
  takerFee = 0,
): PnlResult | undefined {
  if (!(leverage > 0) || !(entry > 0) || !(exit > 0) || !(size > 0)) return undefined;
  const margin = (size * entry) / leverage;
  const pnl = (exit - entry) * size * direction(side);
  return { margin, pnl, roi: pnl / margin, fees: Math.max(0, takerFee) * size * (entry + exit) };
}

/** The exit price that returns `roiPercent` on the margin, before fees. */
export function targetPrice(
  side: TicketSide,
  leverage: number,
  entry: number,
  roiPercent: number,
): number | undefined {
  if (!(leverage > 0) || !(entry > 0) || !Number.isFinite(roiPercent)) return undefined;
  const price = entry * (1 + (direction(side) * roiPercent) / 100 / leverage);
  return price > 0 ? price : undefined;
}

/**
 * Where an isolated position at `leverage` gets liquidated: when its loss
 * eats the margin down to the maintenance margin. That's taken as half the
 * initial margin at the market's maximum leverage (how Hyperliquid sets
 * it); venues with tiered margin differ, so it's an estimate.
 */
export function liquidationPrice(
  side: TicketSide,
  leverage: number,
  entry: number,
  maxLeverage: number,
): number | undefined {
  if (!(leverage > 0) || !(entry > 0) || !(maxLeverage > 0)) return undefined;
  const maintenance = 1 / (2 * maxLeverage);
  const price = entry * (1 - direction(side) * (1 / leverage - maintenance));
  return price > 0 ? price : undefined;
}

/**
 * The largest size `balance` opens at `leverage`, leaving room for the
 * opening fee, rounded down to the size step.
 */
export function maxOpen(
  balance: number,
  leverage: number,
  entry: number,
  sizeStep: Decimal,
  takerFee = 0,
): { size: number; text: string; value: number } | undefined {
  if (!(balance > 0) || !(leverage > 0) || !(entry > 0)) return undefined;
  const raw = (balance * leverage) / (entry * (1 + leverage * Math.max(0, takerFee)));
  const { size, text } = roundToStep(raw, sizeStep);
  return { size, text, value: size * entry };
}
