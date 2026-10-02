import { venueLogos } from "@pewterdesk/assets";
import type { Market, VenueId } from "@pewterdesk/core";
import { decimalsOf, formatNumber, formatSigned, StarButton, TokenIcon, t } from "@pewterdesk/ui";
import { useState } from "react";
import { LuStar } from "react-icons/lu";
import { useMarketSummaries, useMarkets } from "../../hooks/useVenueFeeds";
import { useWatchlist } from "../../hooks/useWatchlist";
import { VENUES } from "../../lib/venues";
import { BarPopover } from "./BarPopover";

const loaded = <T,>(f: { status: string; data?: T }) =>
  f.status === "live" || f.status === "closed" ? f.data : undefined;

/** One venue's starred markets, with prices while the panel is open. */
function VenueList({
  venue,
  current,
  currentMarkets,
  onOpenMarket,
}: {
  venue: VenueId;
  /** The venue on screen, whose market list is already loaded. */
  current: VenueId;
  currentMarkets: readonly Market[];
  onOpenMarket: (venue: VenueId, market: string) => void;
}) {
  const { starred, toggle } = useWatchlist(venue);
  const other = useMarkets(venue === current ? undefined : venue);
  const markets =
    venue === current ? currentMarkets : ((loaded(other) as Market[] | undefined) ?? []);
  const summaries = loaded(useMarketSummaries(venue, starred.size > 0));
  const rows = [...starred].flatMap((id) => {
    const market = markets.find((m) => m.id === id);
    return market ? [market] : [];
  });
  const waiting = starred.size > 0 && markets.length === 0;

  if (starred.size === 0) {
    return <p className="bar-watch-empty">{t("watch.empty", { venue: VENUES[venue].label })}</p>;
  }
  return (
    <ul className="bar-watch-list">
      {waiting && <li className="bar-watch-empty">{t("feed.loading")}</li>}
      {rows.map((m) => {
        const s = summaries?.find((x) => x.market === m.id);
        const price = s ? Number(s.markPrice) : undefined;
        const prev = s ? Number(s.prevDayPrice) : 0;
        const change = price !== undefined && prev > 0 ? ((price - prev) / prev) * 100 : undefined;
        return (
          <li key={m.id}>
            <button
              type="button"
              className="bar-watch-row"
              onClick={() => onOpenMarket(venue, m.id)}
            >
              <TokenIcon market={m} size={16} />
              <span className="bar-watch-name">{m.symbol}</span>
              <span className="pd-num">
                {price === undefined ? "-" : formatNumber(price, decimalsOf(m.tickSize))}
              </span>
              <span
                className="pd-num bar-watch-change"
                data-trend={change === undefined ? undefined : change >= 0 ? "up" : "down"}
              >
                {change === undefined ? "-" : `${formatSigned(change, 2)}%`}
              </span>
            </button>
            <StarButton starred name={m.symbol} size={14} onToggle={() => toggle(m.id)} />
          </li>
        );
      })}
    </ul>
  );
}

/** How many markets are starred on each venue: one hook per venue, in a fixed order. */
function useStarredCounts(venues: readonly VenueId[]): Record<VenueId, number> {
  const bybit = useWatchlist("bybit").starred.size;
  const hyperliquid = useWatchlist("hyperliquid").starred.size;
  const aster = useWatchlist("aster").starred.size;
  const all: Record<VenueId, number> = { bybit, hyperliquid, aster };
  return Object.fromEntries(venues.map((v) => [v, all[v]])) as Record<VenueId, number>;
}

/**
 * The bottom bar's Watchlist: the starred markets on each venue in the
 * terminal, a tab per venue, with price and 24h change. A row opens its
 * market; the star unstars it.
 */
export function WatchlistBar({
  venue,
  venues,
  markets,
  onOpenMarket,
}: {
  venue: VenueId;
  /** The venues in the terminal, in the chips' order. */
  venues: readonly VenueId[];
  markets: readonly Market[];
  onOpenMarket: (venue: VenueId, market: string) => void;
}) {
  const counts = useStarredCounts(venues);
  const total = venues.reduce((sum, v) => sum + (counts[v] ?? 0), 0);
  const [tab, setTab] = useState<VenueId>(venue);
  const active = venues.includes(tab) ? tab : (venues[0] ?? venue);

  return (
    <BarPopover
      label={t("tab.watchlist")}
      button={
        <>
          <LuStar size={13} aria-hidden />
          {t("tab.watchlist")}
          {total > 0 && <span className="bar-watch-count pd-num">{total}</span>}
        </>
      }
    >
      {() => (
        <div className="bar-watch">
          <p className="conn-title">{t("tab.watchlist")}</p>
          <div className="bar-watch-tabs" role="tablist" aria-label={t("tab.watchlist")}>
            {venues.map((v) => (
              <button
                key={v}
                type="button"
                role="tab"
                aria-selected={v === active}
                onClick={() => setTab(v)}
              >
                <img className="bar-watch-logo" src={venueLogos[v]} alt="" />
                {VENUES[v].label}
                <span className="bar-watch-tab-count pd-num">{counts[v] ?? 0}</span>
              </button>
            ))}
          </div>
          <VenueList
            key={active}
            venue={active}
            current={venue}
            currentMarkets={markets}
            onOpenMarket={onOpenMarket}
          />
        </div>
      )}
    </BarPopover>
  );
}
