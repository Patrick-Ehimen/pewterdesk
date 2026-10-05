import { describe, expect, it } from "vitest";
import {
  DEFAULT_VIEW_PREFS,
  loadViewPrefs,
  saveViewPrefs,
  spanFraction,
} from "../src/lib/viewPrefs";

const store = (value?: string) => {
  let saved = value ?? null;
  return {
    getItem: () => saved,
    setItem: (_: string, v: string) => {
      saved = v;
    },
  };
};

describe("view prefs", () => {
  it("starts from the defaults", () => {
    expect(loadViewPrefs(store())).toEqual(DEFAULT_VIEW_PREFS);
    expect(loadViewPrefs(store("not json"))).toEqual(DEFAULT_VIEW_PREFS);
  });

  it("round-trips what was saved", () => {
    const s = store();
    const prefs = {
      ...DEFAULT_VIEW_PREFS,
      chart: { ...DEFAULT_VIEW_PREFS.chart, logScale: true, grid: false },
      depth: { ...DEFAULT_VIEW_PREFS.depth, span: "2" as const, columns: 120, smooth: true },
      watchlist: { ...DEFAULT_VIEW_PREFS.watchlist, dense: true },
    };
    saveViewPrefs(prefs, s);
    expect(loadViewPrefs(s)).toEqual(prefs);
  });

  it("drops values it doesn't know and keeps each view's own", () => {
    const loaded = loadViewPrefs(
      store(
        JSON.stringify({
          chart: { grid: "no", logScale: true },
          depth: { span: "40", columns: 9000, bars: false },
          screener: { minVolume: 123, dense: true },
        }),
      ),
    );
    expect(loaded.chart).toEqual({ ...DEFAULT_VIEW_PREFS.chart, logScale: true });
    expect(loaded.depth).toMatchObject({ span: "book", columns: 400, bars: false });
    expect(loaded.screener).toMatchObject({ minVolume: 0, dense: true });
    expect(loaded.watchlist).toEqual(DEFAULT_VIEW_PREFS.watchlist);
  });

  it("reads a span as a fraction of the mid", () => {
    expect(spanFraction("book")).toBeUndefined();
    expect(spanFraction("0.5")).toBe(0.005);
  });
});
