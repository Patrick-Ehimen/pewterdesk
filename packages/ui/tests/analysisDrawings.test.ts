import { describe, expect, it } from "vitest";
import { ANALYSIS_ID, analysisDrawings } from "../src/lib/openAlgoChart";

const colors = { buy: "green", sell: "red", warning: "amber", muted: "grey" };
const hour = 3600;
// The latest candle: 2026-10-20 12:00 UTC, in seconds.
const view = { last: 1_792_497_600, bar: 4 * hour };

describe("analysisDrawings", () => {
  it("pins each zone, fib, trend line and level to the candles", () => {
    const drawn = analysisDrawings(
      {
        levels: [
          { price: 0.07, kind: "target", label: "Target 1" },
          { price: 0.05, kind: "invalidation", label: "" },
        ],
        zones: [
          {
            kind: "demand",
            start: 1_792_000_000_000,
            end: null,
            top: 0.0585,
            bottom: 0.0565,
            label: "4h demand",
          },
          {
            kind: "supply",
            start: 1_791_000_000_000,
            end: 1_791_500_000_000,
            top: 0.085,
            bottom: 0.08,
            label: "Supply",
          },
        ],
        fibs: [
          {
            from: { time: 1_792_100_000_000, price: 0.0565 },
            to: { time: 1_792_400_000_000, price: 0.0849 },
            label: "Swing",
          },
        ],
        trendLines: [
          {
            from: { time: 1_792_100_000_000, price: 0.056 },
            to: { time: 1_792_300_000_000, price: 0.06 },
            label: "",
          },
        ],
      },
      colors,
      view,
    );
    expect(drawn.map((d) => d.tool)).toEqual([
      "rectangle",
      "rectangle",
      "fib-retracement",
      "trend-line",
      "horizontal-ray",
      "text",
      "horizontal-ray",
    ]);
    // Ids are the analyst's own, and none is editable or saved.
    expect(drawn.every((d) => d.id?.startsWith(ANALYSIS_ID))).toBe(true);
    expect(new Set(drawn.map((d) => d.id)).size).toBe(drawn.length);
    expect(drawn.every((d) => d.policy?.editable === false && d.policy.persistent === false)).toBe(
      true,
    );

    const [demand, supply, fib] = drawn;
    // A live zone runs from where it formed to a little past the latest candle.
    expect(demand?.points).toEqual([
      { time: 1_792_000_000, price: 0.0585 },
      { time: view.last + 12 * view.bar, price: 0.0565 },
    ]);
    expect(demand?.style.color).toBe("green");
    expect(demand?.text?.value).toBe("4h demand");
    expect(supply?.points[1]?.time).toBe(1_791_500_000);
    expect(supply?.style.color).toBe("red");
    expect(fib?.points.map((p) => p.time)).toEqual([1_792_100_000, 1_792_400_000]);
    // A level's ray starts a fixed number of candles back: it doesn't follow the view.
    expect(drawn[4]?.points).toEqual([{ time: view.last - 40 * view.bar, price: 0.07 }]);
    expect(drawn[6]?.style.color).toBe("amber");
  });

  it("draws nothing for an empty analysis", () => {
    expect(analysisDrawings({ levels: [] }, colors, view)).toEqual([]);
  });
});
