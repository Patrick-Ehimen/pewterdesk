import type { ClosedTrade } from "@pewterdesk/core";

// What an account's closed positions add up to: the realized PnL over time,
// how the trades went, and each day's result for the PnL calendar.
// Display-only arithmetic, through JS numbers.

const DAY_MS = 24 * 60 * 60 * 1000;

/** The windows the Portfolio page shows, with how far back each reaches. */
export const RANGES = ["1d", "7d", "30d", "90d"] as const;
export type Range = (typeof RANGES)[number];
export const RANGE_MS: Record<Range, number> = {
  "1d": DAY_MS,
  "7d": 7 * DAY_MS,
  "30d": 30 * DAY_MS,
  "90d": 90 * DAY_MS,
};
/** The longest of them: how much history the page asks for. */
export const HISTORY_MS = RANGE_MS["90d"];

/** The closes at or after `since`, oldest first. */
export function closedSince(trades: readonly ClosedTrade[], since: number): ClosedTrade[] {
  return trades.filter((c) => c.time >= since).sort((a, b) => a.time - b.time);
}

export interface PnlPoint {
  time: number;
  /** Realized PnL from the start of the window to here. */
  total: number;
}

/**
 * The running realized PnL over the window: zero at `since`, a step at each
 * close, and level from the last one to `now`.
 */
export function pnlCurve(trades: readonly ClosedTrade[], since: number, now: number): PnlPoint[] {
  const points: PnlPoint[] = [{ time: since, total: 0 }];
  let total = 0;
  for (const c of closedSince(trades, since)) {
    total += Number(c.closedPnl);
    points.push({ time: c.time, total });
  }
  points.push({ time: now, total });
  return points;
}

/** Return on the margin a close used: its PnL over its cost at its leverage. */
export function closeReturn(c: ClosedTrade): number | undefined {
  const value = Number(c.entryValue);
  const leverage = Number(c.leverage) > 0 ? Number(c.leverage) : 1;
  const margin = value / leverage;
  return margin > 0 ? (Number(c.closedPnl) / margin) * 100 : undefined;
}

/** How a close went, by its return on margin. Best first. */
export const BUCKETS = ["over500", "over200", "gain", "loss", "under50"] as const;
export type Bucket = (typeof BUCKETS)[number];

export function bucketOf(c: ClosedTrade): Bucket {
  const pnl = Number(c.closedPnl);
  const roi = closeReturn(c) ?? (pnl >= 0 ? 0 : -1);
  if (roi > 500) return "over500";
  if (roi > 200) return "over200";
  if (pnl >= 0) return "gain";
  return roi < -50 ? "under50" : "loss";
}

export interface Performance {
  /** Realized PnL over the window, after fees. */
  realized: number;
  trades: number;
  wins: number;
  losses: number;
  /** Wins over trades, 0-1; 0 without trades. */
  winRate: number;
  /** The largest single gain and loss (a loss is negative); 0 without one. */
  best: number;
  worst: number;
  /** The average winning and losing close; 0 without one. */
  avgWin: number;
  avgLoss: number;
  buckets: Record<Bucket, number>;
}

export function performance(trades: readonly ClosedTrade[], since: number): Performance {
  const closes = closedSince(trades, since);
  const pnls = closes.map((c) => Number(c.closedPnl));
  const won = pnls.filter((p) => p > 0);
  const lost = pnls.filter((p) => p < 0);
  const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
  const buckets: Record<Bucket, number> = { over500: 0, over200: 0, gain: 0, loss: 0, under50: 0 };
  for (const c of closes) buckets[bucketOf(c)]++;
  return {
    realized: sum(pnls),
    trades: closes.length,
    wins: won.length,
    losses: lost.length,
    winRate: closes.length > 0 ? won.length / closes.length : 0,
    best: won.length > 0 ? Math.max(...won) : 0,
    worst: lost.length > 0 ? Math.min(...lost) : 0,
    avgWin: won.length > 0 ? sum(won) / won.length : 0,
    avgLoss: lost.length > 0 ? sum(lost) / lost.length : 0,
    buckets,
  };
}

/** A local calendar day as `YYYY-MM-DD`, for grouping closes by the day they fell on. */
export function dayKey(time: number): string {
  const d = new Date(time);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** Each day's realized PnL and number of closes, by `dayKey`. */
export function dailyPnl(
  trades: readonly ClosedTrade[],
): Map<string, { pnl: number; trades: number }> {
  const days = new Map<string, { pnl: number; trades: number }>();
  for (const c of trades) {
    const key = dayKey(c.time);
    const day = days.get(key) ?? { pnl: 0, trades: 0 };
    day.pnl += Number(c.closedPnl);
    day.trades++;
    days.set(key, day);
  }
  return days;
}

export interface CalendarDay {
  /** Day of the month, 1-31. */
  day: number;
  key: string;
  pnl: number;
  trades: number;
  /** After `now`: nothing can have closed yet. */
  future: boolean;
}

export interface PnlCalendar {
  year: number;
  /** 0-11. */
  month: number;
  /** Blank cells before the 1st, for a week that starts on Monday. */
  lead: number;
  days: CalendarDay[];
  total: number;
  /** Days that ended up, and what they made together. */
  upDays: number;
  upTotal: number;
  /** Days that ended down, and what they lost together (negative). */
  downDays: number;
  downTotal: number;
  /** Days with at least one close. */
  activeDays: number;
  /** The longest run of consecutive up days this month. */
  bestStreak: number;
}

/** One month of the account's days, in local time. */
export function pnlCalendar(
  trades: readonly ClosedTrade[],
  year: number,
  month: number,
  now: number,
): PnlCalendar {
  const byDay = dailyPnl(trades);
  const count = new Date(year, month + 1, 0).getDate();
  const today = dayKey(now);
  const days: CalendarDay[] = [];
  for (let day = 1; day <= count; day++) {
    const key = dayKey(new Date(year, month, day).getTime());
    const found = byDay.get(key);
    days.push({ day, key, pnl: found?.pnl ?? 0, trades: found?.trades ?? 0, future: key > today });
  }
  const up = days.filter((d) => d.pnl > 0);
  const down = days.filter((d) => d.pnl < 0);
  let run = 0;
  let bestStreak = 0;
  for (const d of days) {
    run = d.pnl > 0 ? run + 1 : 0;
    bestStreak = Math.max(bestStreak, run);
  }
  return {
    year,
    month,
    // getDay(): 0 is Sunday; Monday-first puts Sunday last.
    lead: (new Date(year, month, 1).getDay() + 6) % 7,
    days,
    total: days.reduce((sum, d) => sum + d.pnl, 0),
    upDays: up.length,
    upTotal: up.reduce((sum, d) => sum + d.pnl, 0),
    downDays: down.length,
    downTotal: down.reduce((sum, d) => sum + d.pnl, 0),
    activeDays: days.filter((d) => d.trades > 0).length,
    bestStreak,
  };
}

/**
 * Consecutive up days ending today (or yesterday, if nothing has closed
 * today yet): the streak still running. A day without a close ends it.
 */
export function currentStreak(trades: readonly ClosedTrade[], now: number): number {
  const byDay = dailyPnl(trades);
  let day = new Date(now);
  if (!byDay.has(dayKey(day.getTime()))) day = new Date(day.getTime() - DAY_MS);
  let streak = 0;
  while ((byDay.get(dayKey(day.getTime()))?.pnl ?? 0) > 0) {
    streak++;
    day = new Date(day.getFullYear(), day.getMonth(), day.getDate() - 1);
  }
  return streak;
}

export interface CurveDot extends PnlPoint {
  x: number;
  y: number;
  /** What this point added to the total: the close it marks. */
  change: number;
}

/**
 * The curve as an area chart in `width` x `height`: the line through every
 * point, the same closed down to the bottom edge, where zero falls, and
 * each point's place, for a pointer to find.
 */
export function curvePath(
  points: readonly PnlPoint[],
  width: number,
  height: number,
): { line: string; area: string; zero: number; dots: CurveDot[] } | undefined {
  const first = points[0];
  const last = points.at(-1);
  if (!first || !last || points.length < 2) return undefined;
  const totals = points.map((p) => p.total);
  const lo = Math.min(0, ...totals);
  const hi = Math.max(0, ...totals);
  const range = hi - lo || 1;
  const span = Math.max(1, last.time - first.time);
  const x = (time: number) => ((time - first.time) / span) * width;
  // The curve keeps to the lower part: the top quarter is left clear for
  // the pointer and the tooltip that follows it, with a little room below.
  const y = (total: number) => height * 0.28 + (1 - (total - lo) / range) * height * 0.66;
  const dots = points.map((p, i) => ({
    ...p,
    x: x(p.time),
    y: y(p.total),
    change: i === 0 ? 0 : p.total - (points[i - 1] as PnlPoint).total,
  }));
  const line = dots
    .map((d, i) => `${i === 0 ? "M" : "L"}${d.x.toFixed(1)},${d.y.toFixed(1)}`)
    .join("");
  return { line, area: `${line}L${width},${height}L0,${height}Z`, zero: y(0), dots };
}

/** The point nearest `x` (in the chart's own units), for the pointer. */
export function nearestDot(dots: readonly CurveDot[], x: number): CurveDot | undefined {
  let best: CurveDot | undefined;
  for (const dot of dots) {
    if (!best || Math.abs(dot.x - x) < Math.abs(best.x - x)) best = dot;
  }
  return best;
}
