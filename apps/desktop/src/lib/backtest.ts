// Backtests, for the Bots page's preview (after the Backtest mockups in
// `design/`). The engine that will run them for real is planned in Rust
// (`docs/bots/`); until then a run here is a small simulation over sample
// candles, made in the page, so the screens can be shown with figures that
// agree with each other. Nothing here reads a venue or places an order.

/** One candle, in plain numbers. `time` is when it opened, in ms. */
export interface Bar {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
}

export type Template = "ema" | "grid" | "custom";

export interface EmaParams {
  fast: number;
  slow: number;
  /** The stop, in ATR(14) multiples from the entry. */
  stopAtr: number;
  /** Equity put at risk by each trade, as a fraction (0.01 = 1%). */
  risk: number;
  maxLeverage: number;
  direction: "both" | "long" | "short";
}

export interface GridParams {
  lower: number;
  upper: number;
  levels: number;
  /** In base units, bought or sold at each level. */
  sizePerLevel: number;
  /** Below `stopBelow` or above `stopAbove` the bot flattens and stops. */
  stopBelow: number;
  stopAbove: number;
}

/** What a custom rule reads: the close, an indicator over it, or a fixed number. */
export type Source =
  | { kind: "price" }
  | { kind: "ema" | "sma" | "rsi"; period: number }
  | { kind: "value"; value: number };

export type Compare = "crossesAbove" | "crossesBelow" | "above" | "below";

/** "EMA 20 crosses above EMA 50", read on each candle's close. */
export interface Rule {
  left: Source;
  op: Compare;
  right: Source;
}

/** A bot made of its own rules: in when every entry rule holds, out when any exit rule does. */
export interface CustomParams {
  side: "long" | "short";
  entry: Rule[];
  exit: Rule[];
  /** From the entry, as fractions (0.03 = 3%); 0 for none. */
  stopLoss: number;
  takeProfit: number;
  /** The position's notional as a fraction of equity (1 = 1×). */
  size: number;
}

/** What a run was asked to do: one strategy, on one market's sample candles. */
export interface RunSpec {
  /** "#14" in the interface. */
  id: number;
  template: Template;
  ema?: EmaParams;
  grid?: GridParams;
  custom?: CustomParams;
  /** The name it was given, if any. */
  name?: string;
  venue: string;
  market: string;
  interval: "1h" | "4h";
  /** Candles in the run, the newest last. */
  bars: number;
  /** The newest candle's open, in ms. */
  end: number;
  /** The last of the run held out from tuning, in days. */
  holdOutDays: number;
  capital: number;
  /** Taker fee per side, as a fraction. */
  fee: number;
  /** Slippage per side, in basis points. */
  slippageBps: number;
  /** Seeds the sample candles: one market, one series. */
  seed: number;
  /** The sample's first price. */
  startPrice: number;
}

export type ExitReason = "cross" | "stop" | "end" | "grid" | "stopOut" | "rule" | "target";

export interface Trade {
  /** 1 is the oldest. */
  n: number;
  side: "long" | "short";
  openTime: number;
  closeTime: number;
  entry: number;
  exit: number;
  size: number;
  /** After fees and funding. */
  pnl: number;
  /** The P&L in multiples of what was risked. */
  r: number;
  /** Amount at risk at entry (1R). */
  risk: number;
  initialStop?: number;
  fees: number;
  funding: number;
  slippage: number;
  exitReason: ExitReason;
  /** Opened in the held-out period. */
  outOfSample: boolean;
  /** Best and worst P&L while open. */
  mfe: number;
  mae: number;
}

export interface RunResult {
  spec: RunSpec;
  bars: Bar[];
  trades: Trade[];
  /** Equity at each candle's close, marked to market. */
  equity: number[];
  /** Holding the market with the whole capital, no leverage. */
  buyHold: number[];
  /** The first held-out candle's index. */
  holdOutFrom: number;
  /** Candles with a position open. */
  barsInMarket: number;
  /** The EMA cross's two lines, for the trades chart. */
  fastLine?: (number | undefined)[];
  slowLine?: (number | undefined)[];
  /** A grid's stop-out: the candle it was hit on and the price, if it was. */
  stoppedOut?: { index: number; price: number };
}

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
/** Funding paid by longs, per 8 hours, on the notional. */
const FUNDING_8H = 0.00005;

export const intervalMs = (interval: RunSpec["interval"]) => (interval === "1h" ? HOUR : 4 * HOUR);

/** A small, fast, seeded random source, so a run is the same each time. */
export function seeded(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

/**
 * Sample candles: a random walk whose drift changes every few days, so there
 * are trends to follow and ranges to lose in. Seeded: the same spec gives the
 * same candles.
 */
export function sampleBars(
  seed: number,
  count: number,
  end: number,
  interval: number,
  startPrice: number,
): Bar[] {
  const random = seeded(seed);
  const bars: Bar[] = [];
  // Moves sized for 4h candles; shorter ones move less, about with the root of time.
  const scale = Math.sqrt(interval / (4 * HOUR));
  let price = startPrice;
  let drift = 0;
  for (let i = 0; i < count; i++) {
    if (i % 30 === 0) drift = (random() - 0.48) * 0.006 * scale;
    const open = price;
    const move = drift + (random() - 0.5) * 0.022 * scale;
    const close = Math.max(open * (1 + move), startPrice * 0.05);
    const high = Math.max(open, close) * (1 + random() * 0.009 * scale);
    const low = Math.min(open, close) * (1 - random() * 0.009 * scale);
    bars.push({ time: end - (count - 1 - i) * interval, open, high, low, close });
    price = close;
  }
  return bars;
}

export function emaLine(values: readonly number[], period: number): (number | undefined)[] {
  const k = 2 / (period + 1);
  const out: (number | undefined)[] = [];
  let prev: number | undefined;
  for (let i = 0; i < values.length; i++) {
    const v = values[i] as number;
    if (i < period - 1) {
      out.push(undefined);
      continue;
    }
    if (prev === undefined) {
      let sum = 0;
      for (let j = i - period + 1; j <= i; j++) sum += values[j] as number;
      prev = sum / period;
    } else {
      prev = v * k + prev * (1 - k);
    }
    out.push(prev);
  }
  return out;
}

export function atrLine(bars: readonly Bar[], period = 14): (number | undefined)[] {
  const out: (number | undefined)[] = [];
  let prev: number | undefined;
  for (let i = 0; i < bars.length; i++) {
    const b = bars[i] as Bar;
    const prevClose = i > 0 ? (bars[i - 1] as Bar).close : b.close;
    const tr = Math.max(b.high - b.low, Math.abs(b.high - prevClose), Math.abs(b.low - prevClose));
    prev = prev === undefined ? tr : (prev * (period - 1) + tr) / period;
    out.push(i >= period - 1 ? prev : undefined);
  }
  return out;
}

interface Open {
  side: "long" | "short";
  openIndex: number;
  entry: number;
  size: number;
  stop?: number;
  risk: number;
  fees: number;
  slippage: number;
  mfe: number;
  mae: number;
}

/** Runs a spec over its sample candles. */
export function runBacktest(spec: RunSpec): RunResult {
  const step = intervalMs(spec.interval);
  const bars = sampleBars(spec.seed, spec.bars, spec.end, step, spec.startPrice);
  const holdOutFrom = Math.max(
    0,
    bars.findIndex((b) => b.time >= spec.end - spec.holdOutDays * DAY + step),
  );
  const result =
    spec.template === "grid" && spec.grid
      ? runGrid(spec, spec.grid, bars, holdOutFrom)
      : spec.template === "custom" && spec.custom
        ? runCustom(spec, spec.custom, bars, holdOutFrom)
        : runEma(spec, spec.ema ?? DEFAULT_EMA, bars, holdOutFrom);
  const first = bars[0]?.close ?? 1;
  return {
    ...result,
    spec,
    bars,
    holdOutFrom,
    buyHold: bars.map((b) => spec.capital * (b.close / first)),
  };
}

export const DEFAULT_EMA: EmaParams = {
  fast: 9,
  slow: 26,
  stopAtr: 2,
  risk: 0.01,
  maxLeverage: 3,
  direction: "both",
};

type Simulated = Omit<RunResult, "spec" | "bars" | "holdOutFrom" | "buyHold">;

function runEma(spec: RunSpec, p: EmaParams, bars: Bar[], holdOutFrom: number): Simulated {
  const closes = bars.map((b) => b.close);
  const fast = emaLine(closes, p.fast);
  const slow = emaLine(closes, p.slow);
  const atr = atrLine(bars);
  const slip = spec.slippageBps / 10_000;
  const step = intervalMs(spec.interval);
  const trades: Trade[] = [];
  const equity: number[] = [];
  let cash = spec.capital;
  let open: Open | undefined;
  let barsInMarket = 0;

  const close = (i: number, rawExit: number, reason: ExitReason) => {
    if (!open) return;
    const dir = open.side === "long" ? 1 : -1;
    const exit = rawExit * (1 - dir * slip);
    const notional = exit * open.size;
    const fee = notional * spec.fee;
    const hours = ((i - open.openIndex) * step) / HOUR;
    const funding = -dir * open.entry * open.size * FUNDING_8H * (hours / 8);
    const gross = (exit - open.entry) * open.size * dir;
    const fees = open.fees + fee;
    const pnl = gross - fees + funding;
    cash += gross - fee + funding;
    trades.push({
      n: trades.length + 1,
      side: open.side,
      openTime: (bars[open.openIndex] as Bar).time,
      closeTime: (bars[i] as Bar).time,
      entry: open.entry,
      exit,
      size: open.size,
      pnl,
      r: open.risk > 0 ? pnl / open.risk : 0,
      risk: open.risk,
      initialStop: open.stop,
      fees: -fees,
      funding,
      slippage: open.slippage + rawExit * slip * open.size,
      exitReason: reason,
      outOfSample: open.openIndex >= holdOutFrom,
      mfe: open.mfe,
      mae: open.mae,
    });
    open = undefined;
  };

  for (let i = 0; i < bars.length; i++) {
    const bar = bars[i] as Bar;
    // A stop is hit inside the candle, before its close is read.
    if (open?.stop !== undefined) {
      const hit = open.side === "long" ? bar.low <= open.stop : bar.high >= open.stop;
      if (hit) close(i, open.stop, "stop");
    }
    if (open) {
      const dir = open.side === "long" ? 1 : -1;
      const best = ((open.side === "long" ? bar.high : bar.low) - open.entry) * open.size * dir;
      const worst = ((open.side === "long" ? bar.low : bar.high) - open.entry) * open.size * dir;
      open.mfe = Math.max(open.mfe, best);
      open.mae = Math.min(open.mae, worst);
    }
    const f = fast[i];
    const s = slow[i];
    const pf = fast[i - 1];
    const ps = slow[i - 1];
    if (f !== undefined && s !== undefined && pf !== undefined && ps !== undefined) {
      const up = pf <= ps && f > s;
      const down = pf >= ps && f < s;
      const want = up ? "long" : down ? "short" : undefined;
      if (want && open && open.side !== want) close(i, bar.close, "cross");
      const allowed = p.direction === "both" || p.direction === want;
      if (want && !open && allowed && i < bars.length - 1) {
        const a = atr[i] ?? bar.close * 0.01;
        const dir = want === "long" ? 1 : -1;
        const entry = bar.close * (1 + dir * slip);
        const stop = entry - dir * p.stopAtr * a;
        const equityNow = cash;
        const byRisk = (equityNow * p.risk) / Math.abs(entry - stop);
        const byLeverage = (equityNow * p.maxLeverage) / entry;
        const size = Math.min(byRisk, byLeverage);
        const fee = entry * size * spec.fee;
        cash -= fee;
        open = {
          side: want,
          openIndex: i,
          entry,
          size,
          stop,
          risk: Math.abs(entry - stop) * size,
          fees: fee,
          slippage: bar.close * slip * size,
          mfe: 0,
          mae: 0,
        };
      }
    }
    if (i === bars.length - 1 && open) close(i, bar.close, "end");
    if (open) barsInMarket++;
    const dir = open?.side === "long" ? 1 : -1;
    equity.push(cash + (open ? (bar.close - open.entry) * open.size * dir : 0));
  }
  return { trades, equity, barsInMarket, fastLine: fast, slowLine: slow };
}

export function smaLine(values: readonly number[], period: number): (number | undefined)[] {
  const out: (number | undefined)[] = [];
  let sum = 0;
  for (let i = 0; i < values.length; i++) {
    sum += values[i] as number;
    if (i >= period) sum -= values[i - period] as number;
    out.push(i >= period - 1 ? sum / period : undefined);
  }
  return out;
}

/** Wilder's RSI, 0 to 100. */
export function rsiLine(values: readonly number[], period: number): (number | undefined)[] {
  const out: (number | undefined)[] = [undefined];
  let gain = 0;
  let loss = 0;
  for (let i = 1; i < values.length; i++) {
    const change = (values[i] as number) - (values[i - 1] as number);
    const up = Math.max(0, change);
    const down = Math.max(0, -change);
    if (i <= period) {
      gain += up / period;
      loss += down / period;
    } else {
      gain = (gain * (period - 1) + up) / period;
      loss = (loss * (period - 1) + down) / period;
    }
    out.push(i < period ? undefined : loss === 0 ? 100 : 100 - 100 / (1 + gain / loss));
  }
  return out;
}

/** A source's value at every candle. */
export function sourceLine(bars: readonly Bar[], source: Source): (number | undefined)[] {
  const closes = bars.map((b) => b.close);
  switch (source.kind) {
    case "price":
      return closes;
    case "value":
      return closes.map(() => source.value);
    case "ema":
      return emaLine(closes, source.period);
    case "sma":
      return smaLine(closes, source.period);
    case "rsi":
      return rsiLine(closes, source.period);
  }
}

/** Whether a rule holds on candle `i`, given its two lines. */
export function ruleHolds(
  op: Compare,
  left: readonly (number | undefined)[],
  right: readonly (number | undefined)[],
  i: number,
): boolean {
  const l = left[i];
  const r = right[i];
  if (l === undefined || r === undefined) return false;
  if (op === "above") return l > r;
  if (op === "below") return l < r;
  const pl = left[i - 1];
  const pr = right[i - 1];
  if (pl === undefined || pr === undefined) return false;
  return op === "crossesAbove" ? pl <= pr && l > r : pl >= pr && l < r;
}

function runCustom(spec: RunSpec, p: CustomParams, bars: Bar[], holdOutFrom: number): Simulated {
  const lines = (rules: readonly Rule[]) =>
    rules.map((rule) => ({
      op: rule.op,
      left: sourceLine(bars, rule.left),
      right: sourceLine(bars, rule.right),
    }));
  const entry = lines(p.entry);
  const exit = lines(p.exit);
  const dir = p.side === "long" ? 1 : -1;
  const slip = spec.slippageBps / 10_000;
  const step = intervalMs(spec.interval);
  const trades: Trade[] = [];
  const equity: number[] = [];
  let cash = spec.capital;
  let open: (Open & { target?: number }) | undefined;
  let barsInMarket = 0;

  const close = (i: number, rawExit: number, reason: ExitReason) => {
    if (!open) return;
    const price = rawExit * (1 - dir * slip);
    const fee = price * open.size * spec.fee;
    const hours = ((i - open.openIndex) * step) / HOUR;
    const funding = -dir * open.entry * open.size * FUNDING_8H * (hours / 8);
    const gross = (price - open.entry) * open.size * dir;
    const fees = open.fees + fee;
    const pnl = gross - fees + funding;
    cash += gross - fee + funding;
    trades.push({
      n: trades.length + 1,
      side: p.side,
      openTime: (bars[open.openIndex] as Bar).time,
      closeTime: (bars[i] as Bar).time,
      entry: open.entry,
      exit: price,
      size: open.size,
      pnl,
      r: open.risk > 0 ? pnl / open.risk : 0,
      risk: open.risk,
      initialStop: open.stop,
      fees: -fees,
      funding,
      slippage: open.slippage + rawExit * slip * open.size,
      exitReason: reason,
      outOfSample: open.openIndex >= holdOutFrom,
      mfe: open.mfe,
      mae: open.mae,
    });
    open = undefined;
  };

  for (let i = 0; i < bars.length; i++) {
    const bar = bars[i] as Bar;
    if (open) {
      // The stop and target are hit inside the candle; the stop is assumed first.
      const stopHit =
        open.stop !== undefined && (dir === 1 ? bar.low <= open.stop : bar.high >= open.stop);
      const targetHit =
        open.target !== undefined && (dir === 1 ? bar.high >= open.target : bar.low <= open.target);
      if (stopHit) close(i, open.stop as number, "stop");
      else if (targetHit) close(i, open.target as number, "target");
    }
    if (open) {
      const best = ((dir === 1 ? bar.high : bar.low) - open.entry) * open.size * dir;
      const worst = ((dir === 1 ? bar.low : bar.high) - open.entry) * open.size * dir;
      open.mfe = Math.max(open.mfe, best);
      open.mae = Math.min(open.mae, worst);
      if (exit.some((r) => ruleHolds(r.op, r.left, r.right, i))) close(i, bar.close, "rule");
    } else if (
      i < bars.length - 1 &&
      entry.length > 0 &&
      entry.every((r) => ruleHolds(r.op, r.left, r.right, i))
    ) {
      const price = bar.close * (1 + dir * slip);
      const size = (cash * p.size) / price;
      const fee = price * size * spec.fee;
      cash -= fee;
      const stop = p.stopLoss > 0 ? price * (1 - dir * p.stopLoss) : undefined;
      open = {
        side: p.side,
        openIndex: i,
        entry: price,
        size,
        stop,
        target: p.takeProfit > 0 ? price * (1 + dir * p.takeProfit) : undefined,
        // Without a stop, 1R is taken as a 1% move.
        risk: price * size * (p.stopLoss > 0 ? p.stopLoss : 0.01),
        fees: fee,
        slippage: bar.close * slip * size,
        mfe: 0,
        mae: 0,
      };
    }
    if (i === bars.length - 1 && open) close(i, bar.close, "end");
    if (open) barsInMarket++;
    equity.push(cash + (open ? (bar.close - open.entry) * open.size * dir : 0));
  }
  return { trades, equity, barsInMarket };
}

/** Grid levels from the lower price to the upper, evenly spaced. */
export function gridLevels(p: Pick<GridParams, "lower" | "upper" | "levels">): number[] {
  if (p.levels < 2 || !(p.upper > p.lower)) return [];
  const step = (p.upper - p.lower) / (p.levels - 1);
  return Array.from({ length: p.levels }, (_, i) => p.lower + i * step);
}

function runGrid(spec: RunSpec, p: GridParams, bars: Bar[], holdOutFrom: number): Simulated {
  const levels = gridLevels(p);
  const gap = levels.length > 1 ? (levels[1] as number) - (levels[0] as number) : 0;
  const slip = spec.slippageBps / 10_000;
  const step = intervalMs(spec.interval);
  const trades: Trade[] = [];
  const equity: number[] = [];
  let cash = spec.capital;
  // The levels held: bought at that level, to sell one level up.
  const held = new Map<number, number>();
  let stoppedOut: Simulated["stoppedOut"];
  let barsInMarket = 0;

  for (let i = 0; i < bars.length; i++) {
    const bar = bars[i] as Bar;
    if (!stoppedOut && (bar.low <= p.stopBelow || bar.high >= p.stopAbove)) {
      const at = bar.low <= p.stopBelow ? p.stopBelow : p.stopAbove;
      for (const [index, openIndex] of held) {
        const entry = levels[index] as number;
        sell(i, openIndex, entry, at * (1 - slip), "stopOut");
      }
      held.clear();
      stoppedOut = { index: i, price: at };
    }
    if (!stoppedOut) {
      for (let l = 0; l < levels.length - 1; l++) {
        const level = levels[l] as number;
        if (!held.has(l) && bar.low <= level && bar.open > level) {
          cash -= level * p.sizePerLevel * spec.fee;
          held.set(l, i);
        } else if (held.has(l) && bar.high >= level + gap) {
          sell(i, held.get(l) as number, level, (level + gap) * (1 - slip), "grid");
          held.delete(l);
        }
      }
    }
    if (i === bars.length - 1) {
      for (const [index, openIndex] of held) {
        sell(i, openIndex, levels[index] as number, bar.close, "end");
      }
      held.clear();
    }
    if (held.size > 0) barsInMarket++;
    let marked = cash;
    for (const index of held.keys()) {
      marked += (bar.close - (levels[index] as number)) * p.sizePerLevel;
    }
    equity.push(marked);
  }
  return { trades, equity, barsInMarket, stoppedOut };

  function sell(i: number, openIndex: number, entry: number, exit: number, reason: ExitReason) {
    const fee = exit * p.sizePerLevel * spec.fee;
    const hours = ((i - openIndex) * step) / HOUR;
    const funding = -entry * p.sizePerLevel * FUNDING_8H * (hours / 8);
    const gross = (exit - entry) * p.sizePerLevel;
    const fees = fee + entry * p.sizePerLevel * spec.fee;
    cash += gross - fee + funding;
    const risk = Math.max((entry - p.stopBelow) * p.sizePerLevel, 1e-9);
    const pnl = gross - fees + funding;
    trades.push({
      n: trades.length + 1,
      side: "long",
      openTime: (bars[openIndex] as Bar).time,
      closeTime: (bars[i] as Bar).time,
      entry,
      exit,
      size: p.sizePerLevel,
      pnl,
      r: pnl / risk,
      risk,
      initialStop: p.stopBelow,
      fees: -fees,
      funding,
      slippage: exit * slip * p.sizePerLevel,
      exitReason: reason,
      outOfSample: openIndex >= holdOutFrom,
      mfe: Math.max(0, gross),
      mae: Math.min(0, gross),
    });
  }
}

// ---- Statistics ------------------------------------------------------------

export interface Drawdown {
  /** As a fraction, negative (-0.068). */
  max: number;
  /** When the deepest point was, in ms. */
  at: number;
  /** Still under the old peak at the end. */
  open: boolean;
  /** The longest time under water, in days. */
  longestDays: number;
  /** At each candle, as a fraction. */
  series: number[];
}

export function drawdown(equity: readonly number[], times: readonly number[]): Drawdown {
  let peak = equity[0] ?? 0;
  let max = 0;
  let at = times[0] ?? 0;
  let since = times[0] ?? 0;
  let longest = 0;
  let deepestIndex = 0;
  let lastPeakIndex = 0;
  const series: number[] = [];
  equity.forEach((e, i) => {
    if (e >= peak) {
      peak = e;
      since = times[i] ?? since;
      lastPeakIndex = i;
    }
    const dd = peak > 0 ? e / peak - 1 : 0;
    series.push(dd);
    if (dd < max) {
      max = dd;
      at = times[i] ?? at;
      deepestIndex = i;
    }
    longest = Math.max(longest, ((times[i] ?? since) - since) / DAY);
  });
  return { max, at, open: deepestIndex > lastPeakIndex, longestDays: longest, series };
}

/** The last equity of each UTC day, in order, with the day's start in ms. */
export function dailyEquity(
  equity: readonly number[],
  times: readonly number[],
): { day: number; equity: number }[] {
  const days: { day: number; equity: number }[] = [];
  equity.forEach((e, i) => {
    const day = Math.floor((times[i] ?? 0) / DAY) * DAY;
    const last = days.at(-1);
    if (last && last.day === day) last.equity = e;
    else days.push({ day, equity: e });
  });
  return days;
}

/** Each day's return, as a fraction, with the day's start in ms. */
export function dailyReturns(
  equity: readonly number[],
  times: readonly number[],
  start: number,
): { day: number; value: number }[] {
  let prev = start;
  return dailyEquity(equity, times).map(({ day, equity: e }) => {
    const value = prev > 0 ? e / prev - 1 : 0;
    prev = e;
    return { day, value };
  });
}

const mean = (xs: readonly number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
const deviation = (xs: readonly number[], below = false) => {
  const m = below ? 0 : mean(xs);
  const sample = below ? xs.filter((x) => x < 0) : xs;
  if (sample.length < 2) return 0;
  return Math.sqrt(sample.reduce((a, x) => a + (x - m) ** 2, 0) / (sample.length - 1));
};

export interface RunStats {
  net: number;
  /** As fractions of the capital. */
  return: number;
  buyHold: number;
  drawdown: Drawdown;
  sharpe: number;
  sortino: number;
  calmar: number;
  profitFactor: number;
  winRate: number;
  wins: number;
  losses: number;
  trades: number;
  /** Average winner over average loser. */
  winLossRatio: number;
  expectancy: number;
  expectancyR: number;
  avgWin: number;
  avgLoss: number;
  avgHoldHours: number;
  timeInMarket: number;
  fees: number;
  funding: number;
  slippage: number;
  /** Return over the held-out days, and over the days before. */
  outOfSample: number;
  inSample: number;
  days: number;
}

export function runStats(run: RunResult): RunStats {
  const { equity, trades, bars, spec } = run;
  const times = bars.map((b) => b.time);
  const end = equity.at(-1) ?? spec.capital;
  const net = end - spec.capital;
  const daily = dailyReturns(equity, times, spec.capital).map((d) => d.value);
  const sd = deviation(daily);
  const down = deviation(daily, true);
  const dd = drawdown(equity, times);
  const days = Math.max(1, ((bars.at(-1)?.time ?? 0) - (bars[0]?.time ?? 0)) / DAY);
  const ret = net / spec.capital;
  const annual = (1 + ret) ** (365 / days) - 1;
  const winners = trades.filter((t) => t.pnl > 0);
  const losers = trades.filter((t) => t.pnl <= 0);
  const grossWin = winners.reduce((a, t) => a + t.pnl, 0);
  const grossLoss = -losers.reduce((a, t) => a + t.pnl, 0);
  const avgWin = winners.length ? grossWin / winners.length : 0;
  const avgLoss = losers.length ? -grossLoss / losers.length : 0;
  const split = equity[run.holdOutFrom - 1] ?? spec.capital;
  return {
    net,
    return: ret,
    buyHold: (run.buyHold.at(-1) ?? spec.capital) / spec.capital - 1,
    drawdown: dd,
    sharpe: sd > 0 ? (mean(daily) / sd) * Math.sqrt(365) : 0,
    sortino: down > 0 ? (mean(daily) / down) * Math.sqrt(365) : 0,
    calmar: dd.max < 0 ? annual / -dd.max : 0,
    profitFactor:
      grossLoss > 0 ? grossWin / grossLoss : grossWin > 0 ? Number.POSITIVE_INFINITY : 0,
    winRate: trades.length ? winners.length / trades.length : 0,
    wins: winners.length,
    losses: losers.length,
    trades: trades.length,
    winLossRatio: avgLoss < 0 ? avgWin / -avgLoss : 0,
    expectancy: trades.length ? net / trades.length : 0,
    expectancyR: mean(trades.map((t) => t.r)),
    avgWin,
    avgLoss,
    avgHoldHours: mean(trades.map((t) => (t.closeTime - t.openTime) / HOUR)),
    timeInMarket: bars.length ? run.barsInMarket / bars.length : 0,
    fees: trades.reduce((a, t) => a + t.fees, 0),
    funding: trades.reduce((a, t) => a + t.funding, 0),
    slippage: -trades.reduce((a, t) => a + t.slippage, 0),
    outOfSample: split > 0 ? end / split - 1 : 0,
    inSample: split / spec.capital - 1,
    days,
  };
}

/** The same figures for one part of the run: the tuned days or the held-out ones. */
export interface SegmentStats {
  return: number;
  per30Days: number;
  maxDrawdown: number;
  trades: number;
  winRate: number;
  profitFactor: number;
  buyHold: number;
}

export function segmentStats(run: RunResult, outOfSample: boolean): SegmentStats {
  const from = outOfSample ? run.holdOutFrom : 0;
  const to = outOfSample ? run.equity.length : run.holdOutFrom;
  const equity = run.equity.slice(from, to);
  const start = from > 0 ? (run.equity[from - 1] as number) : run.spec.capital;
  const end = equity.at(-1) ?? start;
  const times = run.bars.slice(from, to).map((b) => b.time);
  const days = Math.max(1, ((times.at(-1) ?? 0) - (times[0] ?? 0)) / DAY);
  const trades = run.trades.filter((t) => t.outOfSample === outOfSample);
  const won = trades.filter((t) => t.pnl > 0);
  const gain = won.reduce((a, t) => a + t.pnl, 0);
  const loss = -trades.filter((t) => t.pnl <= 0).reduce((a, t) => a + t.pnl, 0);
  const firstClose = (run.bars[from] as Bar | undefined)?.close ?? 1;
  const lastClose = (run.bars[to - 1] as Bar | undefined)?.close ?? firstClose;
  const ret = start > 0 ? end / start - 1 : 0;
  return {
    return: ret,
    per30Days: (1 + ret) ** (30 / days) - 1,
    maxDrawdown: drawdown([start, ...equity], [times[0] ?? 0, ...times]).max,
    trades: trades.length,
    winRate: trades.length ? won.length / trades.length : 0,
    profitFactor: loss > 0 ? gain / loss : gain > 0 ? Number.POSITIVE_INFINITY : 0,
    buyHold: lastClose / firstClose - 1,
  };
}

// ---- Analysis --------------------------------------------------------------

/** Lower edges of the R buckets; the last is open-ended. */
export const R_BUCKETS = [-1.5, -1, -0.5, 0, 0.5, 1, 2, 3, 5] as const;

/** How many trades fall in each R bucket (from its lower edge up to the next). */
export function rBuckets(trades: readonly Trade[]): number[] {
  const counts = R_BUCKETS.map(() => 0);
  for (const t of trades) {
    let index = 0;
    for (let i = 0; i < R_BUCKETS.length; i++) if (t.r >= (R_BUCKETS[i] as number)) index = i;
    counts[index] = (counts[index] as number) + 1;
  }
  return counts;
}

export interface MonteCarlo {
  /** Bucket counts by maximum drawdown, in 2% steps from 0 down. */
  buckets: number[];
  median: number;
  /** Deeper than all but 1 in 20, and 1 in 100. */
  p95: number;
  p99: number;
  /** The share of orderings that drew down further than the run itself. */
  worseThanRun: number;
  runs: number;
}

export const MONTE_CARLO_STEP = 0.02;
export const MONTE_CARLO_BUCKETS = 12;

/** The run's trades replayed in `runs` random orders, for the range of drawdowns. */
export function monteCarlo(
  trades: readonly Trade[],
  capital: number,
  actual: number,
  runs = 1000,
  seed = 7,
): MonteCarlo {
  const random = seeded(seed);
  const pnls = trades.map((t) => t.pnl);
  const results: number[] = [];
  for (let n = 0; n < runs; n++) {
    const order = [...pnls];
    for (let i = order.length - 1; i > 0; i--) {
      const j = Math.floor(random() * (i + 1));
      [order[i], order[j]] = [order[j] as number, order[i] as number];
    }
    let equity = capital;
    let peak = capital;
    let worst = 0;
    for (const pnl of order) {
      equity += pnl;
      peak = Math.max(peak, equity);
      worst = Math.min(worst, equity / peak - 1);
    }
    results.push(worst);
  }
  const sorted = [...results].sort((a, b) => b - a);
  const at = (q: number) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] ?? 0;
  const buckets = Array.from({ length: MONTE_CARLO_BUCKETS }, () => 0);
  for (const r of results) {
    const index = Math.min(MONTE_CARLO_BUCKETS - 1, Math.floor(-r / MONTE_CARLO_STEP));
    buckets[index] = (buckets[index] as number) + 1;
  }
  return {
    buckets,
    median: at(0.5),
    p95: at(0.95),
    p99: at(0.99),
    worseThanRun: results.length ? results.filter((r) => r < actual).length / results.length : 0,
    runs,
  };
}

export const SWEEP_FAST = [5, 7, 9, 12, 15] as const;
export const SWEEP_SLOW = [20, 26, 34, 42, 55] as const;

/** Return of every fast / slow pair around an EMA run, other settings unchanged. */
export function sweep(spec: RunSpec): { fast: number; slow: number; return: number }[] {
  const base = spec.ema ?? DEFAULT_EMA;
  const cells: { fast: number; slow: number; return: number }[] = [];
  for (const slow of SWEEP_SLOW) {
    for (const fast of SWEEP_FAST) {
      const run = runBacktest({ ...spec, ema: { ...base, fast, slow } });
      cells.push({ fast, slow, return: (run.equity.at(-1) ?? spec.capital) / spec.capital - 1 });
    }
  }
  return cells;
}

export interface Readiness {
  settings: { ok: boolean; positive: number; total: number };
  outOfSample: { ok: boolean; outOfSample: number; inSample: number };
  concentration: { ok: boolean; trade?: number; share: number };
  costs: { ok: boolean; share: number };
}

/** The four checks a run passes before it's worth paper trading. */
export function readiness(
  stats: RunStats,
  trades: readonly Trade[],
  cells: readonly { return: number }[],
): Readiness {
  const positive = cells.filter((c) => c.return > 0).length;
  const best = [...trades].sort((a, b) => b.pnl - a.pnl)[0];
  const share = best && stats.net > 0 ? best.pnl / stats.net : best && best.pnl > 0 ? 1 : 0;
  const costs = -(stats.fees + stats.slippage + Math.min(0, stats.funding));
  const gross = stats.net + costs;
  const costShare = gross > 0 ? costs / gross : 1;
  return {
    settings: {
      ok: cells.length > 0 && positive / cells.length >= 0.8,
      positive,
      total: cells.length,
    },
    outOfSample: {
      ok: stats.outOfSample > 0,
      outOfSample: stats.outOfSample,
      inSample: stats.inSample,
    },
    concentration: { ok: share < 0.5, trade: best?.n, share },
    costs: { ok: costShare < 0.2, share: costShare },
  };
}

/** The run's result without its single biggest trade, as a fraction of the capital. */
export function withoutBest(stats: RunStats, trades: readonly Trade[], capital: number): number {
  const best = [...trades].sort((a, b) => b.pnl - a.pnl)[0];
  return (stats.net - (best?.pnl ?? 0)) / capital;
}

/** A run's span in days. */
export const runDays = (spec: Pick<RunSpec, "bars" | "interval">) =>
  Math.round((spec.bars * intervalMs(spec.interval)) / DAY);

/** The periods a template can be tested over: a grid sits around today's price, so its are short. */
export const PERIODS: Record<Template, readonly number[]> = {
  grid: [7, 14, 30],
  ema: [30, 90, 180],
  custom: [30, 90, 180],
};

/** The days held out of a period: about the last quarter. */
export const holdOutFor = (days: number) => Math.max(1, Math.round(days / 3.5));

/**
 * `spec` over another period, ending where it ends now: the same last
 * candle and price, so it's the same market history, longer or shorter.
 */
export function withPeriod(spec: Omit<RunSpec, "id">, days: number): Omit<RunSpec, "id"> {
  const step = intervalMs(spec.interval);
  const bars = Math.round((days * DAY) / step);
  const lastOf = (count: number) =>
    sampleBars(spec.seed, count, spec.end, step, 100).at(-1)?.close ?? 100;
  const startPrice = (spec.startPrice * lastOf(spec.bars)) / lastOf(bars);
  return { ...spec, bars, startPrice, holdOutDays: holdOutFor(days) };
}

export interface Verdict {
  checks: Readiness;
  /** How many of the four checks fail. */
  failing: number;
  /** The parameter sweep behind the settings check (EMA runs only). */
  cells: { fast: number; slow: number; return: number }[];
}

/** Whether a run is worth paper trading: the four checks, with the sweep they use. */
export function verdict(result: RunResult, stats: RunStats): Verdict {
  const cells = result.spec.template === "ema" ? sweep(result.spec) : [];
  const checks = readiness(stats, result.trades, cells.length ? cells : [{ return: stats.return }]);
  const failing = [checks.settings, checks.outOfSample, checks.concentration, checks.costs].filter(
    (c) => !c.ok,
  ).length;
  return { checks, failing, cells };
}
