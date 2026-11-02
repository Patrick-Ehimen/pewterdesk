import type { FxSource } from "@pewterdesk/ui";
import { fxClient } from "../api/venueClient";

// Exchange rates for showing charts and money in other currencies: what
// Rust reads (`fx_rates.rs`), a day old at best. Display only: nothing here
// reaches an order, a trading rule or a limit. USDT and USDC count as dollars.

/** Rust's list, less the dollar. */
export const FX_CURRENCIES = [
  "AED",
  "AUD",
  "BRL",
  "CAD",
  "CHF",
  "CNY",
  "DKK",
  "EGP",
  "EUR",
  "GBP",
  "GHS",
  "HKD",
  "IDR",
  "INR",
  "JPY",
  "KES",
  "KRW",
  "MXN",
  "NGN",
  "NOK",
  "NZD",
  "PHP",
  "PLN",
  "SAR",
  "SEK",
  "SGD",
  "THB",
  "TRY",
  "VND",
  "ZAR",
] as const;

/** The exports' first month. */
const FIRST = Date.UTC(2024, 3, 1) / 1000;
/** A chart's history is read a month at a time: at most this many, spread evenly. */
const MAX_SAMPLES = 60;
const LATEST_FOR_MS = 60 * 60 * 1000;

/** The first of each month from `from` to `to` (UTC seconds), as the feed names dates. */
export function monthDates(from: number, to: number): string[] {
  const start = new Date(Math.max(from, FIRST) * 1000);
  const dates: string[] = [];
  let year = start.getUTCFullYear();
  let month = start.getUTCMonth();
  for (;;) {
    const at = Date.UTC(year, month, 1);
    if (at / 1000 > to) break;
    if (at / 1000 >= FIRST) dates.push(new Date(at).toISOString().slice(0, 10));
    month += 1;
    if (month === 12) {
      month = 0;
      year += 1;
    }
  }
  if (dates.length <= MAX_SAMPLES) return dates;
  const step = dates.length / MAX_SAMPLES;
  return Array.from({ length: MAX_SAMPLES }, (_, i) => dates[Math.floor(i * step)] as string);
}

export interface RatePoint {
  /** UTC seconds. */
  time: number;
  rate: number;
}

/** A rate at any time: a straight line between `points`, level beyond them. */
export function rateLine(points: readonly RatePoint[]): (time: number) => number {
  const line = [...points].sort((a, b) => a.time - b.time);
  return (time) => {
    const first = line[0];
    const last = line.at(-1);
    if (!first || !last) return Number.NaN;
    if (time <= first.time) return first.rate;
    if (time >= last.time) return last.rate;
    const after = line.findIndex((p) => p.time >= time);
    const a = line[after - 1] ?? first;
    const b = line[after] ?? last;
    return a.rate + ((b.rate - a.rate) * (time - a.time)) / (b.time - a.time);
  };
}

let latest: { at: number; read: Promise<Record<string, number>> } | undefined;

/** Today's rates: kept an hour, and a failed read isn't. */
export function latestRates(): Promise<Record<string, number>> {
  if (latest && Date.now() - latest.at < LATEST_FOR_MS) return latest.read;
  const read = fxClient.latest().then((day) => day.rates);
  latest = { at: Date.now(), read };
  read.catch(() => {
    latest = undefined;
  });
  return read;
}

export const chartFx: FxSource = {
  currencies: FX_CURRENCIES,
  async rates(currency, from, to) {
    const today = (await latestRates())[currency];
    if (today === undefined) throw new Error(`No rate for ${currency}`);
    const days = await fxClient.history(monthDates(from, to)).catch(() => []);
    const points = days.flatMap((day) => {
      const rate = day.rates[currency];
      return rate === undefined ? [] : [{ time: Date.parse(`${day.date}T00:00:00Z`) / 1000, rate }];
    });
    return rateLine([...points, { time: Math.floor(Date.now() / 1000), rate: today }]);
  },
};
