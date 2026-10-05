import type { Market, VenueId } from "@pewterdesk/core";

// Where a market's logo comes from. Each venue serves its own markets'
// logos. Bybit's come from its own list too, but that list is only served
// to a connected account's key and doesn't have every coin, so its markets
// also borrow the same coin's logo from Hyperliquid or Aster.

/** Bybit's multiplied tokens: `1000PEPE` is 1,000 PEPE. */
const MULTIPLIER = /^(1000000|100000|10000|1000|100)(.+)$/;

/** A Bybit market's base coin: `BTCUSDT` and `BTCPERP` are both BTC. */
export function bybitBase(market: string): string {
  return market.replace(/(USDT|USDC|PERP)$/, "") || market;
}

/**
 * The `[venue, market]` pairs to ask for a market's logo, in order. Its own
 * venue first; for Bybit, then the coin as Hyperliquid names it (`BTC`, and
 * `kPEPE` for a thousand PEPE), then as Aster does (`BTCUSDT`).
 */
export function iconSources(venue: VenueId, market: string): [VenueId, string][] {
  if (venue !== "bybit") return [[venue, market]];
  const base = bybitBase(market);
  const [, multiplier, coin] = MULTIPLIER.exec(base) ?? [];
  const sources: [VenueId, string][] = [
    ["bybit", market],
    ["hyperliquid", base],
  ];
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

/**
 * Whether a market is a crypto coin, whose ticker CoinGecko can be asked
 * about. Not a stock, ETF, commodity or forex market, nor a builder-deployed
 * one: their tickers match unrelated coins there (AMC the cinema chain is
 * not the token of that name).
 */
export function isCryptoMarket(market: Market | undefined): market is Market {
  if (!market || market.listedBy) return false;
  return !market.category || market.category === "innovation";
}

/** Where `marketLogo` looks, each resolving to SVG markup or undefined for none. */
export interface LogoSources {
  /** A venue's own logo for one of its markets. */
  venue: (venue: VenueId, market: string) => Promise<string | undefined>;
  /** A logo that ships with the app, by base coin. */
  bundled: (base: string) => Promise<string | undefined>;
  /** CoinGecko's logo for a coin, by its ticker. */
  coin: (base: string) => Promise<string | undefined>;
}

/**
 * A market's logo, from the first place that has one: the venues
 * (`iconSources`), then the logos that ship with the app, then CoinGecko by
 * the coin's ticker. A later source is asked only when the earlier ones have
 * none, so a venue's logo is never replaced. CoinGecko is asked for crypto
 * coins only. Undefined when nobody has one; rejects, rather than say so, if
 * a source failed and no other had it, so it's tried again later.
 */
export async function marketLogo(
  venue: VenueId,
  id: string,
  market: Market | undefined,
  sources: LogoSources,
): Promise<string | undefined> {
  let failure: unknown;
  try {
    const icon = await firstIcon(iconSources(venue, id), sources.venue);
    if (icon) return icon;
  } catch (e) {
    failure = e;
  }
  try {
    const logo = await sources.bundled(market?.base ?? bybitBase(id));
    if (logo) return logo;
  } catch (e) {
    failure ??= e;
  }
  if (isCryptoMarket(market)) {
    try {
      const logo = await sources.coin(market.base);
      if (logo) return logo;
    } catch (e) {
      failure ??= e;
    }
  }
  if (failure !== undefined) throw failure;
  return undefined;
}
