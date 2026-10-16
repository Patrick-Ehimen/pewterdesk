import type { VenueId } from "@pewterdesk/core";

// The Maps page's saved views: one view with its settings (window, sort,
// measure...) and, for the views about one market, that market, under a
// name the trader picks. Kept on this machine.

const KEY = "pd.maps.saved";
export const VIEW_NAME_MAX = 40;
const MAX_VIEWS = 30;

export interface SavedMapView {
  id: string;
  name: string;
  /** A view of the Maps page, as its id. */
  view: string;
  /** That view's settings, by name. */
  settings: Record<string, string>;
  /** The market it was on, for the views about one market. */
  market?: string;
  venue?: VenueId;
}

const cleanName = (name: string) => name.trim().replace(/\s+/g, " ").slice(0, VIEW_NAME_MAX);

/** What was stored, made safe: malformed entries dropped. */
export function parseSaved(raw: string | null): SavedMapView[] {
  try {
    const value: unknown = JSON.parse(raw ?? "[]");
    if (!Array.isArray(value)) return [];
    const out: SavedMapView[] = [];
    for (const v of value) {
      if (!v || typeof v !== "object") continue;
      const e = v as Partial<SavedMapView>;
      if (typeof e.id !== "string" || typeof e.view !== "string") continue;
      const name = typeof e.name === "string" ? cleanName(e.name) : "";
      if (!name || out.some((x) => x.id === e.id)) continue;
      const settings: Record<string, string> = {};
      for (const [k, s] of Object.entries(e.settings ?? {})) {
        if (typeof s === "string") settings[k] = s;
      }
      out.push({
        id: e.id,
        name,
        view: e.view,
        settings,
        market: typeof e.market === "string" ? e.market : undefined,
        venue: typeof e.venue === "string" ? e.venue : undefined,
      });
    }
    return out.slice(0, MAX_VIEWS);
  } catch {
    return [];
  }
}

/**
 * `list` with `entry` saved: replacing a view of the same name (ignoring
 * case), or added at the end. Unchanged for an empty name, or when full.
 */
export function withSaved(list: readonly SavedMapView[], entry: SavedMapView): SavedMapView[] {
  const name = cleanName(entry.name);
  if (!name) return [...list];
  const clean = { ...entry, name };
  const at = list.findIndex((e) => e.name.toLowerCase() === name.toLowerCase());
  if (at >= 0) return list.map((e, i) => (i === at ? { ...clean, id: e.id } : e));
  return list.length >= MAX_VIEWS ? [...list] : [...list, clean];
}

export const withoutSaved = (list: readonly SavedMapView[], id: string) =>
  list.filter((e) => e.id !== id);

export function loadSaved(): SavedMapView[] {
  try {
    return parseSaved(localStorage.getItem(KEY));
  } catch {
    return [];
  }
}

export function storeSaved(list: readonly SavedMapView[]) {
  try {
    localStorage.setItem(KEY, JSON.stringify(list));
  } catch {
    // Storage unavailable: kept for this session only.
  }
}
