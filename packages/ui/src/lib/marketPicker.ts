import type { Market, MarketSummary } from "@pewterdesk/core";
import { matchesSearch } from "./screener";

/** The picker's tabs: starred markets, the venue's own, and builder-deployed (HIP-3). */
export type PickerTab = "favorites" | "perps" | "hip3";
export const PICKER_TABS: readonly PickerTab[] = ["favorites", "perps", "hip3"];

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

/** The tabs worth showing: HIP-3 only where the venue has builder markets. */
export function pickerTabs(markets: readonly Market[]): PickerTab[] {
  const builders = markets.some((m) => m.listedBy);
  return PICKER_TABS.filter((tab) => tab !== "hip3" || builders);
}

export function inPickerTab(row: PickerRow, tab: PickerTab, starred: ReadonlySet<string>): boolean {
  switch (tab) {
    case "favorites":
      return starred.has(row.market.id);
    case "perps":
      return !row.market.listedBy;
    case "hip3":
      return Boolean(row.market.listedBy);
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

/** Rows in the tab matching the search, sorted; rows still loading go last. */
export function pickerView(
  rows: readonly PickerRow[],
  tab: PickerTab,
  starred: ReadonlySet<string>,
  query: string,
  sort: PickerSort,
): PickerRow[] {
  const needle = query.trim();
  const dir = sort.descending ? -1 : 1;
  return rows
    .filter((r) => inPickerTab(r, tab, starred) && matchesSearch(r.market, needle))
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
