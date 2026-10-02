import type { Candle, CandleInterval } from "@pewterdesk/core";

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

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** Each candle width in milliseconds. */
export const INTERVAL_MS: Record<CandleInterval, number> = {
  "1m": MINUTE,
  "3m": 3 * MINUTE,
  "5m": 5 * MINUTE,
  "15m": 15 * MINUTE,
  "30m": 30 * MINUTE,
  "1h": HOUR,
  "2h": 2 * HOUR,
  "4h": 4 * HOUR,
  "8h": 8 * HOUR,
  "12h": 12 * HOUR,
  "1d": DAY,
  "3d": 3 * DAY,
  "1w": 7 * DAY,
};

const pad = (n: number) => String(n).padStart(2, "0");

/**
 * Time left until a candle closes, as the price scale shows it: "mm:ss"
 * under an hour, "hh:mm:ss" under a day, else "Nd hh:mm". Never negative.
 */
export function formatCountdown(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const days = Math.floor(total / 86_400);
  const hours = Math.floor((total % 86_400) / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  if (days > 0) return `${days}d ${pad(hours)}:${pad(minutes)}`;
  if (hours > 0) return `${pad(hours)}:${pad(minutes)}:${pad(seconds)}`;
  return `${pad(minutes)}:${pad(seconds)}`;
}
