import { type FiredAlert, firedAlertText, type MarketAlert } from "@pewterdesk/ui";
import type { AlertFiring, WatchedAlert } from "../api/daemonClient";
import type { AlertsState } from "./alerts";

// The market alerts pdd watches once the app has quit (`apps/daemon/src/alerts.rs`):
// those on public market data only. PnL and liquidation alerts read the
// account, so they stay with the app.

const WATCHED_KINDS = new Set<WatchedAlert["kind"]>([
  "price",
  "move",
  "funding",
  "rsi",
  "volume",
  "oi",
]);
/** As `MAX_ALERT_TEXT` in crates/protocol. */
const TEXT_MAX = 200;

const watchable = (a: MarketAlert): a is MarketAlert & { kind: WatchedAlert["kind"] } =>
  WATCHED_KINDS.has(a.kind as WatchedAlert["kind"]);

/** The alerts pdd can watch, as it takes them, each with its notification's words. */
export function toWatched(alerts: readonly MarketAlert[]): WatchedAlert[] {
  return alerts.filter(watchable).map((a) => ({
    id: a.id,
    kind: a.kind,
    venue: a.venue,
    market: a.market,
    condition: a.condition,
    value: a.value,
    repeat: a.repeat === "every",
    active: a.active,
    firedAt: a.firedAt,
    text: firedAlertText({ ...a, alertId: a.id, actual: a.value, time: 0 }).slice(0, TEXT_MAX),
    sound: a.notify.includes("sound"),
  }));
}

/**
 * What pdd fired while the app was closed, taken into the app's own state:
 * each one in "Fired today" (shown in the app only: the desktop has had it),
 * and its alert marked fired, off if it fires once.
 */
export function applyAway(
  state: AlertsState,
  firings: readonly AlertFiring[],
  newId: () => string = () => crypto.randomUUID(),
  kept = 50,
): AlertsState {
  const byId = new Map(state.alerts.map((a) => [a.id, a]));
  const fired: FiredAlert[] = [];
  const last = new Map<string, number>();
  for (const f of firings) {
    const a = byId.get(f.alertId);
    if (!a) continue;
    fired.push({
      id: newId(),
      alertId: a.id,
      kind: a.kind,
      venue: a.venue,
      market: a.market,
      symbol: a.symbol,
      condition: a.condition,
      value: a.value,
      actual: f.actual,
      time: f.time,
      notify: ["app"],
    });
    last.set(a.id, Math.max(last.get(a.id) ?? 0, f.time));
  }
  if (fired.length === 0) return state;
  return {
    ...state,
    alerts: state.alerts.map((a) => {
      const at = last.get(a.id);
      if (at === undefined) return a;
      return {
        ...a,
        firedAt: Math.max(a.firedAt ?? 0, at),
        active: a.repeat === "every" && a.active,
      };
    }),
    fired: [...fired.sort((x, y) => y.time - x.time), ...state.fired].slice(0, kept),
  };
}
