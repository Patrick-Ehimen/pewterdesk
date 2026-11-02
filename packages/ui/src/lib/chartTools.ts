// The floating bar of starred drawing tools: which they are, where it sits and
// whether it's folded, kept on this machine for every chart. Its place is a share of the room the
// chart leaves it, so it stays on the chart at any size.

const KEY = "pd.chartTools";

export interface ChartToolsPrefs {
  /** The library's tool ids. */
  favorites: string[];
  /** 0 at the left and top of the chart, 1 at the right and bottom. */
  x: number;
  y: number;
  /** Folded down to its grip and the arrow that opens it. */
  collapsed: boolean;
}

export const DEFAULT_CHART_TOOLS: ChartToolsPrefs = {
  favorites: [],
  x: 0.5,
  y: 0.03,
  collapsed: false,
};

const share = (value: unknown, otherwise: number) =>
  typeof value === "number" && Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : otherwise;

/** Saved settings, as far as they read; the default for the rest. */
export function chartToolsFrom(raw: unknown): ChartToolsPrefs {
  const s = typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>) : {};
  return {
    favorites: Array.isArray(s.favorites)
      ? s.favorites.filter((id): id is string => typeof id === "string")
      : [],
    x: share(s.x, DEFAULT_CHART_TOOLS.x),
    y: share(s.y, DEFAULT_CHART_TOOLS.y),
    collapsed: s.collapsed === true,
  };
}

export function loadChartTools(): ChartToolsPrefs {
  try {
    return chartToolsFrom(JSON.parse(localStorage.getItem(KEY) ?? "null"));
  } catch {
    return DEFAULT_CHART_TOOLS;
  }
}

/** `change` laid over what's kept now: another chart may have changed the rest. */
export function saveChartTools(change: Partial<ChartToolsPrefs>) {
  try {
    localStorage.setItem(KEY, JSON.stringify({ ...loadChartTools(), ...change }));
  } catch {
    // Storage unavailable; the bar just won't remember.
  }
}
