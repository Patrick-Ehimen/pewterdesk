import { describe, expect, it } from "vitest";
import { allocation, intentIssues, limitsFrom } from "./dayIntent";
import { newDay, newPlan } from "./journal";
import type { RulesView } from "./tradingRules";

const rules = {
  on: true,
  rules: {
    tradeLoss: { pct: 1, mode: "stop" },
    challenge: { dailyPct: 4 },
    tradesPerDay: 4,
    news: { on: false },
    coolOff: { losses: 0 },
  },
} as unknown as RulesView;

const day = (patch: Partial<ReturnType<typeof newDay>>) => ({ ...newDay(), ...patch });

describe("the day's intent against the limits", () => {
  it("takes the trading rules where they're on, else the plan's", () => {
    expect(limitsFrom(rules, undefined).daily).toEqual({ value: 4, from: "rules" });
    const plan = {
      ...newPlan(),
      riskPct: 0.5,
      dailyStop: 500,
      startBalance: 50_000,
      maxTradesPerDay: 3,
    };
    const l = limitsFrom(undefined, plan);
    expect(l.perTrade).toEqual({ value: 0.5, from: "plan" });
    expect(l.daily?.value).toBeCloseTo(1);
    expect(l.tradesPerDay).toEqual({ value: 3, from: "plan" });
  });

  it("caps the day at the daily loss limit when no cap is set", () => {
    const d = day({ markets: { BTC: { bias: "long", note: "", levels: "", riskPct: 1.5 } } });
    const a = allocation(d, limitsFrom(rules, undefined));
    expect(a.cap).toBe(4);
    expect(a.remaining).toBe(2.5);
  });

  it("warns past every limit, and not within them", () => {
    const l = limitsFrom(rules, undefined);
    const ok = day({
      intent: { riskCap: 3, maxTrades: 3 },
      markets: {
        BTC: { bias: "long", note: "", levels: "", riskPct: 2, maxTrades: 2 },
        ETH: { bias: "short", note: "", levels: "", riskPct: 1, maxTrades: 1 },
      },
    });
    expect(intentIssues(ok, l)).toEqual([]);
    const bad = day({
      intent: { riskCap: 5, maxTrades: 6 },
      markets: {
        BTC: { bias: "long", note: "", levels: "", riskPct: 4, maxTrades: 2 },
        ETH: { bias: "short", note: "", levels: "", riskPct: 2, maxTrades: 5 },
      },
    });
    expect(intentIssues(bad, l).map((i) => i.kind)).toEqual([
      "capOverDaily",
      "tradesOverRule",
      "overCap",
      "tradesOverDay",
      "perTrade",
    ]);
  });
});
