import type { Candle } from "@pewterdesk/core";

/** A candle as the chart draws it, in plain numbers. */
export interface DrawnCandle {
  open: number;
  high: number;
  low: number;
  close: number;
}

/**
 * A candle joined to the one before it: it opens at the previous close, with
 * high and low stretched to include that. A venue opens each candle at its
 * first trade, so on a quiet market candles float apart and one-trade
 * candles are flat dashes; joined, the series reads as one continuous line
 * of prices. Display only - the true open is still in the data.
 */
export function joinedCandle(candle: Candle, prevClose?: number): DrawnCandle {
  const high = Number(candle.high);
  const low = Number(candle.low);
  const close = Number(candle.close);
  const open = prevClose ?? Number(candle.open);
  return { open, high: Math.max(high, open), low: Math.min(low, open), close };
}

/** Every candle of a series (oldest first), joined. */
export function joinedCandles(candles: readonly Candle[]): DrawnCandle[] {
  return candles.map((c, i) => {
    const prev = candles[i - 1];
    return joinedCandle(c, prev ? Number(prev.close) : undefined);
  });
}
