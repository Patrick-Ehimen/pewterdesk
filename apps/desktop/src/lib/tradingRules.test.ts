import { describe, expect, it } from "vitest";
import { DEFAULT_RULES, nextUtcMidnight, ruleChanges, type TradingRules } from "./tradingRules";

const base: TradingRules = DEFAULT_RULES;
const fields = (next: TradingRules) => ruleChanges(base, next);

describe("ruleChanges", () => {
  it("is empty when nothing changed", () => {
    expect(fields(base)).toEqual([]);
  });

  it("calls a bigger position limit looser, a smaller one not", () => {
    expect(fields({ ...base, position: { ...base.position, usd: 50_000 } })).toEqual([
      { field: "position", looser: true },
    ]);
    expect(fields({ ...base, position: { ...base.position, usd: 200 } })).toEqual([
      { field: "position", looser: false },
    ]);
  });

  it("keeps position size and leverage apart", () => {
    const next = { ...base, position: { usd: 200, leverage: 20 } };
    expect(fields(next)).toEqual([
      { field: "position", looser: false },
      { field: "leverage", looser: true },
    ]);
  });

  it("treats wider hours, a shorter cool-off and a weaker breach as looser", () => {
    expect(fields({ ...base, hours: { ...base.hours, days: "everyDay" } })[0]?.looser).toBe(true);
    expect(fields({ ...base, hours: { ...base.hours, from: "06:00" } })[0]?.looser).toBe(true);
    expect(fields({ ...base, hours: { ...base.hours, from: "08:00" } })[0]?.looser).toBe(false);
    expect(fields({ ...base, coolOff: { ...base.coolOff, minutes: 10 } })[0]?.looser).toBe(true);
    expect(fields({ ...base, breach: "warn" })[0]?.looser).toBe(true);
    expect(fields({ ...base, breach: "lock" })[0]?.looser).toBe(false);
  });

  it("starts over on a new account size", () => {
    const next = { ...base, challenge: { ...base.challenge, size: 2_000 } };
    expect(fields(next)).toEqual([{ field: "start", looser: true }]);
  });
});

describe("nextUtcMidnight", () => {
  it("is the start of the next UTC day", () => {
    const at = Date.UTC(2026, 10, 11, 17, 30);
    expect(nextUtcMidnight(at)).toBe(Date.UTC(2026, 10, 12));
  });
});
