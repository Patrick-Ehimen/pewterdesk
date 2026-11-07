import { useCallback, useSyncExternalStore } from "react";
import type {
  TraderChangeKind,
  TraderFollow,
  TraderMove,
  TraderSide,
  TraderSnapshot,
  TraderSource,
} from "../api/venueClient";

// The Traders page's own state (after the Top traders mockups in `design/`):
// the traders followed, in lists, each one's alert settings, and what they
// did lately. Kept on this machine. Rust watches the followed ones while the
// app runs (`traders.rs`); entries are "<source>:<id>".

const KEY = "pd.traders";
const ACTIVITY_KEY = "pd.traders.activity";
/** The list a star adds to: always there, first, not deleted. */
export const FOLLOWING = "following";
export const LIST_NAME_MAX = 32;
/** As many as Rust watches at once. */
export const MAX_FOLLOWED = 40;
const MAX_LISTS = 20;
const MAX_ACTIVITY = 300;
const ACTIVITY_DAYS = 30;
export const CHANGE_KINDS: readonly TraderChangeKind[] = ["open", "add", "cut", "close", "flip"];

export interface TraderList {
  id: string;
  /** Empty for the Following list, which is named in the interface language. */
  name: string;
  keys: string[];
}

export interface TraderAlerts {
  on: boolean;
  /** Moves worth less (USD) are kept but don't alert. */
  minValue: number;
  kinds: TraderChangeKind[];
}

export interface TradersState {
  lists: TraderList[];
  /** The list on screen. */
  active: string;
  /** Per trader, where set; the rest take `DEFAULT_ALERTS`. */
  alerts: Record<string, TraderAlerts>;
  /** The name each followed trader had on a leaderboard, to show without one. */
  names: Record<string, string>;
}

export const DEFAULT_ALERTS: TraderAlerts = {
  on: true,
  minValue: 50_000,
  kinds: ["open", "add", "close", "flip"],
};

const EMPTY: TradersState = {
  lists: [{ id: FOLLOWING, name: "", keys: [] }],
  active: FOLLOWING,
  alerts: {},
  names: {},
};

const ADDRESS = /^0x[0-9a-f]{40}$/;
const CODE = /^[0-9A-Za-z]{16}(?:[0-9A-Za-z]{2})?$/;

export const traderKey = (source: TraderSource, id: string) => `${source}:${id}`;

/** A key's source and id, if it names a trader its source can be asked about. */
export function parseKey(key: string): { source: TraderSource; id: string } | undefined {
  const [source, id, extra] = key.split(":");
  if (extra !== undefined || !id) return undefined;
  if (source === "hyperliquid" && ADDRESS.test(id)) return { source, id };
  if (source === "okx" && CODE.test(id)) return { source, id };
  return undefined;
}

const cleanName = (name: string) => name.trim().replace(/\s+/g, " ").slice(0, LIST_NAME_MAX);

function cleanAlerts(value: unknown): TraderAlerts | undefined {
  if (!value || typeof value !== "object") return undefined;
  const a = value as Partial<TraderAlerts>;
  const min = Number(a.minValue);
  return {
    on: a.on !== false,
    minValue: Number.isFinite(min) && min >= 0 ? min : DEFAULT_ALERTS.minValue,
    kinds: Array.isArray(a.kinds) ? CHANGE_KINDS.filter((k) => a.kinds?.includes(k)) : [],
  };
}

/** What was stored, made safe: bad keys and lists dropped, Following always there. */
export function parseTraders(raw: string | null): TradersState {
  if (!raw) return EMPTY;
  try {
    const value = JSON.parse(raw) as Partial<TradersState>;
    const lists: TraderList[] = [];
    for (const l of Array.isArray(value.lists) ? value.lists : []) {
      if (!l || typeof l.id !== "string" || !l.id || lists.some((x) => x.id === l.id)) continue;
      const name = l.id === FOLLOWING ? "" : cleanName(String(l.name ?? ""));
      if (l.id !== FOLLOWING && !name) continue;
      const keys = Array.isArray(l.keys)
        ? [...new Set(l.keys.filter((k): k is string => typeof k === "string" && !!parseKey(k)))]
        : [];
      lists.push({ id: l.id, name, keys: keys.slice(0, MAX_FOLLOWED) });
    }
    if (!lists.some((l) => l.id === FOLLOWING))
      lists.unshift({ id: FOLLOWING, name: "", keys: [] });
    const alerts: Record<string, TraderAlerts> = {};
    for (const [k, a] of Object.entries(value.alerts ?? {})) {
      const clean = parseKey(k) && cleanAlerts(a);
      if (clean) alerts[k] = clean;
    }
    const names: Record<string, string> = {};
    for (const [k, n] of Object.entries(value.names ?? {})) {
      if (parseKey(k) && typeof n === "string" && n.trim()) names[k] = n.trim().slice(0, 40);
    }
    const kept = lists.slice(0, MAX_LISTS);
    const active = kept.some((l) => l.id === value.active) ? String(value.active) : FOLLOWING;
    return { lists: kept, active, alerts, names };
  } catch {
    return EMPTY;
  }
}

/** Every followed trader, once, in list order. */
export function followedKeys(state: TradersState): string[] {
  return [...new Set(state.lists.flatMap((l) => l.keys))].slice(0, MAX_FOLLOWED);
}

export const isFollowed = (state: TradersState, key: string) =>
  state.lists.some((l) => l.keys.includes(key));

/**
 * The star: a followed trader leaves every list; anyone else joins the list
 * on screen. Refused past `MAX_FOLLOWED`.
 */
export function toggleFollow(state: TradersState, key: string, name?: string | null): TradersState {
  if (!parseKey(key)) return state;
  if (isFollowed(state, key)) {
    return {
      ...state,
      lists: state.lists.map((l) => ({ ...l, keys: l.keys.filter((k) => k !== key) })),
    };
  }
  if (followedKeys(state).length >= MAX_FOLLOWED) return state;
  const names = name?.trim() ? { ...state.names, [key]: name.trim().slice(0, 40) } : state.names;
  return {
    ...state,
    names,
    lists: state.lists.map((l) => (l.id === state.active ? { ...l, keys: [...l.keys, key] } : l)),
  };
}

/** `key` added to list `id`, or taken out of it. */
export function toggledIn(state: TradersState, id: string, key: string): TradersState {
  if (!parseKey(key)) return state;
  const list = state.lists.find((l) => l.id === id);
  if (!list) return state;
  const leaving = list.keys.includes(key);
  if (!leaving && !isFollowed(state, key) && followedKeys(state).length >= MAX_FOLLOWED)
    return state;
  return {
    ...state,
    lists: state.lists.map((l) =>
      l.id !== id
        ? l
        : { ...l, keys: leaving ? l.keys.filter((k) => k !== key) : [...l.keys, key] },
    ),
  };
}

export function withList(state: TradersState, id: string, name: string): TradersState {
  const clean = cleanName(name);
  if (!clean || state.lists.length >= MAX_LISTS) return state;
  return { ...state, lists: [...state.lists, { id, name: clean, keys: [] }], active: id };
}

/** The list gone (not Following, which stays); its traders stay followed if another list has them. */
export function withoutList(state: TradersState, id: string): TradersState {
  if (id === FOLLOWING) return state;
  return {
    ...state,
    lists: state.lists.filter((l) => l.id !== id),
    active: state.active === id ? FOLLOWING : state.active,
  };
}

export const alertsFor = (state: TradersState, key: string): TraderAlerts =>
  state.alerts[key] ?? DEFAULT_ALERTS;

export function withAlerts(state: TradersState, key: string, alerts: TraderAlerts): TradersState {
  const clean = cleanAlerts(alerts);
  return clean && parseKey(key) ? { ...state, alerts: { ...state.alerts, [key]: clean } } : state;
}

/** Who Rust watches: every followed trader; one with alerts off still shows what they do. */
export function watchFollows(state: TradersState): TraderFollow[] {
  return followedKeys(state).flatMap((key) => {
    const parsed = parseKey(key);
    if (!parsed) return [];
    const a = alertsFor(state, key);
    return [{ ...parsed, minValue: a.minValue, kinds: a.on ? a.kinds : [] }];
  });
}

/** One market's net among the followed: how many are long and short, and their value. */
export interface Agreement {
  market: string;
  long: number;
  short: number;
  longValue: number;
  shortValue: number;
}

/** Where the followed traders in `keys` are positioned, most traders first. */
export function agreement(
  snapshots: readonly TraderSnapshot[],
  keys: readonly string[],
): Agreement[] {
  const wanted = new Set(keys);
  const by = new Map<string, Agreement>();
  for (const s of snapshots) {
    if (!wanted.has(traderKey(s.source, s.id))) continue;
    // One vote per trader and market, by their net side.
    const net = new Map<string, number>();
    for (const h of s.holdings) {
      const signed = (h.side === "long" ? 1 : -1) * h.value;
      net.set(h.market, (net.get(h.market) ?? 0) + signed);
    }
    for (const [market, value] of net) {
      if (value === 0) continue;
      const a = by.get(market) ?? { market, long: 0, short: 0, longValue: 0, shortValue: 0 };
      if (value > 0) {
        a.long += 1;
        a.longValue += value;
      } else {
        a.short += 1;
        a.shortValue -= value;
      }
      by.set(market, a);
    }
  }
  return [...by.values()].sort(
    (a, b) =>
      b.long + b.short - (a.long + a.short) ||
      b.longValue + b.shortValue - (a.longValue + a.shortValue),
  );
}

/** A trader's net side on a market, if they hold one. */
export function netSide(
  snapshot: TraderSnapshot | undefined,
  market: string,
): TraderSide | undefined {
  if (!snapshot) return undefined;
  let net = 0;
  for (const h of snapshot.holdings) {
    if (h.market === market) net += (h.side === "long" ? 1 : -1) * h.value;
  }
  return net > 0 ? "long" : net < 0 ? "short" : undefined;
}

/** The activity log with `move` first, trimmed by count and age. */
export function withMove(
  log: readonly TraderMove[],
  move: TraderMove,
  now = Date.now(),
): TraderMove[] {
  const cutoff = now - ACTIVITY_DAYS * 86_400_000;
  return [move, ...log].filter((m) => m.at >= cutoff).slice(0, MAX_ACTIVITY);
}

export function parseActivity(raw: string | null): TraderMove[] {
  if (!raw) return [];
  try {
    const value = JSON.parse(raw) as unknown;
    if (!Array.isArray(value)) return [];
    return value
      .filter(
        (m): m is TraderMove =>
          !!m &&
          typeof m === "object" &&
          typeof (m as TraderMove).at === "number" &&
          !!parseKey(traderKey((m as TraderMove).source, (m as TraderMove).id)) &&
          !!(m as TraderMove).change &&
          CHANGE_KINDS.includes((m as TraderMove).change.kind),
      )
      .slice(0, MAX_ACTIVITY);
  } catch {
    return [];
  }
}

// --- Stores, shared by every component and the watch in App. ---

function store<T>(key: string, parse: (raw: string | null) => T) {
  const listeners = new Set<() => void>();
  let cachedRaw: string | null | undefined;
  let cached = parse(null);
  const read = (): string | null => {
    try {
      return localStorage.getItem(key);
    } catch {
      return null;
    }
  };
  const current = (): T => {
    const raw = read();
    if (raw !== cachedRaw) {
      cachedRaw = raw;
      cached = parse(raw);
    }
    return cached;
  };
  const save = (next: T) => {
    const raw = JSON.stringify(next);
    try {
      localStorage.setItem(key, raw);
    } catch {
      // Storage unavailable: kept for this session only.
    }
    cachedRaw = raw;
    cached = next;
    for (const l of listeners) l();
  };
  const subscribe = (listener: () => void) => {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  };
  return { current, save, subscribe };
}

const traders = store(KEY, parseTraders);
const activity = store(ACTIVITY_KEY, parseActivity);

export const currentTraders = traders.current;
export const subscribeTraders = traders.subscribe;

/** Records a move in the activity log. */
export function recordMove(move: TraderMove) {
  activity.save(withMove(activity.current(), move));
}

export function useActivity(): TraderMove[] {
  return useSyncExternalStore(activity.subscribe, activity.current);
}

/** The followed traders, their lists and alert settings. */
export function useTraders() {
  const state = useSyncExternalStore(traders.subscribe, traders.current);
  const update = useCallback(
    (change: (s: TradersState) => TradersState) => traders.save(change(traders.current())),
    [],
  );
  return {
    state,
    toggleFollow: useCallback(
      (key: string, name?: string | null) => update((s) => toggleFollow(s, key, name)),
      [update],
    ),
    toggleIn: useCallback(
      (id: string, key: string) => update((s) => toggledIn(s, id, key)),
      [update],
    ),
    setActive: useCallback((id: string) => update((s) => ({ ...s, active: id })), [update]),
    createList: useCallback(
      (name: string) => update((s) => withList(s, crypto.randomUUID(), name)),
      [update],
    ),
    removeList: useCallback((id: string) => update((s) => withoutList(s, id)), [update]),
    setAlerts: useCallback(
      (key: string, alerts: TraderAlerts) => update((s) => withAlerts(s, key, alerts)),
      [update],
    ),
  };
}
