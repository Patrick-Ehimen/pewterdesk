import type { MarketSummary, VenueId } from "@pewterdesk/core";

// Market alerts: what they watch, how close they are to firing, and whether
// a new price crossed their line. Plain logic; the app stores and runs them.

/**
 * What an alert watches: the mark price, the 24h change (in %), or the
 * current funding rate (in % per interval).
 */
export type AlertKind = "price" | "move" | "funding";
export const ALERT_KINDS: readonly AlertKind[] = ["price", "move", "funding"];

export type AlertCondition = "above" | "below";
/** Once: switches itself off after firing. Every: fires again after a cooldown. */
export type AlertRepeat = "once" | "every";
/** Where a fired alert shows up. Only "app" is delivered so far. */
export type AlertChannel = "app" | "desktop" | "sound" | "menuBar";

/** An "every time" alert stays quiet this long after firing. */
export const ALERT_COOLDOWN_MS = 5 * 60_000;

export interface MarketAlert {
  id: string;
  kind: AlertKind;
  venue: VenueId;
  /** `Market::id`. */
  market: string;
  /** `Market::symbol`, for display. */
  symbol: string;
  condition: AlertCondition;
  /** A price for "price"; a percentage (5 = 5%) for "move" and "funding". */
  value: number;
  repeat: AlertRepeat;
  notify: AlertChannel[];
  note?: string;
  active: boolean;
  createdAt: number;
  /** When it last fired, for the "every time" cooldown. */
  firedAt?: number;
}

/** A fired alert, as listed under "Fired today". */
export interface FiredAlert {
  id: string;
  alertId: string;
  kind: AlertKind;
  venue: VenueId;
  market: string;
  symbol: string;
  condition: AlertCondition;
  value: number;
  /** What the watched value was when it fired. */
  actual: number;
  time: number;
}

/** What `kind` watches, from a market summary; undefined when it can't be read. */
export function watchedValue(kind: AlertKind, summary: MarketSummary | undefined) {
  if (!summary) return undefined;
  const mark = Number(summary.markPrice);
  let value: number;
  switch (kind) {
    case "price":
      value = mark;
      break;
    case "move": {
      const prev = Number(summary.prevDayPrice);
      if (!(prev > 0)) return undefined;
      value = ((mark - prev) / prev) * 100;
      break;
    }
    case "funding":
      value = Number(summary.fundingRate) * 100;
      break;
  }
  return Number.isFinite(value) ? value : undefined;
}

/**
 * How far the watched value is from the alert's line: a fraction of the
 * price for "price" (0.05 = 5% away), percentage points for the others.
 * Zero or less means it's already on the far side.
 */
export function distanceToFire(
  alert: Pick<MarketAlert, "kind" | "condition" | "value">,
  current: number | undefined,
) {
  if (current === undefined) return undefined;
  const gap = alert.condition === "above" ? alert.value - current : current - alert.value;
  if (alert.kind !== "price") return gap;
  return current > 0 ? gap / current : undefined;
}

/**
 * Whether moving from `previous` to `current` crossed the alert's line.
 * The first reading (no `previous`) never fires, so an alert set on the
 * far side of its line waits for a real crossing.
 */
export function crossed(
  alert: Pick<MarketAlert, "condition" | "value">,
  previous: number | undefined,
  current: number | undefined,
) {
  if (previous === undefined || current === undefined) return false;
  return alert.condition === "above"
    ? previous < alert.value && current >= alert.value
    : previous > alert.value && current <= alert.value;
}

/** Whether `alert` may fire at `now`: on, and out of its cooldown if it repeats. */
export function canFire(alert: MarketAlert, now: number) {
  if (!alert.active) return false;
  return alert.firedAt === undefined || now - alert.firedAt >= ALERT_COOLDOWN_MS;
}

/**
 * Active alerts first, closest to firing first (unknown distances after);
 * paused ones last, newest first. Price distances are fractions and the
 * others percentage points, so the others are scaled to match.
 */
export function sortAlerts(
  alerts: readonly MarketAlert[],
  currentOf: (alert: MarketAlert) => number | undefined,
): MarketAlert[] {
  const closeness = (a: MarketAlert) => {
    const d = distanceToFire(a, currentOf(a));
    if (d === undefined) return Number.POSITIVE_INFINITY;
    return Math.abs(a.kind === "price" ? d : d / 100);
  };
  return [...alerts].sort((a, b) => {
    if (a.active !== b.active) return a.active ? -1 : 1;
    if (!a.active) return b.createdAt - a.createdAt;
    return closeness(a) - closeness(b);
  });
}

/** Whether `time` falls on the same local day as `now`. */
export function isToday(time: number, now = Date.now()) {
  return new Date(time).toDateString() === new Date(now).toDateString();
}
