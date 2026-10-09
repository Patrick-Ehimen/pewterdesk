import { describe, expect, it } from "vitest";
import { spread } from "../src/components/rules/RulesDashboard";

describe("the equity chart's labels", () => {
  const places = (items: { at: number }[]) => items.map((i) => Number(i.at.toFixed(3)));

  it("leaves labels that are apart where they are", () => {
    expect(places(spread([{ at: 0.8 }, { at: 0.1 }, { at: 0.5 }], 0.1))).toEqual([0.1, 0.5, 0.8]);
  });

  it("moves apart labels whose lines sit together", () => {
    // A start line and a floor at the same level, and a target just above.
    expect(places(spread([{ at: 0.5 }, { at: 0.5 }, { at: 0.47 }], 0.1))).toEqual([
      0.47, 0.57, 0.67,
    ]);
  });

  it("stacks them up from the bottom rather than off the end", () => {
    expect(places(spread([{ at: 0.95 }, { at: 0.97 }, { at: 0.98 }], 0.1))).toEqual([0.8, 0.9, 1]);
  });
});
