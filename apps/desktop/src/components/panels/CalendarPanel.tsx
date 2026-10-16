import { dateFormat, EmptyState, type MessageKey, Switch, t } from "@pewterdesk/ui";
import { useEffect, useState } from "react";
import type { CalendarEvent, CalendarImpact } from "../../api/venueClient";
import { useEconomicCalendar } from "../../hooks/useVenueFeeds";
import {
  byDay,
  type CalendarView,
  countdown,
  daysFrom,
  type ImpactFloor,
  isPast,
  loadView,
  nextMajor,
  saveView,
  visibleEvents,
} from "../../lib/calendar";

// The week's economic calendar (rate decisions, inflation, jobs...) as a
// workspace panel. Rust reads it (`econ_calendar.rs`); it reaches the page
// as text only, with no links.

const CLOCK: Intl.DateTimeFormatOptions = { hour: "2-digit", minute: "2-digit", hour12: false };
const DAY: Intl.DateTimeFormatOptions = { weekday: "long", day: "numeric", month: "short" };
/** How often the countdowns and what counts as past move on. */
const TICK_MS = 30_000;
/** An event this close is marked as coming up. */
const SOON_MS = 60 * 60_000;

const FLOORS: readonly ImpactFloor[] = ["high", "medium", "all"];

function dayLabel(start: number, now: number) {
  const from = daysFrom(start, now);
  const date = dateFormat(DAY).format(start);
  if (from === 0) return `${t("calendar.today")} · ${date}`;
  if (from === 1) return `${t("calendar.tomorrow")} · ${date}`;
  return date;
}

const IMPACTS: readonly CalendarImpact[] = ["high", "medium", "low", "holiday"];
/** Bars lit in an impact's mark: three for high, none for a holiday. */
const BARS: Record<CalendarImpact, number> = { high: 3, medium: 2, low: 1, holiday: 0 };

/**
 * An impact's mark: its colour, and as many of three bars lit as it rates,
 * so high and medium read apart in every theme, colour or not.
 */
function ImpactMark({ impact, withLabel }: { impact: CalendarImpact; withLabel?: boolean }) {
  const name = t(`calendar.impact.${impact}` as MessageKey);
  return (
    <span className="calendar-impact" data-impact={impact} title={name}>
      <span className="calendar-bars" aria-hidden>
        {[1, 2, 3].map((n) => (
          <span key={n} data-on={n <= BARS[impact] || undefined} />
        ))}
      </span>
      <span className={withLabel ? "calendar-impact-label" : "pd-visually-hidden"}>
        {t(`calendar.level.${impact}` as MessageKey)}
      </span>
    </span>
  );
}

function Row({ event, now }: { event: CalendarEvent; now: number }) {
  const past = isPast(event, now);
  const live = !past && event.time <= now;
  const soon = !past && !live && event.time - now <= SOON_MS;
  return (
    <li
      className="calendar-row"
      data-past={past || undefined}
      data-soon={soon || live || undefined}
      data-impact={event.impact}
    >
      <span className="calendar-time pd-num">{dateFormat(CLOCK).format(event.time)}</span>
      <ImpactMark impact={event.impact} withLabel />
      <span className="calendar-currency">{event.currency}</span>
      <span className="calendar-title">{event.title}</span>
      <span className="calendar-figures pd-num">
        {live ? (
          <span className="calendar-when">{t("calendar.now")}</span>
        ) : soon ? (
          <span className="calendar-when">
            {t("calendar.in", { time: countdown(event.time, now) })}
          </span>
        ) : (
          <>
            {event.forecast && (
              <span title={t("calendar.forecast")}>
                {t("calendar.forecastShort")} {event.forecast}
              </span>
            )}
            {event.previous && (
              <span title={t("calendar.previous")}>
                {t("calendar.previousShort")} {event.previous}
              </span>
            )}
          </>
        )}
      </span>
    </li>
  );
}

/** The Calendar panel: this week's economic events, soonest first. */
export function CalendarPanel() {
  const feed = useEconomicCalendar();
  const [view, setView] = useState<CalendarView>(loadView);
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), TICK_MS);
    return () => clearInterval(id);
  }, []);
  const change = (next: CalendarView) => {
    setView(next);
    saveView(next);
  };

  if (feed.status === "loading" || feed.status === "idle") {
    return <EmptyState>{t("feed.loading")}</EmptyState>;
  }
  // Not the venue's connection: the panel says so itself, and is retried.
  if (feed.status === "error") return <EmptyState>{t("calendar.unavailable")}</EmptyState>;

  const events = feed.data;
  const shown = visibleEvents(events, view, now);
  const next = nextMajor(events, now);
  return (
    <div className="calendar-panel">
      <div className="calendar-bar">
        <div className="pd-segmented" role="radiogroup" aria-label={t("calendar.impact")}>
          {FLOORS.map((floor) => (
            <label key={floor} data-checked={view.floor === floor || undefined}>
              <input
                type="radio"
                name="calendar-floor"
                checked={view.floor === floor}
                onChange={() => change({ ...view, floor })}
              />
              {t(`calendar.floor.${floor}` as MessageKey)}
            </label>
          ))}
        </div>
        <span className="calendar-past">
          <Switch
            checked={view.showPast}
            onChange={(showPast) => change({ ...view, showPast })}
            label={t("calendar.showPast")}
          />
          {t("calendar.showPast")}
        </span>
      </div>
      <ul className="calendar-key" aria-label={t("calendar.impact")}>
        {IMPACTS.map((impact) => (
          <li key={impact}>
            <ImpactMark impact={impact} />
            {t(`calendar.level.${impact}` as MessageKey)}
          </li>
        ))}
      </ul>
      {next && (
        <p className="calendar-next" role="status">
          <span className="pd-muted">{t("calendar.next")}</span>{" "}
          <strong>
            {next.currency} {next.title}
          </strong>{" "}
          <span className="pd-num">{t("calendar.in", { time: countdown(next.time, now) })}</span>
        </p>
      )}
      <div className="calendar-list app-scroll">
        {shown.length === 0 ? (
          <EmptyState>{t("calendar.empty")}</EmptyState>
        ) : (
          byDay(shown).map((day) => (
            <section key={day.start} className="calendar-day">
              <h3 className="calendar-day-title">{dayLabel(day.start, now)}</h3>
              <ul>
                {day.events.map((event) => (
                  <Row
                    key={`${event.time}:${event.currency}:${event.title}`}
                    event={event}
                    now={now}
                  />
                ))}
              </ul>
            </section>
          ))
        )}
      </div>
      <p className="calendar-source pd-muted">{t("calendar.source")}</p>
    </div>
  );
}
