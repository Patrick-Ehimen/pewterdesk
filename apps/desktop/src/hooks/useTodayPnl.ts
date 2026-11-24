import type { ClosedTrade, Position, VenueId } from "@pewterdesk/core";
import { useClosedHistory } from "./useVenueFeeds";

// Today's PnL, as the menu bar, the status bar, the tray panel and the
// floating window all show it: what closed today plus what's open now, so a
// closed trade still counts until the day turns. A day is UTC, as the journal
// and the trading rules count it.

export const DAY_MS = 86_400_000;

/** What today's closed trades came to (after fees); undefined until they're read. */
export function realizedToday(
  closed: readonly ClosedTrade[] | undefined,
  now = Date.now(),
): number | undefined {
  if (!closed) return undefined;
  const start = Math.floor(now / DAY_MS) * DAY_MS;
  return closed.filter((c) => c.time >= start).reduce((sum, c) => sum + Number(c.closedPnl), 0);
}

/** The open positions' unrealized PnL. */
export const unrealizedOf = (positions: readonly Position[]) =>
  positions.reduce((sum, p) => sum + Number(p.unrealizedPnl), 0);

/** The positions as a line: when one closes or shrinks, today's trades are read again at once. */
export const positionsKeyOf = (positions: readonly Position[] | undefined) =>
  positions?.map((p) => `${p.market}:${p.side}:${p.size}`).join("|");

/**
 * What a venue account's trades closed today came to, read while `address`
 * is set (one day's span, a light read every few minutes). Undefined until
 * the first read.
 */
export function useRealizedToday(
  venue: VenueId,
  address: string | undefined,
  positions: readonly Position[] | undefined,
): number | undefined {
  const feed = useClosedHistory(venue, address, DAY_MS, true, positionsKeyOf(positions));
  return realizedToday(feed.status === "live" || feed.status === "closed" ? feed.data : undefined);
}

/** Open positions' PnL plus today's closed trades', where those have been read. */
export const todayPnl = (positions: readonly Position[], realized: number | undefined) =>
  unrealizedOf(positions) + (realized ?? 0);
