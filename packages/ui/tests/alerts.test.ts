import type { MarketSummary } from "@pewterdesk/core";
import { describe, expect, it } from "vitest";
import {
  ALERT_COOLDOWN_MS,
  canFire,
  crossed,
  distanceToFire,
  type MarketAlert,
  sortAlerts,
  watchedValue,
} from "../src/lib/alerts";

const summary = (mark: string, prev: string, funding = "0.0001"): MarketSummary => ({
  market: "HYPE",
  markPrice: mark,
  prevDayPrice: prev,
  dayVolume: "0",
  openInterest: "0",
  fundingRate: funding,
  fundingIntervalSecs: 3600,
});

const alert = (over: Partial<MarketAlert> = {}): MarketAlert => ({
  id: "a",
  kind: "price",
  venue: "hyperliquid",
  market: "HYPE",
  symbol: "HYPE",
  condition: "above",
  value: 40,
  repeat: "once",
  notify: ["app"],
  active: true,
  createdAt: 0,
  ...over,
});

describe("alerts", () => {
  it("reads the watched value for each kind", () => {
    const s = summary("110", "100", "0.0002");
    expect(watchedValue("price", s)).toBe(110);
    expect(watchedValue("move", s)).toBeCloseTo(10);
    expect(watchedValue("funding", s)).toBeCloseTo(0.02);
    expect(watchedValue("move", summary("110", "0"))).toBeUndefined();
    expect(watchedValue("price", undefined)).toBeUndefined();
  });

  it("measures price distance as a fraction, the rest in points", () => {
    expect(distanceToFire(alert({ value: 40 }), 38.398)).toBeCloseTo(0.0417, 3);
    expect(distanceToFire(alert({ condition: "below", value: 36.5 }), 38.398)).toBeCloseTo(
      0.0494,
      3,
    );
    expect(distanceToFire(alert({ kind: "move", value: 5 }), 2)).toBe(3);
    expect(distanceToFire(alert(), undefined)).toBeUndefined();
  });

  it("fires only on a crossing, not on the first reading", () => {
    const up = alert({ value: 40 });
    expect(crossed(up, 39.9, 40)).toBe(true);
    expect(crossed(up, 40.1, 40.2)).toBe(false);
    expect(crossed(up, undefined, 41)).toBe(false);
    const down = alert({ condition: "below", value: 36.5 });
    expect(crossed(down, 36.6, 36.4)).toBe(true);
    expect(crossed(down, 36.4, 36.3)).toBe(false);
  });

  it("holds a repeating alert through its cooldown", () => {
    const a = alert({ repeat: "every", firedAt: 1000 });
    expect(canFire(a, 1000 + ALERT_COOLDOWN_MS - 1)).toBe(false);
    expect(canFire(a, 1000 + ALERT_COOLDOWN_MS)).toBe(true);
    expect(canFire(alert({ active: false }), 0)).toBe(false);
  });

  it("sorts active alerts by closeness, paused ones last", () => {
    const near = alert({ id: "near", value: 39 });
    const far = alert({ id: "far", value: 60 });
    const unknown = alert({ id: "unknown", market: "BTC" });
    const paused = alert({ id: "paused", active: false, value: 38.5 });
    const sorted = sortAlerts([paused, unknown, far, near], (a) =>
      a.market === "HYPE" ? 38.398 : undefined,
    );
    expect(sorted.map((a) => a.id)).toEqual(["near", "far", "unknown", "paused"]);
  });
});
