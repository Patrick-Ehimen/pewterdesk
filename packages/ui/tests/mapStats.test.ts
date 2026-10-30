import type { Candle, MarketSummary } from "@pewterdesk/core";
import { describe, expect, it } from "vitest";
import {
  alignment,
  atrShare,
  bandRead,
  bandZone,
  betaTo,
  bookColumn,
  bookStep,
  breadthNow,
  breadthSeries,
  candleProfile,
  changeSince,
  confluenceRead,
  correlationMatrix,
  cvdSeries,
  emaCross,
  emaOf,
  type FlowTrade,
  fundingBuckets,
  fundingGap,
  fundingIn,
  fundingPerHour,
  hourProfile,
  joinByCoin,
  largeTrades,
  median,
  moneyFlow,
  nakedPocs,
  obvRead,
  oiChangeOver,
  oiChangeSoFar,
  oiQuadrant,
  priceSpreads,
  quoteVolume,
  rangePlace,
  realisedVol,
  relativeStrength,
  rotationQuadrant,
  seasonality,
  sessionStats,
  sessionsAt,
  squeezeRead,
  valueRead,
  volRegime,
  volumeShares,
  volumeSpike,
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

/** `n` hourly candles closing at `close(i)`, each opening at the last close. */
function hourly(n: number, close: (i: number) => number, volume = (_i: number) => 10): Candle[] {
  return Array.from({ length: n }, (_, i) =>
    candle(i, i === 0 ? close(0) : close(i - 1), close(i), { volume: String(volume(i)) }),
  );
}

describe("relative strength and rotation", () => {
  it("is the market's return less the benchmark's", () => {
    expect(relativeStrength(0.05, 0.02)).toBeCloseTo(0.03);
    expect(relativeStrength(undefined, 0.02)).toBeUndefined();
  });

  it("puts a market in the quadrant its trend and momentum say", () => {
    expect(rotationQuadrant(0.1, 0.02)).toBe("leading");
    expect(rotationQuadrant(0.1, -0.02)).toBe("weakening");
    expect(rotationQuadrant(-0.1, -0.02)).toBe("lagging");
    expect(rotationQuadrant(-0.1, 0.02)).toBe("improving");
  });
});

describe("breakouts", () => {
  it("places the price in its range", () => {
    // Closes 100 to 119: highs reach 120, lows 99.
    const candles = hourly(20, (i) => 100 + i);
    const place = rangePlace(candles, 20, 119);
    expect(place?.high).toBe(120);
    expect(place?.low).toBe(99);
    expect(place?.position).toBeCloseTo(20 / 21);
    expect(place?.toHigh).toBeCloseTo(119 / 120 - 1);
  });

  it("needs enough history", () => {
    expect(
      rangePlace(
        hourly(5, () => 100),
        24,
        100,
      ),
    ).toBeUndefined();
  });
});

describe("volume spikes", () => {
  it("weighs the last whole hours against the usual hour, leaving out the forming one", () => {
    // 40 hours of 10, then 3 hours of 40, then a forming hour of 1.
    const candles = hourly(
      44,
      () => 100,
      (i) => (i >= 40 && i < 43 ? 40 : i === 43 ? 1 : 10),
    );
    const one = volumeSpike(candles, 1);
    expect(one?.ratio).toBeCloseTo(4);
    const four = volumeSpike(candles, 4);
    // (10 + 40 * 3) against 4 usual hours of 10.
    expect(four?.ratio).toBeCloseTo(130 / 40);
  });
});

describe("beta", () => {
  it("is the slope of the market's returns on the benchmark's", () => {
    const bench = hourly(50, (i) => 100 * (1 + 0.01 * Math.sin(i)));
    // Moving twice as far as the benchmark, hour by hour.
    const closes = [100];
    for (let i = 1; i < 50; i++) {
      const b0 = Number(bench[i - 1]?.close);
      const b1 = Number(bench[i]?.close);
      closes.push((closes[i - 1] ?? 100) * Math.exp(2 * Math.log(b1 / b0)));
    }
    const market = hourly(50, (i) => closes[i] ?? 100);
    const b = betaTo(market, bench, 48);
    expect(b?.beta).toBeCloseTo(2, 5);
    expect(b?.correlation).toBeCloseTo(1, 5);
  });
});

describe("breadth", () => {
  it("averages toward the values", () => {
    expect(emaOf([10, 10, 10], 3)).toEqual([10, 10, 10]);
    const rising = emaOf([0, 10], 3);
    expect(rising[1]).toBeCloseTo(5);
  });

  it("counts the markets up, above their averages and at new extremes", () => {
    const rising = hourly(100, (i) => 100 + i);
    const falling = hourly(100, (i) => 200 - i);
    const now = breadthNow([rising, falling, hourly(10, () => 1)]);
    expect(now.total).toBe(2);
    expect(now.up24h).toBe(0.5);
    expect(now.aboveEma20).toBe(0.5);
    expect(now.newHighs).toBe(1);
    expect(now.newLows).toBe(1);
  });

  it("follows breadth hour by hour", () => {
    const points = breadthSeries([hourly(60, (i) => 100 + i), hourly(60, (i) => 200 - i)]);
    expect(points.length).toBe(36);
    expect(points.every((p) => p.aboveEma === 0.5 && p.up24h === 0.5)).toBe(true);
  });
});

describe("funding history", () => {
  it("sums payments into 8-hour buckets", () => {
    const start = MONDAY;
    const hourly = Array.from({ length: 8 }, (_, i) => ({ time: start + i * H, rate: 0.0001 }));
    const buckets = fundingBuckets(
      [...hourly, { time: start + 9 * H, rate: -0.0002 }],
      start,
      8 * H,
      3,
    );
    expect(buckets[0]).toBeCloseTo(0.0008);
    expect(buckets[1]).toBeCloseTo(-0.0002);
    expect(buckets[2]).toBeUndefined();
  });
});

describe("order flow", () => {
  const trade = (id: number, time: number, side: "buy" | "sell", size: number, price = 100) =>
    ({ id: String(id), time, side, size, price }) as FlowTrade;

  it("runs the delta across buckets", () => {
    const points = cvdSeries(
      [trade(2, 5_000, "sell", 1), trade(1, 1_000, "buy", 3), trade(3, 12_000, "buy", 2, 101)],
      10_000,
    );
    expect(points.map((p) => p.cvd)).toEqual([2, 4]);
    expect(points[0]).toMatchObject({ buy: 3, sell: 1 });
    expect(points[1]?.price).toBe(101);
  });

  it("keeps the biggest trades by value", () => {
    const trades = Array.from({ length: 100 }, (_, i) => trade(i, i, "buy", i + 1));
    const big = largeTrades(trades, 0.05);
    expect(big.trades.length).toBe(5);
    expect(big.threshold).toBe(96 * 100);
  });
});

describe("volume profiles across markets", () => {
  // Most of the volume around 100, a little trading up at 120.
  const candles = Array.from({ length: 30 }, (_, i) =>
    i < 28
      ? candle(i, 100, 100, { high: "101", low: "99", volume: "100" })
      : candle(i, 120, 120, { high: "121", low: "119", volume: "1" }),
  );

  it("finds the point of control and the value area", () => {
    const read = valueRead(candles, 120);
    expect(read?.poc).toBeGreaterThan(98);
    expect(read?.poc).toBeLessThan(102);
    expect(read?.place).toBe("above");
    expect(read?.toPoc).toBeGreaterThan(0.15);
    expect(valueRead(candles, 100)?.place).toBe("inside");
    expect(valueRead(candles, 90)?.place).toBe("below");
    expect(candleProfile(candles)?.rows.length).toBe(60);
  });

  it("keeps a day's point of control only until it's traded through", () => {
    const day = (d: number, price: number) =>
      Array.from({ length: 24 }, (_, h) =>
        candle(d * 24 + h, price, price, { high: String(price + 1), low: String(price - 1) }),
      );
    // Day 0 at 100, day 1 at 200, day 2 back at 200 (forming): 100 stays
    // naked, day 1's level was traded through by day 2.
    const naked = nakedPocs([...day(0, 100), ...day(1, 200), ...day(2, 200)]);
    expect(naked.length).toBe(1);
    // A flat day has no one busiest price: it's somewhere in the day's range.
    expect(naked[0]?.price).toBeGreaterThanOrEqual(99);
    expect(naked[0]?.price).toBeLessThanOrEqual(101);
  });
});

describe("money flow and OBV", () => {
  it("weighs up hours against down hours", () => {
    const flow = moneyFlow(
      [candle(0, 100, 110, { volume: "3" }), candle(1, 110, 100, { volume: "1" })],
      2,
    );
    expect(flow?.net).toBeCloseTo(330 - 100);
    expect(flow?.ratio).toBeCloseTo(230 / 430);
  });

  it("calls a divergence when price and OBV sit at opposite ends", () => {
    // Price falls on small volume, then ticks up on big volume: OBV ends
    // high while the price stays near its low.
    const closes = [120, 118, 116, 114, 112, 110, 108, 106, 104, 102, 100, 100.5, 101, 101.5];
    const candles = closes.map((c, i) =>
      candle(i, closes[i - 1] ?? c, c, { volume: i > 10 ? "100" : "1" }),
    );
    const read = obvRead(candles, closes.length - 1);
    expect(read?.kind).toBe("bullish");
    expect(read?.gap).toBeGreaterThan(0.4);
  });
});

describe("volume rotation", () => {
  it("compares the day's share of volume with the week's", () => {
    const week = (lastDay: number) =>
      Array.from({ length: 168 }, (_, i) =>
        candle(i, 10, 10, { volume: String(i >= 144 ? lastDay : 10) }),
      );
    const shares = volumeShares(
      new Map([
        ["A", week(10)],
        ["B", week(30)],
      ]),
    );
    expect(quoteVolume(week(10), 24)).toBe(2400);
    expect(shares.get("B")?.change).toBeGreaterThan(0);
    expect(shares.get("A")?.change).toBeLessThan(0);
  });
});

describe("momentum", () => {
  it("scores how well the timeframes agree", () => {
    expect(alignment([0.01, 0.02, 0.03, 0.04])).toBe(4);
    expect(alignment([0.01, -0.02, undefined, -0.04])).toBe(-1);
    expect(alignment([undefined])).toBeUndefined();
  });

  it("finds a fresh EMA cross, and only within the window", () => {
    // A long fall, then a steep rise: the fast average crosses up lately.
    const candles = Array.from({ length: 120 }, (_, i) =>
      i < 100 ? candle(i, 200 - i, 200 - i) : candle(i, 100 + (i - 100) * 4, 100 + (i - 100) * 4),
    );
    const cross = emaCross(candles, 20);
    expect(cross?.direction).toBe("up");
    expect(cross?.gap).toBeGreaterThan(0);
    expect(emaCross(candles, 1)).toBeUndefined();
  });

  it("ranks a tightening market low against its own history", () => {
    const wide = Array.from({ length: 80 }, (_, i) => {
      const c = 100 + (i % 2 ? 5 : -5);
      return candle(i, c, c);
    });
    const tight = Array.from({ length: 24 }, (_, i) => candle(80 + i, 100, 100 + (i % 2) * 0.01));
    const read = squeezeRead([...wide, ...tight]);
    expect(read?.rank).toBeLessThan(0.1);
  });
});

describe("Bollinger bands", () => {
  it("names the zone a %B falls in", () => {
    expect(bandZone(1.2)).toBe("aboveUpper");
    expect(bandZone(0.97)).toBe("atUpper");
    expect(bandZone(0.85)).toBe("nearUpper");
    expect(bandZone(0.5)).toBe("middle");
    expect(bandZone(0.15)).toBe("nearLower");
    expect(bandZone(0.02)).toBe("atLower");
    expect(bandZone(-0.1)).toBe("belowLower");
  });

  const swings = (n: number) =>
    Array.from({ length: n }, (_, i) => {
      const c = 100 + (i % 2 ? 2 : -2);
      return candle(i, c, c);
    });

  it("reads the bands from the closes, the forming bar at the price", () => {
    const mid = bandRead(swings(40), 100, 1);
    expect(mid?.zone).toBe("middle");
    expect(mid?.middle).toBeCloseTo(100, 0);
    expect(bandRead(swings(40), 140, 1)?.zone).toBe("aboveUpper");
    expect(bandRead(swings(40), 60, 1)?.zone).toBe("belowLower");
  });

  it("gathers hours into longer bars, and needs a full period of them", () => {
    // 40 hours make 10 or 11 four-hour bars: not the 20 the bands need.
    expect(bandRead(swings(40), 100, 4)).toBeUndefined();
    expect(bandRead(swings(100), 100, 4)).toBeDefined();
  });
});

describe("RSI at the bands", () => {
  const closes = (rise: number) =>
    Array.from({ length: 60 }, (_, i) => {
      const c = 100 + i * rise + (i % 2 ? 0.5 : -0.5);
      return candle(i, c, c);
    });

  it("marks a market overbought at its upper band", () => {
    const up = closes(1);
    const read = confluenceRead(up, 162, 1);
    expect(read?.rsi).toBeGreaterThanOrEqual(70);
    expect(read?.side).toBe("upper");
  });

  it("marks a market oversold at its lower band", () => {
    const read = confluenceRead(closes(-1), 38, 1);
    expect(read?.rsi).toBeLessThanOrEqual(30);
    expect(read?.side).toBe("lower");
  });

  it("wants both: a band alone, or an RSI alone, is neither", () => {
    // Overbought, but pulled back to the middle of the bands.
    const pulledBack = confluenceRead(closes(1), 150.5, 1);
    expect(pulledBack?.band.zone).toBe("middle");
    expect(pulledBack?.side).toBeUndefined();
  });

  it("needs a full read", () => {
    expect(confluenceRead(closes(1).slice(0, 10), 110, 1)).toBeUndefined();
  });
});
