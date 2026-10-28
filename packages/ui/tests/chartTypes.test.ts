import { describe, expect, it } from "vitest";
import { favoriteChartTypes, groupedChartTypes } from "../src/lib/chartTypes";

describe("chart type groups", () => {
  it("groups what the chart offers, unknown types last, no empty groups", () => {
    expect(groupedChartTypes(["line", "candlestick", "kagi", "bar", "fancy"])).toEqual([
      ["bar", "candlestick"],
      ["line"],
      ["kagi"],
      ["fancy"],
    ]);
  });

  it("lists the starred ones in the menu's order, ignoring any not offered", () => {
    expect(favoriteChartTypes(["candlestick", "line", "renko"], ["renko", "gone", "line"])).toEqual(
      ["line", "renko"],
    );
  });
});
