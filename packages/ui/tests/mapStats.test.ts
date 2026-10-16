import type { Candle, MarketSummary } from "@pewterdesk/core";
import { describe, expect, it } from "vitest";
import {
  atrShare,
  bookColumn,
  bookStep,
  changeSince,
  correlationMatrix,
  fundingGap,
  fundingIn,
  fundingPerHour,
  hourProfile,
  joinByCoin,
  median,
  oiChangeOver,
  oiChangeSoFar,
  oiQuadrant,
  priceSpreads,
  realisedVol,
  seasonality,
  sessionStats,
  sessionsAt,
  volRegime,
  withOiSample,
} from "../src/lib/mapStats";

const H = 3_600_000;
// A Monday, 00:00 UTC.
const MONDAY = Date.UTC(2026, 0, 5);

function candle(i: number, open: number, close: number, extra: Partial<Candle> = {}): Candle {
  return {
    openTime: MONDAY + i * H,
    open: String(open),
    high: String(Math.max(open, close) + 1),
    low: String(Math.min(open, close) - 1),
    close: String(close),
    volume: "10",
    ...extra,
  } as Candle;
}

/** Hourly candles from a list of closes, each opening at the last close. */
const series = (closes: number[]) =>
  closes.map((c, i) => candle(i, i === 0 ? c : (closes[i - 1] ?? c), c));

describe("changeSince", () => {
  it("measures from the open `hours` back to the price now", () => {
    const c = series([100, 101, 102, 110]);
    expect(changeSince(c, 1)).toBeCloseTo(110 / 102 - 1);
    expect(changeSince(c, 3)).toBeCloseTo(110 / 100 - 1);
    expect(changeSince(c, 3, 121)).toBeCloseTo(0.21);
  });
  it("is undefined when the history is too short", () => {
    expect(changeSince(series([100, 101]), 24)).toBeUndefined();
    expect(changeSince([], 1)).toBeUndefined();
  });
});

describe("volatility", () => {
  it("is zero for a flat market and grows with the swings", () => {
    const flat = series(Array.from({ length: 30 }, () => 100));
    const calm = series(Array.from({ length: 30 }, (_, i) => (i % 2 ? 101 : 100)));
    const wild = series(Array.from({ length: 30 }, (_, i) => (i % 2 ? 110 : 100)));
    expect(realisedVol(flat, 24)).toBe(0);
    expect(realisedVol(wild, 24) ?? 0).toBeGreaterThan(realisedVol(calm, 24) ?? 0);
    expect(atrShare(wild) ?? 0).toBeGreaterThan(atrShare(calm) ?? 0);
  });
  it("needs enough candles", () => {
    expect(realisedVol(series([1, 2, 3]), 24)).toBeUndefined();
    expect(atrShare(series([1, 2, 3]))).toBeUndefined();
  });
  it("reads the regime from the day against the week", () => {
    expect(volRegime(0.9, 0.6)).toBe("expanding");
    expect(volRegime(0.4, 0.6)).toBe("contracting");
    expect(volRegime(0.6, 0.6)).toBe("steady");
    expect(volRegime(undefined, 0.6)).toBeUndefined();
  });
});

describe("correlationMatrix", () => {
  it("is 1 for markets moving together and -1 for opposite ones", () => {
    const closes = Array.from({ length: 30 }, (_, i) => 100 * (1 + 0.01 * Math.sin(i)));
    const a = series(closes);
    const b = series(closes.map((c) => c * 2));
    const inverse = series(closes.map((c) => 10_000 / c));
    const m = correlationMatrix([a, b, inverse], 24);
    expect(m[0]?.[0]).toBe(1);
    expect(m[0]?.[1]).toBeCloseTo(1, 6);
    expect(m[0]?.[2]).toBeCloseTo(-1, 2);
    expect(m[2]?.[0]).toBeCloseTo(m[0]?.[2] ?? 0, 10);
  });
  it("leaves pairs with too few hours in common out", () => {
    const a = series(Array.from({ length: 30 }, (_, i) => 100 + i));
    const late = a.slice(-3);
    expect(correlationMatrix([a, late], 24)[0]?.[1]).toBeUndefined();
  });
});

const summary = (market: string, price: number, rate: number, hours = 8, vol = 1): MarketSummary =>
  ({
    market,
    markPrice: String(price),
    prevDayPrice: String(price),
    dayVolume: String(vol),
    openInterest: "10",
    fundingRate: String(rate),
    fundingIntervalSecs: hours * 3600,
  }) as MarketSummary;

describe("funding and prices across venues", () => {
  it("puts every venue's rate per hour", () => {
    expect(fundingPerHour(summary("X", 1, 0.0008))).toBeCloseTo(0.0001);
    expect(fundingPerHour(summary("X", 1, 0.0001, 1))).toBeCloseTo(0.0001);
    expect(fundingIn(0.0001, "8h")).toBeCloseTo(0.0008);
    expect(fundingIn(0.0001, "apr")).toBeCloseTo(0.876);
  });
  it("joins venues by coin, keeping a venue's busier listing", () => {
    const rows = joinByCoin(
      {
        hyperliquid: [summary("BTC", 100, 0.0001, 1, 50), summary("ETH", 10, 0, 1, 5)],
        bybit: [summary("BTCUSDT", 101, 0.0008, 8, 30), summary("BTCPERP", 100, 0, 8, 1)],
      },
      (_, m) => m.replace(/USDT$|PERP$/, ""),
    );
    expect(rows.map((r) => r.base)).toEqual(["BTC", "ETH"]);
    expect(rows[0]?.venues.bybit?.market).toBe("BTCUSDT");
    expect(rows[0]?.volume).toBe(80);
    expect(fundingGap(rows[0] as never)).toBeCloseTo(0);
    expect(fundingGap(rows[1] as never)).toBeUndefined();
  });
  it("measures each venue against the median price", () => {
    const rows = joinByCoin(
      {
        hyperliquid: [summary("BTC", 100, 0)],
        aster: [summary("BTCUSDT", 101, 0)],
        bybit: [summary("BTCUSDT", 102, 0)],
      },
      (_, m) => m.replace(/USDT$/, ""),
    );
    const s = priceSpreads(rows[0] as never);
    expect(s.median).toBe(101);
    expect(s.bps.hyperliquid).toBeCloseTo(-99.0099, 3);
    expect(s.width).toBeCloseTo((102 / 101 - 100 / 101) * 10_000, 6);
  });
  it("takes the middle of an even count", () => {
    expect(median([4, 1, 3, 2])).toBe(2.5);
    expect(median([])).toBeUndefined();
  });
});

describe("open interest", () => {
  it("keeps a sample every 5 minutes lately and one an hour before", () => {
    const M = 60_000;
    let s = withOiSample([], MONDAY, 100, 50);
    s = withOiSample(s, MONDAY + 2 * M, 101, 51);
    // Same 5-minute bucket: the later one replaces it.
    expect(s).toEqual([{ time: MONDAY + 2 * M, oi: 101, price: 51 }]);
    s = withOiSample(s, MONDAY + 7 * M, 102);
    expect(s).toHaveLength(2);
    // Every 5 minutes for 30 hours: thinned to hourly past the last 2 hours.
    for (let m = 10; m <= 30 * 60; m += 5) s = withOiSample(s, MONDAY + m * M, 100 + m);
    const now = MONDAY + 30 * 60 * M;
    const recent = s.filter((x) => x.time > now - 2 * H);
    expect(recent.length).toBe(24);
    expect(s.length).toBeLessThanOrEqual(24 + 26);
    expect(s[0]?.time).toBeGreaterThan(now - 26 * H);
    expect(withOiSample(s, now, 0)).toEqual(s);
  });
  it("reports the change so far before a window is covered", () => {
    const s = [
      { time: MONDAY, oi: 100, price: 10 },
      { time: MONDAY + 20 * 60_000, oi: 110, price: 9 },
    ];
    const soFar = oiChangeSoFar(s);
    expect(soFar?.oi).toBeCloseTo(0.1);
    expect(soFar?.price).toBeCloseTo(-0.1);
    expect(soFar?.minutes).toBe(20);
    expect(oiChangeSoFar(s.slice(0, 1))).toBeUndefined();
    expect(oiChangeSoFar([s[0] as never, { time: MONDAY + 60_000, oi: 1 }])).toBeUndefined();
  });
  it("measures the change once the samples reach back far enough", () => {
    const s = [
      { time: MONDAY, oi: 100 },
      { time: MONDAY + 3 * H, oi: 110 },
      { time: MONDAY + 4 * H, oi: 120 },
    ];
    expect(oiChangeOver(s, 1)).toBeCloseTo(120 / 110 - 1);
    expect(oiChangeOver(s, 4)).toBeCloseTo(0.2);
    expect(oiChangeOver(s, 24)).toBeUndefined();
  });
  it("names the quadrants", () => {
    expect(oiQuadrant(0.01, 0.02)).toBe("newLongs");
    expect(oiQuadrant(0.01, -0.02)).toBe("shortCovering");
    expect(oiQuadrant(-0.01, 0.02)).toBe("newShorts");
    expect(oiQuadrant(-0.01, -0.02)).toBe("longsClosing");
  });
});

describe("seasonality and sessions", () => {
  it("averages returns by weekday and hour", () => {
    // Two Mondays at 00:00 UTC: +1% and +3%.
    const c = [candle(0, 100, 101), candle(24 * 7, 100, 103), candle(1, 100, 99)];
    const grid = seasonality(c);
    expect(grid[0]?.[0]?.avg).toBeCloseTo(0.02);
    expect(grid[0]?.[0]?.count).toBe(2);
    expect(grid[0]?.[0]?.upShare).toBe(1);
    expect(grid[0]?.[1]?.avg).toBeCloseTo(-0.01);
    expect(grid[1]?.[0]).toBeUndefined();
  });
  it("profiles each hour and sums it into sessions", () => {
    const c = Array.from({ length: 48 }, (_, i) =>
      candle(i, 100, 100, { volume: i % 24 === 14 ? "30" : "1" }),
    );
    const profile = hourProfile(c);
    expect(profile).toHaveLength(24);
    expect(profile[14]?.volumeShare).toBeCloseTo(30 / 53);
    expect(profile.reduce((a, h) => a + h.volumeShare, 0)).toBeCloseTo(1);
    const us = sessionStats(profile).find((s) => s.id === "us");
    expect(us?.volumeShare).toBeGreaterThan(0.5);
    expect(sessionsAt(MONDAY + 14 * H)).toEqual(["europe", "us"]);
    expect(sessionsAt(MONDAY + 22 * H)).toEqual([]);
  });
});

describe("order book heat", () => {
  it("bins resting size into price rows", () => {
    const book = {
      bids: [
        { price: "99.5", size: "2" },
        { price: "98.2", size: "1" },
      ],
      asks: [{ price: "100.5", size: "3" }],
    };
    const col = bookColumn(book as never, 101, 1, 4, 5);
    expect(col?.mid).toBe(100);
    // Rows: [101,102) [100,101) [99,100) [98,99)
    expect(Array.from(col?.rows ?? [])).toEqual([0, 301.5, 199, 98.2].map((v) => Math.fround(v)));
    expect(bookColumn({ bids: [], asks: [] } as never, 1, 1, 4, 0)).toBeUndefined();
  });
  it("picks a round step", () => {
    expect(bookStep(100_000, 0.01, 80)).toBe(25);
    expect(bookStep(1.234, 0.02, 80)).toBeCloseTo(0.001);
    expect(bookStep(0, 0.01, 80)).toBe(0);
  });
});
