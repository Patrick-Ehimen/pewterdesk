import { describe, expect, it } from "vitest";
import type { TraderChangeKind, TraderHolding, TraderMove } from "../src/api/venueClient";
import { lanes, type Segment, segments, WINDOW_MS } from "../src/lib/timeline";
import { activeHours, holdTimes, longShort, trades30d } from "../src/lib/traderHabits";

const NOW = 1_800_000_000_000;
const H = 3_600_000;

const move = (
  at: number,
  market: string,
  kind: TraderChangeKind,
  side: "long" | "short",
): TraderMove => ({
  source: "hyperliquid",
  id: "0x0000000000000000000000000000000000000001",
  at,
  alert: true,
  change: { market, kind, side, sizeBefore: 0, sizeAfter: 1, price: 1, value: 1 },
});
const holding = (
  market: string,
  side: "long" | "short",
  openedAt: number | null = null,
): TraderHolding => ({
  market,
  side,
  size: 1,
  entry: 1,
  mark: 1,
  value: 1,
  leverage: null,
  unrealized: 0,
  liquidation: null,
  openedAt,
});

describe("the last 24 hours", () => {
  it("draws what the app saw open and close, and what's held now", () => {
    const moves = [
      move(NOW - 20 * H, "ETH", "open", "long"),
      move(NOW - 10 * H, "ETH", "close", "long"),
      move(NOW - 5 * H, "BTC", "open", "short"),
    ];
    const s = segments(moves, { holdings: [holding("BTC", "short")] }, NOW);
    expect(s).toMatchObject([
      {
        market: "ETH",
        side: "long",
        start: NOW - 20 * H,
        end: NOW - 10 * H,
        open: false,
        startKnown: true,
      },
      { market: "BTC", side: "short", start: NOW - 5 * H, end: NOW, open: true, startKnown: true },
    ]);
  });

  it("starts a position held before the window, or before the app watched, at its edge", () => {
    const s = segments(
      [move(NOW - 30 * H, "SOL", "open", "long")],
      { holdings: [holding("SOL", "long"), holding("XRP", "short")] },
      NOW,
    );
    expect(s.map((x) => [x.market, x.start === NOW - WINDOW_MS, x.startKnown])).toEqual([
      ["SOL", true, false],
      ["XRP", true, false],
    ]);
  });

  it("uses OKX's own opening time, and closes the old side of a flip", () => {
    const opened = NOW - 2 * H;
    const s = segments(
      [move(NOW - 8 * H, "ETH", "open", "short"), move(NOW - 3 * H, "ETH", "flip", "long")],
      {
        holdings: [
          holding("ETH", "long"),
          holding("DOGE", "long", opened),
          holding("DOGE", "long", opened + H),
        ],
      },
      NOW,
    );
    expect(s).toMatchObject([
      {
        market: "ETH",
        side: "short",
        start: NOW - 8 * H,
        end: NOW - 3 * H,
        open: false,
        startKnown: true,
      },
      { market: "ETH", side: "long", start: NOW - 3 * H, end: NOW, open: true, startKnown: true },
      { market: "DOGE", side: "long", start: opened, end: NOW, open: true, startKnown: true },
    ]);
  });
});

describe("timeline lanes", () => {
  const bar = (
    market: string,
    start: number,
    end: number,
    value: number,
    startKnown = false,
  ): Segment => ({
    market,
    side: "long",
    start,
    end,
    open: true,
    startKnown,
    value,
  });

  it("stacks what overlaps, puts what the app saw open first, then the biggest, and counts the rest", () => {
    const bars = [
      bar("A", 0, 10, 5),
      bar("B", 0, 10, 50),
      bar("C", 0, 10, 20),
      bar("D", 0, 10, 1),
      bar("E", 4, 6, 0, true),
      bar("F", 12, 14, 0, true),
    ];
    const { rows, hidden } = lanes(bars, 3);
    expect(rows.map((r) => r.map((b) => b.market))).toEqual([["E", "F"], ["B"], ["C"]]);
    expect(hidden).toBe(2);
  });
});

describe("how they trade", () => {
  const closed = (side: "long" | "short", time: number, openedAt: number | null) => ({
    market: "BTC",
    side,
    size: 1,
    price: 1,
    pnl: 1,
    time,
    openedAt,
  });

  it("splits long and short, buckets hold times, and finds the busy hours", () => {
    const trades = [
      closed("long", Date.UTC(2026, 0, 1, 14), Date.UTC(2026, 0, 1, 13, 30)),
      closed("short", Date.UTC(2026, 0, 1, 15), Date.UTC(2026, 0, 1, 9)),
      closed("short", Date.UTC(2026, 0, 2, 15), Date.UTC(2025, 11, 31, 15)),
      closed("short", Date.UTC(2026, 0, 3, 16), null),
      closed("long", Date.UTC(2026, 0, 4, 2), null),
    ];
    expect(longShort(trades)).toEqual({ long: 0.4, short: 0.6 });
    const hold = holdTimes(trades);
    expect(hold.known).toBe(3);
    // Under 1h, under 12h, under 3d.
    expect(hold.counts).toEqual([1, 0, 1, 0, 1, 0, 0]);
    expect(activeHours(trades)).toMatchObject({ share: 0.8 });
    expect(activeHours(trades.slice(0, 3))).toBeUndefined();
  });

  it("counts trades in the last 30 days, and says when there may be more", () => {
    const now = Date.UTC(2026, 0, 31);
    const recent = Array.from({ length: 100 }, (_, i) => closed("long", now - i * H, null));
    expect(trades30d(recent, 100, now)).toEqual({ count: 100, more: true });
    expect(trades30d(recent.slice(0, 10), 100, now)).toEqual({ count: 10, more: false });
  });
});
