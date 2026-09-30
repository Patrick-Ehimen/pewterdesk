import type { MarketAlert } from "@pewterdesk/ui";
import { describe, expect, it } from "vitest";
import { loadAlerts, saveAlerts } from "../src/lib/alerts";

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

const alert: MarketAlert = {
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
  createdAt: 1,
};

describe("alert storage", () => {
  it("round-trips the alerts", () => {
    const store = memoryStore();
    saveAlerts({ alerts: [alert], fired: [], paused: true, seenAt: 5 }, store);
    expect(loadAlerts(store)).toEqual({ alerts: [alert], fired: [], paused: true, seenAt: 5 });
  });

  it("drops what it can't read, and keeps the rest", () => {
    const store = memoryStore();
    store.items.set(
      "pd.alerts",
      JSON.stringify({
        alerts: [alert, { ...alert, id: "b", venue: "nowhere" }, { nope: 1 }],
        fired: "not a list",
      }),
    );
    const loaded = loadAlerts(store);
    expect(loaded.alerts.map((a) => a.id)).toEqual(["a"]);
    expect(loaded.fired).toEqual([]);
    expect(loaded.paused).toBe(false);
    store.items.set("pd.alerts", "{not json");
    expect(loadAlerts(store).alerts).toEqual([]);
  });
});
