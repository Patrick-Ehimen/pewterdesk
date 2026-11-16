import { describe, expect, it } from "vitest";
import {
  clock,
  defaultRules,
  emaAsRules,
  fullRules,
  lastAtr,
  longestLosing,
  minutesOf,
  PRESETS,
  presetsFor,
  sizePreview,
  streakCost,
} from "./rules";

describe("rules", () => {
  it("fills in what an older strategy left out", () => {
    const old = {
      template: "custom" as const,
      side: "long" as const,
      entry: [],
      exit: [],
      stopLoss: 0.02,
      takeProfit: 0,
      size: 1,
    };
    const full = fullRules(old);
    expect(full.entryMatch).toBe("all");
    expect(full.exitMatch).toBe("any");
    expect(full.guards).toEqual({});
    expect(full.targets).toEqual([]);
  });

  it("turns an EMA cross into the same rules", () => {
    const r = emaAsRules({
      template: "ema",
      fast: 9,
      slow: 21,
      stopAtr: 2,
      risk: 0.01,
      maxLeverage: 3,
      direction: "long",
    });
    expect(r.entry).toEqual([
      { left: { kind: "ema", period: 9 }, op: "crossesAbove", right: { kind: "ema", period: 21 } },
    ]);
    expect(r.stop).toEqual({ kind: "atr", mult: 2, period: 14 });
    expect(r.sizing).toEqual({ kind: "risk", risk: 0.01 });
  });

  it("sizes by risk at the stop and finds the liquidation beyond it", () => {
    const c = { ...defaultRules(), stop: { kind: "fixed" as const, pct: 0.039 } };
    const p = sizePreview(c, 10_000, 100_000, undefined);
    // 1% of 10,000 at a 3.9% stop: about 2,564 of notional.
    expect(p?.notional).toBeCloseTo(100 / 0.039, 6);
    expect(p?.stopAt).toBeCloseTo(96_100, 6);
    // 3x isolated: about 32.8% below, far past the stop.
    expect(p?.liquidation).toBeCloseTo(100_000 * (1 - (1 / 3 - 0.005)), 6);
    expect(p?.further).toBeGreaterThan(8);
  });

  it("caps the size by leverage and the share a market may take", () => {
    const c = {
      ...defaultRules(),
      sizing: { kind: "equity" as const, share: 10 },
      maxLeverage: 3,
      maxShare: 0.25,
    };
    expect(sizePreview(c, 10_000, 100, undefined)?.notional).toBeCloseTo(7_500, 6);
  });

  it("prices a run of losses", () => {
    expect(streakCost(0.01, 5)).toBeCloseTo(-0.049, 3);
    expect(streakCost(0.01, 20)).toBeCloseTo(-0.182, 3);
    expect(longestLosing([1, -1, -2, 3, -1, -1, -1, 2])).toBe(3);
  });

  it("offers time in trade only as an exit", () => {
    expect(presetsFor(false).has("time")).toBe(false);
    expect(presetsFor(true).get("time")?.length).toBeGreaterThan(0);
    // Every preset's key is unique.
    expect(new Set(PRESETS.map((p) => p.key)).size).toBe(PRESETS.length);
  });

  it("reads and writes times of day", () => {
    expect(minutesOf("07:00")).toBe(420);
    expect(minutesOf("21:30")).toBe(1290);
    expect(minutesOf("25:00")).toBeUndefined();
    expect(clock(1290)).toBe("21:30");
  });

  it("works out an ATR", () => {
    const bars = Array.from({ length: 30 }, (_, i) => ({ high: i + 1, low: i - 1, close: i }));
    expect(lastAtr(bars)).toBeCloseTo(2, 6);
    expect(lastAtr(bars.slice(0, 5))).toBeUndefined();
  });
});
