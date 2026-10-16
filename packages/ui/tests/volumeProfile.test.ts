import type { Bar } from "openalgo-charts";
import { describe, expect, it } from "vitest";
import { volumeProfile } from "../src/lib/volumeProfile";

const bar = (low: number, high: number, volume: number, up = true): Bar => ({
  time: 0,
  open: up ? low : high,
  close: up ? high : low,
  low,
  high,
  volume,
});

describe("volumeProfile", () => {
  it("spreads a bar's volume over the rows its range covers", () => {
    const p = volumeProfile([bar(0, 10, 100)], 4, 0.7);
    expect(p?.rows).toHaveLength(4);
    for (const row of p?.rows ?? []) expect(row.up).toBeCloseTo(25);
    expect(p?.rows[0]).toMatchObject({ low: 0, high: 2.5 });
    expect(p?.rows[3]?.high).toBe(10);
  });

  it("splits up and down volume by the bar's direction", () => {
    const p = volumeProfile([bar(0, 10, 40), bar(0, 10, 20, false)], 2, 0.7);
    expect(p?.rows[0]).toMatchObject({ up: 20, down: 10 });
  });

  it("puts a bar with no range in the row holding its price", () => {
    const p = volumeProfile([bar(0, 10, 0), bar(9, 9, 50)], 10, 0.7);
    expect(p?.rows[9]?.up).toBe(50);
    expect(p?.poc).toBe(9);
  });

  it("grows the value area from the point of control towards the busier side", () => {
    const bars = [bar(0, 1, 10), bar(1, 2, 30), bar(2, 3, 50), bar(3, 4, 5), bar(4, 5, 5)];
    const p = volumeProfile(bars, 5, 0.7);
    expect(p?.poc).toBe(2);
    expect(p?.max).toBe(50);
    expect([p?.valueLow, p?.valueHigh]).toEqual([1, 2]);
  });

  it("is undefined without a range or without volume", () => {
    expect(volumeProfile([bar(5, 5, 10)], 24, 0.7)).toBeUndefined();
    expect(volumeProfile([bar(0, 10, 0)], 24, 0.7)).toBeUndefined();
    expect(volumeProfile([], 24, 0.7)).toBeUndefined();
  });
});
