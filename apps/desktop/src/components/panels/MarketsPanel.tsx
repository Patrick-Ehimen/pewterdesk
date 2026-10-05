import type {
  AccountSnapshot,
  CandleInterval,
  Market,
  OrderBook,
  Position,
  PositionProtection,
  VenueId,
} from "@pewterdesk/core";
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
  type ExitKind,
  exitMove,
  FUNDING_RESOLUTIONS,
  FundingChart,
  type FundingResolution,
  fundingSeries,
  IconButton,
  INTERVAL_MS,
  Tabs,
  t,
} from "@pewterdesk/ui";
import { useEffect, useMemo, useRef, useState } from "react";
import { LuFullscreen, LuMaximize2, LuMinimize2, LuShrink } from "react-icons/lu";
import { useStoredChoice } from "../../hooks/useStoredChoice";
import {
  type Feed,
  useAccountFills,
  useCandles,
  useFundingHistory,
} from "../../hooks/useVenueFeeds";
import {
  type ChartPrefs,
  exportChartImage,
  inOrder,
  loadChartPrefs,
  saveChartPrefs,
  toggled,
} from "../../lib/chartPrefs";
import { loadViewPrefs, saveViewPrefs, spanFraction, type ViewPrefs } from "../../lib/viewPrefs";
import type { ExpandMode } from "../../lib/workspace";
import { FeedView } from "../FeedView";
import { LoadingMark } from "../Splash";
import { CoinOverview } from "./CoinOverview";
import { ScreenerPanel } from "./ScreenerPanel";
import { ViewSettings } from "./ViewSettings";

type MarketsTab = "chart" | "overview" | "depth" | "screener" | "watchlist";

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
  /** The connected account on this venue, whose trading the chart shows. */
  address?: string;
  account?: AccountSnapshot;
  /** Sets a position's TP / SL; with it, they can be dragged on the chart. */
  onProtect?: (position: Position, protection: PositionProtection) => Promise<void>;
  /** Each new value brings the panel to the chart (e.g. a position was clicked). */
  showChart?: number;
}

/**
 * Chart, overview (what the coin is), depth, screener and watchlist for the
 * market on screen, tabbed as in the design. Each tab only subscribes to what it shows: candles while the
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
  address,
  account,
  onProtect,
  showChart,
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
  // A position clicked elsewhere: show its market's chart, whatever tab is up.
  // biome-ignore lint/correctness/useExhaustiveDependencies: runs on each new request only
  useEffect(() => {
    if (!showChart) return;
    setTab("chart");
    setChartKind("standard");
  }, [showChart]);
  // Chart style, indicators and toolbar favorites, remembered between sessions.
  const [prefs, setPrefs] = useState(loadChartPrefs);
  const updatePrefs = (change: (p: ChartPrefs) => ChartPrefs) =>
    setPrefs((p) => {
      const next = change(p);
      saveChartPrefs(next);
      return next;
    });
  // Each tab's own settings (the settings button), remembered the same way.
  const [views, setViews] = useState(loadViewPrefs);
  const updateViews = (change: (v: ViewPrefs) => ViewPrefs) =>
    setViews((v) => {
      const next = change(v);
      saveViewPrefs(next);
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
  // The account's trading in this market, over the candles.
  const fills = useAccountFills(venue, address, standardChart && views.chart.fills);
  const allFills = fills.status === "live" ? fills.data : undefined;
  const marketId = market?.id;
  const position = account?.positions.find((p) => p.market === marketId);
  const allOrders = account?.openOrders;
  const orders = useMemo(
    () => allOrders?.filter((o) => o.market === marketId),
    [allOrders, marketId],
  );
  const marketFills = useMemo(
    () => allFills?.filter((f) => f.market === marketId),
    [allFills, marketId],
  );
  // Dragging a TP or SL line sets it, as the TP / SL editor would.
  const moveExit =
    onProtect && position && market
      ? async (kind: ExitKind, price: number) => {
          const move = exitMove(position, kind, price, market.tickSize);
          if (move.result === "invalid") throw new Error(t(move.error));
          if (move.result === "unchanged") return undefined;
          await onProtect(position, move.protection);
          return move.price;
        }
      : undefined;
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
          { id: "overview", label: t("tab.overview") },
          { id: "depth", label: t("tab.depth") },
          { id: "screener", label: t("tab.screener") },
          { id: "watchlist", label: t("tab.watchlist") },
        ]}
        active={tab}
        onChange={setTab}
        aside={
          <div className="pd-panel-tools">
            {fundingChart && resolutionPicker}
            <ViewSettings view={tab} prefs={views} onChange={updateViews} />
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
                      intervalMs={INTERVAL_MS[interval]}
                      seriesKey={`${market?.id}:${interval}`}
                      priceDecimals={decimalsOf(data.at(-1)?.close ?? "0")}
                      market={market}
                      onNeedOlder={loadOlder}
                      position={views.chart.levels ? position : undefined}
                      orders={views.chart.levels ? orders : undefined}
                      fills={views.chart.fills ? marketFills : undefined}
                      onMoveExit={views.chart.levels ? moveExit : undefined}
                      grid={views.chart.grid}
                      logScale={views.chart.logScale}
                      countdown={views.chart.countdown}
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
      ) : tab === "overview" ? (
        <CoinOverview market={market} show={views.overview} />
      ) : tab === "depth" ? (
        <div className="app-fill">
          <FeedView
            feed={orLoading(book)}
            idle={t("depth.empty")}
            loading={<ChartSkeleton />}
            live={(data) =>
              // Expanded, there's room for the design's full depth view.
              expanded ? (
                <DepthView
                  book={data}
                  venue={venueName}
                  base={market?.base}
                  span={spanFraction(views.depth.span)}
                  display={views.depth}
                />
              ) : (
                <DepthChart
                  book={data}
                  venue={venueName}
                  span={spanFraction(views.depth.span)}
                  display={views.depth}
                />
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
          display={tab === "watchlist" ? views.watchlist : views.screener}
          expanded={expanded !== undefined}
        />
      )}
    </>
  );
}
