import { ALERT_KINDS, type FiredAlert, type MarketAlert } from "@pewterdesk/ui";
import { VENUE_IDS } from "./venues";

// Market alerts, kept on this machine. They name public markets and prices,
// nothing about the account, so browser storage is fine.

const STORAGE_KEY = "pd.alerts";
/** More than anyone sets by hand; stops a corrupt store growing without bound. */
const MAX_ALERTS = 200;

export interface AlertsState {
  alerts: MarketAlert[];
  fired: FiredAlert[];
  /** Every alert held, without switching each one off. */
  paused: boolean;
  /** When the popover was last opened; later firings show on the bell. */
  seenAt: number;
}

type Store = Pick<Storage, "getItem" | "setItem">;

const EMPTY: AlertsState = { alerts: [], fired: [], paused: false, seenAt: 0 };

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null;

const isVenue = (v: unknown) => VENUE_IDS.some((id) => id === v);
const isKind = (v: unknown) => ALERT_KINDS.some((k) => k === v);
const isCondition = (v: unknown) => v === "above" || v === "below";

function isAlert(v: unknown): v is MarketAlert {
  return (
    isRecord(v) &&
    typeof v.id === "string" &&
    isKind(v.kind) &&
    isVenue(v.venue) &&
    typeof v.market === "string" &&
    typeof v.symbol === "string" &&
    isCondition(v.condition) &&
    typeof v.value === "number" &&
    Number.isFinite(v.value) &&
    (v.repeat === "once" || v.repeat === "every") &&
    Array.isArray(v.notify) &&
    typeof v.active === "boolean" &&
    typeof v.createdAt === "number"
  );
}

function isFired(v: unknown): v is FiredAlert {
  return (
    isRecord(v) &&
    typeof v.id === "string" &&
    isKind(v.kind) &&
    isVenue(v.venue) &&
    typeof v.market === "string" &&
    typeof v.symbol === "string" &&
    isCondition(v.condition) &&
    typeof v.value === "number" &&
    typeof v.time === "number"
  );
}

/** The saved alerts; anything unreadable is dropped rather than failing the lot. */
export function loadAlerts(store: Store | undefined = storage()): AlertsState {
  try {
    const parsed: unknown = JSON.parse(store?.getItem(STORAGE_KEY) ?? "null");
    if (!isRecord(parsed)) return EMPTY;
    return {
      alerts: (Array.isArray(parsed.alerts) ? parsed.alerts : [])
        .filter(isAlert)
        .slice(0, MAX_ALERTS),
      fired: (Array.isArray(parsed.fired) ? parsed.fired : []).filter(isFired),
      paused: parsed.paused === true,
      seenAt: typeof parsed.seenAt === "number" ? parsed.seenAt : 0,
    };
  } catch {
    return EMPTY;
  }
}

export function saveAlerts(state: AlertsState, store: Store | undefined = storage()) {
  try {
    store?.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    // Storage full or unavailable; the alerts just won't survive a restart.
  }
}

function storage(): Store | undefined {
  try {
    return localStorage;
  } catch {
    return undefined;
  }
}
