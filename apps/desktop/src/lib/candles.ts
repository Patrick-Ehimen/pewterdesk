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
 * The venue's newest page over a series (both oldest first). The page wins
 * where they overlap, however far back it reaches, and what the series has
 * either side of it stays. A page that doesn't meet the series takes its
 * place: `span` is the most a candle can be from the next, and joining across
 * more would close up the missing time on the chart.
 */
export function joinNewestPage(
  series: readonly Candle[],
  page: readonly Candle[],
  span: number,
): Candle[] {
  const first = page[0];
  const last = page.at(-1);
  const held = series.at(-1);
  if (!first || !last) return [...series];
  if (!held || first.openTime - held.openTime > span) return [...page];
  const joined = [
    ...series.filter((c) => c.openTime < first.openTime),
    ...page,
    ...series.filter((c) => c.openTime > last.openTime),
  ];
  return joined.length > MAX_CANDLES ? joined.slice(joined.length - MAX_CANDLES) : joined;
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
