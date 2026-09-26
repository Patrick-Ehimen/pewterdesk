import type { AccountSnapshot, Position } from "@pewterdesk/core";
import { describe, expect, it } from "vitest";
import { portfolioSummary } from "../src/lib/portfolio";

const position = (
  market: string,
  side: "long" | "short",
  size: string,
  mark: string,
): Position => ({
  venue: "hyperliquid",
  market,
  side,
  size,
  entryPrice: mark,
  markPrice: mark,
  unrealizedPnl: side === "long" ? "10" : "-4",
  margin: "100",
});

const snapshot = (positions: Position[], equity = "1000"): AccountSnapshot => ({
  venue: "hyperliquid",
  address: "0x0000000000000000000000000000000000000000",
  equity,
  availableMargin: "500",
  positions,
  openOrders: [],
  time: 0,
});

describe("portfolioSummary", () => {
  const summary = portfolioSummary(
    snapshot([position("HYPE", "long", "250", "38"), position("ETH", "short", "1.4", "2500")]),
  );

  it("signs shorts negative and nets gross vs net exposure", () => {
    // HYPE +9,500; ETH -3,500.
    expect(summary.gross).toBeCloseTo(13_000);
    expect(summary.net).toBeCloseTo(6_000);
    expect(summary.grossRatio).toBeCloseTo(13);
  });

  it("sums PnL and margin, and relates margin to equity", () => {
    expect(summary.unrealizedPnl).toBe(6);
    expect(summary.marginUsed).toBe(200);
    expect(summary.marginRatio).toBeCloseTo(0.2);
    expect(summary.positions).toBe(2);
  });

  it("lists assets largest exposure first, with their share of gross", () => {
    expect(summary.byAsset.map((a) => [a.market, a.netSize])).toEqual([
      ["HYPE", 250],
      ["ETH", -1.4],
    ]);
    expect(summary.byAsset[0]?.share).toBeCloseTo(9_500 / 13_000);
    expect(summary.byAsset[1]?.netNotional).toBeCloseTo(-3_500);
  });

  it("is all zeros for an empty account without dividing by zero", () => {
    const empty = portfolioSummary(snapshot([], "0"));
    expect(empty).toMatchObject({ gross: 0, net: 0, marginRatio: 0, grossRatio: 0, byAsset: [] });
  });
});
