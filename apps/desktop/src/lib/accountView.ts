import { useCallback, useSyncExternalStore } from "react";

// Which view each Account panel shows: the venue on screen's account (as
// it always has), or every venue's balances (the Balances panel's view).
// Kept on this machine per panel, so a layout's panels keep their own;
// the switch in the panel's title and the panel itself read the same one.

export type AccountView = "venue" | "all";

const KEY = "pd.accountView";
/** Panels made as the Balances panel before it became this view: they open on it. */
const LEGACY = "balances:";

type Views = Readonly<Record<string, AccountView>>;

let raw: string | null | undefined;
let views: Views = {};
const listeners = new Set<() => void>();

function read(): Views {
  let now: string | null = null;
  try {
    now = localStorage.getItem(KEY);
  } catch {
    // Storage unavailable: what was set this session holds.
    return views;
  }
  if (now === raw) return views;
  raw = now;
  try {
    const parsed = JSON.parse(now ?? "{}") as Record<string, unknown>;
    const next: Record<string, AccountView> = {};
    for (const [id, view] of Object.entries(parsed)) {
      if (view === "venue" || view === "all") next[id] = view;
    }
    views = next;
  } catch {
    views = {};
  }
  return views;
}

/** The view panel `id` shows: what was picked for it, else the venue's (all for a former Balances panel). */
export function accountViewOf(id: string, saved: Views = read()): AccountView {
  return saved[id] ?? (id.startsWith(LEGACY) ? "all" : "venue");
}

export function setAccountView(id: string, view: AccountView) {
  views = { ...read(), [id]: view };
  try {
    raw = JSON.stringify(views);
    localStorage.setItem(KEY, raw);
  } catch {
    // Kept for this session only.
  }
  for (const l of listeners) l();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Panel `id`'s view, and the way to change it. */
export function useAccountView(id: string) {
  const view = useSyncExternalStore(subscribe, () => accountViewOf(id));
  const set = useCallback((next: AccountView) => setAccountView(id, next), [id]);
  return [view, set] as const;
}
