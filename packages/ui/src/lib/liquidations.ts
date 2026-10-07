// The liquidation feed, kept and summed for the Maps page: totals over a
// window, each market's share, and the newest first for the live list.

import type { Liquidation } from "@pewterdesk/core";

/** Where a liquidation was reported. */
export type LiqSource = "bybit" | "okx";
export const LIQ_SOURCES: readonly LiqSource[] = ["bybit", "okx"];

/** A liquidation with its value in the quote asset (price × size) and its exchange. */
export interface LiqEvent extends Liquidation {
  value: number;
  /** Unset on events kept from before sources were recorded: Bybit's. */
  source?: LiqSource;
}

/** The exchange an event came from. */
export const sourceOf = (e: LiqEvent): LiqSource => e.source ?? "bybit";

export const HOUR_MS = 3_600_000;
/** How far back the feed is kept, and how many events at most. */
export const KEEP_MS = 24 * HOUR_MS;
export const KEEP_MAX = 20_000;

export function toEvent(l: Liquidation, source: LiqSource = "bybit"): LiqEvent {
  return { ...l, value: Number(l.price) * Number(l.size), source };
}

/** `kept` with `batch` added (newest first), past `KEEP_MS` or `KEEP_MAX` dropped. */
export function mergeLiquidations(
  kept: readonly LiqEvent[],
  batch: readonly Liquidation[],
  now: number,
): LiqEvent[] {
  const fresh = batch.map((l) => toEvent(l)).sort((a, b) => b.time - a.time);
  const cutoff = now - KEEP_MS;
  return [...fresh, ...kept].filter((e) => e.time >= cutoff).slice(0, KEEP_MAX);
}

export interface LiqTotals {
  total: number;
  long: number;
  short: number;
  count: number;
}

/** What was liquidated in the last `windowMs`: all, longs and shorts. */
export function liqTotals(events: readonly LiqEvent[], now: number, windowMs: number): LiqTotals {
  const out = { total: 0, long: 0, short: 0, count: 0 };
  for (const e of events) {
    if (e.time < now - windowMs) continue;
    out.total += e.value;
    out.count += 1;
    if (e.side === "long") out.long += e.value;
    else out.short += e.value;
  }
  return out;
}

export interface MarketLiq {
  market: string;
  long: number;
  short: number;
  total: number;
}

/** Each market's liquidations in the last `windowMs`, largest first. */
export function liqByMarket(
  events: readonly LiqEvent[],
  now: number,
  windowMs: number,
): MarketLiq[] {
  const by = new Map<string, MarketLiq>();
  for (const e of events) {
    if (e.time < now - windowMs) continue;
    const m = by.get(e.market) ?? { market: e.market, long: 0, short: 0, total: 0 };
    if (e.side === "long") m.long += e.value;
    else m.short += e.value;
    m.total += e.value;
    by.set(e.market, m);
  }
  return [...by.values()].sort((a, b) => b.total - a.total);
}
