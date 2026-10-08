import type { ClosedTrade } from "@pewterdesk/core";
import { dateFormat, formatSigned, t, trendClass } from "@pewterdesk/ui";
import { useEffect, useRef, useState } from "react";
import { LuChevronLeft, LuChevronRight, LuX } from "react-icons/lu";
import { currentStreak, pnlCalendar } from "../../lib/performance";

const MONTH: Intl.DateTimeFormatOptions = { month: "short", year: "numeric" };
const WEEKDAY: Intl.DateTimeFormatOptions = { weekday: "narrow" };

/** Monday to Sunday, as the app's language writes them in one letter. */
function weekdays(): string[] {
  // 5 January 2026 is a Monday.
  return Array.from({ length: 7 }, (_, i) => dateFormat(WEEKDAY).format(new Date(2026, 0, 5 + i)));
}

interface PnlCalendarProps {
  open: boolean;
  onClose: () => void;
  trades: readonly ClosedTrade[];
  /** The asset the PnL is in, e.g. "USDT". */
  quote: string;
  /** How far back `trades` reaches: no month before this has anything to show. */
  since: number;
}

/**
 * The PnL calendar: a month of the account's days, each with what its
 * closed positions made, the month's total split into up and down days,
 * and the streaks.
 */
export function PnlCalendar({ open, onClose, trades, quote, since }: PnlCalendarProps) {
  const ref = useRef<HTMLDialogElement>(null);
  const [now, setNow] = useState(Date.now);
  const [shown, setShown] = useState(() => {
    const d = new Date();
    return { year: d.getFullYear(), month: d.getMonth() };
  });

  // Drive the native dialog from `open`; it opens on this month.
  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) {
      const d = new Date();
      setNow(d.getTime());
      setShown({ year: d.getFullYear(), month: d.getMonth() });
      dialog.showModal();
    } else if (!open && dialog.open) {
      dialog.close();
    }
  }, [open]);

  const cal = pnlCalendar(trades, shown.year, shown.month, now);
  const streak = currentStreak(trades, now);
  const step = (by: number) =>
    setShown((s) => {
      const d = new Date(s.year, s.month + by, 1);
      return { year: d.getFullYear(), month: d.getMonth() };
    });
  const today = new Date(now);
  const atThisMonth = shown.year === today.getFullYear() && shown.month === today.getMonth();
  // The month before this one ends before the history starts.
  const atFirstMonth = new Date(shown.year, shown.month, 1).getTime() <= since;
  const moved = cal.upTotal - cal.downTotal;
  const money = (v: number) => `${formatSigned(v)} ${quote}`;

  return (
    <dialog
      ref={ref}
      className="pf-cal"
      aria-labelledby="pf-cal-title"
      onClose={onClose}
      // A click on the backdrop lands on the dialog element itself.
      onClick={(e) => e.target === e.currentTarget && onClose()}
      onKeyDown={(e) => e.key === "Escape" && onClose()}
    >
      <header className="pf-cal-head">
        <h2 id="pf-cal-title">{t("portfolio.calendar")}</h2>
        <div className="pf-cal-nav">
          <button
            type="button"
            className="pd-icon-button"
            aria-label={t("portfolio.cal.prev")}
            disabled={atFirstMonth}
            onClick={() => step(-1)}
          >
            <LuChevronLeft size={16} aria-hidden />
          </button>
          <strong>{dateFormat(MONTH).format(new Date(shown.year, shown.month, 1))}</strong>
          <button
            type="button"
            className="pd-icon-button"
            aria-label={t("portfolio.cal.next")}
            disabled={atThisMonth}
            onClick={() => step(1)}
          >
            <LuChevronRight size={16} aria-hidden />
          </button>
        </div>
        <button
          type="button"
          className="pd-icon-button"
          aria-label={t("wallet.close")}
          onClick={onClose}
        >
          <LuX size={17} aria-hidden />
        </button>
      </header>

      <div className="pf-cal-total">
        <strong className={`pd-num pf-cal-sum ${trendClass(cal.total)}`}>{money(cal.total)}</strong>
        {/* Up days against down days, by what each side came to. */}
        <div className="pf-split" aria-hidden>
          <span
            className="pf-split-part"
            data-side="up"
            style={{ flexGrow: moved > 0 ? cal.upTotal / moved : 0 }}
          />
          <span
            className="pf-split-part"
            data-side="down"
            style={{ flexGrow: moved > 0 ? -cal.downTotal / moved : 0 }}
          />
        </div>
        <div className="pf-cal-sides">
          <span className="pd-up pd-num">
            {t("portfolio.cal.days", { count: cal.upDays })} / {money(cal.upTotal)}
          </span>
          <span className="pd-down pd-num">
            {t("portfolio.cal.days", { count: cal.downDays })} / {money(cal.downTotal)}
          </span>
        </div>
      </div>

      <div className="pf-cal-grid">
        {weekdays().map((day, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: seven fixed columns, two of them "T" and "S"
          <span key={i} className="pf-cal-weekday" aria-hidden>
            {day}
          </span>
        ))}
        {Array.from({ length: cal.lead }, (_, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: blank cells before the 1st
          <span key={`lead-${i}`} aria-hidden />
        ))}
        {cal.days.map((d) => (
          <div
            key={d.key}
            className="pf-cal-day"
            data-trend={d.pnl > 0 ? "up" : d.pnl < 0 ? "down" : undefined}
            data-future={d.future || undefined}
          >
            <span className="pf-cal-date">{d.day}</span>
            {!d.future && (
              <strong className="pd-num pf-cal-pnl">
                {d.trades > 0 ? formatSigned(d.pnl) : "-"}
              </strong>
            )}
            {d.trades > 0 && (
              <span className="pf-cal-count">{t("portfolio.cal.closes", { count: d.trades })}</span>
            )}
          </div>
        ))}
      </div>

      <footer className="pf-cal-foot">
        <span className="pf-chip">{t("portfolio.cal.streak", { count: streak })}</span>
        <span className="pf-chip">{t("portfolio.cal.bestStreak", { count: cal.bestStreak })}</span>
        <span className="pf-chip">{t("portfolio.cal.active", { count: cal.activeDays })}</span>
      </footer>
    </dialog>
  );
}
