import { describe, expect, it, vi } from "vitest";
import type { TraderMove } from "../src/api/venueClient";

const stored = new Map<string, string>();
vi.stubGlobal("localStorage", {
  getItem: (k: string) => stored.get(k) ?? null,
  setItem: (k: string, v: string) => void stored.set(k, v),
  removeItem: (k: string) => void stored.delete(k),
});

const { clearActivity, currentActivity, recordMove } = await import("../src/lib/traders");

const move = (at: number): TraderMove => ({
  source: "hyperliquid",
  id: "0x0000000000000000000000000000000000000001",
  at,
  alert: true,
  change: {
    market: "BTC",
    kind: "open",
    side: "long",
    sizeBefore: 0,
    sizeAfter: 1,
    price: 1,
    value: 1,
  },
});

describe("clearing the activity", () => {
  it("deletes it from storage and from memory", () => {
    const now = Date.now();
    recordMove(move(now - 2000));
    recordMove(move(now - 1000));
    expect(currentActivity()).toHaveLength(2);
    expect(stored.has("pd.traders.activity")).toBe(true);
    clearActivity();
    expect(stored.has("pd.traders.activity")).toBe(false);
    expect(currentActivity()).toEqual([]);
    // A move after it starts a new log.
    recordMove(move(now));
    expect(currentActivity()).toHaveLength(1);
  });
});
