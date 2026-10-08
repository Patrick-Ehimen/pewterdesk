import type { ClosedTrade } from "@pewterdesk/core";
import { closedSince, closeReturn } from "./performance";

// "Edge": whether an account's closed positions add up to an advantage, how
// risky they've been, and how it trades after a loss. All from the closes
// themselves, in the order they happened: "after a loss" means the next
// position to close. How long one was held is known only where the venue's
// history reaches back to its opening (`openedAt`).

/** A group of closes: how many, and how they did. */
export interface Group {
  id: string;
  trades: number;
  /** Mean return on margin, in percent. */
  avgReturn: number;
  /** The middle return, in percent: what a typical one of them made. */
  medianReturn: number;
  /** 0-1. */
  winRate: number;
  /** PnL together, in the quote asset. */
  pnl: number;
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
/** How long a position was open: the groups by hold time. */
export const HOLD_BUCKETS = [
  { id: "under1m", below: MINUTE },
  { id: "under10m", below: 10 * MINUTE },
  { id: "under1h", below: HOUR },
  { id: "under1d", below: 24 * HOUR },
  { id: "under7d", below: 7 * 24 * HOUR },
  { id: "over7d", below: Number.POSITIVE_INFINITY },
] as const;
export type HoldBucket = (typeof HOLD_BUCKETS)[number]["id"];

/** What a position cost to open, in the quote asset: the groups by size. */
export const SIZE_BUCKETS = [
  { id: "under100", below: 100 },
  { id: "under500", below: 500 },
  { id: "under1k", below: 1_000 },
  { id: "under5k", below: 5_000 },
  { id: "under20k", below: 20_000 },
  { id: "over20k", below: Number.POSITIVE_INFINITY },
] as const;
export type SizeBucket = (typeof SIZE_BUCKETS)[number]["id"];

/** The return histogram's bars: each from its edge up to the next, in percent. */
export const RETURN_EDGES = [-100, -75, -50, -25, 0, 25, 50, 100, 200, 500] as const;

/** A close counts as a revenge trade when it comes this soon after a loss... */
export const REVENGE_WITHIN_MS = 30 * 60_000;
/** ...and is at least this many times the size of the one that lost. */
export const REVENGE_SIZE = 1.5;

export interface Edge {
  trades: number;
  /** Mean PnL per closed position, in the quote asset. */
  expectancy: number;
  /** What the winners made over what the losers lost; unset with no losses. */
  profitFactor?: number;
  /** 0-1. */
  winRate: number;
  /** The median win over the median loss; unset without both. */
  payoff?: number;
  /** The return (percent) only one close in twenty did worse than. */
  var95?: number;
  /** The mean return of that worst twentieth. */
  cvar95?: number;
  /** The deepest fall of the running PnL from a peak (negative), in the quote asset. */
  maxDrawdown: number;
  long: Group;
  short: Group;
  /** Every hold-time group, in order; the empty ones have no trades. */
  holds: Group[];
  /** Closes whose opening isn't known, so they're in no hold-time group. */
  undated: number;
  /** Every size group, in order. */
  sizes: Group[];
  /** Larger positions closed soon after a loss. */
  revenge: number;
  /** Win rate of the closes that followed a loss, 0-1; unset without any. */
  afterLossWinRate?: number;
  /** The longest runs of wins and of losses. */
  winStreak: number;
  lossStreak: number;
  /**
   * How much a result repeats the one before: 1 when wins follow wins and
   * losses follow losses, -1 when they alternate, 0 when there's no
   * pattern. Unset with too few closes to say.
   */
  streakiness?: number;
  /** Mean size after a loss over mean size after a win; unset without both. */
  tiltRatio?: number;
  /** Of the closes after a loss, the share that were bigger than it, 0-1. */
  martingale?: number;
  /** Closes per bar of `RETURN_EDGES`. */
  histogram: number[];
}

const sum = (xs: readonly number[]) => xs.reduce((a, b) => a + b, 0);
const mean = (xs: readonly number[]) => (xs.length > 0 ? sum(xs) / xs.length : 0);

function median(xs: readonly number[]): number | undefined {
  if (xs.length === 0) return undefined;
  const sorted = [...xs].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2
    ? sorted[mid]
    : ((sorted[mid - 1] as number) + (sorted[mid] as number)) / 2;
}

function group(id: string, closes: readonly ClosedTrade[]): Group {
  const returns = closes.map((c) => closeReturn(c) ?? 0);
  return {
    id,
    trades: closes.length,
    avgReturn: mean(returns),
    medianReturn: median(returns) ?? 0,
    winRate:
      closes.length > 0 ? closes.filter((c) => Number(c.closedPnl) > 0).length / closes.length : 0,
    pnl: sum(closes.map((c) => Number(c.closedPnl))),
  };
}

/** How long a close's position was open, in ms; unset where its opening isn't known. */
export function holdTime(c: ClosedTrade): number | undefined {
  return c.openedAt !== undefined && c.openedAt <= c.time ? c.time - c.openedAt : undefined;
}

export function holdBucket(c: ClosedTrade): HoldBucket | undefined {
  const held = holdTime(c);
  if (held === undefined) return undefined;
  return (HOLD_BUCKETS.find((b) => held < b.below) ?? HOLD_BUCKETS[5]).id;
}

export function sizeBucket(c: ClosedTrade): SizeBucket {
  const value = Number(c.entryValue);
  return (SIZE_BUCKETS.find((b) => value < b.below) ?? SIZE_BUCKETS[5]).id;
}

/** The longest run of consecutive `true`s. */
function longestRun(flags: readonly boolean[]): number {
  let run = 0;
  let best = 0;
  for (const flag of flags) {
    run = flag ? run + 1 : 0;
    best = Math.max(best, run);
  }
  return best;
}

/** Correlation between each result (win 1, loss 0) and the one before it. */
function lagOne(outcomes: readonly number[]): number | undefined {
  if (outcomes.length < 4) return undefined;
  const a = outcomes.slice(0, -1);
  const b = outcomes.slice(1);
  const ma = mean(a);
  const mb = mean(b);
  const cov = sum(a.map((x, i) => (x - ma) * ((b[i] as number) - mb)));
  const spread = Math.sqrt(sum(a.map((x) => (x - ma) ** 2)) * sum(b.map((x) => (x - mb) ** 2)));
  return spread > 0 ? cov / spread : 0;
}

export function edge(trades: readonly ClosedTrade[], since: number): Edge {
  const closes = closedSince(trades, since);
  const pnls = closes.map((c) => Number(c.closedPnl));
  const returns = closes.map((c) => closeReturn(c) ?? 0);
  const won = pnls.filter((p) => p > 0);
  const lost = pnls.filter((p) => p < 0);

  // The worst twentieth of the returns, at least one close.
  const ordered = [...returns].sort((a, b) => a - b);
  const tail = ordered.slice(0, Math.max(1, Math.floor(ordered.length * 0.05)));

  let peak = 0;
  let total = 0;
  let maxDrawdown = 0;
  for (const pnl of pnls) {
    total += pnl;
    peak = Math.max(peak, total);
    maxDrawdown = Math.min(maxDrawdown, total - peak);
  }

  // Each close with the one before it.
  const pairs = closes.slice(1).map((c, i) => ({ c, before: closes[i] as ClosedTrade }));
  const afterLoss = pairs.filter((p) => Number(p.before.closedPnl) < 0);
  const afterWin = pairs.filter((p) => Number(p.before.closedPnl) > 0);
  const value = (c: ClosedTrade) => Number(c.entryValue);
  const sizeAfterWin = mean(afterWin.map((p) => value(p.c)));
  const medWin = median(won);
  const medLoss = median(lost);

  const histogram = RETURN_EDGES.map(() => 0);
  for (const r of returns) {
    let bar = 0;
    for (let i = 0; i < RETURN_EDGES.length; i++) {
      if (r >= (RETURN_EDGES[i] as number)) bar = i;
    }
    histogram[bar] = (histogram[bar] ?? 0) + 1;
  }

  return {
    trades: closes.length,
    expectancy: mean(pnls),
    profitFactor: lost.length > 0 ? sum(won) / -sum(lost) : undefined,
    winRate: closes.length > 0 ? won.length / closes.length : 0,
    payoff: medWin !== undefined && medLoss !== undefined ? medWin / -medLoss : undefined,
    var95: closes.length > 0 ? tail.at(-1) : undefined,
    cvar95: closes.length > 0 ? mean(tail) : undefined,
    maxDrawdown,
    long: group(
      "long",
      closes.filter((c) => c.side === "long"),
    ),
    short: group(
      "short",
      closes.filter((c) => c.side === "short"),
    ),
    holds: HOLD_BUCKETS.map((b) =>
      group(
        b.id,
        closes.filter((c) => holdBucket(c) === b.id),
      ),
    ),
    undated: closes.filter((c) => holdTime(c) === undefined).length,
    sizes: SIZE_BUCKETS.map((b) =>
      group(
        b.id,
        closes.filter((c) => sizeBucket(c) === b.id),
      ),
    ),
    revenge: afterLoss.filter(
      (p) =>
        p.c.time - p.before.time <= REVENGE_WITHIN_MS &&
        value(p.before) > 0 &&
        value(p.c) >= value(p.before) * REVENGE_SIZE,
    ).length,
    afterLossWinRate:
      afterLoss.length > 0
        ? afterLoss.filter((p) => Number(p.c.closedPnl) > 0).length / afterLoss.length
        : undefined,
    winStreak: longestRun(pnls.map((p) => p > 0)),
    lossStreak: longestRun(pnls.map((p) => p < 0)),
    streakiness: lagOne(pnls.filter((p) => p !== 0).map((p) => (p > 0 ? 1 : 0))),
    tiltRatio:
      afterLoss.length > 0 && sizeAfterWin > 0
        ? mean(afterLoss.map((p) => value(p.c))) / sizeAfterWin
        : undefined,
    martingale:
      afterLoss.length > 0
        ? afterLoss.filter((p) => value(p.c) > value(p.before)).length / afterLoss.length
        : undefined,
    histogram,
  };
}

/**
 * The best and worst of some groups by their typical (median) return. With
 * one group traded there's a best and no worst.
 */
export function extremes(groups: readonly Group[]): { best?: Group; worst?: Group } {
  const traded = groups.filter((g) => g.trades > 0);
  if (traded.length === 0) return {};
  const ordered = [...traded].sort((a, b) => b.medianReturn - a.medianReturn);
  return { best: ordered[0], worst: ordered.length > 1 ? ordered.at(-1) : undefined };
}
