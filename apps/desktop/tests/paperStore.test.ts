import type { Market, OrderRequest } from "@pewterdesk/core";
import { describe, expect, it, vi } from "vitest";
import {
  adjustFunds,
  newPaperState,
  PAPER_ADD_MAX,
  PAPER_START,
  placeOrder,
  type Quotes,
  snapshot,
} from "../src/lib/paper";

const store = new Map<string, string>();
vi.stubGlobal("localStorage", {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => void store.set(k, v),
  removeItem: (k: string) => void store.delete(k),
});
vi.stubGlobal("window", { addEventListener: () => {}, removeEventListener: () => {} });
const { paperAccount, resetPaperAccount, savePaperAccount } = await import("../src/lib/paperStore");

const BTC: Market = {
  venue: "hyperliquid",
  id: "BTC",
  symbol: "BTC-USDC",
  base: "BTC",
  quote: "USDC",
  tickSize: "1",
  sizeStep: "0.001",
  minSize: "0.001",
  maxLeverage: 40,
};
const Q: Quotes = { BTC: { mark: 100_000, bid: 99_995, ask: 100_005 } };
const FEES = { taker: 0.00045, maker: 0.00015 };
const buy = (size: string, type: "market" | "limit" = "market") =>
  ({
    market: "BTC",
    side: "buy",
    size,
    reduceOnly: false,
    ...(type === "market" ? { type, maxSlippageBps: 50 } : { type, price: "90000" }),
  }) as OrderRequest;

describe("reset", () => {
  it("leaves nothing behind: no positions, orders or history, and the default balance", () => {
    let s = newPaperState("hyperliquid");
    s = placeOrder(s, buy("0.1"), BTC, Q, FEES, 1).state;
    s = placeOrder(s, buy("0.1", "limit"), BTC, Q, FEES, 2).state;
    s = adjustFunds(s, 5_000, Q).state;
    savePaperAccount(s);
    expect(paperAccount("hyperliquid").positions).toHaveLength(1);
    expect(paperAccount("hyperliquid").orders).toHaveLength(1);

    resetPaperAccount("hyperliquid", PAPER_START);
    const after = paperAccount("hyperliquid");
    expect(after).toMatchObject({ cash: PAPER_START, start: PAPER_START });
    for (const list of [after.positions, after.orders, after.fills, after.closed, after.history]) {
      expect(list).toHaveLength(0);
    }
    expect(after.funding).toHaveLength(0);
    expect(after.settings).toEqual({});
  });

  it("is per venue", () => {
    savePaperAccount(
      placeOrder(newPaperState("aster"), buy("0.1"), { ...BTC, venue: "aster" }, Q, FEES, 1).state,
    );
    resetPaperAccount("hyperliquid", PAPER_START);
    expect(paperAccount("aster").positions).toHaveLength(1);
  });
});

describe("funds", () => {
  it("adding raises the balance without counting as P&L", () => {
    const s = adjustFunds(newPaperState("hyperliquid"), 2_500, Q).state;
    expect(s.cash).toBe(12_500);
    const snap = snapshot(s, Q, new Map([["BTC", BTC]]), 0);
    expect(Number(snap.equity)).toBe(12_500);
    expect(Number(snap.realizedPnl)).toBe(0);
  });

  it("adds at most the cap at once, and at least one unit", () => {
    expect(adjustFunds(newPaperState("hyperliquid"), PAPER_ADD_MAX + 1, Q).error).toBe("amount");
    expect(adjustFunds(newPaperState("hyperliquid"), 0.5, Q).error).toBe("amount");
  });

  it("takes out only what isn't held as margin", () => {
    // 0.5 BTC at 10x holds about 5,000 of the 10,000.
    const s = placeOrder(newPaperState("hyperliquid"), buy("0.5"), BTC, Q, FEES, 1).state;
    expect(adjustFunds(s, -9_000, Q).error).toBe("tooMuch");
    const out = adjustFunds(s, -4_000, Q);
    expect(out.error).toBeUndefined();
    expect(out.state.cash).toBeCloseTo(s.cash - 4_000, 6);
    expect(out.state.start).toBe(PAPER_START - 4_000);
  });
});
