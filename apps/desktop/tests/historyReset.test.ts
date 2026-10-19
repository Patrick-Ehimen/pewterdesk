import { describe, expect, it } from "vitest";
import { loadHistoryReset, saveHistoryReset, sinceReset } from "../src/lib/historyReset";

const memory = () => {
  const items = new Map<string, string>();
  return {
    getItem: (k: string) => items.get(k) ?? null,
    setItem: (k: string, v: string) => void items.set(k, v),
    removeItem: (k: string) => void items.delete(k),
  };
};

describe("history reset", () => {
  it("is kept per account, and can be undone", () => {
    const store = memory();
    expect(loadHistoryReset("bybit:demo:1", store)).toBeUndefined();
    saveHistoryReset("bybit:demo:1", 1_000, store);
    expect(loadHistoryReset("bybit:demo:1", store)).toBe(1_000);
    expect(loadHistoryReset("bybit:demo:2", store)).toBeUndefined();
    saveHistoryReset("bybit:demo:1", undefined, store);
    expect(loadHistoryReset("bybit:demo:1", store)).toBeUndefined();
  });

  it("ignores what isn't a time", () => {
    const store = memory();
    store.setItem("pd.portfolio.resetAt.a", "soon");
    expect(loadHistoryReset("a", store)).toBeUndefined();
  });

  it("keeps only the closes after the reset", () => {
    const trades = [{ time: 500 }, { time: 1_000 }, { time: 1_500 }];
    expect(sinceReset(trades, 1_000)).toEqual([{ time: 1_500 }]);
    expect(sinceReset(trades)).toHaveLength(3);
  });
});
