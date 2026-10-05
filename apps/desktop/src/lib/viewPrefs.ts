import {
  DEFAULT_DEPTH_DISPLAY,
  DEFAULT_SCREENER_DISPLAY,
  type DepthDisplay,
  type ScreenerDisplay,
} from "@pewterdesk/ui";

const STORAGE_KEY = "pd.views.prefs";

/** How far either side of the mid the depth chart reaches: the whole book, or ±%. */
export const DEPTH_SPANS = ["book", "0.5", "1", "2", "5"] as const;
export type DepthSpan = (typeof DEPTH_SPANS)[number];

/** The screener's volume floors, in USD. */
export const MIN_VOLUMES = [0, 1e6, 1e7, 1e8] as const;

/** The fewest and most bars the depth chart's granularity allows. */
export const DEPTH_COLUMNS = { min: 40, max: 400, step: 20 } as const;

/** Each Markets tab's own settings, remembered between sessions. */
export interface ViewPrefs {
  chart: {
    grid: boolean;
    logScale: boolean;
    countdown: boolean;
    /** The position's and open orders' lines. */
    levels: boolean;
    /** Entry and exit marks from the fill history. */
    fills: boolean;
  };
  overview: { about: boolean; tags: boolean; links: boolean; socials: boolean };
  depth: DepthDisplay & { span: DepthSpan };
  screener: ScreenerDisplay;
  watchlist: ScreenerDisplay;
}
export type ViewId = keyof ViewPrefs;

export const DEFAULT_VIEW_PREFS: ViewPrefs = {
  chart: { grid: true, logScale: false, countdown: true, levels: true, fills: true },
  overview: { about: true, tags: true, links: true, socials: true },
  depth: { ...DEFAULT_DEPTH_DISPLAY, span: "book" },
  screener: DEFAULT_SCREENER_DISPLAY,
  watchlist: DEFAULT_SCREENER_DISPLAY,
};

type Storage = Pick<globalThis.Storage, "getItem" | "setItem">;

function storage(): Storage | undefined {
  try {
    return localStorage;
  } catch {
    return undefined;
  }
}

/** `defaults` with each saved value of the same type laid over it; anything else is dropped. */
function merged<T extends object>(defaults: T, saved: unknown): T {
  if (typeof saved !== "object" || saved === null) return defaults;
  const from = saved as Record<string, unknown>;
  const out = { ...defaults } as Record<string, unknown>;
  for (const [key, value] of Object.entries(defaults)) {
    if (typeof from[key] === typeof value) out[key] = from[key];
  }
  return out as T;
}

const screenerPrefs = (saved: unknown): ScreenerDisplay => {
  const s = merged(DEFAULT_SCREENER_DISPLAY, saved);
  return { ...s, minVolume: MIN_VOLUMES.find((v) => v === s.minVolume) ?? 0 };
};

export function loadViewPrefs(from: Storage | undefined = storage()): ViewPrefs {
  try {
    const saved: unknown = JSON.parse(from?.getItem(STORAGE_KEY) ?? "null");
    if (typeof saved !== "object" || saved === null) return DEFAULT_VIEW_PREFS;
    const s = saved as Record<string, unknown>;
    const depth = merged(DEFAULT_VIEW_PREFS.depth, s.depth);
    const columns = Number.isFinite(depth.columns)
      ? Math.min(Math.max(Math.round(depth.columns), DEPTH_COLUMNS.min), DEPTH_COLUMNS.max)
      : DEFAULT_DEPTH_DISPLAY.columns;
    return {
      chart: merged(DEFAULT_VIEW_PREFS.chart, s.chart),
      overview: merged(DEFAULT_VIEW_PREFS.overview, s.overview),
      depth: { ...depth, columns, span: DEPTH_SPANS.find((v) => v === depth.span) ?? "book" },
      screener: screenerPrefs(s.screener),
      watchlist: screenerPrefs(s.watchlist),
    };
  } catch {
    return DEFAULT_VIEW_PREFS;
  }
}

export function saveViewPrefs(prefs: ViewPrefs, to: Storage | undefined = storage()) {
  try {
    to?.setItem(STORAGE_KEY, JSON.stringify(prefs));
  } catch {
    // Storage unavailable; the views just won't remember their settings.
  }
}

/** The span as a fraction of the mid (0.01 = ±1%), or undefined for the whole book. */
export function spanFraction(span: DepthSpan): number | undefined {
  return span === "book" ? undefined : Number(span) / 100;
}
