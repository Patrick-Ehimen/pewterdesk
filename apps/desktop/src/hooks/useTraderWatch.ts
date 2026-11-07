import { formatCompact, formatNumber, shortAddress, t } from "@pewterdesk/ui";
import { useEffect, useSyncExternalStore } from "react";
import { type TraderMove, type TraderSnapshot, tradersClient } from "../api/venueClient";
import { type NoteChannel, notifyEvent as notifyEventOf } from "../lib/notifications";
import {
  type AlertChannel,
  agreements,
  alertsFor,
  currentTraders,
  FOLLOWING,
  followedKeys,
  recordMove,
  subscribeTraders,
  traderKey,
  watchFollows,
} from "../lib/traders";

// The watch on followed traders, run by App for the whole session: Rust
// looks at their positions (`traders.rs`); this hands it who to watch,
// records what they did, alerts on what meets each one's settings, and
// keeps the last look at each for the Traders page.

const snapshots = new Map<string, TraderSnapshot>();
const listeners = new Set<() => void>();
let shown: TraderSnapshot[] = [];

const FIRED_KEY = "pd.traders.agreed";

/** The agreements already alerted, kept so a restart doesn't say them again. */
function readFired(): Set<string> {
  try {
    const v = JSON.parse(localStorage.getItem(FIRED_KEY) ?? "[]") as unknown;
    return new Set(Array.isArray(v) ? v.filter((k): k is string => typeof k === "string") : []);
  } catch {
    return new Set();
  }
}

/** A list's agree alerts: when enough of its traders hold one side of a market. */
function checkAgreements() {
  const state = currentTraders();
  if (!Object.values(state.listAlerts).some((a) => a.on && a.agree)) return;
  const { fire, now } = agreements(state, shown, readFired());
  try {
    localStorage.setItem(FIRED_KEY, JSON.stringify([...now]));
  } catch {
    // Kept for this session only: the next start may say them again.
  }
  for (const a of fire) {
    const list = state.lists.find((l) => l.id === a.list);
    const alerts = state.listAlerts[a.list];
    if (!list || !alerts) continue;
    notifyEventOf({
      type: "alert",
      title: t("traders.agree.noteTitle", {
        list: list.id === FOLLOWING ? t("traders.list.following") : list.name,
      }),
      body: t("traders.agree.noteBody", {
        count: a.count,
        total: a.total,
        side: t(a.side === "long" ? "traders.long" : "traders.short"),
        market: a.market,
      }),
      tone: "neutral",
      sound: "alert",
      only: channels(alerts.to),
    });
  }
}

/** The notification channels a trader's or list's alerts go to. */
function channels(to: readonly AlertChannel[]): NoteChannel[] {
  return [
    ...(to.includes("app") ? (["toast", "sound"] as const) : []),
    ...(to.includes("desktop") ? (["desktop"] as const) : []),
  ];
}

function publish() {
  const keys = new Set(followedKeys(currentTraders()));
  shown = [...snapshots.values()].filter((s) => keys.has(traderKey(s.source, s.id)));
  for (const l of listeners) l();
  checkAgreements();
}

function take(snapshot: TraderSnapshot) {
  snapshots.set(traderKey(snapshot.source, snapshot.id), snapshot);
  publish();
}

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

/** The last look at each followed trader's positions. */
export function useTraderSnapshots(): TraderSnapshot[] {
  return useSyncExternalStore(subscribe, () => shown);
}

/** A trader's name as the page shows it: theirs, or a short id. */
export function traderName(source: TraderMove["source"], id: string, name?: string | null) {
  const stored = name ?? currentTraders().names[traderKey(source, id)];
  if (stored) return stored;
  return source === "hyperliquid" ? shortAddress(id) : id.slice(0, 8);
}

/** A size with as many decimals as it needs: 0.0125, 3.25, 2,355. */
export const sizeText = (v: number) => formatNumber(v, v < 1 ? 4 : v < 100 ? 2 : 0);

/** "Opened a short: 12 BTC at 75,940 ($911K)". */
export function moveText(move: TraderMove): string {
  const c = move.change;
  const size = sizeText(c.kind === "close" ? c.sizeBefore : Math.abs(c.sizeAfter - c.sizeBefore));
  return t(`traders.move.${c.kind}`, {
    side: t(c.side === "long" ? "traders.long" : "traders.short"),
    size: c.kind === "flip" ? sizeText(c.sizeAfter) : size,
    market: c.market,
    price: formatNumber(c.price, c.price < 10 ? 4 : 2),
    value: `$${formatCompact(c.value)}`,
  });
}

function notify(move: TraderMove) {
  const to = alertsFor(currentTraders(), traderKey(move.source, move.id)).to;
  if (to.length === 0) return;
  notifyEventOf({
    type: "alert",
    title: t("traders.note.title", { name: traderName(move.source, move.id) }),
    body: moveText(move),
    tone: "neutral",
    sound: "alert",
    only: channels(to),
  });
}

/** Keeps Rust watching whoever is followed, and acts on what they do. */
export function useTraderWatch() {
  useEffect(() => {
    let last = "";
    const sync = () => {
      const follows = watchFollows(currentTraders());
      const next = JSON.stringify(follows);
      if (next === last) return;
      last = next;
      void tradersClient.watch(follows).catch(() => {
        // Not in the desktop shell: nothing to watch with.
      });
      publish();
    };
    sync();
    const stop = subscribeTraders(sync);
    void tradersClient
      .snapshots()
      .then((all) => {
        for (const s of all) snapshots.set(traderKey(s.source, s.id), s);
        publish();
      })
      .catch(() => {});
    const offSnapshot = tradersClient.onSnapshot(take);
    const offMove = tradersClient.onMove((move) => {
      recordMove(move);
      if (move.alert) notify(move);
    });
    return () => {
      stop();
      offSnapshot();
      offMove();
    };
  }, []);
}
