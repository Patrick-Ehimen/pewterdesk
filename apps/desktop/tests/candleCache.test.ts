import type { Candle } from "@pewterdesk/core";
import { describe, expect, it } from "vitest";
import { CACHED_CANDLES, CACHED_SERIES, loadCandles, saveCandles } from "../src/lib/candleCache";

const candle = (openTime: number): Candle => ({
  openTime,
  open: "1",
  high: "2",
  low: "0.5",
  close: "1.5",
  volume: "10",
});
const series = (n: number, from = 0) => Array.from({ length: n }, (_, i) => candle(from + i * 60));

/** A Storage stand-in; `limit` makes writes past that many characters throw like a full one. */
function memoryStore(limit = Number.POSITIVE_INFINITY) {
  const items = new Map<string, string>();
  const size = () => [...items.values()].reduce((sum, v) => sum + v.length, 0);
  return {
    items,
    getItem: (k: string) => items.get(k) ?? null,
    setItem: (k: string, v: string) => {
      const before = items.get(k);
      items.set(k, v);
      if (size() > limit) {
        if (before === undefined) items.delete(k);
        else items.set(k, before);
        throw new Error("QuotaExceededError");
      }
    },
    removeItem: (k: string) => {
      items.delete(k);
    },
  };
}

describe("candle cache", () => {
  it("round-trips a series, keeping only the newest candles", () => {
    const store = memoryStore();
    saveCandles("hyperliquid", "BTC", "1h", series(CACHED_CANDLES + 20), store);
    const loaded = loadCandles("hyperliquid", "BTC", "1h", store);
    expect(loaded).toHaveLength(CACHED_CANDLES);
    expect(loaded?.at(-1)?.openTime).toBe((CACHED_CANDLES + 19) * 60);
    // Another interval or market is a different series.
    expect(loadCandles("hyperliquid", "BTC", "1m", store)).toBeUndefined();
    expect(loadCandles("hyperliquid", "xyz:TSLA", "1h", store)).toBeUndefined();
  });

  it("drops the least recently saved series past the cap", () => {
    const store = memoryStore();
    for (let i = 0; i <= CACHED_SERIES; i++)
      saveCandles("hyperliquid", `M${i}`, "1h", series(3), store);
    expect(loadCandles("hyperliquid", "M0", "1h", store)).toBeUndefined();
    expect(loadCandles("hyperliquid", `M${CACHED_SERIES}`, "1h", store)).toHaveLength(3);

    // Saving M1 again makes it the newest, so M2 goes next instead.
    saveCandles("hyperliquid", "M1", "1h", series(3), store);
    saveCandles("hyperliquid", "NEW", "1h", series(3), store);
    expect(loadCandles("hyperliquid", "M1", "1h", store)).toHaveLength(3);
    expect(loadCandles("hyperliquid", "M2", "1h", store)).toBeUndefined();
  });

  it("makes room when storage is full, and gives up quietly when it can't", () => {
    const one = JSON.stringify(series(50)).length;
    const store = memoryStore(one * 2 + 200);
    saveCandles("hyperliquid", "A", "1h", series(50), store);
    saveCandles("hyperliquid", "B", "1h", series(50), store);
    saveCandles("hyperliquid", "C", "1h", series(50), store);
    expect(loadCandles("hyperliquid", "A", "1h", store)).toBeUndefined();
    expect(loadCandles("hyperliquid", "C", "1h", store)).toHaveLength(50);

    expect(() =>
      saveCandles("hyperliquid", "HUGE", "1h", series(400), memoryStore(10)),
    ).not.toThrow();
  });

  it("treats unreadable entries as no cache", () => {
    const store = memoryStore();
    store.items.set("pd.candles.hyperliquid:1h:BTC", "{not json");
    store.items.set("pd.candles.hyperliquid:1h:ETH", JSON.stringify([{ openTime: "x" }]));
    store.items.set("pd.candles.hyperliquid:1h:SOL", "[]");
    expect(loadCandles("hyperliquid", "BTC", "1h", store)).toBeUndefined();
    expect(loadCandles("hyperliquid", "ETH", "1h", store)).toBeUndefined();
    expect(loadCandles("hyperliquid", "SOL", "1h", store)).toBeUndefined();
  });
});
