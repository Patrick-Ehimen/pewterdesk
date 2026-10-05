import { describe, expect, it } from "vitest";
import { estLiquidation, positionAfter, ticketChecks } from "../src/lib/ticketChecks";

const market = { tickSize: "0.001", sizeStep: "0.01", minSize: "0.1" };
const base = {
  market,
  type: "limit" as const,
  side: "buy" as const,
  sizeBase: 250,
  limitPrice: "38.391",
  trigger: "",
  reduceOnly: false,
  bestBid: 38.391,
  bestAsk: 38.405,
  price: 38.391,
  available: 11_186,
  leverage: 10,
};
const codes = (over: Partial<Parameters<typeof ticketChecks>[0]>) =>
  ticketChecks({ ...base, ...over }).map((c) => c.code);

describe("ticketChecks", () => {
  it("passes a plain order", () => {
    expect(codes({})).toEqual([]);
  });

  it("refuses a price off the tick", () => {
    expect(codes({ limitPrice: "38.3915" })).toEqual(["tick"]);
  });

  it("warns when a limit is priced far through the book", () => {
    const [check] = ticketChecks({ ...base, limitPrice: "42", price: 42 });
    expect(check).toMatchObject({ field: "price", level: "warn", code: "crosses" });
    expect(codes({ side: "sell", limitPrice: "36", price: 36 })).toEqual(["crosses"]);
    // Just through the spread is an ordinary marketable limit.
    expect(codes({ limitPrice: "38.41", price: 38.41 })).toEqual([]);
  });

  it("refuses a size under the minimum", () => {
    expect(codes({ sizeBase: 0.05 })).toEqual(["minSize"]);
  });

  it("says what an off-step size sends", () => {
    const [check] = ticketChecks({ ...base, sizeBase: 250.005 });
    expect(check).toMatchObject({ code: "step", sends: 250 });
  });

  it("warns about more margin than the account has, with the most it covers", () => {
    const [check] = ticketChecks({
      ...base,
      sizeBase: 3500,
      limitPrice: "42",
      price: 42,
      bestAsk: 43,
    });
    expect(check).toMatchObject({ code: "margin", level: "warn", need: 14_700, have: 11_186 });
    expect(check && "max" in check && check.max).toBeCloseTo(2663.33, 2);
  });

  it("needs no margin to reduce, or without an account", () => {
    expect(codes({ sizeBase: 100_000, reduceOnly: true })).toEqual([]);
    expect(codes({ sizeBase: 100_000, available: undefined })).toEqual([]);
    expect(
      codes({ sizeBase: 100_000, side: "sell", position: { side: "long", size: "100000" } }),
    ).toEqual([]);
  });

  it("checks a trigger's tick", () => {
    expect(codes({ type: "stopMarket", trigger: "38.0005", limitPrice: "" })).toEqual(["tick"]);
  });
});

describe("positionAfter", () => {
  const long = { side: "long" as const, size: "250", entryPrice: "37.912" };

  it("opens from flat at the fill price", () => {
    expect(positionAfter(undefined, "sell", 2, 100, false)).toEqual({
      from: { size: 0 },
      to: { size: -2, entry: 100 },
    });
  });

  it("averages the entry when adding", () => {
    const { to } = positionAfter(long, "buy", 250, 38.392, false);
    expect(to.size).toBe(500);
    expect(to.entry).toBeCloseTo(38.152, 3);
  });

  it("keeps the entry when reducing, and goes flat on a full close", () => {
    expect(positionAfter(long, "sell", 100, 40, false).to).toEqual({ size: 150, entry: 37.912 });
    expect(positionAfter(long, "sell", 250, 40, false).to).toEqual({ size: 0 });
  });

  it("flips at the fill price, unless reduce-only", () => {
    expect(positionAfter(long, "sell", 300, 40, false).to).toEqual({ size: -50, entry: 40 });
    expect(positionAfter(long, "sell", 300, 40, true).to).toEqual({ size: 0 });
    expect(positionAfter(long, "buy", 50, 40, true).to).toEqual({ size: 250, entry: 37.912 });
  });
});

describe("estLiquidation", () => {
  it("puts an isolated long below entry by its margin, less maintenance", () => {
    // 10x: 10% margin, 0.5% maintenance -> 9.5% below.
    expect(
      estLiquidation({ size: 0.1, entry: 84_000 }, { mode: "isolated", leverage: 10 }),
    ).toBeCloseTo(76_020);
  });

  it("puts an isolated short above entry", () => {
    expect(estLiquidation({ size: -2, entry: 100 }, { mode: "isolated", leverage: 5 })).toBeCloseTo(
      119.5,
    );
  });

  it("uses the account's equity in cross", () => {
    // 1 unit at 100 with 30 of equity: 30 of room, less 0.5 maintenance.
    expect(
      estLiquidation({ size: 1, entry: 100 }, { mode: "cross", leverage: 10, equity: 30 }),
    ).toBeCloseTo(70.5);
  });

  it("gives nothing when flat, or when a cross long can't be liquidated above zero", () => {
    expect(estLiquidation({ size: 0 }, { mode: "isolated", leverage: 10 })).toBeUndefined();
    expect(
      estLiquidation({ size: 1, entry: 100 }, { mode: "cross", leverage: 10, equity: 5000 }),
    ).toBeUndefined();
    expect(
      estLiquidation({ size: 1, entry: 100 }, { mode: "cross", leverage: 10 }),
    ).toBeUndefined();
  });
});
