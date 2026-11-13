import type { Market } from "@pewterdesk/core";
import { describe, expect, it } from "vitest";
import { coinOf, legRequest, type MultiTicket, marketForCoin, planLeg } from "./multiVenue";

const market = (over: Partial<Market>): Market => ({
  venue: "bybit",
  id: "SOLUSDT",
  symbol: "SOL-USDT",
  base: "SOL",
  quote: "USDT",
  tickSize: "0.01",
  sizeStep: "0.1",
  minSize: "0.1",
  maxLeverage: 50,
  ...over,
});

const ticket: MultiTicket = {
  side: "buy",
  style: "market",
  offsetPct: 0,
  riskPct: 1,
  balancePct: 10,
  stopPct: 2,
  targetPct: 4,
};

describe("coinOf", () => {
  it("reads the multiplier venues put in front of small coins", () => {
    expect(coinOf("kPEPE")).toEqual({ coin: "PEPE", units: 1000 });
    expect(coinOf("1000PEPE")).toEqual({ coin: "PEPE", units: 1000 });
    expect(coinOf("1000000MOG")).toEqual({ coin: "MOG", units: 1_000_000 });
  });
  it("leaves ordinary coins, and ones that start with a digit, alone", () => {
    expect(coinOf("SOL")).toEqual({ coin: "SOL", units: 1 });
    expect(coinOf("1INCH")).toEqual({ coin: "1INCH", units: 1 });
    expect(coinOf("kaito")).toEqual({ coin: "KAITO", units: 1 });
  });
});

describe("marketForCoin", () => {
  it("finds the coin under another venue's name for it", () => {
    const markets = [market({ id: "kPEPE", base: "kPEPE" }), market({ id: "SOL", base: "SOL" })];
    expect(marketForCoin(markets, "PEPE")?.id).toBe("kPEPE");
    expect(marketForCoin(markets, "DOGE")).toBeUndefined();
  });
  it("prefers the venue's own market to a builder-deployed one", () => {
    const markets = [
      market({ id: "xyz:SOL", base: "SOL", listedBy: "xyz" }),
      market({ id: "SOL", base: "SOL" }),
    ];
    expect(marketForCoin(markets, "SOL")?.id).toBe("SOL");
  });
});

describe("planLeg", () => {
  it("sizes each venue so its stop loses the same share of its own equity", () => {
    const small = planLeg(ticket, {
      market: market({}),
      price: 100,
      equity: 2_000,
      available: 2_000,
    });
    const big = planLeg(ticket, {
      market: market({}),
      price: 100,
      equity: 5_000,
      available: 5_000,
    });
    // 1% of 2,000 is 20; a 2% stop on 100 loses 2 a coin: 10 SOL.
    expect(small).toMatchObject({
      sizeText: "10.0",
      risk: 20,
      stopText: "98.00",
      targetText: "104.00",
    });
    expect(big.sizeText).toBe("25.0");
  });

  it("uses a share of what's available without a stop", () => {
    const plan = planLeg(
      { ...ticket, stopPct: 0 },
      { market: market({}), price: 100, equity: 2_000, available: 1_000 },
    );
    expect(plan.sizeText).toBe("1.0");
    expect(plan.risk).toBeUndefined();
  });

  it("puts a sell's stop above and its limit above the price", () => {
    const plan = planLeg(
      { ...ticket, side: "sell", style: "limit", offsetPct: 1 },
      { market: market({}), price: 100, equity: 2_000, available: 2_000 },
    );
    expect(plan.entryText).toBe("101.00");
    expect(Number(plan.stopText)).toBeGreaterThan(101);
  });

  it("says why a leg can't go", () => {
    const m = market({});
    expect(planLeg(ticket, { market: m, price: 0, equity: 1, available: 1 }).problem).toBe(
      "noPrice",
    );
    expect(planLeg(ticket, { market: m, price: 100, equity: 0, available: 0 }).problem).toBe(
      "noFunds",
    );
    expect(planLeg(ticket, { market: m, price: 100, equity: 5, available: 5 }).problem).toBe(
      "belowMin",
    );
    const tight = market({ maxLeverage: 1 });
    expect(
      planLeg(ticket, { market: tight, price: 100, equity: 2_000, available: 500 }).problem,
    ).toBe("overMargin");
  });

  it("counts a 1000-coin market's size in coins", () => {
    const m = market({ id: "1000PEPEUSDT", base: "1000PEPE", sizeStep: "1", minSize: "1" });
    const plan = planLeg(
      { ...ticket, stopPct: 0 },
      { market: m, price: 0.01, equity: 100, available: 100 },
    );
    expect(plan.size).toBe(1000);
    expect(plan.coins).toBe(1_000_000);
  });
});

describe("legRequest", () => {
  const m = market({});
  const plan = planLeg(ticket, { market: m, price: 100, equity: 2_000, available: 2_000 });
  it("carries the exits where the venue takes them", () => {
    expect(legRequest(ticket, m, plan, 500, true)).toMatchObject({
      type: "market",
      maxSlippageBps: 500,
      stopLoss: "98.00",
      takeProfit: "104.00",
    });
  });
  it("leaves them off where it doesn't", () => {
    const req = legRequest(ticket, m, plan, 500, false);
    expect(req).not.toHaveProperty("stopLoss");
    expect(req).not.toHaveProperty("takeProfit");
  });
});
