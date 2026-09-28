import type { FundingRate } from "@pewterdesk/core";

export type FundingResolution = "1h" | "8h" | "1d";

export const FUNDING_RESOLUTIONS: readonly FundingResolution[] = ["1h", "8h", "1d"];

export const BUCKET_MS: Record<FundingResolution, number> = {
  "1h": 3_600_000,
  "8h": 8 * 3_600_000,
  "1d": 24 * 3_600_000,
};

/**
 * A payment is stamped just after the interval it covers (01:00:00.041 pays
 * for 00:00–01:00), so it's filed a minute earlier: under the period it
 * belongs to, not the next one.
 */
const SETTLE_SLACK_MS = 60_000;

/** A period's rate as a yearly one: `rate` × periods in a year. */
export function annualised(rate: number, resolution: FundingResolution): number {
  return rate * ((365 * 24 * 3_600_000) / BUCKET_MS[resolution]);
}

export interface FundingPoint {
  /** Start of the period, epoch ms (UTC-aligned: 8h at 00/08/16, days at 00:00). */
  time: number;
  /** Funding paid over the period: the sum of its payments, as a fraction. */
  rate: number;
  /** Everything paid from the first period through this one, as a fraction. */
  cumulative: number;
}

/**
 * Funding payments (oldest first) grouped into `resolution` periods: each
 * period's total, and the running total. Positive means longs paid shorts.
 */
export function fundingSeries(
  rates: readonly FundingRate[],
  resolution: FundingResolution,
): FundingPoint[] {
  const size = BUCKET_MS[resolution];
  const points: FundingPoint[] = [];
  let cumulative = 0;
  for (const r of rates) {
    const rate = Number(r.rate);
    if (!Number.isFinite(rate)) continue;
    const time = Math.floor((r.time - SETTLE_SLACK_MS) / size) * size;
    cumulative += rate;
    const last = points.at(-1);
    if (last && last.time === time) {
      last.rate += rate;
      last.cumulative = cumulative;
    } else {
      points.push({ time, rate, cumulative });
    }
  }
  return points;
}
