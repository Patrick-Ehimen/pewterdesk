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
 * regardless (the "send a test" button). Resolves to whether it was handed
 * to the system.
 */
export async function desktopNotify(
  title: string,
  body?: string,
  always = false,
): Promise<boolean> {
  if (!isTauri()) return false;
  // Whether a kind of notification goes to the desktop is the notification
  // settings' call (`notifications.ts`); here, only that the app isn't in front.
  if (!always && document.hasFocus()) return false;
  try {
    await invoke("notify", { title, body });
    // Handed to the system. Whether it shows a banner is the system's call
    // (its notification settings, a Focus mode), which the app can't read.
    return true;
  } catch {
    // Notifications refused or unavailable: the toast is still there.
    return false;
  }
}
