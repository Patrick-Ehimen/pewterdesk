import type { VenueId } from "@pewterdesk/core";

// Where a market's logo comes from. Each venue serves its own markets'
// logos, except Bybit, which has none to serve: its markets borrow the same
// coin's logo from Hyperliquid or Aster, so no new host is needed.

/** Bybit's multiplied tokens: `1000PEPE` is 1,000 PEPE. */
const MULTIPLIER = /^(1000000|100000|10000|1000|100)(.+)$/;

/** A Bybit market's base coin: `BTCUSDT` and `BTCPERP` are both BTC. */
export function bybitBase(market: string): string {
  return market.replace(/(USDT|USDC|PERP)$/, "") || market;
}

/**
 * The `[venue, market]` pairs to ask for a market's logo, in order. Its own
 * venue first; for Bybit, the coin as Hyperliquid names it (`BTC`, and
 * `kPEPE` for a thousand PEPE), then as Aster does (`BTCUSDT`).
 */
export function iconSources(venue: VenueId, market: string): [VenueId, string][] {
  if (venue !== "bybit") return [[venue, market]];
  const base = bybitBase(market);
  const [, multiplier, coin] = MULTIPLIER.exec(base) ?? [];
  const sources: [VenueId, string][] = [["hyperliquid", base]];
  if (coin) {
    sources.push(["hyperliquid", coin]);
    if (multiplier === "1000") sources.push(["hyperliquid", `k${coin}`]);
  }
  sources.push(["aster", `${base}USDT`]);
  if (coin) sources.push(["aster", `${coin}USDT`]);
  return sources;
}

/**
 * The first logo any source has, or undefined. A source that fails (an id
 * that venue doesn't list) just moves on to the next.
 */
export async function firstIcon(
  sources: [VenueId, string][],
  fetchIcon: (venue: VenueId, market: string) => Promise<string | undefined>,
): Promise<string | undefined> {
  for (const [venue, market] of sources) {
    try {
      const icon = await fetchIcon(venue, market);
      if (icon) return icon;
    } catch {
      // Not listed there; try the next.
    }
  }
  return undefined;
}
