import type { CandleInterval, Market, MarketSummary, VenueId } from "@pewterdesk/core";
import {
  CandleChart,
  type CandleChartHandle,
  ChartToolbar,
  type ChartType,
  decimalsOf,
  EmptyState,
  formatNumber,
  formatSigned,
  INTERVAL_MS,
  type IndicatorId,
  MarketSearch,
  t,
  trendClass,
} from "@pewterdesk/ui";
import { useEffect, useRef, useState } from "react";
import { LuExternalLink } from "react-icons/lu";
import { useCandles } from "../../hooks/useVenueFeeds";
import { exportChartImage } from "../../lib/chartPrefs";
import {
  type ChartCell,
  GRID,
  LAYOUTS,
  loadMultiChart,
  type MultiChartState,
  saveMultiChart,
  toggledIndicator,
  withCell,
  withInterval,
  withMarket,
  withSync,
} from "../../lib/multiChart";
import { LoadingMark } from "../Splash";

interface CellProps {
  venue: VenueId;
  cell: ChartCell;
  markets: readonly Market[];
  summary?: MarketSummary;
  onMarket: (id: string) => void;
  onInterval: (interval: CandleInterval) => void;
  onType: (type: ChartType) => void;
  onIndicators: (indicators: IndicatorId[]) => void;
  /** Opens this chart's market on the Trade page. */
  onTrade: () => void;
  /** The loading mark's size: smaller in a 3 x 3 than side by side. */
  markSize: number;
}

/** One chart of the grid: its market and timeframe, its last price, and its candles. */
function Cell({
  venue,
  cell,
  markets,
  summary,
  onMarket,
  onInterval,
  onType,
  onIndicators,
  onTrade,
  markSize,
}: CellProps) {
  const chartRef = useRef<CandleChartHandle>(null);
  const market = markets.find((m) => m.id === cell.market);
  const { feed, loadOlder } = useCandles(venue, cell.market, cell.interval);
  const change =
    summary && Number(summary.prevDayPrice) > 0
      ? (Number(summary.markPrice) / Number(summary.prevDayPrice) - 1) * 100
      : undefined;
  const data = feed.status === "live" || feed.status === "closed" ? feed.data : undefined;

  return (
    <section className="mc-cell" aria-label={market?.symbol ?? cell.market}>
      <header className="mc-cell-head">
        <MarketSearch
          label={t("col.market")}
          markets={markets}
          value={cell.market}
          onChange={onMarket}
        />
        {summary && <span className="pd-num mc-price">{formatNumber(summary.markPrice)}</span>}
        {change !== undefined && (
          <span className={`pd-num ${trendClass(change)}`}>{formatSigned(change)}%</span>
        )}
        <button
          type="button"
          className="pd-icon-button mc-open"
          aria-label={t("multichart.trade", { symbol: market?.symbol ?? cell.market })}
          title={t("multichart.trade", { symbol: market?.symbol ?? cell.market })}
          onClick={onTrade}
        >
          <LuExternalLink size={14} aria-hidden />
        </button>
      </header>
      {/* This chart's own timeframe, style and indicators. */}
      <ChartToolbar
        compact
        interval={cell.interval}
        onInterval={onInterval}
        chartType={cell.type}
        onChartType={onType}
        indicators={cell.indicators}
        onToggleIndicator={(id) => onIndicators(toggledIndicator(cell.indicators, id))}
        onScreenshot={() =>
          exportChartImage(
            chartRef.current?.screenshot(),
            `pewterdesk-${market?.symbol ?? cell.market}-${cell.interval}.png`,
          )
        }
      />
      <div className="mc-chart">
        {feed.status === "error" ? (
          <EmptyState>{feed.message}</EmptyState>
        ) : !data ? (
          // The app's mark while this chart's candles arrive.
          <div className="chart-loader" role="status" aria-label={t("chart.loading")}>
            <LoadingMark size={markSize} />
          </div>
        ) : data.length === 0 ? (
          <p className="pd-empty">{t("chart.empty")}</p>
        ) : (
          <CandleChart
            ref={chartRef}
            chartType={cell.type}
            candles={data}
            intervalMs={INTERVAL_MS[cell.interval]}
            seriesKey={`${cell.market}:${cell.interval}`}
            priceDecimals={decimalsOf(data.at(-1)?.close ?? "0")}
            onNeedOlder={loadOlder}
            indicators={cell.indicators}
            onRemoveIndicator={(id) => onIndicators(toggledIndicator(cell.indicators, id))}
          />
        )}
      </div>
    </section>
  );
}

interface MultiChartPageProps {
  venue: VenueId;
  markets: Market[];
  /** The venue's bottom-bar markets: what the charts start on. */
  majors: readonly string[];
  summaries?: MarketSummary[];
  /** Opens a market on the Trade page. */
  onTrade: (marketId: string) => void;
}

/**
 * Several charts at once, two side by side, a 2x2 or a 3x3. Each is its
 * own: its market, timeframe, chart style and indicators change nothing on
 * the others, and each loads its own candles from the venue. Intervals can
 * be made to move together if asked, and so can the market, which puts one
 * market on every chart at different timeframes.
 */
export function MultiChartPage({
  venue,
  markets,
  majors,
  summaries,
  onTrade,
}: MultiChartPageProps) {
  const [state, setState] = useState<MultiChartState>(() => loadMultiChart(venue, markets, majors));
  // Another venue, or its market list arriving: what's saved for it, checked
  // against the markets it really has.
  // biome-ignore lint/correctness/useExhaustiveDependencies: keyed on the venue and whether its markets are in
  useEffect(() => {
    setState(loadMultiChart(venue, markets, majors));
  }, [venue, markets.length > 0]);
  const update = (next: MultiChartState) => {
    setState(next);
    saveMultiChart(venue, next);
  };

  const { cols, rows } = GRID[state.layout];
  const shown = state.cells.slice(0, cols * rows);

  return (
    <div className="page mc">
      <header className="mc-bar">
        <h1>{t("nav.charts")}</h1>
        <div className="mc-seg" role="radiogroup" aria-label={t("multichart.layout")}>
          {LAYOUTS.map((layout) => (
            // biome-ignore lint/a11y/useSemanticElements: a segmented choice, like the app's others
            <button
              key={layout}
              type="button"
              role="radio"
              aria-checked={state.layout === layout}
              className="mc-seg-option"
              onClick={() => update({ ...state, layout })}
            >
              {layout.replace("x", " × ")}
            </button>
          ))}
        </div>
        <span className="mc-sync-label">{t("multichart.sync")}</span>
        {(["interval", "symbol"] as const).map((which) => {
          const on = which === "interval" ? state.syncInterval : state.syncSymbol;
          return (
            // biome-ignore lint/a11y/useSemanticElements: a chip-style checkbox, like the app's others
            <button
              key={which}
              type="button"
              role="checkbox"
              aria-checked={on}
              className="mc-chip"
              title={t(
                which === "interval" ? "multichart.syncIntervalHint" : "multichart.syncSymbolHint",
              )}
              onClick={() => update(withSync(state, which, !on))}
            >
              {t(which === "interval" ? "multichart.interval" : "multichart.symbol")}
            </button>
          );
        })}
      </header>
      {shown.length === 0 ? (
        // Nothing to chart yet (the venue's markets are still arriving): the
        // mark over the whole page.
        <div className="chart-loader mc-loading" role="status" aria-label={t("chart.loading")}>
          <LoadingMark size={64} />
        </div>
      ) : (
        <div
          className="mc-grid"
          style={{
            gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))`,
            gridTemplateRows: `repeat(${rows}, minmax(0, 1fr))`,
          }}
        >
          {shown.map((cell, i) => (
            <Cell
              // biome-ignore lint/suspicious/noArrayIndexKey: a chart is its place in the grid
              key={i}
              venue={venue}
              cell={cell}
              markets={markets}
              summary={summaries?.find((s) => s.market === cell.market)}
              onMarket={(id) => update(withMarket(state, i, id))}
              onInterval={(interval) => update(withInterval(state, i, interval))}
              onType={(type) => update(withCell(state, i, { type }))}
              onIndicators={(indicators) => update(withCell(state, i, { indicators }))}
              onTrade={() => onTrade(cell.market)}
              markSize={cols * rows > 4 ? 36 : 48}
            />
          ))}
        </div>
      )}
    </div>
  );
}
