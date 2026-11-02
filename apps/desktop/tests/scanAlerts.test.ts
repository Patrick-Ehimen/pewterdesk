import { describe, expect, it } from "vitest";
import { findScanAlert, parseScanAlerts, toggledScanAlert } from "../src/lib/scanAlerts";

const entry = { rule: "squeeze", venue: "bybit", market: "BTCUSDT", symbol: "BTC-USDT" } as const;

describe("scan alerts", () => {
  it("adds an alert, and takes it off the second time", () => {
    const on = toggledScanAlert([], { ...entry, id: "a" });
    expect(on).toHaveLength(1);
    expect(toggledScanAlert(on, entry)).toEqual([]);
  });

  it("keeps a market's alert apart from the starred one, and from other venues", () => {
    const on = toggledScanAlert([], { ...entry, id: "a" });
    expect(findScanAlert(on, "squeeze", "bybit", null)).toBeUndefined();
    expect(findScanAlert(on, "squeeze", "binance", "BTCUSDT")).toBeUndefined();
    expect(findScanAlert(on, "trend", "bybit", "BTCUSDT")).toBeUndefined();
    expect(findScanAlert(on, "squeeze", "bybit", "BTCUSDT")?.id).toBe("a");
  });

  it("reads back what it saved, and drops what doesn't read", () => {
    const raw = JSON.stringify([
      { id: "a", rule: "level", venue: "bybit", market: null },
      { id: "b", rule: "nonsense", venue: "bybit", market: null },
      "junk",
    ]);
    expect(parseScanAlerts(raw).map((a) => a.id)).toEqual(["a"]);
    expect(parseScanAlerts("not json")).toEqual([]);
    expect(parseScanAlerts(null)).toEqual([]);
  });
});
