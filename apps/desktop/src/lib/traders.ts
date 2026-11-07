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

/** Where an alert goes: the app (a toast and its sound) and the desktop. */
export type AlertChannel = "app" | "desktop";
export const ALERT_CHANNELS: readonly AlertChannel[] = ["app", "desktop"];

export interface TraderAlerts {
  on: boolean;
  /** Moves worth less (USD) are kept but don't alert. */
  minValue: number;
  kinds: TraderChangeKind[];
  /** The markets that alert (base coins); none means all of them. */
  markets: string[];
  to: AlertChannel[];
}

/** A list's alerts: the default for its traders, and when enough of them agree. */
export interface ListAlerts extends TraderAlerts {
  /** Alert when this many of the list hold the same side of a market; null, never. */
  agree: number | null;
}

export interface TradersState {
  lists: TraderList[];
  /** The list on screen. */
  active: string;
  /** Per trader, where set; the rest take their first list's, then `DEFAULT_ALERTS`. */
  alerts: Record<string, TraderAlerts>;
  /** Per list, where set. */
  listAlerts: Record<string, ListAlerts>;
  /** The name each followed trader had on a leaderboard, to show without one. */
  names: Record<string, string>;
}

export const DEFAULT_ALERTS: TraderAlerts = {
  on: true,
  minValue: 50_000,
  kinds: ["open", "add", "close", "flip"],
  markets: [],
  to: ["app", "desktop"],
};

export const DEFAULT_LIST_ALERTS: ListAlerts = { ...DEFAULT_ALERTS, agree: null };

const EMPTY: TradersState = {
  lists: [{ id: FOLLOWING, name: "", keys: [] }],
  active: FOLLOWING,
  alerts: {},
  listAlerts: {},
  names: {},
};

const ADDRESS = /^0x[0-9a-f]{40}$/;
/** A base coin, as the sources name them: "BTC", "1000PEPE". */
const COIN = /^[0-9A-Za-z]{1,20}$/;
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
    markets: Array.isArray(a.markets)
      ? [
          ...new Set(a.markets.filter((m): m is string => typeof m === "string" && COIN.test(m))),
        ].slice(0, 50)
      : [],
    to: Array.isArray(a.to)
      ? ALERT_CHANNELS.filter((c) => a.to?.includes(c))
      : [...DEFAULT_ALERTS.to],
  };
}

function cleanListAlerts(value: unknown): ListAlerts | undefined {
  const base = cleanAlerts(value);
  if (!base) return undefined;
  const agree = Number((value as Partial<ListAlerts>).agree);
  return {
    ...base,
    agree: Number.isInteger(agree) && agree >= 2 && agree <= MAX_FOLLOWED ? agree : null,
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
    const listAlerts: Record<string, ListAlerts> = {};
    for (const [id, a] of Object.entries(value.listAlerts ?? {})) {
      const clean = lists.some((l) => l.id === id) && cleanListAlerts(a);
      if (clean) listAlerts[id] = clean;
    }
    const names: Record<string, string> = {};
    for (const [k, n] of Object.entries(value.names ?? {})) {
      if (parseKey(k) && typeof n === "string" && n.trim()) names[k] = n.trim().slice(0, 40);
    }
    const kept = lists.slice(0, MAX_LISTS);
    const active =
      kept.some((l) => l.id === value.active) ||
      (SOURCE_LISTS as readonly unknown[]).includes(value.active)
        ? String(value.active)
        : FOLLOWING;
    return { lists: kept, active, alerts, listAlerts, names };
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
    // Into the list on screen, or Following when that's one made by source.
    lists: state.lists.map((l) =>
      l.id === (state.lists.some((x) => x.id === state.active) ? state.active : FOLLOWING)
        ? { ...l, keys: [...l.keys, key] }
        : l,
    ),
  };
}

/** The lists made by source, from whoever is followed: not stored, not edited. */
export const SOURCE_LISTS = ["source:hyperliquid", "source:okx"] as const;
export type SourceList = (typeof SOURCE_LISTS)[number];

/** The followed traders on a list, whether one of the trader's own or one made by source. */
export function listKeys(state: TradersState, id: string): string[] {
  const source = (SOURCE_LISTS as readonly string[]).includes(id)
    ? id.slice("source:".length)
    : undefined;
  if (source) return followedKeys(state).filter((k) => k.startsWith(`${source}:`));
  return state.lists.find((l) => l.id === id)?.keys ?? [];
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

/** A trader's alerts: their own, else their first list's that has some, else the defaults. */
export const alertsFor = (state: TradersState, key: string): TraderAlerts =>
  state.alerts[key] ??
  state.lists.filter((l) => l.keys.includes(key)).flatMap((l) => state.listAlerts[l.id] ?? [])[0] ??
  DEFAULT_ALERTS;

/** Whether a trader has alerts of their own, rather than their list's. */
export const ownAlerts = (state: TradersState, key: string) => key in state.alerts;

export const listAlertsFor = (state: TradersState, id: string): ListAlerts =>
  state.listAlerts[id] ?? DEFAULT_LIST_ALERTS;

export function withListAlerts(state: TradersState, id: string, alerts: ListAlerts): TradersState {
  const clean = cleanListAlerts(alerts);
  return clean && state.lists.some((l) => l.id === id)
    ? { ...state, listAlerts: { ...state.listAlerts, [id]: clean } }
    : state;
}

/** A trader back on their list's alerts. */
export function withoutOwnAlerts(state: TradersState, key: string): TradersState {
  const { [key]: _gone, ...rest } = state.alerts;
  return { ...state, alerts: rest };
}

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
    return [{ ...parsed, minValue: a.minValue, kinds: a.on ? a.kinds : [], markets: a.markets }];
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
  snapshots: readonly Pick<TraderSnapshot, "source" | "id" | "holdings">[],
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

/** A list whose traders agree on a market, as an alert says it. */
export interface Agreed {
  list: string;
  market: string;
  side: TraderSide;
  count: number;
  total: number;
}

/**
 * The lists, with an agree threshold, where at least that many of their
 * traders now hold the same side of a market. `fired` is what was said
 * before (keys "list|market|side"): only what's new goes in `fire`, and
 * `now` is every agreement holding now, to remember for next time, so one
 * that breaks up and forms again alerts again.
 */
export function agreements(
  state: TradersState,
  snapshots: readonly Pick<TraderSnapshot, "source" | "id" | "holdings">[],
  fired: ReadonlySet<string>,
): { fire: Agreed[]; now: Set<string> } {
  const fire: Agreed[] = [];
  const now = new Set<string>();
  for (const list of state.lists) {
    const need = state.listAlerts[list.id]?.on ? state.listAlerts[list.id]?.agree : null;
    if (!need) continue;
    for (const a of agreement(snapshots, list.keys)) {
      for (const side of ["long", "short"] as const) {
        const count = side === "long" ? a.long : a.short;
        if (count < need) continue;
        const key = `${list.id}|${a.market}|${side}`;
        now.add(key);
        if (!fired.has(key))
          fire.push({ list: list.id, market: a.market, side, count, total: list.keys.length });
      }
    }
  }
  return { fire, now };
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
  /** Gone from storage and from memory: nothing to read back. */
  const clear = () => {
    try {
      localStorage.removeItem(key);
    } catch {
      // Storage unavailable: there was nothing kept there.
    }
    cachedRaw = null;
    cached = parse(null);
    for (const l of listeners) l();
  };
  return { current, save, subscribe, clear };
}

const traders = store(KEY, parseTraders);
const activity = store(ACTIVITY_KEY, parseActivity);

export const currentTraders = traders.current;
export const subscribeTraders = traders.subscribe;

/** Records a move in the activity log. */
/** The activity log as it stands, newest first. */
export const currentActivity = activity.current;

/** Deletes the activity log: from this machine's storage, and from memory. */
export function clearActivity() {
  activity.clear();
}

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
    resetAlerts: useCallback((key: string) => update((s) => withoutOwnAlerts(s, key)), [update]),
    setListAlerts: useCallback(
      (id: string, alerts: ListAlerts) => update((s) => withListAlerts(s, id, alerts)),
      [update],
    ),
  };
}
