import type { CardPosition } from "@pewterdesk/ui";

const STORAGE_KEY = "pd.pnlCard";

/** The floating PnL card: open or not, and where, across restarts. */
export interface PnlCardState {
  open: boolean;
  /** Unset until it's first moved; it then appears above the bottom bar's left end. */
  position?: CardPosition;
}

const isPosition = (p: unknown): p is CardPosition =>
  typeof p === "object" &&
  p !== null &&
  Number.isFinite((p as CardPosition).x) &&
  Number.isFinite((p as CardPosition).y);

export function loadPnlCard(): PnlCardState {
  try {
    const saved: unknown = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "null");
    if (typeof saved !== "object" || saved === null) return { open: false };
    const { open, position } = saved as Record<string, unknown>;
    return { open: open === true, position: isPosition(position) ? position : undefined };
  } catch {
    return { open: false };
  }
}

export function savePnlCard(state: PnlCardState) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    // Storage unavailable; the card just won't reopen where it was.
  }
}

/** Where the card first appears: bottom left, above the bar. */
export function defaultPnlPosition(): CardPosition {
  return { x: 16, y: window.innerHeight - 200 };
}
