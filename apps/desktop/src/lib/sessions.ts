// The bottom bar's clock: which of the big stock-market sessions are open,
// and when that changes. Hours are each exchange's own local time, read
// through its time zone, so daylight saving comes out right. Holidays
// aren't known here.

export type SessionId = "tokyo" | "london" | "newYork";

interface Session {
  id: SessionId;
  timeZone: string;
  /** Local opening and closing time, in minutes after midnight. */
  open: number;
  close: number;
}

export const SESSIONS: readonly Session[] = [
  { id: "tokyo", timeZone: "Asia/Tokyo", open: 9 * 60, close: 15 * 60 },
  { id: "london", timeZone: "Europe/London", open: 8 * 60, close: 16 * 60 + 30 },
  { id: "newYork", timeZone: "America/New_York", open: 9 * 60 + 30, close: 16 * 60 },
];

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;

const formatters = new Map<string, Intl.DateTimeFormat>();

/** How far `timeZone` is ahead of UTC at `now`, in ms. */
export function zoneOffset(timeZone: string, now: number): number {
  let f = formatters.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
      second: "numeric",
    });
    formatters.set(timeZone, f);
  }
  const part = (type: string) =>
    Number(f?.formatToParts(now).find((p) => p.type === type)?.value ?? 0);
  const asUtc = Date.UTC(
    part("year"),
    part("month") - 1,
    part("day"),
    part("hour"),
    part("minute"),
    part("second"),
  );
  return asUtc - Math.floor(now / 1000) * 1000;
}

export interface SessionState {
  id: SessionId;
  open: boolean;
  /** Until it closes (when open) or next opens (when closed), in ms. */
  untilChange: number;
}

const isWeekday = (day: number) => day >= 1 && day <= 5;

/** Whether `session` is open at `now`, and how long until that changes. */
export function sessionState(session: Session, now: number): SessionState {
  // Work in the exchange's local time, as if it were UTC.
  const local = now + zoneOffset(session.timeZone, now);
  const midnight = Math.floor(local / DAY) * DAY;
  const minutes = (local - midnight) / MINUTE;
  const day = new Date(midnight).getUTCDay();
  if (isWeekday(day) && minutes >= session.open && minutes < session.close) {
    return { id: session.id, open: true, untilChange: midnight + session.close * MINUTE - local };
  }
  // Next opening: later today if it's a weekday before the open, else the
  // next weekday.
  let start = midnight;
  if (!(isWeekday(day) && minutes < session.open)) {
    do start += DAY;
    while (!isWeekday(new Date(start).getUTCDay()));
  }
  return { id: session.id, open: false, untilChange: start + session.open * MINUTE - local };
}

/** Every session's state at `now`. */
export function sessionStates(now: number): SessionState[] {
  return SESSIONS.map((s) => sessionState(s, now));
}

/** "2h 10m", "45m", "3d 4h": how long until, at a glance. */
export function untilText(ms: number): string {
  const minutes = Math.max(0, Math.ceil(ms / MINUTE));
  const days = Math.floor(minutes / (24 * 60));
  const hours = Math.floor((minutes % (24 * 60)) / 60);
  const mins = minutes % 60;
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${mins}m`;
  return `${mins}m`;
}

/** "07:41:05" or "41:05": a countdown to the second. */
export function countdown(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const two = (n: number) => String(n).padStart(2, "0");
  return h > 0 ? `${two(h)}:${two(m)}:${two(s)}` : `${two(m)}:${two(s)}`;
}
