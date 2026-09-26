import { newPanelId, PANELS, type PanelKind, panelKindOf } from "./panels";

/** The grid the workspace snaps to. Rows stretch to fill the window's height. */
export const GRID = { cols: 24, rows: 24, margin: 8 } as const;

/** One placed panel, in grid units. `i` is the panel id (see panels.ts). */
export interface Placement {
  i: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

export type Layout = Placement[];

export interface SavedLayout {
  name: string;
  layout: Layout;
}

export interface WorkspaceState {
  layout: Layout;
  /** Name of the preset or saved layout last applied. */
  active: string;
  saved: SavedLayout[];
}

function place(kind: PanelKind, x: number, y: number, w: number, h: number): Placement {
  return { i: `${kind}:${kind}`, x, y, w, h };
}

/**
 * The market stats bar: fixed in the grid (static — not draggable, resizable
 * or removable), one per layout, across the top left of Account.
 */
export const STATS_BAR_ID = "stats:bar";
/** The bar's height in grid rows; never changes. */
export const STATS_BAR_ROWS = 2;
export const isStatsBar = (id: string) => id === STATS_BAR_ID;

const bar = (w: number): Placement => ({ i: STATS_BAR_ID, x: 0, y: 0, w, h: STATS_BAR_ROWS });

/** Built-in layouts, after the design's presets. Read-only; "Save as…" copies. */
export const PRESETS: readonly SavedLayout[] = [
  {
    name: "Default",
    layout: [
      bar(19),
      place("markets", 0, 2, 14, 14),
      place("orderBook", 14, 2, 5, 14),
      place("account", 19, 0, 5, 16),
      place("positions", 0, 16, 24, 8),
    ],
  },
  {
    name: "Scalping",
    layout: [
      bar(18),
      place("orderBook", 0, 2, 6, 22),
      place("markets", 6, 2, 12, 12),
      place("account", 18, 0, 6, 14),
      place("positions", 6, 14, 18, 10),
    ],
  },
  {
    name: "Swing",
    layout: [
      bar(16),
      place("markets", 0, 2, 16, 10),
      place("positions", 0, 12, 16, 12),
      place("account", 16, 0, 8, 10),
      place("orderBook", 16, 10, 8, 14),
    ],
  },
];

// biome-ignore lint/style/noNonNullAssertion: PRESETS is a non-empty literal
export const DEFAULT_PRESET = PRESETS[0]!;

export function initialWorkspace(): WorkspaceState {
  return { layout: DEFAULT_PRESET.layout, active: DEFAULT_PRESET.name, saved: [] };
}

/** Adds a panel at `at`, or at the bottom of the grid when no spot is given. */
export function addPanel(layout: Layout, kind: PanelKind, at?: { x: number; y: number }): Layout {
  const { w, h } = PANELS[kind];
  const bottom = layout.reduce((max, p) => Math.max(max, p.y + p.h), 0);
  const x = Math.min(at?.x ?? 0, GRID.cols - w);
  return [...layout, { i: newPanelId(kind), x: Math.max(x, 0), y: at?.y ?? bottom, w, h }];
}

/** Removes a panel; the stats bar can't be removed. */
export function removePanel(layout: Layout, id: string): Layout {
  return isStatsBar(id) ? layout : layout.filter((p) => p.i !== id);
}

/**
 * Makes sure a layout has the stats bar (layouts saved before it existed
 * don't). It goes across the top, left of Account when Account sits in the
 * top-right corner, and whatever it lands on moves down to make room.
 */
export function withStatsBar(layout: Layout): Layout {
  if (layout.some((p) => isStatsBar(p.i))) return layout;
  const topRight = layout.find(
    (p) => panelKindOf(p.i) === "account" && p.y === 0 && p.x + p.w === GRID.cols,
  );
  const width = topRight ? topRight.x : GRID.cols;
  const moved = layout.map((p) => {
    if (p === topRight || p.y >= STATS_BAR_ROWS || p.x >= width) return p;
    const kind = panelKindOf(p.i);
    const minH = kind ? PANELS[kind].minH : 1;
    const y = p.y + STATS_BAR_ROWS;
    return { ...p, y, h: Math.max(p.h - STATS_BAR_ROWS, minH) };
  });
  return [bar(width), ...moved];
}

type Direction = "left" | "right" | "up" | "down";

/**
 * Grows panels into empty grid space so no section is left blank: sideways
 * first (left, then right), then vertically (up, then down), each panel one
 * step at a time for as long as the strip next to it is free. Panels are
 * visited top-left first, which decides who takes a gap two panels border.
 * Bounded by the grid, or by the lowest panel if the layout already runs past
 * the bottom.
 */
export function fillGaps(layout: Layout): Layout {
  const rows = layout.reduce((max, p) => Math.max(max, p.y + p.h), GRID.rows as number);
  const taken: boolean[][] = Array.from({ length: rows }, () => Array(GRID.cols).fill(false));
  const panels = layout.map((p) => ({ ...p }));
  const mark = (p: Placement, value: boolean) => {
    for (let y = p.y; y < p.y + p.h; y++) {
      for (let x = p.x; x < p.x + p.w; x++) {
        const row = taken[y];
        if (row && x < GRID.cols) row[x] = value;
      }
    }
  };
  for (const p of panels) mark(p, true);

  /** The strip of cells `p` would take by growing one step in `dir`, if it's all free. */
  const canGrow = (p: Placement, dir: Direction): boolean => {
    const free = (x: number, y: number) =>
      x >= 0 && x < GRID.cols && y >= 0 && y < rows && taken[y]?.[x] === false;
    const cells: [number, number][] = [];
    if (dir === "left" || dir === "right") {
      const x = dir === "left" ? p.x - 1 : p.x + p.w;
      for (let y = p.y; y < p.y + p.h; y++) cells.push([x, y]);
    } else {
      const y = dir === "up" ? p.y - 1 : p.y + p.h;
      for (let x = p.x; x < p.x + p.w; x++) cells.push([x, y]);
    }
    return cells.every(([x, y]) => free(x, y));
  };

  const grow = (p: Placement, dir: Direction) => {
    while (canGrow(p, dir)) {
      mark(p, false);
      if (dir === "left") p.x--;
      if (dir === "up") p.y--;
      if (dir === "left" || dir === "right") p.w++;
      else p.h++;
      mark(p, true);
    }
  };

  const order = [...panels].sort((a, b) => a.y - b.y || a.x - b.x);
  for (const dir of ["left", "right", "up", "down"] as const) {
    for (const p of order) {
      // The stats bar has a fixed height: it may widen, never grow taller.
      if (isStatsBar(p.i) && (dir === "up" || dir === "down")) continue;
      grow(p, dir);
    }
  }
  return panels;
}

const isGridInt = (n: unknown): n is number => Number.isInteger(n) && (n as number) >= 0;

/**
 * Rebuilds a layout from untrusted storage: drops anything that isn't a
 * placement of a known panel kind, and clamps sizes to the grid and the
 * panel's minimums.
 */
export function sanitizeLayout(raw: unknown): Layout {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const layout: Layout = [];
  for (const item of raw) {
    if (typeof item !== "object" || item === null) continue;
    const { i, x, y, w, h } = item as Record<string, unknown>;
    if (typeof i !== "string" || seen.has(i)) continue;
    if (isStatsBar(i)) {
      if (!isGridInt(x) || !isGridInt(y) || !isGridInt(w) || w < 1) continue;
      const width = Math.min(w, GRID.cols);
      seen.add(i);
      layout.push({ i, x: Math.min(x, GRID.cols - width), y, w: width, h: STATS_BAR_ROWS });
      continue;
    }
    const kind = panelKindOf(i);
    if (!kind || !isGridInt(x) || !isGridInt(y) || !isGridInt(w) || !isGridInt(h)) continue;
    const spec = PANELS[kind];
    const width = Math.min(Math.max(w, spec.minW), GRID.cols);
    seen.add(i);
    layout.push({ i, x: Math.min(x, GRID.cols - width), y, w: width, h: Math.max(h, spec.minH) });
  }
  return layout;
}

export function sanitizeWorkspace(raw: unknown): WorkspaceState {
  const fallback = initialWorkspace();
  if (typeof raw !== "object" || raw === null) return fallback;
  const { layout, active, saved } = raw as Record<string, unknown>;
  const savedLayouts: SavedLayout[] = Array.isArray(saved)
    ? saved.flatMap((s) =>
        typeof s === "object" && s !== null && typeof s.name === "string"
          ? [{ name: s.name, layout: withStatsBar(sanitizeLayout(s.layout)) }]
          : [],
      )
    : [];
  const current = sanitizeLayout(layout);
  return {
    layout: current.length > 0 ? fillGaps(withStatsBar(current)) : fallback.layout,
    active: typeof active === "string" ? active : fallback.active,
    saved: savedLayouts,
  };
}

/** Saves (or overwrites) the current layout under `name`; presets can't be overwritten. */
export function saveAs(state: WorkspaceState, name: string): WorkspaceState {
  const trimmed = name.trim();
  if (!trimmed || PRESETS.some((p) => p.name === trimmed)) return state;
  const saved = state.saved.filter((s) => s.name !== trimmed);
  return { ...state, active: trimmed, saved: [...saved, { name: trimmed, layout: state.layout }] };
}
