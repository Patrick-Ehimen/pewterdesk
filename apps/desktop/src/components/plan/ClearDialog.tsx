import { dateFormat, t } from "@pewterdesk/ui";
import { useEffect, useMemo, useRef, useState } from "react";
import { LuRotateCcw, LuTrash2, LuX } from "react-icons/lu";
import type { JournalDay } from "../../lib/journal";
import type { DaySummary } from "../../lib/journalStats";
import type { PlanContext } from "./PlanPage";
import { Money, Segment } from "./parts";

type Mode = "days" | "all";
const DAY: Intl.DateTimeFormatOptions = {
  weekday: "short",
  month: "short",
  day: "numeric",
  year: "numeric",
  timeZone: "UTC",
};

/**
 * Clearing the journal, in the app only: picked days or all of them. What was
 * written for them is deleted from PewterDesk Cloud and their trades are hidden
 * here; the venue's own history doesn't change. Cleared days can be shown again.
 */
export function ClearDialog({
  ctx,
  open,
  summaries,
  days,
  onClose,
}: {
  ctx: PlanContext;
  open: boolean;
  /** The days the journal lists now. */
  summaries: readonly DaySummary[];
  days: ReadonlyMap<string, JournalDay>;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const [mode, setMode] = useState<Mode>("days");
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [armed, setArmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) {
      setMode("days");
      setPicked(new Set());
      setFrom("");
      setTo("");
      setArmed(false);
      setError(undefined);
      dialog.showModal();
    } else if (!open && dialog.open) dialog.close();
  }, [open]);

  // Any change of what's picked asks for the confirmation again.
  // biome-ignore lint/correctness/useExhaustiveDependencies: the choices are the trigger
  useEffect(() => setArmed(false), [mode, picked]);

  const cleared = useMemo(
    () =>
      [...days]
        .filter(([, d]) => d.clearedAt !== undefined)
        .map(([day, d]) => ({ day, at: d.clearedAt as number }))
        .sort((a, b) => b.day.localeCompare(a.day)),
    [days],
  );
  const chosen = mode === "all" ? summaries : summaries.filter((s) => picked.has(s.day));
  const trades = chosen.reduce((n, s) => n + s.group.trades, 0);
  const written = chosen.filter((s) => {
    const d = days.get(s.day);
    return (
      s.notes.some((n) => n.reflection.savedAt || n.notes || n.playbookId) ||
      d?.review.savedAt !== undefined ||
      d?.startedAt !== undefined
    );
  }).length;
  const format = dateFormat(DAY);

  const toggle = (day: string) =>
    setPicked((p) => {
      const next = new Set(p);
      if (next.has(day)) next.delete(day);
      else next.add(day);
      return next;
    });
  const pickRange = () => {
    const lo = from && to && from > to ? to : from;
    const hi = from && to && from > to ? from : to;
    setPicked(
      new Set(
        summaries.filter((s) => (!lo || s.day >= lo) && (!hi || s.day <= hi)).map((s) => s.day),
      ),
    );
  };
  const run = async (job: () => Promise<void>) => {
    setBusy(true);
    setError(undefined);
    try {
      await job();
      return true;
    } catch (e) {
      setError((e as Error).message);
      return false;
    } finally {
      setBusy(false);
    }
  };
  const clear = async () => {
    if (!armed) {
      setArmed(true);
      return;
    }
    const list = chosen.map((s) => s.day);
    if (await run(() => ctx.journal.clearDays(list))) onClose();
  };

  return (
    <dialog
      ref={ref}
      className="jr-dialog"
      aria-labelledby="jr-clear-title"
      onClose={onClose}
      onClick={(e) => e.target === e.currentTarget && !busy && onClose()}
      onKeyDown={(e) => {
        // Not while a clear is half done.
        if (e.key === "Escape" && busy) e.preventDefault();
      }}
      onCancel={(e) => busy && e.preventDefault()}
    >
      <header className="jr-dialog-head">
        <span className="jr-dialog-icon">
          <LuTrash2 size={16} aria-hidden />
        </span>
        <div>
          <h2 id="jr-clear-title">{t("plan.clear.title")}</h2>
          <p>{t("plan.clear.lead", { venue: ctx.venueLabel })}</p>
        </div>
        <button
          type="button"
          className="jr-icon"
          aria-label={t("plan.clear.close")}
          disabled={busy}
          onClick={onClose}
        >
          <LuX size={15} aria-hidden />
        </button>
      </header>

      <div className="jr-dialog-body">
        <Segment
          label={t("plan.clear.what")}
          value={mode}
          options={[
            { value: "days", label: t("plan.clear.pick") },
            { value: "all", label: t("plan.clear.everything") },
          ]}
          onChange={setMode}
        />

        {mode === "days" ? (
          <>
            <div className="jr-clear-range">
              <label>
                <span>{t("plan.plan.from")}</span>
                <input
                  className="pd-input"
                  type="date"
                  value={from}
                  onChange={(e) => setFrom(e.target.value)}
                />
              </label>
              <label>
                <span>{t("plan.plan.to")}</span>
                <input
                  className="pd-input"
                  type="date"
                  value={to}
                  onChange={(e) => setTo(e.target.value)}
                />
              </label>
              <button
                type="button"
                className="jr-button"
                disabled={!from && !to}
                onClick={pickRange}
              >
                {t("plan.clear.selectRange")}
              </button>
              <span className="jr-grow" />
              <button
                type="button"
                className="jr-link"
                onClick={() =>
                  setPicked(
                    picked.size === summaries.length
                      ? new Set()
                      : new Set(summaries.map((s) => s.day)),
                  )
                }
              >
                {picked.size === summaries.length && summaries.length > 0
                  ? t("plan.clear.none")
                  : t("plan.clear.all")}
              </button>
            </div>
            {summaries.length === 0 ? (
              <p className="jr-quiet-note">{t("plan.clear.nothing")}</p>
            ) : (
              <ul className="jr-clear-list">
                {summaries.map((s) => (
                  <li key={s.day}>
                    <label data-on={picked.has(s.day) || undefined}>
                      <input
                        type="checkbox"
                        checked={picked.has(s.day)}
                        onChange={() => toggle(s.day)}
                      />
                      <span className="jr-clear-day">{format.format(Date.parse(s.day))}</span>
                      <span className="jr-muted">{t("plan.tradesN", { n: s.group.trades })}</span>
                      <Money value={s.group.pnl} />
                    </label>
                  </li>
                ))}
              </ul>
            )}
          </>
        ) : (
          <p className="jr-clear-all">{t("plan.clear.allBody", { venue: ctx.venueLabel })}</p>
        )}

        {chosen.length > 0 && (
          <p className="jr-clear-sum" data-armed={armed || undefined}>
            {t("plan.clear.summary", { days: chosen.length, trades, written })}
          </p>
        )}
        {error && <p className="jr-error">{error}</p>}

        {cleared.length > 0 && (
          <details className="jr-cleared">
            <summary>{t("plan.clear.clearedN", { n: cleared.length })}</summary>
            <p className="jr-hint">{t("plan.clear.restoreHint")}</p>
            <ul className="jr-clear-list">
              {cleared.map((c) => (
                <li key={c.day}>
                  <span className="jr-cleared-row">
                    <span className="jr-clear-day">{format.format(Date.parse(c.day))}</span>
                    <button
                      type="button"
                      className="jr-button jr-quiet"
                      disabled={busy}
                      onClick={() => void run(() => ctx.journal.restoreDays([c.day]))}
                    >
                      <LuRotateCcw size={12} aria-hidden /> {t("plan.clear.restore")}
                    </button>
                  </span>
                </li>
              ))}
            </ul>
            {cleared.length > 1 && (
              <button
                type="button"
                className="jr-link"
                disabled={busy}
                onClick={() => void run(() => ctx.journal.restoreDays(cleared.map((c) => c.day)))}
              >
                {t("plan.clear.restoreAll")}
              </button>
            )}
          </details>
        )}
      </div>

      <footer className="jr-dialog-foot">
        <button type="button" className="jr-button" disabled={busy} onClick={onClose}>
          {t("plan.clear.cancel")}
        </button>
        <button
          type="button"
          className="jr-button jr-danger"
          data-armed={armed || undefined}
          disabled={busy || chosen.length === 0}
          onClick={() => void clear()}
        >
          <LuTrash2 size={13} aria-hidden />
          {busy
            ? t("plan.saving")
            : armed
              ? t("plan.clear.confirm")
              : mode === "all"
                ? t("plan.clear.doAll")
                : chosen.length === 0
                  ? t("plan.clear.pickFirst")
                  : t("plan.clear.doDays", { n: chosen.length })}
        </button>
      </footer>
    </dialog>
  );
}
