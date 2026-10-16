import type { CalendarEvent, CalendarImpact } from "../api/venueClient";

// The Calendar panel's plain logic: which of the week's events to show,
// grouped by day on this machine's clock, and how long until the next.

/** The least impact shown: "high" alone, "medium" and up, or everything. */
export type ImpactFloor = "high" | "medium" | "all";

export interface CalendarView {
  floor: ImpactFloor;
  /** Events already out are listed too, dimmed. */
  showPast: boolean;
}

export const DEFAULT_VIEW: CalendarView = { floor: "high", showPast: false };

const KEY = "pd.calendar";

/** An event stays "now" this long after its time, before it counts as past. */
export const LIVE_FOR_MS = 15 * 60_000;

const RANK: Record<CalendarImpact, number> = { high: 3, medium: 2, low: 1, holiday: 0 };

/** Whether an event of `impact` clears the floor. Holidays show with medium and up. */
export function clears(impact: CalendarImpact, floor: ImpactFloor): boolean {
  if (floor === "all") return true;
  if (impact === "holiday") return floor === "medium";
  return RANK[impact] >= RANK[floor];
}

export const isPast = (event: CalendarEvent, now: number) => event.time + LIVE_FOR_MS <= now;

/** The events the view shows, soonest first. */
export function visibleEvents(
  events: readonly CalendarEvent[],
  view: CalendarView,
  now: number,
): CalendarEvent[] {
  return events
    .filter((e) => clears(e.impact, view.floor) && (view.showPast || !isPast(e, now)))
    .sort((a, b) => a.time - b.time);
}

/** The soonest high-impact event not yet out, if this week has one. */
export function nextMajor(
  events: readonly CalendarEvent[],
  now: number,
): CalendarEvent | undefined {
  return events
    .filter((e) => e.impact === "high" && e.time > now)
    .reduce<CalendarEvent | undefined>(
      (soonest, e) => (!soonest || e.time < soonest.time ? e : soonest),
      undefined,
    );
}

export interface CalendarDay {
  /** Midnight starting the day, on this machine's clock. */
  start: number;
  events: CalendarEvent[];
}

const dayStart = (time: number) => {
  const d = new Date(time);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
};

/** Events by day on this machine's clock, in the order given. */
export function byDay(events: readonly CalendarEvent[]): CalendarDay[] {
  const days: CalendarDay[] = [];
  for (const event of events) {
    const start = dayStart(event.time);
    const last = days.at(-1);
    if (last?.start === start) last.events.push(event);
    else days.push({ start, events: [event] });
  }
  return days;
}

/** Which day `start` is next to today: 0 today, 1 tomorrow, -1 yesterday. */
export function daysFrom(start: number, now: number): number {
  return Math.round((start - dayStart(now)) / 86_400_000);
}

/** How long until `time`, as "2d 4h", "3h 05m" or "12m"; "0m" once it's here. */
export function countdown(time: number, now: number): string {
  const minutes = Math.max(0, Math.ceil((time - now) / 60_000));
  const days = Math.floor(minutes / 1440);
  const hours = Math.floor((minutes % 1440) / 60);
  const mins = minutes % 60;
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${String(mins).padStart(2, "0")}m`;
  return `${mins}m`;
}

export function loadView(): CalendarView {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? "null") as Partial<CalendarView> | null;
    const floor = raw?.floor;
    return {
      floor: floor === "high" || floor === "medium" || floor === "all" ? floor : DEFAULT_VIEW.floor,
      showPast: raw?.showPast === true,
    };
  } catch {
    return DEFAULT_VIEW;
  }
}

export function saveView(view: CalendarView) {
  try {
    localStorage.setItem(KEY, JSON.stringify(view));
  } catch {
    // Kept for this session only.
  }
}
