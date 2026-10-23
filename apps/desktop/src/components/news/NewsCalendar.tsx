import type { Market, MarketSummary, Position } from "@pewterdesk/core";
import { dateFormat, formatSigned, type MessageKey, Switch, t } from "@pewterdesk/ui";
import { useMemo, useState } from "react";
import { LuChevronLeft, LuChevronRight } from "react-icons/lu";
import { useStoredChoice } from "../../hooks/useStoredChoice";
import type { NewsItem } from "../../lib/news";
import {
  addDays,
  CALENDAR_FILTERS,
  type CalendarEntry,
  type CalendarFilter,
  type CalendarKind,
  calendarEntries,
  dayChange,
  dayCounts,
  dayStart,
  entriesOn,
  filterEntries,
  weekAround,
} from "../../lib/newsCalendar";

const ON_OFF = ["on", "off"] as const;

const FILTER_KEYS = {
  all: "news.filter.all",
  news: "news.cal.news",
  listing: "news.filter.listing",
  delisting: "news.filter.delisting",
  maintenance: "news.filter.maintenance",
  campaign: "news.cal.campaigns",
  funding: "news.cal.funding",
  unlock: "news.cal.unlocks",
} as const satisfies Record<CalendarFilter, MessageKey>;

const KIND_KEYS = {
  news: "news.kind.news",
  listing: "news.kind.listing",
  delisting: "news.kind.delisting",
  maintenance: "news.kind.maintenance",
  campaign: "news.kind.campaign",
  funding: "news.cal.funding",
} as const satisfies Record<CalendarKind, MessageKey>;

interface NewsCalendarProps {
  /** The News page's items: headlines and announcements, with their markets. */
  items: readonly NewsItem[];
  positions: readonly Position[];
  summaries: readonly MarketSummary[];
  markets: readonly Market[];
  /** The starred markets: with the held ones, what "My markets" keeps. */
  starred: ReadonlySet<string>;
  /** The venue whose announcements these are, by name. */
  announcer: string;
  now: number;
  /** Opens a headline in the feed. */
  onOpen: (item: NewsItem) => void;
  /** Opens a market on the Trade page. */
  onTrade: (marketId: string) => void;
}

/**
 * The News page's Calendar view, after Bybit's Market Calendar: a week
 * strip (dots for headlines and for what's scheduled), filters, "My
 * markets", and the day's timeline - what happened before now, what's
 * coming after, with a line at now on today.
 */
export function NewsCalendar({
  items,
  positions,
  summaries,
  markets,
  starred,
  announcer,
  now,
  onOpen,
  onTrade,
}: NewsCalendarProps) {
  const today = dayStart(now);
  const [day, setDay] = useState(today);
  const [filter, setFilter] = useStoredChoice<CalendarFilter>(
    "pd.news.calendar.filter",
    CALENDAR_FILTERS,
    "all",
  );
  const [mine, setMine] = useStoredChoice("pd.news.calendar.mine", ON_OFF, "off");

  const all = useMemo(
    () => calendarEntries(items, positions, summaries, now),
    [items, positions, summaries, now],
  );
  const yours = useMemo(
    () => new Set([...starred, ...positions.map((p) => p.market)]),
    [starred, positions],
  );
  const shown = useMemo(
    () => filterEntries(all, filter, mine === "on", yours),
    [all, filter, mine, yours],
  );
  const week = weekAround(day);
  const onDay = entriesOn(shown, day);
  const summaryOf = useMemo(() => new Map(summaries.map((s) => [s.market, s])), [summaries]);
  const symbolOf = (id: string) => markets.find((m) => m.id === id)?.base ?? id;

  const month = dateFormat({ month: "long", year: "numeric" }).format(new Date(day));
  const weekday = dateFormat({ weekday: "short" });
  const fullDay = dateFormat({ weekday: "long", day: "numeric", month: "long" });
  const clock = dateFormat({ hour: "2-digit", minute: "2-digit" });

  // Today: a line at now, between what happened and what's coming.
  const nowAt = day === today ? onDay.findIndex((e) => e.time > now) : -1;

  return (
    <div className="ncal">
      <div className="ncal-head">
        <strong className="ncal-month">{month}</strong>
        <div className="ncal-nav">
          <button
            type="button"
            className="pd-icon-button"
            aria-label={t("news.cal.prevWeek")}
            title={t("news.cal.prevWeek")}
            onClick={() => setDay(addDays(day, -7))}
          >
            <LuChevronLeft size={16} aria-hidden />
          </button>
          <button
            type="button"
            className="settings-button ncal-today"
            disabled={day === today}
            onClick={() => setDay(today)}
          >
            {t("news.cal.today")}
          </button>
          <button
            type="button"
            className="pd-icon-button"
            aria-label={t("news.cal.nextWeek")}
            title={t("news.cal.nextWeek")}
            onClick={() => setDay(addDays(day, 7))}
          >
            <LuChevronRight size={16} aria-hidden />
          </button>
        </div>
      </div>

      <div className="ncal-week" role="tablist" aria-label={month}>
        {week.map((d) => {
          const counts = dayCounts(shown, d);
          return (
            <button
              type="button"
              role="tab"
              key={d}
              className="ncal-day"
              aria-selected={d === day}
              data-today={d === today || undefined}
              aria-label={`${fullDay.format(new Date(d))} · ${t("news.cal.counts", counts)}`}
              onClick={() => setDay(d)}
            >
              <span className="ncal-weekday">{weekday.format(new Date(d))}</span>
              <span className="ncal-date">{new Date(d).getDate()}</span>
              <span className="ncal-dots" aria-hidden>
                {counts.news > 0 && <span className="ncal-dot" data-kind="news" />}
                {counts.scheduled > 0 && <span className="ncal-dot" data-kind="scheduled" />}
              </span>
            </button>
          );
        })}
      </div>

      <div className="ncal-filters">
        <div className="pd-chips" role="radiogroup" aria-label={t("news.filters")}>
          {CALENDAR_FILTERS.map((f) => (
            // biome-ignore lint/a11y/useSemanticElements: chip-style radio, like the other filters
            <button
              type="button"
              role="radio"
              key={f}
              className="pd-chip"
              aria-checked={f === filter}
              disabled={f === "unlock"}
              title={f === "unlock" ? t("news.cal.unlocksSoon") : undefined}
              onClick={() => setFilter(f)}
            >
              {t(FILTER_KEYS[f])}
            </button>
          ))}
        </div>
        <span className="ncal-mine" title={t("news.cal.mineHelp")}>
          <span>{t("news.cal.mine")}</span>
          <Switch
            label={t("news.cal.mine")}
            checked={mine === "on"}
            onChange={(on) => setMine(on ? "on" : "off")}
          />
        </span>
      </div>

      <h2 className="ncal-day-title">{fullDay.format(new Date(day))}</h2>
      <div className="ncal-timeline">
        {onDay.length === 0 ? (
          <p className="ncal-empty">
            {filter === "unlock"
              ? t("news.cal.unlocksSoon")
              : day >= today
                ? t("news.cal.emptyAhead")
                : t("news.cal.empty")}
          </p>
        ) : (
          onDay.map((e, i) => (
            <div key={e.id} className="ncal-row-group">
              {i === nowAt && (
                <NowLine label={t("news.cal.now")} time={clock.format(new Date(now))} />
              )}
              <div className="ncal-row" data-past={e.time <= now || undefined}>
                <time className="ncal-time" dateTime={new Date(e.time).toISOString()}>
                  {clock.format(new Date(e.time))}
                </time>
                <EntryCard
                  entry={e}
                  announcer={announcer}
                  symbolOf={symbolOf}
                  changeOf={(id) => dayChange(summaryOf.get(id))}
                  onOpen={onOpen}
                  onTrade={onTrade}
                />
              </div>
            </div>
          ))
        )}
        {nowAt === -1 && day === today && onDay.length > 0 && (
          <NowLine label={t("news.cal.now")} time={clock.format(new Date(now))} />
        )}
      </div>
    </div>
  );
}

function NowLine({ label, time }: { label: string; time: string }) {
  return (
    <div className="ncal-now">
      <span>
        {label} · {time}
      </span>
    </div>
  );
}

function EntryCard({
  entry,
  announcer,
  symbolOf,
  changeOf,
  onOpen,
  onTrade,
}: {
  entry: CalendarEntry;
  announcer: string;
  symbolOf: (id: string) => string;
  changeOf: (id: string) => number | undefined;
  onOpen: (item: NewsItem) => void;
  onTrade: (marketId: string) => void;
}) {
  const { item, position } = entry;
  const title = item
    ? item.title
    : position
      ? t("news.funding", { symbol: symbolOf(position.market) })
      : "";
  const source = item?.publisher?.name ?? (item?.venue ? announcer : undefined);
  return (
    <article
      className="ncal-card"
      data-kind={entry.kind}
      data-scheduled={entry.scheduled || undefined}
    >
      <div className="ncal-card-head">
        <span className="ncal-kind">{t(KIND_KEYS[entry.kind])}</span>
        {entry.scheduled && entry.kind !== "funding" && (
          <span className="ncal-starts">{t("news.cal.starts")}</span>
        )}
        {source && <span className="ncal-source">{source}</span>}
      </div>
      {item ? (
        <button type="button" className="ncal-title" onClick={() => onOpen(item)}>
          {title}
        </button>
      ) : (
        <strong className="ncal-title">{title}</strong>
      )}
      {item?.description && <p className="ncal-desc">{item.description}</p>}
      {entry.rate !== undefined && (
        <p className="ncal-desc">
          {t("news.fundingRate", { rate: formatSigned(entry.rate * 100, 4) })}
        </p>
      )}
      {entry.markets.length > 0 && (
        <div className="ncal-coins">
          {entry.markets.map((id) => {
            const change = changeOf(id);
            return (
              <button type="button" key={id} className="ncal-coin" onClick={() => onTrade(id)}>
                {symbolOf(id)}
                {change !== undefined && (
                  <span className="ncal-coin-change" data-tone={change >= 0 ? "up" : "down"}>
                    {formatSigned(change, 2)}%
                  </span>
                )}
              </button>
            );
          })}
        </div>
      )}
    </article>
  );
}
