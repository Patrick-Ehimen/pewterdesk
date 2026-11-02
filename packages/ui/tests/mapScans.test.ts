import type { Candle } from "@pewterdesk/core";
import { describe, expect, it } from "vitest";
import {
  adx,
  carryOf,
  crowding,
  divergence,
  edgeMap,
  efficiency,
  enteredState,
  exposureGroups,
  inRegimeFilter,
  inRuleState,
  leadLag,
  levelsRead,
  pairSpreads,
  passesScan,
  readingsOf,
  regimeRead,
  rsiSeries,
  sectorRows,
  stretchRead,
  volRank,
} from "../src/lib/mapScans";
import { HOUR, joinByCoin } from "../src/lib/mapStats";
import { rsi } from "../src/lib/screener";

const candle = (openTime: number, close: number, wick = 0.2, open = close, volume = 100): Candle =>
  ({
    openTime,
    closeTime: openTime + HOUR,
    open: String(open),
    high: String(Math.max(open, close) + wick),
    low: String(Math.min(open, close) - wick),
    close: String(close),
    volume: String(volume),
  }) as unknown as Candle;
const series = (closes: readonly number[], start = 0) => {
  return closes.map((c, i) => candle(start + i * HOUR, c, 0.2, closes[i - 1] ?? c));
};
/** A steady wobble, repeatable: no two markets share it unless told to. */
const wobble = (n: number, seed: number, size = 1) =>
  Array.from(
    { length: n },
    (_, i) => 100 + size * Math.sin(i * seed) + size * Math.cos(i * seed * 1.7),
  );

describe("regimeRead", () => {
  const up = Array.from({ length: 80 }, (_, i) => 100 + i);
  const down = [...up].reverse();

  it("reads a steady climb as a trend up, and a fall as one down", () => {
    expect(regimeRead(series(up))?.kind).toBe("trendUp");
    expect(regimeRead(series(down))?.kind).toBe("trendDown");
  });

  it("gives a strong straight line a high ADX and full efficiency", () => {
    const read = regimeRead(series(up));
    expect(read?.adx).toBeGreaterThan(50);
    expect(read?.efficiency).toBeCloseTo(1);
  });

  it("doesn't call a market going nowhere a trend", () => {
    const flat = Array.from({ length: 80 }, (_, i) => 100 + (i % 2 ? 0.5 : -0.5));
    expect(["ranging", "choppy"]).toContain(regimeRead(series(flat))?.kind);
  });

  it("needs enough candles", () => {
    expect(regimeRead(series([1, 2, 3]))).toBeUndefined();
    expect(adx(series(up.slice(0, 20)))).toBeUndefined();
  });

  it("filters by what a trader asks for", () => {
    expect(inRegimeFilter("trendDown", "trending")).toBe(true);
    expect(inRegimeFilter("choppy", "trending")).toBe(false);
    expect(inRegimeFilter("choppy", "all")).toBe(true);
  });
});

describe("efficiency", () => {
  it("is 1 for a straight line and small for back and forth", () => {
    expect(efficiency([1, 2, 3, 4])).toBe(1);
    expect(efficiency([1, 3, 1, 3, 1])).toBe(0);
  });
});

describe("levelsRead", () => {
  // Wednesday 2026-06-24, 12:00 UTC.
  const now = Date.UTC(2026, 5, 24, 12);
  const start = now - 168 * HOUR;
  const candles = Array.from({ length: 168 }, (_, i) => {
    const t = start + i * HOUR;
    return candle(t, 100 + (t >= Date.UTC(2026, 5, 23, 12) ? 10 : 0));
  });

  it("finds today's open and this week's, on UTC days from Monday", () => {
    const read = levelsRead(candles, 110, now);
    const of = (kind: string) => read?.levels.find((l) => l.kind === kind)?.price;
    expect(of("dayOpen")).toBe(110);
    expect(of("weekOpen")).toBe(100);
  });

  it("takes yesterday's range from yesterday's candles only", () => {
    const read = levelsRead(candles, 105, now);
    const of = (kind: string) => read?.levels.find((l) => l.kind === kind)?.price;
    expect(of("prevHigh")).toBeCloseTo(110.2);
    expect(of("prevLow")).toBeCloseTo(99.8);
  });

  it("names the nearest level, with its distance signed", () => {
    const read = levelsRead(candles, 109, now);
    expect(read?.nearest.distance).toBeGreaterThan(0);
    expect(read?.nearest.price).toBe(110);
  });

  it("needs a price and candles", () => {
    expect(levelsRead([], 100, now)).toBeUndefined();
    expect(levelsRead(candles, 0, now)).toBeUndefined();
  });
});

describe("rsiSeries", () => {
  it("ends on the screener's own figure", () => {
    const closes = wobble(60, 0.4, 3);
    expect(rsiSeries(closes).at(-1)).toBeCloseTo(rsi(closes) as number, 6);
  });

  it("has nothing before the period is filled", () => {
    expect(rsiSeries([1, 2, 3])).toEqual([undefined, undefined, undefined]);
  });
});

describe("divergence", () => {
  // Falls hard to a low, bounces, then a slow drift to a slightly lower low.
  const fall = Array.from({ length: 20 }, (_, i) => 120 - i * 2);
  const bounce = [84, 88, 92, 96, 100];
  const drift = Array.from({ length: 22 }, (_, i) => 100 - i * 0.8);
  const lift = [84, 85.5, 87, 88.5];

  it("sees a lower low in price with a higher low in RSI", () => {
    const read = divergence(series([...fall, 80, ...bounce, ...drift, 79, ...lift]), 1);
    expect(read?.kind).toBe("bullish");
    expect(read?.priceChange).toBeLessThan(0);
    expect(read?.rsiTo).toBeGreaterThan(read?.rsiFrom ?? 100);
  });

  it("sees the mirror of it at the highs", () => {
    const mirror = (list: readonly number[]) => list.map((v) => 200 - v);
    const read = divergence(series(mirror([...fall, 80, ...bounce, ...drift, 79, ...lift])), 1);
    expect(read?.kind).toBe("bearish");
  });

  it("says nothing of a plain trend", () => {
    expect(divergence(series(Array.from({ length: 80 }, (_, i) => 100 + i)), 1)).toBeUndefined();
  });
});

describe("stretchRead", () => {
  const flat = wobble(150, 0.9, 1);

  it("puts a price far above where it traded well above the VWAP", () => {
    const read = stretchRead(series(flat), 110);
    expect(read?.z).toBeGreaterThan(3);
    expect(read?.fromVwap).toBeGreaterThan(0.05);
  });

  it("reads a fall the other way", () => {
    expect(stretchRead(series(flat), 90)?.z).toBeLessThan(-3);
  });

  it("needs 100 candles for its EMA", () => {
    expect(stretchRead(series(flat.slice(0, 50)), 100)).toBeUndefined();
  });
});

describe("volRank", () => {
  it("ranks a market gone quiet low and one gone wild high", () => {
    const wild = [...wobble(100, 0.7, 4), ...wobble(40, 0.7, 0.1)];
    const calm = [...wobble(100, 0.7, 0.1), ...wobble(40, 0.7, 4)];
    expect(volRank(series(wild))?.rank).toBeLessThan(0.2);
    expect(volRank(series(calm))?.rank).toBeGreaterThan(0.8);
  });

  it("needs a history to rank against", () => {
    expect(volRank(series([1, 2, 3]))).toBeUndefined();
  });
});

describe("crowding", () => {
  const perHour = 0.5 / (24 * 365);

  it("scores full when funding, open interest and a flat price all agree", () => {
    expect(crowding(perHour, 0.1, 0).score).toBe(100);
  });

  it("says who is crowded by who pays", () => {
    expect(crowding(perHour, 0, 0).side).toBe("longs");
    expect(crowding(-perHour, 0, 0).side).toBe("shorts");
  });

  it("gives falling open interest nothing, and unknown only ever lowers it", () => {
    expect(crowding(perHour, -0.2, 0).score).toBe(65);
    expect(crowding(perHour, undefined, 0).score).toBe(65);
  });

  it("takes credit away when the price has already moved", () => {
    expect(crowding(perHour, 0.1, 0.2).score).toBe(80);
  });
});

describe("carryOf", () => {
  const taker = {
    bybit: 0.0005,
    hyperliquid: 0.0005,
    aster: 0.0005,
    binance: 0.0005,
    blofin: 0.0005,
  };
  const quote = (funding: number, price = 100, dayVolume = 5e6) => ({
    market: "X",
    price,
    funding,
    openInterest: 0,
    dayVolume,
  });

  it("goes long where funding is lowest and short where it's highest", () => {
    const row = {
      base: "BTC",
      volume: 1,
      venues: { bybit: quote(0.0001), binance: quote(0.0003), aster: quote(-0.0001, 99) },
    };
    const carry = carryOf(row, taker);
    expect(carry).toMatchObject({ longVenue: "aster", shortVenue: "binance" });
    expect(carry?.apr).toBeCloseTo(0.0004 * 24 * 365);
    expect(carry?.cost).toBeCloseTo(0.002);
    expect(carry?.breakEvenDays).toBeCloseTo(0.002 / (0.0004 * 24));
    expect(carry?.priceGap).toBeCloseTo(100 / 99 - 1);
  });

  it("leaves out a venue too thin to use, and a coin with one venue left", () => {
    const row = {
      base: "BTC",
      volume: 1,
      venues: { bybit: quote(0.0001), binance: quote(0.0003, 100, 10) },
    };
    expect(carryOf(row, taker)).toBeUndefined();
  });
});

describe("pairSpreads", () => {
  const base = wobble(168, 0.5, 2);

  it("finds a pair that moves together and flags the stretch between them", () => {
    const b = base.map((v) => v * 2);
    const a = base.map((v, i) => (i >= 160 ? v * 1.1 : v));
    const rows = pairSpreads([
      { market: "A", candles: series(a) },
      { market: "B", candles: series(b) },
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.z).toBeGreaterThan(2);
    expect(rows[0]?.correlation).toBeGreaterThan(0.7);
  });

  it("leaves out markets that don't move together", () => {
    const rows = pairSpreads([
      { market: "A", candles: series(base) },
      { market: "B", candles: series(wobble(168, 1.91, 2)) },
    ]);
    expect(rows).toEqual([]);
  });

  it("lines candles up by time, not by place", () => {
    const later = base.slice(10).map((v, i) => (i === 150 ? v * 1.02 : v));
    const rows = pairSpreads([
      { market: "A", candles: series(base) },
      { market: "B", candles: series(later, 10 * HOUR) },
    ]);
    expect(rows[0]?.correlation).toBeGreaterThan(0.9);
  });
});

describe("leadLag", () => {
  const noise = Array.from(
    { length: 168 },
    (_, i) => 100 + 3 * Math.sin(i * 1.3) + 2 * Math.sin(i * 2.9),
  );

  it("sees a market that follows the benchmark by an hour or two", () => {
    const follows = [100, 100, ...noise.slice(0, -2)];
    expect(leadLag(series(follows), series(noise))?.lag).toBe(2);
  });

  it("sees one that moves first", () => {
    const first = [...noise.slice(2), 100, 100];
    expect(leadLag(series(first), series(noise))?.lag).toBe(-2);
  });

  it("says together for a market in step", () => {
    expect(leadLag(series(noise), series(noise))?.lag).toBe(0);
  });
});

describe("sectorRows", () => {
  const groups = [
    {
      sector: "l1",
      coins: [
        { symbol: "BIG", marketCap: 900, change24h: 0.1, change7d: 0.2 },
        { symbol: "SMALL", marketCap: 100, change24h: -0.1, change7d: null },
      ],
    },
    { sector: "meme", coins: [{ symbol: "DOG", marketCap: 50, change24h: 0.5 }] },
  ];

  it("weights by market cap and ranks the strongest first", () => {
    const rows = sectorRows(groups, "24h");
    expect(rows[0]?.sector).toBe("meme");
    expect(rows[1]?.changes["24h"]).toBeCloseTo(0.08);
  });

  it("skips a coin with no figure for the period, and names best and worst", () => {
    const row = sectorRows(groups, "24h").find((r) => r.sector === "l1");
    expect(row?.changes["7d"]).toBeCloseTo(0.2);
    expect(row).toMatchObject({ upShare: 0.5 });
    expect(row?.best?.symbol).toBe("BIG");
    expect(row?.worst?.symbol).toBe("SMALL");
  });

  it("puts a sector with no figures last", () => {
    expect(sectorRows(groups, "1h").every((r) => r.changes["1h"] === undefined)).toBe(true);
  });
});

describe("edgeMap", () => {
  const trades = [
    { market: "BTC", closedPnl: "10", time: 0 },
    { market: "BTC", closedPnl: "-4", time: 1 },
    { market: "ETH", closedPnl: "20", time: 2 },
  ];
  const slot = (time: number) => ({ day: time, hour: 3 });

  it("adds P&L up by slot and by market, best market first", () => {
    const map = edgeMap(trades, slot);
    expect(map.grid[0]?.[3]).toEqual({ pnl: 10, trades: 1 });
    expect(map.total).toBe(26);
    expect(map.markets.map((m) => m.market)).toEqual(["ETH", "BTC"]);
    expect(map.markets[1]).toMatchObject({ trades: 2, wins: 1, pnl: 6 });
  });

  it("starts the week on Monday", () => {
    const sunday = new Date(2026, 5, 28, 15).getTime();
    expect(edgeMap([{ market: "A", closedPnl: 1, time: sunday }]).grid[6]?.[15]?.trades).toBe(1);
  });
});

describe("exposureGroups", () => {
  const base = wobble(168, 0.5, 2);
  const inverse = base.map((v) => 200 - v);
  const apart = wobble(168, 1.91, 2);
  const at = (market: string, side: "long" | "short", closes: number[], value = 100) => ({
    market,
    side,
    value,
    candles: series(closes),
  });

  it("makes one bet of two longs that move together", () => {
    const groups = exposureGroups([at("A", "long", base), at("B", "long", base)]);
    expect(groups).toHaveLength(1);
    expect(groups[0]?.share).toBe(1);
    expect(groups[0]?.correlation).toBeCloseTo(1);
  });

  it("counts a long and a short that move opposite as one bet too", () => {
    expect(exposureGroups([at("A", "long", base), at("B", "short", inverse)])).toHaveLength(1);
  });

  it("keeps a long and a short that move together apart: they offset", () => {
    expect(exposureGroups([at("A", "long", base), at("B", "short", base)])).toHaveLength(2);
  });

  it("keeps unrelated positions apart, biggest first, with their shares", () => {
    const groups = exposureGroups([at("A", "long", base, 100), at("B", "long", apart, 300)]);
    expect(groups.map((g) => g.value)).toEqual([300, 100]);
    expect(groups[0]?.share).toBeCloseTo(0.75);
  });

  it("copes with a position that has no candles", () => {
    expect(
      exposureGroups([{ market: "A", side: "long", value: 10 }, at("B", "long", base)]),
    ).toHaveLength(2);
  });
});

describe("joinByCoin and carryOf together", () => {
  it("reads funding per hour as the summaries give it", () => {
    const summary = (market: string, rate: string) =>
      ({
        market,
        markPrice: "100",
        openInterest: "1",
        dayVolume: "5000000",
        fundingRate: rate,
        fundingIntervalSecs: 3600,
      }) as never;
    const [row] = joinByCoin(
      { bybit: [summary("A", "0.0001")], binance: [summary("B", "0.0002")] },
      () => "X",
    );
    const taker = { bybit: 0, hyperliquid: 0, aster: 0, binance: 0, blofin: 0 };
    expect(row && carryOf(row, taker)?.apr).toBeCloseTo(0.0001 * 24 * 365);
  });
});

describe("readingsOf and passesScan", () => {
  const any = {
    regime: "all",
    near: "any",
    stretch: "any",
    vol: "any",
    divergence: "any",
    funding: "any",
  } as const;
  const read = readingsOf(series(wobble(168, 0.6, 2)), 100, Date.now(), 0.0001, 0.01);

  it("gives every reading it can, and the busiest price", () => {
    expect(read.regime).toBeDefined();
    expect(read.vol).toBeDefined();
    expect(read.poc).toBeGreaterThan(90);
    expect(read.fundingApr).toBeCloseTo(0.0001 * 24 * 365);
  });

  it("passes anything with no filters set", () => {
    expect(passesScan(read, any)).toBe(true);
    expect(passesScan({}, any)).toBe(true);
  });

  it("needs every filter to pass", () => {
    expect(passesScan(read, { ...any, funding: "crowded" })).toBe(true);
    expect(passesScan(read, { ...any, funding: "calm" })).toBe(false);
    expect(passesScan(read, { ...any, funding: "crowded", divergence: "bullish" })).toBe(
      read.divergence?.kind === "bullish",
    );
  });

  it("fails a filter on a reading it hasn't got", () => {
    expect(passesScan({}, { ...any, near: "2" })).toBe(false);
    expect(passesScan({}, { ...any, regime: "trending" })).toBe(false);
    expect(passesScan({}, { ...any, vol: "quiet" })).toBe(false);
    expect(passesScan({}, { ...any, funding: "calm" })).toBe(false);
  });

  it("measures nearness either side of the level", () => {
    const at = (distance: number) => ({
      levels: { levels: [], nearest: { kind: "dayOpen" as const, price: 1, distance } },
    });
    expect(passesScan(at(-0.004), { ...any, near: "0.5" })).toBe(true);
    expect(passesScan(at(0.006), { ...any, near: "0.5" })).toBe(false);
  });
});

describe("scan alert rules", () => {
  it("reads each rule's state", () => {
    expect(inRuleState("squeeze", { crowd: { score: 80, side: "longs", apr: 1 } })).toBe(true);
    expect(inRuleState("squeeze", { crowd: { score: 79, side: "longs", apr: 1 } })).toBe(false);
    expect(inRuleState("squeeze", {})).toBe(false);
    expect(inRuleState("trend", { regime: { kind: "trendDown", adx: 30, efficiency: 0.5 } })).toBe(
      true,
    );
    expect(inRuleState("trend", { regime: { kind: "ranging", adx: 10, efficiency: 0.1 } })).toBe(
      false,
    );
    expect(inRuleState("divergence", {})).toBe(false);
  });

  it("fires on the way in only", () => {
    expect(enteredState(false, true)).toBe(true);
    expect(enteredState(true, true)).toBe(false);
    expect(enteredState(true, false)).toBe(false);
    expect(enteredState(false, false)).toBe(false);
  });

  it("stays quiet on first sight, so a state it was already in doesn't fire", () => {
    expect(enteredState(undefined, true)).toBe(false);
  });
});
