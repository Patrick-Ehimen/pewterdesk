import type {
  BotTrade,
  CandleInterval,
  Cell,
  LabRun,
  RunResult,
  StrategyConfig,
  Sweep,
  VenueId,
} from "@pewterdesk/core";
import { invoke } from "@tauri-apps/api/core";
import { asVenueError, describeVenueError } from "../api/venueClient";

/**
 * The Backtest page: strategies kept on this machine (the library), each
 * run by the engine on its market's history between two dates
 * (`backtest_run`), and optimized over a grid of its settings
 * (`backtest_optimize`). Nothing here trades.
 */

export const LAB_INTERVALS = ["15m", "1h", "4h", "1d"] as const satisfies readonly CandleInterval[];
export type LabInterval = (typeof LAB_INTERVALS)[number];

export const INTERVAL_MS: Record<LabInterval, number> = {
  "15m": 900_000,
  "1h": 3_600_000,
  "4h": 14_400_000,
  "1d": 86_400_000,
};

export const PERIODS = ["30d", "90d", "180d", "1y", "2y", "custom"] as const;
export type PeriodKind = (typeof PERIODS)[number];
const PERIOD_DAYS: Record<Exclude<PeriodKind, "custom">, number> = {
  "30d": 30,
  "90d": 90,
  "180d": 180,
  "1y": 365,
  "2y": 730,
};

export const TEMPLATES = ["ema", "grid", "dca", "custom"] as const;
export type Template = (typeof TEMPLATES)[number];

export interface LabStrategy {
  id: string;
  name: string;
  /** Shown first in the library, and run with one click. */
  active: boolean;
  venue: VenueId;
  /** The first market; `extra` holds any more, tested alongside it. */
  market: string;
  extra?: string[];
  /**
   * With several markets: each tested on its own with the whole balance, or
   * one account - the balance split evenly between them, their results added up.
   */
  account?: Account;
  interval: LabInterval;
  period: PeriodKind;
  /** With `period` "custom": the first and last day, ms (UTC midnight). */
  from?: number;
  to?: number;
  holdOutDays: number;
  capital: number;
  slippageBps: number;
  strategy: StrategyConfig;
  version: number;
  updatedAt: number;
  /** The last run's figures, for the library. */
  last?: LastRun;
}

export const ACCOUNTS = ["each", "shared"] as const;
export type Account = (typeof ACCOUNTS)[number];

/** Every market a strategy is tested on, the first first, no repeats. */
export function allMarkets(s: Pick<LabStrategy, "market" | "extra">): string[] {
  return [...new Set([s.market, ...(s.extra ?? [])].filter((m) => m !== ""))];
}

/** The most markets one backtest takes. */
export const MAX_MARKETS = 6;

export interface LastRun {
  at: number;
  ret: number;
  retOut: number;
  maxDrawdown: number;
  trades: number;
  buyHold: number;
  /** Equity, thinned, for the library's chart, and the times it's at. */
  curve: number[];
  times: number[];
}

const DAY = 86_400_000;
const KEY = "pd.backtest.strategies";

export function loadStrategies(): LabStrategy[] {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) {
      const list = JSON.parse(raw) as unknown;
      if (Array.isArray(list)) {
        return list
          .filter(
            (s): s is LabStrategy =>
              typeof s === "object" &&
              s !== null &&
              typeof s.id === "string" &&
              typeof s.strategy === "object" &&
              // The starters an early build put here: the library is the trader's own.
              !s.id.startsWith("seed-"),
          )
          .map(withoutMarketName);
      }
    }
  } catch {
    // Unreadable: an empty library.
  }
  return [];
}

/**
 * Names an early build gave new strategies ended with a market
 * ("RSI bounce · BTC-USDC"), which the page already shows beside them, and
 * which went stale when the strategy moved to other markets: that ending is
 * dropped when it's one of the strategy's markets or reads as a market
 * (BASE-QUOTE, BASE/QUOTE, or a builder market like xyz:TSLA).
 */
function withoutMarketName(s: LabStrategy): LabStrategy {
  if (typeof s.name !== "string") return s;
  const at = s.name.lastIndexOf("·");
  if (at <= 0) return s;
  const head = s.name.slice(0, at).trim();
  const tail = s.name
    .slice(at + 1)
    .trim()
    .toUpperCase();
  if (!head || !tail) return s;
  const bare = (m: string) => m.toUpperCase().replace(/[^A-Z0-9]/g, "");
  const own = [s.market, ...(s.extra ?? [])].some((m) => m && bare(m) === bare(tail));
  const looks =
    /^[A-Z0-9]{1,20}[-/][A-Z0-9]{2,8}$/.test(tail) || /^[A-Z0-9]{1,10}:[A-Z0-9]{1,20}$/.test(tail);
  return own || looks ? { ...s, name: head } : s;
}

export function saveStrategies(list: readonly LabStrategy[]) {
  try {
    localStorage.setItem(KEY, JSON.stringify(list));
  } catch {
    // Full or off: kept for this session.
  }
}

export const newId = () => `s-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;

/** The start and end of a strategy's period, ms: whole candles, the forming one left out. */
export function periodRange(s: LabStrategy, now = Date.now()): { since: number; until: number } {
  const step = INTERVAL_MS[s.interval];
  const lastClosed = now - (now % step) - step;
  if (s.period === "custom" && s.from !== undefined && s.to !== undefined) {
    return { since: s.from, until: Math.min(lastClosed, s.to + DAY - step) };
  }
  const days = s.period === "custom" ? 365 : PERIOD_DAYS[s.period];
  return { since: lastClosed - days * DAY, until: lastClosed };
}

export function labRun(
  s: LabStrategy,
  now = Date.now(),
  market = s.market,
  capital = s.capital,
): LabRun {
  const { since, until } = periodRange(s, now);
  return {
    venue: s.venue,
    market,
    interval: s.interval,
    since,
    until,
    holdOutDays: s.holdOutDays,
    capital,
    slippageBps: s.slippageBps,
    strategy: s.strategy,
  };
}

async function call<T>(command: string, args: Record<string, unknown>): Promise<T> {
  try {
    return await invoke<T>(command, args);
  } catch (e) {
    throw new Error(describeVenueError(asVenueError(e)));
  }
}

/** One market's run within a backtest. */
export interface Part {
  market: string;
  run: RunResult;
}

/**
 * The strategy on each of its markets, run side by side by the engine. In a
 * shared account each market trades its even share of the balance.
 */
export async function runBacktest(s: LabStrategy, now = Date.now()): Promise<Part[]> {
  const markets = allMarkets(s);
  const capital =
    s.account === "shared" && markets.length > 1 ? s.capital / markets.length : s.capital;
  return Promise.all(
    markets.map(async (market) => ({
      market,
      run: await call<RunResult>("backtest_run", { run: labRun(s, now, market, capital) }),
    })),
  );
}

/**
 * Several markets' runs as one account: their equity (and buy & hold) added
 * up at every candle time, each carried forward between its own candles,
 * and every trade together, each tagged with its market.
 */
export function combine(parts: readonly Part[]): RunResult & { tradeMarkets: string[] } {
  const times = [...new Set(parts.flatMap((p) => p.run.bars.map((b) => b.time)))].sort(
    (a, b) => a - b,
  );
  const at = parts.map(() => 0);
  const equity: number[] = [];
  const buyHold: number[] = [];
  for (const time of times) {
    let e = 0;
    let h = 0;
    parts.forEach((p, k) => {
      const bars = p.run.bars;
      let i = at[k] ?? 0;
      while (i + 1 < bars.length && (bars[i + 1]?.time ?? Infinity) <= time) i++;
      at[k] = i;
      // Before a market's first candle, its share sits as cash.
      const started = (bars[0]?.time ?? Infinity) <= time;
      e += started ? (p.run.equity[i] ?? 0) : (p.run.equity[0] ?? 0);
      h += started ? (p.run.buyHold[i] ?? 0) : (p.run.buyHold[0] ?? 0);
    });
    equity.push(e);
    buyHold.push(h);
  }
  const holdAt = Math.min(
    ...parts.map((p) => p.run.bars[p.run.holdOutFrom]?.time ?? Number.POSITIVE_INFINITY),
  );
  const split = times.findIndex((time) => time >= holdAt);
  const tagged = parts
    .flatMap((p) => p.run.trades.map((t) => ({ t, market: p.market })))
    .sort((a, b) => a.t.openTime - b.t.openTime);
  const inMarket =
    parts.reduce((a, p) => a + p.run.barsInMarket / Math.max(1, p.run.bars.length), 0) /
    parts.length;
  return {
    bars: times.map((time) => ({ time, open: 0, high: 0, low: 0, close: 0 })),
    equity,
    buyHold,
    holdOutFrom: split === -1 ? times.length : split,
    barsInMarket: Math.round(inMarket * times.length),
    trades: tagged.map(({ t }, i) => ({ ...t, n: i + 1 })),
    tradeMarkets: tagged.map(({ market }) => market),
    asked: [],
  };
}

/** What the library keeps of a backtest: the account's in a shared one, else the first market's. */
export function lastRunOf(
  s: LabStrategy,
  parts: readonly Part[],
  now = Date.now(),
): LastRun | undefined {
  const first = parts[0];
  if (!first) return undefined;
  return lastRun(parts.length > 1 && s.account === "shared" ? combine(parts) : first.run, now);
}
export const runOptimize = (s: LabStrategy, sweep: Sweep) =>
  call<Cell[]>("backtest_optimize", { run: labRun(s), sweep });

/** The venue's fees as the engine costs a run (`paper_costs`): taker, maker. */
export const VENUE_FEES: Record<VenueId, [number, number]> = {
  bybit: [0.00055, 0.0002],
  hyperliquid: [0.00045, 0.00015],
  aster: [0.00035, 0.0001],
  binance: [0.0005, 0.0002],
  blofin: [0.0006, 0.0002],
};

// --- Settings the optimizer can vary --------------------------------------

export interface ParamSpec {
  name: string;
  /** "count" rounds to whole numbers; "pct" is shown ×100. */
  kind: "count" | "num" | "pct";
  /** A sensible range to start from, around `value`. */
  range: (value: number) => [number, number, number];
}

const around = (v: number, lo: number, hi: number, step: number): [number, number, number] => [
  Math.max(lo, v - step * 4),
  Math.min(hi, v + step * 4),
  step,
];

export function paramSpecs(c: StrategyConfig): ParamSpec[] {
  switch (c.template) {
    case "ema":
      return [
        { name: "fast", kind: "count", range: (v) => around(v, 2, 100, 2) },
        { name: "slow", kind: "count", range: (v) => around(v, 5, 400, 5) },
        { name: "stopAtr", kind: "num", range: (v) => around(v, 0.5, 10, 0.5) },
        { name: "risk", kind: "pct", range: (v) => around(v, 0.0025, 0.05, 0.0025) },
        { name: "maxLeverage", kind: "num", range: (v) => around(v, 1, 20, 1) },
      ];
    case "grid":
      return [
        { name: "levels", kind: "count", range: (v) => around(v, 2, 100, 2) },
        { name: "lower", kind: "num", range: (v) => [v * 0.9, v * 1.05, v * 0.025] },
        { name: "upper", kind: "num", range: (v) => [v * 0.95, v * 1.1, v * 0.025] },
        { name: "sizePerLevel", kind: "num", range: (v) => [v * 0.5, v * 1.5, v * 0.25] },
      ];
    case "dca":
      return [
        { name: "every", kind: "count", range: (v) => around(v, 1, 200, 2) },
        { name: "takeProfit", kind: "pct", range: (v) => around(v, 0.01, 0.5, 0.01) },
        { name: "maxBuys", kind: "count", range: (v) => around(v, 1, 100, 2) },
        { name: "amount", kind: "num", range: (v) => [v * 0.5, v * 1.5, v * 0.25] },
      ];
    case "custom":
      return [
        { name: "stopLoss", kind: "pct", range: (v) => around(v, 0, 0.3, 0.01) },
        { name: "takeProfit", kind: "pct", range: (v) => around(v, 0, 1, 0.02) },
        { name: "size", kind: "pct", range: (v) => around(v, 0.1, 5, 0.25) },
      ];
  }
}

export function getParam(c: StrategyConfig, name: string): number {
  const v = (c as unknown as Record<string, unknown>)[name];
  return typeof v === "number" ? v : 0;
}

/** `c` with one setting changed, as the engine's `set_param` does it. */
export function setParam(c: StrategyConfig, name: string, v: number): StrategyConfig {
  const spec = paramSpecs(c).find((p) => p.name === name);
  const value = spec?.kind === "count" ? Math.max(0, Math.round(v)) : v;
  return { ...c, [name]: value } as StrategyConfig;
}

/** From, to, by: the values in between, at most `max` of them. */
export function steps(from: number, to: number, by: number, max = 20): number[] {
  if (!(by > 0) || !Number.isFinite(from) || !Number.isFinite(to) || to < from) return [];
  const out: number[] = [];
  for (let v = from; v <= to + by * 1e-9 && out.length < max; v += by)
    out.push(Number(v.toFixed(10)));
  return out;
}

export type Rank = "ret" | "retOut" | "calmar" | "pf";
export function score(cell: Cell, rank: Rank): number | undefined {
  const s = cell.summary;
  if (!s) return undefined;
  switch (rank) {
    case "ret":
      return s.retIn;
    case "retOut":
      return s.retOut;
    case "calmar":
      return s.maxDrawdown < 0 ? s.retIn / -s.maxDrawdown : s.retIn > 0 ? 99 : 0;
    case "pf":
      return s.profitFactor ?? (s.trades > 0 ? 99 : 0);
  }
}

// --- What a run comes to ------------------------------------------------

export interface RunStats {
  ret: number;
  retIn: number;
  retOut: number;
  buyHold: number;
  buyHoldDrawdown: number;
  maxDrawdown: number;
  net: number;
  trades: number;
  tradesIn: number;
  tradesOut: number;
  winRate: number;
  profitFactor?: number;
  avgR: number;
  avgWinR: number;
  avgLossR: number;
  inMarket: number;
  fees: number;
  funding: number;
  slippage: number;
  /** P&L before fees, funding and slippage. */
  gross: number;
  best?: BotTrade;
  worstStreak: number;
  stops: number;
}

const ratio = (a: number, b: number) => (b > 0 ? a / b - 1 : 0);

export function maxDrawdown(values: readonly number[]): number {
  let peak = Number.NEGATIVE_INFINITY;
  let dd = 0;
  for (const v of values) {
    peak = Math.max(peak, v);
    if (peak > 0) dd = Math.min(dd, v / peak - 1);
  }
  return dd;
}

function part(trades: readonly BotTrade[], out: boolean) {
  return trades.filter((t) => t.outOfSample === out);
}

export function stats(run: RunResult): RunStats {
  const eq = run.equity;
  const first = eq[0] ?? 0;
  const last = eq.at(-1) ?? first;
  const split = Math.min(run.holdOutFrom, eq.length);
  const atSplit = split === 0 ? first : (eq[split - 1] ?? last);
  const tr = run.trades;
  const wins = tr.filter((t) => t.pnl > 0);
  const losses = tr.filter((t) => t.pnl <= 0);
  const won = wins.reduce((a, t) => a + t.pnl, 0);
  const lost = -losses.reduce((a, t) => a + t.pnl, 0);
  const sum = (k: "fees" | "funding" | "slippage") => tr.reduce((a, t) => a + Math.abs(t[k]), 0);
  const fees = sum("fees");
  // Paid is positive here (a short can be paid funding: negative).
  const funding = -tr.reduce((a, t) => a + t.funding, 0);
  const slippage = sum("slippage");
  const net = last - first;
  let streak = 0;
  let worstStreak = 0;
  for (const t of tr) {
    streak = t.pnl <= 0 ? streak + 1 : 0;
    worstStreak = Math.max(worstStreak, streak);
  }
  const mean = (xs: BotTrade[]) => (xs.length ? xs.reduce((a, t) => a + t.r, 0) / xs.length : 0);
  return {
    ret: ratio(last, first),
    retIn: ratio(atSplit, first),
    retOut: split < eq.length ? ratio(last, atSplit) : 0,
    buyHold: ratio(run.buyHold.at(-1) ?? 0, run.buyHold[0] ?? 0),
    buyHoldDrawdown: maxDrawdown(run.buyHold),
    maxDrawdown: maxDrawdown(eq),
    net,
    trades: tr.length,
    tradesIn: part(tr, false).length,
    tradesOut: part(tr, true).length,
    winRate: tr.length ? wins.length / tr.length : 0,
    profitFactor: lost > 0 ? won / lost : undefined,
    avgR: mean(tr),
    avgWinR: mean(wins),
    avgLossR: mean(losses),
    inMarket: run.bars.length ? run.barsInMarket / run.bars.length : 0,
    fees,
    funding,
    slippage,
    gross: net + fees + funding + slippage,
    best: wins.reduce<BotTrade | undefined>((b, t) => (!b || t.pnl > b.pnl ? t : b), undefined),
    worstStreak,
    stops: tr.filter((t) => t.exitReason === "stop").length,
  };
}

/** Of a part of the run: in sample (before the hold-out) or held out. */
export function partStats(run: RunResult, out: boolean) {
  const eq = run.equity;
  const split = Math.min(run.holdOutFrom, eq.length);
  const slice = out ? eq.slice(Math.max(0, split - 1)) : eq.slice(0, Math.max(1, split));
  const tr = part(run.trades, out);
  const wins = tr.filter((t) => t.pnl > 0);
  const won = wins.reduce((a, t) => a + t.pnl, 0);
  const lost = -tr.filter((t) => t.pnl <= 0).reduce((a, t) => a + t.pnl, 0);
  return {
    ret: ratio(slice.at(-1) ?? 0, slice[0] ?? 0),
    trades: tr.length,
    winRate: tr.length ? wins.length / tr.length : 0,
    profitFactor: lost > 0 ? won / lost : undefined,
    avgR: tr.length ? tr.reduce((a, t) => a + t.r, 0) / tr.length : 0,
    maxDrawdown: maxDrawdown(slice),
    days: (() => {
      const bars = run.bars;
      const a = out ? bars[split] : bars[0];
      const z = out ? bars.at(-1) : bars[Math.max(0, split - 1)];
      return a && z ? (z.time - a.time) / DAY : 0;
    })(),
  };
}

/** Each calendar month's return, and holding's (UTC). */
export function monthly(
  run: RunResult,
): { at: number; ret: number; hold: number; heldOut: boolean }[] {
  const out: { at: number; ret: number; hold: number; heldOut: boolean }[] = [];
  let start = 0;
  const key = (ms: number) => {
    const d = new Date(ms);
    return d.getUTCFullYear() * 12 + d.getUTCMonth();
  };
  for (let i = 1; i <= run.bars.length; i++) {
    const cur = run.bars[i];
    const prev = run.bars[i - 1];
    if (!prev) continue;
    if (!cur || key(cur.time) !== key(prev.time)) {
      const a = Math.max(0, start - 1);
      const d = new Date(run.bars[start]?.time ?? 0);
      out.push({
        at: Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1),
        ret: ratio(run.equity[i - 1] ?? 0, run.equity[a] ?? 0),
        hold: ratio(run.buyHold[i - 1] ?? 0, run.buyHold[a] ?? 0),
        heldOut: i - 1 >= run.holdOutFrom,
      });
      start = i;
    }
  }
  return out;
}

/** The deepest falls from a high: depth, when it began, its low, and when the high came back. */
export function drawdowns(run: RunResult, top = 4) {
  const eq = run.equity;
  const found: { depth: number; from: number; low: number; back?: number }[] = [];
  let peakI = 0;
  let lowI = 0;
  for (let i = 1; i <= eq.length; i++) {
    const v = eq[i];
    const peak = eq[peakI] ?? 0;
    if (v === undefined || v >= peak) {
      const depth = peak > 0 ? (eq[lowI] ?? peak) / peak - 1 : 0;
      if (lowI > peakI && depth < -0.002) {
        found.push({
          depth,
          from: run.bars[peakI]?.time ?? 0,
          low: run.bars[lowI]?.time ?? 0,
          back: v === undefined ? undefined : run.bars[i]?.time,
        });
      }
      peakI = i;
      lowI = i;
    } else if (v < (eq[lowI] ?? Number.POSITIVE_INFINITY)) {
      lowI = i;
    }
  }
  return found.sort((a, b) => a.depth - b.depth).slice(0, top);
}

/**
 * Other years the same trades could have made: each trade's return on the
 * equity it was taken with, drawn again at random (with replacement)
 * `n` times. Seeded, so the same run gives the same answer.
 */
export function monteCarlo(run: RunResult, n = 2000) {
  const returns = run.trades.map((t) => {
    const i = run.bars.findIndex((b) => b.time >= t.openTime);
    const eq = run.equity[Math.max(0, i - 1)] ?? run.equity[0] ?? 1;
    return eq > 0 ? t.pnl / eq : 0;
  });
  if (returns.length === 0) return undefined;
  let seed = 7;
  const rnd = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
  };
  const finals: number[] = [];
  const dds: number[] = [];
  for (let k = 0; k < n; k++) {
    let v = 1;
    let peak = 1;
    let dd = 0;
    for (let j = 0; j < returns.length; j++) {
      v *= 1 + (returns[Math.floor(rnd() * returns.length)] ?? 0);
      peak = Math.max(peak, v);
      dd = Math.min(dd, v / peak - 1);
    }
    finals.push(v - 1);
    dds.push(dd);
  }
  finals.sort((a, b) => a - b);
  dds.sort((a, b) => a - b);
  const q = (xs: number[], p: number) =>
    xs[Math.min(xs.length - 1, Math.floor(p * xs.length))] ?? 0;
  return {
    losing: finals.filter((x) => x < 0).length / n,
    bad: q(finals, 0.05),
    median: q(finals, 0.5),
    good: q(finals, 0.95),
    ddMedian: q(dds, 0.5),
    dd95: q(dds, 0.05),
  };
}

/** A library line: the run's equity, thinned to `points`. */
export function thin(values: readonly number[], points = 48): number[] {
  if (values.length <= points) return [...values];
  const out: number[] = [];
  for (let i = 0; i < points; i++)
    out.push(values[Math.round((i / (points - 1)) * (values.length - 1))] ?? 0);
  return out;
}

export function lastRun(run: RunResult, now = Date.now()): LastRun {
  const s = stats(run);
  return {
    at: now,
    ret: s.ret,
    retOut: s.retOut,
    maxDrawdown: s.maxDrawdown,
    trades: s.trades,
    buyHold: s.buyHold,
    curve: thin(run.equity),
    times: thin(run.bars.map((b) => b.time)),
  };
}
