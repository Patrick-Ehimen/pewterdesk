import type { MarketSummary, Position } from "@pewterdesk/core";
import { describe, expect, it } from "vitest";
import type { NewsItem } from "../src/lib/news";
import {
  addDays,
  calendarEntries,
  dayChange,
  dayCounts,
  dayStart,
  entriesOn,
  filterEntries,
  weekAround,
} from "../src/lib/newsCalendar";

const at = (y: number, mo: number, d: number, h = 0, mi = 0) =>
  new Date(y, mo - 1, d, h, mi).getTime();

const item = (id: string, over: Partial<NewsItem> = {}): NewsItem => ({
  id,
  kind: "news",
  title: id,
  description: "",
  tags: [],
  time: at(2026, 10, 23, 6, 44),
  markets: [],
  held: false,
  highImpact: false,
  ...over,
});

const position = (market: string) => ({ venue: "bybit", market, side: "long" }) as Position;
const summary = (market: string, over: Partial<MarketSummary> = {}) =>
  ({
    market,
    markPrice: "110",
    prevDayPrice: "100",
    fundingRate: "0.0001",
    fundingIntervalSecs: 8 * 3600,
    ...over,
  }) as MarketSummary;

describe("the news calendar's days", () => {
  it("lays out a week around the day, by local midnight", () => {
    const day = at(2026, 10, 23, 15, 30);
    const week = weekAround(day);
    expect(week).toHaveLength(7);
    expect(week[0]).toBe(at(2026, 10, 20));
    expect(week[3]).toBe(at(2026, 10, 23));
    expect(week[6]).toBe(at(2026, 10, 26));
    expect(dayStart(day)).toBe(at(2026, 10, 23));
    // Across a month's end.
    expect(addDays(at(2026, 10, 30), 3)).toBe(at(2026, 11, 2));
  });
});

describe("calendarEntries", () => {
  it("puts an announcement at its start and a headline when it came out", () => {
    const listing = item("listing", {
      kind: "listing",
      time: at(2026, 10, 22, 9),
      startsAt: at(2026, 10, 24, 10),
      markets: ["ANIMEUSDT"],
    });
    const entries = calendarEntries([item("headline"), listing], [], [], at(2026, 10, 23, 8));
    const byId = new Map(entries.map((e) => [e.id, e]));
    expect(byId.get("listing")?.time).toBe(at(2026, 10, 24, 10));
    expect(byId.get("listing")?.scheduled).toBe(true);
    expect(byId.get("headline")?.scheduled).toBe(false);
    // Soonest first.
    expect(entries.map((e) => e.id)).toEqual(["headline", "listing"]);
  });

  it("adds each open position's next funding, on the interval's boundary", () => {
    const now = Date.UTC(2026, 9, 23, 5, 0);
    const [funding] = calendarEntries([], [position("SOLUSDT")], [summary("SOLUSDT")], now);
    expect(funding?.kind).toBe("funding");
    expect(funding?.time).toBe(Date.UTC(2026, 9, 23, 8, 0));
    expect(funding?.rate).toBeCloseTo(0.0001);
    // No summary, or no interval: no funding.
    expect(calendarEntries([], [position("XUSDT")], [], now)).toEqual([]);
    expect(
      calendarEntries(
        [],
        [position("SOLUSDT")],
        [summary("SOLUSDT", { fundingIntervalSecs: 0 })],
        now,
      ),
    ).toEqual([]);
  });
});

describe("filterEntries", () => {
  const now = at(2026, 10, 23, 8);
  const entries = calendarEntries(
    [
      item("sol", { markets: ["SOLUSDT"] }),
      item("eth", { markets: ["ETHUSDT"] }),
      item("delist", { kind: "delisting", markets: ["ABCUSDT"] }),
    ],
    [position("BTCUSDT")],
    [summary("BTCUSDT")],
    now,
  );
  const ids = (es: { id: string }[]) => es.map((e) => e.id).sort();

  it("keeps a kind, or everything", () => {
    expect(ids(filterEntries(entries, "delisting", false, new Set()))).toEqual(["delist"]);
    expect(filterEntries(entries, "all", false, new Set())).toHaveLength(4);
    expect(filterEntries(entries, "unlock", false, new Set())).toEqual([]);
  });

  it("with My markets, keeps your coins and your fundings", () => {
    const mine = filterEntries(entries, "all", true, new Set(["SOLUSDT"]));
    expect(mine.map((e) => e.kind).sort()).toEqual(["funding", "news"]);
    expect(mine.find((e) => e.kind === "news")?.id).toBe("sol");
  });
});

describe("a day's entries and dots", () => {
  it("counts headlines and scheduled entries on their own day", () => {
    const entries = calendarEntries(
      [
        item("a", { time: at(2026, 10, 23, 1) }),
        item("b", { time: at(2026, 10, 23, 23, 59) }),
        item("c", { kind: "listing", time: at(2026, 10, 20), startsAt: at(2026, 10, 23, 12) }),
        item("d", { time: at(2026, 10, 24, 0, 0) }),
      ],
      [],
      [],
      at(2026, 10, 23, 8),
    );
    const day = at(2026, 10, 23);
    expect(entriesOn(entries, day).map((e) => e.id)).toEqual(["a", "c", "b"]);
    expect(dayCounts(entries, day)).toEqual({ news: 2, scheduled: 1 });
    expect(dayCounts(entries, at(2026, 10, 24))).toEqual({ news: 1, scheduled: 0 });
  });

  it("reads a coin's change over the day", () => {
    expect(dayChange(summary("A"))).toBeCloseTo(10);
    expect(dayChange(summary("A", { prevDayPrice: "0" }))).toBeUndefined();
    expect(dayChange(undefined)).toBeUndefined();
  });
});
