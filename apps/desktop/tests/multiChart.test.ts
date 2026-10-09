import type { Market, VenueId } from "@pewterdesk/core";
import { describe, expect, it } from "vitest";
import {
  applySet,
  currentSet,
  DEFAULT_CELL_SETTINGS,
  defaultCells,
  GRID,
  LAYOUTS,
  MAX_CELLS,
  popoutCell,
  repaired,
  restore,
  sameCoin,
  setsFrom,
  swapped,
  toggledIndicator,
  withCell,
  withInterval,
  withMarket,
  withoutSet,
  withPositions,
  withSet,
  withSync,
} from "../src/lib/multiChart";

const market = (id: string, venue: VenueId = "bybit", base = id): Market => ({
  venue,
  id,
  symbol: id,
  base,
  quote: "USDT",
  tickSize: "0.1",
  sizeStep: "0.01",
  minSize: "0.01",
  maxLeverage: 50,
});
const markets = ["A", "B", "BTC", "C", "ETH", "D", "E", "F", "G", "H", "I"].map((id) => market(id));
const majors = ["BTC", "ETH", "GONE"];
/** Nine charts on Bybit's defaults. */
const base = () => repaired(restore(undefined), "bybit", markets, majors);

describe("multi-chart state", () => {
  it("starts on the venue's majors, then its other markets", () => {
    const cells = defaultCells("bybit", markets, majors);
    expect(cells).toHaveLength(MAX_CELLS);
    expect(cells.slice(0, 4).map((c) => c.market)).toEqual(["BTC", "ETH", "A", "B"]);
    expect(new Set(cells.map((c) => c.market)).size).toBe(MAX_CELLS);
    expect(cells.every((c) => c.venue === "bybit" && c.interval === "15m")).toBe(true);
    expect(cells.every((c) => c.type === "candles" && c.indicators.length === 0)).toBe(true);
  });

  it("restores what was saved, each chart with its own venue", () => {
    const state = restore({
      layout: "1+2",
      syncInterval: true,
      cells: [
        {
          venue: "bybit",
          market: "C",
          interval: "1h",
          type: "line",
          indicators: ["rsi", "nope"],
          // Its own settings; what doesn't read keeps its default.
          settings: { logScale: true, grid: false, countdown: "yes" },
        },
        { venue: "hyperliquid", market: "BTC", interval: "nope" },
        // Not charts: no venue, an unknown venue, no market.
        { market: "ETH" },
        { venue: "kraken", market: "ETH" },
        { venue: "aster", market: "" },
      ],
    });
    expect(state.layout).toBe("1+2");
    expect(state.syncInterval).toBe(true);
    expect(state.cells).toEqual([
      {
        venue: "bybit",
        market: "C",
        interval: "1h",
        type: "line",
        indicators: ["rsi"],
        settings: { ...DEFAULT_CELL_SETTINGS, logScale: true, grid: false },
      },
      {
        venue: "hyperliquid",
        market: "BTC",
        interval: "15m",
        type: "candles",
        indicators: [],
        settings: DEFAULT_CELL_SETTINGS,
      },
    ]);
    // Nothing saved, or nonsense: no charts yet, every one its own.
    expect(restore("junk")).toEqual({
      layout: "2x2",
      cells: [],
      syncInterval: false,
      syncSymbol: false,
      syncCrosshair: true,
      syncRange: false,
      tradeBar: false,
    });
  });

  it("repairs against a venue's markets once they're known", () => {
    const saved = restore({
      cells: [
        { venue: "bybit", market: "C", interval: "1h" },
        { venue: "bybit", market: "DELISTED", interval: "4h" },
        { venue: "hyperliquid", market: "WHATEVER" },
      ],
    });
    const fixed = repaired(saved, "bybit", markets, majors);
    expect(fixed.cells).toHaveLength(MAX_CELLS);
    expect(fixed.cells[0]).toMatchObject({ market: "C", interval: "1h" });
    // The gone one becomes a default not already on a chart, keeping its interval.
    expect(fixed.cells[1]).toMatchObject({ venue: "bybit", market: "BTC", interval: "4h" });
    // Another venue's chart isn't this venue's to judge.
    expect(fixed.cells[2]).toMatchObject({ venue: "hyperliquid", market: "WHATEVER" });
    // The rest are filled in on this venue, none twice.
    expect(fixed.cells.slice(3).every((c) => c.venue === "bybit")).toBe(true);
    const onBybit = fixed.cells.filter((c) => c.venue === "bybit").map((c) => c.market);
    expect(new Set(onBybit).size).toBe(onBybit.length);
    // Nothing to fix: the very same state. And nothing to go by: the same too.
    expect(repaired(fixed, "bybit", markets, majors)).toBe(fixed);
    expect(repaired(saved, "bybit", [], majors)).toBe(saved);
    // Without filling (a venue that isn't on screen): fixed, not added to.
    expect(repaired(saved, "bybit", markets, majors, false).cells).toHaveLength(3);
  });

  it("changes one chart and no other, unless a sync says so", () => {
    const state = base();
    expect(
      withInterval(state, 1, "4h")
        .cells.map((c) => c.interval)
        .slice(0, 3),
    ).toEqual(["15m", "4h", "15m"]);
    const all = withInterval({ ...state, syncInterval: true }, 1, "4h");
    expect(all.cells.every((c) => c.interval === "4h")).toBe(true);
    // A market on another venue, on that one chart.
    const mixed = withMarket(state, 2, "hyperliquid", "HYPE");
    expect(mixed.cells[2]).toMatchObject({ venue: "hyperliquid", market: "HYPE" });
    expect(mixed.cells[0]).toEqual(state.cells[0]);
    expect(
      withMarket({ ...state, syncSymbol: true }, 2, "aster", "X").cells.every(
        (c) => c.venue === "aster" && c.market === "X",
      ),
    ).toBe(true);
    const styled = withCell(state, 1, { type: "line", indicators: toggledIndicator([], "rsi") });
    expect(styled.cells[1]).toMatchObject({ type: "line", indicators: ["rsi"] });
    // A chart's settings are its own too.
    const logged = withCell(state, 1, { settings: { ...DEFAULT_CELL_SETTINGS, logScale: true } });
    expect(logged.cells[1]?.settings.logScale).toBe(true);
    expect(logged.cells[0]?.settings).toEqual(DEFAULT_CELL_SETTINGS);
    expect(styled.cells[0]).toEqual(state.cells[0]);
    expect(toggledIndicator(["rsi", "ema"], "rsi")).toEqual(["ema"]);
  });

  it("finds the same coin on another venue", () => {
    const hl = [market("BTC", "hyperliquid"), market("kPEPE", "hyperliquid")];
    expect(sameCoin("btc", hl, "HYPE")).toBe("BTC");
    expect(sameCoin("DOGE", hl, "HYPE")).toBe("HYPE");
    expect(sameCoin(undefined, hl, "HYPE")).toBe("HYPE");
    const aster = [market("BTCUSDT", "aster", "BTC")];
    expect(sameCoin("BTC", aster, "ETHUSDT")).toBe("BTCUSDT");
  });

  it("swaps two charts, everything about them going along", () => {
    const state = withCell(base(), 0, { type: "line" });
    const next = swapped(state, 0, 3);
    expect(next.cells[3]).toEqual(state.cells[0]);
    expect(next.cells[0]).toEqual(state.cells[3]);
    expect(next.cells[1]).toEqual(state.cells[1]);
    expect(swapped(state, 2, 2)).toBe(state);
    expect(swapped(state, 0, 99)).toBe(state);
  });

  it("puts the markets held first, keeping the rest in order", () => {
    const state = withMarket(withCell(base(), 0, { type: "line" }), 5, "hyperliquid", "HYPE");
    const next = withPositions({ ...state, syncSymbol: true }, "bybit", ["H", "ETH"]);
    expect(next.cells.slice(0, 5).map((c) => c.market)).toEqual(["H", "ETH", "BTC", "A", "B"]);
    expect(next.cells.slice(0, 2).every((c) => c.venue === "bybit")).toBe(true);
    // The Hyperliquid chart moved along with the rest, still Hyperliquid's.
    expect(next.cells.find((c) => c.market === "HYPE")?.venue).toBe("hyperliquid");
    // The first chart is still a line chart, and markets are their own again.
    expect(next.cells[0]?.type).toBe("line");
    expect(next.syncSymbol).toBe(false);
    expect(withPositions(state, "bybit", []).cells).toEqual(state.cells);
  });

  it("lines the charts up when a sync is switched on", () => {
    const state = withMarket(withInterval(base(), 0, "1h"), 0, "hyperliquid", "HYPE");
    const synced = withSync(state, "interval", true);
    expect(synced.cells.every((c) => c.interval === "1h")).toBe(true);
    // One market on every chart, each at its own timeframe.
    const symbol = withSync(synced, "symbol", true);
    expect(symbol.cells.every((c) => c.venue === "hyperliquid" && c.market === "HYPE")).toBe(true);
    expect(new Set(symbol.cells.map((c) => c.interval)).size).toBe(MAX_CELLS);
    expect([symbol.syncSymbol, symbol.syncInterval]).toEqual([true, false]);
    expect(withSync(symbol, "symbol", false).cells).toEqual(symbol.cells);
  });

  it("lays out every layout within the cells kept", () => {
    for (const layout of LAYOUTS) {
      const { cols, rows, charts } = GRID[layout];
      expect(charts, layout).toBeLessThanOrEqual(MAX_CELLS);
      expect(charts, layout).toBeLessThanOrEqual(cols * rows);
    }
    expect(GRID["1+2"].charts).toBe(3);
    expect(GRID["2x3"]).toMatchObject({ cols: 3, rows: 2, charts: 6 });
  });
});

describe("saved sets", () => {
  it("keeps the charts under a name, and brings them back", () => {
    const state = { ...withCell(base(), 0, { type: "area" }), layout: "1x3" as const };
    const sets = withSet([], "  My   majors ", state);
    expect(sets.map((s) => s.name)).toEqual(["My majors"]);
    expect(currentSet(sets, state)?.name).toBe("My majors");
    // Changed since: no set is the one showing.
    const moved = withInterval(state, 0, "1d");
    expect(currentSet(sets, moved)).toBeUndefined();
    const [set] = sets;
    if (!set) throw new Error("no set saved");
    const back = applySet({ ...moved, layout: "3x3", syncSymbol: true }, set);
    expect(back.layout).toBe("1x3");
    expect(back.cells).toEqual(state.cells);
    expect(back.syncSymbol).toBe(false);
  });

  it("replaces a set of the same name, drops one, and ignores no name", () => {
    const one = withSet([], "alts", base());
    const two = withSet(one, "alts", { ...base(), layout: "3x3" });
    expect(two).toHaveLength(1);
    expect(two[0]?.layout).toBe("3x3");
    expect(withSet(two, "   ", base())).toEqual(two);
    expect(withoutSet(withSet(two, "majors", base()), "alts").map((s) => s.name)).toEqual([
      "majors",
    ]);
    expect(withSet([], "x".repeat(60), base())[0]?.name).toHaveLength(24);
  });

  it("reads back only what's a set", () => {
    const good = { name: "ok", layout: "2x2", cells: [{ venue: "bybit", market: "BTC" }] };
    expect(
      setsFrom([good, { name: "", layout: "2x2", cells: good.cells }, { name: "x" }, "junk"]),
    ).toEqual([
      {
        name: "ok",
        layout: "2x2",
        cells: [
          {
            venue: "bybit",
            market: "BTC",
            interval: "15m",
            type: "candles",
            indicators: [],
            settings: DEFAULT_CELL_SETTINGS,
          },
        ],
      },
    ]);
    expect(setsFrom("nope")).toEqual([]);
  });

  it("gives a popped-out window the chart its address names", () => {
    const hash = "#chart?venue=hyperliquid&market=xyz:TSLA&interval=1h";
    const left = {
      venue: "hyperliquid",
      market: "xyz:TSLA",
      interval: "1h",
      type: "line",
      indicators: ["rsi"],
      settings: { logScale: true },
    };
    // What was left for it, when it's the same chart.
    expect(popoutCell(hash, left)).toMatchObject({
      type: "line",
      indicators: ["rsi"],
      settings: { ...DEFAULT_CELL_SETTINGS, logScale: true },
    });
    // Another chart's leftovers: a fresh one on the named market.
    expect(popoutCell(hash, { ...left, market: "BTC" })).toMatchObject({
      venue: "hyperliquid",
      market: "xyz:TSLA",
      interval: "1h",
      type: "candles",
      indicators: [],
    });
    expect(popoutCell("#chart?venue=kraken&market=BTC&interval=1h", null)).toBeUndefined();
    expect(popoutCell("#chart", null)).toBeUndefined();
  });
});
