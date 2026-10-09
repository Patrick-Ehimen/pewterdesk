import type {
  AccountSnapshot,
  CandleInterval,
  Market,
  MarketSummary,
  Order,
  Position,
  PositionProtection,
  VenueId,
} from "@pewterdesk/core";
import {
  CandleChart,
  type CandleChartHandle,
  ChartToolbar,
  type ChartType,
  decimalsOf,
  EmptyState,
  type ExitKind,
  exitMove,
  formatNumber,
  formatSigned,
  INTERVAL_MS,
  type IndicatorId,
  MarketSearch,
  type MessageKey,
  Select,
  t,
  trendClass,
} from "@pewterdesk/ui";
import { type FormEvent, useEffect, useRef, useState } from "react";
import {
  LuCheck,
  LuExternalLink,
  LuGripVertical,
  LuMaximize2,
  LuMinimize2,
  LuPictureInPicture2,
  LuSave,
  LuTrash2,
} from "react-icons/lu";
import { appClient } from "../../api/appClient";
import { useCandles, useMarketSummaries, useMarkets } from "../../hooks/useVenueFeeds";
import { exportChartImage } from "../../lib/chartPrefs";
import {
  applySet,
  type CellSettings,
  type ChartCell,
  currentSet,
  DEFAULT_CELL_SETTINGS,
  GRID,
  LAYOUTS,
  leavePopout,
  loadMultiChart,
  loadSets,
  type MultiChartState,
  repaired,
  SET_NAME_MAX,
  sameCoin,
  saveMultiChart,
  saveSets,
  swapped,
  toggledIndicator,
  withCell,
  withInterval,
  withMarket,
  withoutSet,
  withPositions,
  withSet,
  withSync,
} from "../../lib/multiChart";
import { VENUES } from "../../lib/venues";
import { HoldButton } from "../HoldButton";
import { SettingSwitch, SettingsPopover } from "../panels/ViewSettings";
import { LoadingMark } from "../Splash";

/** A venue's markets and their prices, while it's wanted. */
export function useVenueData(venue: VenueId, enabled: boolean) {
  const markets = useMarkets(enabled ? venue : undefined);
  const summaries = useMarketSummaries(venue, enabled);
  return {
    markets: markets.status === "live" || markets.status === "closed" ? markets.data : undefined,
    summaries:
      summaries.status === "live" || summaries.status === "closed" ? summaries.data : undefined,
  };
}

interface TradeStripProps {
  market?: Market;
  /** The mark price: what the buttons show, and the quantity is valued at. */
  price?: number;
  /**
   * Places a market order of that many coins; rejects with why not (said in
   * a notification by whoever placed it). Unset where this chart can't be
   * traded: the buttons stay, disabled, and say why.
   */
  onOrder?: (side: "buy" | "sell", size: number) => Promise<void>;
  /** Why it can't be traded. */
  reason?: string;
}

/**
 * Buy and sell under a chart: a quantity between a market long and a market
 * short. Each button acts only once held, so a stray click among nine
 * charts can't place an order.
 */
function TradeStrip({ market, price, onOrder, reason }: TradeStripProps) {
  const [qty, setQty] = useState("");
  const [sending, setSending] = useState(false);
  const size = Number(qty);
  const ready = onOrder !== undefined && market !== undefined && size > 0 && !sending;
  const send = async (side: "buy" | "sell") => {
    if (!onOrder || !(size > 0) || sending) return;
    setSending(true);
    try {
      await onOrder(side, size);
      // Placed: it starts over, so a second hold can't repeat it.
      setQty("");
    } catch {
      // Whoever placed it says why not.
    } finally {
      setSending(false);
    }
  };
  const value = size > 0 && price !== undefined && price > 0 ? size * price : undefined;
  const shown = price === undefined ? "-" : formatNumber(price);
  const side = (which: "buy" | "sell") => (
    <HoldButton
      className="mc-trade-side"
      disabled={!ready}
      label={t(which === "buy" ? "quick.long" : "quick.short")}
      onDone={() => void send(which)}
    >
      <span data-side={which}>{t(which === "buy" ? "quick.long" : "quick.short")}</span>
      <span className="pd-num">{shown}</span>
    </HoldButton>
  );
  return (
    <div className="mc-trade" title={onOrder ? undefined : reason}>
      {side("buy")}
      <label className="mc-trade-size">
        <input
          inputMode="decimal"
          placeholder={t("quick.qty")}
          aria-label={t("quick.qtyLabel", { base: market?.base ?? "" })}
          value={qty}
          disabled={!onOrder}
          onChange={(e) => {
            // Digits and one decimal point only.
            const next = e.target.value.replace(",", ".");
            if (/^\d*\.?\d*$/.test(next)) setQty(next);
          }}
        />
        {value !== undefined && (
          <span className="mc-trade-value pd-num">
            ≈ {formatNumber(value, 2)}
            {market ? ` ${market.quote}` : ""}
          </span>
        )}
      </label>
      {side("sell")}
    </div>
  );
}

interface CellProps {
  cell: ChartCell;
  /** The venues a chart can be on; none or one leaves no choice to show. */
  venues?: readonly { id: VenueId; label: string }[];
  /** This chart's venue's markets; empty until they arrive. */
  markets: readonly Market[];
  summary?: MarketSummary;
  onVenue?: (venue: VenueId) => void;
  onMarket: (id: string) => void;
  onInterval: (interval: CandleInterval) => void;
  onType: (type: ChartType) => void;
  onIndicators: (indicators: IndicatorId[]) => void;
  /** This chart's own grid, scale, countdown and position lines. */
  onSettings: (settings: CellSettings) => void;
  /** Opens this chart's market on the Trade page; no button without it. */
  onTrade?: () => void;
  /** Opens this chart in a window of its own; no button without it. */
  onPopOut?: () => void;
  /**
   * Sets the position's take-profit or stop-loss, as the TP / SL editor
   * would; with it, their lines on the chart can be dragged.
   */
  onProtect?: (position: Position, protection: PositionProtection) => Promise<void>;
  /** The buy and sell strip under the chart; none without it. */
  trade?: Pick<TradeStripProps, "onOrder" | "reason">;
  /** The loading mark's size: smaller in a 3 x 3 than side by side. */
  markSize: number;
  /** The account's position and open orders in this chart's market, drawn on it. */
  position?: Position;
  orders?: readonly Order[];
  /** Whether this chart fills the page, and the button that switches it. */
  maximised?: boolean;
  onMaximise?: () => void;
  /** The pointer's moment on this chart, for the others; unset when not shared. */
  onCrosshair?: (time: number | undefined) => void;
  /** Another chart's moment, to mark here. */
  crosshairTime?: number;
  /** The dates on screen as this chart is scrolled or zoomed, for the others. */
  onRange?: (range: { from: number; to: number }) => void;
  /** Another chart's dates, to show here. */
  range?: { from: number; to: number };
  /**
   * Dragging this chart by its grip, to swap it with the one it's dropped
   * on; no grip without it.
   */
  onDragStart?: () => void;
  onDragEnd?: () => void;
  /** Another chart is being dragged over this one, or dropped on it. */
  onDragOver?: () => void;
  onDrop?: () => void;
  /** "from" while it's the one being dragged, "over" while another is over it. */
  dragging?: "from" | "over";
}

/** One chart of the grid: its venue, market and timeframe, its last price, and its candles. */
export function Cell({
  cell,
  venues = [],
  markets,
  summary,
  onVenue,
  onMarket,
  onInterval,
  onType,
  onIndicators,
  onSettings,
  onTrade,
  onPopOut,
  onProtect,
  trade,
  markSize,
  position,
  orders,
  maximised = false,
  onMaximise,
  onCrosshair,
  crosshairTime,
  onRange,
  range,
  onDragStart,
  onDragEnd,
  onDragOver,
  onDrop,
  dragging,
}: CellProps) {
  const chartRef = useRef<CandleChartHandle>(null);
  const market = markets.find((m) => m.id === cell.market);
  const { feed, loadOlder } = useCandles(cell.venue, cell.market, cell.interval);
  const change =
    summary && Number(summary.prevDayPrice) > 0
      ? (Number(summary.markPrice) / Number(summary.prevDayPrice) - 1) * 100
      : undefined;
  const data = feed.status === "live" || feed.status === "closed" ? feed.data : undefined;
  const name = market?.symbol ?? cell.market;
  const { settings } = cell;
  // Dragging a TP or SL line sets it, as on the Trade page's chart.
  const moveExit =
    onProtect && position && market && settings.levels
      ? async (kind: ExitKind, price: number) => {
          const move = exitMove(position, kind, price, market.tickSize);
          if (move.result === "invalid") throw new Error(t(move.error));
          if (move.result === "unchanged") return undefined;
          await onProtect(position, move.protection);
          return move.price;
        }
      : undefined;
  const setting = (key: keyof CellSettings, label: MessageKey) => (
    <SettingSwitch
      label={t(label)}
      checked={settings[key]}
      onChange={(on) => onSettings({ ...settings, [key]: on })}
    />
  );

  return (
    <section
      className="mc-cell"
      aria-label={name}
      data-dragging={dragging}
      onDragOver={
        onDragOver &&
        ((e) => {
          // Says a chart can be dropped here.
          e.preventDefault();
          onDragOver();
        })
      }
      onDrop={
        onDrop &&
        ((e) => {
          e.preventDefault();
          onDrop();
        })
      }
    >
      <header className="mc-cell-head">
        {onDragStart && (
          <button
            type="button"
            className="pd-icon-button mc-grip"
            aria-label={t("multichart.move", { symbol: name })}
            title={t("multichart.move", { symbol: name })}
            draggable
            onDragStart={(e) => {
              e.dataTransfer.effectAllowed = "move";
              e.dataTransfer.setData("text/plain", name);
              onDragStart();
            }}
            onDragEnd={onDragEnd}
          >
            <LuGripVertical size={14} aria-hidden />
          </button>
        )}
        {venues.length > 1 && onVenue && (
          <Select
            className="mc-venue"
            label={t("portfolio.col.venue")}
            value={cell.venue}
            options={venues.map((v) => ({ value: v.id, label: v.label }))}
            onChange={onVenue}
          />
        )}
        <MarketSearch
          label={t("col.market")}
          markets={markets}
          value={cell.market}
          onChange={onMarket}
        />
        {summary && <span className="pd-num mc-price">{formatNumber(summary.markPrice)}</span>}
        {change !== undefined && (
          <span className={`pd-num mc-change ${trendClass(change)}`}>{formatSigned(change)}%</span>
        )}
        {onMaximise && (
          <button
            type="button"
            className="pd-icon-button mc-open"
            aria-label={t(maximised ? "multichart.restore" : "multichart.maximise")}
            title={t(maximised ? "multichart.restore" : "multichart.maximise")}
            aria-pressed={maximised}
            onClick={onMaximise}
          >
            {maximised ? (
              <LuMinimize2 size={14} aria-hidden />
            ) : (
              <LuMaximize2 size={14} aria-hidden />
            )}
          </button>
        )}
        {onPopOut && (
          <button
            type="button"
            className="pd-icon-button"
            aria-label={t("multichart.popOut", { symbol: name })}
            title={t("multichart.popOut", { symbol: name })}
            onClick={onPopOut}
          >
            <LuPictureInPicture2 size={14} aria-hidden />
          </button>
        )}
        {onTrade && (
          <button
            type="button"
            className="pd-icon-button"
            aria-label={t("multichart.trade", { symbol: name })}
            title={t("multichart.trade", { symbol: name })}
            onClick={onTrade}
          >
            <LuExternalLink size={14} aria-hidden />
          </button>
        )}
      </header>
      {/* This chart's own timeframe, style, indicators and settings. */}
      <div className="mc-tools">
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
              `pewterdesk-${name}-${cell.interval}.png`,
            )
          }
        />
        <SettingsPopover
          className="pd-icon-button"
          title={t("view.title", { view: t("tab.chart") })}
          onReset={() => onSettings(DEFAULT_CELL_SETTINGS)}
        >
          {setting("grid", "view.grid")}
          {setting("logScale", "view.chart.log")}
          {setting("countdown", "view.chart.countdown")}
          {setting("levels", "view.chart.levels")}
        </SettingsPopover>
      </div>
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
            seriesKey={`${cell.venue}:${cell.market}:${cell.interval}`}
            priceDecimals={decimalsOf(data.at(-1)?.close ?? "0")}
            onNeedOlder={loadOlder}
            position={settings.levels ? position : undefined}
            orders={settings.levels ? orders : undefined}
            grid={settings.grid}
            logScale={settings.logScale}
            countdown={settings.countdown}
            onMoveExit={moveExit}
            onVisibleRange={onRange}
            visibleRange={range}
            onCrosshairTime={onCrosshair}
            crosshairTime={crosshairTime}
            indicators={cell.indicators}
            onRemoveIndicator={(id) => onIndicators(toggledIndicator(cell.indicators, id))}
          />
        )}
      </div>
      {trade && (
        <TradeStrip
          market={market}
          price={summary ? Number(summary.markPrice) : undefined}
          onOrder={trade.onOrder}
          reason={trade.reason}
        />
      )}
    </section>
  );
}

interface MultiChartPageProps {
  /** The venue on screen: what new charts start on, and whose account this is. */
  venue: VenueId;
  /** The venues in the terminal; a chart can be on any of them. */
  venues: readonly { id: VenueId; label: string }[];
  /** The connected account: its positions and orders are drawn on their charts. */
  account?: AccountSnapshot;
  /** Opens a market on the Trade page. */
  onTrade: (venue: VenueId, marketId: string) => void;
  /** Sets a position's TP / SL on the venue on screen; unset where it can't trade. */
  onProtect?: (position: Position, protection: PositionProtection) => Promise<void>;
  /** A market order of `size` coins on the venue on screen; unset where it can't trade. */
  onOrder?: (market: Market, side: "buy" | "sell", size: number) => Promise<void>;
  /** Why orders can't be placed on the venue on screen. */
  tradeUnavailable?: string;
}

/**
 * Several charts at once, in a grid or one large with two beside it.
 * Each is its own: its venue, market, timeframe, chart style and
 * indicators change nothing on the others, and each loads its own candles.
 * So one page can hold a market on two venues side by side. Charts swap
 * places by dragging, a set of them can be saved under a name, and the
 * interval, the market or the crosshair can be made to move together.
 */
export function MultiChartPage({
  venue,
  venues,
  account,
  onTrade,
  onProtect,
  onOrder,
  tradeUnavailable,
}: MultiChartPageProps) {
  const [state, setState] = useState<MultiChartState>(loadMultiChart);
  const [sets, setSets] = useState(loadSets);
  const update = (next: MultiChartState) => {
    setState(next);
    saveMultiChart(next);
  };

  // Every venue in the terminal: its markets for the pickers, its prices for
  // the headers. Three fixed calls; a venue that isn't in the terminal is idle.
  const has = (id: VenueId) => id === venue || venues.some((v) => v.id === id);
  const data: Record<VenueId, ReturnType<typeof useVenueData>> = {
    bybit: useVenueData("bybit", has("bybit")),
    hyperliquid: useVenueData("hyperliquid", has("hyperliquid")),
    aster: useVenueData("aster", has("aster")),
  };
  const bybit = data.bybit.markets;
  const hyperliquid = data.hyperliquid.markets;
  const aster = data.aster.markets;
  // As each venue's markets arrive: its charts are checked against them, and
  // the venue on screen fills in any charts still missing.
  useEffect(() => {
    setState((now) => {
      let next = now;
      const lists = { bybit, hyperliquid, aster };
      // The venue on screen last, so its charts fill what's left.
      const order = (Object.keys(lists) as VenueId[]).sort(
        (a, b) => Number(a === venue) - Number(b === venue),
      );
      for (const id of order) {
        next = repaired(next, id, lists[id] ?? [], VENUES[id].majors, id === venue);
      }
      if (next !== now) saveMultiChart(next);
      return next;
    });
  }, [venue, bybit, hyperliquid, aster]);

  // The chart given the whole page, by its place in the grid.
  const [maximised, setMaximised] = useState<number>();
  // The moment under the pointer, and the chart it's on: marked on the rest.
  const [crosshair, setCrosshair] = useState<{ from: number; time: number }>();
  // Pointer moves come many times a frame; the other charts follow once per frame.
  const pending = useRef<{ from: number; time: number | undefined }>(undefined);
  const frame = useRef(0);
  useEffect(() => () => cancelAnimationFrame(frame.current), []);
  const shareCrosshair = (from: number, time: number | undefined) => {
    pending.current = { from, time };
    cancelAnimationFrame(frame.current);
    frame.current = requestAnimationFrame(() => {
      const next = pending.current;
      if (!next) return;
      const at = next.time;
      setCrosshair((now) =>
        at === undefined
          ? // Leaving a chart clears it only if it's still that chart's.
            now?.from === next.from
            ? undefined
            : now
          : { from: next.from, time: at },
      );
    });
  };
  // The dates on the chart being scrolled, for the others on its timeframe:
  // on another, the same dates are a different number of candles.
  const [range, setRange] = useState<{
    from: number;
    interval: CandleInterval;
    dates: { from: number; to: number };
  }>();
  const pendingRange = useRef<typeof range>(undefined);
  const rangeFrame = useRef(0);
  useEffect(() => () => cancelAnimationFrame(rangeFrame.current), []);
  const shareRange = (next: NonNullable<typeof range>) => {
    pendingRange.current = next;
    cancelAnimationFrame(rangeFrame.current);
    rangeFrame.current = requestAnimationFrame(() => setRange(pendingRange.current));
  };
  // The chart being dragged, and the one it's over.
  const [drag, setDrag] = useState<{ from: number; over?: number }>();
  // Naming a set to save the charts under.
  const [naming, setNaming] = useState<string>();

  const grid = GRID[state.layout];
  const shown = state.cells.slice(0, grid.charts);
  const alone = maximised !== undefined && maximised < shown.length ? maximised : undefined;
  const { cols, rows } = alone === undefined ? grid : { cols: 1, rows: 1 };
  // The markets held, biggest position first.
  const held = [...(account?.positions ?? [])]
    .sort((a, b) => Number(b.size) * Number(b.markPrice) - Number(a.size) * Number(a.markPrice))
    .map((p) => p.market);
  const showing = currentSet(sets, state);
  const keepSets = (next: typeof sets) => {
    setSets(next);
    saveSets(next);
  };
  const saveSet = (e: FormEvent) => {
    e.preventDefault();
    keepSets(withSet(sets, naming ?? "", state));
    setNaming(undefined);
  };

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
              onClick={() => {
                setMaximised(undefined);
                update({ ...state, layout });
              }}
            >
              {layout.replace("x", " × ").replace("+", " + ")}
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
        {/* biome-ignore lint/a11y/useSemanticElements: a chip-style checkbox, like the app's others */}
        <button
          type="button"
          role="checkbox"
          aria-checked={state.syncCrosshair}
          className="mc-chip"
          title={t("multichart.syncCrosshairHint")}
          onClick={() => {
            setCrosshair(undefined);
            update({ ...state, syncCrosshair: !state.syncCrosshair });
          }}
        >
          {t("multichart.crosshair")}
        </button>
        {/* biome-ignore lint/a11y/useSemanticElements: a chip-style checkbox, like the app's others */}
        <button
          type="button"
          role="checkbox"
          aria-checked={state.syncRange}
          className="mc-chip"
          title={t("multichart.syncRangeHint")}
          onClick={() => {
            setRange(undefined);
            update({ ...state, syncRange: !state.syncRange });
          }}
        >
          {t("multichart.range")}
        </button>
        {/* biome-ignore lint/a11y/useSemanticElements: a chip-style checkbox, like the app's others */}
        <button
          type="button"
          role="checkbox"
          aria-checked={state.tradeBar}
          className="mc-chip mc-trade-chip"
          title={t("multichart.tradeBarHint")}
          onClick={() => update({ ...state, tradeBar: !state.tradeBar })}
        >
          {t("multichart.tradeBar")}
        </button>

        <div className="mc-sets">
          {naming === undefined ? (
            <>
              {sets.length > 0 && (
                <Select
                  className="mc-set"
                  label={t("multichart.sets")}
                  // A set that's been changed since is no longer the one showing.
                  value={showing?.name ?? ""}
                  options={[
                    ...(showing ? [] : [{ value: "", label: t("multichart.sets") }]),
                    ...sets.map((s) => ({ value: s.name, label: s.name })),
                  ]}
                  onChange={(name) => {
                    const set = sets.find((s) => s.name === name);
                    if (!set) return;
                    setMaximised(undefined);
                    update(applySet(state, set));
                  }}
                />
              )}
              {showing ? (
                <button
                  type="button"
                  className="pd-icon-button"
                  aria-label={t("multichart.deleteSet", { name: showing.name })}
                  title={t("multichart.deleteSet", { name: showing.name })}
                  onClick={() => keepSets(withoutSet(sets, showing.name))}
                >
                  <LuTrash2 size={15} aria-hidden />
                </button>
              ) : (
                <button
                  type="button"
                  className="pd-icon-button"
                  aria-label={t("multichart.saveSet")}
                  title={t("multichart.saveSet")}
                  disabled={shown.length === 0}
                  onClick={() => setNaming("")}
                >
                  <LuSave size={15} aria-hidden />
                </button>
              )}
            </>
          ) : (
            <form className="mc-set-form" onSubmit={saveSet}>
              <input
                // biome-ignore lint/a11y/noAutofocus: it opens to be typed into
                autoFocus
                value={naming}
                maxLength={SET_NAME_MAX}
                placeholder={t("multichart.setName")}
                aria-label={t("multichart.setName")}
                onChange={(e) => setNaming(e.target.value)}
                onKeyDown={(e) => e.key === "Escape" && setNaming(undefined)}
                onBlur={() => naming.trim() === "" && setNaming(undefined)}
              />
              <button
                type="submit"
                className="pd-icon-button"
                aria-label={t("multichart.saveSet")}
                disabled={naming.trim() === ""}
              >
                <LuCheck size={15} aria-hidden />
              </button>
            </form>
          )}
          <button
            type="button"
            className="mc-chip mc-held"
            disabled={held.length === 0}
            title={t(held.length === 0 ? "multichart.noPositions" : "multichart.positionsHint")}
            onClick={() => update(withPositions(state, venue, held))}
          >
            {t("multichart.positions")}
          </button>
        </div>
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
          data-layout={alone === undefined ? state.layout : undefined}
          style={{
            gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))`,
            gridTemplateRows: `repeat(${rows}, minmax(0, 1fr))`,
          }}
        >
          {shown.map((cell, i) => {
            if (alone !== undefined && alone !== i) return null;
            const list = data[cell.venue].markets ?? [];
            const mine = account?.venue === cell.venue ? account : undefined;
            // Orders and exits go to the venue on screen: its account is the one connected.
            const here = cell.venue === venue;
            const market = list.find((m) => m.id === cell.market);
            return (
              <Cell
                // biome-ignore lint/suspicious/noArrayIndexKey: a chart is its place in the grid
                key={i}
                cell={cell}
                venues={venues}
                markets={list}
                summary={data[cell.venue].summaries?.find((s) => s.market === cell.market)}
                onVenue={(next) => {
                  // The same coin over there, where it's listed.
                  const base = list.find((m) => m.id === cell.market)?.base;
                  const to = sameCoin(base, data[next].markets ?? [], VENUES[next].defaultMarket);
                  update(withMarket(state, i, next, to));
                }}
                onMarket={(id) => update(withMarket(state, i, cell.venue, id))}
                onInterval={(interval) => update(withInterval(state, i, interval))}
                onType={(type) => update(withCell(state, i, { type }))}
                onIndicators={(indicators) => update(withCell(state, i, { indicators }))}
                onSettings={(settings) => update(withCell(state, i, { settings }))}
                onTrade={() => onTrade(cell.venue, cell.market)}
                onPopOut={() => {
                  leavePopout(cell);
                  void appClient.openChartWindow(cell.venue, cell.market, cell.interval);
                }}
                onProtect={here && mine ? onProtect : undefined}
                trade={
                  state.tradeBar
                    ? {
                        onOrder:
                          here && onOrder && market
                            ? (side, size) => onOrder(market, side, size)
                            : undefined,
                        reason: here
                          ? tradeUnavailable
                          : t("multichart.tradeOtherVenue", { venue: VENUES[cell.venue].label }),
                      }
                    : undefined
                }
                markSize={cols * rows > 4 ? 36 : 48}
                position={mine?.positions.find((p) => p.market === cell.market)}
                orders={mine?.openOrders.filter((o) => o.market === cell.market)}
                maximised={alone === i}
                onMaximise={() => setMaximised(alone === i ? undefined : i)}
                onCrosshair={state.syncCrosshair ? (time) => shareCrosshair(i, time) : undefined}
                crosshairTime={
                  state.syncCrosshair && crosshair && crosshair.from !== i
                    ? crosshair.time
                    : undefined
                }
                onRange={
                  state.syncRange
                    ? (dates) => shareRange({ from: i, interval: cell.interval, dates })
                    : undefined
                }
                range={
                  state.syncRange && range && range.from !== i && range.interval === cell.interval
                    ? range.dates
                    : undefined
                }
                onDragStart={() => setDrag({ from: i })}
                onDragEnd={() => setDrag(undefined)}
                onDragOver={() =>
                  setDrag((now) => (now && now.over !== i ? { ...now, over: i } : now))
                }
                onDrop={() => {
                  if (drag) update(swapped(state, drag.from, i));
                  setDrag(undefined);
                }}
                dragging={drag?.from === i ? "from" : drag && drag.over === i ? "over" : undefined}
              />
            );
          })}
        </div>
      )}
    </div>
  );
}
