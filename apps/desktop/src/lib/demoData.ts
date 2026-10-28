import type { VenueId } from "@pewterdesk/core";
import { binanceKeyClient, blofinKeyClient } from "../api/venueClient";
import { accountsState, activeAccount, isDemoAccount, subscribeAccounts } from "./account";
import { loadOnboarding } from "./onboarding";

// Which exchange a venue's market data is from, on the venues whose Demo
// Trading is an exchange of its own - other markets, and prices of its own:
// Binance's (about 600 markets to mainnet's 790) and BloFin's (87 to 527).
// While the venue's active account is a Demo Trading one, its markets,
// books, charts, screener and maps are Demo Trading's, as on the venue's own
// demo site, so nothing is offered that the demo account can't trade. Rust
// reads from whichever it's told (`set_binance_demo_data`,
// `set_blofin_demo_data`); each window tells it at start, and reloads when
// an answer changes, so no feed or cache mixes the two.

/** The venues with a Demo Trading exchange of their own, and how to tell Rust. */
const DEMO_DATA_VENUES = {
  binance: (demo: boolean) => binanceKeyClient.setDemoData(demo),
  blofin: (demo: boolean) => blofinKeyClient.setDemoData(demo),
} as const;
type DemoDataVenue = keyof typeof DEMO_DATA_VENUES;
const VENUES = Object.keys(DEMO_DATA_VENUES) as DemoDataVenue[];

const isDemoDataVenue = (venue: VenueId): venue is DemoDataVenue => VENUES.some((v) => v === venue);

/** Whether `venue`'s market data should be Demo Trading's: its active account is demo. */
export function wantsDemoData(venue: VenueId): boolean {
  if (!isDemoDataVenue(venue)) return false;
  const account = activeAccount(accountsState(), venue);
  return account !== undefined && isDemoAccount(account);
}

const demoData = new Set<VenueId>();

/** Whether this window shows `venue`'s Demo Trading data. */
export const showsDemoData = (venue: VenueId) => demoData.has(venue);

/**
 * The name a venue's market data is cached under on this machine: Demo
 * Trading's apart from mainnet's, as their markets and prices differ.
 */
export const dataKey = (venue: VenueId): string => (demoData.has(venue) ? `${venue}-demo` : venue);

function tell(venue: DemoDataVenue, demo: boolean): Promise<unknown> {
  if (demo) demoData.add(venue);
  else demoData.delete(venue);
  return DEMO_DATA_VENUES[venue](demo).catch(() => {
    // Not in the app (a browser preview): mainnet's data, as by default.
  });
}

/**
 * Tells Rust which exchange to read for each venue, before anything
 * subscribes, and reloads the window when a venue's active account crosses
 * between live and demo. During setup it only tells Rust: setup keeps its
 * step in memory, and nothing it shows streams those markets.
 */
export async function syncDemoData(): Promise<void> {
  await Promise.all(VENUES.map((venue) => tell(venue, wantsDemoData(venue))));
  subscribeAccounts(() => {
    const changed = VENUES.filter((venue) => wantsDemoData(venue) !== demoData.has(venue));
    if (changed.length === 0) return;
    if (!loadOnboarding().done) {
      for (const venue of changed) void tell(venue, wantsDemoData(venue));
      return;
    }
    location.reload();
  });
}
