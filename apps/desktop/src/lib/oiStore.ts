import type { MarketSummary, VenueId } from "@pewterdesk/core";
import { OI_KEEP, type OiSample, withOiSample } from "@pewterdesk/ui";

/** How often a sample is written, at most. */
const EVERY_MS = 5 * 60_000;
/** Markets kept: the largest by open interest. */
const MARKETS = 150;

// Open-interest samples for the venues that publish no history of it
// (Hyperliquid, Aster), for the Maps page's open-interest view. Taken from
// the summaries the app streams anyway, every few minutes while it runs
// (thinned to hourly after two hours), with the price at the time, and kept
// on this machine for a day and a bit, for the largest markets only.

export interface OiStore {
  /** When sampling began (the oldest sample kept). */
  since?: number;
  /** When the last sample was written. */
  last?: number;
  markets: Record<string, OiSample[]>;
}

const key = (venue: VenueId) => `pd.oi.${venue}`;

export function parseOi(raw: string | null): OiStore {
  try {
    const value = JSON.parse(raw ?? "") as Partial<OiStore>;
    const markets: Record<string, OiSample[]> = {};
    for (const [id, list] of Object.entries(value.markets ?? {})) {
      if (!Array.isArray(list)) continue;
      const clean = list.filter(
        (s): s is OiSample => !!s && Number.isFinite(s.time) && Number.isFinite(s.oi) && s.oi > 0,
      );
      if (clean.length > 0) markets[id] = clean.slice(-OI_KEEP * 2);
    }
    return {
      since: typeof value.since === "number" ? value.since : undefined,
      last: typeof value.last === "number" ? value.last : undefined,
      markets,
    };
  } catch {
    return { markets: {} };
  }
}

export function loadOi(venue: VenueId): OiStore {
  try {
    return parseOi(localStorage.getItem(key(venue)));
  } catch {
    return { markets: {} };
  }
}

/**
 * `store` with a sample of each of the largest markets added, or unchanged
 * when the last was written under 5 minutes ago. Markets no longer listed,
 * or no longer among the largest, drop out.
 */
export function withSummaries(
  store: OiStore,
  summaries: readonly MarketSummary[],
  now: number,
): OiStore {
  if (store.last !== undefined && now - store.last < EVERY_MS && now >= store.last) return store;
  const largest = [...summaries]
    .map((s) => ({ s, value: Number(s.openInterest) * Number(s.markPrice) }))
    .filter(({ value }) => value > 0)
    .sort((a, b) => b.value - a.value)
    .slice(0, MARKETS);
  const markets: Record<string, OiSample[]> = {};
  for (const { s } of largest) {
    const next = withOiSample(
      store.markets[s.market] ?? [],
      now,
      Number(s.openInterest),
      Number(s.markPrice),
    );
    if (next.length > 0) markets[s.market] = next;
  }
  const oldest = Math.min(...Object.values(markets).map((l) => l[0]?.time ?? now), now);
  return { since: oldest, last: now, markets };
}

/** Records a sample for `venue`, unless one was written in the last 5 minutes. */
export function recordOi(venue: VenueId, summaries: readonly MarketSummary[], now: number) {
  const store = loadOi(venue);
  const next = withSummaries(store, summaries, now);
  if (next === store) return;
  try {
    localStorage.setItem(key(venue), JSON.stringify(next));
  } catch {
    // Storage full or unavailable: the view keeps collecting from now.
  }
}
