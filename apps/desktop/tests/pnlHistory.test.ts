import { describe, expect, it } from "vitest";
import {
  allTimePnl,
  EMPTY_HISTORY,
  loadPnlHistory,
  MAX_POINTS,
  recordPnl,
  resetPnl,
  SAMPLE_MS,
  savePnlHistory,
} from "../src/lib/pnlHistory";

const store = () => {
  const items = new Map<string, string>();
  return {
    getItem: (k: string) => items.get(k) ?? null,
    setItem: (k: string, v: string) => void items.set(k, v),
  };
};

describe("PnL history", () => {
  it("adds realised and open PnL", () => {
    expect(allTimePnl(-120.5, 20)).toBe(-100.5);
    expect(allTimePnl(undefined, 7)).toBe(7);
  });

  it("samples at most once a minute, updating the latest in between", () => {
    let h = recordPnl(EMPTY_HISTORY, 0, 10);
    h = recordPnl(h, SAMPLE_MS, 12);
    h = recordPnl(h, SAMPLE_MS + 5_000, 13);
    expect(h.points).toEqual([
      [0, 10],
      [SAMPLE_MS + 5_000, 13],
    ]);
    h = recordPnl(h, 3 * SAMPLE_MS, 9);
    expect(h.points).toHaveLength(3);
  });

  it("measures from the last reset", () => {
    let h = resetPnl(1_000, 250);
    expect(h.points).toEqual([[1_000, 0]]);
    h = recordPnl(h, 1_000 + SAMPLE_MS, 240);
    expect(h.points.at(-1)).toEqual([1_000 + SAMPLE_MS, -10]);
    expect(h.resetAt).toBe(1_000);
  });

  it("thins old samples instead of growing without end", () => {
    let h = EMPTY_HISTORY;
    for (let i = 0; i <= MAX_POINTS; i++) h = recordPnl(h, i * SAMPLE_MS, i);
    expect(h.points.length).toBeLessThan(MAX_POINTS);
    expect(h.points.at(-1)).toEqual([MAX_POINTS * SAMPLE_MS, MAX_POINTS]);
  });

  it("round-trips per account and drops bad data", () => {
    const s = store();
    savePnlHistory("bybit:1", resetPnl(5, 42), s);
    expect(loadPnlHistory("bybit:1", s)).toEqual({ baseline: 42, resetAt: 5, points: [[5, 0]] });
    expect(loadPnlHistory("bybit:2", s)).toEqual(EMPTY_HISTORY);
    s.setItem("pd.pnlHistory.bad", JSON.stringify({ baseline: "x", points: [[1], [2, 3]] }));
    expect(loadPnlHistory("bad", s)).toEqual({ baseline: 0, resetAt: undefined, points: [[2, 3]] });
  });
});
