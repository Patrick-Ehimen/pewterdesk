import type { Candle, CandleInterval, Market } from "@pewterdesk/core";
import { describe, expect, it } from "vitest";
import {
  COLOR_BASE,
  COLOR_RAMPS,
  drawingPrice,
  readColor,
  writeColor,
} from "../src/lib/chartColors";
import { chartToolsFrom, DEFAULT_CHART_TOOLS } from "../src/lib/chartTools";
import {
  canToggle,
  framesOf,
  groupOf,
  groupOfBarSeconds,
  rangeOf,
  shownGroups,
  tickedGroups,
} from "../src/lib/drawingFrames";
import {
  asInterval,
  type BarSource,
  barFeed,
  chartCode,
  groupNews,
  levelLine,
  MAX_BARS_PAGE,
  marketOfSymbol,
  outOfAutoscale,
  toBar,
} from "../src/lib/openAlgoChart";

const market = (id: string, over: Partial<Market> = {}): Market => ({
  venue: "hyperliquid",
  id,
  symbol: `${id}-USDC`,
  base: id,
  quote: "USDC",
  tickSize: "0.01",
  sizeStep: "0.01",
  minSize: "0.01",
  maxLeverage: 20,
  ...over,
});

const candle = (openTime: number, close = "10"): Candle => ({
  openTime,
  open: "9",
  high: "11",
  low: "8",
  close,
  volume: "120.5",
});

const MARKETS = [
  market("BTC"),
  market("kPEPE"),
  market("xyz:TSLA", { base: "TSLA" }),
  market("ETH"),
];
const HOUR = 3_600_000;

/** A source that records what it was asked, and lets a test push live candles. */
function fakeSource(history: Candle[] = []) {
  const asked: { market: string; interval: CandleInterval; before: number; count: number }[] = [];
  let push: ((candles: Candle[]) => void) | undefined;
  let unsubscribed = false;
  const source: BarSource = {
    history: async (m, interval, before, count) => {
      asked.push({ market: m, interval, before, count });
      return history;
    },
    subscribe: (_m, _i, onCandles) => {
      push = onCandles;
      return () => {
        unsubscribed = true;
      };
    },
  };
  return { source, asked, push: (c: Candle[]) => push?.(c), unsubscribed: () => unsubscribed };
}

describe("toBar", () => {
  it("turns a candle into a bar in UTC seconds and plain numbers", () => {
    expect(toBar(candle(1_700_000_000_000, "10.5"))).toEqual({
      time: 1_700_000_000,
      open: 9,
      high: 11,
      low: 8,
      close: 10.5,
      volume: 120.5,
    });
  });
});

describe("asInterval", () => {
  it("accepts only the venue intervals", () => {
    expect(asInterval("4h")).toBe("4h");
    expect(asInterval("1mo")).toBeUndefined();
  });

  it("names months so the chart can't take them for minutes", () => {
    expect(chartCode("1m")).toBe("1m");
    expect(chartCode("1M")).toBe("1MN");
    expect(chartCode("12M")).toBe("12MN");
    expect(asInterval("1MN")).toBe("1M");
    expect(asInterval("1M")).toBeUndefined();
  });
});

describe("marketOfSymbol", () => {
  it("finds a market whatever case the chart gives its id in", () => {
    expect(marketOfSymbol(MARKETS, "KPEPE")?.id).toBe("kPEPE");
    expect(marketOfSymbol(MARKETS, "XYZ:TSLA")?.id).toBe("xyz:TSLA");
    expect(marketOfSymbol(MARKETS, "DOGE")).toBeUndefined();
  });
});

describe("barFeed", () => {
  it("asks for the window's bars up to and including `to`", async () => {
    const { source, asked } = fakeSource([candle(0), candle(HOUR), candle(2 * HOUR)]);
    const feed = barFeed(source, () => MARKETS);
    const bars = await feed.getBars({
      symbol: "KPEPE",
      exchange: "hyperliquid",
      interval: "1h",
      from: 3600,
      to: 7200,
    });
    expect(asked).toEqual([{ market: "kPEPE", interval: "1h", before: 7_201_000, count: 2 }]);
    expect(bars.map((b) => b.time)).toEqual([3600, 7200]);
  });

  it("never asks a venue for more than a page", async () => {
    const { source, asked } = fakeSource();
    const feed = barFeed(source, () => MARKETS);
    await feed.getBars({ symbol: "BTC", exchange: "", interval: "1m", from: 0, to: 9_000_000 });
    expect(asked[0]?.count).toBe(MAX_BARS_PAGE);
  });

  it("refuses a market or interval it doesn't know", async () => {
    const feed = barFeed(fakeSource().source, () => MARKETS);
    await expect(feed.getBars({ symbol: "DOGE", exchange: "", interval: "1h" })).rejects.toThrow();
    await expect(feed.getBars({ symbol: "BTC", exchange: "", interval: "1mo" })).rejects.toThrow();
  });

  it("pages back from an exclusive anchor, and says when history ends", async () => {
    const { source, asked } = fakeSource([candle(0), candle(HOUR)]);
    const feed = barFeed(source, () => MARKETS);
    const req = { symbol: "BTC", exchange: "", interval: "1h", before: 7200, countBack: 300 };
    const page = await feed.getBarsPage?.(req);
    expect(asked[0]).toEqual({ market: "BTC", interval: "1h", before: 7_200_000, count: 300 });
    expect(page).toMatchObject({ hasMore: true, nextBefore: 0 });

    const empty = await barFeed(fakeSource().source, () => MARKETS).getBarsPage?.(req);
    expect(empty).toEqual({ bars: [], hasMore: false });
  });

  it("passes on only the forming candle of the first batch, then every live one", () => {
    const { source, push, unsubscribed } = fakeSource();
    const feed = barFeed(source, () => MARKETS);
    const seen: number[] = [];
    const stop = feed.subscribeBars?.({ symbol: "BTC", exchange: "", interval: "1h" }, (bar) =>
      seen.push(bar.time),
    );
    push([candle(0), candle(HOUR), candle(2 * HOUR)]);
    expect(seen).toEqual([7200]);
    push([candle(2 * HOUR, "12"), candle(3 * HOUR)]);
    // An older candle is never sent after a newer one.
    push([candle(HOUR)]);
    expect(seen).toEqual([7200, 7200, 10_800]);
    stop?.();
    expect(unsubscribed()).toBe(true);
  });
});

describe("levelLine", () => {
  const colors = { buy: "#0a0", sell: "#a00", warning: "#aa0", order: "#b80" };
  it("draws a position solid in its side's colour, and the rest dashed", () => {
    const entry = levelLine(
      { id: "position", kind: "position", price: 38, side: "short" },
      "Short",
      colors,
    );
    expect(entry).toMatchObject({
      id: "pd:position",
      price: 38,
      color: "#a00",
      lineStyle: "solid",
    });
    expect(entry.closeButton).toBeUndefined();
    expect(
      levelLine({ id: "liquidation", kind: "liquidation", price: 30 }, "Liq", colors),
    ).toMatchObject({ color: "#aa0", lineStyle: "dashed", leftLabel: "Liq" });
    expect(
      levelLine({ id: "order:1", kind: "order", price: 37, side: "buy" }, "Buy", colors).color,
    ).toBe("#b80");
  });

  it("spans part of the plot from the price axis", () => {
    const line = levelLine({ id: "liquidation", kind: "liquidation", price: 30 }, "Liq", colors);
    expect(line.extentFromRight).toBeGreaterThan(0);
    expect(line.extentFromRight).toBeLessThan(1);
  });
});

describe("outOfAutoscale", () => {
  it("leaves a line out of the price scale's fit", () => {
    const line = { autoscaleInfo: (): unknown => ({ min: 30, max: 30 }) };
    expect(outOfAutoscale(line).autoscaleInfo()).toBeNull();
  });
});

describe("groupNews", () => {
  const spot = (id: string, x: number) => ({ id, x });

  it("leaves releases apart at their own times", () => {
    expect(groupNews([spot("a", 10), spot("b", 40)], 20, 30)).toEqual([
      { x: 10, ids: ["a"] },
      { x: 40, ids: ["b"] },
    ]);
  });

  it("makes one badge of releases too close to part, at the first one's time", () => {
    expect(groupNews([spot("a", 10), spot("b", 10), spot("c", 25), spot("d", 60)], 20, 30)).toEqual(
      [
        { x: 10, ids: ["a", "b", "c"] },
        { x: 60, ids: ["d"] },
      ],
    );
  });

  it("eases badges that would touch apart, without merging them", () => {
    expect(groupNews([spot("a", 10), spot("b", 32), spot("c", 54)], 20, 30)).toEqual([
      { x: 10, ids: ["a"] },
      { x: 40, ids: ["b"] },
      { x: 70, ids: ["c"] },
    ]);
  });
});

describe("chartToolsFrom", () => {
  it("keeps what reads, and the default for the rest", () => {
    expect(chartToolsFrom({ favorites: ["trend-line", 3], x: 0.2, y: "top" })).toEqual({
      favorites: ["trend-line"],
      x: 0.2,
      y: DEFAULT_CHART_TOOLS.y,
      collapsed: false,
    });
    expect(chartToolsFrom(null)).toEqual(DEFAULT_CHART_TOOLS);
  });

  it("keeps the bar on the chart", () => {
    expect(chartToolsFrom({ x: 4, y: -1 })).toMatchObject({ x: 1, y: 0 });
  });

  it("keeps a folded bar folded, and folds only for a real true", () => {
    expect(chartToolsFrom({ collapsed: true }).collapsed).toBe(true);
    expect(chartToolsFrom({ collapsed: "yes" }).collapsed).toBe(false);
  });
});

describe("chart colours", () => {
  it("offers each colour once, and no list of recent ones", () => {
    const all = [...COLOR_BASE, ...COLOR_RAMPS].flat();
    expect(new Set(all).size).toBe(all.length);
    expect(all.length).toBe(80);
  });

  it("reads a style's colour and opacity back", () => {
    expect(readColor("#FF8800")).toEqual({ hex: "#ff8800", alpha: 1 });
    expect(readColor("rgba(255, 136, 0, 0.4)")).toEqual({ hex: "#ff8800", alpha: 0.4 });
    expect(readColor("#ff880080").alpha).toBeCloseTo(0.5, 1);
    expect(readColor(undefined)).toEqual({ hex: "#000000", alpha: 1 });
  });

  it("writes a solid colour plainly, and a see-through one with its opacity", () => {
    expect(writeColor({ hex: "#ff8800", alpha: 1 })).toBe("#ff8800");
    expect(writeColor({ hex: "#ff8800", alpha: 0.4 })).toBe("rgba(255,136,0,0.4)");
    expect(readColor(writeColor({ hex: "#ff8800", alpha: 0.4 }))).toEqual({
      hex: "#ff8800",
      alpha: 0.4,
    });
  });
});

describe("drawingPrice", () => {
  const points = [
    { time: 100, price: 10 },
    { time: 200, price: 20 },
  ];

  it("reads a line where it is now", () => {
    expect(drawingPrice("trend-line", points, 300)).toBe(30);
  });

  it("reads anything else at its last point", () => {
    expect(drawingPrice("rectangle", points, 300)).toBe(20);
    expect(drawingPrice("horizontal-line", [{ time: 1, price: 7 }], 300)).toBe(7);
    expect(drawingPrice("rectangle", [], 300)).toBeUndefined();
  });
});

describe("a drawing's timeframes", () => {
  const INTERVALS = ["1m", "15m", "1h", "4h", "1d", "3d", "1w", "1MN", "3MN"];
  const ALL = ["minutes", "hours", "days", "weeks", "months"] as const;

  it("sorts interval codes into groups", () => {
    expect(INTERVALS.map(groupOf)).toEqual([
      "minutes",
      "minutes",
      "hours",
      "hours",
      "days",
      "days",
      "weeks",
      "months",
      "months",
    ]);
  });

  it("shows on everything with no range", () => {
    expect(tickedGroups(undefined, INTERVALS)).toEqual(ALL);
    expect(tickedGroups(null, INTERVALS)).toEqual(ALL);
    expect(rangeOf(ALL, INTERVALS)).toBeNull();
  });

  it("turns ticks into a range, and back", () => {
    const range = rangeOf(["hours", "days"], INTERVALS);
    expect(range).toEqual({ from: "1h", to: "3d" });
    expect(tickedGroups(range, INTERVALS)).toEqual(["hours", "days"]);
  });

  it("lets any tick change but the last one left", () => {
    expect(canToggle("days", ALL)).toBe(true);
    expect(canToggle("months", ["hours", "days"])).toBe(true);
    expect(canToggle("days", ["days"])).toBe(false);
  });

  it("keeps a gap beside the range, which runs from the first tick to the last", () => {
    const { range, hidden } = framesOf(["minutes", "days"], INTERVALS);
    expect(hidden).toEqual(["hours"]);
    expect(tickedGroups(range, INTERVALS)).toEqual(["minutes", "hours", "days"]);
    expect(shownGroups(range, hidden, INTERVALS)).toEqual(["minutes", "days"]);
  });

  it("has no gaps to keep for an unbroken run, nor when everything's ticked", () => {
    expect(framesOf(["hours", "days"], INTERVALS).hidden).toBeUndefined();
    expect(framesOf(ALL, INTERVALS)).toEqual({ range: null, hidden: undefined });
  });

  it("reads a chart's group from the seconds between its bars", () => {
    expect(groupOfBarSeconds(60)).toBe("minutes");
    expect(groupOfBarSeconds(1_800)).toBe("minutes");
    expect(groupOfBarSeconds(3_600)).toBe("hours");
    expect(groupOfBarSeconds(4 * 3_600)).toBe("hours");
    expect(groupOfBarSeconds(86_400)).toBe("days");
    expect(groupOfBarSeconds(3 * 86_400)).toBe("days");
    expect(groupOfBarSeconds(7 * 86_400)).toBe("weeks");
    expect(groupOfBarSeconds(30 * 86_400)).toBe("months");
    expect(groupOfBarSeconds(28 * 86_400)).toBe("months");
  });
});
