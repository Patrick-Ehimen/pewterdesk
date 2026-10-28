import type { VenueId } from "@pewterdesk/core";
import { t } from "@pewterdesk/ui";
import { binanceKeyClient, bybitKeyClient, walletClient } from "../api/venueClient";
import { liveId } from "./account";

export { liveId };

// Which live accounts have trading turned on: Bybit accounts by UID, Binance
// accounts as "binance:<uid>", and Hyperliquid and Aster accounts as
// "<venue>:<address>". Rust keeps the list and
// enforces it (`live_trading.rs`): this is its copy for the page, so the
// ticket knows whether to offer orders. It's mirrored to localStorage only
// so the app's other windows (the floating one) hear a change.

const KEY = "pd.liveTrading";

let uids: readonly string[] = read();
const listeners = new Set<() => void>();

function read(): readonly string[] {
  try {
    const saved: unknown = JSON.parse(localStorage.getItem(KEY) ?? "[]");
    return Array.isArray(saved) ? saved.filter((u) => typeof u === "string") : [];
  } catch {
    return [];
  }
}

function publish(next: readonly string[]) {
  uids = next;
  try {
    localStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    // Other windows catch up when they next ask Rust.
  }
  for (const listener of listeners) listener();
}

/** The live accounts with trading on (see `liveId`), as last heard from Rust. */
export const liveTradingUids = () => uids;

export function subscribeLiveTrading(listener: () => void): () => void {
  listeners.add(listener);
  const onStorage = (e: StorageEvent) => {
    if (e.key !== KEY) return;
    uids = read();
    listener();
  };
  window.addEventListener("storage", onStorage);
  return () => {
    listeners.delete(listener);
    window.removeEventListener("storage", onStorage);
  };
}

/** Asks Rust for the list; what it says replaces the page's copy. */
export async function refreshLiveTrading(): Promise<void> {
  try {
    publish(await bybitKeyClient.liveAccounts());
  } catch {
    // Not in the app (a browser preview): nothing is on.
  }
}

/**
 * Turns live trading on or off for a live account. Turning it on has Rust
 * check the stored key with the venue first; it throws, changing nothing,
 * if that fails.
 */
export async function setLiveTrading(
  account: { venue: VenueId; id: string },
  on: boolean,
): Promise<void> {
  // Only Demo Trading accounts connect on BloFin: there's nothing to turn on.
  if (account.venue === "blofin") throw new Error(t("apiKey.liveUnavailable", { venue: "BloFin" }));
  if (account.venue === "bybit") await bybitKeyClient.setLive(account.id, on);
  else if (account.venue === "binance") await binanceKeyClient.setLive(account.id, on);
  else await walletClient.setLive(account.venue, account.id, on);
  const id = liveId(account);
  publish(on ? [...uids.filter((u) => u !== id), id] : uids.filter((u) => u !== id));
}
