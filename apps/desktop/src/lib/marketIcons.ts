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
 * The first logo any source has. Undefined only when every source answered
 * that it has none; if one failed (a timeout, a rate limit, offline) and no
 * other had a logo, this rejects instead, so the "no logo" isn't saved for a
 * week and the next look tries again.
 */
export async function firstIcon(
  sources: [VenueId, string][],
  fetchIcon: (venue: VenueId, market: string) => Promise<string | undefined>,
): Promise<string | undefined> {
  let failure: unknown;
  for (const [venue, market] of sources) {
    try {
      const icon = await fetchIcon(venue, market);
      if (icon) return icon;
    } catch (e) {
      // Try the next; remember it failed rather than had nothing.
      failure ??= e;
    }
  }
  if (failure !== undefined) throw failure;
  return undefined;
}
