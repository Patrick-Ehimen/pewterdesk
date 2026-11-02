import type { VenueId } from "@pewterdesk/core";
import { t } from "@pewterdesk/ui";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

// "Always on": the app as a client of the daemon (pdd), which keeps algos
// running with the app quit (`src-tauri/src/daemon.rs`). These commands
// install and pair it; the trading commands route themselves.

export interface DaemonState {
  /** This app can run pdd in the background here (macOS, pdd bundled). */
  available: boolean;
  alwaysOn: boolean;
  agent: "notInstalled" | "stopped" | "running";
  connected: boolean;
  paired: boolean;
}

export interface PairTicket {
  requestId: string;
  /** Shown here and in pdd's dialog, to know it's this app being approved. */
  code: string;
}

export type PairStatus = "pending" | "approved" | "denied" | "expired";

/** A market alert as pdd watches it (`WatchedAlert` in crates/protocol). */
export interface WatchedAlert {
  id: string;
  kind: "price" | "move" | "funding" | "rsi" | "volume" | "oi";
  venue: VenueId;
  market: string;
  condition: "above" | "below";
  value: number;
  repeat: boolean;
  active: boolean;
  firedAt?: number;
  /** The notification's words, in the app's language. */
  text: string;
  sound: boolean;
}

/** An alert pdd fired while the app was closed. */
export interface AlertFiring {
  alertId: string;
  actual: number;
  time: number;
}

/** Keep in sync with ALERTS_FIRED_EVENT in src-tauri/src/daemon.rs. */
const ALERTS_FIRED_EVENT = "daemon-alerts-fired";

/** These commands' errors are the app's own words, safe to show. */
async function call<T>(command: string, args: Record<string, unknown> = {}): Promise<T> {
  if (!isTauri()) throw new Error(t("error.noTauri"));
  try {
    return await invoke<T>(command, args);
  } catch (e) {
    throw new Error(typeof e === "string" ? e : t("error.failed"));
  }
}

export const daemonClient = {
  state: () => call<DaemonState>("daemon_state"),
  setAlwaysOn: (on: boolean) => call<DaemonState>("set_always_on", { on }),
  pair: () => call<PairTicket>("daemon_pair"),
  pairStatus: (requestId: string) => call<PairStatus>("daemon_pair_status", { requestId }),
  /** Hands pdd the market alerts, to watch once the app has quit (a no-op unless always on). */
  syncAlerts: async (alerts: WatchedAlert[], paused: boolean) => {
    if (isTauri()) await invoke("sync_daemon_alerts", { sync: { alerts, paused } });
  },
  /** Calls `handler` with what pdd fired while the app was closed. */
  onAlertsFired: (handler: (fired: AlertFiring[]) => void): (() => void) => {
    if (!isTauri()) return () => {};
    const unlisten = listen<AlertFiring[]>(ALERTS_FIRED_EVENT, (e) => handler(e.payload));
    return () => {
      void unlisten.then((stop) => stop());
    };
  },
};
