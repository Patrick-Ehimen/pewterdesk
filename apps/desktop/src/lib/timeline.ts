import type { TraderMove, TraderSide, TraderSnapshot } from "../api/venueClient";

// The Following page's "Last 24 hours": what each followed trader held, and
// when, as bars on a day's timeline. Built from what the app saw - their
// moves (`pd.traders.activity`) and their positions now - so a position
// opened before the app was watching starts at the window's edge, marked so.

export const WINDOW_MS = 24 * 3_600_000;

export interface Segment {
  market: string;
  side: TraderSide;
  /** Ms since the epoch, inside the window. */
  start: number;
  end: number;
  /** Still held. */
  open: boolean;
  /** Whether the start is when it opened, or only the window's edge. */
  startKnown: boolean;
  /** What a position still held is worth now (USD); 0 for one closed. */
  value: number;
}

/**
 * Bars into at most `lanes` rows that don't overlap: what the app saw open
 * first, then the biggest held. The rest are counted, not drawn.
 */
export function lanes(
  bars: readonly Segment[],
  lanes: number,
): { rows: Segment[][]; hidden: number } {
  const ranked = [...bars].sort(
    (a, b) => Number(b.startKnown) - Number(a.startKnown) || b.value - a.value || a.start - b.start,
  );
  const rows: Segment[][] = [];
  let hidden = 0;
  for (const bar of ranked) {
    const row = rows.find((r) => r.every((x) => x.end <= bar.start || x.start >= bar.end));
    if (row) row.push(bar);
    else if (rows.length < lanes) rows.push([bar]);
    else hidden += 1;
  }
  return { rows, hidden };
}

/** One trader's positions over the window ending `now`, oldest first. */
export function segments(
  moves: readonly TraderMove[],
  snapshot: Pick<TraderSnapshot, "holdings"> | undefined,
  now: number,
): Segment[] {
  const from = now - WINDOW_MS;
  const out: Segment[] = [];
  // Per market and side: when the position the app saw opening began.
  const opened = new Map<string, number>();
  const key = (market: string, side: TraderSide) => `${market}|${side}`;
  const close = (market: string, side: TraderSide, at: number) => {
    const k = key(market, side);
    const start = opened.get(k);
    opened.delete(k);
    if (at < from) return;
    out.push({
      market,
      side,
      start: Math.max(start ?? from, from),
      end: Math.min(at, now),
      open: false,
      startKnown: start !== undefined && start >= from,
      value: 0,
    });
  };
  for (const m of [...moves].sort((a, b) => a.at - b.at)) {
    const { market, kind, side } = m.change;
    if (kind === "open") opened.set(key(market, side), m.at);
    else if (kind === "close") close(market, side, m.at);
    else if (kind === "flip") {
      close(market, side === "long" ? "short" : "long", m.at);
      opened.set(key(market, side), m.at);
    } else if (!opened.has(key(market, side))) {
      // An add or a cut to a position opened before the log: it was held then.
      opened.set(key(market, side), Number.NEGATIVE_INFINITY);
    }
  }
  // What's held now runs to now; its start is the open the app saw, or the
  // source's own (OKX), or else the window's edge.
  const held = new Map<string, number | undefined>();
  const worth = new Map<string, number>();
  for (const h of snapshot?.holdings ?? []) {
    const k = key(h.market, h.side);
    worth.set(k, (worth.get(k) ?? 0) + h.value);
    const known = opened.get(k);
    const start = known !== undefined && Number.isFinite(known) ? known : (h.openedAt ?? undefined);
    // OKX's sub-positions of one market: the earliest start that's known.
    const before = held.get(k);
    const earliest = [before, start].filter((t): t is number => t !== undefined);
    held.set(k, earliest.length > 0 ? Math.min(...earliest) : undefined);
  }
  for (const [k, start] of held) {
    const [market = "", side] = k.split("|") as [string, TraderSide];
    out.push({
      market,
      side,
      start: Math.max(start ?? from, from),
      end: now,
      open: true,
      startKnown: start !== undefined && start >= from,
      value: worth.get(k) ?? 0,
    });
  }
  return out.sort((a, b) => a.start - b.start);
}
