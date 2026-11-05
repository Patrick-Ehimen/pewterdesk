import { describe, expect, it } from "vitest";
import { makeRoom, storedChars, trimStorage, writeSurely } from "../src/lib/storageRoom";

/** A storage with a quota, as the webview's: a write that would go past it is refused. */
function fullStore(quota: number, items: Record<string, string>) {
  const map = new Map(Object.entries(items));
  const size = () => [...map].reduce((n, [k, v]) => n + k.length + v.length, 0);
  return {
    get length() {
      return map.size;
    },
    key: (i: number) => [...map.keys()][i] ?? null,
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => {
      const before = map.get(k);
      map.set(k, v);
      if (size() > quota) {
        if (before === undefined) map.delete(k);
        else map.set(k, before);
        throw new DOMException("full", "QuotaExceededError");
      }
    },
    removeItem: (k: string) => void map.delete(k),
    map,
  };
}

describe("room in storage", () => {
  it("makes way with the caches when a write is refused, and says it landed", () => {
    const s = fullStore(100, {
      "pd.icons.hyperliquid": "x".repeat(60),
      "pd.oi.hyperliquid": "o".repeat(20),
    });
    expect(writeSurely("pd.paper.hyperliquid", "p".repeat(40), s)).toBe(true);
    expect(s.getItem("pd.paper.hyperliquid")).toBe("p".repeat(40));
    // The logos made way; the collected open interest didn't.
    expect(s.getItem("pd.icons.hyperliquid")).toBeNull();
    expect(s.getItem("pd.oi.hyperliquid")).toBe("o".repeat(20));
  });

  it("says so when even then it can't land", () => {
    const s = fullStore(50, { "pd.oi.hyperliquid": "o".repeat(40) });
    expect(writeSurely("pd.paper.hyperliquid", "p".repeat(40), s)).toBe(false);
    expect(s.getItem("pd.paper.hyperliquid")).toBeNull();
  });

  it("clears only rebuildable caches, and at start only when near full", () => {
    const items = {
      "pd.icons.aster": "i".repeat(10),
      "pd.cache.markets": "c".repeat(10),
      "pd.candles.bybit:BTC": "k".repeat(10),
      "pd.rsi.bybit": "r".repeat(10),
      "pd.paper.aster": "p".repeat(10),
      "pd.oi.aster": "o".repeat(10),
      "pd.liquidations.bybit": "l".repeat(10),
    };
    const roomy = fullStore(10_000_000, items);
    trimStorage(roomy);
    expect(roomy.map.size).toBe(7);
    const s = fullStore(10_000_000, items);
    expect(makeRoom(s)).toBeGreaterThan(0);
    expect([...s.map.keys()].sort()).toEqual([
      "pd.liquidations.bybit",
      "pd.oi.aster",
      "pd.paper.aster",
    ]);
    expect(storedChars(s)).toBeLessThan(storedChars(fullStore(10_000_000, items)));
  });
});
