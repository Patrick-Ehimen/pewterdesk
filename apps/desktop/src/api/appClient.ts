import type { VenueId } from "@pewterdesk/core";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { emit, listen } from "@tauri-apps/api/event";

/** About this build, from the Rust shell (see src-tauri/src/about.rs). */
export interface AppInfo {
  version: string;
  /** "macos", "windows", "linux", ... */
  os: string;
  /** "aarch64", "x86_64", ... */
  arch: string;
  /** A development build rather than a release. */
  debug: boolean;
}

/** A run of the menu-bar (tray) title in one colour: green for up, red for down. */
export interface TitlePart {
  text: string;
  tone: "plain" | "up" | "down";
}

/** What the menu-bar item shows beside its icon; see src-tauri/src/tray.rs. */
export interface TrayUpdate {
  /** In coloured runs; empty for the icon alone. */
  title: TitlePart[];
}

/** A market picked in the tray panel; ids only mean something within a venue. */
export interface TrayPick {
  venue: VenueId;
  marketId: string;
}

/** Events between the tray panel and the main window. */
const TRAY_MODE_EVENT = "tray-mode";
const TRAY_SELECT_EVENT = "tray-select-market";

/** Calls `handler` with each payload of app event `name`; returns the unsubscribe. */
function onEvent<T>(name: string, handler: (payload: T) => void): () => void {
  if (!isTauri()) return () => {};
  const unlisten = listen<T>(name, (e) => handler(e.payload));
  return () => {
    void unlisten.then((stop) => stop());
  };
}

/** The About box's links; the URLs themselves live in the Rust shell. */
export type AboutLink = "repository" | "issues" | "license";

export const appClient = {
  /** Undefined outside the desktop app (e.g. `make dev-ui`). */
  info: async (): Promise<AppInfo | undefined> =>
    isTauri() ? invoke<AppInfo>("app_info") : undefined,

  /**
   * Calls `handler` when the menu bar's "About" item is chosen (macOS).
   * Returns the unsubscribe; a no-op outside the desktop app.
   */
  onOpenAbout: (handler: () => void): (() => void) => {
    if (!isTauri()) return () => {};
    // Keep in sync with OPEN_ABOUT_EVENT in src-tauri/src/about.rs.
    const unlisten = listen("open-about", handler);
    return () => {
      void unlisten.then((stop) => stop());
    };
  },

  /** Redraws the menu-bar (tray) item; a no-op outside the desktop app. */
  updateTray: async (update: TrayUpdate): Promise<void> => {
    if (isTauri()) await invoke("update_tray", { update });
  },

  /** Main window: calls `handler` with the display mode picked in the tray panel. */
  onTrayMode: (handler: (mode: string) => void) => onEvent(TRAY_MODE_EVENT, handler),

  /** Tray panel: tells the main window which display mode was picked. */
  setTrayMode: (mode: string) => (isTauri() ? emit(TRAY_MODE_EVENT, mode) : Promise.resolve()),

  /** Main window: calls `handler` with a market picked from the tray panel (any venue). */
  onTraySelectMarket: (handler: (pick: TrayPick) => void) => onEvent(TRAY_SELECT_EVENT, handler),

  /** Tray panel: puts a market on screen in the main window, and opens it. */
  selectMarketFromTray: async (pick: TrayPick) => {
    if (!isTauri()) return;
    await emit(TRAY_SELECT_EVENT, pick);
    await invoke("tray_open_main");
  },

  /** Tray panel: opens the main window. */
  openMainFromTray: async () => {
    if (isTauri()) await invoke("tray_open_main");
  },

  /** Tray panel: quits the app. */
  quitFromTray: async () => {
    if (isTauri()) await invoke("tray_quit");
  },

  /** Tray panel: fits its window to its content. */
  resizeTrayPanel: async (height: number) => {
    if (isTauri()) await invoke("resize_tray_panel", { height });
  },

  /** Shows the floating window, or hides it if it's showing. */
  toggleFloat: async () => {
    if (isTauri()) await invoke("toggle_float");
  },

  /** Floating window: brings itself up (a risk alert). */
  showFloat: async () => {
    if (isTauri()) await invoke("show_float");
  },

  /** Floating window: hides itself. */
  hideFloat: async () => {
    if (isTauri()) await invoke("hide_float");
  },

  /** Floating window: fits its window to its content, in points. */
  resizeFloat: async (width: number, height: number) => {
    if (isTauri()) await invoke("resize_float", { width, height });
  },

  /** Floating window: snaps to a nearby edge; resolves to where it settled. */
  snapFloat: async (): Promise<[number, number] | undefined> =>
    isTauri() ? ((await invoke<[number, number] | null>("snap_float")) ?? undefined) : undefined,

  /** Floating window: goes back to where it was last left. */
  placeFloat: async (x: number, y: number) => {
    if (isTauri()) await invoke("place_float", { x, y });
  },

  /** Floating window: whether screen shares and recordings can't see it. */
  setFloatProtected: async (hidden: boolean) => {
    if (isTauri()) await invoke("set_float_protected", { protected: hidden });
  },

  /** Main window: it's loaded, so the launch splash can give way to it. */
  appReady: async () => {
    if (isTauri()) await invoke("app_ready");
  },

  /**
   * Saves a P&L share card (a PNG) to the Downloads folder, under a name
   * Rust picks; resolves to where it went. Sent as raw bytes.
   */
  saveShareImage: async (png: Blob): Promise<string> => {
    if (!isTauri()) throw new Error("not in the desktop app");
    try {
      return await invoke<string>("save_share_image", new Uint8Array(await png.arrayBuffer()));
    } catch (err) {
      throw new Error(typeof err === "string" ? err : "couldn't save the image");
    }
  },

  /** Opens one of the fixed links in the system browser. */
  openLink: async (link: AboutLink): Promise<void> => {
    if (!isTauri()) throw new Error("not in the desktop app");
    await invoke("open_about_link", { link });
  },
};
