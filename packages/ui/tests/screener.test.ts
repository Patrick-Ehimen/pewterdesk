import type { Market, MarketHistory, MarketSummary } from "@pewterdesk/core";
import { describe, expect, it } from "vitest";
import {
  changeOver,
  fundingApr,
  marketState,
  matchesFilter,
  matchesSearch,
  OI_WINDOW_MS,
  type OiSamples,
  rsi,
  screenerRows,
  signalEvents,
  signalFor,
  sortRows,
  trackOpenInterest,
} from "../src/lib/screener";

const market = (id: string): Market => ({
  venue: "hyperliquid",
  id,
  symbol: `${id}-USD`,
  base: id,
  quote: "USDC",
  tickSize: "0.01",
  sizeStep: "0.01",
  minSize: "0.01",
  maxLeverage: 10,
});
const summary = (id: string, mark: string, prev: string, funding = "0.00001"): MarketSummary => ({
  market: id,
  markPrice: mark,
  prevDayPrice: prev,
  dayVolume: "1000",
  openInterest: "100",
  fundingRate: funding,
  fundingIntervalSecs: 3600,
});
const history = (id: string, closes: number[], volumes?: number[]): MarketHistory => ({
  market: id,
  interval: "1h",
  candles: closes.map((c, i) => ({
    openTime: i * 3_600_000,
    open: String(c),
    high: String(c),
    low: String(c),
    close: String(c),
    volume: String(volumes?.[i] ?? 10),
  })),
});

describe("indicators", () => {
  it("RSI is 100 on straight gains, 0 on straight losses, undefined when short", () => {
    const up = Array.from({ length: 20 }, (_, i) => 100 + i);
    expect(rsi(up)).toBe(100);
    expect(rsi([...up].reverse())).toBe(0);
    expect(rsi(up.slice(0, 10))).toBeUndefined();
  });

  it("RSI sits near 50 when gains and losses balance", () => {
    const zigzag = Array.from({ length: 40 }, (_, i) => (i % 2 ? 101 : 100));
    expect(rsi(zigzag)).toBeGreaterThan(45);
    expect(rsi(zigzag)).toBeLessThan(55);
  });

  it("measures change over a number of closes", () => {
    expect(changeOver([100, 110, 121], 1)).toBeCloseTo(0.1);
    expect(changeOver([100], 1)).toBeUndefined();
  });

  it("annualises hourly funding", () => {
    expect(fundingApr(0.0001, 3600)).toBeCloseTo(0.876);
  });
});

describe("rows and signals", () => {
  it("joins listed markets only, deriving changes, APR and RSI", () => {
    const rows = screenerRows(
      [market("BTC")],
      [summary("BTC", "110", "100"), summary("GONE", "1", "1")],
      new Map([
        [
          "BTC",
          history(
            "BTC",
            Array.from({ length: 20 }, (_, i) => 100 + i),
          ),
        ],
      ]),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.change24h).toBeCloseTo(0.1);
    expect(rows[0]?.change1h).toBeCloseTo(119 / 118 - 1);
    expect(rows[0]?.rsi1h).toBe(100);
    expect(rows[0]?.signal).toBe("overbought");
  });

  it("picks signals in priority order", () => {
    const base = screenerRows([market("X")], [summary("X", "100", "100")])[0];
    if (!base) throw new Error("no row");
    expect(signalFor({ ...base, rsi1h: 25 })).toBe("oversold");
    expect(signalFor({ ...base, oiChange: 0.05 })).toBe("oiSpike");
    expect(signalFor({ ...base, fundingApr: 0.8 })).toBe("crowdedLong");
    expect(signalFor({ ...base, fundingApr: -0.2 })).toBe("negativeFunding");
    expect(signalFor({ ...base, change24h: 0.04 })).toBe("momentum");
    expect(signalFor(base)).toBeUndefined();
  });

  it("filters by chip", () => {
    const [hype] = screenerRows([market("HYPE")], [summary("HYPE", "104", "100")]);
    if (!hype) throw new Error("no row");
    expect(matchesFilter(hype, "movers", new Set())).toBe(true);
    expect(matchesFilter(hype, "hl", new Set())).toBe(true);
    expect(matchesFilter(hype, "starred", new Set(["HYPE"]))).toBe(true);
    expect(matchesFilter(hype, "oi", new Set())).toBe(false);
    expect(matchesFilter(hype, "builder", new Set())).toBe(false);
  });

  it("tells builder-deployed markets apart, and finds them by exchange", () => {
    const tsla: Market = {
      ...market("xyz:TSLA"),
      symbol: "TSLA-USD",
      base: "TSLA",
      listedBy: "xyz",
    };
    // A builder listing of HYPE isn't part of the HL ecosystem chip.
    const hyna: Market = {
      ...market("hyna:HYPE"),
      symbol: "HYPE-USD",
      base: "HYPE",
      listedBy: "hyna",
    };
    const [tslaRow, hynaRow] = screenerRows(
      [tsla, hyna],
      [summary("xyz:TSLA", "372", "370"), summary("hyna:HYPE", "44", "40")],
    );
    expect(tslaRow && matchesFilter(tslaRow, "builder", new Set())).toBe(true);
    expect(hynaRow && matchesFilter(hynaRow, "hl", new Set())).toBe(false);

    expect(matchesSearch(tsla, "tsla")).toBe(true);
    expect(matchesSearch(tsla, "xyz")).toBe(true);
    expect(matchesSearch(tsla, "btc")).toBe(false);
    expect(matchesSearch(market("BTC"), "")).toBe(true);
  });

  it("sorts either way, with missing values last", () => {
    const rows = screenerRows(
      [market("A"), market("B"), market("C")],
      [summary("A", "1", "1"), summary("B", "2", "1"), summary("C", "3", "1")],
      new Map([
        [
          "A",
          history(
            "A",
            Array.from({ length: 20 }, (_, i) => 100 - i),
          ),
        ],
        [
          "C",
          history(
            "C",
            Array.from({ length: 20 }, (_, i) => 100 + i),
          ),
        ],
      ]),
    );
    expect(sortRows(rows, "rsi1h", true).map((r) => r.market.id)).toEqual(["C", "A", "B"]);
    expect(sortRows(rows, "rsi1h", false).map((r) => r.market.id)).toEqual(["A", "C", "B"]);
    expect(sortRows(rows, "change24h", true).map((r) => r.market.id)).toEqual(["C", "B", "A"]);
  });
});

describe("live signals", () => {
  const rowsById = new Map();

  it("reports transitions, not states already true on first sight", () => {
    const calm = { fundingSign: 1 as const, oiSpike: false, aboveHigh: false, rsi1h: 60 };
    const hot = {
      fundingSign: -1 as const,
      oiSpike: true,
      aboveHigh: true,
      rsi1h: 72,
      high24h: 10,
      volumeSurge: 2.5,
    };
    expect(signalEvents(new Map(), new Map([["X", hot]]), rowsById, 1)).toEqual([]);
    const kinds = signalEvents(new Map([["X", calm]]), new Map([["X", hot]]), rowsById, 1).map(
      (e) => e.kind,
    );
    expect(kinds.sort()).toEqual([
      "breakout",
      "fundingNegative",
      "oiSpike",
      "overbought",
      "volume",
    ]);
  });

  it("reads breakouts and volume surges from closed candles", () => {
    const [row] = screenerRows([market("X")], [summary("X", "12", "10")]);
    if (!row) throw new Error("no row");
    // 30 closed hours at 10, a last closed hour with 5× volume, then the forming hour.
    const closes = [...Array.from({ length: 31 }, () => 10), 11];
    const volumes = [...Array.from({ length: 30 }, () => 10), 50, 1];
    const state = marketState(row, history("X", closes, volumes));
    expect(state.aboveHigh).toBe(true);
    expect(state.high24h).toBe(10);
    expect(state.volumeSurge).toBeCloseTo(5);
  });

  it("measures OI change only once the window is covered", () => {
    const samples: OiSamples = new Map();
    expect(trackOpenInterest(samples, [summary("X", "1", "1")], 0).size).toBe(0);
    const later = { ...summary("X", "1", "1"), openInterest: "104" };
    const changes = trackOpenInterest(samples, [later], OI_WINDOW_MS);
    expect(changes.get("X")).toBeCloseTo(0.04);
  });
});
