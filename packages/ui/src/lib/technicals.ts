import type { Candle } from "@pewterdesk/core";
import { ema, macd, rsi, type Series, sma } from "./indicators";

// TradingView's technical rating, the one Bybit's coin pages show: fifteen
// moving averages and eleven oscillators, each a vote of buy (1), sell (-1)
// or neutral (0), by the rules TradingView publishes for its Technical
// Ratings. The moving averages' votes are averaged, the oscillators' too,
// and the summary is the mean of the two. An indicator without enough
// candles yet casts no vote. A reading of where the indicators stand, not a
// forecast.

export type Vote = 1 | -1 | 0;

export type MaIndicator =
  | "ema10"
  | "sma10"
  | "ema20"
  | "sma20"
  | "ema30"
  | "sma30"
  | "ema50"
  | "sma50"
  | "ema100"
  | "sma100"
  | "ema200"
  | "sma200"
  | "ichimoku"
  | "vwma20"
  | "hma9";

export type OscIndicator =
  | "rsi"
  | "stoch"
  | "cci"
  | "adx"
  | "ao"
  | "mom"
  | "macd"
  | "stochRsi"
  | "wr"
  | "bbp"
  | "uo";

/** Each indicator that could be read, with its vote. */
export interface TechBreakdown {
  ma: Partial<Record<MaIndicator, Vote>>;
  osc: Partial<Record<OscIndicator, Vote>>;
}

const last = (s: Series, back = 0) => s[s.length - 1 - back];
const sign = (v: number): Vote => (v > 0 ? 1 : v < 0 ? -1 : 0);

/** An average below the close is a buy, above it a sell. */
const maVote = (average: number | undefined, close: number): Vote | undefined =>
  average === undefined ? undefined : sign(close - average);

function rolling(
  values: readonly number[],
  period: number,
  pick: (a: number, b: number) => number,
) {
  return values.map((_, i) => {
    if (i < period - 1) return undefined;
    let out = values[i] as number;
    for (let j = i - period + 1; j < i; j++) out = pick(out, values[j] as number);
    return out;
  });
}

/** Weighted moving average: the latest weighs `period`, the oldest 1. */
function wma(values: readonly (number | undefined)[], period: number): Series {
  const weight = (period * (period + 1)) / 2;
  return values.map((_, i) => {
    if (i < period - 1) return undefined;
    let sum = 0;
    for (let j = 0; j < period; j++) {
      const v = values[i - j];
      if (v === undefined) return undefined;
      sum += v * (period - j);
    }
    return sum / weight;
  });
}

/** Wilder's moving average, seeded with the simple average of the first `period`. */
function rma(values: readonly (number | undefined)[], period: number): Series {
  const out: Series = [];
  let prev: number | undefined;
  let seed: number[] = [];
  for (const v of values) {
    if (v === undefined) {
      out.push(undefined);
      continue;
    }
    if (prev === undefined) {
      seed.push(v);
      if (seed.length < period) {
        out.push(undefined);
        continue;
      }
      prev = seed.reduce((a, b) => a + b, 0) / period;
      seed = [];
    } else {
      prev = (prev * (period - 1) + v) / period;
    }
    out.push(prev);
  }
  return out;
}

/** Stochastic of `values` over `period`, 0 to 100; highs and lows default to the values. */
function stochOf(
  values: readonly (number | undefined)[],
  period: number,
  highs: readonly (number | undefined)[] = values,
  lows: readonly (number | undefined)[] = values,
): Series {
  return values.map((v, i) => {
    if (v === undefined || i < period - 1) return undefined;
    let hi = Number.NEGATIVE_INFINITY;
    let lo = Number.POSITIVE_INFINITY;
    for (let j = i - period + 1; j <= i; j++) {
      const h = highs[j];
      const l = lows[j];
      if (h === undefined || l === undefined) return undefined;
      hi = Math.max(hi, h);
      lo = Math.min(lo, l);
    }
    return hi === lo ? 50 : (100 * (v - lo)) / (hi - lo);
  });
}

/** The simple average of a series that may start with gaps. */
function smaOf(values: readonly (number | undefined)[], period: number): Series {
  return values.map((_, i) => {
    if (i < period - 1) return undefined;
    let sum = 0;
    for (let j = i - period + 1; j <= i; j++) {
      const v = values[j];
      if (v === undefined) return undefined;
      sum += v;
    }
    return sum / period;
  });
}

/** Each indicator's vote on the latest candle. */
export function techBreakdown(candles: readonly Candle[]): TechBreakdown {
  const close = candles.map((c) => Number(c.close));
  const high = candles.map((c) => Number(c.high));
  const low = candles.map((c) => Number(c.low));
  const volume = candles.map((c) => Number(c.volume));
  const price = close[close.length - 1] as number;
  const ma: TechBreakdown["ma"] = {};
  const osc: TechBreakdown["osc"] = {};
  const put = <K extends string>(
    into: Partial<Record<K, Vote>>,
    key: K,
    vote: Vote | undefined,
  ) => {
    if (vote !== undefined) into[key] = vote;
  };
  if (close.length < 2) return { ma, osc };

  for (const period of [10, 20, 30, 50, 100, 200] as const) {
    put(ma, `ema${period}`, maVote(last(ema(close, period)), price));
    put(ma, `sma${period}`, maVote(last(sma(close, period)), price));
  }

  // Ichimoku (9, 26, 52): a vote only on the cross TradingView names.
  const mid = (period: number) => {
    const hh = rolling(high, period, Math.max);
    const ll = rolling(low, period, Math.min);
    return hh.map((h, i) =>
      h === undefined || ll[i] === undefined ? undefined : (h + (ll[i] as number)) / 2,
    );
  };
  const conversion = last(mid(9));
  const base = last(mid(26));
  const lead2 = last(mid(52));
  const before = close[close.length - 2] as number;
  if (conversion !== undefined && base !== undefined && lead2 !== undefined) {
    const lead1 = (conversion + base) / 2;
    const up =
      lead1 > lead2 && price > lead1 && price < base && before < conversion && price > conversion;
    const down =
      lead2 > lead1 && price < lead2 && price > base && before > conversion && price < conversion;
    ma.ichimoku = up ? 1 : down ? -1 : 0;
  }

  // Volume-weighted moving average (20).
  if (close.length >= 20) {
    let pv = 0;
    let v = 0;
    for (let i = close.length - 20; i < close.length; i++) {
      pv += (close[i] as number) * (volume[i] as number);
      v += volume[i] as number;
    }
    if (v > 0) ma.vwma20 = sign(price - pv / v);
  }

  // Hull moving average (9).
  const half = wma(close, 4);
  const full = wma(close, 9);
  const hull = wma(
    half.map((h, i) =>
      h === undefined || full[i] === undefined ? undefined : 2 * h - (full[i] as number),
    ),
    3,
  );
  put(ma, "hma9", maVote(last(hull), price));

  // The oscillators that read the trend: up over the 50 average, down under it.
  const trendLine = last(sma(close, 50));
  const upTrend = trendLine !== undefined && price > trendLine;
  const downTrend = trendLine !== undefined && price < trendLine;

  const rsiLine = rsi(close, 14);
  const [r, r1] = [last(rsiLine), last(rsiLine, 1)];
  if (r !== undefined && r1 !== undefined) {
    osc.rsi = r < 30 && r > r1 ? 1 : r > 70 && r < r1 ? -1 : 0;
  }

  const k = smaOf(stochOf(close, 14, high, low), 3);
  const d = smaOf(k, 3);
  const [k0, d0, k1, d1] = [last(k), last(d), last(k, 1), last(d, 1)];
  if (k0 !== undefined && d0 !== undefined && k1 !== undefined && d1 !== undefined) {
    osc.stoch =
      k0 < 20 && d0 < 20 && k0 > d0 && k1 < d1
        ? 1
        : k0 > 80 && d0 > 80 && k0 < d0 && k1 > d1
          ? -1
          : 0;
  }

  // CCI (20), on the typical price.
  const typical = close.map((c, i) => ((high[i] as number) + (low[i] as number) + c) / 3);
  const typicalAvg = sma(typical, 20);
  const cciLine = typical.map((tp, i) => {
    const avg = typicalAvg[i];
    if (avg === undefined) return undefined;
    let dev = 0;
    for (let j = i - 19; j <= i; j++) dev += Math.abs((typical[j] as number) - avg);
    dev /= 20;
    return dev === 0 ? 0 : (tp - avg) / (0.015 * dev);
  });
  const [c0, c1] = [last(cciLine), last(cciLine, 1)];
  if (c0 !== undefined && c1 !== undefined) {
    osc.cci = c0 < -100 && c0 > c1 ? 1 : c0 > 100 && c0 < c1 ? -1 : 0;
  }

  // ADX (14) with its directional lines, Wilder's smoothing throughout.
  const plusDm: Series = [undefined];
  const minusDm: Series = [undefined];
  const trueRange: Series = [undefined];
  for (let i = 1; i < close.length; i++) {
    const upMove = (high[i] as number) - (high[i - 1] as number);
    const downMove = (low[i - 1] as number) - (low[i] as number);
    plusDm.push(upMove > downMove && upMove > 0 ? upMove : 0);
    minusDm.push(downMove > upMove && downMove > 0 ? downMove : 0);
    trueRange.push(
      Math.max(
        (high[i] as number) - (low[i] as number),
        Math.abs((high[i] as number) - (close[i - 1] as number)),
        Math.abs((low[i] as number) - (close[i - 1] as number)),
      ),
    );
  }
  const tr14 = rma(trueRange, 14);
  const plusDi = rma(plusDm, 14).map((v, i) =>
    v === undefined || !tr14[i] ? undefined : (100 * v) / (tr14[i] as number),
  );
  const minusDi = rma(minusDm, 14).map((v, i) =>
    v === undefined || !tr14[i] ? undefined : (100 * v) / (tr14[i] as number),
  );
  const dx = plusDi.map((p, i) => {
    const m = minusDi[i];
    if (p === undefined || m === undefined) return undefined;
    return p + m === 0 ? 0 : (100 * Math.abs(p - m)) / (p + m);
  });
  const adxLine = rma(dx, 14);
  const [a0, p0, m0, p1, m1] = [
    last(adxLine),
    last(plusDi),
    last(minusDi),
    last(plusDi, 1),
    last(minusDi, 1),
  ];
  if (
    a0 !== undefined &&
    p0 !== undefined &&
    m0 !== undefined &&
    p1 !== undefined &&
    m1 !== undefined
  ) {
    osc.adx = a0 > 20 && p1 < m1 && p0 > m0 ? 1 : a0 > 20 && p1 > m1 && p0 < m0 ? -1 : 0;
  }

  // Awesome oscillator: the 5 and 34 averages of the bar's midpoint.
  const hl2 = high.map((h, i) => (h + (low[i] as number)) / 2);
  const fast = sma(hl2, 5);
  const slow = sma(hl2, 34);
  const ao = fast.map((f, i) =>
    f === undefined || slow[i] === undefined ? undefined : f - (slow[i] as number),
  );
  const [ao0, ao1, ao2] = [last(ao), last(ao, 1), last(ao, 2)];
  if (ao0 !== undefined && ao1 !== undefined && ao2 !== undefined) {
    const up = (ao0 > 0 && ao1 < 0) || (ao0 > 0 && ao1 > 0 && ao0 > ao1 && ao2 > ao1);
    const down = (ao0 < 0 && ao1 > 0) || (ao0 < 0 && ao1 < 0 && ao0 < ao1 && ao2 < ao1);
    osc.ao = up ? 1 : down ? -1 : 0;
  }

  // Momentum (10).
  if (close.length > 11) {
    const at = (back: number) =>
      (close[close.length - 1 - back] as number) - (close[close.length - 11 - back] as number);
    osc.mom = sign(at(0) - at(1));
  }

  const m = macd(close, 12, 26, 9).at(-1);
  if (m?.macd !== undefined && m.signal !== undefined) osc.macd = sign(m.macd - m.signal);

  // Stochastic RSI (3, 3, 14, 14): a buy only in a downtrend, a sell only in an uptrend.
  const sk = smaOf(stochOf(rsiLine, 14), 3);
  const sd = smaOf(sk, 3);
  const [sk0, sd0] = [last(sk), last(sd)];
  if (sk0 !== undefined && sd0 !== undefined) {
    osc.stochRsi =
      downTrend && sk0 < 20 && sd0 < 20 && sk0 > sd0
        ? 1
        : upTrend && sk0 > 80 && sd0 > 80 && sk0 < sd0
          ? -1
          : 0;
  }

  // Williams %R (14).
  const wr = stochOf(close, 14, high, low).map((v) => (v === undefined ? undefined : v - 100));
  const [w0, w1] = [last(wr), last(wr, 1)];
  if (w0 !== undefined && w1 !== undefined) {
    osc.wr = w0 < -80 && w0 > w1 ? 1 : w0 > -20 && w0 < w1 ? -1 : 0;
  }

  // Bull bear power: the bar's high and low against the 13 average.
  const e13 = ema(close, 13);
  const [e0, e1] = [last(e13), last(e13, 1)];
  if (e0 !== undefined && e1 !== undefined) {
    const bear0 = (low[low.length - 1] as number) - e0;
    const bear1 = (low[low.length - 2] as number) - e1;
    const bull0 = (high[high.length - 1] as number) - e0;
    const bull1 = (high[high.length - 2] as number) - e1;
    osc.bbp =
      upTrend && bear0 < 0 && bear0 > bear1 ? 1 : downTrend && bull0 > 0 && bull0 < bull1 ? -1 : 0;
  }

  // Ultimate oscillator (7, 14, 28).
  if (close.length > 28) {
    const average = (period: number) => {
      let bp = 0;
      let tr = 0;
      for (let i = close.length - period; i < close.length; i++) {
        const floor = Math.min(low[i] as number, close[i - 1] as number);
        bp += (close[i] as number) - floor;
        tr += Math.max(high[i] as number, close[i - 1] as number) - floor;
      }
      return tr === 0 ? 0 : bp / tr;
    };
    const uo = (100 * (4 * average(7) + 2 * average(14) + average(28))) / 7;
    osc.uo = uo > 70 ? 1 : uo < 30 ? -1 : 0;
  }

  return { ma, osc };
}

const mean = (votes: readonly Vote[]) =>
  votes.length === 0 ? undefined : votes.reduce<number>((a, b) => a + b, 0) / votes.length;

/** The two groups' scores and the summary, each from -1 to 1. */
export function techScores(breakdown: TechBreakdown) {
  const ma = mean(Object.values(breakdown.ma));
  const osc = mean(Object.values(breakdown.osc));
  if (ma === undefined || osc === undefined) return undefined;
  return { ma, osc, all: (ma + osc) / 2 };
}
