import { describe, expect, it } from "vitest";
import {
  DEFAULT_CHART_PREFS,
  inOrder,
  loadChartPrefs,
  saveChartPrefs,
  toggled,
} from "../src/lib/chartPrefs";

function memoryStore() {
  const items = new Map<string, string>();
  return {
    items,
    getItem: (k: string) => items.get(k) ?? null,
    setItem: (k: string, v: string) => {
      items.set(k, v);
    },
  };
}

describe("chart prefs", () => {
  it("starts with candles, volume and a few favorites", () => {
    expect(loadChartPrefs(memoryStore())).toEqual(DEFAULT_CHART_PREFS);
  });

  it("round-trips a setup", () => {
    const store = memoryStore();
    const prefs = {
      type: "heikinAshi" as const,
      indicators: ["rsi" as const, "sma" as const],
      favoriteIntervals: ["30m" as const, "12h" as const],
      favoriteTypes: ["area" as const],
    };
    saveChartPrefs(prefs, store);
    expect(loadChartPrefs(store)).toEqual(prefs);
  });

  it("drops what it doesn't know, and duplicates", () => {
    const store = memoryStore();
    store.items.set(
      "pd.chart.prefs",
      JSON.stringify({
        type: "renko",
        indicators: ["sma", "ichimoku", "sma"],
        favoriteIntervals: ["1m", "7m"],
        favoriteTypes: "bars",
      }),
    );
    expect(loadChartPrefs(store)).toEqual({
      type: "candles",
      indicators: ["sma"],
      favoriteIntervals: ["1m"],
      favoriteTypes: DEFAULT_CHART_PREFS.favoriteTypes,
    });
    store.items.set("pd.chart.prefs", "{not json");
    expect(loadChartPrefs(store)).toEqual(DEFAULT_CHART_PREFS);
  });

  it("toggles items and keeps favorites in menu order", () => {
    expect(toggled(["a", "b"], "c")).toEqual(["a", "b", "c"]);
    expect(toggled(["a", "b"], "a")).toEqual(["b"]);
    expect(inOrder(["1h", "1m"], ["1m", "5m", "1h"])).toEqual(["1m", "1h"]);
  });
});
