import type { Candle, CandleInterval, Market } from "@pewterdesk/core";
import { describe, expect, it } from "vitest";
import {
  asInterval,
  type BarSource,
  barFeed,
  levelLine,
  MAX_BARS_PAGE,
  marketOfSymbol,
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
});
