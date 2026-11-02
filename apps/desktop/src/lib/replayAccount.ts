import type { Market } from "@pewterdesk/core";
import { closeAll, type Fees, type PaperState, type Quotes, tick } from "./paper";

// The replay account's market: the same simulated account as paper trading,
// moved along by a replay's past candles instead of live prices. Plain logic:
// it imports no venue client, and nothing here can reach a venue.
//
// A candle gives its four prices, not their order, so each one is walked the
// way that's hardest on the position: against it first. A stop and a target
// in one candle therefore take the stop, and results lean cautious.

export interface ReplayBar {
  /** UTC seconds: the candle's open. */
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
}

/** A replay in progress on the chart: its candles, and the newest on screen. */
export interface ReplaySession {
  /** New for each start, so one ending and the next beginning can't be missed. */
  id: number;
  market: string;
  bars: readonly ReplayBar[];
  index: number;
  /** UTC seconds: the moment on screen, when the newest candle closed. */
  time: number;
}

/** Every price in this market where something would happen. */
function levels(state: PaperState, market: string): number[] {
  const out: (number | undefined)[] = [];
  for (const o of state.orders) {
    if (o.market !== market) continue;
    out.push(o.price, o.triggerPrice, o.takeProfit, o.stopLoss);
  }
  for (const p of state.positions) {
    if (p.market === market) out.push(p.takeProfit, p.stopLoss);
  }
  return out.filter((v): v is number => v !== undefined);
}

/** The prices strictly between `from` and `to`, in the order a move between them meets them. */
const between = (from: number, to: number, stops: readonly number[]) =>
  stops
    .filter((p) => p > Math.min(from, to) && p < Math.max(from, to))
    .sort((a, b) => (from < to ? a - b : b - a));

/**
 * A candle as a walk of prices: from the open to one extreme, the other, then
 * the close, stopping at each of `stops` on the way so an order there fills at
 * its own price, not the candle's extreme. `lowFirst` picks the first extreme.
 */
export function pricePath(bar: ReplayBar, stops: readonly number[], lowFirst: boolean): number[] {
  const [first, second] = lowFirst ? [bar.low, bar.high] : [bar.high, bar.low];
  const legs = [bar.open, first, second, bar.close];
  const path = [bar.open];
  for (let i = 1; i < legs.length; i++) {
    const from = legs[i - 1] as number;
    const to = legs[i] as number;
    path.push(...between(from, to, stops), to);
  }
  return path;
}

/** The account after one more candle of `market`. */
export function stepBar(state: PaperState, market: Market, bar: ReplayBar, fees: Fees): PaperState {
  const position = state.positions.find((p) => p.market === market.id);
  // Against a long is down, against a short is up; with neither, the same as a long.
  const path = pricePath(bar, levels(state, market.id), position?.side !== "short");
  const markets = new Map([[market.id, market]]);
  let next = state;
  for (const mark of path) {
    next = tick(next, { [market.id]: { mark } }, markets, fees, bar.time * 1000);
  }
  return next;
}

/** The session over: orders cancelled, anything open closed at the last candle's close. */
export function endSession(
  state: PaperState,
  market: Market,
  bar: ReplayBar,
  fees: Fees,
): PaperState {
  const quotes: Quotes = { [market.id]: { mark: bar.close } };
  return closeAll(state, quotes, new Map([[market.id, market]]), fees, bar.time * 1000);
}
