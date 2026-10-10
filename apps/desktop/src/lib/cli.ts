import type { Market, Order, OrderRequest, Position, PositionProtection } from "@pewterdesk/core";
import { closeOrder } from "@pewterdesk/ui";
import {
  type CommandContext,
  findMarket,
  type Intent,
  orderFor,
  parseCommand,
  protectionFor,
  scaledOrders,
} from "./commands";
import { closeRequest } from "./float";
import { MENU_PAGES, type Page } from "./pages";

/**
 * What a line typed into the CLI panel asks for. The trading lines are the
 * command palette's own (`commands.ts`); the rest read the account, show a
 * market or open a page. Reading a line does nothing: the panel prints what
 * a trading line would send and waits for Enter before it sends.
 */
export type CliCommand =
  | { kind: "help" }
  | { kind: "clear" }
  | { kind: "positions" }
  | { kind: "orders" }
  | { kind: "balance" }
  | { kind: "price"; market: Market }
  | { kind: "market"; market: Market }
  | { kind: "page"; page: Page }
  | { kind: "trade"; intent: Intent }
  /** A coin or page that isn't one. */
  | { kind: "missing"; what: "market" | "page"; word: string }
  | { kind: "unknown" };

const WORDS: Record<string, "help" | "clear" | "positions" | "orders" | "balance"> = {
  help: "help",
  "?": "help",
  clear: "clear",
  cls: "clear",
  positions: "positions",
  pos: "positions",
  orders: "orders",
  balance: "balance",
  bal: "balance",
  equity: "balance",
};

/** A page by its name in a command: "portfolio", "charts", "rules". */
const pageNamed = (word: string): Page | undefined =>
  [...MENU_PAGES, "settings" as const].find((page) => page === word);

export function parseLine(text: string, ctx: CommandContext): CliCommand | undefined {
  const words = text.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const [first, second] = words;
  if (!first) return undefined;
  const plain = words.length === 1 ? WORDS[first] : undefined;
  if (plain) return { kind: plain };
  if (first === "price" || first === "p" || first === "market" || first === "m") {
    // Without a coin: the market on screen.
    const market = second ? findMarket(second, ctx.markets, ctx.current) : ctx.current;
    if (!market) return { kind: "missing", what: "market", word: second ?? "" };
    return { kind: first === "price" || first === "p" ? "price" : "market", market };
  }
  if (first === "go" || first === "page") {
    const page = second ? pageNamed(second) : undefined;
    return page ? { kind: "page", page } : { kind: "missing", what: "page", word: second ?? "" };
  }
  const intent = parseCommand(text, ctx);
  return intent ? { kind: "trade", intent } : { kind: "unknown" };
}

/** What a trading line comes to, to send once it's confirmed. */
export type CliAction =
  | { kind: "orders"; requests: OrderRequest[] }
  | { kind: "cancel"; orders: Order[] }
  | { kind: "protect"; position: Position; protection: PositionProtection };

/**
 * The requests an intent turns into: a price makes a limit order (or a
 * ladder of them), none a market order within the venue's slippage bound.
 * Closing and taking part off are reduce-only.
 */
export function actionFor(intent: Intent, maxSlippageBps: number): CliAction {
  switch (intent.kind) {
    case "order":
      return {
        kind: "orders",
        // A ladder where the line gives a range; else the one order.
        requests: (intent.to ? scaledOrders(intent) : undefined) ?? [
          orderFor(intent, maxSlippageBps, intent.price === undefined),
        ],
      };
    case "reduce": {
      const base = closeRequest(intent.position, intent.market, intent.fraction, maxSlippageBps);
      return {
        kind: "orders",
        requests: [
          intent.price
            ? {
                market: base.market,
                side: base.side,
                size: base.size,
                reduceOnly: true,
                type: "limit",
                price: intent.price,
              }
            : base,
        ],
      };
    }
    case "close":
      return {
        kind: "orders",
        requests: [closeOrder(intent.position, { type: "market", maxSlippageBps })],
      };
    case "protect":
      return { kind: "protect", position: intent.position, protection: protectionFor(intent) };
    case "cancel":
      return { kind: "cancel", orders: intent.orders };
  }
}

/** The lines typed before, newest last, without repeats in a row. */
export function withHistory(history: readonly string[], line: string, max = 50): string[] {
  const text = line.trim();
  if (!text || history.at(-1) === text) return [...history];
  return [...history, text].slice(-max);
}

/** A line on the panel's screen: what was typed, or what came back. */
export interface CliLine {
  id: number;
  tone: "in" | "out" | "ok" | "warn" | "err" | "dim";
  text: string;
}

/**
 * What the panel had on it, kept while the app runs: leaving the Trade page
 * (or reloading) takes the panel down, and this brings it back as it was.
 */
export interface CliSession {
  lines: CliLine[];
  history: string[];
  /** What was typed and not yet entered. */
  input: string;
  /** A trading line was waiting on Enter: it doesn't wait across a leave. */
  pending: boolean;
}

const SESSION_KEY = "pd.cli";
const TONES: readonly CliLine["tone"][] = ["in", "out", "ok", "warn", "err", "dim"];

/** A kept session, as far as it reads. */
export function restoreSession(saved: unknown): CliSession | undefined {
  if (typeof saved !== "object" || saved === null) return undefined;
  const raw = saved as Record<string, unknown>;
  if (!Array.isArray(raw.lines)) return undefined;
  const lines = raw.lines.flatMap((line: unknown, id): CliLine[] => {
    const l = (typeof line === "object" && line !== null ? line : {}) as Record<string, unknown>;
    const tone = TONES.find((tone) => tone === l.tone);
    // Numbered again in order, so ids stay one of a kind.
    return tone && typeof l.text === "string" ? [{ id, tone, text: l.text }] : [];
  });
  return {
    lines,
    history: Array.isArray(raw.history)
      ? raw.history.filter((h): h is string => typeof h === "string")
      : [],
    input: typeof raw.input === "string" ? raw.input : "",
    pending: raw.pending === true,
  };
}

/** In the session's storage, which lasts until the app is closed. */
export function loadSession(): CliSession | undefined {
  try {
    return restoreSession(JSON.parse(sessionStorage.getItem(SESSION_KEY) ?? "null"));
  } catch {
    return undefined;
  }
}

export function saveSession(session: CliSession) {
  try {
    sessionStorage.setItem(SESSION_KEY, JSON.stringify(session));
  } catch {
    // Storage unavailable; the panel just starts over next time.
  }
}
