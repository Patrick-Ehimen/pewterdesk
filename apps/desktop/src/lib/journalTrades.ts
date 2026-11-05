import type { ClosedTrade, Fill, Position } from "@pewterdesk/core";
import {
  detectedBreaks,
  figuresOf,
  newNote,
  type Plan,
  type TradeFigures,
  type TradeNote,
  tradeKey,
  utcDay,
} from "./journal";

/**
 * One trade in the journal: the venue's closed trade where its history still
 * has it, the trader's note where one was written, and the note to show either
 * way (an unwritten one is a fresh note on the venue's figures, with the
 * breaks the app can see by itself).
 */
export interface JournalTrade {
  key: string;
  closed?: ClosedTrade;
  /** The venue's position, while the trade is still open (its key is `openKey`). */
  open?: Position;
  note: TradeNote;
  /** A note for it is stored. */
  written: boolean;
  /**
   * The open trade's note this closed one took over (`openKey`), until it's
   * saved under the closed trade's own key and that one removed.
   */
  adoptedFrom?: string;
}

/**
 * An open trade's key: its market and side, the one position a one-way
 * account holds there. Its note moves to the closed trade's key once it closes.
 */
export const openKey = (market: string, side: "long" | "short") => `open:${market}:${side}`;
export const isOpenKey = (key: string) => key.startsWith("open:");

/** A position's figures as a trade note keeps them: the mark as its exit, open P&L as its P&L. */
export function positionFigures(p: Position, openedAt?: number): TradeFigures {
  const size = Number(p.size);
  const entry = Number(p.entryPrice);
  return {
    venue: p.venue,
    market: p.market,
    side: p.side,
    size,
    entryPrice: entry,
    exitPrice: Number(p.markPrice),
    pnl: Number(p.unrealizedPnl),
    entryValue: size * entry,
    leverage: p.leverage === undefined ? undefined : Number(p.leverage),
    openedAt,
    closedAt: Date.now(),
  };
}

/**
 * When the position opened, from the account's fills: back from the newest
 * fill on its market until the fills add up to its size. Undefined where the
 * fills don't reach that far.
 */
export function openedAtOf(p: Position, fills: readonly Fill[]): number | undefined {
  const size = Number(p.size);
  const dir = p.side === "long" ? 1 : -1;
  let held = 0;
  for (const f of [...fills].filter((x) => x.market === p.market).sort((a, b) => b.time - a.time)) {
    held += (f.side === "buy" ? 1 : -1) * dir * Number(f.size);
    if (held >= size * 0.999) return f.time;
  }
  return undefined;
}

/** The account's open positions as trades, each with its note (written while open, or fresh). */
export function openTrades(
  positions: readonly Position[],
  notes: ReadonlyMap<string, { data: TradeNote }>,
  /** When a position opened, where the account knows (a paper account does). */
  openedAt: (p: Position) => number | undefined = () => undefined,
): JournalTrade[] {
  return positions.map((p) => {
    const key = openKey(p.market, p.side);
    const stored = notes.get(key);
    const live = positionFigures(p, stored?.data.trade.openedAt ?? openedAt(p));
    return {
      key,
      open: p,
      note: stored ? { ...stored.data, trade: { ...stored.data.trade, ...live } } : newNote(live),
      written: stored !== undefined,
    };
  });
}

/**
 * The venue's closed trades and the stored notes, as one list, newest first.
 * A note whose trade the venue no longer lists still shows, from its own copy.
 */
export function journalTrades(
  closed: readonly ClosedTrade[],
  notes: ReadonlyMap<string, { data: TradeNote }>,
  plan: Plan | undefined,
  positions: readonly Position[] = [],
): JournalTrade[] {
  const out = new Map<string, JournalTrade>();
  // An open trade's note goes to the newest closed trade on its market and
  // side that closed after it was written, once no position is open there.
  const adopt = new Map<string, string>();
  for (const [key, stored] of notes) {
    if (!isOpenKey(key)) continue;
    const { market, side } = stored.data.trade;
    if (positions.some((p) => p.market === market && p.side === side)) continue;
    const since = (stored.data.trade.openedAt ?? 0) - 60_000;
    const into = closed
      .filter((c) => c.market === market && c.side === side && c.time >= since)
      .sort((a, b) => b.time - a.time)[0];
    if (into && !notes.has(tradeKey(into))) adopt.set(tradeKey(into), key);
  }
  for (const c of closed) {
    const key = tradeKey(c);
    const stored = notes.get(key);
    const from = adopt.get(key);
    const taken = from ? notes.get(from)?.data : undefined;
    out.set(key, {
      key,
      closed: c,
      note:
        stored?.data ??
        (taken
          ? { ...taken, trade: { ...figuresOf(c), openedAt: c.openedAt ?? taken.trade.openedAt } }
          : newNote(figuresOf(c))),
      written: stored !== undefined || taken !== undefined,
      ...(taken && from ? { adoptedFrom: from } : {}),
    });
  }
  for (const [key, stored] of notes) {
    if (!out.has(key) && !isOpenKey(key)) out.set(key, { key, note: stored.data, written: true });
  }
  const list = [...out.values()];
  // Which trade of its day each one was, by when it opened, for the plan's daily count.
  const byDay = new Map<string, JournalTrade[]>();
  for (const trade of list) {
    const opened = trade.note.trade.openedAt ?? trade.note.trade.closedAt;
    const day = utcDay(opened);
    byDay.set(day, [...(byDay.get(day) ?? []), trade]);
  }
  for (const trades of byDay.values()) {
    trades.sort(
      (a, b) =>
        (a.note.trade.openedAt ?? a.note.trade.closedAt) -
        (b.note.trade.openedAt ?? b.note.trade.closedAt),
    );
    trades.forEach((trade, i) => {
      if (!trade.written)
        trade.note = { ...trade.note, breaks: detectedBreaks(trade.note, plan, i + 1) };
    });
  }
  return list.sort((a, b) => b.note.trade.closedAt - a.note.trade.closedAt);
}

/** The trade's place in its UTC day (1 for the first opened). */
export function nthOfDay(trades: readonly JournalTrade[], key: string): number {
  const self = trades.find((t) => t.key === key);
  if (!self) return 1;
  const opened = (t: JournalTrade) => t.note.trade.openedAt ?? t.note.trade.closedAt;
  const day = utcDay(opened(self));
  return trades.filter((t) => utcDay(opened(t)) === day && opened(t) <= opened(self)).length;
}

/**
 * The trades taken on a day: what's open now, and what closed, each closed
 * position once (one closed in parts is one trade), by the day it opened. An
 * open position whose opening isn't known counts on today's page.
 */
export function tradesTaken(
  closed: readonly JournalTrade[],
  open: readonly JournalTrade[],
  day: string,
  today: string,
): { total: number; open: number; closed: number } {
  const opened = (x: JournalTrade) => x.note.trade.openedAt ?? x.note.trade.closedAt;
  const stillOpen = open.filter((x) =>
    x.note.trade.openedAt === undefined ? day === today : utcDay(x.note.trade.openedAt) === day,
  ).length;
  const done = new Set(
    closed
      .filter((x) => utcDay(opened(x)) === day)
      .map((x) => `${x.note.trade.market}:${x.note.trade.side}:${opened(x)}`),
  ).size;
  return { total: done + stillOpen, open: stillOpen, closed: done };
}
