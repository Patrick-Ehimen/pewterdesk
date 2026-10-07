// Plain logic behind the Maps page's RSI heatmap: RSI zones and timeframes.

import { rsi } from "./screener";

export type RsiZone = "overbought" | "strong" | "neutral" | "weak" | "oversold";
export const RSI_ZONES: readonly RsiZone[] = [
  "overbought",
  "strong",
  "neutral",
  "weak",
  "oversold",
];

/** Coinglass's bands: 70+ overbought, 60-70 strong, 40-60 neutral, 30-40 weak, under 30 oversold. */
export function rsiZone(value: number): RsiZone {
  if (value >= 70) return "overbought";
  if (value >= 60) return "strong";
  if (value > 40) return "neutral";
  if (value > 30) return "weak";
  return "oversold";
}

/** The timeframes the heatmap offers, as coinglass does. */
export type RsiFrame = "5m" | "15m" | "1h" | "4h" | "12h" | "1d" | "1w";
export const RSI_FRAMES: readonly RsiFrame[] = ["5m", "15m", "1h", "4h", "12h", "1d", "1w"];

/** Candles fetched per market: enough for RSI(14) now and one candle earlier, with margin. */
export const RSI_CANDLES = 50;

/** RSI(14) at the latest close and at the one before, or undefined without enough closes. */
export function rsiNowAndBefore(
  closes: readonly number[],
): { value: number; previous?: number } | undefined {
  const value = rsi(closes);
  if (value === undefined) return undefined;
  return { value, previous: rsi(closes.slice(0, -1)) };
}
