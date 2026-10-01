import { beforeEach, describe, expect, it } from "vitest";
import {
  flushIcons,
  ICON_MAX_AGE_MS,
  MAX_ICON_CHARS,
  peekIcon,
  rememberIcon,
  resetIconCache,
  STORE_VERSION,
} from "../src/lib/iconCache";

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

describe("icon cache", () => {
  beforeEach(resetIconCache);

  it("keeps logos, and markets without one, across a restart", () => {
    const store = memoryStore();
    rememberIcon("aster", "BTCUSDT", "<svg>btc</svg>", 0, store);
    rememberIcon("aster", "PUMPBTCUSDT", undefined, 0, store);
    flushIcons(store);
    resetIconCache(); // a new session
    expect(peekIcon("aster", "BTCUSDT", 1, store)).toBe("<svg>btc</svg>");
    expect(peekIcon("aster", "PUMPBTCUSDT", 1, store)).toBeNull();
    expect(peekIcon("aster", "ETHUSDT", 1, store)).toBeUndefined();
    // Venues are kept apart: ids repeat across them.
    expect(peekIcon("hyperliquid", "BTCUSDT", 1, store)).toBeUndefined();
  });

  it("starts over once the saved set is a week old", () => {
    const store = memoryStore();
    rememberIcon("aster", "BTCUSDT", "<svg/>", 0, store);
    flushIcons(store);
    resetIconCache();
    expect(peekIcon("aster", "BTCUSDT", ICON_MAX_AGE_MS + 1, store)).toBeUndefined();
  });

  it("skips logos too big to keep", () => {
    const store = memoryStore();
    rememberIcon("aster", "BIG", "x".repeat(MAX_ICON_CHARS + 1), 0, store);
    flushIcons(store);
    resetIconCache();
    expect(peekIcon("aster", "BIG", 1, store)).toBeUndefined();
  });

  it("merges with what another window saved rather than dropping it", () => {
    const store = memoryStore();
    rememberIcon("aster", "BTCUSDT", "<svg>btc</svg>", 0, store);
    flushIcons(store);
    // The other window started earlier, never saw BTC, and saves ETH.
    resetIconCache();
    store.items.set(
      "pd.icons.aster",
      JSON.stringify({ version: STORE_VERSION, savedAt: 0, icons: { BTCUSDT: "<svg>btc</svg>" } }),
    );
    rememberIcon("aster", "ETHUSDT", "<svg>eth</svg>", 0, memoryStore());
    flushIcons(store);
    resetIconCache();
    expect(peekIcon("aster", "BTCUSDT", 1, store)).toBe("<svg>btc</svg>");
    expect(peekIcon("aster", "ETHUSDT", 1, store)).toBe("<svg>eth</svg>");
  });

  it("ignores anything unreadable", () => {
    const store = memoryStore();
    store.items.set("pd.icons.aster", "{not json");
    expect(peekIcon("aster", "BTCUSDT", 0, store)).toBeUndefined();
    resetIconCache();
    store.items.set(
      "pd.icons.aster",
      JSON.stringify({ version: STORE_VERSION, savedAt: 0, icons: { A: 3 } }),
    );
    expect(peekIcon("aster", "A", 0, store)).toBeUndefined();
  });

  it("drops what an older version saved", () => {
    // Version 1 saved "no logo" for every Bybit market; that mustn't stick.
    const store = memoryStore();
    store.items.set("pd.icons.bybit", JSON.stringify({ savedAt: 0, icons: { BTCUSDT: null } }));
    expect(peekIcon("bybit", "BTCUSDT", 1, store)).toBeUndefined();
  });
});
