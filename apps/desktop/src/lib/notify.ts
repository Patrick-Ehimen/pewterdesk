import { invoke, isTauri } from "@tauri-apps/api/core";

const STORAGE_KEY = "pd.notifications";

/** Whether desktop notifications are on (they are until switched off). */
export function notificationsOn(): boolean {
  try {
    return localStorage.getItem(STORAGE_KEY) !== "off";
  } catch {
    return true;
  }
}

export function saveNotifications(on: boolean) {
  try {
    localStorage.setItem(STORAGE_KEY, on ? "on" : "off");
  } catch {
    // Storage full or off: the choice lasts this session.
  }
}

/**
 * Shows a desktop notification, if they're on and the window isn't the one
 * being looked at: in the app, the toast already says it. `always` sends it
 * regardless (the "send a test" button).
 */
export async function desktopNotify(title: string, body?: string, always = false): Promise<void> {
  if (!isTauri()) return;
  if (!always && (!notificationsOn() || document.hasFocus())) return;
  try {
    await invoke("notify", { title, body });
  } catch {
    // Notifications refused or unavailable: the toast is still there.
  }
}
