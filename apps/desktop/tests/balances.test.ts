import type { AccountSnapshot, Position } from "@pewterdesk/core";
import { describe, expect, it } from "vitest";
import type { AccountsState } from "../src/lib/account";
import { accountKey, balanceAccounts, figuresOf, shareOf, totals } from "../src/lib/balances";

const position = (unrealizedPnl: string) => ({ unrealizedPnl }) as Position;
const snapshot = (equity: string, available: string, pnls: string[]): AccountSnapshot =>
  ({
    equity,
    availableMargin: available,
    positions: pnls.map(position),
  }) as AccountSnapshot;

const state: AccountsState = {
  accounts: [
    { venue: "bybit", id: "123", name: "" },
    { venue: "hyperliquid", id: `0x${"a".repeat(40)}`, name: "Main" },
    { venue: "binance", id: "demo:77", name: "" },
    { venue: "aster", id: `0x${"b".repeat(40)}`, name: "" },
  ],
  active: {},
};

describe("balances", () => {
  it("works an account's figures out of its snapshot", () => {
    expect(figuresOf(snapshot("1100", "800", ["150", "-50"]))).toEqual({
      balance: 1000,
      unrealized: 100,
      equity: 1100,
      available: 800,
      positions: 2,
    });
  });

  it("lists the accounts on the venues turned on, in their order", () => {
    const listed = balanceAccounts(state, ["hyperliquid", "binance", "bybit"]);
    expect(listed.map((a) => a.venue)).toEqual(["hyperliquid", "binance", "bybit"]);
  });

  it("totals real funds and Demo Trading's apart", () => {
    const listed = balanceAccounts(state, ["bybit", "hyperliquid", "binance"]);
    const [bybit, hyper, demo] = listed;
    if (!bybit || !hyper || !demo) throw new Error("accounts");
    const figures = new Map([
      [accountKey(bybit), figuresOf(snapshot("500", "300", []))],
      [accountKey(hyper), figuresOf(snapshot("1500", "900", ["-20"]))],
      [accountKey(demo), figuresOf(snapshot("10000", "10000", []))],
    ]);
    const sums = totals(listed, figures);
    expect(sums.live.equity).toBe(2000);
    expect(sums.live.unrealized).toBe(-20);
    expect(sums.demo.equity).toBe(10000);
    expect(sums.counted).toEqual({ live: 2, demo: 1 });
  });

  it("gives each account its share of its total", () => {
    expect(shareOf(500, 2000)).toBe(0.25);
    expect(shareOf(0, 2000)).toBe(0);
    expect(shareOf(-5, 2000)).toBe(0);
    expect(shareOf(10, 0)).toBeUndefined();
  });
});
