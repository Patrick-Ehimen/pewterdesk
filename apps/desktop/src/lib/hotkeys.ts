import { MENU_PAGES, type Page } from "./pages";

/** What a shortcut does, for whoever owns the action. */
export type HotkeyAction =
  | { type: "palette" }
  | { type: "page"; page: Page }
  | { type: "settings" }
  | { type: "help" }
  | { type: "back" }
  | { type: "forward" }
  | { type: "quickTrade" };

/** The parts of a key press a shortcut is told by. */
export interface KeyPress {
  key: string;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
}

/** Whether a key press is being typed into a field: plain keys are text there. */
export function isTyping(target: EventTarget | null): boolean {
  return (
    target instanceof Element &&
    target.closest("input, textarea, select, [contenteditable]") !== null
  );
}

/**
 * A plain key (no Cmd, Ctrl or Alt), lower-cased, where nothing is being
 * typed: what a page's own shortcuts are made of ("v", "3", "escape").
 */
export function plainKey(e: KeyPress, typing: boolean): string | undefined {
  if (typing || e.metaKey || e.ctrlKey || e.altKey) return undefined;
  return e.key.toLowerCase();
}

/**
 * The app-wide shortcut a key press is, if it is one. Cmd on macOS is Ctrl
 * elsewhere. `typing` (the press is in a field) rules out the plain keys
 * and Cmd with an arrow, which moves the caret there.
 */
export function hotkeyFor(e: KeyPress, typing: boolean): HotkeyAction | undefined {
  const mod = (e.metaKey || e.ctrlKey) && !e.altKey;
  if (mod && !e.shiftKey) {
    const key = e.key.toLowerCase();
    if (key === "k") return { type: "palette" };
    if (key === ",") return { type: "settings" };
    if (key === "[") return { type: "back" };
    if (key === "]") return { type: "forward" };
    // Cmd with an arrow goes back and forward; in a field it moves the caret.
    if (!typing && key === "arrowleft") return { type: "back" };
    if (!typing && key === "arrowright") return { type: "forward" };
    // Cmd+1 is the first page of the menu, and so on.
    const page = /^[1-9]$/.test(key) ? MENU_PAGES[Number(key) - 1] : undefined;
    if (page) return { type: "page", page };
    return undefined;
  }
  if (typing || e.metaKey || e.ctrlKey || e.altKey) return undefined;
  if (e.key === "?") return { type: "help" };
  if (e.key.toLowerCase() === "q" && !e.shiftKey) return { type: "quickTrade" };
  return undefined;
}

/** A key as the list shows it: "mod" is Cmd on macOS and Ctrl elsewhere. */
export type KeyName = string;

/** One row of the shortcuts list: what it does and the keys, one or more ways. */
export interface HotkeyRow {
  id: string;
  /** Each way of pressing it: the keys held together. */
  keys: readonly (readonly KeyName[])[];
}

export const HOTKEY_GROUPS = ["general", "pages", "trade", "charts", "maps"] as const;
export type HotkeyGroup = (typeof HOTKEY_GROUPS)[number];

/** Every shortcut, as Settings lists them. The pages' own are in `pageRows`. */
export const HOTKEYS: Record<HotkeyGroup, readonly HotkeyRow[]> = {
  general: [
    { id: "palette", keys: [["mod", "K"]] },
    { id: "settings", keys: [["mod", ","]] },
    { id: "help", keys: [["?"]] },
    { id: "float", keys: [["Ctrl", "Alt", "Space"]] },
  ],
  pages: [
    {
      id: "back",
      keys: [
        ["mod", "←"],
        ["mod", "["],
      ],
    },
    {
      id: "forward",
      keys: [
        ["mod", "→"],
        ["mod", "]"],
      ],
    },
  ],
  trade: [{ id: "quickTrade", keys: [["Q"]] }],
  charts: [
    { id: "maximise", keys: [["1 – 9"]] },
    { id: "restore", keys: [["Esc"]] },
  ],
  maps: [{ id: "rsiView", keys: [["V"]] }],
};

/** The pages' shortcuts, in the menu's order: Cmd+1 and on. */
export const pageRows = (): { page: Page; keys: readonly KeyName[] }[] =>
  MENU_PAGES.slice(0, 9).map((page, i) => ({ page, keys: ["mod", String(i + 1)] }));

/** A key's label on this machine. */
export function keyLabel(key: KeyName, mac: boolean): string {
  if (key === "mod") return mac ? "⌘" : "Ctrl";
  if (key === "Alt") return mac ? "⌥" : "Alt";
  if (key === "Ctrl") return mac ? "⌃" : "Ctrl";
  return key;
}

/** Whether this is a Mac, for which keys to show. */
export const onMac = () =>
  typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);
