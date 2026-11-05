import { useCallback, useRef, useState } from "react";
import { useAutosave } from "../../hooks/useJournal";
import { type JournalDay, newDay, type TradeNote } from "../../lib/journal";
import type { JournalTrade } from "../../lib/journalTrades";
import type { PlanContext } from "./PlanPage";

/**
 * A day's entry as it's being written: edits show at once and are saved once
 * typing pauses (and when the view closes).
 */
export function useDayDraft(ctx: PlanContext, day: string) {
  const stored = ctx.journal.data.days.get(day)?.data;
  const [entry, setEntry] = useState<JournalDay>(() => stored ?? newDay());
  const current = useRef(entry);
  current.current = entry;
  const [dirty, setDirty] = useState(false);
  const { saveDay } = ctx.journal;
  const save = useCallback(
    (value: JournalDay) => {
      setDirty(false);
      saveDay(day, value).catch(() => {});
    },
    [day, saveDay],
  );
  useAutosave(entry, save, 1200, dirty);
  const update = useCallback((change: (entry: JournalDay) => JournalDay) => {
    setEntry((e) => change(e));
    setDirty(true);
  }, []);
  /** Saves now, as a button's click does. */
  const commit = useCallback(
    (change: (entry: JournalDay) => JournalDay) => {
      const next = change(current.current);
      current.current = next;
      setEntry(next);
      setDirty(false);
      saveDay(day, next).catch(() => {});
    },
    [day, saveDay],
  );
  return { entry, update, commit, locked: entry.finalizedAt !== undefined };
}

/** A trade's note as it's being written, saved as typing pauses. */
export function useNoteDraft(ctx: PlanContext, trade: JournalTrade) {
  const [note, setNote] = useState<TradeNote>(trade.note);
  const [dirty, setDirty] = useState(false);
  const { saveNote } = ctx.journal;
  const save = useCallback(
    (value: TradeNote) => {
      setDirty(false);
      saveNote(trade.key, value).catch(() => {});
    },
    [trade.key, saveNote],
  );
  useAutosave(note, save, 1200, dirty);
  const update = useCallback((change: (note: TradeNote) => TradeNote) => {
    setNote((n) => change(n));
    setDirty(true);
  }, []);
  return { note, update };
}
