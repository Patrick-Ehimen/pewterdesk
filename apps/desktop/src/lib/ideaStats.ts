import { BIASES, type Bias, type Idea, TIMEFRAMES, type Timeframe } from "./ideas";

/**
 * The Ideas page's track record: how the trader's calls went, graded by
 * where they put them (Played out, Wrong), not by any trade. An archived
 * idea was let go, neither right nor wrong: it's counted apart.
 */

export const RECORD_PERIODS = ["30d", "90d", "all"] as const;
export type RecordPeriod = (typeof RECORD_PERIODS)[number];

const DAY = 86_400_000;
const periodStart = (period: RecordPeriod, now: number) =>
  period === "30d" ? now - 30 * DAY : period === "90d" ? now - 90 * DAY : 0;

/** A rate: how many played out of how many were graded. */
export interface Rate {
  graded: number;
  playedOut: number;
}
const rate = (): Rate => ({ graded: 0, playedOut: 0 });
export const share = (r: Rate) => (r.graded > 0 ? r.playedOut / r.graded : undefined);

/**
 * How far the price went from where the idea was noted to where it was
 * closed, in its own direction: up for a bullish idea, down for a bearish
 * one, either way for a range. Undefined without both prices.
 */
export function moveOf(idea: Idea): number | undefined {
  if (!idea.notedPrice || !idea.resolvedPrice) return undefined;
  const raw = (idea.resolvedPrice - idea.notedPrice) / idea.notedPrice;
  return idea.bias === "bearish" ? -raw : idea.bias === "range" ? Math.abs(raw) : raw;
}

export interface TrackRecord {
  /** The ideas closed in the period, newest first. */
  closed: Idea[];
  playedOut: number;
  wrong: number;
  /** Archived: let go without a verdict. */
  letGo: number;
  /** Still being watched (not graded). */
  watching: number;
  /** Average move, in each idea's direction, of the ones that played out and of the wrong ones. */
  avgWin?: number;
  avgLoss?: number;
  /** Median time from noting an idea to closing it (ms). */
  medianHeld?: number;
  byBias: Record<Bias, Rate>;
  byTimeframe: Record<Timeframe, Rate>;
  /** Index 0 is conviction 1. */
  byConviction: Rate[];
}

const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : undefined);
function median(xs: number[]) {
  if (!xs.length) return undefined;
  const sorted = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2;
}

export function trackRecord(
  ideas: readonly Idea[],
  period: RecordPeriod,
  now = Date.now(),
): TrackRecord {
  const from = periodStart(period, now);
  const closed = ideas
    .filter((i) => i.status !== "watching" && (i.resolvedAt ?? i.notedAt) >= from)
    .sort((a, b) => (b.resolvedAt ?? b.notedAt) - (a.resolvedAt ?? a.notedAt));
  const graded = closed.filter((i) => i.status === "playedOut" || i.status === "wrong");
  const byBias = Object.fromEntries(BIASES.map((b) => [b, rate()])) as Record<Bias, Rate>;
  const byTimeframe = Object.fromEntries(TIMEFRAMES.map((tf) => [tf, rate()])) as Record<
    Timeframe,
    Rate
  >;
  const byConviction = [1, 2, 3, 4, 5].map(rate);
  for (const idea of graded) {
    const won = idea.status === "playedOut" ? 1 : 0;
    for (const r of [
      byBias[idea.bias],
      byTimeframe[idea.timeframe],
      byConviction[idea.conviction - 1],
    ]) {
      if (!r) continue;
      r.graded += 1;
      r.playedOut += won;
    }
  }
  const moves = (status: Idea["status"]) =>
    graded.flatMap((i) => {
      const m = i.status === status ? moveOf(i) : undefined;
      return m === undefined ? [] : [m];
    });
  return {
    closed,
    playedOut: graded.filter((i) => i.status === "playedOut").length,
    wrong: graded.filter((i) => i.status === "wrong").length,
    letGo: closed.filter((i) => i.status === "archived").length,
    watching: ideas.filter((i) => i.status === "watching").length,
    avgWin: mean(moves("playedOut")),
    avgLoss: mean(moves("wrong")),
    medianHeld: median(
      graded.flatMap((i) => (i.resolvedAt ? [Math.max(0, i.resolvedAt - i.notedAt)] : [])),
    ),
    byBias,
    byTimeframe,
    byConviction,
  };
}

/** A finding worth saying, as a key and its figures (the page words it). */
export type Finding =
  | { kind: "weakBias"; bias: Bias; playedOut: number; graded: number }
  | { kind: "strongBias"; bias: Bias; playedOut: number; graded: number }
  | { kind: "conviction"; high: number; low: number };

/**
 * What the record says, when there's enough of it: the bias that does
 * worst and best (three graded at least), and whether high conviction
 * (4-5) beats low (1-3) or not.
 */
export function findings(record: TrackRecord): Finding[] {
  const out: Finding[] = [];
  const rated = BIASES.map((bias) => ({ bias, r: record.byBias[bias] }))
    .filter(({ r }) => r.graded >= 3)
    .sort((a, b) => (share(a.r) ?? 0) - (share(b.r) ?? 0));
  const worst = rated[0];
  const best = rated.at(-1);
  if (worst && best && worst !== best && (share(best.r) ?? 0) - (share(worst.r) ?? 0) >= 0.2) {
    out.push({ kind: "weakBias", bias: worst.bias, ...worst.r });
    out.push({ kind: "strongBias", bias: best.bias, ...best.r });
  }
  const sum = (rs: Rate[]) =>
    rs.reduce(
      (a, r) => ({ graded: a.graded + r.graded, playedOut: a.playedOut + r.playedOut }),
      rate(),
    );
  const high = sum(record.byConviction.slice(3));
  const low = sum(record.byConviction.slice(0, 3));
  const h = share(high);
  const l = share(low);
  if (h !== undefined && l !== undefined && high.graded >= 3 && low.graded >= 3) {
    out.push({ kind: "conviction", high: h, low: l });
  }
  return out;
}
