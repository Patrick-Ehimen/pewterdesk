import { readFileSync, writeFileSync } from "node:fs";
import type { Market, Order, Position } from "@pewterdesk/core";
import { describe, expect, it } from "vitest";
import { type CliCommand, parseLine } from "../src/lib/cli";
import { type CommandContext, type Intent, parseCommand } from "../src/lib/commands";
import { PAGES } from "../src/lib/pages";

// The command language's contract, shared with the Rust parser in
// `crates/protocol` (docs/bots/cli.md): every line in
// `tests/fixtures/commands.json`, read by both, must parse to the same thing.
// The wire shape names markets and orders by id. `UPDATE_FIXTURES=1` writes
// the file from this parser instead of checking it.

const FILE = new URL("../../../tests/fixtures/commands.json", import.meta.url);

const market = (base: string, sizeStep = "0.01", over: Partial<Market> = {}): Market => ({
  venue: "bybit",
  id: `${base}USDT`,
  symbol: `${base}-USDT`,
  base,
  quote: "USDT",
  tickSize: "0.1",
  sizeStep,
  minSize: sizeStep,
  maxLeverage: 50,
  ...over,
});
const position = (marketId: string, side: "long" | "short", size: string): Position => ({
  venue: "bybit",
  market: marketId,
  side,
  size,
  entryPrice: "100",
  markPrice: "100",
  unrealizedPnl: "0",
  margin: "20",
});

/** A context as the fixture keeps it: markets in full, the rest by id. */
interface FixtureContext {
  markets: Market[];
  current?: string;
  positions: { market: string; side: "long" | "short"; size: string }[];
  orders: { id: string; market: string }[];
}

const sol = (id: string, quote: string) =>
  market("SOL", "0.01", { id, symbol: id, quote, tickSize: "0.1" });

const CONTEXTS: Record<string, FixtureContext> = {
  main: {
    markets: [market("BTC", "0.001"), market("ETH"), market("HYPE"), market("HYPER")],
    current: "ETHUSDT",
    positions: [{ market: "ETHUSDT", side: "long", size: "2" }],
    orders: [
      { id: "1", market: "HYPEUSDT" },
      { id: "2", market: "HYPEUSDT" },
      { id: "3", market: "BTCUSDT" },
    ],
  },
  exits: {
    markets: [market("ETH", "0.01", { symbol: "ETHUSDT" })],
    current: "ETHUSDT",
    positions: [],
    orders: [],
  },
  sol: {
    markets: [sol("SOLPERP", "USDC"), sol("SOLUSDT", "USDT")],
    current: "SOLUSDT",
    positions: [],
    orders: [],
  },
  solPerp: {
    markets: [sol("SOLPERP", "USDC"), sol("SOLUSDT", "USDT")],
    current: "SOLPERP",
    positions: [],
    orders: [],
  },
  solDated: {
    markets: [sol("SOLPERP", "USDC"), sol("SOLUSDT-16OCT26", "USDT"), sol("SOLUSDT", "USDT")],
    positions: [],
    orders: [],
  },
  cli: {
    markets: [
      market("BTC", "0.001", { symbol: "BTCUSDT" }),
      market("ETH", "0.001", { symbol: "ETHUSDT" }),
    ],
    current: "BTCUSDT",
    positions: [{ market: "ETHUSDT", side: "long", size: "2" }],
    orders: [{ id: "o1", market: "BTCUSDT" }],
  },
  short: {
    markets: [market("BTC", "0.001"), market("ETH")],
    current: "BTCUSDT",
    positions: [{ market: "BTCUSDT", side: "short", size: "0.5" }],
    orders: [],
  },
  empty: { markets: [], positions: [], orders: [] },
};

/** The lines the palette and the CLI panel read, and some they don't. */
const COMMANDS: [string, string][] = [
  // Orders: limit, market, either word order, "@", thousands separators.
  ["main", "buy 100 hype at 38.2"],
  ["main", "Short BTC 0.0105 @ 80,000"],
  ["main", "sell 2 eth @2500"],
  ["main", "long 1.5"],
  ["main", "buy hype 100"],
  ["main", "  BUY   100   HYPE  "],
  ["main", "buy 0.001 btc"],
  ["main", "sell 0.0019 btc"],
  ["main", "buy 1,250.5 hype at 1,000"],
  ["main", "buy .5 eth"],
  ["main", "buy 100 hyper at 1"],
  ["main", "buy 100 HYPEUSDT"],
  ["main", "buy 100 hype-usdt"],
  // Not orders.
  ["main", "buy"],
  ["main", "buy hype"],
  ["main", "buy 100 nope"],
  ["main", "buy 0 hype"],
  ["main", "buy 0.0001 btc"],
  ["main", "buy 100 hype at"],
  ["main", "buy 100 hype at cheap"],
  ["main", "buy 100 200 hype"],
  ["main", "buy 100 hype now please"],
  ["main", "bought 100 hype"],
  ["main", "buy -1 hype"],
  ["main", "buy 1e3 hype"],
  ["main", ""],
  ["main", "   "],
  ["empty", "buy 1"],
  // Closing and cancelling.
  ["main", "close eth"],
  ["main", "close"],
  ["main", "close btc"],
  ["main", "close eth now"],
  ["main", "cancel all"],
  ["main", "cancel all hype"],
  ["main", "cancel btc"],
  ["main", "cancel eth"],
  ["main", "cancel"],
  ["main", "cancel all nope"],
  ["main", "cancel hype btc"],
  // A share of a position.
  ["main", "sell 50% eth"],
  ["main", "sell 100% eth at 2500"],
  ["main", "sell 33% eth"],
  ["main", "buy 50% eth"],
  ["main", "sell 50% btc"],
  ["main", "sell 150% eth"],
  ["main", "sell 0% eth"],
  ["main", "sell 50% eth at 2500 to 2400"],
  ["main", "sell 50% eth sl 2000"],
  ["short", "buy 25% btc"],
  ["short", "sell 25% btc"],
  // Exits.
  ["main", "tp eth 2600"],
  ["main", "sl off"],
  ["main", "sl eth remove"],
  ["main", "tp 2700"],
  ["main", "tp btc 90000"],
  ["main", "tp eth soon"],
  ["main", "tp"],
  ["main", "tp eth 2600 now"],
  // Scaled.
  ["main", "buy 100 hype at 38.2 to 37.8"],
  ["main", "sell 3 eth @2500 to 2600 x3"],
  ["main", "sell 3 eth at 2500 to 2600 in 2 orders"],
  ["main", "sell 3 eth at 2500 to 2600 x10"],
  ["main", "sell 3 eth at 2500 to 2600 4"],
  ["main", "buy 100 hype at 38.2 to 37.8 x50"],
  ["main", "buy 0.002 btc at 80000 to 79000 x5"],
  ["main", "buy 100 hype at 38.2 to 38.2"],
  ["main", "buy 100 hype at 38.2 37.8"],
  ["main", "buy 100 hype at 38.2 to 37.8 x1"],
  // Orders with exits.
  ["exits", "sell 10 eth sl 2600 tp 2300"],
  ["exits", "buy 1 eth sl 2300 at 2400"],
  ["exits", "buy 5 eth at 2400 to 2300 x5 sl 2200"],
  ["exits", "buy 1 eth sl"],
  ["exits", "buy 1 eth sl soon"],
  ["exits", "buy 1 eth"],
  ["exits", "buy 1 eth tp 2500"],
  // A coin with several markets.
  ["sol", "buy 0.5 sol"],
  ["solPerp", "buy 0.5 sol"],
  ["solPerp", "buy 0.5 solusdt"],
  ["solDated", "buy 0.5 sol"],
  // Algos.
  ["main", "chase buy 0.5 eth"],
  ["main", "chase sell eth 1 to 0.5% then market"],
  ["main", "chase buy 1 eth to 2%"],
  ["main", "chase buy 1 eth then market"],
  ["main", "chase 1 eth"],
  ["main", "chase buy 1 eth to 80%"],
  ["main", "chase buy 1 eth to 0%"],
  ["main", "chase buy 1 eth then limit to 1%"],
  ["main", "chase long 1"],
  ["main", "twap sell 10 eth over 30m"],
  ["main", "twap buy 2 btc 1h30m x6 chase"],
  ["main", "twap buy 2 btc in 2d"],
  ["main", "twap sell 10 eth"],
  ["main", "twap sell 10 eth 5s"],
  ["main", "twap sell 10 eth 8d"],
  ["main", "twap sell eth 30m"],
  ["main", "twap sell 10 eth 30m x0"],
  ["main", "twap sell 10 eth 30m x501"],
  ["main", "twap sell 10 eth 45s"],
  ["main", "halt"],
  ["main", "HALT"],
  ["main", "halt eth"],
];

/** The CLI panel's own lines (it reads the trading lines above too). */
const LINES: [string, string][] = [
  ["cli", "help"],
  ["cli", "?"],
  ["cli", "  POS "],
  ["cli", "orders"],
  ["cli", "bal"],
  ["cli", "equity"],
  ["cli", "clear"],
  ["cli", "cls"],
  ["cli", ""],
  ["cli", "dance"],
  ["cli", "help me"],
  ["cli", "price eth"],
  ["cli", "p"],
  ["cli", "market eth"],
  ["cli", "m"],
  ["cli", "price doge"],
  ["empty", "price"],
  ["cli", "go portfolio"],
  ["cli", "go settings"],
  ["cli", "page rules"],
  ["cli", "go nowhere"],
  ["cli", "go"],
  ["cli", "buy 0.01 btc"],
  ["cli", "sell 50% eth"],
  ["cli", "cancel all"],
  ["cli", "halt"],
];

function contextFor(name: string): CommandContext {
  const c = CONTEXTS[name];
  if (!c) throw new Error(`no context ${name}`);
  return {
    markets: c.markets,
    current: c.markets.find((m) => m.id === c.current),
    positions: c.positions.map((p) => position(p.market, p.side, p.size)),
    orders: c.orders.map((o) => ({ id: o.id, market: o.market }) as Order),
  };
}

/** Drops the keys a TS object leaves undefined: the wire omits them. */
function compact<T extends object>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as T;
}

/** An intent on the wire: markets and orders by id, numbers as decimals. */
function wire(intent: Intent | undefined): unknown {
  if (!intent) return null;
  switch (intent.kind) {
    case "order":
      return compact({ ...intent, market: intent.market.id });
    case "reduce":
      return compact({
        kind: "reduce",
        market: intent.market.id,
        fraction: String(intent.fraction),
        price: intent.price,
      });
    case "protect":
      return compact({
        kind: "protect",
        market: intent.market.id,
        exit: intent.exit,
        price: intent.price,
      });
    case "close":
      return { kind: "close", market: intent.position.market };
    case "cancel":
      return compact({
        kind: "cancel",
        market: intent.market?.id,
        orders: intent.orders.map((o) => o.id),
      });
    case "chase":
      return compact({
        ...intent,
        market: intent.market.id,
        giveUpPct: intent.giveUpPct === undefined ? undefined : String(intent.giveUpPct),
      });
    case "twap":
      return compact({ ...intent, market: intent.market.id });
    case "halt":
      return intent;
  }
}

function wireLine(line: CliCommand | undefined): unknown {
  if (!line) return null;
  switch (line.kind) {
    case "price":
    case "market":
      return { kind: line.kind, market: line.market.id };
    case "trade":
      return { kind: "trade", intent: wire(line.intent) };
    default:
      return line;
  }
}

function build() {
  return {
    note: "The command language's contract: apps/desktop/tests/commandFixtures.test.ts and crates/protocol both read it. Regenerate with UPDATE_FIXTURES=1.",
    version: 1,
    pages: [...PAGES],
    contexts: CONTEXTS,
    commands: COMMANDS.map(([context, line]) => ({
      context,
      line,
      intent: wire(parseCommand(line, contextFor(context))),
    })),
    lines: LINES.map(([context, line]) => ({
      context,
      line,
      result: wireLine(parseLine(line, contextFor(context))),
    })),
  };
}

describe("the shared command fixtures", () => {
  it("match what this parser reads", () => {
    const now = build();
    if (process.env.UPDATE_FIXTURES) {
      writeFileSync(FILE, `${JSON.stringify(now, null, 2)}\n`);
      return;
    }
    const kept = JSON.parse(readFileSync(FILE, "utf8"));
    expect(now).toEqual(kept);
  });
});
