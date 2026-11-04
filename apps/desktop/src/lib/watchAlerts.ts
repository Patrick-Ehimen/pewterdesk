import { useSyncExternalStore } from "react";

// Which of the pump / dump watch's states notify while the app runs: none,
// pumps, dumps or both. Kept on this machine, shared by the Maps view's switch
// and the app-wide check that notifies.

export const WATCH_ALERTS = ["off", "pump", "dump", "all"] as const;
export type WatchAlerts = (typeof WATCH_ALERTS)[number];

const KEY = "pd.maps.watchAlerts";
const listeners = new Set<() => void>();

function read(): WatchAlerts {
  try {
    const saved = localStorage.getItem(KEY);
    return WATCH_ALERTS.find((a) => a === saved) ?? "off";
  } catch {
    return "off";
  }
}

let current: WatchAlerts = read();

/** The setting now, outside React. */
export const watchAlerts = () => current;

export function setWatchAlerts(next: WatchAlerts) {
  current = next;
  try {
    localStorage.setItem(KEY, next);
  } catch {
    // Storage unavailable or full: it holds for this session, not a restart.
  }
  for (const listen of listeners) listen();
}

/** The setting, kept in step wherever it's read. */
export function useWatchAlerts(): WatchAlerts {
  return useSyncExternalStore(
    (listen) => {
      listeners.add(listen);
      return () => listeners.delete(listen);
    },
    () => current,
  );
}
