import type { Market, MarketSummary } from "@pewterdesk/core";

// The Screener's top movers and price trend distribution, after Bybit's Key
// Metrics: the day's change of every market the venue lists, from the
// summaries the Screener already reads.

export interface Mover {
  market: Market;
  /** The day's change, as a fraction. */
  change: number;
}

/** Each market's change since the venue's price a day ago, where both are known. */
export function dayChanges(
  markets: readonly Market[],
  summaries: ReadonlyMap<string, MarketSummary>,
): Mover[] {
  return markets.flatMap((market) => {
    const s = summaries.get(market.id);
    if (!s) return [];
    const now = Number(s.markPrice);
    const before = Number(s.prevDayPrice);
    if (!Number.isFinite(now) || !Number.isFinite(before) || before <= 0 || now <= 0) return [];
    return [{ market, change: now / before - 1 }];
  });
}

/** The biggest gainers and losers, `count` of each, biggest first. */
export function topMovers(changes: readonly Mover[], count: number) {
  const sorted = [...changes].sort((a, b) => b.change - a.change);
  return {
    gainers: sorted.filter((m) => m.change > 0).slice(0, count),
    losers: sorted
      .filter((m) => m.change < 0)
      .reverse()
      .slice(0, count),
  };
}

/** A change this small shows as 0.00%: it counts as no change. */
const FLAT = 0.00005;

/** How many markets are up, down and unchanged on the day. */
export function trendDistribution(changes: readonly Mover[]) {
  let up = 0;
  let down = 0;
  let flat = 0;
  for (const { change } of changes) {
    if (change >= FLAT) up += 1;
    else if (change <= -FLAT) down += 1;
    else flat += 1;
  }
  return { up, down, flat };
}

/** The venue's market for a coin's ticker, if it lists one (the leader of a sector). */
export function marketForCoin(markets: readonly Market[], symbol: string) {
  const ticker = symbol.toUpperCase();
  return markets.find((m) => m.base.toUpperCase() === ticker && !m.listedBy);
}
