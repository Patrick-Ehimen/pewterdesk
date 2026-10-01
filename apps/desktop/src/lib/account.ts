import type { VenueId } from "@pewterdesk/core";

// The connected trading account: which venue and main address. Only public
// data lives here - the trade-only key is in the OS keychain, and nothing
// reads it back to JS. Everything that shows an account (the account,
// positions and history panels, Portfolio, the order ticket, the tray) reads
// it and shows its "connect a wallet" state without one.

const KEY = "pd.wallet";

export interface ConnectedWallet {
  venue: VenueId;
  /** The main account, lowercase `0x` hex: what positions are read from. */
  address: string;
}

const listeners = new Set<() => void>();
let cachedRaw: string | null | undefined;
let cached: ConnectedWallet | undefined;

function readRaw(): string | null {
  try {
    return localStorage.getItem(KEY);
  } catch {
    return null;
  }
}

/** Parses what was stored, ignoring anything malformed. */
export function parseWallet(raw: string | null): ConnectedWallet | undefined {
  if (!raw) return undefined;
  try {
    const value = JSON.parse(raw) as Partial<ConnectedWallet>;
    const venueOk = value.venue === "hyperliquid" || value.venue === "aster";
    const addressOk = typeof value.address === "string" && /^0x[0-9a-f]{40}$/.test(value.address);
    return venueOk && addressOk
      ? { venue: value.venue as VenueId, address: value.address as string }
      : undefined;
  } catch {
    return undefined;
  }
}

/** The connected account, if any; the same object until it changes. */
export function connectedWallet(): ConnectedWallet | undefined {
  const raw = readRaw();
  if (raw !== cachedRaw) {
    cachedRaw = raw;
    cached = parseWallet(raw);
  }
  return cached;
}

/** The connected main address on `venue`, if that's the venue it's on. */
export function connectedAddress(venue: VenueId = "hyperliquid"): string | undefined {
  const wallet = connectedWallet();
  return wallet?.venue === venue ? wallet.address : undefined;
}

/** Remembers (or, with `undefined`, forgets) the connected account. */
export function setConnectedWallet(wallet: ConnectedWallet | undefined) {
  try {
    if (wallet) localStorage.setItem(KEY, JSON.stringify(wallet));
    else localStorage.removeItem(KEY);
  } catch {
    // Storage unavailable: the connection lasts for this session only.
  }
  for (const l of listeners) l();
}

/** For useSyncExternalStore. Other windows (the tray) hear it via `storage`. */
export function subscribeWallet(listener: () => void): () => void {
  listeners.add(listener);
  const onStorage = (e: StorageEvent) => e.key === KEY && listener();
  window.addEventListener("storage", onStorage);
  return () => {
    listeners.delete(listener);
    window.removeEventListener("storage", onStorage);
  };
}

/** Earlier versions could watch any address; forget one they stored. */
export function forgetWatchedAddress() {
  try {
    localStorage.removeItem("pd.watchAddress");
  } catch {
    // Storage unavailable: there's nothing stored to forget either.
  }
}
