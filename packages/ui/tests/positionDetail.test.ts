import type { Candle, Fill, FundingPayment, Position } from "@pewterdesk/core";
import { describe, expect, it } from "vitest";
import {
  closeOrder,
  feesPaid,
  heldParts,
  intervalFor,
  pnlSeries,
  positionFills,
  positionFunding,
  sparkPath,
} from "../src/lib/positionDetail";

const position = (over: Partial<Position> = {}): Position => ({
  venue: "bybit",
  market: "HYPE",
  side: "long",
  size: "250",
  entryPrice: "37.912",
  markPrice: "38.398",
  unrealizedPnl: "121.5",
  margin: "959.95",
  ...over,
});

let id = 0;
const fill = (
  side: "buy" | "sell",
  size: string,
  time: number,
  over: Partial<Fill> = {},
): Fill => ({
  venue: "bybit",
  id: String(++id),
  orderId: "o",
  market: "HYPE",
  side,
  effect: "other",
  price: "38",
  size,
  closedPnl: "0",
  fee: "1",
  feeAsset: "USDT",
  taker: true,
  time,
  ...over,
});

describe("positionFills", () => {
  it("walks back from the newest fill until the position's size is made up", () => {
    const fills = [
      fill("buy", "100", 1), // an earlier position...
      fill("sell", "100", 2), // ...closed
      fill("buy", "150", 3),
      fill("buy", "100", 4),
      fill("buy", "5", 5, { market: "ETH" }),
    ];
    const out = positionFills(fills, position());
    expect(out.fills.map((f) => f.time)).toEqual([3, 4]);
    expect(out.openedAt).toBe(3);
  });

  it("counts a partial close against the position", () => {
    const fills = [fill("buy", "300", 1), fill("sell", "50", 2)];
    expect(positionFills(fills, position()).openedAt).toBe(1);
  });

  it("follows a short's sells", () => {
    const fills = [fill("sell", "1.5", 1), fill("buy", "0.5", 2)];
    expect(positionFills(fills, position({ side: "short", size: "1" })).openedAt).toBe(1);
  });

  it("leaves the opening time unset when the fills don't reach back far enough", () => {
    const out = positionFills([fill("buy", "100", 1)], position());
    expect(out.fills).toHaveLength(1);
    expect(out.openedAt).toBeUndefined();
  });

  it("ignores fills with no size", () => {
    const fills = [fill("buy", "250", 1), fill("buy", "0", 2)];
    expect(positionFills(fills, position()).fills.map((f) => f.time)).toEqual([1]);
  });
});

describe("fees and funding", () => {
  it("sums the fees, rebates negative", () => {
    expect(
      feesPaid([fill("buy", "1", 1, { fee: "2.5" }), fill("buy", "1", 2, { fee: "-0.5" })]),
    ).toBe(2);
  });

  it("keeps the market's payments since the position opened, newest first", () => {
    const pay = (market: string, time: number): FundingPayment => ({
      venue: "bybit",
      market,
      amount: "-0.4",
      positionSize: "250",
      rate: "0.0001",
      time,
    });
    const out = positionFunding(
      [pay("HYPE", 1), pay("HYPE", 5), pay("HYPE", 9), pay("ETH", 7)],
      "HYPE",
      5,
    );
    expect(out.map((p) => p.time)).toEqual([9, 5]);
  });
});

describe("pnlSeries", () => {
  const candle = (openTime: number, close: string): Candle => ({
    openTime,
    open: close,
    high: close,
    low: close,
    close,
    volume: "1",
  });

  it("prices the position at each close since it opened, ending on its PnL now", () => {
    const out = pnlSeries(
      [candle(0, "30"), candle(10, "40"), candle(20, "36")],
      position({ size: "2", entryPrice: "38", unrealizedPnl: "1" }),
      10,
      30,
    );
    expect(out).toEqual([
      { time: 10, pnl: 4 },
      { time: 20, pnl: -4 },
      { time: 30, pnl: 1 },
    ]);
  });

  it("flips for a short", () => {
    const out = pnlSeries(
      [candle(0, "40")],
      position({ side: "short", size: "1", entryPrice: "38" }),
      0,
      1,
    );
    expect(out[0]?.pnl).toBe(-2);
  });
});

describe("sparkPath", () => {
  it("needs two points", () => {
    expect(sparkPath([{ time: 0, pnl: 1 }], 100, 50)).toBeNull();
  });

  it("puts the zero line inside the range", () => {
    const out = sparkPath(
      [
        { time: 0, pnl: -10 },
        { time: 1, pnl: 30 },
      ],
      100,
      40,
    );
    expect(out?.zero).toBe(30);
    expect(out?.line).toBe("M0.0,40.0L100.0,0.0");
  });
});

describe("closeOrder", () => {
  it("closes a long with a reduce-only sell of its whole size", () => {
    expect(closeOrder(position(), { type: "market", maxSlippageBps: 500 })).toEqual({
      market: "HYPE",
      side: "sell",
      size: "250",
      reduceOnly: true,
      type: "market",
      maxSlippageBps: 500,
    });
  });

  it("closes a short with a reduce-only buy at a limit", () => {
    expect(
      closeOrder(position({ side: "short", size: "1.4" }), { type: "limit", price: "2400" }),
    ).toEqual({
      market: "HYPE",
      side: "buy",
      size: "1.4",
      reduceOnly: true,
      type: "limit",
      price: "2400",
    });
  });
});

describe("helpers", () => {
  it("splits a holding time", () => {
    expect(heldParts((2 * 24 + 14) * 3_600_000 + 5 * 60_000)).toEqual({ d: 2, h: 14, m: 5 });
  });

  it("picks coarser candles for longer spans", () => {
    expect(intervalFor(3_600_000)).toBe("1m");
    expect(intervalFor(3 * 24 * 3_600_000)).toBe("15m");
    expect(intervalFor(60 * 24 * 3_600_000)).toBe("4h");
  });
});
