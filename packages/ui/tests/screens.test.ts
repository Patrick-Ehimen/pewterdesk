import type { Candle, Market, MarketSummary } from "@pewterdesk/core";
import { describe, expect, it } from "vitest";
import { HOUR } from "../src/lib/mapStats";
import {
  parseScreenNumber,
  passesFilter,
  ratingOf,
  runScreen,
  SCREEN_COLUMNS,
  SCREEN_PRESETS,
  type Screen,
  type ScreenInput,
  screenFrom,
  screenValue,
  techRating,
  techVotes,
} from "../src/lib/screens";

const candle = (openTime: number, close: number): Candle =>
  ({
    openTime,
    closeTime: openTime + HOUR,
    open: String(close),
    high: String(close + 0.2),
    low: String(close - 0.2),
    close: String(close),
    volume: "100",
  }) as unknown as Candle;

const market = (id: string, category?: string): Market =>
  ({ id, symbol: id, base: id, quote: "USDT", category }) as unknown as Market;

const summary = (id: string, mark: number, prev: number, volume: number): MarketSummary =>
  ({
    market: id,
    markPrice: String(mark),
    prevDayPrice: String(prev),
    dayVolume: String(volume),
    openInterest: "10",
    fundingRate: "0.0001",
    fundingIntervalSecs: 28_800,
  }) as unknown as MarketSummary;

const input = (id: string, mark: number, prev: number, volume: number): ScreenInput => ({
  market: market(id),
  summary: summary(id, mark, prev, volume),
  candles: Array.from({ length: 168 }, (_, i) =>
    candle(i * HOUR, prev + ((mark - prev) * i) / 167),
  ),
  now: 168 * HOUR,
});

const screen = (over: Partial<Screen> = {}): Screen => ({
  id: "s",
  name: "s",
  columns: ["price", "change24h"],
  filters: [],
  sort: { column: "change24h", desc: true },
  scope: "crypto",
  ...over,
});

describe("screenValue", () => {
  it("reads the summary's columns at once", () => {
    const i = { ...input("BTC", 110, 100, 5e6), candles: undefined };
    expect(screenValue("price", i)).toBe(110);
    expect(screenValue("change24h", i)).toBeCloseTo(0.1);
    expect(screenValue("volume", i)).toBe(5e6);
    expect(screenValue("oi", i)).toBe(1100);
    expect(screenValue("funding", i)).toBeCloseTo(0.0001 * 3 * 365);
    expect(screenValue("rsi1h", i)).toBeUndefined();
  });

  it("reads every column from a week of candles", () => {
    const i = input("BTC", 110, 100, 5e6);
    for (const c of ["change1h", "change7d", "rsi1h", "rsi4h", "rangePos"] as const) {
      expect(typeof screenValue(c, i), c).toBe("number");
    }
    expect(screenValue("rsi1h", i)).toBe(100);
    expect(screenValue("divergence", i)).toBe("none");
    // Nothing throws, for any column.
    for (const c of SCREEN_COLUMNS) screenValue(c, i);
  });
});

describe("filters", () => {
  it("takes percentages as typed", () => {
    expect(passesFilter({ column: "change24h", op: "above", value: 5 }, 0.06)).toBe(true);
    expect(passesFilter({ column: "change24h", op: "above", value: 5 }, 0.04)).toBe(false);
    expect(passesFilter({ column: "rsi1h", op: "below", value: 30 }, 25)).toBe(true);
  });

  it("reads a between either way round", () => {
    const f = { column: "rsi1h" as const, op: "between" as const, value: 70, to: 30 };
    expect(passesFilter(f, 50)).toBe(true);
    expect(passesFilter(f, 80)).toBe(false);
  });

  it("matches a state, and passes nothing unknown", () => {
    expect(passesFilter({ column: "regime", op: "is", value: "ranging" }, "ranging")).toBe(true);
    expect(passesFilter({ column: "rsi1h", op: "above", value: 1 }, undefined)).toBe(false);
  });
});

describe("runScreen", () => {
  const inputs = [input("A", 110, 100, 5e6), input("B", 90, 100, 5e6), input("C", 105, 100, 10)];

  it("keeps what passes every filter, sorted", () => {
    const rows = runScreen(
      screen({ filters: [{ column: "volume", op: "above", value: 1000 }] }),
      inputs,
    );
    expect(rows.map((r) => r.market.id)).toEqual(["A", "B"]);
  });

  it("sorts either way, unknowns last", () => {
    const rows = runScreen(screen({ sort: { column: "change24h", desc: false } }), [
      ...inputs,
      { market: market("D"), now: 0 },
    ]);
    expect(rows.map((r) => r.market.id)).toEqual(["B", "C", "A", "D"]);
  });

  it("leaves stocks and the like out of a crypto screen", () => {
    const stock = { ...input("TSLA", 1, 1, 1), market: market("TSLA", "stocks") };
    expect(runScreen(screen(), [stock])).toHaveLength(0);
    expect(runScreen(screen({ scope: "all" }), [stock])).toHaveLength(1);
  });
});

describe("parseScreenNumber", () => {
  it("reads plain numbers and k / m / b", () => {
    expect(parseScreenNumber("5")).toBe(5);
    expect(parseScreenNumber("-1.5")).toBe(-1.5);
    expect(parseScreenNumber("2m")).toBe(2e6);
    expect(parseScreenNumber("1,200")).toBe(1200);
    expect(parseScreenNumber("abc")).toBeUndefined();
  });
});

describe("screenFrom", () => {
  it("reads every preset back as it is", () => {
    for (const p of SCREEN_PRESETS) expect(screenFrom(JSON.parse(JSON.stringify(p)))).toEqual(p);
  });

  it("drops what doesn't read", () => {
    const read = screenFrom({
      id: "x",
      name: "Mine",
      columns: ["price", "nope", "price"],
      filters: [
        { column: "rsi1h", op: "below", value: 30 },
        { column: "rsi1h", op: "is", value: "x" },
        { column: "regime", op: "is", value: "ranging" },
        { column: "rsi1h", op: "between", value: 1 },
      ],
      sort: { column: "bad" },
    });
    expect(read?.columns).toEqual(["price"]);
    expect(read?.filters).toHaveLength(2);
    expect(read?.sort).toEqual({ column: "volume", desc: true });
    expect(screenFrom({ name: "no id" })).toBeUndefined();
  });
});

describe("techRating", () => {
  const run = (closes: number[]) => closes.map((c, i) => candle(i * HOUR, c));

  it("needs enough candles for its longest average", () => {
    expect(techRating(run(Array.from({ length: 100 }, () => 1)))).toBeUndefined();
  });

  it("reads a steady climb as a buy, a steady fall as a sell", () => {
    const up = techRating(run(Array.from({ length: 168 }, (_, i) => 100 + i)));
    const down = techRating(run(Array.from({ length: 168 }, (_, i) => 300 - i)));
    // Most averages: Ichimoku votes only on a cross, and the Hull average
    // sits on a straight line.
    expect(up?.ma).toBeGreaterThan(0.7);
    expect(down?.ma).toBeLessThan(-0.7);
    expect(ratingOf(up?.all ?? 0)).toMatch(/buy/i);
    expect(ratingOf(down?.all ?? 0)).toMatch(/sell/i);
  });

  it("stays between -1 and 1", () => {
    const zigzag = run(Array.from({ length: 168 }, (_, i) => 100 + ((i * 7) % 13)));
    const r = techRating(zigzag);
    for (const v of [r?.ma, r?.osc, r?.all]) {
      expect(v).toBeGreaterThanOrEqual(-1);
      expect(v).toBeLessThanOrEqual(1);
    }
  });
});

describe("techVotes", () => {
  const run = (closes: number[]) => closes.map((c, i) => candle(i * HOUR, c));

  it("counts every indicator once, as the rating weighs them", () => {
    const up = techVotes(run(Array.from({ length: 168 }, (_, i) => 100 + i)));
    // 168 candles: every indicator but the two 200 averages.
    expect(up && up.sell + up.neutral + up.buy).toBe(24);
    expect(up?.buy).toBeGreaterThan(up?.sell ?? 0);
    expect(techVotes(run(Array.from({ length: 100 }, () => 1)))).toBeUndefined();
  });
});

describe("ratings", () => {
  it("names scores at their thresholds", () => {
    expect([1, 0.5, 0.2, 0, -0.2, -0.5, -1].map(ratingOf)).toEqual([
      "strongBuy",
      "strongBuy",
      "buy",
      "neutral",
      "sell",
      "strongSell",
      "strongSell",
    ]);
  });

  it("filters a score by its rating", () => {
    const f = { column: "rating" as const, op: "is" as const, value: "strongBuy" };
    expect(passesFilter(f, 0.8)).toBe(true);
    expect(passesFilter(f, 0.3)).toBe(false);
  });

  it("sorts by the score, not the name", () => {
    const up = input("UP", 110, 100, 5e6);
    up.candles = Array.from({ length: 168 }, (_, i) => candle(i * HOUR, 100 + i));
    const down = input("DOWN", 90, 100, 5e6);
    down.candles = Array.from({ length: 168 }, (_, i) => candle(i * HOUR, 300 - i));
    const rows = runScreen(
      {
        ...SCREEN_PRESETS[0],
        columns: ["rating"],
        sort: { column: "rating", desc: true },
      } as Screen,
      [down, up],
    );
    expect(rows.map((r) => r.market.id)).toEqual(["UP", "DOWN"]);
  });
});
