import type { TraderHolding, TraderSide, TraderSwept } from "../api/venueClient";
import { type Agreement, agreement, traderKey } from "./traders";

// The leaderboard's insight cards (after design/screens/93): how the top
// traders sit on BTC, what they hold most, and the biggest position one of
// them opened in the last hour. Arithmetic over their public positions.

const HOUR = 3_600_000;

/** The biggest position a top trader opened lately. */
export interface NewPosition {
  key: string;
  market: string;
  side: TraderSide;
  /** USD notional of the whole position now. */
  value: number;
  size: number;
  /** Its mark, or entry. */
  price: number;
  /** When it opened (OKX) or was first seen (Hyperliquid). */
  at: number;
}

export interface TopInsights {
  /** Traders read so far. */
  read: number;
  /** BTC among them, if anyone holds it. */
  btc?: Agreement;
  /** The three markets most of them hold. */
  mostHeld: Agreement[];
  biggestNew?: NewPosition;
}

/** A trader's net position on one market and side, OKX sub-positions added up. */
function netOf(holdings: readonly TraderHolding[], market: string, side: TraderSide) {
  let size = 0;
  let value = 0;
  let opened = 0;
  for (const h of holdings) {
    if (h.market !== market || h.side !== side) continue;
    size += h.size;
    value += h.value;
    opened = Math.max(opened, h.openedAt ?? 0);
  }
  return { size, value, opened, price: size > 0 ? value / size : 0 };
}

export function topInsights(swept: readonly TraderSwept[], now = Date.now()): TopInsights {
  const keys = swept.map((s) => traderKey(s.source, s.id));
  const all = agreement(swept, keys);
  let biggestNew: NewPosition | undefined;
  const consider = (s: TraderSwept, market: string, side: TraderSide, at: number) => {
    if (now - at > HOUR || at > now + 60_000) return;
    const net = netOf(s.holdings, market, side);
    if (net.value <= 0 || (biggestNew && biggestNew.value >= net.value)) return;
    biggestNew = { key: traderKey(s.source, s.id), market, side, at, ...net };
  };
  for (const s of swept) {
    // OKX says when each position opened; Hyperliquid's are first sightings.
    for (const h of s.holdings) if (h.openedAt) consider(s, h.market, h.side, h.openedAt);
    for (const [market, side, at] of s.newSince) consider(s, market, side, at);
  }
  return {
    read: swept.length,
    btc: all.find((a) => a.market === "BTC"),
    mostHeld: all.slice(0, 3),
    biggestNew,
  };
}

/** The share of an agreement's value that's short (0 to 1). */
export const shortShare = (a: Agreement) =>
  a.longValue + a.shortValue > 0 ? a.shortValue / (a.longValue + a.shortValue) : 0;
