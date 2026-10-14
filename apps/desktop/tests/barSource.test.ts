import type { Candle } from "@pewterdesk/core";
import { describe, expect, it, vi } from "vitest";

vi.mock("../src/api/venueClient", () => ({ venueClient: {} }));
const { SessionCandles } = await import("../src/lib/barSource");

const candle = (openTime: number, close = "1"): Candle => ({
  openTime,
  open: "1",
  high: "1",
  low: "1",
  close,
  volume: "1",
});
const times = (series: Candle[] | undefined) => series?.map((c) => c.openTime);

describe("SessionCandles", () => {
  it("joins newer candles on, the forming one replaced", () => {
    const kept = new SessionCandles();
    kept.merge("a", [candle(1), candle(2)]);
    kept.merge("a", [candle(2, "5"), candle(3)]);
    expect(times(kept.get("a"))).toEqual([1, 2, 3]);
    expect(kept.get("a")?.[1]?.close).toBe("5");
  });

  it("puts an older page before what it holds, and none for a series it doesn't", () => {
    const kept = new SessionCandles();
    kept.prepend("a", [candle(1)]);
    expect(kept.get("a")).toBeUndefined();
    kept.merge("a", [candle(3), candle(4)]);
    kept.prepend("a", [candle(1), candle(2), candle(3)]);
    expect(times(kept.get("a"))).toEqual([1, 2, 3, 4]);
  });

  it("lets the least recently used series go past its limit", () => {
    const kept = new SessionCandles(2);
    kept.merge("a", [candle(1)]);
    kept.merge("b", [candle(1)]);
    kept.get("a");
    kept.merge("c", [candle(1)]);
    expect(kept.get("b")).toBeUndefined();
    expect(kept.get("a")).toBeDefined();
    expect(kept.get("c")).toBeDefined();
  });
});
