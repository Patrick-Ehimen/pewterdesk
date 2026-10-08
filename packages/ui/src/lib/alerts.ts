import type { MarketSummary, Position, VenueId } from "@pewterdesk/core";

// Market alerts: what they watch, how close they are to firing, and whether
// a new price crossed their line. Plain logic; the app stores and runs them.

/**
 * What an alert watches. On the market: the mark price, the 24h change (in
 * %), the funding rate (in % per interval), RSI(14) on hourly candles, 24h
 * volume and open interest (both in the quote asset). On your own position
 * in that market: its unrealized PnL (quote asset) and how far the mark is
 * from its liquidation price (in %).
 */
export type AlertKind = "price" | "move" | "funding" | "rsi" | "volume" | "oi" | "pnl" | "liq";
export const ALERT_KINDS: readonly AlertKind[] = [
  "price",
  "move",
  "funding",
  "rsi",
  "volume",
  "oi",
  "pnl",
  "liq",
];
/** Kinds that read your position, so need a connected account. */
export const ACCOUNT_KINDS: ReadonlySet<AlertKind> = new Set(["pnl", "liq"]);
/**
 * How a kind's distance to its line is measured: as a share of the current
 * value (price, volume, open interest), or in the kind's own units.
 */
const RELATIVE_KINDS: ReadonlySet<AlertKind> = new Set(["price", "volume", "oi"]);

export type AlertCondition = "above" | "below";
/** Once: switches itself off after firing. Every: fires again after a cooldown. */
export type AlertRepeat = "once" | "every";
/** Where a fired alert shows up. "menuBar" is the tray item's title, for a while. */
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
  /**
   * In the kind's units: a price; a percentage (5 = 5%) for "move",
   * "funding" and "liq"; an RSI reading; a quote amount for the rest.
   */
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
  /** Where the alert was set to notify; unset on ones fired before this was kept. */
  notify?: AlertChannel[];
}

/** What a kind may need beyond the market's summary. */
export interface AlertContext {
  /** RSI(14) on the market's hourly candles. */
  rsi?: number;
  /** Your open position in the market, if any. */
  position?: Position;
}

/**
 * What `kind` watches, from the market's summary and `context`; undefined
 * when it can't be read (no summary yet, no RSI yet, no position).
 */
export function watchedValue(
  kind: AlertKind,
  summary: MarketSummary | undefined,
  context: AlertContext = {},
) {
  if (kind === "rsi") return Number.isFinite(context.rsi) ? context.rsi : undefined;
  if (kind === "pnl") {
    const pnl = Number(context.position?.unrealizedPnl);
    return context.position && Number.isFinite(pnl) ? pnl : undefined;
  }
  if (kind === "liq") {
    const p = context.position;
    const mark = Number(p?.markPrice);
    const liq = Number(p?.liquidationPrice);
    if (!p || !(mark > 0) || !(liq > 0)) return undefined;
    return (Math.abs(mark - liq) / mark) * 100;
  }
  if (!summary) return undefined;
  const mark = Number(summary.markPrice);
  let value: number;
  switch (kind) {
    case "volume":
      value = Number(summary.dayVolume);
      break;
    case "oi":
      value = Number(summary.openInterest) * mark;
      break;
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
 * current value for price, volume and open interest (0.05 = 5% away), the
 * kind's own units for the others (percentage points, RSI points, quote
 * amount). Zero or less means it's already on the far side.
 */
export function distanceToFire(
  alert: Pick<MarketAlert, "kind" | "condition" | "value">,
  current: number | undefined,
) {
  if (current === undefined) return undefined;
  const gap = alert.condition === "above" ? alert.value - current : current - alert.value;
  if (!RELATIVE_KINDS.has(alert.kind)) return gap;
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

/** Whether a kind's distance is a share of its current value (see `distanceToFire`). */
export const isRelativeKind = (kind: AlertKind) => RELATIVE_KINDS.has(kind);

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
    if (RELATIVE_KINDS.has(a.kind)) return Math.abs(d);
    // A quote amount is compared with the size of its own line; points are out of 100.
    return Math.abs(a.kind === "pnl" ? d / Math.max(Math.abs(a.value), 1) : d / 100);
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
