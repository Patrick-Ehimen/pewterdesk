import type {
  Announcement,
  Candle,
  Market,
  MarketSummary,
  Position,
  VenueId,
} from "@pewterdesk/core";
import {
  currentLocale,
  dateFormat,
  EmptyState,
  formatNumber,
  formatSigned,
  INTERVAL_MS,
  intervalFor,
  type MessageKey,
  Switch,
  TableSkeleton,
  t,
  trendClass,
} from "@pewterdesk/ui";
import { useEffect, useMemo, useState } from "react";
import { LuSearch } from "react-icons/lu";
import { type Article, newsClient, venueClient } from "../../api/venueClient";
import { useStoredChoice } from "../../hooks/useStoredChoice";
import type { Feed } from "../../hooks/useVenueFeeds";
import {
  buildNews,
  filterNews,
  fundingDue,
  loadMutedPublishers,
  moreNews,
  movers,
  NEWS_FILTERS,
  type NewsFilter,
  type NewsItem,
  PUBLISHERS,
  priceChart,
  saveMutedPublishers,
  upcoming,
} from "../../lib/news";

const CHART_W = 600;
const CHART_H = 180;
/** Candles fetched for a headline's chart, at most. */
const MAX_CANDLES = 500;
/** The chart starts at least this long before the headline. */
const LEAD_MS = 2 * 3_600_000;
const ON_OFF = ["on", "off"] as const;

const CLOCK: Intl.DateTimeFormatOptions = { hour: "2-digit", minute: "2-digit", hour12: false };
const DAY: Intl.DateTimeFormatOptions = { month: "short", day: "numeric" };
const FULL: Intl.DateTimeFormatOptions = { ...DAY, ...CLOCK };

const KIND_LABEL: Record<Announcement["kind"], MessageKey> = {
  listing: "news.kind.listing",
  delisting: "news.kind.delisting",
  maintenance: "news.kind.maintenance",
  campaign: "news.kind.campaign",
  news: "news.kind.news",
};
const FILTER_LABEL: Record<Exclude<NewsFilter, "mine">, MessageKey> = {
  all: "news.filter.all",
  news: "news.kind.news",
  listing: "news.filter.listing",
  delisting: "news.filter.delisting",
  maintenance: "news.filter.maintenance",
};

/** "12 min ago", "in 3 hr": the distance from now, in the app's language. */
function relative(time: number, now: number): string {
  const format = new Intl.RelativeTimeFormat(currentLocale(), {
    style: "short",
    numeric: "always",
  });
  const minutes = Math.round((time - now) / 60_000);
  if (Math.abs(minutes) < 60) return format.format(minutes, "minute");
  const hours = Math.round(minutes / 60);
  if (Math.abs(hours) < 48) return format.format(hours, "hour");
  return format.format(Math.round(hours / 24), "day");
}

/** A headline's time in the list: the clock today, the date before that. */
const listTime = (time: number, now: number) =>
  dateFormat(now - time < 20 * 3_600_000 ? CLOCK : DAY).format(time);

function Badges({ item }: { item: NewsItem }) {
  return (
    <>
      <span className="news-kind" data-kind={item.kind}>
        {t(KIND_LABEL[item.kind])}
      </span>
      {item.highImpact && <span className="news-high">{t("news.high")}</span>}
      {item.held && <span className="news-held">· {t("news.held")}</span>}
    </>
  );
}

interface NewsPageProps {
  venue: VenueId;
  /** The venue's display name, e.g. "Bybit". */
  venueLabel: string;
  /** The venue whose announcements `news` holds, by name. */
  announcer: string;
  news: Feed<Announcement[]>;
  /** The news sites' headlines. */
  wire: Feed<Article[]>;
  markets: Market[];
  /** Every market's price and funding; unset until they arrive. */
  summaries?: MarketSummary[];
  positions: Position[];
  /** Opens a market on the Trade page. */
  onTrade: (marketId: string) => void;
}

/**
 * News: a venue's own announcements and news sites' headlines, read by the
 * app from the venue's public API and the sites' RSS feeds (no Pewterdesk
 * server, no made-up headlines). The feed on the left, the chosen headline with its market since then in the middle, and
 * what's scheduled plus the sources on the right.
 */
export function NewsPage({
  venue,
  venueLabel,
  announcer,
  news,
  wire,
  markets,
  summaries,
  positions,
  onTrade,
}: NewsPageProps) {
  const [filter, setFilter] = useState<NewsFilter>("all");
  const [query, setQuery] = useState("");
  const [highOnly, setHighOnly] = useState(false);
  const [announcementsOn, setAnnouncementsOn] = useStoredChoice("pd.news.venue", ON_OFF, "on");
  const [campaignsOn, setCampaignsOn] = useStoredChoice("pd.news.campaigns", ON_OFF, "off");
  const [muted, setMuted] = useState(loadMutedPublishers);
  const [selectedId, setSelectedId] = useState<string>();
  // The article that wouldn't open, so the message goes when another is picked.
  const [openFailed, setOpenFailed] = useState<string>();
  // Relative times ("12 min ago") move on once a minute.
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(id);
  }, []);

  const announced = news.status === "live" || news.status === "closed" ? news.data : undefined;
  const articles = wire.status === "live" || wire.status === "closed" ? wire.data : undefined;
  const loaded = announced !== undefined || articles !== undefined;
  const waiting = news.status === "loading" || wire.status === "loading";
  const items = useMemo(
    () =>
      buildNews(
        announcementsOn === "on" ? (announced ?? []) : [],
        markets,
        positions,
        (articles ?? []).filter((a) => !muted.includes(a.source)),
      ),
    [announced, articles, announcementsOn, muted, markets, positions],
  );
  const allOff = announcementsOn === "off" && muted.length === PUBLISHERS.length;
  const sourceOf = (item: NewsItem) =>
    item.publisher?.name ?? t("news.source", { venue: announcer });
  const shown = useMemo(
    () => filterNews(items, { filter, query, highOnly, campaigns: campaignsOn === "on" }),
    [items, filter, query, highOnly, campaignsOn],
  );
  const mine = items.filter(
    (i) => i.held && (campaignsOn === "on" || i.kind !== "campaign"),
  ).length;
  const selected = shown.find((i) => i.id === selectedId) ?? shown[0];
  const coming = upcoming(items, positions, summaries ?? [], now);

  const more = useMemo(() => (selected ? moreNews(selected, shown) : []), [selected, shown]);
  const moving = useMemo(() => movers(summaries ?? []), [summaries]);

  const marketOf = (id: string) => markets.find((m) => m.id === id);
  const summaryOf = (id: string) => summaries?.find((s) => s.market === id);
  const symbolOf = (id: string) => marketOf(id)?.symbol ?? id;

  // The first market in the headline, charted from a little before it to now.
  const chartMarket = selected?.markets[0];
  const headline = selected?.time;
  const [candles, setCandles] = useState<{ key: string; data: Candle[] }>();
  const chartKey = chartMarket && headline ? `${venue}:${chartMarket}:${headline}` : undefined;
  useEffect(() => {
    if (!chartKey || !chartMarket || !headline) return;
    let live = true;
    const end = Date.now();
    const start = headline - Math.max(LEAD_MS, (end - headline) * 0.4);
    const interval = intervalFor(end - start);
    const step = INTERVAL_MS[interval];
    const count = Math.min(MAX_CANDLES, Math.ceil((end - start) / step) + 2);
    venueClient.candles(venue, chartMarket, interval, end + step, count).then(
      (data) => live && setCandles({ key: chartKey, data }),
      () => live && setCandles({ key: chartKey, data: [] }),
    );
    return () => {
      live = false;
    };
  }, [chartKey, venue, chartMarket, headline]);
  const chart =
    candles && candles.key === chartKey && headline
      ? priceChart(candles.data, headline, CHART_W, CHART_H)
      : undefined;
  const chartPlaces = (price: string) => (price.includes(".") ? price.split(".")[1]?.length : 0);

  const move = (by: number) => {
    const i = shown.findIndex((x) => x.id === selected?.id);
    const next = shown[Math.min(shown.length - 1, Math.max(0, i + by))];
    if (next) setSelectedId(next.id);
  };

  const list =
    !loaded && waiting ? (
      <TableSkeleton columns={2} />
    ) : !loaded ? (
      <EmptyState>{t("news.noSource")}</EmptyState>
    ) : shown.length === 0 ? (
      <EmptyState>{t(allOff ? "news.sourcesOff" : "news.empty")}</EmptyState>
    ) : (
      <ul
        className="news-list"
        // biome-ignore lint/a11y/noNoninteractiveTabindex: the list takes the arrow keys
        tabIndex={0}
        aria-label={t("nav.news")}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown" || e.key === "j") move(1);
          else if (e.key === "ArrowUp" || e.key === "k") move(-1);
          else return;
          e.preventDefault();
        }}
      >
        {shown.map((item) => (
          <li key={item.id}>
            <button
              type="button"
              className="news-row"
              aria-current={item.id === selected?.id || undefined}
              onClick={() => setSelectedId(item.id)}
            >
              <time className="news-row-time">{listTime(item.time, now)}</time>
              <span className="news-row-main">
                <span className="news-row-badges">
                  <Badges item={item} />
                  {item.publisher && <span className="news-row-source">{item.publisher.name}</span>}
                </span>
                <span className="news-row-title">{item.title}</span>
                {item.markets.length > 0 && (
                  <span className="news-row-chips">
                    {item.markets.map((id) => {
                      const s = summaryOf(id);
                      const change =
                        s && Number(s.prevDayPrice) > 0
                          ? (Number(s.markPrice) / Number(s.prevDayPrice) - 1) * 100
                          : undefined;
                      return (
                        <span key={id} className="news-chip">
                          {marketOf(id)?.base ?? id}
                          {change !== undefined && (
                            <span className={trendClass(change)}>{formatSigned(change)}%</span>
                          )}
                        </span>
                      );
                    })}
                  </span>
                )}
              </span>
            </button>
          </li>
        ))}
      </ul>
    );

  return (
    <div className="page news">
      <div className="news-main">
        <section className="news-panel news-feed">
          <header className="news-feed-head">
            <h1>{t("nav.news")}</h1>
            {loaded && (
              <span className="news-live">
                <span className="news-live-dot" aria-hidden />
                {t("news.live")}
              </span>
            )}
          </header>
          <label className="news-search">
            <LuSearch size={15} aria-hidden />
            <input
              type="search"
              value={query}
              placeholder={t("news.search")}
              aria-label={t("news.search")}
              onChange={(e) => setQuery(e.target.value)}
            />
          </label>
          <div className="news-filters" role="radiogroup" aria-label={t("news.filters")}>
            {NEWS_FILTERS.map((f) => (
              // biome-ignore lint/a11y/useSemanticElements: filter chips, like the other segmented controls
              <button
                key={f}
                type="button"
                role="radio"
                aria-checked={filter === f}
                className="news-filter"
                onClick={() => setFilter(f)}
              >
                {f === "mine" ? t("news.filter.mine", { count: mine }) : t(FILTER_LABEL[f])}
              </button>
            ))}
          </div>
          <label className="news-check">
            <input
              type="checkbox"
              checked={highOnly}
              onChange={(e) => setHighOnly(e.target.checked)}
            />
            {t("news.highOnly")}
          </label>
          <div className="news-scroll">{list}</div>
        </section>
        <section className="news-panel news-coming">
          <h3 className="news-side-title">{t("news.comingUp")}</h3>
          {coming.length === 0 ? (
            <p className="news-muted news-pad">{t("news.nothingUp")}</p>
          ) : (
            coming.map((u) => {
              const due = u.kind === "funding" ? fundingDue(u.position, u.rate) : 0;
              return (
                <div
                  key={`${u.kind}:${u.time}:${u.kind === "funding" ? u.position.market : u.item.id}`}
                  className="news-up"
                  data-kind={u.kind === "funding" ? "funding" : u.item.kind}
                >
                  <span className="news-up-time">
                    <span className="news-num">
                      {dateFormat(now + 20 * 3_600_000 > u.time ? CLOCK : FULL).format(u.time)}
                    </span>
                    <span className="news-up-in">{relative(u.time, now)}</span>
                  </span>
                  <span className="news-up-main">
                    <strong>
                      {u.kind === "funding"
                        ? t("news.funding", { symbol: symbolOf(u.position.market) })
                        : u.item.title}
                    </strong>
                    <span className="news-muted">
                      {u.kind === "funding" ? (
                        <>
                          {t("news.fundingRate", { rate: formatNumber(u.rate * 100, 4) })} ·{" "}
                          <span className={trendClass(due)}>{formatSigned(due)}</span>
                        </>
                      ) : (
                        t(KIND_LABEL[u.item.kind])
                      )}
                    </span>
                  </span>
                </div>
              );
            })
          )}
        </section>
      </div>

      <section className="news-panel news-detail">
        {selected ? (
          <>
            <header className="news-detail-head">
              <p className="news-detail-meta">
                <Badges item={selected} />
                <span>
                  {sourceOf(selected)} · {dateFormat(FULL).format(selected.time)} ·{" "}
                  {relative(selected.time, now)}
                </span>
              </p>
              <h2>{selected.title}</h2>
              {selected.description && <p className="news-detail-body">{selected.description}</p>}
              {selected.tags.length > 0 && (
                <p className="news-tags">
                  {selected.tags.map((tag) => (
                    <span key={tag} className="news-chip">
                      {tag}
                    </span>
                  ))}
                </p>
              )}
              {selected.article && (
                <p className="news-read">
                  <button
                    type="button"
                    className="news-trade-go"
                    onClick={() => {
                      const id = selected.article ?? "";
                      setOpenFailed(undefined);
                      newsClient.open(id).catch(() => setOpenFailed(id));
                    }}
                  >
                    {t("news.read", { source: sourceOf(selected) })}
                  </button>
                  {openFailed === selected.article && (
                    <span className="news-muted">{t("news.openFailed")}</span>
                  )}
                </p>
              )}
            </header>

            {chartMarket ? (
              <div className="news-chart">
                <div className="news-chart-head">
                  <span className="news-label">
                    {t("news.since", { symbol: symbolOf(chartMarket) })}
                  </span>
                  {chart && (
                    <span className="news-chart-price">
                      {formatNumber(chart.last.close)}
                      {chart.mark && (
                        <span className={trendClass(Number(chart.last.close) - chart.mark.price)}>
                          {formatSigned((Number(chart.last.close) / chart.mark.price - 1) * 100)}%
                        </span>
                      )}
                      {chart.mark && (
                        <span className="news-chart-basis">{t("news.sinceHeadline")}</span>
                      )}
                    </span>
                  )}
                </div>
                {chart ? (
                  <>
                    <svg
                      className="news-chart-svg"
                      viewBox={`0 0 ${CHART_W} ${CHART_H}`}
                      preserveAspectRatio="none"
                      data-trend={
                        Number(chart.last.close) >= (chart.mark?.price ?? Number(chart.first.close))
                          ? "up"
                          : "down"
                      }
                      role="img"
                      aria-label={t("news.since", { symbol: symbolOf(chartMarket) })}
                    >
                      <path className="news-chart-area" d={chart.area} />
                      <path className="news-chart-line" d={chart.line} />
                      {chart.mark && (
                        <line
                          className="news-chart-mark"
                          x1={chart.mark.x}
                          x2={chart.mark.x}
                          y1="0"
                          y2={CHART_H}
                        />
                      )}
                      {/* The price the change is measured from, level across to now. */}
                      {chart.mark && (
                        <line
                          className="news-chart-base"
                          x1={chart.mark.x}
                          x2={CHART_W}
                          y1={chart.mark.y}
                          y2={chart.mark.y}
                        />
                      )}
                    </svg>
                    <div className="news-chart-foot">
                      <span>{dateFormat(FULL).format(chart.first.openTime)}</span>
                      {chart.mark && (
                        <span className="news-chart-note">
                          {t("news.headlineAt", {
                            time: dateFormat(FULL).format(selected.time),
                            price: formatNumber(chart.mark.price, chartPlaces(chart.last.close)),
                          })}
                        </span>
                      )}
                      <span>{t("news.now")}</span>
                    </div>
                  </>
                ) : candles && candles.key === chartKey ? (
                  <p className="news-muted">{t("news.noCandles")}</p>
                ) : (
                  <div className="pd-skel news-chart-skel" />
                )}
              </div>
            ) : (
              // No market to chart: what the market's doing instead.
              (moving.gainers.length > 0 || moving.losers.length > 0) && (
                <div className="news-movers">
                  <h3 className="news-label">{t("movement.movers")}</h3>
                  <div className="news-movers-cols">
                    {(["gainers", "losers"] as const).map((side) => (
                      <div key={side} className="news-movers-col">
                        <span className="news-muted">
                          {t(side === "gainers" ? "picker.gainers" : "picker.losers")}
                        </span>
                        {moving[side].map((m) => (
                          <button
                            key={m.market}
                            type="button"
                            className="news-mover"
                            onClick={() => onTrade(m.market)}
                          >
                            <strong>{symbolOf(m.market)}</strong>
                            <span className="news-num">{formatNumber(m.price)}</span>
                            <span className={`news-num ${trendClass(m.change)}`}>
                              {formatSigned(m.change)}%
                            </span>
                          </button>
                        ))}
                      </div>
                    ))}
                  </div>
                </div>
              )
            )}

            {selected.markets.length > 0 && (
              <div className="news-trade">
                <h3 className="news-label">{t("news.tradeIt")}</h3>
                {selected.markets.map((id) => {
                  const s = summaryOf(id);
                  const change =
                    s && Number(s.prevDayPrice) > 0
                      ? (Number(s.markPrice) / Number(s.prevDayPrice) - 1) * 100
                      : undefined;
                  const held = positions.find((p) => p.market === id);
                  return (
                    <div key={id} className="news-trade-row">
                      <strong>{symbolOf(id)}</strong>
                      <span className="news-muted">{venueLabel}</span>
                      <span className="news-num">{s ? formatNumber(s.markPrice) : "-"}</span>
                      <span
                        className={`news-num ${change === undefined ? "" : trendClass(change)}`}
                      >
                        {change === undefined ? "-" : `${formatSigned(change)}%`}
                      </span>
                      <span className="news-muted">
                        {held
                          ? t(held.side === "long" ? "news.yourLong" : "news.yourShort", {
                              size: formatNumber(held.size),
                            })
                          : t("news.noPosition")}
                      </span>
                      <button type="button" className="news-trade-go" onClick={() => onTrade(id)}>
                        {t("news.trade")}
                      </button>
                    </div>
                  );
                })}
              </div>
            )}

            {more.length > 0 && (
              <div className="news-more">
                <h3 className="news-label">{t("news.more")}</h3>
                {more.map((item) => (
                  <button
                    key={item.id}
                    type="button"
                    className="news-more-row"
                    onClick={() => setSelectedId(item.id)}
                  >
                    <time className="news-row-time">{listTime(item.time, now)}</time>
                    <span className="news-row-main">
                      <span className="news-row-title">{item.title}</span>
                      <span className="news-row-source">{sourceOf(item)}</span>
                    </span>
                  </button>
                ))}
              </div>
            )}
          </>
        ) : (
          <EmptyState>{t("news.pick")}</EmptyState>
        )}
      </section>

      <aside className="news-side">
        <section className="news-panel">
          <h3 className="news-side-title">{t("news.sources")}</h3>
          <p className="news-muted news-pad">{t("news.subtitle")}</p>
          <div className="news-source">
            <span className="news-source-name">
              <strong>{t("news.sourceAnnouncements")}</strong>
              <span className="news-muted">{announcer}</span>
            </span>
            <Switch
              checked={announcementsOn === "on"}
              onChange={(on) => setAnnouncementsOn(on ? "on" : "off")}
              label={t("news.sourceAnnouncements")}
            />
          </div>
          <div className="news-source">
            <span className="news-source-name">
              <strong>{t("news.sourceCampaigns")}</strong>
              <span className="news-muted">{t("news.sourceCampaignsHint")}</span>
            </span>
            <Switch
              checked={campaignsOn === "on"}
              onChange={(on) => setCampaignsOn(on ? "on" : "off")}
              label={t("news.sourceCampaigns")}
            />
          </div>
          {PUBLISHERS.map((p) => (
            <div key={p.id} className="news-source">
              <span className="news-source-name">
                <strong>{p.name}</strong>
                <span className="news-muted">{t("news.sourceFeed")}</span>
              </span>
              <Switch
                checked={!muted.includes(p.id)}
                onChange={(on) => {
                  const next = on ? muted.filter((id) => id !== p.id) : [...muted, p.id];
                  setMuted(next);
                  saveMutedPublishers(next);
                }}
                label={p.name}
              />
            </div>
          ))}
          <p className="news-muted news-pad news-sources-note">{t("news.sourcesMissing")}</p>
        </section>
      </aside>
    </div>
  );
}
