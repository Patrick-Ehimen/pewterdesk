import type { Market, VenueId } from "@pewterdesk/core";
import { dateFormat, EmptyState, FundingHeatmap, Screener, SignalsFeed, t } from "@pewterdesk/ui";
import { useFundingHeatmap } from "../../hooks/useFundingHeatmap";
import { useScreenerData } from "../../hooks/useScreenerData";

const UTC_TIME: Intl.DateTimeFormatOptions = {
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hour12: false,
  timeZone: "UTC",
};

interface ScreenerPanelProps {
  venue: VenueId;
  venueName: string;
  markets: Market[];
  selected?: string;
  onSelect: (market: Market) => void;
  starred: ReadonlySet<string>;
  onToggleStar: (market: Market) => void;
  /** The Watchlist tab: starred markets only. */
  watchlistOnly?: boolean;
  /** Expanded: the full table with the funding heatmap and signals beside it. */
  expanded: boolean;
}

/** The Screener and Watchlist tabs: the compact table, or the full screen when expanded. */
export function ScreenerPanel({
  venue,
  venueName,
  markets,
  selected,
  onSelect,
  starred,
  onToggleStar,
  watchlistOnly = false,
  expanded,
}: ScreenerPanelProps) {
  const data = useScreenerData(venue, markets, true);
  const heatmap = useFundingHeatmap(venue, data.rows, expanded);

  if (data.error) return <EmptyState error>{data.error}</EmptyState>;
  const loading = data.loading && data.rows.length === 0;

  const table = (
    <Screener
      rows={data.rows}
      selected={selected}
      onSelect={onSelect}
      starred={starred}
      onToggleStar={onToggleStar}
      variant={expanded ? "full" : "compact"}
      watchlistOnly={watchlistOnly}
      loading={loading}
      meta={
        data.updatedAt && (
          <span className="pd-muted pd-num">
            {t("screener.meta", {
              venue: venueName,
              time: dateFormat(UTC_TIME).format(data.updatedAt),
            })}
          </span>
        )
      }
      progress={
        !loading && data.filled < data.total
          ? t("screener.filling", { done: data.filled, total: data.total })
          : undefined
      }
    />
  );

  if (!expanded) return <div className="app-scroll">{table}</div>;
  return (
    <div className="pd-screener-full">
      <div className="pd-screener-main">{table}</div>
      <aside className="pd-screener-side">
        <FundingHeatmap
          rows={heatmap.rows}
          start={heatmap.start}
          loading={loading || heatmap.loading}
        />
        <SignalsFeed
          events={data.events}
          nameOf={(id) => markets.find((m) => m.id === id)?.base ?? id}
        />
      </aside>
    </div>
  );
}
