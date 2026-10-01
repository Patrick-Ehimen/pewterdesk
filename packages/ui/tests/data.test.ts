import type { AccountSnapshot, OrderBook, Position } from "@pewterdesk/core";
import { describe, expect, it } from "vitest";
import { accountTotals, ratioLevel } from "../src/components/trading/AccountSummary";
import { bookLadder, changedLevels, levelSizes } from "../src/components/trading/OrderBookView";
import { formatNumber, formatSigned } from "../src/lib/format";

const book: OrderBook = {
  market: "HYPE",
  bids: [
    { price: "38.39", size: "10" },
    { price: "38.38", size: "30" },
    { price: "38.37", size: "5" },
  ],
  asks: [
    { price: "38.41", size: "20" },
    { price: "38.42", size: "40" },
  ],
  time: 0,
};

describe("bookLadder", () => {
  it("accumulates totals from the spread outwards and puts the best ask last", () => {
    const ladder = bookLadder(book, 10);
    expect(ladder.asks.map((r) => [r.price, r.total])).toEqual([
      ["38.42", 60],
      ["38.41", 20],
    ]);
    expect(ladder.bids.map((r) => [r.price, r.total])).toEqual([
      ["38.39", 10],
      ["38.38", 40],
      ["38.37", 45],
    ]);
  });

  it("shows running totals as finely as the sizes, not rounded to whole units", () => {
    // A HYPE book's sizes are whole units.
    expect(bookLadder(book, 10).sizeDecimals).toBe(0);
    // A BTC book's are thousandths: 0.012 + 0.071 must not show as 0.
    const btc: OrderBook = {
      market: "BTC",
      bids: [
        { price: "83250", size: "0.012" },
        { price: "83249", size: "0.071" },
      ],
      asks: [{ price: "83251", size: "0.5" }],
      time: 0,
    };
    const ladder = bookLadder(btc, 10);
    expect(ladder.sizeDecimals).toBe(3);
    expect(formatNumber(ladder.bids[1]?.total ?? 0, ladder.sizeDecimals)).toBe("0.083");
    // A dust level can't widen the column past five places.
    const dust = { ...btc, bids: [{ price: "83250", size: "0.00000001" }] };
    expect(bookLadder(dust, 10).sizeDecimals).toBe(5);
  });

  it("accumulates value for the average fill price", () => {
    const [first, second] = bookLadder(book, 10).bids;
    expect(first?.notional).toBeCloseTo(38.39 * 10);
    expect(second?.notional).toBeCloseTo(38.39 * 10 + 38.38 * 30);
    // Average fill to the second level sits between the two prices.
    expect((second?.notional ?? 0) / (second?.total ?? 1)).toBeCloseTo(
      (38.39 * 10 + 38.38 * 30) / 40,
    );
  });

  it("scales depth bars against the deeper side", () => {
    const ladder = bookLadder(book, 10);
    expect(ladder.asks[0]?.depth).toBe(1);
    expect(ladder.bids[2]?.depth).toBe(45 / 60);
  });

  it("caps each side at the requested depth", () => {
    const ladder = bookLadder(book, 1);
    expect(ladder.bids).toHaveLength(1);
    expect(ladder.asks).toHaveLength(1);
  });

  it("computes mid and spread from the best levels", () => {
    const ladder = bookLadder(book, 10);
    expect(ladder.mid).toBeCloseTo(38.4);
    expect(ladder.spread).toBeCloseTo(0.02);
    expect(ladder.spreadBps).toBeCloseTo((0.02 / 38.4) * 10_000);
    // Prices here have 2 places, so the mid (38.40) shows at 2 too.
    expect(ladder.midDecimals).toBe(2);
  });

  it("measures the bid share across the whole book, whatever the depth shown", () => {
    // Bids 10 + 30 + 5 = 45, asks 20 + 40 = 60.
    expect(bookLadder(book, 10).bidShare).toBeCloseTo(45 / 105);
    expect(bookLadder(book, 1).bidShare).toBeCloseTo(45 / 105);
  });

  it("reports an all-bid book as a bid share of 1, and an empty book as none", () => {
    expect(bookLadder({ ...book, asks: [] }, 10).bidShare).toBe(1);
    expect(bookLadder({ ...book, bids: [], asks: [] }, 10).bidShare).toBeUndefined();
  });

  it("leaves mid undefined when a side is empty", () => {
    const ladder = bookLadder({ ...book, asks: [] }, 10);
    expect(ladder.mid).toBeUndefined();
    expect(ladder.asks).toEqual([]);
  });
});

const position = (unrealizedPnl: string, margin: string): Position => ({
  venue: "hyperliquid",
  market: "HYPE",
  side: "long",
  size: "1",
  entryPrice: "1",
  markPrice: "1",
  unrealizedPnl,
  margin,
});

describe("accountTotals", () => {
  const snapshot: AccountSnapshot = {
    venue: "hyperliquid",
    address: "0x0000000000000000000000000000000000000000",
    equity: "1000",
    availableMargin: "700",
    positions: [position("50.5", "200"), position("-20.5", "100")],
    openOrders: [],
    time: 0,
  };

  it("sums PnL and margin across positions", () => {
    expect(accountTotals(snapshot)).toEqual({
      equity: 1000,
      available: 700,
      unrealizedPnl: 30,
      marginUsed: 300,
      marginRatio: 0.3,
      notional: 2,
      // Half of each position's margin, with no leverage limits to go on.
      maintenanceMargin: 150,
      maintenanceRatio: 0.15,
      leverage: 0.002,
    });
  });

  it("takes maintenance margin from each market's maximum leverage", () => {
    const big: AccountSnapshot = {
      ...snapshot,
      positions: [{ ...position("0", "500"), size: "10", markPrice: "400" }],
    };
    // 4,000 of notional at 20x max: 1/40 of it, 100, is 10% of 1,000 equity.
    const totals = accountTotals(big, () => 20);
    expect(totals.maintenanceMargin).toBe(100);
    expect(totals.maintenanceRatio).toBeCloseTo(0.1);
    expect(totals.leverage).toBe(4);
  });

  it("grades the margin ratio for the gauge", () => {
    expect(ratioLevel(0)).toBe("safe");
    expect(ratioLevel(0.5)).toBe("warn");
    expect(ratioLevel(0.8)).toBe("danger");
  });

  it("reports a zero margin ratio for an empty account", () => {
    expect(accountTotals({ ...snapshot, equity: "0", positions: [] }).marginRatio).toBe(0);
  });
});

describe("format", () => {
  it("keeps the venue's precision by default", () => {
    expect(formatNumber("38.300")).toBe("38.300");
    expect(formatNumber("12486.3")).toBe("12,486.3");
  });

  it("signs positive values only", () => {
    expect(formatSigned(121.5)).toBe("+121.50");
    expect(formatSigned(-17.64)).toBe("-17.64");
    expect(formatSigned(0)).toBe("0.00");
  });
});

describe("level flashes", () => {
  it("flags new levels and changed sizes, not unchanged ones", () => {
    const next: OrderBook = {
      ...book,
      bids: [
        { price: "38.39", size: "10" }, // unchanged
        { price: "38.38", size: "31" }, // size changed
        { price: "38.36", size: "5" }, // new level (38.37 left)
      ],
      asks: [
        { price: "38.41", size: "20" },
        { price: "38.42", size: "40" },
      ],
    };
    expect(changedLevels(levelSizes(book), levelSizes(next)).sort()).toEqual([
      "bid:38.36",
      "bid:38.38",
    ]);
  });

  it("keeps bids and asks at the same price apart", () => {
    const crossed: OrderBook = { ...book, asks: [{ price: "38.39", size: "10" }] };
    expect(levelSizes(crossed).get("ask:38.39")).toBe("10");
    expect(levelSizes(crossed).get("bid:38.39")).toBe("10");
    expect(changedLevels(levelSizes(book), levelSizes(crossed))).toEqual(["ask:38.39"]);
  });
});
