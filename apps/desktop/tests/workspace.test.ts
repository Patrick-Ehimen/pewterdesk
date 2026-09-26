import { describe, expect, it } from "vitest";
import { panelKindOf } from "../src/lib/panels";
import {
  addPanel,
  DEFAULT_PRESET,
  fillGaps,
  GRID,
  initialWorkspace,
  PRESETS,
  removePanel,
  STATS_BAR_ID,
  STATS_BAR_ROWS,
  sanitizeLayout,
  sanitizeWorkspace,
  saveAs,
  withStatsBar,
} from "../src/lib/workspace";

describe("presets", () => {
  it.each(PRESETS.map((p) => [p.name, p.layout] as const))(
    "%s fits the grid without overlaps",
    (_name, layout) => {
      for (const p of layout) {
        expect(p.x + p.w).toBeLessThanOrEqual(GRID.cols);
        expect(p.y + p.h).toBeLessThanOrEqual(GRID.rows);
      }
      for (const a of layout) {
        for (const b of layout) {
          if (a === b) continue;
          const overlap = a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
          expect(overlap, `${a.i} overlaps ${b.i}`).toBe(false);
        }
      }
    },
  );

  it("survive sanitising unchanged", () => {
    for (const preset of PRESETS) expect(sanitizeLayout(preset.layout)).toEqual(preset.layout);
  });
});

describe("addPanel / removePanel", () => {
  it("adds a new instance of a kind that's already placed", () => {
    const layout = addPanel(DEFAULT_PRESET.layout, "orderBook");
    const books = layout.filter((p) => panelKindOf(p.i) === "orderBook");
    expect(books).toHaveLength(2);
    expect(new Set(layout.map((p) => p.i)).size).toBe(layout.length);
  });

  it("appends below everything when no spot is given", () => {
    const added = addPanel(DEFAULT_PRESET.layout, "markets").at(-1);
    expect(added?.y).toBe(24);
  });

  it("keeps a dropped panel inside the grid's width", () => {
    const added = addPanel([], "markets", { x: 20, y: 3 }).at(-1);
    expect(added).toMatchObject({ x: GRID.cols - 12, y: 3, w: 12 });
  });

  it("removes only the given panel", () => {
    const layout = removePanel(DEFAULT_PRESET.layout, "account:account");
    expect(layout.map((p) => p.i)).not.toContain("account:account");
    expect(layout).toHaveLength(DEFAULT_PRESET.layout.length - 1);
  });
});

describe("fillGaps", () => {
  const byId = (layout: ReturnType<typeof fillGaps>) =>
    Object.fromEntries(layout.map(({ i, x, y, w, h }) => [i, { x, y, w, h }]));

  it("leaves a full layout alone", () => {
    for (const preset of PRESETS) expect(fillGaps(preset.layout)).toEqual(preset.layout);
  });

  it("widens the neighbours, stats bar included, when a side panel is removed", () => {
    // Default: stats bar over markets | orderBook, account on the right, positions below.
    const layout = byId(fillGaps(removePanel(DEFAULT_PRESET.layout, "account:account")));
    expect(layout[STATS_BAR_ID]).toEqual({ x: 0, y: 0, w: 24, h: STATS_BAR_ROWS });
    expect(layout["orderBook:orderBook"]).toEqual({ x: 14, y: 2, w: 10, h: 14 });
    expect(layout["markets:markets"]).toEqual({ x: 0, y: 2, w: 14, h: 14 });
  });

  it("widens rightwards into a gap on the left", () => {
    const layout = byId(fillGaps(removePanel(DEFAULT_PRESET.layout, "markets:markets")));
    expect(layout["orderBook:orderBook"]).toEqual({ x: 0, y: 2, w: 19, h: 14 });
  });

  it("grows panels down to the bottom of the grid", () => {
    const layout = byId(fillGaps(removePanel(DEFAULT_PRESET.layout, "positions:positions")));
    for (const [id, p] of Object.entries(layout)) {
      if (id !== STATS_BAR_ID) expect(p.y + p.h, id).toBe(GRID.rows);
    }
  });

  it("stretches a lone panel over the whole grid", () => {
    expect(fillGaps([{ i: "markets:a", x: 3, y: 2, w: 6, h: 5 }])).toEqual([
      { i: "markets:a", x: 0, y: 0, w: GRID.cols, h: GRID.rows },
    ]);
  });

  it("never overlaps panels or leaves an empty cell", () => {
    const layout = fillGaps([
      { i: "markets:a", x: 0, y: 0, w: 6, h: 6 },
      { i: "orderBook:a", x: 10, y: 3, w: 5, h: 9 },
      { i: "positions:a", x: 2, y: 15, w: 8, h: 4 },
    ]);
    const cells = new Map<string, string>();
    for (const p of layout) {
      for (let y = p.y; y < p.y + p.h; y++) {
        for (let x = p.x; x < p.x + p.w; x++) {
          expect(cells.get(`${x},${y}`), `${p.i} overlaps at ${x},${y}`).toBeUndefined();
          cells.set(`${x},${y}`, p.i);
        }
      }
    }
    expect(cells.size).toBe(GRID.cols * GRID.rows);
  });

  it("doesn't grow past panels that already run below the grid", () => {
    const layout = fillGaps([{ i: "markets:a", x: 0, y: 20, w: 24, h: 10 }]);
    expect(layout[0]).toMatchObject({ y: 0, h: 30 });
  });
});

describe("sanitizeLayout", () => {
  it("drops unknown kinds, duplicates and malformed entries", () => {
    const layout = sanitizeLayout([
      { i: "markets:a", x: 0, y: 0, w: 12, h: 12 },
      { i: "markets:a", x: 0, y: 12, w: 12, h: 12 },
      { i: "chart:a", x: 0, y: 0, w: 4, h: 4 },
      { i: "account:a", x: -1, y: 0, w: 4, h: 6 },
      { i: "account:b", x: 0, y: 0, w: "4", h: 6 },
      null,
      "positions:a",
    ]);
    expect(layout.map((p) => p.i)).toEqual(["markets:a"]);
  });

  it("clamps sizes to the panel's minimum and the grid", () => {
    expect(sanitizeLayout([{ i: "orderBook:a", x: 22, y: 0, w: 1, h: 1 }])).toEqual([
      { i: "orderBook:a", x: 20, y: 0, w: 4, h: 8 },
    ]);
    expect(sanitizeLayout([{ i: "markets:a", x: 0, y: 0, w: 99, h: 12 }])[0]?.w).toBe(GRID.cols);
  });

  it("returns an empty layout for non-arrays", () => {
    expect(sanitizeLayout({})).toEqual([]);
  });
});

describe("sanitizeWorkspace", () => {
  it("falls back to the default preset for garbage", () => {
    expect(sanitizeWorkspace("nope")).toEqual(initialWorkspace());
    expect(sanitizeWorkspace({ layout: [] }).layout).toEqual(DEFAULT_PRESET.layout);
  });

  it("keeps valid saved layouts", () => {
    const state = sanitizeWorkspace({
      layout: DEFAULT_PRESET.layout,
      active: "Mine",
      saved: [{ name: "Mine", layout: DEFAULT_PRESET.layout }, { layout: [] }],
    });
    expect(state.active).toBe("Mine");
    expect(state.saved.map((s) => s.name)).toEqual(["Mine"]);
  });
});

describe("saveAs", () => {
  it("saves the current layout and makes it active", () => {
    const state = saveAs(initialWorkspace(), "  Mine ");
    expect(state.active).toBe("Mine");
    expect(state.saved).toEqual([{ name: "Mine", layout: DEFAULT_PRESET.layout }]);
  });

  it("overwrites a saved layout of the same name", () => {
    const once = saveAs(initialWorkspace(), "Mine");
    const twice = saveAs({ ...once, layout: [] }, "Mine");
    expect(twice.saved).toEqual([{ name: "Mine", layout: [] }]);
  });

  it("refuses blank names and preset names", () => {
    const state = initialWorkspace();
    expect(saveAs(state, "  ")).toBe(state);
    expect(saveAs(state, "Scalping")).toBe(state);
  });
});

describe("stats bar", () => {
  const bar = (layout: ReturnType<typeof withStatsBar>) =>
    layout.filter((p) => p.i === STATS_BAR_ID);

  it.each(PRESETS.map((p) => [p.name, p.layout] as const))(
    "%s has one bar across the top, directly left of Account",
    (_name, layout) => {
      const [b, ...extra] = bar(layout);
      const account = layout.find((p) => panelKindOf(p.i) === "account");
      expect(extra).toEqual([]);
      expect(b).toMatchObject({ x: 0, y: 0, h: STATS_BAR_ROWS });
      expect(b && account && b.x + b.w).toBe(account?.x);
      expect(account?.y).toBe(0);
    },
  );

  it("can't be removed", () => {
    expect(removePanel(DEFAULT_PRESET.layout, STATS_BAR_ID)).toBe(DEFAULT_PRESET.layout);
  });

  it("never grows taller when gaps are filled", () => {
    const [b] = bar(fillGaps([{ i: STATS_BAR_ID, x: 0, y: 0, w: 10, h: STATS_BAR_ROWS }]));
    expect(b).toEqual({ i: STATS_BAR_ID, x: 0, y: 0, w: GRID.cols, h: STATS_BAR_ROWS });
  });

  it("is added to a layout saved before it existed, moving what it lands on", () => {
    const old = [
      { i: "markets:a", x: 0, y: 0, w: 14, h: 16 },
      { i: "orderBook:a", x: 14, y: 0, w: 5, h: 16 },
      { i: "account:a", x: 19, y: 0, w: 5, h: 16 },
      { i: "positions:a", x: 0, y: 16, w: 24, h: 8 },
    ];
    const layout = withStatsBar(old);
    expect(bar(layout)).toEqual([{ i: STATS_BAR_ID, x: 0, y: 0, w: 19, h: STATS_BAR_ROWS }]);
    expect(layout).toContainEqual({ i: "markets:a", x: 0, y: 2, w: 14, h: 14 });
    expect(layout).toContainEqual({ i: "account:a", x: 19, y: 0, w: 5, h: 16 });
    expect(layout).toContainEqual({ i: "positions:a", x: 0, y: 16, w: 24, h: 8 });
    expect(withStatsBar(layout)).toBe(layout);
  });

  it("spans the full width when Account isn't in the top-right corner", () => {
    const [b] = bar(withStatsBar([{ i: "markets:a", x: 0, y: 4, w: 24, h: 10 }]));
    expect(b?.w).toBe(GRID.cols);
  });

  it("keeps a stored bar but pins its height", () => {
    expect(sanitizeLayout([{ i: STATS_BAR_ID, x: 0, y: 0, w: 19, h: 9 }])).toEqual([
      { i: STATS_BAR_ID, x: 0, y: 0, w: 19, h: STATS_BAR_ROWS },
    ]);
  });

  it("is restored on load", () => {
    const state = sanitizeWorkspace({ layout: [{ i: "markets:a", x: 0, y: 0, w: 24, h: 24 }] });
    expect(bar(state.layout)).toHaveLength(1);
  });
});
