import type { Bar } from "openalgo-charts";

// Volume at price over a run of bars: the sum behind the price chart's
// visible range volume profile. Display only, so it is JS numbers.

/** One row of the profile: a price band and the volume traded in it. */
export interface ProfileRow {
  low: number;
  high: number;
  /** Volume of the bars that closed at or above their open. */
  up: number;
  /** Volume of the bars that closed below it. */
  down: number;
}

export interface VolumeProfile {
  /** Equal bands from the lowest low to the highest high, lowest first. */
  rows: ProfileRow[];
  /** The row with the most volume (the point of control). */
  poc: number;
  /** The value area: the rows from `valueLow` to `valueHigh`, both included. */
  valueLow: number;
  valueHigh: number;
  /** The largest row's volume, the length every row is drawn against. */
  max: number;
}

/**
 * The profile of `bars` in `rowCount` rows. A bar's volume is shared across
 * the rows its range covers, in proportion to how much of its range each
 * holds. The value area grows from the point of control, a row at a time
 * towards the busier side, until it holds `valueArea` (0..1) of the volume.
 * Undefined when the bars have no range or no volume.
 */
export function volumeProfile(
  bars: readonly Bar[],
  rowCount: number,
  valueArea: number,
): VolumeProfile | undefined {
  const count = Math.max(1, Math.round(rowCount));
  let lo = Number.POSITIVE_INFINITY;
  let hi = Number.NEGATIVE_INFINITY;
  for (const bar of bars) {
    if (!Number.isFinite(bar.low) || !Number.isFinite(bar.high)) continue;
    lo = Math.min(lo, bar.low);
    hi = Math.max(hi, bar.high);
  }
  if (!(hi > lo)) return undefined;

  const step = (hi - lo) / count;
  const rows: ProfileRow[] = Array.from({ length: count }, (_, i) => ({
    low: lo + i * step,
    high: i === count - 1 ? hi : lo + (i + 1) * step,
    up: 0,
    down: 0,
  }));
  const rowOf = (price: number) =>
    Math.min(count - 1, Math.max(0, Math.floor((price - lo) / step)));
  let total = 0;
  for (const bar of bars) {
    const volume = bar.volume ?? 0;
    if (!(volume > 0) || !Number.isFinite(bar.low) || !Number.isFinite(bar.high)) continue;
    const side = bar.close >= bar.open ? "up" : "down";
    total += volume;
    const span = bar.high - bar.low;
    const first = rowOf(bar.low);
    const last = rowOf(bar.high);
    if (span <= 0 || first === last) {
      const row = rows[first];
      if (row) row[side] += volume;
      continue;
    }
    for (let i = first; i <= last; i++) {
      const row = rows[i];
      if (!row) continue;
      const overlap = Math.min(bar.high, row.high) - Math.max(bar.low, row.low);
      if (overlap > 0) row[side] += (volume * overlap) / span;
    }
  }
  if (total <= 0) return undefined;

  const size = (i: number) => {
    const row = rows[i];
    return row ? row.up + row.down : 0;
  };
  let poc = 0;
  for (let i = 1; i < count; i++) if (size(i) > size(poc)) poc = i;
  const target = total * Math.min(1, Math.max(0, valueArea));
  let held = size(poc);
  let valueLow = poc;
  let valueHigh = poc;
  while (held < target && (valueLow > 0 || valueHigh < count - 1)) {
    const below = valueLow > 0 ? size(valueLow - 1) : -1;
    const above = valueHigh < count - 1 ? size(valueHigh + 1) : -1;
    if (above >= below) held += size(++valueHigh);
    else held += size(--valueLow);
  }
  return { rows, poc, valueLow, valueHigh, max: size(poc) };
}
