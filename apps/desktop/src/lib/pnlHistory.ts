// The floating PnL card's figure and its line: all-time PnL (realised over
// the account's life plus what's open now), measured from the last reset,
// and samples of it over time. Kept per account in browser storage; nothing
// leaves the machine.

/** One sample: when (ms since the epoch) and the PnL then, in the quote asset. */
export type PnlPoint = [time: number, pnl: number];

export interface PnlHistory {
  /** All-time PnL when it was last reset; the card shows PnL above it. 0 if never reset. */
  baseline: number;
  /** When it was last reset; unset if never. */
  resetAt?: number;
  /** Oldest first, each PnL already measured from the baseline. */
  points: PnlPoint[];
}

const STORAGE_PREFIX = "pd.pnlHistory.";
/** A new sample at most this often; in between, the latest replaces the last. */
export const SAMPLE_MS = 60_000;
/** Past this many samples, the older half is thinned to every other one. */
export const MAX_POINTS = 720;

export const EMPTY_HISTORY: PnlHistory = { baseline: 0, points: [] };

type Storage = Pick<globalThis.Storage, "getItem" | "setItem">;

function storage(): Storage | undefined {
  try {
    return localStorage;
  } catch {
    return undefined;
  }
}

const isPoint = (p: unknown): p is PnlPoint =>
  Array.isArray(p) && p.length === 2 && p.every((n) => typeof n === "number" && Number.isFinite(n));

export function loadPnlHistory(account: string, from: Storage | undefined = storage()): PnlHistory {
  try {
    const saved: unknown = JSON.parse(from?.getItem(STORAGE_PREFIX + account) ?? "null");
    if (typeof saved !== "object" || saved === null) return EMPTY_HISTORY;
    const { baseline, resetAt, points } = saved as Record<string, unknown>;
    return {
      baseline: typeof baseline === "number" && Number.isFinite(baseline) ? baseline : 0,
      resetAt: typeof resetAt === "number" && Number.isFinite(resetAt) ? resetAt : undefined,
      points: Array.isArray(points) ? points.filter(isPoint) : [],
    };
  } catch {
    return EMPTY_HISTORY;
  }
}

export function savePnlHistory(
  account: string,
  history: PnlHistory,
  to: Storage | undefined = storage(),
) {
  try {
    to?.setItem(STORAGE_PREFIX + account, JSON.stringify(history));
  } catch {
    // Storage unavailable; the line just starts over next time.
  }
}

/** All-time PnL: realised over the account's life (where known) plus open positions'. */
export function allTimePnl(realized: number | undefined, unrealized: number): number {
  return (realized ?? 0) + unrealized;
}

/** `history` with the PnL at `time` added: a new sample, or the last one updated. */
export function recordPnl(history: PnlHistory, time: number, allTime: number): PnlHistory {
  const pnl = allTime - history.baseline;
  const points = [...history.points];
  const last = points.at(-1);
  // The first sample (the reset's zero) stays put; later ones roll up into the minute.
  if (last && points.length > 1 && time - last[0] < SAMPLE_MS)
    points[points.length - 1] = [time, pnl];
  else points.push([time, pnl]);
  if (points.length > MAX_POINTS) {
    const half = Math.floor(points.length / 2);
    const thinned = points.slice(0, half).filter((_, i) => i % 2 === 0);
    return { ...history, points: [...thinned, ...points.slice(half)] };
  }
  return { ...history, points };
}

/** Starts over from now: the card reads zero, and the line starts here. */
export function resetPnl(time: number, allTime: number): PnlHistory {
  return { baseline: allTime, resetAt: time, points: [[time, 0]] };
}
