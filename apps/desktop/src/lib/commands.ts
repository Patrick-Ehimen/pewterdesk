import type { Market, Order, OrderRequest, Position, PositionProtection } from "@pewterdesk/core";
import { decimalsOf, roundToStep } from "@pewterdesk/ui";

/**
 * What a line typed into the command palette asks for. Parsing only: nothing
 * here places, closes or cancels anything; the palette shows what was
 * understood and asks before it acts.
 */
export type Intent =
  | {
      kind: "order";
      side: "buy" | "sell";
      market: Market;
      /** Cut down to the market's size step. */
      size: string;
      /** A limit price as typed; unset for a market order. */
      price?: string;
      /** Scaled: the last order's price, with `count` orders from `price` to it. */
      to?: string;
      count?: number;
    }
  /** Part of an open position, taken off: "sell 50% hype". */
  | {
      kind: "reduce";
      position: Position;
      market: Market;
      /** Of the position, above 0 and at most 1. */
      fraction: number;
      /** A limit price as typed; unset to do it at market. */
      price?: string;
    }
  /** A position's take-profit or stop-loss: set at `price`, or removed. */
  | { kind: "protect"; position: Position; market: Market; exit: "tp" | "sl"; price?: string }
  | { kind: "close"; position: Position; market?: Market }
  /** Every open order, or only `market`'s. */
  | { kind: "cancel"; orders: Order[]; market?: Market };

export interface CommandContext {
  markets: readonly Market[];
  /** The market on screen: what "buy 100" means without a coin. */
  current?: Market;
  positions: readonly Position[];
  orders: readonly Order[];
}

const SIDES: Record<string, "buy" | "sell"> = {
  buy: "buy",
  long: "buy",
  sell: "sell",
  short: "sell",
};

/** Orders a scaled order is split into, when the line doesn't say. */
const DEFAULT_SCALE = 5;
const MAX_SCALE = 10;

/** A number as people type one: "1,250.5", "38.2". Positive, or nothing. */
function amount(word: string | undefined): string | undefined {
  if (!word) return undefined;
  const plain = word.replace(/,/g, "");
  return /^\d*\.?\d+$/.test(plain) && Number(plain) > 0 ? plain : undefined;
}

/**
 * The market a word names: its id ("BTCUSDT"), its symbol ("BTC-USDT") or
 * its coin ("btc"), in that order, so a coin gets its first-listed market.
 */
export function findMarket(word: string, markets: readonly Market[]): Market | undefined {
  const w = word.toUpperCase();
  return (
    markets.find((m) => m.id.toUpperCase() === w) ??
    markets.find((m) => m.symbol.toUpperCase() === w) ??
    markets.find((m) => m.base.toUpperCase() === w)
  );
}

/** "50%" as a fraction, above 0 and at most 1. */
function percent(word: string | undefined): number | undefined {
  const value = word?.endsWith("%") ? amount(word.slice(0, -1)) : undefined;
  return value && Number(value) <= 100 ? Number(value) / 100 : undefined;
}

/** How many orders "x5", "5" or "5 orders" asks for: 2 to `MAX_SCALE`. */
function scaleCount(words: string[]): number | undefined {
  if (words.length === 0) return DEFAULT_SCALE;
  const [first, second] = words[0] === "in" ? words.slice(1) : words;
  if (words.length > (words[0] === "in" ? 3 : 2)) return undefined;
  if (second !== undefined && second !== "orders") return undefined;
  const count = Number(first?.replace(/^x/, ""));
  return Number.isInteger(count) && count >= 2 && count <= MAX_SCALE ? count : undefined;
}

/**
 * Reads a command:
 *
 * - `buy 100 hype at 38.2`, `sell 0.5 eth`, `long btc 0.01 @ 80,000`: an
 *   order, at a limit if a price follows, at market if not. Without a coin
 *   it's the market on screen.
 * - `buy 100 hype at 38.2 to 37.8 x5`: the same size as five limit orders
 *   spread evenly between the two prices (five when no count is given).
 * - `sell 50% hype`: that share of the open position, reduce-only. It has
 *   to be the side that closes it.
 * - `tp hype 41`, `sl 36.5`, `tp hype off`: a position's take-profit or
 *   stop-loss, set or removed.
 * - `close eth`: the open position on that market (or the one on screen).
 * - `cancel all`, `cancel all hype`, `cancel hype`: open orders.
 *
 * Anything else isn't a command (it may still be a search).
 */
export function parseCommand(text: string, ctx: CommandContext): Intent | undefined {
  const words = text.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const verb = words[0];
  if (!verb) return undefined;

  const side = SIDES[verb];
  if (side) {
    const rest = words.slice(1);
    // The price is whatever follows "at" or "@" ("@38.2" too); "to" and a
    // second price after it make it a scaled order.
    let price: string | undefined;
    let to: string | undefined;
    let count: number | undefined;
    const at = rest.findIndex((w) => w === "at" || w.startsWith("@"));
    if (at !== -1) {
      const tail = rest.slice(at).flatMap((w) => (w.startsWith("@") ? ["at", w.slice(1)] : [w]));
      const after = tail.filter(Boolean).slice(1);
      price = amount(after[0]);
      if (!price) return undefined;
      if (after.length > 1) {
        to = after[1] === "to" ? amount(after[2]) : undefined;
        count = scaleCount(after.slice(3));
        if (!to || !count || to === price) return undefined;
      }
      rest.length = at;
    }
    if (rest.length === 0 || rest.length > 2) return undefined;
    // The size and the coin, in either order.
    const isSize = (w: string) => amount(w) !== undefined || percent(w) !== undefined;
    const sizeWord = rest.find(isSize);
    const coinWord = rest.find((w) => !isSize(w));
    if (!sizeWord || rest.length - (coinWord ? 1 : 0) !== 1) return undefined;
    const market = coinWord ? findMarket(coinWord, ctx.markets) : ctx.current;
    if (!market) return undefined;
    const fraction = percent(sizeWord);
    if (fraction !== undefined) {
      // A share of the position, so only the side that takes it off, and never scaled.
      const position = ctx.positions.find((p) => p.market === market.id);
      const closes = position && (position.side === "long" ? "sell" : "buy") === side;
      return closes && !to ? { kind: "reduce", position, market, fraction, price } : undefined;
    }
    const size = roundToStep(Number(amount(sizeWord)), market.sizeStep);
    if (size.size <= 0 || size.size < Number(market.minSize)) return undefined;
    if (to && !scaledOrders({ side, market, size: size.text, price, to, count })) return undefined;
    return { kind: "order", side, market, size: size.text, price, to, count };
  }

  if ((verb === "tp" || verb === "sl") && words.length >= 2 && words.length <= 3) {
    const value = words[words.length - 1] ?? "";
    const market = words.length === 3 ? findMarket(words[1] ?? "", ctx.markets) : ctx.current;
    const position = market && ctx.positions.find((p) => p.market === market.id);
    if (!market || !position) return undefined;
    const off = value === "off" || value === "remove";
    const price = off ? undefined : amount(value);
    return off || price ? { kind: "protect", position, market, exit: verb, price } : undefined;
  }

  if (verb === "close" && words.length <= 2) {
    const market = words[1] ? findMarket(words[1], ctx.markets) : ctx.current;
    const position = market && ctx.positions.find((p) => p.market === market.id);
    return position ? { kind: "close", position, market } : undefined;
  }

  if (verb === "cancel" && words.length >= 2 && words.length <= 3) {
    const coin = words[1] === "all" ? words[2] : words.length === 2 ? words[1] : undefined;
    if (words[1] !== "all" && !coin) return undefined;
    const market = coin ? findMarket(coin, ctx.markets) : undefined;
    if (coin && !market) return undefined;
    const orders = market ? ctx.orders.filter((o) => o.market === market.id) : [...ctx.orders];
    return orders.length > 0 ? { kind: "cancel", orders, market } : undefined;
  }
  return undefined;
}

/** The order an order command comes to; a market order goes with a slippage bound. */
export function orderFor(
  intent: Extract<Intent, { kind: "order" }>,
  maxSlippageBps: number,
  atMarket = intent.price === undefined,
): OrderRequest {
  const base = {
    market: intent.market.id,
    side: intent.side,
    size: intent.size,
    reduceOnly: false,
  };
  return atMarket || intent.price === undefined
    ? { ...base, type: "market", maxSlippageBps }
    : { ...base, type: "limit", price: intent.price };
}

/**
 * The limit orders a scaled order comes to: its size in equal parts, at
 * prices spread evenly from `price` to `to`, each on the market's tick.
 * Nothing if a part would be under the market's minimum size.
 */
export function scaledOrders(
  order: Pick<
    Extract<Intent, { kind: "order" }>,
    "side" | "market" | "size" | "price" | "to" | "count"
  >,
): OrderRequest[] | undefined {
  const { market, count = DEFAULT_SCALE } = order;
  const from = Number(order.price);
  const until = Number(order.to);
  const tick = Number(market.tickSize);
  if (!(from > 0) || !(until > 0) || !(tick > 0) || count < 2) return undefined;
  const part = roundToStep(Number(order.size) / count, market.sizeStep);
  if (part.size <= 0 || part.size < Number(market.minSize)) return undefined;
  const places = decimalsOf(market.tickSize);
  return Array.from({ length: count }, (_, i) => {
    const raw = from + ((until - from) * i) / (count - 1);
    return {
      market: market.id,
      side: order.side,
      size: part.text,
      reduceOnly: false,
      type: "limit" as const,
      price: (Math.round(raw / tick + 1e-9) * tick).toFixed(places),
    };
  });
}

/** The change a tp/sl command makes: that exit set or removed, the rest kept. */
export function protectionFor(intent: Extract<Intent, { kind: "protect" }>): PositionProtection {
  const change = intent.price
    ? ({ action: "set", price: intent.price } as const)
    : ({ action: "remove" } as const);
  const keep = { action: "keep" } as const;
  return {
    takeProfit: intent.exit === "tp" ? change : keep,
    stopLoss: intent.exit === "sl" ? change : keep,
    trailingStop: keep,
  };
}

/**
 * The markets a search finds, best first: the coin or id starting with the
 * query, then containing it. At most `limit`.
 */
export function searchMarkets(query: string, markets: readonly Market[], limit = 6): Market[] {
  const q = query.trim().toUpperCase();
  if (!q || /\s/.test(q)) return [];
  const rank = (m: Market) => {
    const names = [m.base.toUpperCase(), m.id.toUpperCase(), m.symbol.toUpperCase()];
    if (names[0] === q) return 0;
    if (names.some((n) => n === q)) return 1;
    if (names[0]?.startsWith(q)) return 2;
    if (names.some((n) => n.startsWith(q))) return 3;
    return names.some((n) => n.includes(q)) ? 4 : -1;
  };
  return markets
    .map((m, i) => ({ m, i, r: rank(m) }))
    .filter((x) => x.r >= 0)
    .sort((a, b) => a.r - b.r || a.i - b.i)
    .slice(0, limit)
    .map((x) => x.m);
}

const RECENT_KEY = "pd.commands.recent";
const MAX_RECENT = 6;

export interface RecentCommand {
  text: string;
  /** Milliseconds since the Unix epoch. */
  time: number;
}

/** The commands last run, newest first. */
export function loadRecent(): RecentCommand[] {
  try {
    const saved: unknown = JSON.parse(localStorage.getItem(RECENT_KEY) ?? "[]");
    if (!Array.isArray(saved)) return [];
    return saved
      .filter(
        (r): r is RecentCommand =>
          typeof r?.text === "string" && r.text.length <= 80 && typeof r?.time === "number",
      )
      .slice(0, MAX_RECENT);
  } catch {
    return [];
  }
}

/** `recent` with `text` at the front, once. */
export function withRecent(
  recent: readonly RecentCommand[],
  text: string,
  time: number,
): RecentCommand[] {
  const line = text.trim().toLowerCase();
  if (!line) return [...recent];
  return [{ text: line, time }, ...recent.filter((r) => r.text !== line)].slice(0, MAX_RECENT);
}

export function saveRecent(recent: readonly RecentCommand[]): void {
  try {
    localStorage.setItem(RECENT_KEY, JSON.stringify(recent));
  } catch {
    // Private mode or a full store: the list lasts for this session.
  }
}
