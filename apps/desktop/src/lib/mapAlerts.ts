import { useSyncExternalStore } from "react";

// Which of the Maps page's Bollinger views notify while the app runs, as the
// pump / dump watch's switch does for it: a squeeze (bands the tightest of
// their week), a break of a band, and RSI overbought or oversold at a band.
// Kept on this machine, shared by each view's switch and the app-wide check
// that notifies.

export const SQUEEZE_ALERTS = ["off", "on"] as const;
export type SqueezeAlerts = (typeof SQUEEZE_ALERTS)[number];

/** A band: the upper one, the lower one, or both. */
export const BAND_ALERTS = ["off", "upper", "lower", "all"] as const;
export type BandAlerts = (typeof BAND_ALERTS)[number];

export interface MapAlerts {
  squeeze: SqueezeAlerts;
  bands: BandAlerts;
  rsiBands: BandAlerts;
}

const OFF: MapAlerts = { squeeze: "off", bands: "off", rsiBands: "off" };
const KEY = "pd.maps.mapAlerts";
const listeners = new Set<() => void>();

const pick = <T extends string>(options: readonly T[], value: unknown, fallback: T): T =>
  options.find((o) => o === value) ?? fallback;

function read(): MapAlerts {
  try {
    const saved = JSON.parse(localStorage.getItem(KEY) ?? "null") as Partial<MapAlerts> | null;
    return {
      squeeze: pick(SQUEEZE_ALERTS, saved?.squeeze, "off"),
      bands: pick(BAND_ALERTS, saved?.bands, "off"),
      rsiBands: pick(BAND_ALERTS, saved?.rsiBands, "off"),
    };
  } catch {
    return OFF;
  }
}

let current: MapAlerts = read();

/** The settings now, outside React. */
export const mapAlerts = () => current;

/** Whether any of the three notifies. */
export const anyMapAlert = (a: MapAlerts) =>
  a.squeeze !== "off" || a.bands !== "off" || a.rsiBands !== "off";

export function setMapAlert<K extends keyof MapAlerts>(key: K, value: MapAlerts[K]) {
  current = { ...current, [key]: value };
  try {
    localStorage.setItem(KEY, JSON.stringify(current));
  } catch {
    // Storage unavailable or full: it holds for this session, not a restart.
  }
  for (const listen of listeners) listen();
}

/** The settings, kept in step wherever they're read. */
export function useMapAlerts(): MapAlerts {
  return useSyncExternalStore(
    (listen) => {
      listeners.add(listen);
      return () => listeners.delete(listen);
    },
    () => current,
  );
}

/** Whether a band side is one these settings notify on. */
export const wantsSide = (setting: BandAlerts, side: "upper" | "lower") =>
  setting === "all" || setting === side;
