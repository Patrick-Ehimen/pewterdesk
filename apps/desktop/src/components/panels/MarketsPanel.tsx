import type { CandleInterval, Market, OrderBook, VenueId } from "@pewterdesk/core";
import {
  ALL_INTERVALS,
  CandleChart,
  type CandleChartHandle,
  CHART_TYPES,
  ChartSkeleton,
  ChartToolbar,
  DepthChart,
  DepthView,
  decimalsOf,
  EmptyState,
  FUNDING_RESOLUTIONS,
  FundingChart,
  type FundingResolution,
  fundingSeries,
  IconButton,
  Tabs,
  t,
} from "@pewterdesk/ui";
import { useRef, useState } from "react";
import { LuFullscreen, LuMaximize2, LuMinimize2, LuSettings, LuShrink } from "react-icons/lu";
import { useStoredChoice } from "../../hooks/useStoredChoice";
import { type Feed, useCandles, useFundingHistory } from "../../hooks/useVenueFeeds";
import {
  type ChartPrefs,
  exportChartImage,
  inOrder,
  loadChartPrefs,
  saveChartPrefs,
  toggled,
} from "../../lib/chartPrefs";
import type { ExpandMode } from "../../lib/workspace";
import { FeedView } from "../FeedView";
import { LoadingMark } from "../Splash";
import { ScreenerPanel } from "./ScreenerPanel";

type MarketsTab = "chart" | "depth" | "screener" | "watchlist";

/**
 * Which chart the Charts tab shows: candles, the funding history, or
 * TradingView (a placeholder until the advanced chart lands).
 */
type ChartKind = "standard" | "tradingview" | "funding";
const CHART_KINDS: readonly ChartKind[] = ["standard", "tradingview", "funding"];

interface MarketsPanelProps {
  venue: VenueId;
  /** The venue's display name, labelling the depth curves and the chart. */
  venueName: string;
  markets: Feed<Market[]>;
  /** The market on screen. */
  market?: Market;
  onSelect: (market: Market) => void;
  /** Shared with the order book panel, so the depth chart needs no feed of its own. */
  book: Feed<OrderBook>;
  starred: ReadonlySet<string>;
  onToggleStar: (market: Market) => void;
  /** How this panel is expanded right now, if it is. */
  expanded?: ExpandMode;
  /** Expand in a mode, or collapse with `undefined`. */
  onExpand: (mode: ExpandMode | undefined) => void;
}

/**
 * Chart, depth, screener and watchlist for the market on screen, tabbed as in
 * the design. Each tab only subscribes to what it shows: candles while the
 * chart is open, the screener's poll while a list is open.
 */
export function MarketsPanel({
  venue,
  venueName,
  markets,
  market,
  onSelect,
  book,
  starred,
  onToggleStar,
  expanded,
  onExpand,
}: MarketsPanelProps) {
  const [tab, setTab] = useState<MarketsTab>("chart");
  const [interval, setInterval] = useStoredChoice<CandleInterval>(
    "pd.chart.interval",
    ALL_INTERVALS,
    "1h",
  );
  const [chartKind, setChartKind] = useStoredChoice<ChartKind>(
    "pd.chart.kind",
    CHART_KINDS,
    "standard",
  );
  // Chart style, indicators and toolbar favorites, remembered between sessions.
  const [prefs, setPrefs] = useState(loadChartPrefs);
  const updatePrefs = (change: (p: ChartPrefs) => ChartPrefs) =>
    setPrefs((p) => {
      const next = change(p);
      saveChartPrefs(next);
      return next;
    });
  const chartRef = useRef<CandleChartHandle>(null);
  const standardChart = tab === "chart" && chartKind === "standard";
  const fundingChart = tab === "chart" && chartKind === "funding";
  // Each chart only loads while it's showing.
  const { feed: candles, loadOlder } = useCandles(
    venue,
    standardChart ? market?.id : undefined,
    interval,
  );
  const funding = useFundingHistory(venue, fundingChart ? market?.id : undefined);
  const [resolution, setResolution] = useStoredChoice<FundingResolution>(
    "pd.funding.resolution",
    FUNDING_RESOLUTIONS,
    "8h",
  );
  const marketList = markets.status === "live" || markets.status === "closed" ? markets.data : [];
  // No market is chosen until the list arrives: that's still loading (or
  // failed), not a prompt to pick one, so the charts say which.
  const orLoading = <T,>(feed: Feed<T>): Feed<T> => {
    if (market !== undefined) return feed;
    if (markets.status === "loading") return { status: "loading" };
    if (markets.status === "error") return { status: "error", message: markets.message };
    return feed;
  };

  const resolutionPicker = (
    <div
      className="pd-segmented pd-intervals"
      role="radiogroup"
      aria-label={t("funding.resolution")}
    >
      {FUNDING_RESOLUTIONS.map((r) => (
        // biome-ignore lint/a11y/useSemanticElements: compact segmented control, like the interval picker
        <button
          key={r}
          type="button"
          role="radio"
          aria-checked={r === resolution}
          data-checked={r === resolution || undefined}
          onClick={() => setResolution(r)}
        >
          {r === "1d" ? t("funding.day") : r}
        </button>
      ))}
    </div>
  );

  return (
    <>
      <Tabs
        tabs={[
          { id: "chart", label: t("tab.chart") },
          { id: "depth", label: t("tab.depth") },
          { id: "screener", label: t("tab.screener") },
          { id: "watchlist", label: t("tab.watchlist") },
        ]}
        active={tab}
        onChange={setTab}
        aside={
          <div className="pd-panel-tools">
            {fundingChart && resolutionPicker}
            {/* Placeholder: panel settings aren't built yet, so it says so and does nothing. */}
            <IconButton className="pd-kebab" label={t("panel.settings")} aria-disabled>
              <LuSettings size={15} aria-hidden />
            </IconButton>
            <IconButton
              className="pd-kebab"
              label={t(expanded === "wide" ? "panel.collapse" : "panel.expand")}
              pressed={expanded === "wide"}
              onClick={() => onExpand(expanded === "wide" ? undefined : "wide")}
            >
              {expanded === "wide" ? (
                <LuMinimize2 size={15} aria-hidden />
              ) : (
                <LuMaximize2 size={15} aria-hidden />
              )}
            </IconButton>
            <IconButton
              className="pd-kebab"
              label={t(expanded === "full" ? "panel.exitFull" : "panel.fullView")}
              pressed={expanded === "full"}
              onClick={() => onExpand(expanded === "full" ? undefined : "full")}
            >
              {expanded === "full" ? (
                <LuShrink size={15} aria-hidden />
              ) : (
                <LuFullscreen size={15} aria-hidden />
              )}
            </IconButton>
          </div>
        }
      />
      {tab === "chart" ? (
        <div className="app-fill">
          <Tabs
            variant="sub"
            label={t("chart.kind")}
            tabs={[
              { id: "standard", label: t("chart.standard") },
              { id: "tradingview", label: t("chart.tradingview") },
              { id: "funding", label: t("chart.funding") },
            ]}
            active={chartKind}
            onChange={setChartKind}
          />
          {chartKind === "tradingview" ? (
            <EmptyState>{t("chart.tvSoon")}</EmptyState>
          ) : chartKind === "funding" ? (
            <div className="app-fill">
              <FeedView
                feed={orLoading(funding)}
                idle={t("feed.pickMarket")}
                loading={<ChartSkeleton />}
                live={(rates) =>
                  rates.length === 0 ? (
                    <p className="pd-empty">{t("funding.empty")}</p>
                  ) : (
                    <FundingChart
                      points={fundingSeries(rates, resolution)}
                      resolution={resolution}
                      seriesKey={`${market?.id}:${resolution}`}
                    />
                  )
                }
              />
            </div>
          ) : (
            <div className="app-fill">
              <ChartToolbar
                interval={interval}
                onInterval={setInterval}
                favoriteIntervals={prefs.favoriteIntervals}
                onToggleFavoriteInterval={(i) =>
                  updatePrefs((p) => ({
                    ...p,
                    favoriteIntervals: inOrder(toggled(p.favoriteIntervals, i), ALL_INTERVALS),
                  }))
                }
                chartType={prefs.type}
                onChartType={(type) => updatePrefs((p) => ({ ...p, type }))}
                favoriteTypes={prefs.favoriteTypes}
                onToggleFavoriteType={(type) =>
                  updatePrefs((p) => ({
                    ...p,
                    favoriteTypes: inOrder(toggled(p.favoriteTypes, type), CHART_TYPES),
                  }))
                }
                indicators={prefs.indicators}
                onToggleIndicator={(id) =>
                  updatePrefs((p) => ({ ...p, indicators: toggled(p.indicators, id) }))
                }
                onScreenshot={() =>
                  exportChartImage(
                    chartRef.current?.screenshot(),
                    `pewterdesk-${market?.symbol ?? "chart"}-${interval}.png`,
                  )
                }
              />
              <FeedView
                feed={orLoading(candles)}
                idle={t("feed.pickMarket")}
                loading={
                  <div className="chart-loader" role="status" aria-label={t("chart.loading")}>
                    <LoadingMark size={48} />
                  </div>
                }
                live={(data) =>
                  data.length === 0 ? (
                    <p className="pd-empty">{t("chart.empty")}</p>
                  ) : (
                    <CandleChart
                      ref={chartRef}
                      chartType={prefs.type}
                      indicators={prefs.indicators}
                      onRemoveIndicator={(id) =>
                        updatePrefs((p) => ({ ...p, indicators: toggled(p.indicators, id) }))
                      }
                      candles={data}
                      seriesKey={`${market?.id}:${interval}`}
                      priceDecimals={decimalsOf(data.at(-1)?.close ?? "0")}
                      market={market}
                      onNeedOlder={loadOlder}
                      title={[market?.symbol, interval, venueName, market?.listedBy]
                        .filter(Boolean)
                        .join(" · ")}
                    />
                  )
                }
              />
            </div>
          )}
        </div>
      ) : tab === "depth" ? (
        <div className="app-fill">
          <FeedView
            feed={orLoading(book)}
            idle={t("depth.empty")}
            loading={<ChartSkeleton />}
            live={(data) =>
              // Expanded, there's room for the design's full depth view.
              expanded ? (
                <DepthView book={data} venue={venueName} base={market?.base} />
              ) : (
                <DepthChart book={data} venue={venueName} />
              )
            }
          />
        </div>
      ) : (
        <ScreenerPanel
          venue={venue}
          venueName={venueName}
          markets={marketList}
          selected={market?.id}
          onSelect={onSelect}
          starred={starred}
          onToggleStar={onToggleStar}
          watchlistOnly={tab === "watchlist"}
          expanded={expanded !== undefined}
        />
      )}
    </>
  );
}
