import type { Market, OrderRequest } from "@pewterdesk/core";
import { positionFills } from "@pewterdesk/ui";
import { describe, expect, it } from "vitest";
import {
  cancelOrder,
  type Fees,
  isPaperVenue,
  newPaperState,
  type PaperState,
  placeOrder,
  protectPosition,
  type Quotes,
  setLeverage,
  setMarginMode,
  snapshot,
  tick,
  totals,
} from "../src/lib/paper";

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
const MARKETS = new Map([[BTC.id, BTC]]);
const FEES: Fees = { taker: 0.00045, maker: 0.00015 };
const T = Date.UTC(2026, 9, 15, 10, 30);

const at = (mark: number, spread = 10): Quotes => ({
  BTC: { mark, bid: mark - spread / 2, ask: mark + spread / 2 },
});
const market = (side: "buy" | "sell", size: string, extra: Partial<OrderRequest> = {}) =>
  ({
    market: "BTC",
    side,
    size,
    reduceOnly: false,
    type: "market",
    maxSlippageBps: 50,
    ...extra,
  }) as OrderRequest;
const limit = (side: "buy" | "sell", size: string, price: string, extra = {}) =>
  ({
    market: "BTC",
    side,
    size,
    reduceOnly: false,
    type: "limit",
    price,
    ...extra,
  }) as OrderRequest;

function ok(result: { state: PaperState; error?: string }) {
  expect(result.error).toBeUndefined();
  return result.state;
}

describe("which venues", () => {
  it("is only the ones without a demo of their own", () => {
    expect(isPaperVenue("hyperliquid")).toBe(true);
    expect(isPaperVenue("aster")).toBe(true);
    expect(isPaperVenue("bybit")).toBe(false);
  });
});

describe("market orders", () => {
  it("buy at the ask and pay the taker fee", () => {
    const s = ok(
      placeOrder(newPaperState("hyperliquid"), market("buy", "0.1"), BTC, at(100_000), FEES, T),
    );
    const p = s.positions[0];
    expect(p).toMatchObject({ side: "long", size: 0.1, entry: 100_005 });
    expect(s.cash).toBeCloseTo(10_000 - 0.1 * 100_005 * FEES.taker, 6);
    expect(s.fills[0]).toMatchObject({ side: "buy", effect: "openLong", taker: true });
    expect(s.history[0]?.status).toBe("filled");
  });

  it("are refused without the margin for them", () => {
    const r = placeOrder(
      newPaperState("hyperliquid"),
      market("buy", "5"),
      BTC,
      at(100_000),
      FEES,
      T,
    );
    expect(r.error).toBe("margin");
  });

  it("never fill past their slippage bound", () => {
    const r = placeOrder(
      newPaperState("hyperliquid"),
      market("buy", "0.01", { maxSlippageBps: 1 }),
      BTC,
      at(100_000, 100),
      FEES,
      T,
    );
    expect(r.error).toBe("price");
    expect(r.state.positions).toHaveLength(0);
  });

  it("round the size down to the market's step, and refuse what's below its minimum", () => {
    const s = ok(
      placeOrder(newPaperState("hyperliquid"), market("buy", "0.0109"), BTC, at(100_000), FEES, T),
    );
    expect(s.positions[0]?.size).toBeCloseTo(0.01, 9);
    expect(
      placeOrder(newPaperState("hyperliquid"), market("buy", "0.0004"), BTC, at(100_000), FEES, T)
        .error,
    ).toBe("size");
  });
});

describe("limit orders", () => {
  it("rest below the market, then fill at their price as a maker", () => {
    let s = ok(
      placeOrder(
        newPaperState("hyperliquid"),
        limit("buy", "0.1", "99000"),
        BTC,
        at(100_000),
        FEES,
        T,
      ),
    );
    expect(s.orders).toHaveLength(1);
    expect(snapshot(s, at(100_000), MARKETS, T).openOrders[0]).toMatchObject({
      status: "open",
      price: "99000",
    });
    s = tick(s, at(99_500), MARKETS, FEES, T + 1000);
    expect(s.orders).toHaveLength(1);
    s = tick(s, at(98_900), MARKETS, FEES, T + 2000);
    expect(s.orders).toHaveLength(0);
    expect(s.positions[0]).toMatchObject({ entry: 99_000, size: 0.1 });
    expect(s.fills[0]?.taker).toBe(false);
  });

  it("that cross the book fill at once, or are refused if post-only", () => {
    const filled = ok(
      placeOrder(
        newPaperState("hyperliquid"),
        limit("buy", "0.1", "101000"),
        BTC,
        at(100_000),
        FEES,
        T,
      ),
    );
    expect(filled.positions[0]?.entry).toBe(100_005);
    const post = placeOrder(
      newPaperState("hyperliquid"),
      limit("buy", "0.1", "101000", { timeInForce: "postOnly" }),
      BTC,
      at(100_000),
      FEES,
      T,
    );
    expect(post.error).toBe("postOnly");
    expect(post.state.positions).toHaveLength(0);
  });

  it("can be cancelled, and hold margin while they rest", () => {
    const s = ok(
      placeOrder(
        newPaperState("hyperliquid"),
        limit("buy", "0.5", "90000"),
        BTC,
        at(100_000),
        FEES,
        T,
      ),
    );
    expect(totals(s, at(100_000)).available).toBeLessThan(10_000);
    const id = s.orders[0]?.id ?? "";
    const c = ok(cancelOrder(s, id));
    expect(c.orders).toHaveLength(0);
    expect(c.history[0]?.status).toBe("cancelled");
    expect(cancelOrder(c, id).error).toBe("notFound");
  });
});

describe("closing", () => {
  const opened = () =>
    ok(placeOrder(newPaperState("hyperliquid"), market("buy", "0.1"), BTC, at(100_000), FEES, T));

  it("realises the P&L and records a closed trade", () => {
    const s = ok(placeOrder(opened(), market("sell", "0.1"), BTC, at(101_000), FEES, T + 60_000));
    expect(s.positions).toHaveLength(0);
    const gross = (100_995 - 100_005) * 0.1;
    expect(s.closed[0]?.side).toBe("long");
    expect(Number(s.closed[0]?.closedPnl)).toBeLessThan(gross);
    expect(s.cash).toBeGreaterThan(10_000);
    expect(s.fills[0]?.effect).toBe("closeLong");
  });

  it("flips a position when the order is bigger than it", () => {
    const s = ok(placeOrder(opened(), market("sell", "0.3"), BTC, at(100_000), FEES, T));
    expect(s.positions[0]).toMatchObject({ side: "short" });
    expect(s.positions[0]?.size).toBeCloseTo(0.2, 9);
    expect(s.fills[0]?.effect).toBe("longToShort");
  });

  it("reduce-only needs a position to reduce, and never flips", () => {
    expect(
      placeOrder(
        newPaperState("hyperliquid"),
        market("sell", "0.1", { reduceOnly: true }),
        BTC,
        at(100_000),
        FEES,
        T,
      ).error,
    ).toBe("reduceOnly");
    const s = ok(
      placeOrder(opened(), market("sell", "1", { reduceOnly: true }), BTC, at(100_000), FEES, T),
    );
    expect(s.positions).toHaveLength(0);
  });
});

describe("exits", () => {
  it("an attached stop-loss closes the position when the mark reaches it", () => {
    let s = ok(
      placeOrder(
        newPaperState("hyperliquid"),
        market("buy", "0.1", { stopLoss: "98000" }),
        BTC,
        at(100_000),
        FEES,
        T,
      ),
    );
    expect(s.positions[0]?.stopLoss).toBe(98_000);
    s = tick(s, at(98_500), MARKETS, FEES, T + 1000);
    expect(s.positions).toHaveLength(1);
    s = tick(s, at(97_900), MARKETS, FEES, T + 2000);
    expect(s.positions).toHaveLength(0);
    expect(s.closed[0]?.side).toBe("long");
  });

  it("a take-profit set later closes it too", () => {
    let s = ok(
      placeOrder(newPaperState("hyperliquid"), market("buy", "0.1"), BTC, at(100_000), FEES, T),
    );
    s = ok(
      protectPosition(s, "BTC", {
        takeProfit: { action: "set", price: "102000" },
        stopLoss: { action: "keep" },
        trailingStop: { action: "keep" },
      }),
    );
    s = tick(s, at(102_100), MARKETS, FEES, T + 1000);
    expect(s.positions).toHaveLength(0);
    expect(Number(s.closed[0]?.closedPnl)).toBeGreaterThan(0);
  });

  it("a trailing stop follows the high and closes on the way back", () => {
    let s = ok(
      placeOrder(newPaperState("hyperliquid"), market("buy", "0.1"), BTC, at(100_000), FEES, T),
    );
    s = ok(
      protectPosition(s, "BTC", {
        takeProfit: { action: "keep" },
        stopLoss: { action: "keep" },
        trailingStop: { action: "set", price: "500" },
      }),
    );
    s = tick(s, at(100_000), MARKETS, FEES, T + 1000);
    s = tick(s, at(101_000), MARKETS, FEES, T + 2000);
    s = tick(s, at(100_600), MARKETS, FEES, T + 3000);
    expect(s.positions).toHaveLength(1);
    s = tick(s, at(100_400), MARKETS, FEES, T + 4000);
    expect(s.positions).toHaveLength(0);
  });

  it("a stop trigger fires as a market order", () => {
    let s = ok(
      placeOrder(
        newPaperState("hyperliquid"),
        {
          market: "BTC",
          side: "buy",
          size: "0.1",
          reduceOnly: false,
          type: "trigger",
          triggerPrice: "101000",
        },
        BTC,
        at(100_000),
        FEES,
        T,
      ),
    );
    expect(s.orders[0]?.triggerAbove).toBe(true);
    s = tick(s, at(101_200), MARKETS, FEES, T + 1000);
    expect(s.orders).toHaveLength(0);
    expect(s.positions[0]?.side).toBe("long");
  });

  it("a position past its liquidation price is closed there", () => {
    let s = setLeverage(newPaperState("hyperliquid"), BTC, 20);
    s = ok(placeOrder(s, market("buy", "1.5"), BTC, at(100_000), FEES, T));
    const liq = Number(snapshot(s, at(100_000), MARKETS, T).positions[0]?.liquidationPrice);
    expect(liq).toBeGreaterThan(90_000);
    expect(liq).toBeLessThan(100_000);
    s = tick(s, at(liq - 10), MARKETS, FEES, T + 1000);
    expect(s.positions).toHaveLength(0);
  });
});

describe("funding and settings", () => {
  it("pays funding once per interval: a long pays a positive rate", () => {
    let s = ok(
      placeOrder(newPaperState("hyperliquid"), market("buy", "0.1"), BTC, at(100_000), FEES, T),
    );
    const q: Quotes = { BTC: { mark: 100_000, fundingRate: 0.0001, fundingIntervalSecs: 3600 } };
    s = tick(s, q, MARKETS, FEES, T + 1000);
    expect(s.funding).toHaveLength(0);
    const before = s.cash;
    s = tick(s, q, MARKETS, FEES, T + 3600_000);
    expect(s.funding).toHaveLength(1);
    expect(s.cash).toBeCloseTo(before - 0.1 * 100_000 * 0.0001, 6);
    s = tick(s, q, MARKETS, FEES, T + 3600_000 + 1000);
    expect(s.funding).toHaveLength(1);
  });

  it("keeps leverage within the market's, and margin mode only without a position", () => {
    expect(setLeverage(newPaperState("hyperliquid"), BTC, 500).settings.BTC?.leverage).toBe(40);
    const s = ok(
      placeOrder(newPaperState("hyperliquid"), market("buy", "0.01"), BTC, at(100_000), FEES, T),
    );
    expect(setMarginMode(s, BTC, "isolated").error).toBe("hasPosition");
    expect(
      ok(setMarginMode(newPaperState("hyperliquid"), BTC, "isolated")).settings.BTC?.marginMode,
    ).toBe("isolated");
  });

  it("reports equity with the open P&L in it", () => {
    const s = ok(
      placeOrder(newPaperState("hyperliquid"), market("buy", "0.1"), BTC, at(100_000), FEES, T),
    );
    const snap = snapshot(s, at(101_000), MARKETS, T);
    expect(Number(snap.equity)).toBeCloseTo(s.cash + (101_000 - 100_005) * 0.1, 4);
    expect(snap.address).toBe("paper");
  });
});

describe("the position drawer", () => {
  it("finds the fills that built a paper position, and when it opened", () => {
    let s = ok(
      placeOrder(newPaperState("hyperliquid"), market("buy", "0.1"), BTC, at(100_000), FEES, T),
    );
    s = ok(placeOrder(s, market("buy", "0.05"), BTC, at(100_500), FEES, T + 60_000));
    const position = snapshot(s, at(100_500), MARKETS, T + 60_000).positions[0];
    if (!position) throw new Error("no position");
    const found = positionFills(s.fills, position);
    expect(found.fills).toHaveLength(2);
    expect(found.openedAt).toBe(T);
  });
});
