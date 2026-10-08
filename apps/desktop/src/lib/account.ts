import type { VenueId } from "@pewterdesk/core";
import { removeAvatar } from "./avatars";

// The connected trading accounts: any number per venue, each with a name the
// user picks, and one active per venue - the one the account panels,
// Portfolio, the order ticket and the tray show. Only public data lives
// here (venue, account id, name); each account's trade-only key is in the OS
// keychain under its id, and nothing reads it back to JS.
//
// An account's id is what its venue knows it by: the main address (lowercase
// `0x` hex) on Hyperliquid and Aster, the UID on Bybit - with `demo:` in
// front for a Bybit Demo Trading account (demo funds, Bybit's demo host).

const KEY = "pd.accounts";
/** Where earlier versions kept their one wallet, and their one Bybit UID. */
const LEGACY_WALLET = "pd.wallet";
const LEGACY_BYBIT = "pd.bybit";

/** Longest name kept; longer ones are cut. */
export const NAME_MAX = 32;

export interface VenueAccount {
  venue: VenueId;
  /** The main address (`0x` hex) or, on Bybit, the UID. */
  id: string;
  /** The user's name for it; empty until they give one (see `accountLabel`). */
  name: string;
}

export interface AccountsState {
  /** In the order they were added. */
  accounts: VenueAccount[];
  /** Each venue's active account, by id. */
  active: Partial<Record<VenueId, string>>;
}

/** The wallet-connected account on screen, for code that reads one address. */
export interface ConnectedWallet {
  venue: VenueId;
  /** The main account, lowercase `0x` hex: what positions are read from. */
  address: string;
}

const EMPTY: AccountsState = { accounts: [], active: {} };

/** Whether `id` is a valid account id on `venue`. */
export function isAccountId(venue: VenueId, id: string): boolean {
  return venue === "bybit" ? /^(demo:)?\d{1,20}$/.test(id) : /^0x[0-9a-f]{40}$/.test(id);
}

/** Whether an account is a Bybit Demo Trading one: demo funds, not real ones. */
export const isDemoAccount = (account: { venue: VenueId; id: string }) =>
  account.venue === "bybit" && account.id.startsWith("demo:");

/**
 * Whether orders can be placed for an account: a Bybit demo account, or a
 * live one with live trading turned on (`liveUids`, see `lib/liveTrading`).
 * Rust refuses the rest too; this just keeps the UI from offering it.
 */
export const canTrade = (
  account: { venue: VenueId; id: string } | undefined,
  liveUids: readonly string[],
) =>
  account !== undefined &&
  account.venue === "bybit" &&
  (isDemoAccount(account) || liveUids.includes(account.id));

const isVenue = (v: unknown): v is VenueId => v === "hyperliquid" || v === "aster" || v === "bybit";

const cleanName = (name: string) => name.trim().replace(/\s+/g, " ").slice(0, NAME_MAX);

/** Parses what was stored, dropping anything malformed or repeated. */
export function parseAccounts(raw: string | null): AccountsState {
  if (!raw) return EMPTY;
  try {
    const value = JSON.parse(raw) as Partial<AccountsState>;
    const accounts: VenueAccount[] = [];
    for (const a of Array.isArray(value.accounts) ? value.accounts : []) {
      const ok =
        a &&
        isVenue(a.venue) &&
        typeof a.id === "string" &&
        isAccountId(a.venue, a.id) &&
        typeof a.name === "string" &&
        !accounts.some((b) => b.venue === a.venue && b.id === a.id);
      if (ok) accounts.push({ venue: a.venue, id: a.id, name: cleanName(a.name) });
    }
    const active: AccountsState["active"] = {};
    for (const [venue, id] of Object.entries(value.active ?? {})) {
      if (isVenue(venue) && accounts.some((a) => a.venue === venue && a.id === id)) {
        active[venue] = id as string;
      }
    }
    return withActive({ accounts, active });
  } catch {
    return EMPTY;
  }
}

/** Every venue with accounts has an active one: its first, if none is set. */
function withActive(state: AccountsState): AccountsState {
  const active = { ...state.active };
  for (const a of state.accounts) active[a.venue] ??= a.id;
  return { accounts: state.accounts, active };
}

/** Adds an account (or keeps one already there) and makes it active. */
export function withAccount(
  state: AccountsState,
  venue: VenueId,
  id: string,
  name: string,
): AccountsState {
  const known = state.accounts.some((a) => a.venue === venue && a.id === id);
  const accounts = known
    ? state.accounts
    : [...state.accounts, { venue, id, name: cleanName(name) }];
  return { accounts, active: { ...state.active, [venue]: id } };
}

/** Drops an account; if it was active, the venue's next one takes over. */
export function withoutAccount(state: AccountsState, venue: VenueId, id: string): AccountsState {
  const accounts = state.accounts.filter((a) => !(a.venue === venue && a.id === id));
  const active = { ...state.active };
  if (active[venue] === id) delete active[venue];
  return withActive({ accounts, active });
}

/** Renames an account; an empty name makes it unnamed again. */
export function withName(
  state: AccountsState,
  venue: VenueId,
  id: string,
  name: string,
): AccountsState {
  const next = cleanName(name);
  return {
    accounts: state.accounts.map((a) =>
      a.venue === venue && a.id === id ? { ...a, name: next } : a,
    ),
    active: state.active,
  };
}

/** What earlier versions stored, as the new shape. */
export function migrateLegacy(wallet: string | null, bybit: string | null): AccountsState {
  let state = EMPTY;
  try {
    const w = wallet ? (JSON.parse(wallet) as Partial<ConnectedWallet>) : undefined;
    if (w && isVenue(w.venue) && typeof w.address === "string" && isAccountId(w.venue, w.address)) {
      state = withAccount(state, w.venue, w.address, "");
    }
  } catch {
    // Malformed: nothing to carry over.
  }
  if (bybit && isAccountId("bybit", bybit)) state = withAccount(state, "bybit", bybit, "");
  return state;
}

function read(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

const listeners = new Set<() => void>();
let cachedRaw: string | null | undefined;
let cached: AccountsState = EMPTY;

/** Every connected account; the same object until it changes. */
export function accountsState(): AccountsState {
  let raw = read(KEY);
  if (raw === null && (read(LEGACY_WALLET) !== null || read(LEGACY_BYBIT) !== null)) {
    // First run after the update: carry the old single accounts over.
    save(migrateLegacy(read(LEGACY_WALLET), read(LEGACY_BYBIT)), false);
    raw = read(KEY);
  }
  if (raw !== cachedRaw) {
    cachedRaw = raw;
    cached = parseAccounts(raw);
  }
  return cached;
}

function save(state: AccountsState, notify = true) {
  try {
    localStorage.setItem(KEY, JSON.stringify(state));
    localStorage.removeItem(LEGACY_WALLET);
    localStorage.removeItem(LEGACY_BYBIT);
  } catch {
    // Storage unavailable: the change lasts for this session only.
    cachedRaw = JSON.stringify(state);
    cached = state;
  }
  if (notify) for (const l of listeners) l();
}

/** For useSyncExternalStore. Other windows (the tray) hear it via `storage`. */
export function subscribeAccounts(listener: () => void): () => void {
  listeners.add(listener);
  const onStorage = (e: StorageEvent) => e.key === KEY && listener();
  window.addEventListener("storage", onStorage);
  return () => {
    listeners.delete(listener);
    window.removeEventListener("storage", onStorage);
  };
}

/** Adds a connected account and makes it the venue's active one. */
export function addAccount(venue: VenueId, id: string, name = "") {
  save(withAccount(accountsState(), venue, id, name));
}

/** Forgets an account (its key is deleted from the keychain separately). */
export function removeAccount(venue: VenueId, id: string) {
  removeAvatar(venue, id);
  save(withoutAccount(accountsState(), venue, id));
}

export function renameAccount(venue: VenueId, id: string, name: string) {
  save(withName(accountsState(), venue, id, name));
}

/** Makes `id` the venue's active account. */
export function selectAccount(venue: VenueId, id: string) {
  const state = accountsState();
  if (state.accounts.some((a) => a.venue === venue && a.id === id)) {
    save({ accounts: state.accounts, active: { ...state.active, [venue]: id } });
  }
}

/** The venue's accounts, in the order they were added. */
export function venueAccounts(state: AccountsState, venue: VenueId): VenueAccount[] {
  return state.accounts.filter((a) => a.venue === venue);
}

/**
 * What to call an account: its name, or for an unnamed one its place among
 * the venue's accounts (1-based), for the UI to word ("Account 2").
 */
export function accountLabel(
  state: AccountsState,
  account: VenueAccount,
): { name: string } | { index: number } {
  if (account.name) return { name: account.name };
  return { index: venueAccounts(state, account.venue).findIndex((a) => a.id === account.id) + 1 };
}

/** The venue's active account, if it has one. */
export function activeAccount(state: AccountsState, venue: VenueId): VenueAccount | undefined {
  const id = state.active[venue];
  return state.accounts.find((a) => a.venue === venue && a.id === id);
}

let walletFor: AccountsState | undefined;
let walletCached: ConnectedWallet | undefined;

/**
 * The active Hyperliquid account as a wallet, for code that shows one wallet
 * (the tray, onboarding); the same object until it changes.
 */
export function connectedWallet(): ConnectedWallet | undefined {
  const state = accountsState();
  if (state !== walletFor) {
    walletFor = state;
    const a = activeAccount(state, "hyperliquid");
    walletCached = a ? { venue: a.venue, address: a.id } : undefined;
  }
  return walletCached;
}

/** The active Bybit account's UID, if any. */
export function connectedBybit(): string | undefined {
  return activeAccount(accountsState(), "bybit")?.id;
}

/** Earlier versions could watch any address; forget one they stored. */
export function forgetWatchedAddress() {
  try {
    localStorage.removeItem("pd.watchAddress");
  } catch {
    // Storage unavailable: there's nothing stored to forget either.
  }
}
