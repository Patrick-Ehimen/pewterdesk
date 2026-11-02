import { SCREEN_PRESETS, type Screen, screenFrom } from "@pewterdesk/ui";

// The Screener page's screens, kept on this machine: the trader's saved
// ones, and the one on screen as it was last left. Market ids and numbers,
// nothing about the account.

const SAVED_KEY = "pd.screens";
const CURRENT_KEY = "pd.screener.current";
/** More than anyone keeps; stops a corrupt store growing without bound. */
export const MAX_SAVED = 50;

type Store = Pick<Storage, "getItem" | "setItem">;

const storage = (): Store | undefined =>
  typeof localStorage === "undefined" ? undefined : localStorage;

function read(key: string, store = storage()): unknown {
  try {
    const raw = store?.getItem(key);
    return raw ? JSON.parse(raw) : undefined;
  } catch {
    return undefined;
  }
}

function write(key: string, value: unknown, store = storage()) {
  try {
    store?.setItem(key, JSON.stringify(value));
  } catch {
    // Full or blocked: the screen just isn't kept.
  }
}

export function loadSaved(store?: Store): Screen[] {
  const v = read(SAVED_KEY, store);
  return Array.isArray(v) ? v.flatMap((s) => screenFrom(s) ?? []).slice(0, MAX_SAVED) : [];
}

export const keepSaved = (screens: readonly Screen[], store?: Store) =>
  write(SAVED_KEY, screens.slice(0, MAX_SAVED), store);

/** The screen as it was last left, or the first preset. */
export function loadCurrent(store?: Store): Screen {
  return screenFrom(read(CURRENT_KEY, store)) ?? (SCREEN_PRESETS[0] as Screen);
}

export const keepCurrent = (screen: Screen, store?: Store) => write(CURRENT_KEY, screen, store);
