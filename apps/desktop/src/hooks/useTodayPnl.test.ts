import type { ClosedTrade, Position } from "@pewterdesk/core";
import { describe, expect, it } from "vitest";
import { DAY_MS, realizedToday, todayPnl } from "./useTodayPnl";

const closed = (time: number, pnl: string) => ({ time, closedPnl: pnl }) as ClosedTrade;
const position = (upnl: string) => ({ unrealizedPnl: upnl }) as Position;

describe("today's PnL", () => {
  const midnight = 20_000 * DAY_MS;
  const now = midnight + 13 * 3_600_000;

  it("counts only what closed since 00:00 UTC", () => {
    const trades = [closed(midnight + 1000, "16.14"), closed(midnight - 1000, "-50")];
    expect(realizedToday(trades, now)).toBeCloseTo(16.14);
    expect(realizedToday(undefined, now)).toBeUndefined();
  });

  it("adds what's open, and is the open PnL alone until today's trades are read", () => {
    expect(todayPnl([position("2.5")], 16.14)).toBeCloseTo(18.64);
    expect(todayPnl([], 16.14)).toBeCloseTo(16.14);
    expect(todayPnl([position("2.5")], undefined)).toBeCloseTo(2.5);
  });
});
