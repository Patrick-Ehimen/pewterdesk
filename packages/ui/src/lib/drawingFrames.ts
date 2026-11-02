// Which timeframes a drawing shows on, as ticks: minutes, hours, days, weeks,
// months. The chart keeps one unbroken range, so the gaps in a run of ticks are
// kept beside it, on the drawing's props, and left out by `frameFilter`.

export type FrameGroup = "minutes" | "hours" | "days" | "weeks" | "months";
export const FRAME_GROUPS: readonly FrameGroup[] = ["minutes", "hours", "days", "weeks", "months"];

export interface FrameRange {
  from?: string;
  to?: string;
}

/** The group an interval code ("15m", "4h", "3MN") belongs to. */
export function groupOf(code: string): FrameGroup | undefined {
  if (code.endsWith("MN")) return "months";
  const unit = code.at(-1);
  if (unit === "m") return "minutes";
  if (unit === "h") return "hours";
  if (unit === "d") return "days";
  return unit === "w" ? "weeks" : undefined;
}

/** The groups a range shows on, of `intervals` (shortest first). */
export function tickedGroups(
  range: FrameRange | null | undefined,
  intervals: readonly string[],
): FrameGroup[] {
  const at = (code: string | undefined, otherwise: number) => {
    const i = code === undefined ? -1 : intervals.indexOf(code);
    return i < 0 ? otherwise : i;
  };
  const from = at(range?.from, 0);
  const to = at(range?.to, intervals.length - 1);
  const shown = intervals.slice(Math.min(from, to), Math.max(from, to) + 1);
  return FRAME_GROUPS.filter((group) => shown.some((code) => groupOf(code) === group));
}

/** Whether `group`'s tick can change: any can, but the last one left. */
export function canToggle(group: FrameGroup, ticked: readonly FrameGroup[]): boolean {
  return !ticked.includes(group) || ticked.length > 1;
}

/** The range for these groups; null when they're all on, which is no limit at all. */
export function rangeOf(
  ticked: readonly FrameGroup[],
  intervals: readonly string[],
): FrameRange | null {
  if (ticked.length === FRAME_GROUPS.length) return null;
  const shown = intervals.filter((code) => {
    const group = groupOf(code);
    return group !== undefined && ticked.includes(group);
  });
  return { from: shown[0], to: shown.at(-1) };
}

/** The group a chart is on, by the seconds between its bars. */
export function groupOfBarSeconds(seconds: number): FrameGroup {
  if (seconds < 3_600) return "minutes";
  if (seconds < 86_400) return "hours";
  if (seconds < 6 * 86_400) return "days";
  return seconds < 27 * 86_400 ? "weeks" : "months";
}

/** The groups a drawing shows on: its range, without those it leaves out inside it. */
export function shownGroups(
  range: FrameRange | null | undefined,
  hidden: readonly string[] | undefined,
  intervals: readonly string[],
): FrameGroup[] {
  return tickedGroups(range, intervals).filter((group) => !hidden?.includes(group));
}

/**
 * What the chart keeps for these ticks: the one range it can hold, from the
 * first ticked to the last, and the groups inside it to leave out, which the
 * chart can't and `frameFilter` does.
 */
export function framesOf(ticked: readonly FrameGroup[], intervals: readonly string[]) {
  const range = rangeOf(ticked, intervals);
  const hidden = tickedGroups(range, intervals).filter((group) => !ticked.includes(group));
  return { range, hidden: hidden.length > 0 ? hidden : undefined };
}
