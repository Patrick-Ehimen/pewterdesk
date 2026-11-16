import { t } from "@pewterdesk/ui";
import { useEffect, useRef, useState } from "react";
import {
  LuCalendar,
  LuChevronLeft,
  LuChevronRight,
  LuChevronsLeft,
  LuChevronsRight,
} from "react-icons/lu";

const DAY = 86_400_000;
const utcDay = (ms: number) => ms - (((ms % DAY) + DAY) % DAY);
const label = (ms: number) =>
  new Date(ms).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  });

/** Days shown for a month: whole weeks from Monday, the neighbours' days to fill them. */
function monthGrid(year: number, month: number): number[] {
  const first = Date.UTC(year, month, 1);
  const lead = (new Date(first).getUTCDay() + 6) % 7;
  const start = first - lead * DAY;
  const days = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  const weeks = Math.ceil((lead + days) / 7);
  return Array.from({ length: weeks * 7 }, (_, i) => start + i * DAY);
}

/**
 * A day, picked from a month calendar: UTC midnight in, UTC midnight out.
 * The other end of the range is shaded, so the period reads at a glance.
 */
export function DatePicker({
  label: fieldLabel,
  value,
  onChange,
  min,
  max,
  rangeFrom,
  rangeTo,
}: {
  label: string;
  /** UTC midnight, ms. */
  value: number;
  onChange: (day: number) => void;
  min?: number;
  max?: number;
  /** The whole period, shaded. */
  rangeFrom?: number;
  rangeTo?: number;
}) {
  const [open, setOpen] = useState(false);
  const [shown, setShown] = useState(() => {
    const d = new Date(value);
    return { year: d.getUTCFullYear(), month: d.getUTCMonth() };
  });
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const d = new Date(value);
    setShown({ year: d.getUTCFullYear(), month: d.getUTCMonth() });
    const close = (e: PointerEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const key = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("pointerdown", close);
    document.addEventListener("keydown", key);
    return () => {
      document.removeEventListener("pointerdown", close);
      document.removeEventListener("keydown", key);
    };
  }, [open, value]);

  const move = (months: number) =>
    setShown(({ year, month }) => {
      const n = year * 12 + month + months;
      return { year: Math.floor(n / 12), month: ((n % 12) + 12) % 12 };
    });
  const today = utcDay(Date.now());
  const lo = rangeFrom === undefined ? undefined : utcDay(rangeFrom);
  const hi = rangeTo === undefined ? undefined : utcDay(rangeTo);
  const heads = Array.from({ length: 7 }, (_, i) =>
    new Date(Date.UTC(2024, 0, 1 + i))
      .toLocaleDateString("en-US", { weekday: "short", timeZone: "UTC" })
      .slice(0, 2),
  );
  const monthName = new Date(Date.UTC(shown.year, shown.month, 1)).toLocaleDateString("en-US", {
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  });

  return (
    <div className="lab-date" ref={rootRef}>
      <span className="lab-date-label">{fieldLabel}</span>
      <button
        type="button"
        className={`lab-date-field${open ? " on" : ""}`}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        <LuCalendar size={14} aria-hidden />
        <span className="lab-num">{label(value)}</span>
        <span className="lab-dim">00:00 UTC</span>
      </button>
      {open && (
        <div className="lab-cal" role="dialog" aria-label={fieldLabel}>
          <div className="lab-cal-head">
            <button type="button" aria-label={t("bt.cal.prevYear")} onClick={() => move(-12)}>
              <LuChevronsLeft size={14} aria-hidden />
            </button>
            <button type="button" aria-label={t("bt.cal.prevMonth")} onClick={() => move(-1)}>
              <LuChevronLeft size={14} aria-hidden />
            </button>
            <b>{monthName}</b>
            <button type="button" aria-label={t("bt.cal.nextMonth")} onClick={() => move(1)}>
              <LuChevronRight size={14} aria-hidden />
            </button>
            <button type="button" aria-label={t("bt.cal.nextYear")} onClick={() => move(12)}>
              <LuChevronsRight size={14} aria-hidden />
            </button>
          </div>
          <div className="lab-cal-grid">
            {heads.map((h) => (
              <i key={h}>{h}</i>
            ))}
            {monthGrid(shown.year, shown.month).map((d) => {
              const off = new Date(d).getUTCMonth() !== shown.month;
              const blocked =
                (min !== undefined && d < utcDay(min)) || (max !== undefined && d > utcDay(max));
              const picked = d === utcDay(value);
              const inRange = lo !== undefined && hi !== undefined && d > lo && d < hi;
              const cls = [
                picked ? "sel" : "",
                inRange ? "rng" : "",
                off ? "out" : "",
                d === today ? "today" : "",
              ]
                .filter(Boolean)
                .join(" ");
              return (
                <button
                  key={d}
                  type="button"
                  className={cls || undefined}
                  disabled={blocked}
                  aria-pressed={picked}
                  onClick={() => {
                    onChange(d);
                    setOpen(false);
                  }}
                >
                  {new Date(d).getUTCDate()}
                </button>
              );
            })}
          </div>
          <div className="lab-cal-foot">
            <span className="lab-dim">{t("bt.cal.utc")}</span>
            {max !== undefined && (
              <button
                type="button"
                className="lab-btn ghost small"
                onClick={() => {
                  onChange(utcDay(max));
                  setOpen(false);
                }}
              >
                {t("bt.cal.latest")}
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
