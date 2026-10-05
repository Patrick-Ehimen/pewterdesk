import type { Candle, Fill, Order, Position } from "@pewterdesk/core";
import { describe, expect, it } from "vitest";
import { exitMove, fillMarks, tradeLevels } from "../src/lib/tradeMarks";

const position = (over: Partial<Position> = {}): Position => ({
  venue: "hyperliquid",
  market: "HYPE",
  side: "long",
  size: "250",
  entryPrice: "37.912",
  markPrice: "38.398",
  liquidationPrice: "34.1",
  unrealizedPnl: "121.5",
  margin: "959.95",
  ...over,
});

const order = (over: Partial<Order> = {}): Order => ({
  venue: "hyperliquid",
  id: "1",
  market: "HYPE",
  side: "buy",
  type: "limit",
  size: "120",
  filledSize: "0",
  price: "37.2",
  reduceOnly: false,
  status: "open",
  createdAt: 0,
  category: "regular",
  ...over,
});

const HOUR = 3_600_000;
const candles: Candle[] = [0, 1, 2].map((i) => ({
  openTime: i * HOUR,
  open: "1",
  high: "1",
  low: "1",
  close: "1",
  volume: "1",
}));

const fill = (time: number, over: Partial<Fill> = {}): Fill => ({
  venue: "hyperliquid",
  id: String(time),
  orderId: "1",
  market: "HYPE",
  side: "buy",
  effect: "openLong",
  price: "10",
  size: "1",
  closedPnl: "0",
  fee: "0",
  feeAsset: "USDC",
  taker: true,
  time,
  ...over,
});

describe("trade levels", () => {
  it("draws the entry, liquidation and resting orders", () => {
    const levels = tradeLevels(position(), [order()]);
    expect(levels.map((l) => [l.kind, l.price])).toEqual([
      ["position", 37.912],
      ["liquidation", 34.1],
      ["order", 37.2],
    ]);
    expect(levels[0]?.pnl).toBe(121.5);
    expect(levels[1]?.distance).toBeCloseTo((34.1 - 38.398) / 38.398);
  });

  it("prices a TP and SL kept on the position as if they filled", () => {
    const levels = tradeLevels(position({ takeProfit: "41", stopLoss: "36.5" }), []);
    const tp = levels.find((l) => l.kind === "takeProfit");
    const sl = levels.find((l) => l.kind === "stopLoss");
    expect(tp?.pnl).toBeCloseTo((41 - 37.912) * 250);
    expect(sl?.pnl).toBeCloseTo((36.5 - 37.912) * 250);
  });

  it("takes TP and SL from exit orders, the whole position when unsized", () => {
    const short = position({ side: "short", entryPrice: "100", size: "2" });
    const levels = tradeLevels(short, [
      order({ id: "tp", category: "takeProfit", type: "trigger", triggerPrice: "90", size: "0" }),
      order({ id: "sl", category: "stopLoss", type: "trigger", triggerPrice: "105", size: "1" }),
    ]);
    expect(levels.find((l) => l.kind === "takeProfit")?.pnl).toBeCloseTo(20);
    expect(levels.find((l) => l.kind === "stopLoss")?.pnl).toBeCloseTo(-5);
    expect(levels.some((l) => l.kind === "order")).toBe(false);
  });

  it("shows a TP reported both on the position and as an order once", () => {
    const levels = tradeLevels(position({ takeProfit: "41" }), [
      order({ category: "takeProfit", type: "trigger", triggerPrice: "41", size: "0" }),
    ]);
    expect(levels.filter((l) => l.kind === "takeProfit")).toHaveLength(1);
  });

  it("draws only orders without a position", () => {
    expect(tradeLevels(undefined, [order()]).map((l) => l.kind)).toEqual(["order"]);
  });
});

describe("fill marks", () => {
  it("puts each fill on the candle it fell in, merged by side and kind", () => {
    const marks = fillMarks(
      [
        fill(HOUR + 10, { price: "10", size: "1" }),
        fill(HOUR + 20, { price: "13", size: "2" }),
        fill(2 * HOUR + 5, { side: "sell", effect: "closeLong", price: "12" }),
      ],
      candles,
      HOUR,
    );
    expect(marks).toEqual([
      { time: HOUR, side: "buy", kind: "entry", price: 12, size: 3 },
      { time: 2 * HOUR, side: "sell", kind: "exit", price: 12, size: 1 },
    ]);
  });

  it("leaves out fills outside the candles loaded", () => {
    expect(fillMarks([fill(-1), fill(3 * HOUR)], candles, HOUR)).toEqual([]);
    expect(fillMarks([fill(3 * HOUR)], candles)).toHaveLength(1);
  });

  it("sorts oldest first, as the chart needs", () => {
    const marks = fillMarks([fill(2 * HOUR), fill(0)], candles, HOUR);
    expect(marks.map((m) => m.time)).toEqual([0, 2 * HOUR]);
  });
});

describe("moving a TP or SL", () => {
  const long = position({ takeProfit: "41", stopLoss: "36.5" });

  it("sets the one moved, on the tick, and keeps the rest", () => {
    expect(exitMove(long, "takeProfit", 42.0071, "0.001")).toEqual({
      result: "set",
      price: "42.007",
      protection: {
        takeProfit: { action: "set", price: "42.007" },
        stopLoss: { action: "keep" },
        trailingStop: { action: "keep" },
      },
    });
  });

  it("does nothing when it lands back on the same tick", () => {
    expect(exitMove(long, "stopLoss", 36.5002, "0.001")).toEqual({ result: "unchanged" });
  });

  it("keeps a TP on the profitable side and an SL on the losing side", () => {
    expect(exitMove(long, "takeProfit", 38, "0.001")).toMatchObject({ error: "protect.tpSide" });
    expect(exitMove(long, "stopLoss", 39, "0.001")).toMatchObject({ error: "protect.slSide" });
    const short = position({ side: "short", takeProfit: "30", stopLoss: "45" });
    expect(exitMove(short, "takeProfit", 39, "0.001")).toMatchObject({ error: "protect.tpSide" });
    expect(exitMove(short, "stopLoss", 37, "0.001")).toMatchObject({ error: "protect.slSide" });
  });

  it("marks only TP and SL kept on the position as movable", () => {
    const levels = tradeLevels(long, [
      order({ id: "tp", category: "takeProfit", type: "trigger", triggerPrice: "44", size: "0" }),
    ]);
    expect(levels.filter((l) => l.movable).map((l) => l.id)).toEqual([
      "position:tp",
      "position:sl",
    ]);
  });
});
