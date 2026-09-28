type KeyPress = Pick<KeyboardEvent, "key" | "ctrlKey" | "metaKey" | "altKey">;

/**
 * Ctrl+R or F5, the reload keys on Windows and Linux, which have no menu bar.
 * Never on macOS: there the View menu's Reload (Cmd+R) reloads from Rust, so
 * the page leaves it alone rather than reloading twice.
 */
export function isReloadKey(e: KeyPress, mac: boolean): boolean {
  if (mac || e.altKey || e.metaKey) return false;
  if (e.key === "F5") return !e.ctrlKey;
  return e.ctrlKey && e.key.toLowerCase() === "r";
}

/** Whether this page load is a reload (menu, keys, or a language switch). */
export function wasReloaded(): boolean {
  const nav = performance.getEntriesByType("navigation")[0] as
    | PerformanceNavigationTiming
    | undefined;
  return nav?.type === "reload";
}

/**
 * Reloads the page on its reload keys. Installed before React renders, so it
 * still works when the app itself fails to.
 */
export function installReloadShortcut() {
  const mac = navigator.userAgent.includes("Mac");
  window.addEventListener("keydown", (e) => {
    if (!isReloadKey(e, mac)) return;
    e.preventDefault();
    location.reload();
  });
}
