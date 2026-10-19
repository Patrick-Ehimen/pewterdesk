import { t } from "@pewterdesk/ui";
import { invoke, isTauri } from "@tauri-apps/api/core";

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
};
