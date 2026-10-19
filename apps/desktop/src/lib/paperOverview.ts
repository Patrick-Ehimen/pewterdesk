import type { AccountSnapshot } from "@pewterdesk/core";
import type { PaperState } from "./paper";
import { type Performance, type PnlPoint, performance, pnlCurve } from "./performance";
import { portfolioSummary } from "./portfolio";

// What the Paper panel shows of the paper account: its figures, how its
// trades went, and its realized P&L over time. Display-only arithmetic over
// the paper state, through JS numbers; it changes nothing.

export interface PaperOverview {
  equity: number;
  /** Equity over what was put in: realized and open, after fees and funding. */
  pnl: number;
  /** `pnl` over what was put in, as a percentage. */
  pnlPct: number;
  unrealized: number;
  marginUsed: number;
  available: number;
  /** Fees paid on every fill, as a positive figure. */
  fees: number;
  /** Funding received (positive) or paid (negative). */
  funding: number;
  openPositions: number;
  /** How the closed positions went, over the account's whole life. */
  closes: Performance;
  /** Realized P&L from the first trade to `now`; one point if nothing has traded. */
  curve: PnlPoint[];
}

export function paperOverview(
  state: PaperState,
  snapshot: AccountSnapshot | undefined,
  now: number,
): PaperOverview {
  const summary = snapshot && portfolioSummary(snapshot);
  const equity = summary?.equity ?? state.cash;
  const pnl = equity - state.start;
  const sum = (xs: readonly { toString(): string }[]) =>
    xs.reduce<number>((total, x) => total + (Number(x) || 0), 0);
  // Fills are newest first: the oldest is where the curve starts.
  const first = state.fills.at(-1)?.time ?? state.closed.at(-1)?.time;
  return {
    equity,
    pnl,
    pnlPct: state.start > 0 ? (pnl / state.start) * 100 : 0,
    unrealized: summary?.unrealizedPnl ?? 0,
    marginUsed: summary?.marginUsed ?? 0,
    available: Number(snapshot?.availableMargin ?? state.cash),
    fees: Math.abs(sum(state.fills.map((f) => f.fee))),
    funding: sum(state.funding.map((f) => f.amount)),
    openPositions: state.positions.length,
    closes: performance(state.closed, 0),
    curve: first === undefined ? [{ time: now, total: 0 }] : pnlCurve(state.closed, first, now),
  };
}

/** Whether the Paper panel has been put in the layout once already. Outside `pd.paper.`, which the paper store watches. */
const OFFERED_KEY = "pd.paperPanel.offered";

export function paperPanelOffered(): boolean {
  try {
    return localStorage.getItem(OFFERED_KEY) === "1";
  } catch {
    // Blocked storage: don't keep adding it.
    return true;
  }
}

export function markPaperPanelOffered() {
  try {
    localStorage.setItem(OFFERED_KEY, "1");
  } catch {
    // Blocked storage: nothing to remember it in.
  }
}
