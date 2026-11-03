import type { HeatGroup, HeatSector } from "@pewterdesk/ui";

// The Screener's trending sectors, after Bybit's: each of CoinGecko's
// sectors (the market heatmap's) by how its largest coins moved over the
// day, weighted by market cap, with the one that moved most.

export interface SectorTrend {
  sector: HeatSector;
  /** The day's change, market-cap weighted, as a fraction. */
  change: number;
  /** The coin that rose most (or fell least): of those the venue lists, where any. */
  leader: { symbol: string; change: number };
}

/**
 * The sectors that moved most over the day, best first. `listed` says which
 * coins the venue trades: a sector's leader is the best of those, so it can
 * be opened, or its best coin of all where the venue lists none.
 */
export function trendingSectors(
  groups: readonly HeatGroup[],
  count: number,
  listed: (symbol: string) => boolean = () => false,
): SectorTrend[] {
  const trends = groups.flatMap((group) => {
    let cap = 0;
    let weighted = 0;
    let leader: SectorTrend["leader"] | undefined;
    let listedLeader: SectorTrend["leader"] | undefined;
    for (const coin of group.coins) {
      const change = coin.change24h;
      if (typeof change !== "number" || !Number.isFinite(change)) continue;
      if (coin.marketCap > 0) {
        cap += coin.marketCap;
        weighted += coin.marketCap * change;
      }
      const symbol = coin.symbol.toUpperCase();
      if (!leader || change > leader.change) leader = { symbol, change };
      if (listed(symbol) && (!listedLeader || change > listedLeader.change)) {
        listedLeader = { symbol, change };
      }
    }
    const best = listedLeader ?? leader;
    return cap > 0 && best ? [{ sector: group.sector, change: weighted / cap, leader: best }] : [];
  });
  return trends.sort((a, b) => b.change - a.change).slice(0, count);
}
