import type { VenueId } from "@pewterdesk/core";

export interface VenueInfo {
  /** A proper name, shown as-is in every language. */
  label: string;
  /** Opened when the saved market isn't listed (or on first run). */
  defaultMarket: string;
  /** Base-tier perp fees (taker / maker), for the order ticket. */
  fees: { taker: number; maker: number };
  /** The venue's default cap on how far a market order may fill from the touch. */
  maxSlippage: number;
  /** The bottom bar's tickers: BTC, ETH, SOL, BNB and the two venues' own tokens, by market id here. */
  majors: readonly string[];
}

export const VENUES: Record<VenueId, VenueInfo> = {
  // Builder-deployed (HIP-3) markets scale fees per deployer; the ticket shows none for them.
  hyperliquid: {
    label: "Hyperliquid",
    defaultMarket: "HYPE",
    fees: { taker: 0.00045, maker: 0.00015 },
    maxSlippage: 0.08,
    majors: ["BTC", "ETH", "SOL", "BNB", "HYPE", "ASTER"],
  },
  aster: {
    label: "Aster",
    defaultMarket: "BTCUSDT",
    fees: { taker: 0.00035, maker: 0.0001 },
    // Aster's `marketTakeBound` for its main markets.
    maxSlippage: 0.05,
    majors: ["BTCUSDT", "ETHUSDT", "SOLUSDT", "BNBUSDT", "HYPEUSDT", "ASTERUSDT"],
  },
};

/** In the order the venue chips show them. */
export const VENUE_IDS = Object.keys(VENUES) as VenueId[];

const STORAGE_KEY = "pd.venue";

const isVenue = (v: string | null): v is VenueId => VENUE_IDS.some((id) => id === v);

/** The venue last on screen, so a restart opens there. */
export function loadVenue(): VenueId {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    return isVenue(saved) ? saved : "hyperliquid";
  } catch {
    return "hyperliquid";
  }
}

export function saveVenue(venue: VenueId) {
  try {
    localStorage.setItem(STORAGE_KEY, venue);
  } catch {
    // Storage unavailable; the venue just won't survive a restart.
  }
}
