import type { CandleInterval, Decimal, Fill, Market, Order, Position } from "@pewterdesk/core";
import {
  type Bar,
  type ChartTheme,
  createLinkGroup,
  getIndicator,
  type IndicatorApi,
  type LinkGroup,
  type PriceLine,
  registerIndicator,
  type SeriesMarkers,
} from "openalgo-charts";
import "openalgo-charts/indicators";
import "openalgo-charts/transform";
import {
  type DrawingDocumentStore,
  memoryDrawingStore,
  webStorageDrawingStore,
} from "openalgo-charts/draw";
import {
  applyTokens,
  chartTypeChoices,
  chartTypeLabel,
  createWidget,
  mountIndicatorPicker,
  mountIndicatorSettings,
  stripView,
  unregisterWidgetDialog,
  type Widget,
} from "openalgo-charts/widget";
import {
  type ReactNode,
  useEffect,
  useLayoutEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
} from "react";
import {
  LuCamera,
  LuChartNoAxesCombined,
  LuCheck,
  LuChevronDown,
  LuChevronUp,
  LuEye,
  LuEyeOff,
  LuMaximize2,
  LuMinimize2,
  LuSettings,
  LuSettings2,
  LuX,
} from "react-icons/lu";
import { type MessageKey, t as tr } from "../../i18n";
import { INTERVAL_MS } from "../../lib/chart";
import { decimalsOf, formatCompact, formatNumber, formatSigned } from "../../lib/format";
import { ALL_INTERVALS, type ChartType } from "../../lib/indicators";
import {
  asInterval,
  type BarSource,
  barFeed,
  keptLayout,
  levelLine,
  levelLineId,
  marketOfSymbol,
} from "../../lib/openAlgoChart";
import { toastError } from "../../lib/toasts";
import { type ChartLevel, type ExitKind, fillMarks, tradeLevels } from "../../lib/tradeMarks";
import { levelLabel } from "./CandleChart";
import { IntervalPicker, TypeIcon, usePopover } from "./ChartToolbar";
import { type Tokens, tokens, withAlpha } from "./chartTheme";
import { TokenIcon } from "./TokenIcon";

// The price chart: OpenAlgo Charts' engine, drawing rail, indicators and
// dialogs over the app's own candles, under the app's own toolbar and
// readout. The library draws and keeps the trader's layout; it is given no
// way to trade. Dragging a TP or SL line only tells the caller, which sets
// it as the TP / SL editor would.

/** The layout, drawings and indicators are kept under this name, on this machine. */
const STORAGE_NAME = "pewterdesk";
/** Set once the first chart has been given its volume pane, so removing it sticks. */
const SEEDED_KEY = "pd.chart.volumeSeeded";
/** The library's own colour for volume bars, before they follow the candles. */
const STOCK_VOLUME_COLOR = "#3a4666";
/** How solid volume bars are next to the candles they take their colours from. */
const VOLUME_ALPHA = 0.35;
/** The hidden scale volume is drawn on, under the candles. */
const VOLUME_SCALE = "";
/** Volume takes the bottom of the price pane, this much of its height. */
const VOLUME_SHARE = 0.2;

// Volume as TradingView draws it: see-through bars along the bottom of the
// price pane, on a scale of their own, rather than a pane that takes height
// from the candles. Later registrations of an id replace the library's own.
{
  const stock = getIndicator("volume");
  registerIndicator({
    ...stock,
    placement: "onchart",
    inputs: stock.inputs.map((input) =>
      input.key === "colorByDirection" && input.type === "boolean"
        ? { ...input, default: true }
        : input,
    ),
    plots: stock.plots.map((plot) => ({ ...plot, priceScaleId: VOLUME_SCALE })),
  });
}
/** A reading this large is shown compact (1.2K), as volume is. */
const COMPACT_FROM = 100_000;
/** A changed layout is handed to the caller this long after the last change. */
const LAYOUT_SAVE_MS = 300;
/** How long a moved TP or SL waits for the account to show it before letting go. */
const SETTLE_MS = 10_000;

/** How long a chart may take to draw its first candles before the loading mark shows. */
const LOADING_DELAY_MS = 120;
/** Bars kept clear right of the latest one when a chart opens on it. */
const LATEST_MARGIN_BARS = 4;
/** Where every chart keeps its drawings, one entry per market. */
const DRAWINGS_PREFIX = "pd.drawings:";
/** Where the Trade chart kept them before every chart shared them. */
const OLD_DRAWINGS_PREFIX = `oac-widget:${STORAGE_NAME}:drawings:`;

type DrawingsListener = (key: string, document: unknown) => void;
const drawingsListeners = new Set<DrawingsListener>();
let sharedStore: DrawingDocumentStore | undefined;

/**
 * One store for every chart's drawings, by market: a line drawn on BTC on
 * the Trade page is on every BTC chart. A chart that changes a market's
 * drawings tells the others showing that market, so none of them keeps (and
 * later saves back) an older copy.
 */
function drawingStore(): DrawingDocumentStore {
  if (sharedStore) return sharedStore;
  const store = storage();
  if (!store) {
    sharedStore = memoryDrawingStore();
    return sharedStore;
  }
  const backing = webStorageDrawingStore(store, DRAWINGS_PREFIX);
  const text = new Map<string, string>();
  sharedStore = {
    get(key) {
      const found = backing.get(key);
      if (found !== null && found !== undefined) return found;
      // Drawn before the store was shared: still there, under the old name.
      try {
        const old = store.getItem(OLD_DRAWINGS_PREFIX + key);
        return old ? JSON.parse(old) : null;
      } catch {
        return null;
      }
    },
    set(key, document) {
      const next = JSON.stringify(document);
      if (text.get(key) === next) return true;
      text.set(key, next);
      const landed = backing.set(key, document);
      for (const listener of drawingsListeners) listener(key, document);
      return landed;
    },
    remove(key) {
      text.delete(key);
      backing.remove(key);
    },
  };
  return sharedStore;
}

/** Charts whose crosshair and dates can move together (the Multi-chart page's). */
export type ChartLink = LinkGroup;
export const createChartLink = (): ChartLink =>
  createLinkGroup({ crosshair: false, viewport: false });

// The chart has no alerts of its own here: the app's alerts are the alerts.
// Its dialogs are taken out; the stylesheet hides its menu rows for them.
unregisterWidgetDialog("alerts");
unregisterWidgetDialog("alertEditor");

/** The brand's tokens as the library's palette; its dialogs derive from it. */
function chartTheme(t: Tokens): ChartTheme {
  return {
    background: t.bg,
    grid: t.grid,
    axisText: t.text,
    axisLine: t.border,
    paneSeparator: t.border,
    crosshair: t.crosshair,
    crosshairLabelBackground: t.border,
    axisFontSize: 11,
    upColor: t.up,
    downColor: t.down,
    wickUpColor: t.up,
    wickDownColor: t.down,
    // Also the chrome's accent (active tool, focus ring): the brand's one accent.
    lineColor: t.brass,
    areaTopColor: withAlpha(t.brass, 0.28),
    areaBottomColor: withAlpha(t.brass, 0),
    baselineTopLine: t.up,
    baselineTopFill: withAlpha(t.up, 0.2),
    baselineBottomLine: t.down,
    baselineBottomFill: withAlpha(t.down, 0.2),
    lastPriceUp: t.up,
    lastPriceDown: t.down,
    lastPriceText: t.bg,
    buy: t.buy,
    sell: t.sell,
    profit: t.buy,
    loss: t.sell,
  };
}

/** The chrome's own type, set again after each theme: the app's fonts. */
const BRAND_FONTS = {
  "--oac-font": "var(--pd-font-sans)",
  "--oac-mono": "var(--pd-font-mono)",
};

/**
 * Volume studies on the price pane, under the candles: one kept from before
 * (in a pane of its own) is moved there with its settings.
 */
function volumeOnPrice(widget: Widget) {
  const { chart } = widget;
  const price = chart.primaryPaneIndex();
  widget.history.ignore(() => {
    for (const study of chart.indicators()) {
      if (study.indicatorId !== "volume" || study.paneIndex === price) continue;
      const { id } = study;
      const settings = study.settings();
      study.remove();
      chart.addIndicator("volume", settings, {
        paneIndex: price,
        priceScaleId: VOLUME_SCALE,
        instanceId: id,
      });
    }
  });
  if (chart.indicators().some((study) => study.indicatorId === "volume")) {
    chart
      .panes()
      [price]?.scaleFor(VOLUME_SCALE)
      .setOptions({ marginTop: 1 - VOLUME_SHARE, marginBottom: 0 });
  }
}

/**
 * Volume bars take the theme's candle colours, as the candles do: a volume
 * study still on the library's stock look, or already following the candles.
 */
function styleVolume(widget: Widget, t: Tokens) {
  const colors = {
    colorByDirection: true,
    upColor: withAlpha(t.up, VOLUME_ALPHA),
    downColor: withAlpha(t.down, VOLUME_ALPHA),
  };
  widget.history.ignore(() => {
    for (const study of widget.chart.indicators()) {
      if (study.indicatorId !== "volume") continue;
      const now = study.settings();
      const stock = now.colorByDirection !== true && now.color === STOCK_VOLUME_COLOR;
      if (!stock && now.colorByDirection !== true) continue;
      if (now.upColor !== colors.upColor || now.downColor !== colors.downColor || stock) {
        study.setSettings(colors);
      }
    }
  });
}

/** How many bars the chart shows across, if it has any to show. */
function barsOnScreen(widget: Widget): number | undefined {
  if (widget.series.getData().length === 0) return undefined;
  const { from, to } = widget.chart.getVisibleLogicalRange();
  return to > from ? to - from : undefined;
}

function storage(): Storage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

/** The library's chart types that have one of the app's own names and glyphs. */
const OWN_TYPE: Record<string, ChartType> = {
  candlestick: "candles",
  "hollow-candle": "hollow",
  bar: "bars",
  line: "line",
  area: "area",
  baseline: "baseline",
  "heikin-ashi": "heikinAshi",
};
const typeName = (id: string) => {
  const own = OWN_TYPE[id];
  return own ? tr(`chart.type.${own}` as MessageKey) : chartTypeLabel(id);
};

type ShotResult = "copied" | "saved" | "failed";

/**
 * The bar above the chart, after the standard chart's: intervals, the chart
 * style, indicators, and the chart's settings and a snapshot on the right.
 */
function Toolbar({
  widget,
  interval,
  onInterval,
  favoriteIntervals,
  onToggleFavoriteInterval,
  onScreenshot,
  compact,
  tools,
}: {
  widget: Widget | null;
  interval: CandleInterval;
  onInterval: (interval: CandleInterval) => void;
  favoriteIntervals?: readonly CandleInterval[];
  onToggleFavoriteInterval?: (interval: CandleInterval) => void;
  onScreenshot?: (shot: HTMLCanvasElement | undefined) => Promise<ShotResult>;
  compact?: boolean;
  tools?: ReactNode;
}) {
  const typeRef = useRef<HTMLButtonElement>(null);
  const indicatorRef = useRef<HTMLButtonElement>(null);
  const typeMenu = usePopover(typeRef);
  const [shot, setShot] = useState<ShotResult>();
  useEffect(() => {
    if (!shot) return;
    const id = setTimeout(() => setShot(undefined), 2000);
    return () => clearTimeout(id);
  }, [shot]);

  const type = widget?.chartType() ?? "candlestick";
  const count = widget?.chart.indicators().length ?? 0;
  const openIndicators = () => {
    if (widget) mountIndicatorPicker(widget.context, indicatorRef.current ?? undefined);
  };

  return (
    <div
      className="pd-chart-toolbar"
      role="toolbar"
      aria-label={tr("chart.toolbar")}
      data-compact={compact || undefined}
    >
      <IntervalPicker
        interval={interval}
        onInterval={onInterval}
        favoriteIntervals={favoriteIntervals}
        onToggleFavoriteInterval={onToggleFavoriteInterval}
      />

      <span className="pd-chart-divider" aria-hidden />

      <button
        ref={typeRef}
        type="button"
        className="pd-chart-tool pd-chart-indicators"
        aria-label={tr("chart.type")}
        title={typeName(type)}
        aria-haspopup="dialog"
        aria-expanded={typeMenu.open}
        onClick={() => typeMenu.setOpen(!typeMenu.open)}
      >
        <TypeIcon type={OWN_TYPE[type] ?? "line"} />
        <LuChevronDown size={14} aria-hidden />
      </button>
      {typeMenu.render(
        tr("chart.type"),
        chartTypeChoices().map((id) => (
          <div key={id} className="pd-chart-menu-row" aria-current={id === type || undefined}>
            <button
              type="button"
              className="pd-chart-menu-pick"
              onClick={() => {
                widget?.setChartType(id);
                typeMenu.close();
              }}
            >
              <TypeIcon type={OWN_TYPE[id] ?? "line"} />
              {typeName(id)}
            </button>
          </div>
        )),
        "pd-chart-menu-types",
      )}

      <span className="pd-chart-divider" aria-hidden />

      <button
        ref={indicatorRef}
        type="button"
        className="pd-chart-tool pd-chart-indicators"
        aria-haspopup="dialog"
        onClick={openIndicators}
      >
        <LuChartNoAxesCombined size={17} aria-hidden />
        {compact ? (
          <span className="pd-visually-hidden">{tr("chart.indicators")}</span>
        ) : (
          tr("chart.indicators")
        )}
        {count > 0 && <span className="pd-chart-count">{count}</span>}
      </button>

      <div className="pd-chart-spacer" />

      <button
        type="button"
        className="pd-chart-tool pd-chart-icon"
        aria-label={tr("chart.settings")}
        title={tr("chart.settings")}
        onClick={() => widget?.openSettings()}
      >
        <LuSettings2 size={17} aria-hidden />
      </button>
      {onScreenshot && (
        <button
          type="button"
          className="pd-chart-tool pd-chart-icon"
          aria-label={tr("chart.screenshot")}
          title={shot ? tr(`chart.shot.${shot}`) : tr("chart.screenshot")}
          data-state={shot}
          onClick={() => void onScreenshot(widget?.chart.takeScreenshot()).then(setShot)}
        >
          {shot && shot !== "failed" ? (
            <LuCheck size={17} aria-hidden />
          ) : (
            <LuCamera size={17} aria-hidden />
          )}
        </button>
      )}
      <span className="pd-visually-hidden" role="status">
        {shot ? tr(`chart.shot.${shot}`) : ""}
      </span>
      {tools}
    </div>
  );
}

/** A study's readings at bar `index` (the latest without one), one per plot it draws. */
function readings(study: IndicatorApi, index: number | undefined, decimals: number) {
  const out: string[] = [];
  for (const [key, series] of Object.entries(study.values())) {
    if (!study.series(key)) continue;
    const value = series[index ?? series.length - 1];
    if (value === null || value === undefined || !Number.isFinite(value)) continue;
    out.push(
      Math.abs(value) >= COMPACT_FROM || study.indicatorId === "volume"
        ? formatCompact(value)
        : formatNumber(value, study.paneIndex === 0 ? decimals : 2),
    );
  }
  return out.join("  ");
}

/**
 * The top-left readout, as on the standard chart: the market, then the
 * candle under the crosshair (or the latest), then each study with its
 * readings and, on hover, its show / hide, settings and remove buttons.
 */
function Legend({
  widget,
  title,
  market,
  bar,
  index,
  decimals,
  problem,
  onChange,
}: {
  widget: Widget;
  title?: string;
  market: Market;
  bar?: Bar;
  index?: number;
  decimals: number;
  problem?: string;
  onChange: () => void;
}) {
  const change = bar ? bar.close - bar.open : 0;
  const pct = bar?.open ? (change / bar.open) * 100 : 0;
  const price = (v: number) => formatNumber(v, decimals);
  const item = (label: string, value: string, className = "pd-ohlc-item", hideLabel = false) => (
    <div className={className}>
      <dt className={hideLabel ? "pd-visually-hidden" : "pd-ohlc-label"}>{label}</dt>
      <dd>{value}</dd>
    </div>
  );
  const studies = widget.chart.indicators();
  const pricePane = widget.chart.primaryPaneIndex();
  // Kept with the chart's own layout, as TradingView keeps its legend folded.
  const folded = widget.chart.indicatorLegendCollapsed();
  const fold = (on: boolean) => {
    widget.chart.setIndicatorLegendCollapsed(on);
    onChange();
  };
  const settings = (study: IndicatorApi, anchor: HTMLElement) =>
    mountIndicatorSettings(widget.context, anchor, {
      instanceId: study.id,
      onClose: onChange,
    });
  return (
    <div className="pd-ohlc pd-oachart-legend">
      {title && (
        <p className="pd-ohlc-title">
          <TokenIcon market={market} size={18} />
          <span className="pd-ohlc-name">{title}</span>
        </p>
      )}
      {bar && (
        <dl className="pd-ohlc-values" data-trend={change >= 0 ? "up" : "down"}>
          {item(tr("chart.open"), price(bar.open))}
          {item(tr("chart.high"), price(bar.high))}
          {item(tr("chart.low"), price(bar.low))}
          {item(tr("chart.close"), price(bar.close))}
          {item(
            tr("chart.change"),
            `${formatSigned(change, decimals)} (${formatSigned(pct)}%)`,
            "pd-ohlc-item",
            true,
          )}
          {bar.volume !== undefined &&
            item(tr("chart.volume"), formatCompact(bar.volume), "pd-ohlc-item pd-ohlc-volume")}
        </dl>
      )}
      {problem && (
        <p className="pd-oachart-problem" role="status">
          {problem}
        </p>
      )}
      {studies.length > 0 && folded && (
        <button
          type="button"
          className="pd-oachart-fold"
          aria-expanded={false}
          onClick={() => fold(false)}
        >
          <LuChevronUp size={13} aria-hidden style={{ transform: "rotate(180deg)" }} />
          {tr("chart.studies", { count: studies.length })}
        </button>
      )}
      <ul className="pd-ohlc-indicators pd-oachart-studies" hidden={folded}>
        {studies.map((study) => {
          const row = study.legend()?.options();
          const name = row?.title ?? study.name;
          const shown = study.visible();
          // A study in a pane of its own can fold that pane to a strip.
          const pane = study.paneIndex === pricePane ? undefined : study.paneIndex;
          const small = pane !== undefined && widget.chart.paneCollapsed(pane);
          return (
            <li key={study.id}>
              <button
                type="button"
                className="pd-oachart-study"
                data-hidden={!shown || undefined}
                title={tr("indicator.settings", { name })}
                onDoubleClick={(e) => settings(study, e.currentTarget)}
              >
                <span className="pd-ohlc-indicator-name">{name}</span>
                {row?.params && <span className="pd-oachart-params">{row.params}</span>}
              </button>
              <span
                className="pd-ohlc-indicator-values"
                // Volume's bars follow the candles; its reading stays neutral.
                style={{ color: study.indicatorId === "volume" ? undefined : row?.color }}
              >
                {shown ? readings(study, index, decimals) : ""}
              </span>
              <button
                type="button"
                className="pd-ohlc-remove"
                aria-label={tr(shown ? "indicator.hide" : "indicator.show", { name })}
                title={tr(shown ? "indicator.hide" : "indicator.show", { name })}
                aria-pressed={!shown}
                onClick={() => {
                  study.setVisible(!shown);
                  // A pane with nothing left showing folds away, giving the
                  // candles its room; showing a study opens it again.
                  if (pane !== undefined) {
                    const open = studies.some((s) => s.paneIndex === pane && s.visible());
                    widget.chart.setPaneCollapsed(pane, !open);
                  }
                  onChange();
                }}
              >
                {shown ? <LuEye size={13} aria-hidden /> : <LuEyeOff size={13} aria-hidden />}
              </button>
              {pane !== undefined && (
                <button
                  type="button"
                  className="pd-ohlc-remove"
                  aria-label={tr(small ? "indicator.restorePane" : "indicator.minimizePane", {
                    name,
                  })}
                  title={tr(small ? "indicator.restorePane" : "indicator.minimizePane", { name })}
                  aria-pressed={small}
                  onClick={() => {
                    widget.chart.setPaneCollapsed(pane, !small);
                    onChange();
                  }}
                >
                  {small ? (
                    <LuMaximize2 size={12} aria-hidden />
                  ) : (
                    <LuMinimize2 size={12} aria-hidden />
                  )}
                </button>
              )}
              <button
                type="button"
                className="pd-ohlc-remove"
                aria-label={tr("indicator.settings", { name })}
                title={tr("indicator.settings", { name })}
                onClick={(e) => settings(study, e.currentTarget)}
              >
                <LuSettings size={13} aria-hidden />
              </button>
              <button
                type="button"
                className="pd-ohlc-remove"
                aria-label={tr("indicator.remove", { name })}
                title={tr("indicator.remove", { name })}
                onClick={() => {
                  study.remove();
                  onChange();
                }}
              >
                <LuX size={13} aria-hidden />
              </button>
            </li>
          );
        })}
      </ul>
      {studies.length > 0 && !folded && (
        <button
          type="button"
          className="pd-ohlc-remove pd-oachart-fold-all"
          aria-label={tr("chart.studiesHide")}
          title={tr("chart.studiesHide")}
          aria-expanded
          onClick={() => fold(true)}
        >
          <LuChevronUp size={13} aria-hidden />
        </button>
      )}
    </div>
  );
}

interface OpenAlgoChartProps {
  source: BarSource;
  /** The venue's id: it names the chart's exchange, and whose drawings a market keeps. */
  venue: string;
  markets: readonly Market[];
  /** The market on screen. */
  market: Market;
  /** What the readout calls the chart, e.g. "BTC-USDT · 1d · Bybit"; none without it. */
  title?: string;
  interval: CandleInterval;
  onInterval: (interval: CandleInterval) => void;
  /** Intervals with a button of their own on the toolbar. */
  favoriteIntervals?: readonly CandleInterval[];
  onToggleFavoriteInterval?: (interval: CandleInterval) => void;
  /** Takes the chart's picture; resolves to what happened to it. No button without it. */
  onScreenshot?: (shot: HTMLCanvasElement | undefined) => Promise<ShotResult>;
  /** The account's position and open orders in this market, drawn as lines. */
  position?: Position;
  orders?: readonly Order[];
  /** The account's fills in this market, marked on the candles they fell in. */
  fills?: readonly Fill[];
  /**
   * Sets the position's TP or SL; with it, the lines of those kept on the
   * position can be dragged. Resolves to the price set (on the tick), or
   * undefined if nothing changed; rejects with the message to show.
   */
  onMoveExit?: (kind: ExitKind, price: number) => Promise<Decimal | undefined>;
  /**
   * For a small chart (one of several): a shorter toolbar, its intervals in
   * the menu.
   */
  compact?: boolean;
  /**
   * The chart's look (style, indicators, settings) as `onLayout` last gave
   * it. With `onLayout` the caller keeps it, per chart; without, it is kept
   * in this machine's browser storage. Drawings are kept by market either
   * way, shared by every chart.
   */
  layout?: string;
  onLayout?: (layout: string) => void;
  /** The charts this one shares its crosshair and dates with. */
  link?: ChartLink;
  /** More buttons at the end of the toolbar. */
  tools?: ReactNode;
  /** Shown over the chart until its first candles arrive. */
  loading?: ReactNode;
}

const NO_ORDERS: readonly Order[] = [];

export function OpenAlgoChart({
  source,
  venue,
  markets,
  market,
  title,
  interval,
  onInterval,
  favoriteIntervals,
  onToggleFavoriteInterval,
  onScreenshot,
  position,
  orders = NO_ORDERS,
  fills,
  onMoveExit,
  compact = false,
  layout,
  onLayout,
  link,
  tools,
  loading,
}: OpenAlgoChartProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const [widget, setWidget] = useState<Widget | null>(null);
  // The studies, chart style and their settings live in the widget: this
  // redraws the toolbar and readout when they change.
  const [, redraw] = useReducer((n: number) => n + 1, 0);
  const [themed, restyled] = useReducer((n: number) => n + 1, 0);
  // Counts the times the candles loaded changed (not each live tick).
  const [loaded, reloaded] = useReducer((n: number) => n + 1, 0);
  const [settled, settle] = useReducer((n: number) => n + 1, 0);
  const [hover, setHover] = useState<{ bar: Bar; index?: number }>();
  const [latest, setLatest] = useState<Bar>();
  const [problem, setProblem] = useState<string>();
  // The loading mark waits a moment: a chart drawn from candles already held
  // shows them before it would have appeared.
  const [slow, setSlow] = useState(false);
  // Read by the widget's callbacks, which outlive a render.
  const latestProps = useRef({ markets, interval, onInterval, onMoveExit, onLayout });
  latestProps.current = { markets, interval, onInterval, onMoveExit, onLayout };
  const firstMarket = useRef(market.id);
  /** The layout as last given to, or taken from, the caller. */
  const keptRef = useRef<string | undefined>(undefined);
  /** The trade levels' lines, by line id. */
  const lines = useRef(new Map<string, { line: PriceLine; level: ChartLevel; look: string }>());
  /** A TP or SL being dragged, or moved and awaiting the account. */
  const held = useRef<{ id: string; price?: number }>(undefined);
  /**
   * How many bars were on screen when the timeframe or market changed: the
   * new one opens at that zoom, not the chart's default, until the trader
   * zooms or scrolls it themselves.
   */
  const zoom = useRef<number>(undefined);
  const kept = onLayout !== undefined;

  // Create once per venue; restyle whenever the theme or market colors change.
  useLayoutEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const store = kept ? null : storage();
    let theme = chartTheme(tokens(host));
    const made = createWidget(host, {
      feed: barFeed(source, () => latestProps.current.markets),
      symbol: firstMarket.current,
      exchange: venue,
      interval: latestProps.current.interval,
      intervals: ALL_INTERVALS,
      theme,
      // The app's own bar and readout stand in for the library's.
      topbar: false,
      statusline: false,
      panels: false,
      // The readout lists the studies; above the plot, the library's own
      // list (and its "Indicators" fold) isn't drawn.
      legendOffset: { top: -1 },
      // Drawings are kept with the chart's own storage: a chart whose look
      // the caller keeps has nowhere to keep them, so it has no drawing rail.
      persist: kept ? false : STORAGE_NAME,
      storage: store,
      drawingStore: drawingStore(),
      // Numbers stay en-US in every language.
      locale: "en-US",
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      axisChrome: { barCountdown: true },
      branding: false,
      // Bare letters stay the app's own hotkeys, not the chart's symbol entry.
      typingNavigation: false,
      loading: { refreshOnGap: true },
    });
    setWidget(made);
    setSlow(false);
    const loadingLate = setTimeout(() => setSlow(true), LOADING_DELAY_MS);

    applyTokens(made.root, BRAND_FONTS);

    const { chart } = made;
    let saving: ReturnType<typeof setTimeout> | undefined;
    /** Hands the caller the layout, once it has stopped changing. */
    const layoutChanged = () => {
      if (!latestProps.current.onLayout) return;
      clearTimeout(saving);
      saving = setTimeout(() => {
        if (made.isDestroyed) return;
        const now = made.getState();
        // Drawings are kept by market, not with the look.
        const { drawings: _, ...look } = stripView(now.chart) as unknown as Record<string, unknown>;
        const next = JSON.stringify({ chartType: now.chartType, chart: look });
        if (next === keptRef.current) return;
        keptRef.current = next;
        latestProps.current.onLayout?.(next);
      }, LAYOUT_SAVE_MS);
    };
    /** The readout draws each study's row, so the chart's own are put away. */
    const studiesChanged = () => {
      // A study just added takes the theme's colours at once.
      volumeOnPrice(made);
      styleVolume(made, tokens(host));
      for (const study of chart.indicators()) study.legend()?.setOptions({ visible: false });
      redraw();
      layoutChanged();
    };
    const lineOf = (id: string) => lines.current.get(id);
    const letGo = (id: string) => {
      if (held.current?.id !== id) return;
      held.current = undefined;
      settle();
    };
    // The chart opens on the latest candle, and again on each new market or
    // interval, until the trader moves it themselves.
    let pinned = true;
    let shownCount = 0;
    const unpin = () => {
      pinned = false;
      zoom.current = undefined;
    };
    const repin = () => {
      pinned = true;
    };
    const toLatest = () => {
      const count = made.series.getData().length;
      if (!pinned || count === 0) return;
      const { from, to } = chart.getVisibleLogicalRange();
      const span = zoom.current ?? Math.max(10, to - from);
      const end = count - 1 + LATEST_MARGIN_BARS;
      chart.setVisibleLogicalRange({ from: end - span, to: end });
    };
    /** The candles changed: the readout follows, and a pinned view keeps the newest in sight. */
    const candlesChanged = () => {
      if (made.isDestroyed) return;
      const bars = made.series.getData();
      setLatest(bars.at(-1));
      if (bars.length === shownCount) return;
      shownCount = bars.length;
      reloaded();
      toLatest();
      // The chart puts back its own view once it has taken new candles in;
      // the newest are brought into sight again after that.
      requestAnimationFrame(() => requestAnimationFrame(toLatest));
    };
    host.addEventListener("pointerdown", unpin, true);
    host.addEventListener("wheel", unpin, { capture: true, passive: true });
    // Another chart changed the drawings of the market this one shows.
    const otherDrawings: DrawingsListener = (key, document) => {
      const drawings = made.instrumentDrawings;
      if (!drawings || drawings.key() !== key) return;
      const instrument = { symbol: made.symbol(), exchange: made.exchange() };
      if (JSON.stringify(drawings.document(instrument)) === JSON.stringify(document)) return;
      drawings.setDocument(instrument, document);
    };
    drawingsListeners.add(otherDrawings);
    const offs = [
      made.on("symbol", repin),
      made.on("interval", repin),
      made.on("theme", ({ chartTheme: shown }) => {
        // Only the app's theme: never the library's stock light or dark.
        if (shown !== theme) made.setTheme(theme);
        else applyTokens(made.root, BRAND_FONTS);
      }),
      made.on("interval", ({ interval: code }) => {
        const picked = asInterval(code);
        if (picked && picked !== latestProps.current.interval) {
          latestProps.current.onInterval(picked);
        }
      }),
      made.on("layout", () => {
        redraw();
        layoutChanged();
      }),
      made.on("status", ({ text, kind }) => setProblem(kind === "error" ? text : undefined)),
      chart.on("objects:change", studiesChanged),
      chart.on("indicatorSettings", studiesChanged),
      chart.on("indicatorRemoved", studiesChanged),
      chart.on("paneCollapsed", redraw),
      chart.on("state:restore:end", studiesChanged),
      chart.on("layout:change", layoutChanged),
      chart.on("crosshair:move", (e) =>
        setHover(e.bar ? { bar: e.bar, index: e.index ?? undefined } : undefined),
      ),
      chart.on("data:update", candlesChanged),
      chart.on("data:range", candlesChanged),
      // The venue's history replacing the cached candles comes this way.
      made.dataController?.subscribe(() => requestAnimationFrame(candlesChanged)) ?? (() => {}),
      // A TP or SL line follows the pointer, and is set where it's let go.
      // (Registering here is also what lets the chart grab such a line.)
      chart.subscribeDrag(
        (id, price) => {
          const hit = lineOf(id);
          if (!hit?.level.movable || !latestProps.current.onMoveExit) return;
          held.current = { id };
          hit.line.setPrice(price);
        },
        (id, price) => {
          const hit = lineOf(id);
          const move = latestProps.current.onMoveExit;
          if (!hit || held.current?.id !== id) return;
          const { kind } = hit.level;
          if (!move || (kind !== "takeProfit" && kind !== "stopLoss")) return letGo(id);
          move(kind, price).then(
            (set) => {
              if (set === undefined) return letGo(id);
              // Where it was set, until the account shows it there.
              held.current = { id, price: Number(set) };
              if (!made.isDestroyed) hit.line.setPrice(Number(set));
              setTimeout(() => letGo(id), SETTLE_MS);
            },
            (err: unknown) => {
              letGo(id);
              toastError(tr("toast.exitNotMoved"), err);
            },
          );
        },
      ),
      chart.on("drag:cancel", () => held.current && letGo(held.current.id)),
    ];

    void made.ready.then(() => {
      if (made.isDestroyed) return;
      // A first chart opens with volume under the price, as a trader expects.
      if (store && !store.getItem(SEEDED_KEY)) {
        if (chart.indicators().length === 0) chart.addIndicator("volume");
        store.setItem(SEEDED_KEY, "1");
      }
      styleVolume(made, tokens(host));
      studiesChanged();
    });

    const observer = new MutationObserver(() => {
      const t = tokens(host);
      theme = chartTheme(t);
      made.setTheme(theme);
      styleVolume(made, t);
      restyled();
    });
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["data-theme", "data-market"],
    });
    const drawn = lines.current;
    return () => {
      observer.disconnect();
      clearTimeout(saving);
      clearTimeout(loadingLate);
      host.removeEventListener("pointerdown", unpin, true);
      host.removeEventListener("wheel", unpin, true);
      drawingsListeners.delete(otherDrawings);
      for (const off of offs) off();
      drawn.clear();
      held.current = undefined;
      keptRef.current = undefined;
      setWidget(null);
      setHover(undefined);
      setLatest(undefined);
      made.destroy();
    };
  }, [source, venue, kept]);

  // Follow the market and interval chosen elsewhere in the app.
  const marketId = market.id;
  const tick = Number(market.tickSize);
  useEffect(() => {
    if (!widget) return;
    if (marketOfSymbol(latestProps.current.markets, widget.symbol())?.id !== marketId) {
      zoom.current = barsOnScreen(widget) ?? zoom.current;
      widget.setSymbol(marketId, venue);
    }
    if (tick > 0) widget.chart.applyOptions({ priceScale: { minMove: tick } });
  }, [widget, marketId, tick, venue]);
  useEffect(() => {
    if (!widget || widget.interval() === interval) return;
    zoom.current = barsOnScreen(widget) ?? zoom.current;
    widget.setInterval(interval);
  }, [widget, interval]);

  // The look the caller keeps for this chart: put on when it isn't the one
  // just handed over (another chart moved into this place, or a saved set).
  useEffect(() => {
    if (!widget || !kept || layout === keptRef.current) return;
    keptRef.current = layout;
    const saved = keptLayout(layout);
    void widget.ready.then(() => {
      if (widget.isDestroyed || keptRef.current !== layout) return;
      const now = widget.getState();
      const { drawings } = now.chart as { drawings?: unknown };
      widget.restoreState(
        saved
          ? {
              ...now,
              chartType: saved.chartType,
              chart: {
                ...(saved.chart as object),
                ...(drawings === undefined ? {} : { drawings }),
              },
            }
          : // A chart with nothing kept starts plain: candles, no studies.
            { ...now, chartType: "candlestick", chart: { ...now.chart, indicators: [] } },
      );
      styleVolume(widget, tokens(widget.root));
    });
  }, [widget, kept, layout]);

  // Its crosshair and dates move with the others'.
  useEffect(() => {
    if (!widget || !link) return;
    const { chart } = widget;
    link.add(chart);
    return () => link.remove(chart);
  }, [widget, link]);

  // The account's trading in this market: its levels as lines, kept in step
  // one by one, so a line being dragged isn't redrawn under the pointer.
  const decimals = decimalsOf(market.tickSize);
  const levels = useMemo(
    () => (position || orders.length ? tradeLevels(position, orders) : []),
    [position, orders],
  );
  const canMove = onMoveExit !== undefined;
  // biome-ignore lint/correctness/useExhaustiveDependencies: `themed` recolours the lines, `settled` lets a moved one go
  useEffect(() => {
    const host = hostRef.current;
    if (!widget || !host || widget.isDestroyed) return;
    const t = tokens(host);
    const colors = { buy: t.buy, sell: t.sell, warning: t.warning, order: t.brass };
    const drawn = lines.current;
    const wanted = new Set<string>();
    for (const level of levels) {
      const id = levelLineId(level);
      wanted.add(id);
      const label = levelLabel(level, decimals);
      const options = levelLine(level, label, colors, canMove && level.movable);
      const look = `${options.color}|${options.lineStyle}|${options.cursor}`;
      const had = drawn.get(id);
      if (had && had.look !== look) widget.chart.removePrimitive(had.line);
      if (!had || had.look !== look) {
        drawn.set(id, { line: widget.chart.addPriceLine(options), level, look });
        continue;
      }
      had.level = level;
      had.line.setLeftLabel(label);
      const mine = held.current?.id === id ? held.current : undefined;
      // The account now shows a moved line where it was set.
      if (mine?.price === level.price) held.current = undefined;
      if (!mine && had.line.price !== level.price) had.line.setPrice(level.price);
    }
    for (const [id, had] of drawn) {
      if (wanted.has(id)) continue;
      widget.chart.removePrimitive(had.line);
      drawn.delete(id);
    }
  }, [widget, levels, decimals, canMove, themed, settled]);

  // The account's fills, as arrows at their prices on the candles loaded.
  const markers = useRef<{ of: Widget; layer: SeriesMarkers }>(undefined);
  // biome-ignore lint/correctness/useExhaustiveDependencies: `loaded` re-places them on the candles now loaded, `themed` recolours them
  useEffect(() => {
    const host = hostRef.current;
    if (!widget || !host || widget.isDestroyed) return;
    if (!fills?.length && markers.current?.of !== widget) return;
    if (markers.current?.of !== widget) {
      markers.current = { of: widget, layer: widget.series.createMarkers() };
    }
    const t = tokens(host);
    const bars = widget.series.getData().map((b) => ({ openTime: b.time * 1000 }));
    markers.current.layer.setMarkers(
      fillMarks(fills ?? [], bars, INTERVAL_MS[interval]).map((m) => ({
        time: Math.floor(m.time / 1000),
        position: "atPrice",
        price: m.price,
        shape: m.side === "buy" ? "arrowUp" : "arrowDown",
        size: "small",
        color: m.side === "buy" ? t.buy : t.sell,
      })),
    );
  }, [widget, fills, interval, loaded, themed]);

  return (
    <div className="pd-oachart">
      <Toolbar
        widget={widget}
        interval={interval}
        onInterval={onInterval}
        favoriteIntervals={favoriteIntervals}
        onToggleFavoriteInterval={onToggleFavoriteInterval}
        onScreenshot={onScreenshot}
        compact={compact}
        tools={tools}
      />
      <div className="pd-oachart-stage">
        <div ref={hostRef} className="pd-oachart-chart" />
        {!latest && slow && loading && <div className="pd-oachart-loading">{loading}</div>}
        {widget && (
          <Legend
            widget={widget}
            title={title}
            market={market}
            bar={hover?.bar ?? latest}
            index={hover?.index}
            decimals={decimals}
            problem={problem}
            onChange={redraw}
          />
        )}
      </div>
    </div>
  );
}
