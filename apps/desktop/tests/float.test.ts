import type { Position } from "@pewterdesk/core";
import { describe, expect, it } from "vitest";
import { closeRequest, liquidationDistance, riskiest, slippageBps } from "../src/lib/float";

const position = (over: Partial<Position> = {}): Position => ({
  venue: "bybit",
  market: "ETHUSDT",
  side: "long",
  size: "1.00",
  entryPrice: "2400",
  markPrice: "2000",
  liquidationPrice: "1970",
  unrealizedPnl: "-400",
  margin: "240",
  ...over,
});

describe("liquidationDistance", () => {
  it("is the gap to liquidation as a share of the mark", () => {
    expect(liquidationDistance(position())).toBeCloseTo(0.015);
    expect(liquidationDistance(position({ side: "short", liquidationPrice: "2100" }))).toBeCloseTo(
      0.05,
    );
  });

  it("is unknown without a liquidation price", () => {
    expect(liquidationDistance(position({ liquidationPrice: undefined }))).toBeUndefined();
  });
});

describe("riskiest", () => {
  // 9% away: well clear of the 2% threshold.
  const safe = position({ market: "BTCUSDT", liquidationPrice: "1820" });
  const close = position();
  const closer = position({ market: "SOLUSDT", liquidationPrice: "1990" });

  it("picks the position nearest liquidation, within the threshold", () => {
    expect(riskiest([safe], {}, 0)).toBeUndefined();
    expect(riskiest([safe, close, closer], {}, 0)?.position.market).toBe("SOLUSDT");
  });

  it("skips a snoozed position until its snooze runs out", () => {
    const snoozed = { "SOLUSDT:long": 100 };
    expect(riskiest([close, closer], snoozed, 50)?.position.market).toBe("ETHUSDT");
    expect(riskiest([close, closer], snoozed, 150)?.position.market).toBe("SOLUSDT");
  });
});

describe("closeRequest", () => {
  const market = { sizeStep: "0.01", minSize: "0.01" };

  it("closes all of a long with a reduce-only sell", () => {
    expect(closeRequest(position(), market, 1, 500)).toEqual({
      market: "ETHUSDT",
      side: "sell",
      size: "1.00",
      reduceOnly: true,
      type: "market",
      maxSlippageBps: 500,
    });
  });

  it("closes half, on the size step, the other way for a short", () => {
    const half = closeRequest(position({ side: "short", size: "1.41" }), market, 0.5, 500);
    expect([half.side, half.size, half.reduceOnly]).toEqual(["buy", "0.70", true]);
  });

  it("closes the whole position when half would be under the minimum", () => {
    expect(closeRequest(position({ size: "0.01" }), market, 0.5, 500).size).toBe("0.01");
  });

  it("bounds the slippage", () => {
    expect([slippageBps(0.05), slippageBps(0), slippageBps(5)]).toEqual([500, 1, 1000]);
  });
});
