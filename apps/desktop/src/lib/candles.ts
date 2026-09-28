import type { Candle } from "@pewterdesk/core";

/**
 * Candles kept per series; older ones fall off the left. Room for all the
 * history a venue keeps (Hyperliquid: about 5,000 per interval) once a chart
 * has been scrolled all the way back.
 */
export const MAX_CANDLES = 6000;

/**
 * Folds live candle updates into a series (oldest first). Each update is a
 * whole candle: the forming one is replaced, a newer one is appended, and an
 * older one (a late replay) replaces its match or is dropped.
 */
export function mergeCandles(series: readonly Candle[], updates: readonly Candle[]): Candle[] {
  const next = [...series];
  for (const candle of updates) {
    const last = next.at(-1);
    if (!last || candle.openTime > last.openTime) {
      next.push(candle);
    } else if (candle.openTime === last.openTime) {
      next[next.length - 1] = candle;
    } else {
      const i = next.findIndex((c) => c.openTime === candle.openTime);
      if (i !== -1) next[i] = candle;
    }
  }
  return next.length > MAX_CANDLES ? next.slice(next.length - MAX_CANDLES) : next;
}

/**
 * Older candles joined on the left of a series (both oldest first): only
 * those strictly older than the series' first, so an overlapping page can't
 * duplicate or reorder anything. The count added is how far the view moves.
 */
export function prependCandles(
  series: readonly Candle[],
  older: readonly Candle[],
): { series: Candle[]; added: number } {
  const first = series[0]?.openTime ?? Number.POSITIVE_INFINITY;
  const fresh = older.filter((c) => c.openTime < first);
  return { series: [...fresh, ...series], added: fresh.length };
}
