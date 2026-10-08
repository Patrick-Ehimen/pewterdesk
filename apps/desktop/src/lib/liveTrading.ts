import { bybitKeyClient } from "../api/venueClient";

// Which live Bybit accounts have trading turned on. Rust keeps the list and
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

/** The live Bybit accounts (UIDs) with trading on, as last heard from Rust. */
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
 * Turns live trading on or off for Bybit account `uid`. Turning it on has
 * Rust check the stored key with Bybit first; it throws, changing nothing,
 * if that fails.
 */
export async function setLiveTrading(uid: string, on: boolean): Promise<void> {
  await bybitKeyClient.setLive(uid, on);
  publish(on ? [...uids.filter((u) => u !== uid), uid] : uids.filter((u) => u !== uid));
}
