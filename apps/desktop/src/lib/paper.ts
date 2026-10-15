import type {
  AccountSnapshot,
  ClosedTrade,
  ExitChange,
  Fill,
  FillEffect,
  FundingPayment,
  MarginMode,
  Market,
  Order,
  OrderAmend,
  OrderRequest,
  Position,
  PositionProtection,
  Side,
  TradeSettings,
  VenueId,
} from "@pewterdesk/core";

// Paper trading: a simulated account on a venue that has no demo of its own
// (Hyperliquid, Aster), traded from the Trade page like a live one. Orders
// fill against the venue's live public prices - the book's best bid and ask
// for the market on screen, the mark for the rest - at the venue's own fees,
// and nothing is signed or sent: this module never reaches a venue. Pure
// functions over a plain state, so the page and its tests run the same code.

/** Venues that get paper trading: the ones without a demo of their own. */
export const PAPER_VENUES: readonly VenueId[] = ["hyperliquid", "aster"];
export const isPaperVenue = (venue: VenueId) => PAPER_VENUES.includes(venue);

/** A new paper account's balance, in the venue's quote asset. */
export const PAPER_START = 10_000;
/** The most that can be added at once, like a demo's top-up. */
export const PAPER_ADD_MAX = 100_000;
/** The least that can be added or taken out at once. */
export const PAPER_MOVE_MIN = 1;
/** Kept per list, newest first; older ones drop off. */
const KEEP = 500;
/** Where there's no book (a market not on screen), fills are this far from the mark. */
const MARK_SPREAD = 0.0002;

/** What a market costs right now: its mark, and the book's best prices where known. */
export interface Quote {
  mark: number;
  bid?: number;
  ask?: number;
  /** The current funding rate and its interval, from the venue's summaries. */
  fundingRate?: number;
  fundingIntervalSecs?: number;
}
export type Quotes = Readonly<Record<string, Quote>>;

export interface PaperPosition {
  market: string;
  side: "long" | "short";
  size: number;
  entry: number;
  leverage: number;
  marginMode: MarginMode;
  /** Realised on this position so far: closed parts, fees, funding. */
  realized: number;
  /** What its entries cost in fees, for a closed part's share. */
  openFees: number;
  openedAt: number;
  takeProfit?: number;
  stopLoss?: number;
  /** A trailing stop's distance, and the best price it has followed. */
  trailing?: number;
  trailingBest?: number;
  /** Where a trailing stop starts following; unset once it has. */
  trailingFrom?: number;
}

export interface PaperOrder {
  id: string;
  market: string;
  side: Side;
  type: "limit" | "trigger";
  size: number;
  price?: number;
  triggerPrice?: number;
  /** A trigger fires when the mark rises to it (true) or falls to it. */
  triggerAbove?: boolean;
  reduceOnly: boolean;
  postOnly: boolean;
  createdAt: number;
  takeProfit?: number;
  stopLoss?: number;
}

export interface PaperState {
  venue: VenueId;
  /** Deposited plus everything realised: the balance before open P&L. */
  cash: number;
  /** What it started with, for the reset and the return. */
  start: number;
  positions: PaperPosition[];
  orders: PaperOrder[];
  /** Newest first, each. */
  fills: Fill[];
  closed: ClosedTrade[];
  history: Order[];
  funding: FundingPayment[];
  /** Leverage and margin mode per market, as the ticket set them. */
  settings: Record<string, { leverage: number; marginMode: MarginMode }>;
  nextId: number;
  /** When funding was last paid, per market. */
  fundedAt: Record<string, number>;
}

export interface Fees {
  taker: number;
  maker: number;
}

export function newPaperState(venue: VenueId, start = PAPER_START): PaperState {
  return {
    venue,
    cash: start,
    start,
    positions: [],
    orders: [],
    fills: [],
    closed: [],
    history: [],
    funding: [],
    settings: {},
    nextId: 1,
    fundedAt: {},
  };
}

/** A number as a domain `Decimal`: plain digits, no exponent, no float noise. */
export function dec(n: number): string {
  if (!Number.isFinite(n)) return "0";
  const s = n.toFixed(10).replace(/\.?0+$/, "");
  return s === "-0" ? "0" : s;
}

const dirOf = (side: "long" | "short") => (side === "long" ? 1 : -1);
const keep = <T>(list: T[]) => list.slice(0, KEEP);
/** Rounds down to the market's size step. */
function toStep(size: number, step: number) {
  if (!(step > 0)) return size;
  return Math.floor(size / step + 1e-9) * step;
}

/** A market's settings, or its defaults: 10× (or its maximum) and cross. */
export function settingsFor(state: PaperState, market: Market) {
  return (
    state.settings[market.id] ?? {
      leverage: Math.min(10, market.maxLeverage),
      marginMode: "cross" as MarginMode,
    }
  );
}

/** Maintenance margin as a fraction of notional: half the initial margin at the market's maximum leverage. */
const maintenance = (maxLeverage: number) => 0.5 / Math.max(1, maxLeverage);

const markOf = (quotes: Quotes, market: string, fallback: number) =>
  quotes[market]?.mark ?? fallback;

/** Open P&L, margin and equity at these prices. */
export function totals(state: PaperState, quotes: Quotes) {
  let upnl = 0;
  let margin = 0;
  for (const p of state.positions) {
    const mark = markOf(quotes, p.market, p.entry);
    upnl += (mark - p.entry) * p.size * dirOf(p.side);
    margin += (p.size * mark) / p.leverage;
  }
  // Resting orders that would open a position hold their margin too.
  let held = 0;
  for (const o of state.orders) {
    if (o.reduceOnly) continue;
    const price = o.price ?? o.triggerPrice ?? markOf(quotes, o.market, 0);
    const lev = state.settings[o.market]?.leverage ?? 10;
    held += (o.size * price) / lev;
  }
  const equity = state.cash + upnl;
  return { upnl, margin, held, equity, available: Math.max(0, equity - margin - held) };
}

/** The price at which a position would be liquidated, at these prices. */
export function liquidationPrice(
  state: PaperState,
  p: PaperPosition,
  quotes: Quotes,
  maxLeverage: number,
): number | undefined {
  const mmr = maintenance(maxLeverage);
  const dir = dirOf(p.side);
  if (p.marginMode === "isolated") {
    // The position's own margin covers the loss down to maintenance.
    const price = (p.entry * (1 - dir / p.leverage)) / (1 - dir * mmr);
    return price > 0 ? price : undefined;
  }
  // Cross: the whole account's equity, the others held where they are.
  const { equity } = totals(state, quotes);
  const mark = markOf(quotes, p.market, p.entry);
  const others = state.positions
    .filter((o) => o !== p)
    .reduce((sum, o) => sum + o.size * markOf(quotes, o.market, o.entry) * mmr, 0);
  // equity + dir*size*(liq - mark) = others + size*liq*mmr
  const liq = (others - equity + dir * p.size * mark) / (dir * p.size - p.size * mmr);
  return liq > 0 && Number.isFinite(liq) ? liq : undefined;
}

export type PaperResult = { state: PaperState; error?: string };

/** The cost of crossing the spread now: the ask to buy, the bid to sell. */
function takerPrice(quote: Quote, side: Side) {
  if (side === "buy") return quote.ask ?? quote.mark * (1 + MARK_SPREAD);
  return quote.bid ?? quote.mark * (1 - MARK_SPREAD);
}

/** Problems, by the domain's `VenueError` wording: "size", "margin", "reduceOnly"... */
export type PaperError =
  | "noPrice"
  | "size"
  | "minSize"
  | "margin"
  | "reduceOnly"
  | "postOnly"
  | "notFound"
  | "price"
  | "hasPosition"
  | "amount"
  | "tooMuch";

function pushHistory(state: PaperState, o: PaperOrder, status: Order["status"], filled: number) {
  state.history = keep([toOrder(state.venue, o, status, filled), ...state.history]);
}

/**
 * Places an order. A market order, and a limit that crosses the book, fills
 * at once as a taker; a limit that doesn't rests; a trigger waits for the
 * mark. An attached TP and SL go onto the position it opens.
 */
export function placeOrder(
  current: PaperState,
  request: OrderRequest,
  market: Market,
  quotes: Quotes,
  fees: Fees,
  now: number,
): PaperResult & { error?: PaperError } {
  const quote = quotes[market.id];
  if (!quote || !(quote.mark > 0)) return { state: current, error: "noPrice" };
  const state = clone(current);
  const step = Number(market.sizeStep);
  let size = toStep(Number(request.size), step);
  if (!(size > 0)) return { state: current, error: "size" };
  if (size < Number(market.minSize) - 1e-12) return { state: current, error: "minSize" };
  const position = state.positions.find((p) => p.market === market.id);
  if (request.reduceOnly) {
    const closing =
      position && (position.side === "long" ? request.side === "sell" : request.side === "buy");
    if (!closing || !position) return { state: current, error: "reduceOnly" };
    size = Math.min(size, position.size);
  }
  const id = `paper-${state.nextId++}`;
  const order: PaperOrder = {
    id,
    market: market.id,
    side: request.side,
    type: request.type === "trigger" ? "trigger" : "limit",
    size,
    reduceOnly: request.reduceOnly,
    postOnly: request.type === "limit" && request.timeInForce === "postOnly",
    createdAt: now,
    takeProfit: request.takeProfit ? Number(request.takeProfit) : undefined,
    stopLoss: request.stopLoss ? Number(request.stopLoss) : undefined,
  };

  // Opening size needs margin: the part that doesn't close what's open.
  const closes =
    position && (position.side === "long" ? request.side === "sell" : request.side === "buy")
      ? Math.min(size, position.size)
      : 0;
  const opening = size - closes;
  if (opening > 0) {
    const price =
      request.type === "limit"
        ? Number(request.price)
        : request.type === "trigger"
          ? Number(request.limitPrice ?? request.triggerPrice)
          : takerPrice(quote, request.side);
    const lev = settingsFor(state, market).leverage;
    const need = (opening * price) / lev + opening * price * fees.taker;
    if (need > totals(state, quotes).available + 1e-9) return { state: current, error: "margin" };
  }

  if (request.type === "market") {
    const price = takerPrice(quote, request.side);
    // The slippage bound: a market order never fills past it.
    const bound = quote.mark * (request.maxSlippageBps / 10_000);
    if (Math.abs(price - quote.mark) > bound + 1e-12) {
      pushHistory(state, order, "cancelled", 0);
      return { state, error: "price" };
    }
    fill(state, order, market, price, true, fees, now);
    pushHistory(state, order, "filled", size);
    return { state };
  }
  if (request.type === "limit") {
    const price = Number(request.price);
    if (!(price > 0)) return { state: current, error: "price" };
    order.price = price;
    const crosses =
      request.side === "buy"
        ? price >= takerPrice(quote, "buy")
        : price <= takerPrice(quote, "sell");
    if (crosses && order.postOnly) {
      pushHistory(state, order, "rejected", 0);
      return { state, error: "postOnly" };
    }
    if (crosses) {
      fill(state, order, market, takerPrice(quote, request.side), true, fees, now);
      pushHistory(state, order, "filled", size);
      return { state };
    }
    if (request.timeInForce === "ioc") {
      pushHistory(state, order, "cancelled", 0);
      return { state };
    }
    state.orders = [order, ...state.orders];
    return { state };
  }
  const trigger = Number(request.triggerPrice);
  if (!(trigger > 0)) return { state: current, error: "price" };
  order.triggerPrice = trigger;
  order.triggerAbove = trigger > quote.mark;
  if (request.limitPrice) order.price = Number(request.limitPrice);
  state.orders = [order, ...state.orders];
  return { state };
}

/** Applies a fill to the market's position, and records it. */
function fill(
  state: PaperState,
  order: Pick<PaperOrder, "id" | "market" | "side" | "takeProfit" | "stopLoss">,
  market: Market,
  price: number,
  taker: boolean,
  fees: Fees,
  now: number,
  size = (order as PaperOrder).size,
) {
  const fee = size * price * (taker ? fees.taker : fees.maker);
  state.cash -= fee;
  const buy = order.side === "buy";
  const index = state.positions.findIndex((p) => p.market === market.id);
  const position = index === -1 ? undefined : state.positions[index];
  let effect: FillEffect = buy ? "openLong" : "openShort";
  let closedPnl = 0;
  const { leverage, marginMode } = settingsFor(state, market);

  if (!position || (position.side === "long") === buy) {
    // Opens or adds: the entry is the size-weighted average.
    if (position) {
      const total = position.size + size;
      position.entry = (position.entry * position.size + price * size) / total;
      position.size = total;
      position.openFees += fee;
      position.realized -= fee;
    } else {
      state.positions.push({
        market: market.id,
        side: buy ? "long" : "short",
        size,
        entry: price,
        leverage,
        marginMode,
        realized: -fee,
        openFees: fee,
        openedAt: now,
        takeProfit: order.takeProfit,
        stopLoss: order.stopLoss,
      });
    }
  } else {
    // Closes some or all of it, and any rest opens the other way.
    const closing = Math.min(size, position.size);
    const dir = dirOf(position.side);
    closedPnl = (price - position.entry) * closing * dir;
    state.cash += closedPnl;
    const share = closing / position.size;
    const entryFees = position.openFees * share;
    const closeFee = fee * (closing / size);
    state.closed = keep([
      {
        venue: state.venue,
        market: market.id,
        side: position.side,
        size: dec(closing),
        entryPrice: dec(position.entry),
        exitPrice: dec(price),
        closedPnl: dec(closedPnl - entryFees - closeFee),
        entryValue: dec(position.entry * closing),
        leverage: dec(position.leverage),
        time: now,
        openedAt: position.openedAt,
      },
      ...state.closed,
    ]);
    const rest = size - closing;
    effect =
      rest > 1e-12
        ? position.side === "long"
          ? "longToShort"
          : "shortToLong"
        : position.side === "long"
          ? "closeLong"
          : "closeShort";
    if (closing >= position.size - 1e-12) {
      state.positions.splice(index, 1);
      // An exit order for a position that's gone goes with it.
      state.orders = state.orders.filter((o) => !(o.market === market.id && o.reduceOnly));
      if (rest > 1e-12) {
        state.positions.push({
          market: market.id,
          side: buy ? "long" : "short",
          size: rest,
          entry: price,
          leverage,
          marginMode,
          realized: -(fee - closeFee),
          openFees: fee - closeFee,
          openedAt: now,
          takeProfit: order.takeProfit,
          stopLoss: order.stopLoss,
        });
      }
    } else {
      position.size -= closing;
      position.openFees -= entryFees;
      position.realized += closedPnl - closeFee;
    }
  }
  state.fills = keep([
    {
      venue: state.venue,
      id: `${order.id}-${state.nextId++}`,
      orderId: order.id,
      market: market.id,
      side: order.side,
      effect,
      price: dec(price),
      size: dec(size),
      closedPnl: dec(closedPnl),
      fee: dec(fee),
      feeAsset: market.quote,
      taker,
      time: now,
    },
    ...state.fills,
  ]);
}

/** Closes a whole position at `price`, as an order of its own (an exit, a liquidation). */
function closeAt(
  state: PaperState,
  p: PaperPosition,
  market: Market,
  price: number,
  fees: Fees,
  now: number,
) {
  const order: PaperOrder = {
    id: `paper-${state.nextId++}`,
    market: p.market,
    side: p.side === "long" ? "sell" : "buy",
    type: "trigger",
    size: p.size,
    reduceOnly: true,
    postOnly: false,
    createdAt: now,
  };
  fill(state, order, market, price, true, fees, now);
  pushHistory(state, order, "filled", order.size);
}

/**
 * Moves the account on to `now` at these prices: resting limits that the
 * price reached fill (as a maker, at their price), triggers fire, a
 * position's TP, SL and trailing stop close it, funding is paid at each
 * interval, and a position past its liquidation price is closed there.
 */
export function tick(
  current: PaperState,
  quotes: Quotes,
  markets: ReadonlyMap<string, Market>,
  fees: Fees,
  now: number,
): PaperState {
  const state = clone(current);
  let changed = false;

  for (const o of [...state.orders]) {
    const quote = quotes[o.market];
    const market = markets.get(o.market);
    if (!quote || !market) continue;
    if (o.type === "trigger") {
      const hit = o.triggerAbove
        ? quote.mark >= (o.triggerPrice ?? 0)
        : quote.mark <= (o.triggerPrice ?? 0);
      if (!hit) continue;
      changed = true;
      state.orders = state.orders.filter((x) => x.id !== o.id);
      if (o.price !== undefined) {
        // A stop-limit becomes a resting limit at its price.
        state.orders = [{ ...o, type: "limit", triggerPrice: undefined }, ...state.orders];
        continue;
      }
      const size = sizeFor(state, o);
      if (size <= 0) {
        pushHistory(state, o, "cancelled", 0);
        continue;
      }
      fill(state, o, market, takerPrice(quote, o.side), true, fees, now, size);
      pushHistory(state, o, "filled", size);
      continue;
    }
    // A resting limit fills once the other side reaches its price.
    const price = o.price ?? 0;
    const reached =
      o.side === "buy" ? (quote.ask ?? quote.mark) <= price : (quote.bid ?? quote.mark) >= price;
    if (!reached) continue;
    changed = true;
    state.orders = state.orders.filter((x) => x.id !== o.id);
    const size = sizeFor(state, o);
    if (size <= 0) {
      pushHistory(state, o, "cancelled", 0);
      continue;
    }
    fill(state, o, market, price, false, fees, now, size);
    pushHistory(state, o, "filled", size);
  }

  for (const p of [...state.positions]) {
    const quote = quotes[p.market];
    const market = markets.get(p.market);
    if (!quote || !market) continue;
    const mark = quote.mark;
    const long = p.side === "long";
    // Funding, once per interval: longs pay a positive rate, shorts receive it.
    const interval = (quote.fundingIntervalSecs ?? 3600) * 1000;
    const last = state.fundedAt[p.market] ?? p.openedAt;
    if (
      quote.fundingRate !== undefined &&
      Math.floor(now / interval) > Math.floor(last / interval)
    ) {
      const amount = -dirOf(p.side) * p.size * mark * quote.fundingRate;
      state.cash += amount;
      p.realized += amount;
      state.fundedAt[p.market] = now;
      state.funding = keep([
        {
          venue: state.venue,
          market: p.market,
          amount: dec(amount),
          positionSize: dec(p.size * dirOf(p.side)),
          rate: dec(quote.fundingRate),
          time: now,
        },
        ...state.funding,
      ]);
      changed = true;
    } else if (state.fundedAt[p.market] === undefined) {
      state.fundedAt[p.market] = now;
    }
    // A trailing stop follows the best price once it's active.
    if (p.trailing !== undefined) {
      const active =
        p.trailingFrom === undefined || (long ? mark >= p.trailingFrom : mark <= p.trailingFrom);
      if (active) {
        const best =
          p.trailingBest === undefined
            ? mark
            : long
              ? Math.max(p.trailingBest, mark)
              : Math.min(p.trailingBest, mark);
        // A new best (or the start of following) is a change to keep.
        if (best !== p.trailingBest || p.trailingFrom !== undefined) changed = true;
        p.trailingFrom = undefined;
        p.trailingBest = best;
      }
    }
    const trailHit =
      p.trailing !== undefined &&
      p.trailingBest !== undefined &&
      (long ? mark <= p.trailingBest - p.trailing : mark >= p.trailingBest + p.trailing);
    const liq = liquidationPrice(state, p, quotes, market.maxLeverage);
    if (liq !== undefined && (long ? mark <= liq : mark >= liq)) {
      closeAt(state, p, market, liq, fees, now);
      changed = true;
    } else if (p.stopLoss !== undefined && (long ? mark <= p.stopLoss : mark >= p.stopLoss)) {
      closeAt(state, p, market, takerPrice(quote, long ? "sell" : "buy"), fees, now);
      changed = true;
    } else if (p.takeProfit !== undefined && (long ? mark >= p.takeProfit : mark <= p.takeProfit)) {
      closeAt(state, p, market, takerPrice(quote, long ? "sell" : "buy"), fees, now);
      changed = true;
    } else if (trailHit) {
      closeAt(state, p, market, takerPrice(quote, long ? "sell" : "buy"), fees, now);
      changed = true;
    }
  }
  return changed || JSON.stringify(state.fundedAt) !== JSON.stringify(current.fundedAt)
    ? state
    : current;
}

/** A reduce-only order shrinks to what's left of the position; others fill whole. */
function sizeFor(state: PaperState, o: PaperOrder) {
  if (!o.reduceOnly) return o.size;
  const p = state.positions.find((x) => x.market === o.market);
  const closing = p && (p.side === "long" ? o.side === "sell" : o.side === "buy");
  return closing && p ? Math.min(o.size, p.size) : 0;
}

/**
 * Adds funds to the account (a positive `amount`) or takes them out (a
 * negative one). The P&L is measured from what was put in, so `start` moves
 * with it: money moved in or out is never profit or loss. Only what isn't
 * held as margin can be taken out.
 */
export function adjustFunds(
  current: PaperState,
  amount: number,
  quotes: Quotes,
): PaperResult & { error?: PaperError } {
  const size = Math.abs(amount);
  if (!Number.isFinite(amount) || size < PAPER_MOVE_MIN) return { state: current, error: "amount" };
  if (amount > 0 && amount > PAPER_ADD_MAX) return { state: current, error: "amount" };
  if (amount < 0 && size > withdrawable(current, quotes) + 1e-9) {
    return { state: current, error: "tooMuch" };
  }
  return {
    state: { ...clone(current), cash: current.cash + amount, start: current.start + amount },
  };
}

/** What can be taken out now: equity not held as margin, and never more than the cash. */
export function withdrawable(state: PaperState, quotes: Quotes): number {
  return Math.max(0, Math.min(totals(state, quotes).available, state.cash));
}

export function cancelOrder(current: PaperState, id: string): PaperResult & { error?: PaperError } {
  const order = current.orders.find((o) => o.id === id);
  if (!order) return { state: current, error: "notFound" };
  const state = clone(current);
  state.orders = state.orders.filter((o) => o.id !== id);
  pushHistory(state, order, "cancelled", 0);
  return { state };
}

const applyExit = (now: number | undefined, change: ExitChange) =>
  change.action === "keep" ? now : change.action === "remove" ? undefined : Number(change.price);

/** Changes an open order's price, size, or attached TP and SL. */
export function amendOrder(
  current: PaperState,
  id: string,
  change: OrderAmend,
  market: Market,
): PaperResult & { error?: PaperError } {
  const state = clone(current);
  const order = state.orders.find((o) => o.id === id);
  if (!order) return { state: current, error: "notFound" };
  if (change.price !== undefined) {
    const price = Number(change.price);
    if (!(price > 0)) return { state: current, error: "price" };
    if (order.type === "trigger") order.triggerPrice = price;
    else order.price = price;
  }
  if (change.size !== undefined) {
    const size = toStep(Number(change.size), Number(market.sizeStep));
    if (!(size > 0)) return { state: current, error: "size" };
    order.size = size;
  }
  order.takeProfit = applyExit(order.takeProfit, change.takeProfit);
  order.stopLoss = applyExit(order.stopLoss, change.stopLoss);
  return { state };
}

/** Sets a position's take-profit, stop-loss and trailing stop. */
export function protectPosition(
  current: PaperState,
  marketId: string,
  protection: PositionProtection,
): PaperResult & { error?: PaperError } {
  const state = clone(current);
  const p = state.positions.find((x) => x.market === marketId);
  if (!p) return { state: current, error: "notFound" };
  p.takeProfit = applyExit(p.takeProfit, protection.takeProfit);
  p.stopLoss = applyExit(p.stopLoss, protection.stopLoss);
  const trailing = applyExit(p.trailing, protection.trailingStop);
  if (trailing !== p.trailing) {
    p.trailing = trailing;
    p.trailingBest = undefined;
    p.trailingFrom =
      trailing !== undefined && protection.trailingActivation
        ? Number(protection.trailingActivation)
        : undefined;
  }
  return { state };
}

/** Sets a market's leverage (1 to its maximum); an open position takes it too. */
export function setLeverage(current: PaperState, market: Market, leverage: number): PaperState {
  const state = clone(current);
  const lev = Math.max(1, Math.min(market.maxLeverage, Math.round(leverage)));
  state.settings[market.id] = { ...settingsFor(state, market), leverage: lev };
  const p = state.positions.find((x) => x.market === market.id);
  if (p) p.leverage = lev;
  return state;
}

/** Cross or isolated; like the venues, not while a position is open. */
export function setMarginMode(
  current: PaperState,
  market: Market,
  mode: MarginMode,
): PaperResult & { error?: PaperError } {
  if (current.positions.some((p) => p.market === market.id)) {
    return { state: current, error: "hasPosition" };
  }
  const state = clone(current);
  state.settings[market.id] = { ...settingsFor(state, market), marginMode: mode };
  return { state };
}

/** The ticket's settings for a market, in the domain's shape. */
export function tradeSettings(state: PaperState, market: Market): TradeSettings {
  const s = settingsFor(state, market);
  return {
    marginMode: s.marginMode,
    marginModeAccountWide: false,
    leverage: String(s.leverage),
    maxLeverage: String(market.maxLeverage),
  };
}

function toOrder(venue: VenueId, o: PaperOrder, status: Order["status"], filled: number): Order {
  return {
    venue,
    id: o.id,
    market: o.market,
    side: o.side,
    type:
      o.type === "trigger"
        ? "trigger"
        : status === "filled" && o.price === undefined
          ? "market"
          : "limit",
    size: dec(o.size),
    filledSize: dec(filled),
    price: o.price === undefined ? undefined : dec(o.price),
    triggerPrice: o.triggerPrice === undefined ? undefined : dec(o.triggerPrice),
    reduceOnly: o.reduceOnly,
    status,
    createdAt: o.createdAt,
    category: o.type === "trigger" ? "conditional" : "regular",
    triggerBy: o.type === "trigger" ? "mark" : undefined,
    takeProfit: o.takeProfit === undefined ? undefined : dec(o.takeProfit),
    stopLoss: o.stopLoss === undefined ? undefined : dec(o.stopLoss),
  };
}

/** The account as the panels read a venue's: positions at these prices, open orders, equity. */
export function snapshot(
  state: PaperState,
  quotes: Quotes,
  markets: ReadonlyMap<string, Market>,
  now: number,
): AccountSnapshot {
  const { equity, available } = totals(state, quotes);
  const positions: Position[] = state.positions.map((p) => {
    const mark = markOf(quotes, p.market, p.entry);
    const market = markets.get(p.market);
    const liq = market ? liquidationPrice(state, p, quotes, market.maxLeverage) : undefined;
    return {
      venue: state.venue,
      market: p.market,
      side: p.side,
      size: dec(p.size),
      entryPrice: dec(p.entry),
      markPrice: dec(mark),
      liquidationPrice: liq === undefined ? undefined : dec(liq),
      unrealizedPnl: dec((mark - p.entry) * p.size * dirOf(p.side)),
      margin: dec((p.size * mark) / p.leverage),
      realizedPnl: dec(p.realized),
      takeProfit: p.takeProfit === undefined ? undefined : dec(p.takeProfit),
      stopLoss: p.stopLoss === undefined ? undefined : dec(p.stopLoss),
      trailingStop: p.trailing === undefined ? undefined : dec(p.trailing),
      leverage: dec(p.leverage),
      marginMode: p.marginMode,
    };
  });
  return {
    venue: state.venue,
    address: "paper",
    equity: dec(equity),
    availableMargin: dec(available),
    realizedPnl: dec(state.cash - state.start),
    positions,
    openOrders: state.orders.map((o) => toOrder(state.venue, o, "open", 0)),
    time: now,
  };
}

function clone(state: PaperState): PaperState {
  return {
    ...state,
    positions: state.positions.map((p) => ({ ...p })),
    orders: state.orders.map((o) => ({ ...o })),
    settings: { ...state.settings },
    fundedAt: { ...state.fundedAt },
  };
}

/** What was stored, if it's a paper account at all. */
export function parsePaperState(raw: string | null, venue: VenueId): PaperState | undefined {
  if (!raw) return undefined;
  try {
    const value = JSON.parse(raw) as PaperState;
    if (
      value &&
      value.venue === venue &&
      Number.isFinite(value.cash) &&
      Array.isArray(value.positions) &&
      Array.isArray(value.orders)
    ) {
      return { ...newPaperState(venue, value.start), ...value };
    }
  } catch {
    // Unreadable: a fresh account.
  }
  return undefined;
}
