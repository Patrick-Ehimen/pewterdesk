import { describe, expect, it } from "vitest";
import { ANALYSIS_ID, analysisDrawings, levelLabels, tradePlan } from "../src/lib/openAlgoChart";

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
      "horizontal-ray",
      "text",
      "text",
      "text",
      "text",
    ]);
    // Ids are the analyst's own; the trader can move and delete them, and none is saved.
    expect(drawn.every((d) => d.id?.startsWith(ANALYSIS_ID))).toBe(true);
    expect(new Set(drawn.map((d) => d.id)).size).toBe(drawn.length);
    expect(drawn.every((d) => d.policy?.editable === true && d.policy.persistent === false)).toBe(
      true,
    );

    const [demand, supply, fib] = drawn;
    // A live zone runs from where it formed to a little past the latest candle.
    expect(demand?.points).toEqual([
      { time: 1_792_000_000, price: 0.0585 },
      { time: view.last + view.bar, price: 0.0565 },
    ]);
    expect(demand?.style.color).toBe("green");
    // Its name is in the column by the axis, not on the zone.
    expect(demand?.text).toBeUndefined();
    expect(supply?.points[1]?.time).toBe(1_791_500_000);
    expect(supply?.style.color).toBe("red");
    expect(fib?.points.map((p) => p.time)).toEqual([1_792_100_000, 1_792_400_000]);
    // A level's ray starts a fixed number of candles back: it doesn't follow the view.
    expect(drawn[4]?.points).toEqual([{ time: view.last - 12 * view.bar, price: 0.07 }]);
    expect(drawn[5]?.style.color).toBe("amber");
    // The words sit right of the latest candle, each with its price.
    // The names, highest first, past the trade's box: levels and zones alike.
    const names = drawn.filter((d) => d.tool === "text");
    expect(names.map((d) => d.text?.value)).toEqual([
      "Supply · 0.08–0.085",
      "Target 1 · 0.07",
      "4h demand · 0.0565–0.0585",
      "0.05",
    ]);
    expect(names[1]?.points).toEqual([{ time: view.last + 10 * view.bar, price: 0.07 }]);
  });

  it("draws nothing for an empty analysis", () => {
    expect(analysisDrawings({ levels: [] }, colors, view)).toEqual([]);
  });

  it("draws no second line where a fib line already is, and puts near labels together", () => {
    const fib = {
      from: { time: 1_792_100_000_000, price: 2450 },
      to: { time: 1_792_400_000_000, price: 2205.4 },
      label: "Nov 4 to 5",
    };
    const levels = [
      // On the fib's 78.6% and 61.8% lines, as the analyst drew them.
      { price: 2257.6, kind: "target" as const, label: "T1 0.786 fib" },
      { price: 2298.8, kind: "target" as const, label: "T2 0.618 fib" },
      // Two levels a couple of dollars apart: one label.
      { price: 2240, kind: "support" as const, label: "2240" },
      { price: 2237, kind: "support" as const, label: "entry" },
      { price: 2387, kind: "resistance" as const, label: "pre-flush rejection" },
    ];
    const drawn = analysisDrawings(
      { levels, fibs: [fib] },
      { ...colors, background: "black" },
      view,
    );
    // Only the levels off the fib get a line.
    expect(drawn.filter((d) => d.tool === "horizontal-ray").map((d) => d.points[0]?.price)).toEqual(
      [2240, 2237, 2387],
    );
    const texts = drawn.filter((d) => d.tool === "text");
    expect(texts.map((d) => d.text?.value)).toEqual([
      "pre-flush rejection · 2387",
      "T2 0.618 fib · 2298.8",
      "T1 0.786 fib · 2257.6",
      "2240 · 2240",
      "entry · 2237",
    ]);
    // Two a few dollars apart each keep a line: the lower eased down, clear of the one above.
    const [, , , upper, lower] = texts.map((d) => d.points[0]?.price ?? 0);
    expect(upper).toBe(2240);
    expect((upper ?? 0) - (lower ?? 0)).toBeGreaterThanOrEqual((2450 - 2205.4) * 0.035 - 1e-9);
    // Where the chart says how much price a line of text takes, at least that.
    const spaced = analysisDrawings({ levels, fibs: [fib] }, colors, { ...view, labelGap: 40 })
      .filter((d) => d.tool === "text")
      .map((d) => d.points[0]?.price ?? 0);
    for (let i = 1; i < spaced.length; i++) {
      expect((spaced[i - 1] ?? 0) - (spaced[i] ?? 0)).toBeGreaterThanOrEqual(40 - 1e-9);
    }
    // On a plate of the chart's background, so lines don't run through them.
    expect(texts.every((d) => d.text?.background && d.text.backgroundColor === "black")).toBe(true);
    expect(levelLabels({ levels: [] }, () => "x")).toEqual([]);
  });

  it("draws a trade plan as a position box, from the latest candle", () => {
    const levels = [
      { price: 2237, kind: "entry" as const, label: "Entry" },
      { price: 2245, kind: "entry" as const, label: "Entry" },
      { price: 2257.6, kind: "target" as const, label: "TP1" },
      { price: 2328, kind: "target" as const, label: "TP2" },
      { price: 2205.4, kind: "invalidation" as const, label: "Stop" },
      { price: 2387, kind: "resistance" as const, label: "R1" },
    ];
    expect(tradePlan(levels)).toEqual({ side: "long", entry: 2241, stop: 2205.4, target: 2328 });
    const drawn = analysisDrawings({ levels }, colors, view);
    const box = drawn.find((d) => d.tool === "long-position");
    expect(box?.points).toEqual([
      { time: view.last, price: 2241 },
      { time: view.last + 8 * view.bar, price: 2328 },
      { time: view.last + 8 * view.bar, price: 2205.4 },
    ]);
    // Its risk/reward and percentages, not the tool's sizing example.
    expect(box?.props).toEqual({ profitColor: "green", lossColor: "red", showLossSize: false });
    // The plan's lines start at the latest candle; resistance a little before, dotted.
    const rays = drawn.filter((d) => d.tool === "horizontal-ray");
    const r1 = rays.find((d) => d.points[0]?.price === 2387);
    expect(r1?.points[0]?.time).toBe(view.last - 12 * view.bar);
    expect(r1?.style.lineStyle).toBe("dotted");
    expect(rays.find((d) => d.points[0]?.price === 2257.6)?.points[0]?.time).toBe(view.last);
    // A short: targets below, the stop above.
    expect(
      tradePlan([
        { price: 100, kind: "entry", label: "" },
        { price: 90, kind: "target", label: "" },
        { price: 105, kind: "invalidation", label: "" },
      ]),
    ).toEqual({ side: "short", entry: 100, stop: 105, target: 90 });
    // Levels that don't make a trade draw none.
    expect(
      tradePlan([
        { price: 100, kind: "entry", label: "" },
        { price: 110, kind: "target", label: "" },
        { price: 120, kind: "invalidation", label: "" },
      ]),
    ).toBeUndefined();
    expect(tradePlan([{ price: 100, kind: "entry", label: "" }])).toBeUndefined();
  });

  it("draws the fib's key ratios only, quietly", () => {
    const [fib] = analysisDrawings(
      {
        levels: [],
        fibs: [
          {
            from: { time: 1_792_100_000_000, price: 10 },
            to: { time: 1_792_400_000_000, price: 20 },
            label: "",
          },
        ],
      },
      colors,
      view,
    );
    expect(fib?.style.levels?.map((l) => l.ratio)).toEqual([0, 0.382, 0.5, 0.618, 0.786, 1]);
    expect(fib?.style.levels?.every((l) => l.color === "grey")).toBe(true);
    expect(fib?.style.fill).toBe(false);
  });
});
