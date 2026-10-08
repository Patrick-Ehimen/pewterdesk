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
 *
 * A ticker alone doesn't make it the same asset (Bybit's PURR is a
 * company's shares, Hyperliquid's a memecoin): `marketLogo` only uses
 * another venue's logo once `sameAsset` agrees.
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
 * How many of `source`'s units one unit of the Bybit market `base` is: 1 for
 * the same name, the multiplier for the plain coin (`1000PEPE` against
 * `PEPE`), and that over a thousand for Hyperliquid's `k` (`kPEPE`).
 */
export function unitsOf(base: string, source: string): number {
  const [, multiplier, coin] = MULTIPLIER.exec(base) ?? [];
  const name = source.replace(/USDT$/, "");
  if (!coin || name === base) return 1;
  if (name === `k${coin}`) return Number(multiplier) / 1000;
  return name === coin ? Number(multiplier) : 1;
}

/** Prices this far apart aren't one asset's (venues differ by a percent or two). */
const SAME_PRICE = 0.2;

/**
 * Whether two markets are the same asset, by their prices: `ours` for one
 * unit here, `theirs` for one there, `units` of theirs to one of ours.
 * Undefined when either price isn't known.
 */
export function sameAsset(
  ours: number | undefined,
  theirs: number | undefined,
  units = 1,
): boolean | undefined {
  if (!ours || !theirs || !(ours > 0) || !(theirs > 0) || !(units > 0)) return undefined;
  return Math.abs(ours / (theirs * units) - 1) <= SAME_PRICE;
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

/**
 * Whether CoinGecko's coin is a different asset from the market with base
 * `base`, going by what one coin is worth there (market cap over supply)
 * against the market's `price`. The price may be for a thousand or a
 * million of the coin (`1000PEPE`, Hyperliquid's `kPEPE`), so it's another
 * coin only if no such reading fits. Never when a figure is missing.
 */
export function isAnotherCoin(
  info: { marketCap: number | null; circulatingSupply: number | null },
  base: string,
  price: number | undefined,
): boolean {
  const each =
    info.marketCap && info.circulatingSupply ? info.marketCap / info.circulatingSupply : undefined;
  if (!each || !price) return false;
  const [, multiplier] = MULTIPLIER.exec(base) ?? [];
  const units = [1];
  if (multiplier) units.push(Number(multiplier));
  if (/^k[A-Z]/.test(base)) units.push(1000);
  return units.every((u) => sameAsset(price, each, u) === false);
}

/** Where `marketLogo` looks, each resolving to SVG markup or undefined for none. */
export interface LogoSources {
  /** A venue's own logo for one of its markets. */
  venue: (venue: VenueId, market: string) => Promise<string | undefined>;
  /** A logo that ships with the app, by base coin. */
  bundled: (base: string) => Promise<string | undefined>;
  /** CoinGecko's logo for a coin, by its ticker. */
  coin: (base: string) => Promise<string | undefined>;
  /** A market's last known price on a venue, to tell same-named assets apart. */
  price?: (venue: VenueId, market: string) => number | undefined;
}

/**
 * A market's logo, from the first place that has one: the venues
 * (`iconSources`), then the logos that ship with the app, then CoinGecko by
 * the coin's ticker. A later source is asked only when the earlier ones have
 * none, so a venue's logo is never replaced.
 *
 * Another venue's logo is used only for the same asset, which a shared
 * ticker doesn't settle: the two markets have to trade at the same price
 * (`sameAsset`). Where a price isn't known, a crypto coin's ticker is
 * trusted as before, and a stock's, ETF's, commodity's or forex pair's
 * isn't. CoinGecko is asked for crypto coins only. Undefined when nobody has one; rejects, rather than say so, if
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
    // Until the market is known, it's taken for a coin.
    const trusted = market === undefined || isCryptoMarket(market);
    const ours = sources.price?.(venue, id);
    const from = iconSources(venue, id).filter(([v, m]) => {
      if (v === venue) return true;
      const same = sameAsset(ours, sources.price?.(v, m), unitsOf(bybitBase(id), m));
      return same ?? trusted;
    });
    const icon = await firstIcon(from, sources.venue);
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
