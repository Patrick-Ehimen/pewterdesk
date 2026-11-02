import type { MarketAlert } from "@pewterdesk/ui";
import { describe, expect, it } from "vitest";
import type { AlertsState } from "../src/lib/alerts";
import { applyAway, toWatched } from "../src/lib/daemonAlerts";

const alert = (over: Partial<MarketAlert> = {}): MarketAlert => ({
  id: "a1",
  kind: "price",
  venue: "binance",
  market: "BTCUSDT",
  symbol: "BTC",
  condition: "above",
  value: 100_000,
  repeat: "once",
  notify: ["app", "sound"],
  active: true,
  createdAt: 1,
  ...over,
});

const state = (alerts: MarketAlert[]): AlertsState => ({
  alerts,
  fired: [],
  paused: false,
  seenAt: 0,
});

describe("toWatched", () => {
  it("hands over market alerts only, with their words and sound", () => {
    const watched = toWatched([
      alert(),
      alert({ id: "p", kind: "pnl" }),
      alert({ id: "l", kind: "liq" }),
    ]);
    expect(watched.map((w) => w.id)).toEqual(["a1"]);
    expect(watched[0]).toMatchObject({ repeat: false, sound: true, active: true });
    expect(watched[0]?.text).toContain("BTC");
  });
});

describe("applyAway", () => {
  it("records what fired, and turns off an alert that fires once", () => {
    const next = applyAway(
      state([alert()]),
      [{ alertId: "a1", actual: 100_050, time: 9 }],
      () => "f1",
    );
    expect(next.fired).toEqual([
      expect.objectContaining({
        id: "f1",
        alertId: "a1",
        actual: 100_050,
        time: 9,
        notify: ["app"],
      }),
    ]);
    expect(next.alerts[0]).toMatchObject({ active: false, firedAt: 9 });
  });

  it("keeps a repeating alert on, at its latest firing", () => {
    const firings = [
      { alertId: "a1", actual: 1, time: 5 },
      { alertId: "a1", actual: 2, time: 7 },
    ];
    const next = applyAway(state([alert({ repeat: "every" })]), firings);
    expect(next.alerts[0]).toMatchObject({ active: true, firedAt: 7 });
    expect(next.fired.map((f) => f.time)).toEqual([7, 5]);
  });

  it("ignores firings of alerts since deleted", () => {
    const before = state([alert()]);
    expect(applyAway(before, [{ alertId: "gone", actual: 1, time: 1 }])).toBe(before);
  });
});
