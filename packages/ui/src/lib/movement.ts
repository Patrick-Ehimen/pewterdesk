import type { MarketSummary } from "@pewterdesk/core";

// The bottom bar's market movement: each venue's totals and breadth, and the
// biggest movers across venues, from the venues' market summaries.

export interface VenueMovement {
  /** Traded value over 24 hours, in the quote asset. */
  volume: number;
  /** Open interest valued at the mark, in the quote asset. */
  openInterest: number;
  /** Markets up, down and unchanged over 24 hours. */
  up: number;
  down: number;
  flat: number;
  /** Volume-weighted 24h change, as a fraction. */
  change: number;
}

const changeOf = (s: MarketSummary) => {
  const prev = Number(s.prevDayPrice);
  return prev > 0 ? (Number(s.markPrice) - prev) / prev : undefined;
};

export function venueMovement(summaries: readonly MarketSummary[]): VenueMovement {
  let volume = 0;
  let openInterest = 0;
  let weighted = 0;
  let up = 0;
  let down = 0;
  let flat = 0;
  for (const s of summaries) {
    const vol = Number(s.dayVolume) || 0;
    volume += vol;
    openInterest += (Number(s.openInterest) || 0) * (Number(s.markPrice) || 0);
    const c = changeOf(s);
    if (c === undefined) continue;
    weighted += c * vol;
    if (c > 0) up += 1;
    else if (c < 0) down += 1;
    else flat += 1;
  }
  return { volume, openInterest, up, down, flat, change: volume > 0 ? weighted / volume : 0 };
}

export interface Mover<V> {
  venue: V;
  market: string;
  /** As a fraction. */
  change: number;
  volume: number;
}

/**
 * The biggest 24h moves up and down across venues, among markets trading at
 * least `minVolume` a day, so a thin market's spike doesn't lead the list.
 */
export function topMovers<V>(
  venues: readonly { venue: V; summaries: readonly MarketSummary[] }[],
  count: number,
  minVolume: number,
): { up: Mover<V>[]; down: Mover<V>[] } {
  const all: Mover<V>[] = [];
  for (const { venue, summaries } of venues) {
    for (const s of summaries) {
      const change = changeOf(s);
      const volume = Number(s.dayVolume) || 0;
      if (change === undefined || volume < minVolume) continue;
      all.push({ venue, market: s.market, change, volume });
    }
  }
  const byChange = [...all].sort((a, b) => b.change - a.change);
  return {
    up: byChange.filter((m) => m.change > 0).slice(0, count),
    down: byChange
      .filter((m) => m.change < 0)
      .reverse()
      .slice(0, count),
  };
}
