import type {
  CandleInterval,
  Cond,
  CustomParams,
  Group,
  Guards,
  Match,
  Rule,
  Sizing,
  Source,
  StopRule,
  StrategyConfig,
} from "@pewterdesk/core";

/**
 * The Backtest builder's rules strategy (the engine's `custom` template):
 * its defaults, the conditions offered to pick from, and the arithmetic the
 * builder shows beside the settings (a position's size, where it would be
 * liquidated, what a run of losses costs). Plain logic; nothing here runs
 * a backtest.
 */

export type Rules = { template: "custom" } & CustomParams;

/** Every setting a rules strategy has, filled in: what the builder edits. */
export interface FullRules extends Rules {
  entryMatch: Match;
  exitMatch: Match;
  guards: Guards;
  targets: NonNullable<CustomParams["targets"]>;
}

export const isRules = (c: StrategyConfig): c is Rules => c.template === "custom";

/** A rules strategy with what older ones left out filled in. */
export function fullRules(c: Rules): FullRules {
  return {
    ...c,
    entryMatch: c.entryMatch ?? "all",
    exitMatch: c.exitMatch ?? "any",
    guards: c.guards ?? {},
    targets: c.targets ?? [],
  };
}

const ema = (period: number, on?: CandleInterval): Source =>
  on ? { kind: "ema", period, on } : { kind: "ema", period };
const value = (v: number): Source => ({ kind: "value", value: v });
const rule = (left: Source, op: Rule["op"], right: Source, hours?: number): Rule =>
  hours === undefined ? { left, op, right } : { left, op, right, hours };

/** A new rules strategy: a trend rider, as the builder opens on. */
export function defaultRules(): FullRules {
  return {
    template: "custom",
    side: "long",
    entry: [rule(ema(9), "crossesAbove", ema(21))],
    entryMatch: "all",
    exit: [rule(ema(9), "crossesBelow", ema(21))],
    exitMatch: "any",
    stopLoss: 0,
    takeProfit: 0,
    size: 1,
    sizing: { kind: "risk", risk: 0.01 },
    maxLeverage: 3,
    margin: "isolated",
    stop: { kind: "atr", mult: 2, period: 14 },
    targets: [],
    guards: {},
  };
}

/** An EMA cross as rules, so its exits and size can be changed. */
export function emaAsRules(c: Extract<StrategyConfig, { template: "ema" }>): FullRules {
  return {
    ...defaultRules(),
    side: c.direction === "short" ? "short" : "long",
    entry: [
      rule(ema(c.fast), c.direction === "short" ? "crossesBelow" : "crossesAbove", ema(c.slow)),
    ],
    exit: [
      rule(ema(c.fast), c.direction === "short" ? "crossesAbove" : "crossesBelow", ema(c.slow)),
    ],
    sizing: { kind: "risk", risk: c.risk },
    maxLeverage: c.maxLeverage,
    stop: { kind: "atr", mult: c.stopAtr, period: 14 },
  };
}

export const isGroup = (c: Cond): c is Group => "conds" in c;

/** The rules a condition holds: itself, or a group's. */
export const rulesOf = (c: Cond): Rule[] => (isGroup(c) ? c.conds : [c]);

// --- Sources and comparisons ----------------------------------------------

export const SOURCE_KINDS = [
  "price",
  "ema",
  "sma",
  "rsi",
  "value",
  "volume",
  "volumeAvg",
  "funding",
  "openInterest",
  "heldHours",
] as const satisfies readonly Source["kind"][];

/** The longer candles an average or RSI can be read on. */
export const FRAMES = ["1h", "4h", "1d"] as const satisfies readonly CandleInterval[];

/** A source of `kind`, with sensible first settings. */
export function sourceOf(kind: Source["kind"], was?: Source): Source {
  const period = was && "period" in was ? was.period : undefined;
  switch (kind) {
    case "ema":
    case "sma":
      return { kind, period: period ?? 50 };
    case "rsi":
      return { kind, period: period ?? 14 };
    case "volumeAvg":
      return { kind, period: period ?? 20 };
    case "value":
      return { kind, value: was?.kind === "value" ? was.value : 0 };
    default:
      return { kind };
  }
}

export const OPS = [
  "crossesAbove",
  "crossesBelow",
  "above",
  "below",
  "risesMoreThan",
  "fallsMoreThan",
] as const satisfies readonly Rule["op"][];

/** A rise or fall compares a change with a share; the rest compare two values. */
export const isChange = (op: Rule["op"]) => op === "risesMoreThan" || op === "fallsMoreThan";

/**
 * How a number on the right of `rule` is shown and typed: funding and a
 * rise or fall as percentages, time in trade in hours, the rest as is.
 */
export function valueUnit(r: Rule): "pct" | "hours" | "plain" {
  if (isChange(r.op)) return "pct";
  if (r.left.kind === "funding") return "pct";
  if (r.left.kind === "heldHours") return "hours";
  return "plain";
}

// --- What there is to pick from --------------------------------------------

export const CATEGORIES = ["trend", "momentum", "volume", "derivatives", "price", "time"] as const;
export type Category = (typeof CATEGORIES)[number];

export interface Preset {
  /** A message key's last part: `bt.cond.<key>`. */
  key: string;
  category: Category;
  rule: Rule;
  /** Only makes sense as an exit (time in trade). */
  exitOnly?: boolean;
}

const sma = (period: number): Source => ({ kind: "sma", period });
const rsi = (period: number, on?: CandleInterval): Source =>
  on ? { kind: "rsi", period, on } : { kind: "rsi", period };
const price: Source = { kind: "price" };

/** Conditions to start from, by kind; each is then edited like any other. */
export const PRESETS: readonly Preset[] = [
  { key: "emaCrossUp", category: "trend", rule: rule(ema(9), "crossesAbove", ema(21)) },
  { key: "emaCrossDown", category: "trend", rule: rule(ema(9), "crossesBelow", ema(21)) },
  { key: "goldenCross", category: "trend", rule: rule(sma(50), "crossesAbove", sma(200)) },
  { key: "deathCross", category: "trend", rule: rule(sma(50), "crossesBelow", sma(200)) },
  { key: "aboveEma200", category: "trend", rule: rule(price, "above", ema(200)) },
  { key: "belowEma200", category: "trend", rule: rule(price, "below", ema(200)) },
  { key: "aboveDailyEma50", category: "trend", rule: rule(price, "above", ema(50, "1d")) },
  { key: "belowDailyEma50", category: "trend", rule: rule(price, "below", ema(50, "1d")) },
  { key: "fastOverSlow", category: "trend", rule: rule(ema(20), "above", ema(50)) },
  { key: "rsiUnder60", category: "momentum", rule: rule(rsi(14), "below", value(60)) },
  { key: "rsiOversold", category: "momentum", rule: rule(rsi(14), "below", value(30)) },
  { key: "rsiOverbought", category: "momentum", rule: rule(rsi(14), "above", value(70)) },
  { key: "rsiBackOver30", category: "momentum", rule: rule(rsi(14), "crossesAbove", value(30)) },
  { key: "rsiBackUnder70", category: "momentum", rule: rule(rsi(14), "crossesBelow", value(70)) },
  { key: "rsiOver50", category: "momentum", rule: rule(rsi(14), "above", value(50)) },
  { key: "dailyRsiOver50", category: "momentum", rule: rule(rsi(14, "1d"), "above", value(50)) },
  { key: "priceUp5", category: "momentum", rule: rule(price, "risesMoreThan", value(0.05), 24) },
  {
    key: "volumeOverAvg",
    category: "volume",
    rule: rule({ kind: "volume" }, "above", { kind: "volumeAvg", period: 20 }),
  },
  {
    key: "volumeUnderAvg",
    category: "volume",
    rule: rule({ kind: "volume" }, "below", { kind: "volumeAvg", period: 20 }),
  },
  {
    key: "volumeSpike",
    category: "volume",
    rule: rule({ kind: "volume" }, "risesMoreThan", value(1), 24),
  },
  {
    key: "volumeAvgRising",
    category: "volume",
    rule: rule({ kind: "volumeAvg", period: 20 }, "risesMoreThan", value(0.25), 24),
  },
  {
    key: "fundingUnder",
    category: "derivatives",
    rule: rule({ kind: "funding" }, "below", value(0.0003)),
  },
  {
    key: "fundingOver",
    category: "derivatives",
    rule: rule({ kind: "funding" }, "above", value(0.0005)),
  },
  {
    key: "fundingNegative",
    category: "derivatives",
    rule: rule({ kind: "funding" }, "below", value(0)),
  },
  {
    key: "oiRising",
    category: "derivatives",
    rule: rule({ kind: "openInterest" }, "risesMoreThan", value(0.05), 24),
  },
  {
    key: "oiFalling",
    category: "derivatives",
    rule: rule({ kind: "openInterest" }, "fallsMoreThan", value(0.08), 24),
  },
  {
    key: "fundingRising",
    category: "derivatives",
    rule: rule({ kind: "funding" }, "crossesAbove", value(0.0001)),
  },
  { key: "closeAboveEma50", category: "price", rule: rule(price, "above", ema(50)) },
  { key: "closeBelowEma50", category: "price", rule: rule(price, "below", ema(50)) },
  { key: "crossUpSma20", category: "price", rule: rule(price, "crossesAbove", sma(20)) },
  { key: "crossDownSma20", category: "price", rule: rule(price, "crossesBelow", sma(20)) },
  { key: "dropFast", category: "price", rule: rule(price, "fallsMoreThan", value(0.05), 24) },
  { key: "ripFast", category: "price", rule: rule(price, "risesMoreThan", value(0.08), 24) },
  { key: "closeAboveSma200", category: "price", rule: rule(price, "above", sma(200)) },
  {
    key: "heldDays",
    category: "time",
    exitOnly: true,
    rule: rule({ kind: "heldHours" }, "above", value(12 * 24)),
  },
  {
    key: "heldDay",
    category: "time",
    exitOnly: true,
    rule: rule({ kind: "heldHours" }, "above", value(24)),
  },
  {
    key: "heldHours",
    category: "time",
    exitOnly: true,
    rule: rule({ kind: "heldHours" }, "above", value(8)),
  },
];

/** The presets offered for an entry or an exit, by category. */
export function presetsFor(exit: boolean): Map<Category, Preset[]> {
  const out = new Map<Category, Preset[]>();
  for (const p of PRESETS) {
    if (p.exitOnly && !exit) continue;
    const list = out.get(p.category) ?? [];
    list.push(p);
    out.set(p.category, list);
  }
  return out;
}

// --- The risk arithmetic the builder shows ------------------------------

/** The maintenance margin, as the engine works liquidation out. */
export const MAINTENANCE = 0.005;

/** The stop's distance from `price`, as a fraction; undefined for none. */
export function stopDistance(c: FullRules, price: number, atr: number | undefined) {
  const s: StopRule | undefined = c.stop;
  if (!s) return c.stopLoss > 0 ? c.stopLoss : undefined;
  switch (s.kind) {
    case "fixed":
      return s.pct;
    case "atr":
      return atr && price > 0 ? (s.mult * atr) / price : undefined;
    case "swing":
      // Depends on the candles; a typical one: two ATRs.
      return atr && price > 0 ? (2 * atr) / price : undefined;
    case "none":
      return undefined;
  }
}

export interface SizePreview {
  notional: number;
  size: number;
  /** Notional over equity. */
  leverage: number;
  stopAt?: number;
  liquidation?: number;
  /** How much further the liquidation is than the stop. */
  further?: number;
}

/**
 * A trade's size and liquidation as the engine would work them out on
 * `equity`, at `price`, with `atr` the market's typical candle.
 */
export function sizePreview(
  c: FullRules,
  equity: number,
  price: number,
  atr: number | undefined,
): SizePreview | undefined {
  if (!(equity > 0 && price > 0)) return undefined;
  const dir = c.side === "long" ? 1 : -1;
  const dist = stopDistance(c, price, atr);
  const byRisk = (risk: number) => (dist && dist > 0 ? (equity * risk) / dist : undefined);
  const s: Sizing | undefined = c.sizing;
  let notional: number | undefined;
  if (!s) notional = equity * c.size;
  else if (s.kind === "fixed") notional = s.amount;
  else if (s.kind === "equity") notional = equity * s.share;
  else if (s.kind === "risk") notional = byRisk(s.risk);
  else if (s.kind === "volatility")
    notional = atr && atr > 0 ? (equity * s.target) / (atr / price) : undefined;
  else notional = byRisk(s.maxRisk / 2);
  if (notional === undefined || !Number.isFinite(notional)) return undefined;
  if (c.maxLeverage) notional = Math.min(notional, equity * c.maxLeverage);
  if (c.maxShare) notional = Math.min(notional, equity * c.maxShare * (c.maxLeverage ?? 1));
  const size = notional / price;
  const lev = c.maxLeverage ?? Math.max(1, notional / equity);
  const liquidation =
    c.margin === "cross"
      ? price - (dir * Math.max(0, equity - notional * MAINTENANCE)) / size
      : price * (1 - dir * (1 / lev - MAINTENANCE));
  const stopAt = dist === undefined ? undefined : price * (1 - dir * dist);
  const liq = liquidation > 0 && Number.isFinite(liquidation) ? liquidation : undefined;
  return {
    notional,
    size,
    leverage: notional / equity,
    stopAt,
    liquidation: liq,
    further:
      liq !== undefined && stopAt !== undefined && stopAt !== price
        ? Math.abs(price - liq) / Math.abs(price - stopAt)
        : undefined,
  };
}

/** What `n` losses in a row cost, each losing `risk` of what's left. */
export const streakCost = (risk: number, n: number) => (1 - risk) ** n - 1;

/** The share of equity a trade loses at its stop, as sized. */
export function riskShare(c: FullRules, price: number, atr: number | undefined): number {
  const p = sizePreview(c, 1, price, atr);
  const dist = stopDistance(c, price, atr);
  return p && dist ? p.notional * dist : 0;
}

/** Longest run of losing trades in a list of P&Ls. */
export function longestLosing(pnls: readonly number[]): number {
  let run = 0;
  let most = 0;
  for (const p of pnls) {
    run = p <= 0 ? run + 1 : 0;
    most = Math.max(most, run);
  }
  return most;
}

/** Wilder's ATR(14) at the last candle, for previews. */
export function lastAtr(
  bars: readonly { high: number; low: number; close: number }[],
  period = 14,
): number | undefined {
  if (bars.length < period + 1) return undefined;
  let atr: number | undefined;
  for (let i = 1; i < bars.length; i++) {
    const b = bars[i];
    const prev = bars[i - 1];
    if (!b || !prev) continue;
    const tr = Math.max(
      b.high - b.low,
      Math.abs(b.high - prev.close),
      Math.abs(b.low - prev.close),
    );
    atr = atr === undefined ? tr : (atr * (period - 1) + tr) / period;
  }
  return atr;
}

/** "07:00" for minutes from midnight. */
export const clock = (min: number) =>
  `${String(Math.floor(min / 60) % 24).padStart(2, "0")}:${String(min % 60).padStart(2, "0")}`;

/** Minutes from midnight for "07:00"; undefined if it isn't a time. */
export function minutesOf(text: string): number | undefined {
  const m = /^(\d{1,2}):(\d{2})$/.exec(text.trim());
  if (!m) return undefined;
  const h = Number(m[1]);
  const min = Number(m[2]);
  return h <= 24 && min < 60 && h * 60 + min <= 1440 ? h * 60 + min : undefined;
}
