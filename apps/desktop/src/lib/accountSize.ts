// The leaderboard's account size filter: bands of what a trader trades with
// (USD; on OKX, the assets a lead trader manages), and "and up" floors.
// Rust filters by them (`AccountRange`), so a band gets its own top traders.

export const SIZE_BANDS = [
  "any",
  "100kUp",
  "1mUp",
  "100",
  "1k",
  "10k",
  "100k",
  "1m",
  "10m",
] as const;
export type SizeBand = (typeof SIZE_BANDS)[number];

export interface AccountRange {
  min: number;
  /** None: no ceiling. */
  max: number | null;
}

const K = 1_000;
const M = 1_000_000;

export const BAND_RANGE: Record<SizeBand, AccountRange> = {
  any: { min: 0, max: null },
  "100kUp": { min: 100 * K, max: null },
  "1mUp": { min: M, max: null },
  "100": { min: 100, max: K },
  "1k": { min: K, max: 10 * K },
  "10k": { min: 10 * K, max: 100 * K },
  "100k": { min: 100 * K, max: M },
  "1m": { min: M, max: 10 * M },
  "10m": { min: 10 * M, max: null },
};

export const isSizeBand = (v: unknown): v is SizeBand =>
  typeof v === "string" && (SIZE_BANDS as readonly string[]).includes(v);

/** The band an old saved floor ("Account ≥ $1M" or the $100K default) comes to. */
export const bandFromFloor = (min: unknown): SizeBand => (Number(min) >= M ? "1mUp" : "100kUp");
