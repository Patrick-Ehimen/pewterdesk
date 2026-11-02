import { describe, expect, it, vi } from "vitest";

vi.mock("openalgo-charts", async (real) => ({ ...(await real<object>()) }));
const { barEnd, lastClosedAt } = await import("../src/components/trading/ChartReplay");

const bars = (...times: number[]) => times.map((time) => ({ time }));

describe("barEnd", () => {
  it("closes when the next one opens, so months of any length are right", () => {
    expect(barEnd(bars(0, 31, 59), 0)).toBe(31);
    expect(barEnd(bars(0, 31, 59), 1)).toBe(59);
  });

  it("gives the last one the length before it", () => {
    expect(barEnd(bars(0, 10, 20), 2)).toBe(30);
  });

  it("has no end for a bar that isn't there", () => {
    expect(barEnd([], 0)).toBeNaN();
  });
});

describe("lastClosedAt", () => {
  const fourHours = bars(0, 4, 8, 12, 16, 20, 24);

  it("takes the newest finished by the moment, going to a shorter interval", () => {
    expect(lastClosedAt(fourHours, 24)).toBe(5);
  });

  it("never takes one still forming, going to a longer interval", () => {
    const days = bars(0, 24, 48);
    expect(lastClosedAt(days, 36)).toBe(0);
    expect(lastClosedAt(days, 48)).toBe(1);
  });

  it("finds nothing when the candles start after the moment", () => {
    expect(lastClosedAt(bars(100, 110, 120), 50)).toBe(-1);
  });

  it("comes back to the same candle after a trip through another interval", () => {
    const days = bars(0, 24, 48, 72);
    const moment = barEnd(days, 0);
    expect(lastClosedAt(fourHours, moment)).toBe(5);
    expect(lastClosedAt(days, moment)).toBe(0);
  });
});
