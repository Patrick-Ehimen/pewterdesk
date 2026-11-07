import type { TraderPeriod, TraderRow, TraderStats } from "../api/venueClient";

// How a leaderboard trader trades, from their line on it: tags under their
// name, and the board's filter chips. Rules of thumb, said so on the chips.

export type TraderStyle = "whale" | "scalper" | "swing";
export const STYLES: readonly TraderStyle[] = ["swing", "scalper", "whale"];

/** Account (Hyperliquid) or assets managed (OKX) that make a whale. */
export const WHALE = { hyperliquid: 10_000_000, okx: 1_000_000 } as const;
/** Volume a day, as a share of the account: at least this, a scalper. */
export const SCALPER_TURNOVER = 1;
/** At most this, a swing trader. */
export const SWING_TURNOVER = 0.2;
/** Over this share of the month's PnL in one day: a one-hit wonder. */
export const ONE_HIT = 0.5;

const DAYS: Record<TraderPeriod, number | undefined> = {
  day: 1,
  week: 7,
  month: 30,
  // All time has no fixed length: turnover can't be read from it.
  allTime: undefined,
};

/** The trader's styles: whale by size; scalper or swing by how much they turn over. */
export function stylesOf(row: TraderRow, period: TraderPeriod): TraderStyle[] {
  const out: TraderStyle[] = [];
  const days = DAYS[period];
  if (row.source === "hyperliquid" && days && row.volume != null && row.accountValue > 0) {
    const turnover = row.volume / row.accountValue / days;
    if (turnover >= SCALPER_TURNOVER) out.push("scalper");
    else if (turnover <= SWING_TURNOVER && row.volume > 0) out.push("swing");
  }
  if (row.accountValue >= WHALE[row.source]) out.push("whale");
  return out;
}

/** One day made over half the month's PnL. Unknown (false) until their record is read. */
export const isOneHit = (stats: TraderStats | null | undefined) =>
  (stats?.bestDayShare ?? 0) > ONE_HIT;
