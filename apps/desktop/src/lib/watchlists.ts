import type { Candle, MarketHistory, Position, VenueId } from "@pewterdesk/core";
import type { MarketAlert } from "@pewterdesk/ui";
import { useCallback, useSyncExternalStore } from "react";

// The Watchlist tab's lists (after the Watchlist mockup in `design/`): the
// starred markets, which the rest of the app stars and unstars
// (`hooks/useWatchlist`), and any number of the trader's own named lists.
// Kept on this machine. Entries are "<venue>:<market id>", like the stars.

const KEY = "pd.watchlists";
/** The starred markets' list: always there, first, and not renamed or deleted. */
export const STARRED = "starred";
export const LIST_NAME_MAX = 32;
const MAX_LISTS = 40;
const MAX_ENTRIES = 200;

export interface NamedList {
  id: string;
  name: string;
  keys: string[];
}

export interface ListsState {
  /** The trader's own lists, in the order they were made. */
  lists: NamedList[];
  /** The list on screen: `STARRED` or one of `lists`. */
  active: string;
}

const EMPTY: ListsState = { lists: [], active: STARRED };

const cleanName = (name: string) => name.trim().replace(/\s+/g, " ").slice(0, LIST_NAME_MAX);

/** What was stored, made safe: malformed lists dropped, entries unique. */
export function parseLists(raw: string | null): ListsState {
  if (!raw) return EMPTY;
  try {
    const value = JSON.parse(raw) as Partial<ListsState>;
    const lists: NamedList[] = [];
    for (const l of Array.isArray(value.lists) ? value.lists : []) {
      if (!l || typeof l.id !== "string" || !l.id || l.id === STARRED) continue;
      if (typeof l.name !== "string" || !cleanName(l.name)) continue;
      if (lists.some((x) => x.id === l.id)) continue;
      const keys = Array.isArray(l.keys)
        ? [...new Set(l.keys.filter((k): k is string => typeof k === "string" && k.includes(":")))]
        : [];
      lists.push({ id: l.id, name: cleanName(l.name), keys: keys.slice(0, MAX_ENTRIES) });
    }
    const active =
      typeof value.active === "string" && lists.some((l) => l.id === value.active)
        ? value.active
        : STARRED;
    return { lists: lists.slice(0, MAX_LISTS), active };
  } catch {
    return EMPTY;
  }
}

/** A new list named `name`, made the one on screen. */
export function withList(state: ListsState, id: string, name: string): ListsState {
  const clean = cleanName(name);
  if (!clean || state.lists.length >= MAX_LISTS) return state;
  return { lists: [...state.lists, { id, name: clean, keys: [] }], active: id };
}

export function withoutList(state: ListsState, id: string): ListsState {
  return {
    lists: state.lists.filter((l) => l.id !== id),
    active: state.active === id ? STARRED : state.active,
  };
}

export function renamed(state: ListsState, id: string, name: string): ListsState {
  const clean = cleanName(name);
  if (!clean) return state;
  return { ...state, lists: state.lists.map((l) => (l.id === id ? { ...l, name: clean } : l)) };
}

/** `key` added to list `id`, or taken out if it's there. */
export function toggled(state: ListsState, id: string, key: string): ListsState {
  return {
    ...state,
    lists: state.lists.map((l) => {
      if (l.id !== id) return l;
      if (l.keys.includes(key)) return { ...l, keys: l.keys.filter((k) => k !== key) };
      return l.keys.length >= MAX_ENTRIES ? l : { ...l, keys: [...l.keys, key] };
    }),
  };
}

/** A list's markets on `venue`, by market id, in the list's order. */
export function marketsOn(keys: readonly string[], venue: VenueId): string[] {
  const prefix = `${venue}:`;
  return keys.filter((k) => k.startsWith(prefix)).map((k) => k.slice(prefix.length));
}

/** A list's 24h performance: its markets' changes, equal-weighted. */
export function listPerformance(changes: readonly number[]): number | undefined {
  const known = changes.filter((c) => Number.isFinite(c));
  if (known.length === 0) return undefined;
  return known.reduce((a, b) => a + b, 0) / known.length;
}

/** The last 24 hours of hourly candles: the day's low and high, and its closes. */
export function lastDay(history: MarketHistory | undefined, now: number) {
  const since = now - 24 * 3_600_000;
  const candles: Candle[] = (history?.candles ?? []).filter((c) => c.openTime >= since);
  if (candles.length === 0) return undefined;
  return {
    low: Math.min(...candles.map((c) => Number(c.low))),
    high: Math.max(...candles.map((c) => Number(c.high))),
    closes: candles.map((c) => Number(c.close)),
  };
}

/** Where `price` sits in the day's range, 0 to 1. */
export const rangeShare = (price: number, low: number, high: number) =>
  high > low ? Math.min(1, Math.max(0, (price - low) / (high - low))) : 0.5;

/** The active price alert on a market closest to its price, for the card's chip. */
export function nearestPriceAlert(
  alerts: readonly MarketAlert[],
  venue: VenueId,
  market: string,
  price: number,
): MarketAlert | undefined {
  return alerts
    .filter((a) => a.active && a.kind === "price" && a.venue === venue && a.market === market)
    .sort((a, b) => Math.abs(a.value - price) - Math.abs(b.value - price))[0];
}

/** The account's position in a market, if it holds one. */
export const positionIn = (positions: readonly Position[], market: string) =>
  positions.find((p) => p.market === market);

function read(): string | null {
  try {
    return localStorage.getItem(KEY);
  } catch {
    return null;
  }
}

const listeners = new Set<() => void>();
let cachedRaw: string | null | undefined;
let cached: ListsState = EMPTY;

function current(): ListsState {
  const raw = read();
  if (raw !== cachedRaw) {
    cachedRaw = raw;
    cached = parseLists(raw);
  }
  return cached;
}

function save(next: ListsState) {
  try {
    localStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    // Storage unavailable: kept for this session only.
    cachedRaw = JSON.stringify(next);
    cached = next;
  }
  for (const l of listeners) l();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** The trader's own lists and which list is on screen. */
export function useLists() {
  const state = useSyncExternalStore(subscribe, current);
  const update = useCallback(
    (change: (s: ListsState) => ListsState) => save(change(current())),
    [],
  );
  return {
    state,
    setActive: useCallback((id: string) => update((s) => ({ ...s, active: id })), [update]),
    create: useCallback(
      (name: string) => update((s) => withList(s, crypto.randomUUID(), name)),
      [update],
    ),
    rename: useCallback(
      (id: string, name: string) => update((s) => renamed(s, id, name)),
      [update],
    ),
    remove: useCallback((id: string) => update((s) => withoutList(s, id)), [update]),
    toggle: useCallback((id: string, key: string) => update((s) => toggled(s, id, key)), [update]),
  };
}
