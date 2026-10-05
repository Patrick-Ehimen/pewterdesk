import type { Market, Position } from "@pewterdesk/core";
import { hasLimitPrice, hasTrigger, type TicketSide, type TicketType } from "./ticket";

/** How far through the book a limit price is before the ticket warns: 0.5%. */
const FAR_THROUGH = 0.005;
/** Slack for float sums when testing a multiple of a step. */
const GRID_SLACK = 1e-6;

/** What a check found: an `error` blocks the order, a `warn` only says so. */
export type TicketCheck =
  | { field: "price" | "trigger" | "tp" | "sl"; level: "error"; code: "tick"; tick: string }
  /** A take-profit that isn't beyond the order's price, or a stop-loss that isn't behind it. */
  | { field: "tp" | "sl"; level: "error"; code: "exitSide" }
  | {
      field: "price";
      level: "warn";
      code: "crosses";
      /** How far past the mid, as a fraction. */
      past: number;
      mid: number;
    }
  | { field: "size"; level: "error"; code: "minSize"; min: string }
  | { field: "size"; level: "warn"; code: "step"; step: string; sends: number }
  | {
      field: "size";
      // An estimate (no fees, and the venue's own margin rules), so it
      // warns rather than blocks: the venue has the last word.
      level: "warn";
      code: "margin";
      need: number;
      have: number;
      /** The largest size the available margin covers at this price, in base units. */
      max: number;
    };

const onGrid = (value: number, step: number) =>
  !(step > 0) || Math.abs(value / step - Math.round(value / step)) < GRID_SLACK;

/**
 * What's wrong with the ticket as filled in, before it's sent: prices off
 * the market's tick, a limit priced far through the book (it would fill at
 * once), a size under the minimum or off the step, and more margin than the
 * account has. The venue still has the last word; these catch what it would
 * refuse, and say how to fix it.
 */
export function ticketChecks(input: {
  market: Pick<Market, "tickSize" | "sizeStep" | "minSize">;
  type: TicketType;
  side: TicketSide;
  /** In base units, as the ticket worked it out. */
  sizeBase: number;
  limitPrice: string;
  trigger: string;
  reduceOnly: boolean;
  bestBid: number;
  bestAsk: number;
  /** The price the order is valued at. */
  price: number;
  /** A take-profit and stop-loss going with the order, as typed; empty for none. */
  takeProfit?: string;
  stopLoss?: string;
  /** Unset until an account is connected: no margin check then. */
  available?: number;
  leverage: number;
  position?: Pick<Position, "side" | "size">;
}): TicketCheck[] {
  const { market, type, side, sizeBase } = input;
  const checks: TicketCheck[] = [];
  const tick = Number(market.tickSize);

  const limit = Number(input.limitPrice);
  if (hasLimitPrice(type) && limit > 0) {
    if (!onGrid(limit, tick)) {
      checks.push({ field: "price", level: "error", code: "tick", tick: market.tickSize });
    } else if (type === "limit") {
      const mid = (input.bestBid + input.bestAsk) / 2;
      const through =
        side === "buy"
          ? input.bestAsk > 0 && limit >= input.bestAsk * (1 + FAR_THROUGH)
          : input.bestBid > 0 && limit <= input.bestBid * (1 - FAR_THROUGH);
      if (through && mid > 0) {
        checks.push({
          field: "price",
          level: "warn",
          code: "crosses",
          past: Math.abs(limit - mid) / mid,
          mid,
        });
      }
    }
  }
  const trigger = Number(input.trigger);
  if (hasTrigger(type) && trigger > 0 && !onGrid(trigger, tick)) {
    checks.push({ field: "trigger", level: "error", code: "tick", tick: market.tickSize });
  }

  // Exits: on the tick, and each on its own side of the price the order goes
  // in at (its limit, its trigger, or the touch), as the venue will insist.
  const entry =
    hasLimitPrice(type) && limit > 0
      ? limit
      : hasTrigger(type) && trigger > 0
        ? trigger
        : side === "buy"
          ? input.bestAsk
          : input.bestBid;
  for (const [field, text] of [
    ["tp", input.takeProfit],
    ["sl", input.stopLoss],
  ] as const) {
    const exit = Number(text);
    if (!(exit > 0)) continue;
    if (!onGrid(exit, tick)) {
      checks.push({ field, level: "error", code: "tick", tick: market.tickSize });
    } else if (entry > 0) {
      // A take-profit on a buy and a stop-loss on a sell sit above the price.
      const above = (field === "tp") === (side === "buy");
      if (above ? exit <= entry : exit >= entry) {
        checks.push({ field, level: "error", code: "exitSide" });
      }
    }
  }

  if (!(sizeBase > 0)) return checks;
  const step = Number(market.sizeStep);
  const sends = step > 0 ? Math.floor(sizeBase / step + GRID_SLACK) * step : sizeBase;
  if (sends < Number(market.minSize) - GRID_SLACK * step) {
    checks.push({ field: "size", level: "error", code: "minSize", min: market.minSize });
    return checks;
  }
  if (!onGrid(sizeBase, step)) {
    checks.push({ field: "size", level: "warn", code: "step", step: market.sizeStep, sends });
  }

  // Margin: only for what the order adds. Closing an opposite position (or
  // part of one) frees margin rather than needing it.
  if (!input.reduceOnly && input.available !== undefined && input.price > 0) {
    const opposite =
      input.position && (input.position.side === "long") !== (side === "buy")
        ? Number(input.position.size)
        : 0;
    const adds = Math.max(0, sends - opposite);
    const need = (adds * input.price) / input.leverage;
    if (need > input.available) {
      const max = opposite + (input.available * input.leverage) / input.price;
      checks.push({
        field: "size",
        level: "warn",
        code: "margin",
        need,
        have: input.available,
        max: step > 0 ? Math.floor(max / step) * step : max,
      });
    }
  }
  return checks;
}

export interface PositionState {
  /** Signed: positive long, negative short, 0 flat. */
  size: number;
  /** Unset when flat. */
  entry?: number;
}

/**
 * The position before and after an order of `size` fills at `price`: adding
 * averages the entry, reducing keeps it, flipping starts again at `price`.
 * A reduce-only order stops at flat.
 */
export function positionAfter(
  position: Pick<Position, "side" | "size" | "entryPrice"> | undefined,
  side: TicketSide,
  size: number,
  price: number,
  reduceOnly: boolean,
): { from: PositionState; to: PositionState } {
  const held = position ? Number(position.size) * (position.side === "long" ? 1 : -1) : 0;
  const from: PositionState = position
    ? { size: held, entry: Number(position.entryPrice) }
    : { size: 0 };
  let change = size * (side === "buy" ? 1 : -1);
  const reduces = held !== 0 && Math.sign(change) !== Math.sign(held);
  if (reduceOnly)
    change = reduces ? Math.sign(change) * Math.min(Math.abs(change), Math.abs(held)) : 0;
  const next = held + change;
  if (Math.abs(next) < 1e-12) return { from, to: { size: 0 } };
  let entry: number;
  if (held === 0 || Math.sign(next) !== Math.sign(held)) entry = price;
  else if (reduces) entry = from.entry ?? price;
  else entry = (Math.abs(held) * (from.entry ?? price) + Math.abs(change) * price) / Math.abs(next);
  return { from, to: { size: next, entry } };
}

/**
 * The maintenance margin assumed for a liquidation estimate: 0.5%, the
 * lowest tier on the large markets. Venues tier it up with position size,
 * so a big position liquidates sooner than estimated.
 */
const MAINTENANCE_RATE = 0.005;

/**
 * Roughly where `position` would be liquidated. Isolated: when its own
 * margin (its value over the leverage) is down to the maintenance margin.
 * Cross: when the whole account's `equity` is, taking this position as the
 * only one. An estimate either way - no fees or funding, one maintenance
 * rate - so undefined rather than a number where it can't be meaningful.
 */
export function estLiquidation(
  position: PositionState,
  margin: { mode: "cross" | "isolated"; leverage: number; equity?: number },
): number | undefined {
  const size = Math.abs(position.size);
  const entry = position.entry;
  if (!(size > 0) || entry === undefined || !(entry > 0) || !(margin.leverage > 0))
    return undefined;
  const dir = position.size > 0 ? 1 : -1;
  // The loss per unit the position can take before only maintenance is left.
  const cushion =
    margin.mode === "isolated"
      ? entry / margin.leverage - entry * MAINTENANCE_RATE
      : margin.equity === undefined
        ? undefined
        : margin.equity / size - entry * MAINTENANCE_RATE;
  if (cushion === undefined || !(cushion > 0)) return undefined;
  const price = entry - dir * cushion;
  return price > 0 ? price : undefined;
}
