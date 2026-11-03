import type { FearGreedDay } from "../api/venueClient";

// The crypto Fear & Greed Index, as the Screener's gauge reads it. The bands
// are Alternative.me's own, read off its history: the feed names them, but
// the page names them itself, in the trader's language.

export type FearGreedBand = "extremeFear" | "fear" | "neutral" | "greed" | "extremeGreed";

/** Which way a band leans, for its colour: fear is red, greed green. */
export type FearGreedSide = "fear" | "neutral" | "greed";

const DAY = 86_400;

export function bandOf(value: number): FearGreedBand {
  if (value <= 25) return "extremeFear";
  if (value <= 46) return "fear";
  if (value <= 54) return "neutral";
  if (value <= 75) return "greed";
  return "extremeGreed";
}

export function sideOf(band: FearGreedBand): FearGreedSide {
  if (band === "extremeFear" || band === "fear") return "fear";
  if (band === "neutral") return "neutral";
  return "greed";
}

export type Comparison = "yesterday" | "week" | "month";

const AGO: Record<Comparison, number> = { yesterday: 1, week: 7, month: 30 };

/**
 * The reading `days` before the newest, or none if the feed has nothing
 * within a day of it (a gap in the source is left a gap).
 */
export function readingAgo(days: readonly FearGreedDay[], ago: number): FearGreedDay | undefined {
  const [today] = days;
  if (!today) return undefined;
  const at = today.time - ago * DAY;
  let best: FearGreedDay | undefined;
  for (const day of days) {
    if (Math.abs(day.time - at) >= DAY) continue;
    if (!best || Math.abs(day.time - at) < Math.abs(best.time - at)) best = day;
  }
  return best;
}

/** Yesterday's, last week's and last month's readings, where the feed has them. */
export function comparisons(days: readonly FearGreedDay[]) {
  return (Object.keys(AGO) as Comparison[]).flatMap((when) => {
    const day = readingAgo(days, AGO[when]);
    return day ? [{ when, value: day.value }] : [];
  });
}

/**
 * Where a value sits on the gauge's half circle, as a point around `(cx, cy)`
 * at radius `r`: 0 at the left end, 100 at the right, 50 at the top.
 */
export function gaugePoint(value: number, cx: number, cy: number, r: number) {
  const angle = Math.PI * (1 - Math.min(100, Math.max(0, value)) / 100);
  return { x: cx + r * Math.cos(angle), y: cy - r * Math.sin(angle) };
}
