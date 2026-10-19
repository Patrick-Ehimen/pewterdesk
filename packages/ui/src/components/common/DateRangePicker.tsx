import { type KeyboardEvent, useEffect, useRef, useState } from "react";
import { LuCalendarDays, LuChevronLeft, LuChevronRight } from "react-icons/lu";
import { dateFormat, t } from "../../i18n";

/** A local calendar day as `YYYY-MM-DD`; "" for none. */
export type Day = string;

const pad = (n: number) => String(n).padStart(2, "0");

/** `date`'s local calendar day. */
export function toDay(date: Date): Day {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** The local midnight a day starts at; undefined if `day` isn't one. */
export function fromDay(day: Day): Date | undefined {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day);
  return m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : undefined;
}

/**
 * The days a month's grid shows, Monday first: whole weeks, so the first
 * and last rows run into the months either side (`null` there).
 */
export function monthGrid(year: number, month: number): (Day | null)[] {
  const first = new Date(year, month, 1);
  const lead = (first.getDay() + 6) % 7;
  const days = new Date(year, month + 1, 0).getDate();
  const cells: (Day | null)[] = Array.from({ length: lead }, () => null);
  for (let d = 1; d <= days; d++) cells.push(toDay(new Date(year, month, d)));
  while (cells.length % 7 !== 0) cells.push(null);
  return cells;
}

/**
 * The range after a click on `day`: the first click (or one after a whole
 * range) starts a new one, the next ends it, either way round.
 */
export function pickDay(from: Day, to: Day, day: Day): { from: Day; to: Day } {
  if (!from || to) return { from: day, to: "" };
  return day < from ? { from: day, to: from } : { from, to: day };
}

interface DateRangePickerProps {
  from: Day;
  to: Day;
  onChange: (from: Day, to: Day) => void;
  /** The earliest and latest days that can be picked. */
  min?: Day;
  max?: Day;
  /** Accessible name of the trigger. */
  label: string;
  className?: string;
}

/**
 * A from-to range of whole days in the app's own style, in place of the
 * native date inputs: one field, and under it a month's calendar. A first
 * click picks the start, a second the end; the list opens inline, like
 * `Select`'s. Escape or a click outside closes it.
 */
export function DateRangePicker({
  from,
  to,
  onChange,
  min,
  max,
  label,
  className,
}: DateRangePickerProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  // The month on screen: the range's start, else the latest pickable day's.
  const [view, setView] = useState(() => fromDay(from) ?? fromDay(max ?? "") ?? new Date());
  const [hover, setHover] = useState<Day>();

  const show = () => {
    setView(fromDay(from) ?? fromDay(max ?? "") ?? new Date());
    setOpen(true);
  };
  const close = (refocus = true) => {
    setOpen(false);
    setHover(undefined);
    if (refocus) buttonRef.current?.focus();
  };

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: PointerEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [open]);

  const year = view.getFullYear();
  const month = view.getMonth();
  const step = (by: number) => setView(new Date(year, month + by, 1));
  const firstOf = toDay(new Date(year, month, 1));
  const lastOf = toDay(new Date(year, month + 1, 0));
  const canBack = !min || min < firstOf;
  const canOn = !max || max > lastOf;
  // Monday to Sunday, in the interface language (2024-01-01 was a Monday).
  const weekdays = Array.from({ length: 7 }, (_, i) =>
    dateFormat({ weekday: "narrow" }).format(new Date(2024, 0, 1 + i)),
  );
  // While only the start is picked, the range runs to the day under the pointer.
  const end = to || (from && hover && hover > from ? hover : "");

  const pick = (day: Day) => {
    const next = pickDay(from, to, day);
    onChange(next.from, next.to);
    if (next.to) close();
  };

  const onEscape = (e: KeyboardEvent) => {
    if (open && e.key === "Escape") {
      // Closes the calendar only, not a popover it sits in.
      e.preventDefault();
      e.stopPropagation();
      close();
    }
  };

  return (
    <div ref={rootRef} className={`pd-select pd-dates ${className ?? ""}`}>
      <button
        ref={buttonRef}
        type="button"
        className="pd-select-trigger pd-dates-trigger"
        aria-label={label}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => (open ? close() : show())}
        onKeyDown={onEscape}
      >
        <span className="pd-num" data-empty={!from || undefined}>
          {from || t("dates.start")}
        </span>
        <span className="pd-dates-arrow" aria-hidden>
          →
        </span>
        <span className="pd-num" data-empty={!to || undefined}>
          {to || t("dates.end")}
        </span>
        <LuCalendarDays size={14} className="pd-select-chevron" aria-hidden />
      </button>
      {open && (
        <div
          className="pd-select-list pd-dates-pop"
          role="dialog"
          aria-label={label}
          onKeyDown={onEscape}
        >
          <div className="pd-dates-head">
            <button
              type="button"
              className="pd-dates-step"
              aria-label={t("dates.prevMonth")}
              disabled={!canBack}
              onClick={() => step(-1)}
            >
              <LuChevronLeft size={15} aria-hidden />
            </button>
            <strong aria-live="polite">
              {dateFormat({ month: "long", year: "numeric" }).format(view)}
            </strong>
            <button
              type="button"
              className="pd-dates-step"
              aria-label={t("dates.nextMonth")}
              disabled={!canOn}
              onClick={() => step(1)}
            >
              <LuChevronRight size={15} aria-hidden />
            </button>
          </div>
          <div className="pd-dates-grid" onPointerLeave={() => setHover(undefined)}>
            {weekdays.map((w, i) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: narrow names repeat (S, T)
              <span key={i} className="pd-dates-weekday" aria-hidden>
                {w}
              </span>
            ))}
            {monthGrid(year, month).map((day, i) =>
              day === null ? (
                // biome-ignore lint/suspicious/noArrayIndexKey: blank cells have nothing else
                <span key={`blank-${i}`} />
              ) : (
                <button
                  key={day}
                  type="button"
                  className="pd-dates-day pd-num"
                  disabled={(!!min && day < min) || (!!max && day > max)}
                  aria-pressed={day === from || day === to}
                  aria-label={dateFormat({ dateStyle: "long" }).format(fromDay(day))}
                  data-edge={day === from || day === end || undefined}
                  data-within={(from && end && day > from && day < end) || undefined}
                  data-today={day === toDay(new Date()) || undefined}
                  onPointerEnter={() => setHover(day)}
                  onFocus={() => setHover(day)}
                  onClick={() => pick(day)}
                >
                  {Number(day.slice(8))}
                </button>
              ),
            )}
          </div>
          <div className="pd-dates-foot">
            <span className="pd-muted">{from && !to ? t("dates.pickEnd") : ""}</span>
            <button
              type="button"
              className="pd-dates-clear"
              disabled={!from && !to}
              onClick={() => {
                onChange("", "");
                close();
              }}
            >
              {t("dates.clear")}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
