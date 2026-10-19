import type { ClosedTrade, Fill } from "@pewterdesk/core";
import { describe, expect, it } from "vitest";
import { newPaperState } from "../src/lib/paper";
import { paperOverview } from "../src/lib/paperOverview";

const fill = (time: number, fee: string): Fill => ({
  venue: "hyperliquid",
  id: String(time),
  orderId: String(time),
  market: "ETH",
  side: "buy",
  effect: "openLong",
  price: "100",
  size: "1",
  closedPnl: "0",
  fee,
  feeAsset: "USDC",
  taker: true,
  time,
});
const close = (time: number, pnl: number): ClosedTrade => ({
  venue: "hyperliquid",
  market: "ETH",
  side: "long",
  size: "1",
  entryPrice: "100",
  exitPrice: "100",
  closedPnl: String(pnl),
  entryValue: "100",
  leverage: "10",
  time,
});

describe("paper overview", () => {
  it("starts flat", () => {
    const o = paperOverview(newPaperState("hyperliquid"), undefined, 1_000);
    expect(o.equity).toBe(10_000);
    expect(o.pnl).toBe(0);
    expect(o.closes.trades).toBe(0);
    expect(o.curve).toEqual([{ time: 1_000, total: 0 }]);
  });

  it("adds up fees, funding and the closes", () => {
    const state = {
      ...newPaperState("hyperliquid"),
      cash: 10_030,
      fills: [fill(300, "0.5"), fill(100, "0.25")],
      closed: [close(400, -20), close(200, 50)],
      funding: [
        {
          venue: "hyperliquid" as const,
          market: "ETH",
          amount: "-1.5",
          positionSize: "1",
          rate: "0.0001",
          time: 250,
        },
      ],
    };
    const o = paperOverview(state, undefined, 500);
    expect(o.pnl).toBe(30);
    expect(o.pnlPct).toBeCloseTo(0.3);
    expect(o.fees).toBe(0.75);
    expect(o.funding).toBe(-1.5);
    expect(o.closes).toMatchObject({ trades: 2, wins: 1, losses: 1, best: 50, worst: -20 });
    // From the first fill, a step at each close, level to now.
    expect(o.curve.map((p) => p.total)).toEqual([0, 50, 30, 30]);
    expect(o.curve[0]?.time).toBe(100);
  });
});
