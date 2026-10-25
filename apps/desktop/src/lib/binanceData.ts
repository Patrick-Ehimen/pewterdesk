import type { VenueId } from "@pewterdesk/core";
import { binanceKeyClient } from "../api/venueClient";
import { accountsState, activeAccount, isDemoAccount, subscribeAccounts } from "./account";
import { loadOnboarding } from "./onboarding";

// Which Binance exchange the market data is from. Binance's Demo Trading is
// an exchange of its own - other markets (about 600 to mainnet's 790), and
// prices of its own - so while the active Binance account is a Demo Trading
// one, Binance's markets, books, charts, screener and maps are Demo
// Trading's, as on Binance's own demo site. Rust reads from whichever it's
// told (`set_binance_demo_data`); each window tells it at start, and reloads
// when the answer changes, so no feed or cache mixes the two.

/** Whether Binance's market data should be Demo Trading's: the active Binance account is demo. */
export function wantsDemoData(): boolean {
  const account = activeAccount(accountsState(), "binance");
  return account !== undefined && isDemoAccount(account);
}

let demoData = false;

/** Whether this window shows Demo Trading's Binance data. */
export const showsDemoData = () => demoData;

/**
 * The name a venue's market data is cached under on this machine: Binance's
 * Demo Trading apart from mainnet, as their markets and prices differ.
 */
export const dataKey = (venue: VenueId): string =>
  venue === "binance" && demoData ? "binance-demo" : venue;

/**
 * Tells Rust which Binance exchange to read, before anything subscribes, and
 * reloads the window when the active Binance account crosses between live
 * and demo. During setup it only tells Rust: setup keeps its step in memory,
 * and nothing it shows streams Binance's markets.
 */
export async function syncBinanceData(): Promise<void> {
  demoData = wantsDemoData();
  try {
    await binanceKeyClient.setDemoData(demoData);
  } catch {
    // Not in the app (a browser preview): mainnet's data, as by default.
  }
  subscribeAccounts(() => {
    const next = wantsDemoData();
    if (next === demoData) return;
    if (!loadOnboarding().done) {
      demoData = next;
      void binanceKeyClient.setDemoData(next).catch(() => {});
      return;
    }
    location.reload();
  });
}
