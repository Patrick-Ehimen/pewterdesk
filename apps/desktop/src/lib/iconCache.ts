import type { VenueId } from "@pewterdesk/core";
import type { IconLoader, IconPeek } from "@pewterdesk/ui";

// Market logos kept between sessions, so they draw at once on the next launch
// instead of each being fetched again. Shared by the main window and the tray
// panel (same origin). Logos are public, so browser storage is fine.

const PREFIX = "pd.icons.";
/**
 * Bumped when where logos come from changes, so saved answers from before
 * are dropped rather than kept for a week. 2: Bybit markets borrow their
 * coin's logo from Hyperliquid and Aster; version 1 saved "none" for all.
 * 3: a failed lookup was saved as "none" (BTC's logo went missing that way).
 * 4: Aster's logo list answers for coins it has no market for.
 * 5: Bybit's own logo list is asked first, for a connected account.
 * 6: CoinGecko is asked last, for a crypto coin no venue has a logo for.
 * 7: logos that ship with the app (assets/tokens) fill in for stocks and ETFs.
 * 8: another venue's logo is borrowed only for the same asset, by price
 *    (Bybit's PURR, a stock, had Hyperliquid's memecoin's).
 */
export const STORE_VERSION = 8;
/** The whole store starts over after this, so changed logos come through. */
export const ICON_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
/** A bigger logo isn't kept; Aster's are about 1.5 KB wrapped, most of Hyperliquid's less. */
export const MAX_ICON_CHARS = 16 * 1024;
/** Per venue: stops a large logo set crowding out the rest of storage. */
export const MAX_STORE_CHARS = 1_500_000;
/** Many logos arrive together (the screener asks for every market's); one write for them all. */
const WRITE_DELAY_MS = 1000;

interface Store {
  version: number;
  savedAt: number;
  /** SVG markup, or `null` for a market with no logo. */
  icons: Record<string, string | null>;
}

type Storage = Pick<globalThis.Storage, "getItem" | "setItem">;

const stores = new Map<VenueId, Store>();
const pending = new Set<VenueId>();
let timer: ReturnType<typeof setTimeout> | undefined;

function storage(): Storage | undefined {
  try {
    return localStorage;
  } catch {
    return undefined;
  }
}

function isStore(v: unknown): v is Store {
  if (typeof v !== "object" || v === null) return false;
  const s = v as Store;
  return (
    s.version === STORE_VERSION &&
    typeof s.savedAt === "number" &&
    typeof s.icons === "object" &&
    s.icons !== null &&
    Object.values(s.icons).every((icon) => icon === null || typeof icon === "string")
  );
}

function storeFor(venue: VenueId, now: number, from: Storage | undefined): Store {
  let store = stores.get(venue);
  if (!store) {
    try {
      const parsed: unknown = JSON.parse(from?.getItem(PREFIX + venue) ?? "null");
      if (isStore(parsed)) store = parsed;
    } catch {
      // Unreadable; start over.
    }
    stores.set(venue, store ?? { version: STORE_VERSION, savedAt: now, icons: {} });
    store = stores.get(venue) as Store;
  }
  if (now - store.savedAt > ICON_MAX_AGE_MS) {
    store = { version: STORE_VERSION, savedAt: now, icons: {} };
    stores.set(venue, store);
  }
  return store;
}

/** The saved logo: SVG markup, `null` for none, `undefined` if not saved. */
export function peekIcon(
  venue: VenueId,
  market: string,
  now = Date.now(),
  from: Storage | undefined = storage(),
): string | null | undefined {
  return storeFor(venue, now, from).icons[market];
}

/** Keeps `svg` (or that there's none) for next time; written shortly after. */
export function rememberIcon(
  venue: VenueId,
  market: string,
  svg: string | undefined,
  now = Date.now(),
  to: Storage | undefined = storage(),
) {
  if (svg && svg.length > MAX_ICON_CHARS) return;
  const store = storeFor(venue, now, to);
  store.icons[market] = svg ?? null;
  pending.add(venue);
  if (timer === undefined) timer = setTimeout(() => flushIcons(to), WRITE_DELAY_MS);
}

/**
 * Writes what's changed, merged into what's saved: the main window and the
 * tray panel each keep their own copy, and neither should drop the other's.
 * Over the size cap, the saved set is left as it was.
 */
export function flushIcons(to: Storage | undefined = storage()) {
  timer = undefined;
  for (const venue of pending) {
    const store = stores.get(venue);
    if (!store) continue;
    let saved: unknown;
    try {
      saved = JSON.parse(to?.getItem(PREFIX + venue) ?? "null");
    } catch {
      saved = null;
    }
    if (isStore(saved) && saved.savedAt >= store.savedAt) {
      store.icons = { ...saved.icons, ...store.icons };
    }
    const json = JSON.stringify(store);
    if (json.length > MAX_STORE_CHARS) continue;
    try {
      to?.setItem(PREFIX + venue, json);
    } catch {
      // Storage full or unavailable; logos just get fetched next time.
    }
  }
  pending.clear();
}

/** `load`, saving what it fetches; a failed fetch isn't saved, so it's retried. */
export function withIconCache(load: IconLoader): IconLoader {
  return (market, venue, info) =>
    load(market, venue, info).then((svg) => {
      rememberIcon(venue, market, svg);
      return svg;
    });
}

/** Saved logos, for `TokenIconProvider`'s `peek`. */
export const peekSavedIcon: IconPeek = (market, venue) => peekIcon(venue, market);

/** Forgets everything in memory; for tests. */
export function resetIconCache() {
  stores.clear();
  pending.clear();
  if (timer !== undefined) clearTimeout(timer);
  timer = undefined;
}
