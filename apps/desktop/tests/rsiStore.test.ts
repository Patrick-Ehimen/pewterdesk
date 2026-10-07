import { beforeEach, describe, expect, it, vi } from "vitest";

const candles = vi.fn();
vi.mock("../src/api/venueClient", () => ({
  venueClient: { candles: (...a: unknown[]) => candles(...a) },
}));

const store = new Map<string, string>();
vi.stubGlobal("localStorage", {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => void store.set(k, v),
});

/** 50 closes that trend, so RSI(14) has a value. */
const series = (up: boolean) =>
  Array.from({ length: 50 }, (_, i) => ({
    openTime: i,
    open: "1",
    high: "1",
    low: "1",
    close: String(100 + (up ? i : -i) + (i % 3 === 0 ? (up ? -2 : 2) : 0)),
    volume: "1",
  }));

async function settled(venue: "bybit", frame: "4h" | "1h") {
  const { rsiState } = await import("../src/lib/rsiStore");
  await vi.waitFor(() => expect(rsiState(venue, frame).loading).toBe(false));
  return rsiState(venue, frame);
}

describe("RSI store", () => {
  beforeEach(() => {
    vi.resetModules();
    store.clear();
    candles.mockReset();
  });

  it("reads every market once, keeps it, and doesn't read again while fresh", async () => {
    candles.mockImplementation(async (_v: string, market: string) =>
      market === "NEW" ? [] : series(market === "UP"),
    );
    const { loadRsi } = await import("../src/lib/rsiStore");
    loadRsi("bybit", "4h", ["UP", "DOWN", "NEW"]);
    const state = await settled("bybit", "4h");
    expect(state.values.get("UP")?.value).toBeGreaterThan(50);
    expect(state.values.get("DOWN")?.value).toBeLessThan(50);
    expect(state.values.has("NEW")).toBe(false);
    expect(candles).toHaveBeenCalledTimes(3);
    // Coming back: nothing to load, the market with no history included.
    loadRsi("bybit", "4h", ["UP", "DOWN", "NEW"]);
    expect((await settled("bybit", "4h")).values.size).toBe(2);
    expect(candles).toHaveBeenCalledTimes(3);
    // Asked for outright, it reads them all again.
    loadRsi("bybit", "4h", ["UP", "DOWN", "NEW"], true);
    await settled("bybit", "4h");
    expect(candles).toHaveBeenCalledTimes(6);
  });

  it("comes back from storage after a reload, and only fills the gaps", async () => {
    candles.mockImplementation(async () => series(true));
    let mod = await import("../src/lib/rsiStore");
    mod.loadRsi("bybit", "1h", ["A", "B"]);
    await settled("bybit", "1h");
    expect(candles).toHaveBeenCalledTimes(2);
    // A reload: a new module, the same storage.
    vi.resetModules();
    mod = await import("../src/lib/rsiStore");
    expect(mod.rsiState("bybit", "1h").values.size).toBe(2);
    mod.loadRsi("bybit", "1h", ["A", "B", "C"]);
    const state = await settled("bybit", "1h");
    expect(state.values.size).toBe(3);
    expect(candles).toHaveBeenCalledTimes(3);
    expect(candles.mock.calls.at(-1)?.[1]).toBe("C");
  });

  it("remembers the columns' order per venue", async () => {
    const { loadRsiOrder, saveRsiOrder } = await import("../src/lib/rsiStore");
    expect(loadRsiOrder("bybit")).toBeUndefined();
    saveRsiOrder("bybit", ["BTCUSDT", "ETHUSDT"]);
    expect(loadRsiOrder("bybit")).toEqual(["BTCUSDT", "ETHUSDT"]);
  });
});
