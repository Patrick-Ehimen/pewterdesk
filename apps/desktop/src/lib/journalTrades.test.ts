import type { ClosedTrade, Fill, Position } from "@pewterdesk/core";
import { describe, expect, it } from "vitest";
import { newNote } from "./journal";
import {
  journalTrades,
  openedAtOf,
  openKey,
  openTrades,
  positionFigures,
  tradesTaken,
} from "./journalTrades";

const position = (over: Partial<Position> = {}): Position => ({
  venue: "hyperliquid",
  market: "HYPE",
  side: "long",
  size: "11",
  entryPrice: "88",
  markPrice: "90",
  unrealizedPnl: "22",
  margin: "100",
  ...over,
});

const fill = (time: number, side: "buy" | "sell", size: string): Fill => ({
  venue: "hyperliquid",
  id: String(time),
  orderId: String(time),
  market: "HYPE",
  side,
  effect: "other",
  price: "88",
  size,
  closedPnl: "0",
  fee: "0",
  feeAsset: "USDC",
  taker: true,
  time,
});

const closed = (time: number, over: Partial<ClosedTrade> = {}): ClosedTrade =>
  ({
    venue: "hyperliquid",
    market: "HYPE",
    side: "long",
    size: "11",
    entryPrice: "88",
    exitPrice: "95",
    pnl: "77",
    time,
    ...over,
  }) as ClosedTrade;

describe("an open trade", () => {
  it("opened at the oldest fill that makes up its size", () => {
    const fills = [
      fill(100, "buy", "5"),
      fill(300, "buy", "6"),
      fill(50, "sell", "20"),
      fill(400, "buy", "0"),
    ];
    expect(openedAtOf(position(), fills)).toBe(100);
    expect(openedAtOf(position(), [fill(300, "buy", "6")])).toBeUndefined();
  });

  it("shows its note with the position's live figures", () => {
    const key = openKey("HYPE", "long");
    const note = { ...newNote(positionFigures(position(), 100)), thesis: "range low" };
    const [trade] = openTrades([position({ markPrice: "91" })], new Map([[key, { data: note }]]));
    expect(trade?.written).toBe(true);
    expect(trade?.note.thesis).toBe("range low");
    expect(trade?.note.trade.exitPrice).toBe(91);
    expect(trade?.note.trade.openedAt).toBe(100);
  });

  it("hands its note to the closed trade once the position is gone, and never shows as a trade itself", () => {
    const key = openKey("HYPE", "long");
    const note = { ...newNote(positionFigures(position(), 1_000)), thesis: "range low" };
    const notes = new Map([[key, { data: note }]]);

    const stillOpen = journalTrades([closed(5_000)], notes, undefined, [position()]);
    expect(stillOpen.some((x) => x.adoptedFrom)).toBe(false);
    expect(stillOpen.some((x) => x.key === key)).toBe(false);

    const done = journalTrades([closed(500), closed(5_000)], notes, undefined, []);
    const into = done.find((x) => x.adoptedFrom === key);
    expect(into?.note.thesis).toBe("range low");
    expect(into?.note.trade.exitPrice).toBe(95);
    expect(done.filter((x) => x.adoptedFrom)).toHaveLength(1);
  });
});

describe("trades taken on a day", () => {
  const day = "2026-11-05";
  const at = (h: number) => Date.parse(`${day}T${String(h).padStart(2, "0")}:00:00Z`);
  const done = (market: string, openedAt: number, closedAt: number) => ({
    key: `${market}:${closedAt}`,
    note: newNote({ ...positionFigures(position({ market }), openedAt), closedAt }),
    written: false,
  });

  it("counts a position closed in parts once, and one still open as open", () => {
    // Two trades: SOL closed in two parts, HYPE still open.
    const closed = [done("SOL", at(9), at(10)), done("SOL", at(9), at(11))];
    const [open] = openTrades([position({ market: "HYPE" })], new Map(), () => at(12));
    expect(tradesTaken(closed, open ? [open] : [], day, day)).toEqual({
      total: 2,
      open: 1,
      closed: 1,
    });
  });

  it("counts by the day a trade opened", () => {
    const yesterday = Date.parse("2026-11-04T22:00:00Z");
    const closed = [done("SOL", yesterday, at(1))];
    const [open] = openTrades([position({ market: "HYPE" })], new Map(), () => yesterday);
    expect(tradesTaken(closed, open ? [open] : [], day, day).total).toBe(0);
  });

  it("counts what's open and what closed, whatever they share", () => {
    // Two open, one closed on a market and side one of them shares.
    const closed = [done("HYPE", at(9), at(10))];
    const open = openTrades(
      [position({ market: "HYPE" }), position({ market: "SOL", side: "short" })],
      new Map(),
      () => at(9),
    );
    expect(tradesTaken(closed, open, day, day)).toEqual({ total: 3, open: 2, closed: 1 });
  });
});
