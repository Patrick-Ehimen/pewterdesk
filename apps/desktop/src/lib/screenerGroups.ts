import type { Market, MarketCategory, MarketSummary } from "@pewterdesk/core";
import type { HeatGroup, HeatSector } from "@pewterdesk/ui";
import { coinOf } from "./multiVenue";

// The Screener's quick groups, after Bybit's contract list: tabs by the asset
// a market settles in (USDT, USDC), and chips that keep the table to one kind
// of market - the busiest, the newly listed, the venue's own groupings and
// CoinGecko's sectors. Each only narrows what the screen already shows.

/** Listed this recently, a market counts as new. */
export const NEW_DAYS = 30;
const DAY_MS = 86_400_000;
/** "Trending": the busiest markets by the day's traded value. */
export const TRENDING_COUNT = 30;

/** CoinGecko's sectors offered as chips, in Bybit's order. */
export const SECTOR_CHIPS = [
  "memes",
  "layer1",
  "layer2",
  "ai",
  "defi",
  "realWorldAssets",
  "solana",
] as const satisfies readonly HeatSector[];
type SectorChip = (typeof SECTOR_CHIPS)[number];

/** The venue's own groupings offered as chips (Innovation Zone first, then TradFi). */
export const CATEGORY_CHIPS = [
  "innovation",
  "stock",
  "etf",
  "commodity",
  "forex",
] as const satisfies readonly MarketCategory[];
type CategoryChip = (typeof CATEGORY_CHIPS)[number];

export type ScreenerChip = "trending" | "new" | SectorChip | CategoryChip;

/** The settlement assets the venue lists, the most-used first: the tabs after "All". */
export function quoteTabs(markets: readonly Market[]): string[] {
  const counts = new Map<string, number>();
  for (const m of markets) counts.set(m.quote, (counts.get(m.quote) ?? 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([quote]) => quote);
}

/** Listed within `NEW_DAYS` of `now`; a venue that doesn't say never has a new one. */
export function isNew(market: Market, now: number): boolean {
  return market.listedAt !== undefined && now - market.listedAt < NEW_DAYS * DAY_MS;
}

/** Whole days since the market was listed, for its tag; undefined where the venue doesn't say. */
export function listedDaysAgo(market: Market, now: number): number | undefined {
  return market.listedAt === undefined
    ? undefined
    : Math.max(0, Math.floor((now - market.listedAt) / DAY_MS));
}

/** Coins in each sector, by ticker, from CoinGecko's lists. */
export function sectorCoins(groups: readonly HeatGroup[]): Map<HeatSector, Set<string>> {
  return new Map(
    groups.map((g) => [g.sector, new Set(g.coins.map((c) => c.symbol.toUpperCase()))]),
  );
}

const isSector = (chip: ScreenerChip): chip is SectorChip =>
  (SECTOR_CHIPS as readonly string[]).includes(chip);
const isCategory = (chip: ScreenerChip): chip is CategoryChip =>
  (CATEGORY_CHIPS as readonly string[]).includes(chip);

/**
 * The ids of the markets in a chip's group. A sector matches by coin, so
 * Bybit's `1000PEPE` and Hyperliquid's `kPEPE` are both PEPE; a market a
 * builder deployed (HIP-3) or that isn't crypto is in no sector.
 */
export function chipMarkets(
  chip: ScreenerChip,
  markets: readonly Market[],
  context: {
    now: number;
    summaries: ReadonlyMap<string, MarketSummary>;
    sectors: ReadonlyMap<HeatSector, ReadonlySet<string>>;
  },
): Set<string> {
  if (chip === "trending") {
    const volume = (m: Market) => Number(context.summaries.get(m.id)?.dayVolume ?? 0);
    return new Set(
      markets
        .filter((m) => volume(m) > 0)
        .sort((a, b) => volume(b) - volume(a))
        .slice(0, TRENDING_COUNT)
        .map((m) => m.id),
    );
  }
  if (chip === "new") {
    return new Set(markets.filter((m) => isNew(m, context.now)).map((m) => m.id));
  }
  if (isCategory(chip)) {
    return new Set(markets.filter((m) => m.category === chip).map((m) => m.id));
  }
  if (isSector(chip)) {
    const coins = context.sectors.get(chip);
    if (!coins) return new Set();
    return new Set(
      markets
        .filter(
          (m) =>
            !m.listedBy &&
            (m.category === undefined || m.category === "innovation") &&
            coins.has(coinOf(m.base).coin),
        )
        .map((m) => m.id),
    );
  }
  return new Set();
}

/** The chips worth showing: those with at least one market among `markets`. */
export function availableChips(
  markets: readonly Market[],
  context: Parameters<typeof chipMarkets>[2],
): ScreenerChip[] {
  const all: ScreenerChip[] = [
    "trending",
    "new",
    ...CATEGORY_CHIPS.slice(0, 1),
    ...SECTOR_CHIPS,
    ...CATEGORY_CHIPS.slice(1),
  ];
  return all.filter((chip) => chipMarkets(chip, markets, context).size > 0);
}
