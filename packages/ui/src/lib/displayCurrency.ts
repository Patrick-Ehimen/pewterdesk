import { useSyncExternalStore } from "react";
import { formatNumber } from "./format";

// The currency the app's money is shown in: balances, P&L and values, turned
// from the venues' dollar stablecoins at a day-old rate, and marked "≈" so
// they don't read as exact. Display only: prices, sizes and anything an order
// is made of stay in the venue's own currency, and never come through here.

export interface DisplayCurrency {
  code: string;
  /** Units of it to a dollar. */
  rate: number;
}

let current: DisplayCurrency | undefined;
const listeners = new Set<() => void>();

export function setDisplayCurrency(next: DisplayCurrency | undefined) {
  if (next?.code === current?.code && next?.rate === current?.rate) return;
  current = next;
  for (const l of listeners) l();
}

/** The currency on show, re-rendering when it changes; none for the venue's own. */
export function useDisplayCurrency() {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => current,
  );
}

const symbolOf = (code: string) =>
  new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: code,
    currencyDisplay: "narrowSymbol",
  })
    .formatToParts(0)
    .find((part) => part.type === "currency")?.value ?? code;

const converted = (value: number, sign: string, shown: DisplayCurrency, decimals: number) =>
  `≈ ${sign}${symbolOf(shown.code)}${formatNumber(Math.abs(value * shown.rate), decimals)}`;

const signOf = (value: number, plus: boolean) => (value < 0 ? "-" : value > 0 && plus ? "+" : "");

/** An amount: as the venue has it, with `suffix` (" USDT"), or in the app's currency. */
export function formatMoney(value: number, suffix = "", decimals = 2): string {
  if (!Number.isFinite(value)) return "-";
  if (!current) return `${formatNumber(value, decimals)}${suffix}`;
  return converted(value, signOf(value, false), current, decimals);
}

/** The same, with "+" on a gain. */
export function formatSignedMoney(value: number, suffix = "", decimals = 2): string {
  if (!Number.isFinite(value)) return "-";
  if (!current)
    return `${signOf(value, true) === "+" ? "+" : ""}${formatNumber(value, decimals)}${suffix}`;
  return converted(value, signOf(value, true), current, decimals);
}

/** An amount the app writes as dollars ("$1,234.56"), or in the app's currency. */
export function formatDollars(value: number, plus = false): string {
  if (!Number.isFinite(value)) return "-";
  const sign = signOf(value, plus);
  if (!current) return `${sign}$${formatNumber(Math.abs(value), 2)}`;
  return converted(value, sign, current, 2);
}
