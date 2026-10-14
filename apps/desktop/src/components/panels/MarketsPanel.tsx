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
  ChartSkeleton,
  DepthChart,
  DepthView,
  type ExitKind,
  exitMove,
  FUNDING_RESOLUTIONS,
  FundingChart,
  type FundingResolution,
  fundingSeries,
  IconButton,
  OpenAlgoChart,
  Tabs,
  t,
} from "@pewterdesk/ui";
import { useEffect, useMemo, useState } from "react";
import { LuFullscreen, LuMaximize2, LuMinimize2, LuShrink } from "react-icons/lu";
import { useStoredChoice } from "../../hooks/useStoredChoice";
import { type Feed, useAccountFills, useFundingHistory } from "../../hooks/useVenueFeeds";
import { venueBarSource } from "../../lib/barSource";
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

/** Which chart the Charts tab shows: the price chart, or the funding history. */
type ChartKind = "standard" | "funding";
const CHART_KINDS: readonly ChartKind[] = ["standard", "funding"];

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
  // The toolbar's favorite intervals, remembered between sessions.
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
  const toggleFavoriteInterval = (i: CandleInterval) =>
    updatePrefs((p) => ({
      ...p,
      favoriteIntervals: inOrder(toggled(p.favoriteIntervals, i), ALL_INTERVALS),
    }));
  const chartTitle = [market?.symbol, interval, venueName, market?.listedBy]
    .filter(Boolean)
    .join(" · ");
  const shotName = `pewterdesk-${market?.symbol ?? "chart"}-${interval}.png`;
  const standardChart = tab === "chart" && chartKind === "standard";
  // The chart asks for its own candles, as it is scrolled back.
  const barSource = useMemo(() => venueBarSource(venue), [venue]);
  const fundingChart = tab === "chart" && chartKind === "funding";
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

  // Filling the workspace, the price chart takes all of it: the tab rows
  // (and the panel's title) give way, their buttons going to its toolbar.
  const filling = expanded === "full" && tab === "chart" && chartKind === "standard";
  const panelTools = (
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
  );

  return (
    <>
      {!filling && (
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
          aside={panelTools}
        />
      )}
      {tab === "chart" ? (
        // The quick trade bar is kept inside this (see App).
        <div className="app-fill" data-quick-trade-area data-chart-fill={filling || undefined}>
          {!filling && (
            <Tabs
              variant="sub"
              label={t("chart.kind")}
              tabs={[
                { id: "standard", label: t("chart.standard") },
                { id: "funding", label: t("chart.funding") },
              ]}
              active={chartKind}
              onChange={setChartKind}
            />
          )}
          {chartKind === "standard" ? (
            <div className="app-fill">
              <FeedView
                feed={orLoading<Market>(
                  market ? { status: "live", data: market } : { status: "idle" },
                )}
                idle={t("feed.pickMarket")}
                loading={
                  <div className="chart-loader" role="status" aria-label={t("chart.loading")}>
                    <LoadingMark size={48} />
                  </div>
                }
                live={(shown) => (
                  <OpenAlgoChart
                    key={venue}
                    source={barSource}
                    venue={venue}
                    markets={marketList}
                    market={shown}
                    title={chartTitle}
                    interval={interval}
                    onInterval={setInterval}
                    favoriteIntervals={prefs.favoriteIntervals}
                    onToggleFavoriteInterval={toggleFavoriteInterval}
                    onScreenshot={(shot) => exportChartImage(shot, shotName)}
                    position={views.chart.levels ? position : undefined}
                    orders={views.chart.levels ? orders : undefined}
                    fills={views.chart.fills ? marketFills : undefined}
                    onMoveExit={views.chart.levels ? moveExit : undefined}
                    tools={filling ? panelTools : undefined}
                    loading={
                      <div className="chart-loader" role="status" aria-label={t("chart.loading")}>
                        <LoadingMark size={48} />
                      </div>
                    }
                  />
                )}
              />
            </div>
          ) : (
            <div className="app-fill">
              <FeedView
                feed={orLoading(funding)}
                idle={t("feed.pickMarket")}
                loading={
                  // The app's mark, as on the price chart.
                  <div className="chart-loader" role="status" aria-label={t("chart.loading")}>
                    <LoadingMark size={48} />
                  </div>
                }
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
