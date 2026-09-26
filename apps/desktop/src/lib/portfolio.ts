import type { AccountSnapshot, VenueId } from "@pewterdesk/core";

// Display-only arithmetic over an account snapshot: these go through JS
// numbers, which is fine for showing totals and never for anything signed.

export interface AssetExposure {
  /** `Market::id` the position is in. */
  market: string;
  venue: VenueId;
  /** Signed: positive long, negative short, in base units. */
  netSize: number;
  /** Signed notional at the mark price, in the quote asset. */
  netNotional: number;
  /** This asset's |notional| over the gross, 0–1. */
  share: number;
}

export interface PortfolioSummary {
  equity: number;
  unrealizedPnl: number;
  marginUsed: number;
  /** Margin used over equity; 0 without equity. */
  marginRatio: number;
  /** Sum of |notional| across positions. */
  gross: number;
  /** Gross over equity; 0 without equity. */
  grossRatio: number;
  /** Signed sum of notional: positive is a long bias. */
  net: number;
  positions: number;
  /** Largest exposure first. */
  byAsset: AssetExposure[];
}

export function portfolioSummary(snapshot: AccountSnapshot): PortfolioSummary {
  const equity = Number(snapshot.equity);
  const byMarket = new Map<string, { netSize: number; netNotional: number }>();
  let unrealizedPnl = 0;
  let marginUsed = 0;
  for (const p of snapshot.positions) {
    const sign = p.side === "long" ? 1 : -1;
    const size = Number(p.size) * sign;
    const entry = byMarket.get(p.market) ?? { netSize: 0, netNotional: 0 };
    entry.netSize += size;
    entry.netNotional += size * Number(p.markPrice);
    byMarket.set(p.market, entry);
    unrealizedPnl += Number(p.unrealizedPnl);
    marginUsed += Number(p.margin);
  }

  const assets = [...byMarket].map(([market, e]) => ({ market, ...e }));
  const gross = assets.reduce((sum, a) => sum + Math.abs(a.netNotional), 0);
  const net = assets.reduce((sum, a) => sum + a.netNotional, 0);
  return {
    equity,
    unrealizedPnl,
    marginUsed,
    marginRatio: equity > 0 ? marginUsed / equity : 0,
    gross,
    grossRatio: equity > 0 ? gross / equity : 0,
    net,
    positions: snapshot.positions.length,
    byAsset: assets
      .map((a) => ({
        ...a,
        venue: snapshot.venue,
        share: gross > 0 ? Math.abs(a.netNotional) / gross : 0,
      }))
      .sort((a, b) => Math.abs(b.netNotional) - Math.abs(a.netNotional)),
  };
}
