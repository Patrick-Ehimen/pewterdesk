import { describe, expect, it } from "vitest";
import {
  amounts,
  DEFAULT_RULES,
  hoursNow,
  PRESET_TERMS,
  restoreRules,
  withPreset,
} from "../src/lib/tradingRules";

describe("trading rules", () => {
  it("restores what reads and defaults the rest", () => {
    expect(restoreRules(null)).toEqual(DEFAULT_RULES);
    const rules = restoreRules({
      preset: "classic",
      breach: "explode",
      challenge: { size: "big", maxPct: 400, maxKind: "eod", dailyPct: 4 },
      position: { usd: 5000, leverage: -3 },
      hours: { days: "everyDay", from: "25:00", to: "18:30" },
      tilt: { revenge: { on: false, minutes: 12, mode: "warn" }, sizeCreep: { factor: 2 } },
    });
    expect(rules.preset).toBe("classic");
    expect(rules.breach).toBe(DEFAULT_RULES.breach);
    expect(rules.challenge).toMatchObject({
      size: DEFAULT_RULES.challenge.size,
      maxPct: DEFAULT_RULES.challenge.maxPct,
      maxKind: "eod",
      dailyPct: 4,
    });
    expect(rules.position).toEqual({ usd: 5000, leverage: DEFAULT_RULES.position.leverage });
    expect(rules.hours).toEqual({ days: "everyDay", from: DEFAULT_RULES.hours.from, to: "18:30" });
    expect(rules.tilt.revenge).toEqual({ on: false, minutes: 12, mode: "warn" });
    expect(rules.tilt.sizeCreep).toEqual({ on: true, factor: 2 });
  });

  it("starts over from a preset, keeping the account size and the limits", () => {
    const mine = { ...DEFAULT_RULES, challenge: { ...DEFAULT_RULES.challenge, size: 50_000 } };
    const classic = withPreset({ ...mine, tradesPerDay: 4 }, "classic");
    expect(classic.challenge).toEqual({ size: 50_000, ...PRESET_TERMS.classic });
    expect(classic.tradesPerDay).toBe(4);
    expect(amounts(classic)).toEqual({ target: 4000, daily: 2500, max: 5000, tradeLoss: 500 });
  });

  it("knows whether the trading hours are open, and for how long", () => {
    const hours = { days: "weekdays", from: "07:00", to: "20:00" } as const;
    // Wednesday 12:04 UTC: open, 7h 56m left.
    expect(hoursNow(hours, new Date("2026-10-07T12:04:00Z"))).toEqual({ open: true, minutes: 476 });
    // Friday 21:00: closed until Monday 07:00.
    expect(hoursNow(hours, new Date("2026-10-09T21:00:00Z"))).toEqual({
      open: false,
      minutes: 58 * 60,
    });
    // Every day, over midnight: 22:00 to 06:00.
    const night = { days: "everyDay", from: "22:00", to: "06:00" } as const;
    expect(hoursNow(night, new Date("2026-10-10T23:30:00Z"))).toEqual({ open: true, minutes: 390 });
    expect(hoursNow(night, new Date("2026-10-10T12:00:00Z"))).toEqual({
      open: false,
      minutes: 600,
    });
    // Weekdays over midnight: Friday's window runs into Saturday morning.
    const late = { days: "weekdays", from: "22:00", to: "06:00" } as const;
    expect(hoursNow(late, new Date("2026-10-10T03:00:00Z")).open).toBe(true);
    expect(hoursNow(late, new Date("2026-10-10T23:00:00Z")).open).toBe(false);
    expect(hoursNow({ ...hours, to: "07:00" }, new Date("2026-10-07T12:00:00Z"))).toEqual({
      open: false,
      minutes: undefined,
    });
  });
});
