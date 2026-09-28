import type { QuickTradePosition } from "@pewterdesk/ui";

const STORAGE_KEY = "pd.quickTrade";

export interface QuickTradeState {
  open: boolean;
  /** Unset until it's first moved; the app then places it bottom-centre. */
  position?: QuickTradePosition;
}

const isPosition = (p: unknown): p is QuickTradePosition =>
  typeof p === "object" &&
  p !== null &&
  Number.isFinite((p as QuickTradePosition).x) &&
  Number.isFinite((p as QuickTradePosition).y);

export function loadQuickTrade(): QuickTradeState {
  try {
    const saved: unknown = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "null");
    if (typeof saved !== "object" || saved === null) return { open: false };
    const { open, position } = saved as Record<string, unknown>;
    return { open: open === true, position: isPosition(position) ? position : undefined };
  } catch {
    return { open: false };
  }
}

export function saveQuickTrade(state: QuickTradeState) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    // Storage unavailable; the bar just won't reopen where it was.
  }
}

/** Where the bar first appears: centred near the bottom of the window. */
export function defaultQuickTradePosition(): QuickTradePosition {
  return { x: Math.round(window.innerWidth / 2 - 140), y: window.innerHeight - 100 };
}
