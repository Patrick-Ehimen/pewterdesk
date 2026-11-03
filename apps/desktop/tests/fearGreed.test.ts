import { describe, expect, it } from "vitest";
import { bandOf, comparisons, gaugePoint, readingAgo, sideOf } from "../src/lib/fearGreed";

const DAY = 86_400;
const TODAY = 1_793_664_000;
const day = (ago: number, value: number) => ({ time: TODAY - ago * DAY, value });

describe("the fear and greed index", () => {
  it("names a reading by Alternative.me's bands", () => {
    expect([0, 25, 26, 46, 47, 54, 55, 75, 76, 100].map(bandOf)).toEqual([
      "extremeFear",
      "extremeFear",
      "fear",
      "fear",
      "neutral",
      "neutral",
      "greed",
      "greed",
      "extremeGreed",
      "extremeGreed",
    ]);
    expect(sideOf("extremeFear")).toBe("fear");
    expect(sideOf("neutral")).toBe("neutral");
    expect(sideOf("extremeGreed")).toBe("greed");
  });

  it("compares today with a day, a week and a month before", () => {
    const days = Array.from({ length: 31 }, (_, i) => day(i, 20 + i));
    expect(comparisons(days)).toEqual([
      { when: "yesterday", value: 21 },
      { when: "week", value: 27 },
      { when: "month", value: 50 },
    ]);
  });

  it("leaves a gap in the feed a gap", () => {
    const days = [day(0, 26), day(1, 37), day(3, 40)];
    expect(readingAgo(days, 7)).toBeUndefined();
    expect(comparisons(days).map((c) => c.when)).toEqual(["yesterday"]);
    expect(comparisons([])).toEqual([]);
  });

  it("puts 0 at the gauge's left end, 50 at its top and 100 at its right", () => {
    const at = (v: number) => {
      const p = gaugePoint(v, 50, 50, 40);
      return [Math.round(p.x), Math.round(p.y)];
    };
    expect(at(0)).toEqual([10, 50]);
    expect(at(50)).toEqual([50, 10]);
    expect(at(100)).toEqual([90, 50]);
    expect(at(140)).toEqual([90, 50]);
  });
});
