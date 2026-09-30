import { describe, expect, it } from "vitest";
import {
  loadMarkets,
  loadSpark,
  loadSummaries,
  SPARK_MAX_AGE_MS,
  SPARKS_KEPT,
  saveMarkets,
  saveSpark,
} from "../src/lib/trayCache";

function memoryStore() {
  const items = new Map<string, string>();
  return {
    items,
    getItem: (k: string) => items.get(k) ?? null,
    setItem: (k: string, v: string) => {
      items.set(k, v);
    },
  };
}

describe("tray cache", () => {
  it("round-trips markets, and ignores anything unreadable", () => {
    const store = memoryStore();
    saveMarkets("hyperliquid", [{ id: "BTC" } as never], store);
    expect(loadMarkets("hyperliquid", store).map((m) => m.id)).toEqual(["BTC"]);
    store.items.set("pd.cache.summaries", "{not json");
    expect(loadSummaries("hyperliquid", store)).toEqual([]);
    store.items.set("pd.cache.markets", JSON.stringify([{ nope: 1 }]));
    expect(loadMarkets("hyperliquid", store)).toEqual([]);
  });

  it("keeps each venue's markets apart", () => {
    const store = memoryStore();
    saveMarkets("hyperliquid", [{ id: "BTC" } as never], store);
    saveMarkets("aster", [{ id: "BTCUSDT" } as never], store);
    expect(loadMarkets("hyperliquid", store).map((m) => m.id)).toEqual(["BTC"]);
    expect(loadMarkets("aster", store).map((m) => m.id)).toEqual(["BTCUSDT"]);
  });

  it("serves a sparkline until it's stale", () => {
    const store = memoryStore();
    saveSpark("BTC", [1, 2, 3], 1000, store);
    expect(loadSpark("BTC", 1000 + SPARK_MAX_AGE_MS - 1, store)).toEqual({
      closes: [1, 2, 3],
      fresh: true,
    });
    // Stale: still shown while a fresh one loads.
    expect(loadSpark("BTC", 1000 + SPARK_MAX_AGE_MS, store)?.fresh).toBe(false);
    expect(loadSpark("ETH", 1000, store)).toBeUndefined();
  });

  it("keeps only the most recent sparklines", () => {
    const store = memoryStore();
    for (let i = 0; i <= SPARKS_KEPT; i++) saveSpark(`M${i}`, [i], i, store);
    expect(loadSpark("M0", 0, store)).toBeUndefined();
    expect(loadSpark(`M${SPARKS_KEPT}`, 0, store)?.closes).toEqual([SPARKS_KEPT]);
  });
});
