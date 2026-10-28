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
  /** The bottom bar's tickers: BTC, ETH, SOL, BNB, HYPE and ASTER, by market id here. */
  majors: readonly string[];
  /**
   * How an account connects: a wallet that approves a trade-only key, or an
   * exchange API key made on the venue's site. Picks the connect flow.
   */
  auth: "wallet" | "apiKey";
  /** Whether an account can be connected yet. */
  connectable: boolean;
}

export const VENUES: Record<VenueId, VenueInfo> = {
  // A centralized exchange: read-only market data until API-key trading lands.
  bybit: {
    label: "Bybit",
    defaultMarket: "BTCUSDT",
    // Bybit's non-VIP perpetual fees.
    fees: { taker: 0.00055, maker: 0.0002 },
    // pewterdesk's own cap; Bybit's price protection varies by market.
    maxSlippage: 0.05,
    majors: ["BTCUSDT", "ETHUSDT", "SOLUSDT", "BNBUSDT", "HYPEUSDT", "ASTERUSDT"],
    auth: "apiKey",
    connectable: true,
  },
  // Builder-deployed (HIP-3) markets scale fees per deployer; the ticket shows none for them.
  hyperliquid: {
    label: "Hyperliquid",
    defaultMarket: "HYPE",
    fees: { taker: 0.00045, maker: 0.00015 },
    maxSlippage: 0.08,
    majors: ["BTC", "ETH", "SOL", "BNB", "HYPE", "ASTER"],
    auth: "wallet",
    connectable: true,
  },
  // USDⓈ-M futures, with Demo Trading for demo accounts.
  binance: {
    label: "Binance",
    defaultMarket: "BTCUSDT",
    // Binance's regular-tier USDⓈ-M fees.
    fees: { taker: 0.0005, maker: 0.0002 },
    // Binance refuses a limit price outside the market's band around the
    // mark (3% on BTCUSDT); Rust pulls a wider bound in to it.
    maxSlippage: 0.03,
    majors: ["BTCUSDT", "ETHUSDT", "SOLUSDT", "BNBUSDT", "HYPEUSDT", "ASTERUSDT"],
    auth: "apiKey",
    connectable: true,
  },
  // USDT-M perpetuals; Demo Trading accounts only (see `blofin_key.rs`).
  blofin: {
    label: "BloFin",
    defaultMarket: "BTC-USDT",
    // BloFin's base-tier perpetual fees.
    fees: { taker: 0.0006, maker: 0.0002 },
    // BloFin refuses a price outside its limits around the mark; Rust pulls
    // a wider bound in to them.
    maxSlippage: 0.03,
    majors: ["BTC-USDT", "ETH-USDT", "SOL-USDT", "BNB-USDT", "HYPE-USDT", "ASTER-USDT"],
    auth: "apiKey",
    connectable: true,
  },
  aster: {
    label: "Aster",
    defaultMarket: "BTCUSDT",
    fees: { taker: 0.00035, maker: 0.0001 },
    // Aster's `marketTakeBound` for its main markets.
    maxSlippage: 0.05,
    majors: ["BTCUSDT", "ETHUSDT", "SOLUSDT", "BNBUSDT", "HYPEUSDT", "ASTERUSDT"],
    auth: "wallet",
    connectable: true,
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
