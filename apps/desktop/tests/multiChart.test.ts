import type { Market } from "@pewterdesk/core";
import { describe, expect, it } from "vitest";
import {
  defaultCells,
  MAX_CELLS,
  restore,
  toggledIndicator,
  withCell,
  withInterval,
  withMarket,
  withSync,
} from "../src/lib/multiChart";

const market = (id: string): Market => ({
  venue: "bybit",
  id,
  symbol: id,
  base: id,
  quote: "USDT",
  tickSize: "0.1",
  sizeStep: "0.01",
  minSize: "0.01",
  maxLeverage: 50,
});
const markets = ["A", "B", "BTC", "C", "ETH", "D", "E", "F", "G", "H", "I"].map(market);
const majors = ["BTC", "ETH", "GONE"];

describe("multi-chart state", () => {
  it("starts on the venue's majors, then its other markets", () => {
    const cells = defaultCells(markets, majors);
    expect(cells).toHaveLength(MAX_CELLS);
    expect(cells.slice(0, 4).map((c) => c.market)).toEqual(["BTC", "ETH", "A", "B"]);
    expect(new Set(cells.map((c) => c.market)).size).toBe(MAX_CELLS);
    expect(cells.every((c) => c.interval === "15m" && c.type === "candles")).toBe(true);
    expect(cells.every((c) => c.indicators.length === 0)).toBe(true);
  });

  it("restores what was saved, replacing a market that's gone", () => {
    const state = restore(
      {
        layout: "3x3",
        syncInterval: false,
        syncSymbol: false,
        cells: [
          { market: "C", interval: "1h", type: "line", indicators: ["rsi", "nope", "volume"] },
          { market: "DELISTED", interval: "4h" },
          { market: "ETH", interval: "nope" },
        ],
      },
      markets,
      majors,
    );
    expect(state.layout).toBe("3x3");
    expect(state.syncInterval).toBe(false);
    expect(state.cells).toHaveLength(MAX_CELLS);
    // Its own chart type and indicators come back, less what isn't one.
    expect(state.cells[0]).toEqual({
      market: "C",
      interval: "1h",
      type: "line",
      indicators: ["volume", "rsi"],
    });
    // The gone one becomes a default not already on a chart, keeping its interval.
    expect(state.cells[1]).toMatchObject({ market: "BTC", interval: "4h", type: "candles" });
    expect(state.cells[2]).toMatchObject({ market: "ETH", interval: "15m" });
    // Nothing saved, or nonsense: the defaults.
    // Every chart on its own, unless a sync was asked for.
    expect(restore("junk", markets, majors)).toMatchObject({
      layout: "2x2",
      syncInterval: false,
      syncSymbol: false,
    });
    // Before the markets arrive, saved cells are taken on trust.
    expect(restore({ cells: [{ market: "X", interval: "1d" }] }, [], []).cells).toEqual([
      { market: "X", interval: "1d", type: "candles", indicators: [] },
    ]);
  });

  it("moves intervals and markets together only when synced", () => {
    const base = restore({ syncInterval: false }, markets, majors);
    const one = withInterval(base, 1, "4h");
    expect(one.cells.map((c) => c.interval).slice(0, 3)).toEqual(["15m", "4h", "15m"]);
    const all = withInterval({ ...base, syncInterval: true }, 1, "4h");
    expect(all.cells.every((c) => c.interval === "4h")).toBe(true);
    expect(withMarket(base, 2, "H").cells[2]?.market).toBe("H");
    expect(withMarket(base, 2, "H").cells[0]?.market).toBe("BTC");
    expect(
      withMarket({ ...base, syncSymbol: true }, 2, "H").cells.every((c) => c.market === "H"),
    ).toBe(true);
  });

  it("changes one chart's type and indicators, and no other's", () => {
    const base = restore(undefined, markets, majors);
    const next = withCell(base, 1, { type: "line", indicators: toggledIndicator([], "rsi") });
    expect(next.cells[1]).toMatchObject({ type: "line", indicators: ["rsi"] });
    expect(next.cells[0]).toEqual(base.cells[0]);
    expect(next.cells[2]).toEqual(base.cells[2]);
    // An interval change is one chart's too.
    expect(
      withInterval(next, 1, "1d")
        .cells.map((c) => c.interval)
        .slice(0, 3),
    ).toEqual(["15m", "1d", "15m"]);
    expect(toggledIndicator(["rsi", "ema"], "rsi")).toEqual(["ema"]);
    // Symbol sync keeps each chart's own type and indicators.
    expect(withSync(next, "symbol", true).cells[1]).toMatchObject({
      type: "line",
      indicators: ["rsi"],
    });
  });

  it("lines the charts up when a sync is switched on", () => {
    const base = withInterval(restore({ syncInterval: false }, markets, majors), 0, "1h");
    const synced = withSync(base, "interval", true);
    expect(synced.cells.every((c) => c.interval === "1h")).toBe(true);
    // One market on every chart, each at its own timeframe.
    const symbol = withSync(synced, "symbol", true);
    expect(symbol.cells.every((c) => c.market === "BTC")).toBe(true);
    expect(new Set(symbol.cells.map((c) => c.interval)).size).toBe(MAX_CELLS);
    expect([symbol.syncSymbol, symbol.syncInterval]).toEqual([true, false]);
    expect(withSync(symbol, "symbol", false).cells).toEqual(symbol.cells);
  });
});
