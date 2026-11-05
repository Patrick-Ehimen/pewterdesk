import type { JournalDay, Plan } from "./journal";
import type { RulesView } from "./tradingRules";

// The day's pre-market intent against the trader's own limits: the trading
// rules where they're on (what Rust enforces before an order is sent), the
// plan's where they're not. It only ever reads and warns; the router's
// trading gate is what refuses an order.

export type LimitSource = "rules" | "plan";

export interface Limits {
  /** The most one trade may risk, % of the account. */
  perTrade?: { value: number; from: LimitSource };
  /** The most a day may lose, % of the account. */
  daily?: { value: number; from: LimitSource };
  tradesPerDay?: { value: number; from: LimitSource };
}

export function limitsFrom(rules: RulesView | undefined, plan: Plan | undefined): Limits {
  const on = rules?.on ? rules.rules : undefined;
  const out: Limits = {};
  if (on) out.perTrade = { value: on.tradeLoss.pct, from: "rules" };
  else if (plan?.riskPct) out.perTrade = { value: plan.riskPct, from: "plan" };
  if (on) out.daily = { value: on.challenge.dailyPct, from: "rules" };
  else if (plan?.dailyStop && plan.startBalance)
    out.daily = { value: (plan.dailyStop / plan.startBalance) * 100, from: "plan" };
  if (on) out.tradesPerDay = { value: on.tradesPerDay, from: "rules" };
  else if (plan?.maxTradesPerDay) out.tradesPerDay = { value: plan.maxTradesPerDay, from: "plan" };
  return out;
}

export interface Allocation {
  /** The day's cap, as set or, unset, the daily loss limit. */
  cap?: number;
  /** Each market's share, in the order they were added. */
  markets: { market: string; risk?: number }[];
  allocated: number;
  remaining?: number;
  maxTrades?: number;
  plannedTrades: number;
}

export function allocation(day: JournalDay, limits: Limits): Allocation {
  const markets = Object.entries(day.markets).map(([market, m]) => ({ market, risk: m.riskPct }));
  const allocated = markets.reduce((s, m) => s + (m.risk ?? 0), 0);
  const cap = day.intent.riskCap ?? limits.daily?.value;
  return {
    cap,
    markets,
    allocated,
    remaining: cap === undefined ? undefined : cap - allocated,
    maxTrades: day.intent.maxTrades ?? limits.tradesPerDay?.value,
    plannedTrades: Object.values(day.markets).reduce((s, m) => s + (m.maxTrades ?? 0), 0),
  };
}

export type Issue =
  | { kind: "capOverDaily"; cap: number; limit: number; from: LimitSource }
  | { kind: "tradesOverRule"; trades: number; limit: number; from: LimitSource }
  | { kind: "overCap"; allocated: number; cap: number }
  | { kind: "tradesOverDay"; planned: number; max: number }
  | { kind: "perTrade"; market: string; risk: number; limit: number; from: LimitSource };

const over = (a: number, b: number) => a - b > 1e-9;

/** Where the intent goes past a limit, most serious first. */
export function intentIssues(day: JournalDay, limits: Limits): Issue[] {
  const out: Issue[] = [];
  const a = allocation(day, limits);
  const { daily, tradesPerDay, perTrade } = limits;
  if (day.intent.riskCap !== undefined && daily && over(day.intent.riskCap, daily.value))
    out.push({
      kind: "capOverDaily",
      cap: day.intent.riskCap,
      limit: daily.value,
      from: daily.from,
    });
  if (
    day.intent.maxTrades !== undefined &&
    tradesPerDay &&
    day.intent.maxTrades > tradesPerDay.value
  )
    out.push({
      kind: "tradesOverRule",
      trades: day.intent.maxTrades,
      limit: tradesPerDay.value,
      from: tradesPerDay.from,
    });
  if (a.cap !== undefined && over(a.allocated, a.cap))
    out.push({ kind: "overCap", allocated: a.allocated, cap: a.cap });
  if (a.maxTrades !== undefined && a.plannedTrades > a.maxTrades)
    out.push({ kind: "tradesOverDay", planned: a.plannedTrades, max: a.maxTrades });
  if (perTrade)
    for (const [market, m] of Object.entries(day.markets)) {
      if (m.riskPct === undefined) continue;
      const each = m.riskPct / Math.max(1, m.maxTrades ?? 1);
      if (over(each, perTrade.value))
        out.push({
          kind: "perTrade",
          market,
          risk: each,
          limit: perTrade.value,
          from: perTrade.from,
        });
    }
  return out;
}

/** How many of the day's rules and limits are set, for the head's "armed" count. */
export function armedCount(limits: Limits, rules: RulesView | undefined): number {
  if (rules?.on) {
    const r = rules.rules;
    return 4 + (r.news.on ? 1 : 0) + (r.coolOff.losses > 0 ? 1 : 0);
  }
  return [limits.perTrade, limits.daily, limits.tradesPerDay].filter(Boolean).length;
}
