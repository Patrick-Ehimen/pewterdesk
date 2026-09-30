import type { VenueId } from "@pewterdesk/core";

// Hyperliquid keeps the original key, so a market saved before there were
// other venues still opens.
const keyFor = (venue: VenueId) => (venue === "hyperliquid" ? "pd.market" : `pd.market.${venue}`);

// A market id (e.g. "HYPE", "xyz:TSLA") is public, so browser storage is fine.
// An id the venue no longer lists just falls back to the default market.
export function loadMarket(venue: VenueId = "hyperliquid"): string | undefined {
  try {
    return localStorage.getItem(keyFor(venue)) || undefined;
  } catch {
    return undefined;
  }
}

export function saveMarket(id: string, venue: VenueId = "hyperliquid") {
  try {
    localStorage.setItem(keyFor(venue), id);
  } catch {
    // Storage unavailable; the market just won't survive a restart.
  }
}
