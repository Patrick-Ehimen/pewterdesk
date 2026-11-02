import type { VenueId } from "@pewterdesk/core";
import { SCAN_RULES, type ScanRule } from "@pewterdesk/ui";

// Alerts on a scan's state: a market entering a divergence, a high squeeze risk,
// a key level or a trend. Kept on this machine, read-only: they only notify.

const KEY = "pd.scanAlerts";
const MAX = 100;

export interface ScanAlert {
  id: string;
  rule: ScanRule;
  venue: VenueId;
  /** `Market::id`, or null for every market starred on the venue. */
  market: string | null;
  symbol?: string;
}

const isAlert = (v: unknown): v is ScanAlert => {
  const a = v as Partial<ScanAlert> | null;
  return (
    typeof a === "object" &&
    a !== null &&
    typeof a.id === "string" &&
    typeof a.venue === "string" &&
    SCAN_RULES.includes(a.rule as ScanRule) &&
    (a.market === null || typeof a.market === "string")
  );
};

export function parseScanAlerts(raw: string | null): ScanAlert[] {
  try {
    const parsed: unknown = JSON.parse(raw ?? "[]");
    return Array.isArray(parsed) ? parsed.filter(isAlert).slice(0, MAX) : [];
  } catch {
    return [];
  }
}

export function loadScanAlerts(): ScanAlert[] {
  try {
    return parseScanAlerts(localStorage.getItem(KEY));
  } catch {
    return [];
  }
}

export function saveScanAlerts(alerts: readonly ScanAlert[]) {
  try {
    localStorage.setItem(KEY, JSON.stringify(alerts));
  } catch {
    // Storage unavailable; the alerts just won't survive a restart.
  }
}

const same = (a: ScanAlert, rule: ScanRule, venue: VenueId, market: string | null) =>
  a.rule === rule && a.venue === venue && a.market === market;

/** The alert for this rule and scope, if there is one. */
export const findScanAlert = (
  alerts: readonly ScanAlert[],
  rule: ScanRule,
  venue: VenueId,
  market: string | null,
) => alerts.find((a) => same(a, rule, venue, market));

/** The alerts with this one added, or taken off if it was there. */
export function toggledScanAlert(
  alerts: readonly ScanAlert[],
  entry: Omit<ScanAlert, "id"> & { id?: string },
): ScanAlert[] {
  if (findScanAlert(alerts, entry.rule, entry.venue, entry.market)) {
    return alerts.filter((a) => !same(a, entry.rule, entry.venue, entry.market));
  }
  return [...alerts, { ...entry, id: entry.id ?? crypto.randomUUID() }].slice(-MAX);
}
