import type { Bar } from "openalgo-charts";
import { describe, expect, it } from "vitest";
import {
  barIndexAt,
  followOffset,
  newLiveGate,
  releaseGate,
} from "../src/components/trading/ChartReplay";

const bar = (time: number): Bar => ({ time, open: 1, high: 1, low: 1, close: 1, volume: 1 });

describe("bar replay", () => {
  it("finds the bar a click falls on", () => {
    const bars = [bar(60), bar(120), bar(180)];
    expect(barIndexAt(bars, 30)).toBe(-1);
    expect(barIndexAt(bars, 60)).toBe(0);
    expect(barIndexAt(bars, 179.5)).toBe(1);
    expect(barIndexAt(bars, 9999)).toBe(2);
  });

  it("puts held live candles on in order when the replay ends", () => {
    const gate = newLiveGate();
    gate.held = true;
    const put: number[] = [];
    gate.pending.set(180, () => put.push(180));
    gate.pending.set(120, () => put.push(120));
    // Only a candle's latest update is kept.
    gate.pending.set(180, () => put.push(181));
    releaseGate(gate);
    expect(put).toEqual([120, 181]);
    expect(gate.held).toBe(false);
    expect(gate.pending.size).toBe(0);
  });

  it("holds the view still while new bars fill the space, then follows them", () => {
    // 20 bars of space on the right: a new bar takes one of them.
    expect(followOffset(20, 1, 5)).toBe(19);
    // At the margin it follows: the newest stays where it is.
    expect(followOffset(5, 1, 5)).toBe(5);
    expect(followOffset(6, 3, 5)).toBe(5);
    // Scrolled back (the newest off to the right): the view holds still.
    expect(followOffset(-40, 1, 5)).toBe(-41);
    // A step back leaves a bar of space.
    expect(followOffset(5, -1, 5)).toBe(6);
  });
});
