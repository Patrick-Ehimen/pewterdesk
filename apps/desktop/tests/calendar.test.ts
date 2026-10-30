import { describe, expect, it } from "vitest";
import type { CalendarEvent } from "../src/api/venueClient";
import {
  byDay,
  CHART_NEWS_AHEAD_MS,
  chartNews,
  clears,
  countdown,
  DEFAULT_VIEW,
  LIVE_FOR_MS,
  nextMajor,
  visibleEvents,
} from "../src/lib/calendar";

const HOUR = 3_600_000;
const NOW = new Date(2026, 9, 14, 12, 0).getTime();

const event = (
  title: string,
  at: number,
  impact: CalendarEvent["impact"] = "high",
): CalendarEvent => ({
  title,
  currency: "USD",
  time: at,
  impact,
  forecast: null,
  previous: null,
});

describe("calendar", () => {
  it("shows an impact and up, holidays from medium", () => {
    expect(clears("high", "high")).toBe(true);
    expect(clears("medium", "high")).toBe(false);
    expect(clears("medium", "medium")).toBe(true);
    expect(clears("low", "medium")).toBe(false);
    expect(clears("holiday", "high")).toBe(false);
    expect(clears("holiday", "medium")).toBe(true);
    expect(clears("low", "all")).toBe(true);
  });

  it("leaves out what's past unless asked, but keeps an event a while after its time", () => {
    const events = [
      event("later", NOW + HOUR),
      event("long gone", NOW - 2 * HOUR),
      event("just out", NOW - LIVE_FOR_MS + 60_000),
      event("minor", NOW + HOUR, "low"),
    ];
    expect(visibleEvents(events, DEFAULT_VIEW, NOW).map((e) => e.title)).toEqual([
      "just out",
      "later",
    ]);
    expect(visibleEvents(events, { floor: "high", showPast: true }, NOW)).toHaveLength(3);
    expect(visibleEvents(events, { floor: "all", showPast: false }, NOW)).toHaveLength(3);
  });

  it("finds the next high-impact event still to come", () => {
    const events = [
      event("past", NOW - HOUR),
      event("medium", NOW + HOUR, "medium"),
      event("second", NOW + 3 * HOUR),
      event("first", NOW + 2 * HOUR),
    ];
    expect(nextMajor(events, NOW)?.title).toBe("first");
    expect(nextMajor([event("medium", NOW + HOUR, "medium")], NOW)).toBeUndefined();
  });

  it("groups by day on this machine's clock", () => {
    const tomorrow = new Date(2026, 9, 15, 0, 30).getTime();
    const days = byDay([event("a", NOW), event("b", NOW + HOUR), event("c", tomorrow)]);
    expect(days.map((d) => d.events.length)).toEqual([2, 1]);
    expect(days[1]?.start).toBe(new Date(2026, 9, 15).getTime());
  });

  it("counts down in days, hours and minutes", () => {
    expect(countdown(NOW + 12 * 60_000, NOW)).toBe("12m");
    expect(countdown(NOW + 3 * HOUR + 5 * 60_000, NOW)).toBe("3h 05m");
    expect(countdown(NOW + 50 * HOUR, NOW)).toBe("2d 2h");
    expect(countdown(NOW - HOUR, NOW)).toBe("0m");
  });
});

describe("chartNews", () => {
  it("keeps USD releases of high or medium impact, with their figures", () => {
    const at = (title: string, impact: CalendarEvent["impact"], currency = "USD") => ({
      ...event(title, NOW, impact),
      currency,
      forecast: "3.2%",
    });
    const shown = chartNews(
      [
        at("CPI", "high"),
        at("Claims", "medium"),
        at("Auction", "low"),
        at("Bank holiday", "holiday"),
        at("ECB", "high", "EUR"),
      ],
      NOW,
    );
    expect(shown.map((e) => e.title)).toEqual(["CPI", "Claims"]);
    expect(shown[0]?.forecast).toBe("3.2%");
  });

  it("marks releases past and to come, up to a week ahead", () => {
    const shown = chartNews(
      [
        event("Past", NOW - HOUR),
        event("In a week", NOW + CHART_NEWS_AHEAD_MS),
        event("Too far", NOW + CHART_NEWS_AHEAD_MS + 1),
      ],
      NOW,
    );
    expect(shown.map((e) => e.title)).toEqual(["Past", "In a week"]);
  });
});
