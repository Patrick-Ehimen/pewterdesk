import type { MarketSummary, Position } from "@pewterdesk/core";
import type { NewsItem } from "./news";

// The News page's Calendar view: the News page's own items laid out by day,
// after Bybit's Market Calendar. Before now, what happened (headlines,
// announcements as published); from now on, what's coming (announcements
// at the time they start, each open position's next funding). Plain logic,
// in the machine's time zone.

/** What a calendar entry is. */
export type CalendarKind = NewsItem["kind"] | "funding";

export interface CalendarEntry {
  id: string;
  kind: CalendarKind;
  /** When it happens (a start, a funding) or happened (a headline). Milliseconds. */
  time: number;
  /** It's a set time to come (a start, a funding), not a publication time. */
  scheduled: boolean;
  /** The headline or announcement it is; unset for a funding. */
  item?: NewsItem;
  /** The position a funding is for. */
  position?: Position;
  /** The funding rate, as a fraction. */
  rate?: number;
  /** Ids of the markets it's about. */
  markets: string[];
}

/** The calendar's filters: by kind, and token unlocks (no source yet). */
export const CALENDAR_FILTERS = [
  "all",
  "news",
  "listing",
  "delisting",
  "maintenance",
  "campaign",
  "funding",
  "unlock",
] as const;
export type CalendarFilter = (typeof CALENDAR_FILTERS)[number];

/** Midnight, local time, of the day `time` falls on. */
export function dayStart(time: number): number {
  const d = new Date(time);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/** Midnight of the day `days` after the one `day` starts (DST-safe). */
export function addDays(day: number, days: number): number {
  const d = new Date(day);
  d.setDate(d.getDate() + days);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/** The week strip around `day`: three days before it, it, three after. */
export function weekAround(day: number): number[] {
  return Array.from({ length: 7 }, (_, i) => addDays(dayStart(day), i - 3));
}

/**
 * Every entry: the items (an announcement at its start when it has one, a
 * headline when it was published) and each open position's next funding.
 */
export function calendarEntries(
  items: readonly NewsItem[],
  positions: readonly Position[],
  summaries: readonly MarketSummary[],
  now: number,
): CalendarEntry[] {
  const out: CalendarEntry[] = items.map((item) => {
    const scheduled = item.startsAt !== undefined;
    return {
      id: item.id,
      kind: item.kind,
      time: item.startsAt ?? item.time,
      scheduled,
      item,
      markets: item.markets,
    };
  });
  const byMarket = new Map(summaries.map((s) => [s.market, s]));
  for (const position of positions) {
    const s = byMarket.get(position.market);
    // Funding falls on the interval's boundaries, counted from midnight UTC.
    const every = (s?.fundingIntervalSecs ?? 0) * 1000;
    if (!s || every <= 0) continue;
    const time = (Math.floor(now / every) + 1) * every;
    out.push({
      id: `funding:${position.venue}:${position.market}:${time}`,
      kind: "funding",
      time,
      scheduled: true,
      position,
      rate: Number(s.fundingRate),
      markets: [position.market],
    });
  }
  return out.sort((a, b) => a.time - b.time);
}

/** Entries the filter and "my markets" keep. */
export function filterEntries(
  entries: readonly CalendarEntry[],
  filter: CalendarFilter,
  mine: boolean,
  yours: ReadonlySet<string>,
): CalendarEntry[] {
  return entries.filter(
    (e) =>
      (filter === "all" || e.kind === filter) &&
      // A funding is always yours: it's a position's.
      (!mine || e.kind === "funding" || e.markets.some((m) => yours.has(m))),
  );
}

/** One day's entries, in time order. */
export function entriesOn(entries: readonly CalendarEntry[], day: number): CalendarEntry[] {
  const end = addDays(day, 1);
  return entries.filter((e) => e.time >= day && e.time < end);
}

/** What a day holds, for its dots: how many headlines, how many scheduled. */
export function dayCounts(
  entries: readonly CalendarEntry[],
  day: number,
): { news: number; scheduled: number } {
  let news = 0;
  let scheduled = 0;
  for (const e of entriesOn(entries, day)) {
    if (e.scheduled) scheduled += 1;
    else news += 1;
  }
  return { news, scheduled };
}

/** A market's change over the day, in percent, from its summary. */
export function dayChange(summary: MarketSummary | undefined): number | undefined {
  const price = Number(summary?.markPrice);
  const prev = Number(summary?.prevDayPrice);
  return price > 0 && prev > 0 ? (price / prev - 1) * 100 : undefined;
}
