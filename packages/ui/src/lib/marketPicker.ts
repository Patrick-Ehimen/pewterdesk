import type { Market, MarketSummary } from "@pewterdesk/core";
import { matchesSearch } from "./screener";

/**
 * The picker's tabs, after the venues' own market lists: starred markets,
 * all of the venue's own, what's moving, what's new, the venue's categories
 * (Bybit's Innovation Zone, stocks, ETFs, commodities, forex), and
 * builder-deployed markets (HIP-3).
 */
export type PickerTab =
  | "favorites"
  | "perps"
  | "trending"
  | "new"
  | "innovation"
  | "stock"
  | "etf"
  | "commodity"
  | "forex"
  | "hip3";
export const PICKER_TABS: readonly PickerTab[] = [
  "favorites",
  "perps",
  "trending",
  "new",
  "innovation",
  "stock",
  "etf",
  "commodity",
  "forex",
  "hip3",
];
/** The tabs that are one of the venue's own categories. */
const CATEGORY_TABS = ["innovation", "stock", "etf", "commodity", "forex"] as const;
/** A market counts as new for this long after it's listed. */
export const NEW_FOR_MS = 30 * 24 * 60 * 60 * 1000;
/** How many markets Trending shows: the biggest 24h moves among the more traded half. */
export const TRENDING = 30;

export type PickerSortKey = "name" | "price" | "change" | "funding" | "volume" | "oi";
export interface PickerSort {
  by: PickerSortKey;
  descending: boolean;
}

/** The quick filters above the list, each a preset sort. */
export type PickerPreset = "top" | "gainers" | "losers";
export const PICKER_PRESETS: Record<PickerPreset, PickerSort> = {
  top: { by: "volume", descending: true },
  gainers: { by: "change", descending: true },
  losers: { by: "change", descending: false },
};

export interface PickerRow {
  market: Market;
  /** Unset until the market's summary arrives. */
  price?: number;
  /** As the venue sent it, for its decimals. */
  rawPrice?: string;
  /** Fraction, e.g. 0.0107 for +1.07%. */
  change24h?: number;
  /** The same move in price terms. */
  changeAbs?: number;
  /** The current interval's rate, as a fraction. */
  funding?: number;
  /** Length of that interval, in seconds (1h on Hyperliquid, 4h or 8h on Aster). */
  fundingIntervalSecs?: number;
  /** 24h notional volume. */
  volume?: number;
  /** Open interest in the quote asset (size times mark). */
  openInterest?: number;
}

export function pickerRows(
  markets: readonly Market[],
  summaries: readonly MarketSummary[] = [],
): PickerRow[] {
  const byId = new Map(summaries.map((s) => [s.market, s]));
  return markets.map((market) => {
    const s = byId.get(market.id);
    if (!s) return { market };
    const price = Number(s.markPrice);
    const prev = Number(s.prevDayPrice);
    return {
      market,
      price,
      rawPrice: s.markPrice,
      change24h: prev > 0 ? (price - prev) / prev : undefined,
      changeAbs: prev > 0 ? price - prev : undefined,
      funding: Number(s.fundingRate),
      fundingIntervalSecs: s.fundingIntervalSecs,
      volume: Number(s.dayVolume),
      openInterest: Number(s.openInterest) * price,
    };
  });
}

const isNew = (market: Market, now: number) =>
  market.listedAt !== undefined && now - market.listedAt < NEW_FOR_MS;

/**
 * The tabs worth showing: New, each category and HIP-3 only where the venue
 * has such markets.
 */
export function pickerTabs(markets: readonly Market[], now = Date.now()): PickerTab[] {
  return PICKER_TABS.filter((tab) => {
    if (tab === "hip3") return markets.some((m) => m.listedBy);
    if (tab === "new") return markets.some((m) => isNew(m, now));
    const category = CATEGORY_TABS.find((c) => c === tab);
    return !category || markets.some((m) => m.category === category);
  });
}

/** The quote coins the venue's markets come in, the most used first. */
export function pickerQuotes(markets: readonly Market[]): string[] {
  const counts = new Map<string, number>();
  for (const m of markets) counts.set(m.quote, (counts.get(m.quote) ?? 0) + 1);
  return [...counts].sort((a, b) => b[1] - a[1]).map(([quote]) => quote);
}

/**
 * The markets Trending shows: the biggest 24h moves, either way, among the
 * more traded half, so a coin nobody trades doesn't top it on one print.
 */
export function trendingIds(rows: readonly PickerRow[]): Set<string> {
  const priced = rows.filter((r) => r.change24h !== undefined && r.volume !== undefined);
  const volumes = priced.map((r) => r.volume as number).sort((a, b) => a - b);
  const median = volumes[Math.floor(volumes.length / 2)] ?? 0;
  return new Set(
    priced
      .filter((r) => (r.volume as number) >= median)
      .sort((a, b) => Math.abs(b.change24h as number) - Math.abs(a.change24h as number))
      .slice(0, TRENDING)
      .map((r) => r.market.id),
  );
}

export function inPickerTab(
  row: PickerRow,
  tab: PickerTab,
  starred: ReadonlySet<string>,
  context: { now: number; trending: ReadonlySet<string> } = {
    now: Date.now(),
    trending: new Set(),
  },
): boolean {
  switch (tab) {
    case "favorites":
      return starred.has(row.market.id);
    case "perps":
      return !row.market.listedBy;
    case "trending":
      return context.trending.has(row.market.id);
    case "new":
      return isNew(row.market, context.now);
    case "hip3":
      return Boolean(row.market.listedBy);
    default:
      return row.market.category === tab;
  }
}

const sortValue = (row: PickerRow, by: PickerSortKey): number | string | undefined => {
  switch (by) {
    case "name":
      return row.market.symbol;
    case "price":
      return row.price;
    case "change":
      return row.change24h;
    case "funding":
      return row.funding;
    case "volume":
      return row.volume;
    case "oi":
      return row.openInterest;
  }
};

/**
 * Rows in the tab matching the search, sorted; rows still loading go last.
 * `quote` keeps only the markets quoted in that coin.
 */
export function pickerView(
  rows: readonly PickerRow[],
  tab: PickerTab,
  starred: ReadonlySet<string>,
  query: string,
  sort: PickerSort,
  options: { quote?: string; now?: number } = {},
): PickerRow[] {
  const needle = query.trim();
  const dir = sort.descending ? -1 : 1;
  const quoted = options.quote ? rows.filter((r) => r.market.quote === options.quote) : rows;
  const context = {
    now: options.now ?? Date.now(),
    trending: tab === "trending" ? trendingIds(quoted) : new Set<string>(),
  };
  return quoted
    .filter((r) => inPickerTab(r, tab, starred, context) && matchesSearch(r.market, needle))
    .sort((a, b) => {
      const x = sortValue(a, sort.by);
      const y = sortValue(b, sort.by);
      if (x === undefined || y === undefined) {
        return x === undefined ? (y === undefined ? 0 : 1) : -1;
      }
      if (typeof x === "string" || typeof y === "string") {
        return dir * String(x).localeCompare(String(y));
      }
      return dir * (x - y);
    });
}

/** The quick filter a sort corresponds to, if any, for highlighting its chip. */
export function presetOf(sort: PickerSort): PickerPreset | undefined {
  return (Object.keys(PICKER_PRESETS) as PickerPreset[]).find(
    (p) => PICKER_PRESETS[p].by === sort.by && PICKER_PRESETS[p].descending === sort.descending,
  );
}
