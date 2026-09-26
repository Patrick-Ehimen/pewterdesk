import type { Decimal } from "@pewterdesk/core";

// Display-only. These go through a JS number, which is fine for rendering and
// never fine for anything sent back to a venue — order inputs keep the
// original Decimal strings.

const formatters = new Map<string, Intl.NumberFormat>();

function formatter(min: number, max: number): Intl.NumberFormat {
  const key = `${min}:${max}`;
  let f = formatters.get(key);
  if (!f) {
    f = new Intl.NumberFormat("en-US", { minimumFractionDigits: min, maximumFractionDigits: max });
    formatters.set(key, f);
  }
  return f;
}

/** Decimal places in a venue-supplied value, e.g. "38.391" → 3. */
export function decimalsOf(value: Decimal): number {
  const dot = value.indexOf(".");
  return dot === -1 ? 0 : value.length - dot - 1;
}

/** Groups thousands and pads to `decimals` places (default: as the venue sent it). */
export function formatNumber(value: Decimal | number, decimals?: number): string {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) return "—";
  const dp = decimals ?? (typeof value === "string" ? decimalsOf(value) : 2);
  return formatter(dp, dp).format(n);
}

/** Prefixes positive values with "+"; negatives keep their "-". */
export function formatSigned(value: Decimal | number, decimals = 2): string {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) return "—";
  const text = formatNumber(n, decimals);
  return n > 0 ? `+${text}` : text;
}

export function formatPercent(ratio: number, decimals = 2): string {
  if (!Number.isFinite(ratio)) return "—";
  return `${formatNumber(ratio * 100, decimals)}%`;
}

/** "0x7a3f…c91e" */
export function shortAddress(address: string): string {
  return address.length > 12 ? `${address.slice(0, 6)}…${address.slice(-4)}` : address;
}

/** CSS class for a market-colored number: green up, red down, plain at zero. */
export function trendClass(value: Decimal | number): string {
  const n = typeof value === "number" ? value : Number(value);
  if (n > 0) return "pd-up";
  if (n < 0) return "pd-down";
  return "";
}
