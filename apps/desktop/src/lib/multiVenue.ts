import type { Market, OrderRequest, Side, VenueId } from "@pewterdesk/core";
import { onTick, roundToStep } from "@pewterdesk/ui";

/**
 * The multi-venue ticket's arithmetic: one coin found on each venue, and an
 * order for each sized against that venue's own account. Each order is an
 * ordinary `OrderRequest`, sent through the same `place_order` (and gate) as
 * the ticket's; nothing here is sent anywhere.
 */

/**
 * A market's coin, and how many of it one unit of the market is: Hyperliquid
 * quotes PEPE as `kPEPE` (1,000), Bybit and Binance as `1000PEPE`.
 */
export function coinOf(base: string): { coin: string; units: number } {
  const k = /^k([A-Z0-9][A-Za-z0-9]*)$/.exec(base);
  if (k?.[1]) return { coin: k[1].toUpperCase(), units: 1000 };
  const n = /^(1000000000|1000000|100000|10000|1000)([A-Za-z][A-Za-z0-9]*)$/.exec(base);
  if (n?.[1] && n[2]) return { coin: n[2].toUpperCase(), units: Number(n[1]) };
  return { coin: base.toUpperCase(), units: 1 };
}

/**
 * The market a venue lists `coin` on: its own (not a builder-deployed one)
 * first, then one quoted per single coin; undefined if it has none.
 */
export function marketForCoin(markets: readonly Market[], coin: string): Market | undefined {
  const wanted = coin.toUpperCase();
  const found = markets.filter((m) => coinOf(m.base).coin === wanted);
  const rank = (m: Market) => (m.listedBy ? 2 : 0) + (coinOf(m.base).units === 1 ? 0 : 1);
  return found.sort((a, b) => rank(a) - rank(b))[0];
}

/** Venues that take no TP / SL with an order: Aster's go on the position afterwards. */
export const NO_ATTACHED_EXITS: ReadonlySet<VenueId> = new Set<VenueId>(["aster"]);

export type OrderStyle = "market" | "limit";

/** What the trader fills in once, for every venue. */
export interface MultiTicket {
  side: Side;
  style: OrderStyle;
  /** Limit only: how far inside each venue's price, in percent (0.5 = 0.5% better). */
  offsetPct: number;
  /** With a stop: what each venue's trade may lose, in percent of that account's equity. */
  riskPct: number;
  /** Without a stop: each order's size, in percent of that venue's available margin. */
  balancePct: number;
  /** Distance to the stop and the target, in percent of each venue's entry; 0 for none. */
  stopPct: number;
  targetPct: number;
}

/** One venue's numbers, as its own feeds have them. */
export interface LegFacts {
  market: Market;
  /** The market's mark price, per unit of the market. */
  price: number;
  equity: number;
  available: number;
}

export type LegProblem = "noPrice" | "noFunds" | "belowMin" | "overMargin";

/** What one venue's order comes to. */
export interface LegPlan {
  /** In the market's own units, on its size step. */
  size: number;
  sizeText: string;
  /** In the coin itself: the size times the market's units. */
  coins: number;
  entry: number;
  entryText: string;
  notional: number;
  /** What it loses at the stop; unset without one. */
  risk?: number;
  stopText?: string;
  targetText?: string;
  problem?: LegProblem;
}

const sign = (side: Side) => (side === "buy" ? 1 : -1);

/**
 * One venue's order: with a stop, sized so it loses `riskPct` of that
 * account's equity at the stop; without one, `balancePct` of what that
 * account has available, as notional. Prices on the market's tick, the size
 * rounded down to its step.
 */
export function planLeg(ticket: MultiTicket, facts: LegFacts): LegPlan {
  const { market, price, equity, available } = facts;
  const s = sign(ticket.side);
  const units = coinOf(market.base).units;
  // A limit order sits inside the price: below it for a buy, above for a sell.
  const raw = ticket.style === "limit" ? price * (1 - (s * ticket.offsetPct) / 100) : price;
  const entryText = onTick(raw, market.tickSize);
  const entry = Number(entryText);
  const empty = { size: 0, sizeText: "0", coins: 0, entry, entryText, notional: 0 };
  if (!(price > 0) || !(entry > 0)) return { ...empty, problem: "noPrice" };
  if (!(equity > 0)) return { ...empty, problem: "noFunds" };

  const stop = ticket.stopPct > 0 ? entry * (1 - (s * ticket.stopPct) / 100) : undefined;
  const target = ticket.targetPct > 0 ? entry * (1 + (s * ticket.targetPct) / 100) : undefined;
  const stopText = stop !== undefined ? onTick(stop, market.tickSize) : undefined;
  const targetText = target !== undefined ? onTick(target, market.tickSize) : undefined;
  const perUnitLoss = stopText !== undefined ? Math.abs(entry - Number(stopText)) : undefined;

  const wanted =
    perUnitLoss && perUnitLoss > 0
      ? (equity * ticket.riskPct) / 100 / perUnitLoss
      : (Math.max(available, 0) * ticket.balancePct) / 100 / entry;
  const { size, text } = roundToStep(wanted, market.sizeStep);
  const notional = size * entry;
  const plan: LegPlan = {
    size,
    sizeText: text,
    coins: size * units,
    entry,
    entryText,
    notional,
    risk: perUnitLoss !== undefined ? size * perUnitLoss : undefined,
    stopText,
    targetText,
  };
  if (!(size > 0) || size < Number(market.minSize)) return { ...plan, problem: "belowMin" };
  // More than the account could open at the market's highest leverage: the venue refuses it.
  if (notional > Math.max(available, 0) * Math.max(market.maxLeverage, 1)) {
    return { ...plan, problem: "overMargin" };
  }
  return plan;
}

/**
 * The order a leg sends. A venue that takes no exits with an order (Aster)
 * gets them afterwards on the position, so `withExits` is false there.
 */
export function legRequest(
  ticket: MultiTicket,
  market: Market,
  plan: LegPlan,
  maxSlippageBps: number,
  withExits: boolean,
): OrderRequest {
  const base = {
    market: market.id,
    side: ticket.side,
    size: plan.sizeText,
    reduceOnly: false,
    ...(withExits && plan.stopText && { stopLoss: plan.stopText }),
    ...(withExits && plan.targetText && { takeProfit: plan.targetText }),
  };
  return ticket.style === "market"
    ? { ...base, type: "market", maxSlippageBps }
    : { ...base, type: "limit", price: plan.entryText };
}
