import type { Market, Order, OrderRequest, Position } from "@pewterdesk/core";
import { roundToStep } from "@pewterdesk/ui";

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
    }
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

/**
 * Reads a command:
 *
 * - `buy 100 hype at 38.2`, `sell 0.5 eth`, `long btc 0.01 @ 80,000`: an
 *   order, at a limit if a price follows, at market if not. Without a coin
 *   it's the market on screen.
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
    // The price is whatever follows "at" or "@" ("@38.2" too).
    let price: string | undefined;
    const at = rest.findIndex((w) => w === "at" || w.startsWith("@"));
    if (at !== -1) {
      const word = rest[at] === "at" || rest[at] === "@" ? rest[at + 1] : rest[at]?.slice(1);
      price = amount(word);
      if (!price) return undefined;
      rest.length = at;
    }
    if (rest.length === 0 || rest.length > 2) return undefined;
    // The size and the coin, in either order.
    const sizeWord = rest.find((w) => amount(w));
    const coinWord = rest.find((w) => !amount(w));
    if (!sizeWord || rest.length - (coinWord ? 1 : 0) !== 1) return undefined;
    const market = coinWord ? findMarket(coinWord, ctx.markets) : ctx.current;
    if (!market) return undefined;
    const size = roundToStep(Number(amount(sizeWord)), market.sizeStep);
    if (size.size <= 0 || size.size < Number(market.minSize)) return undefined;
    return { kind: "order", side, market, size: size.text, price };
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
