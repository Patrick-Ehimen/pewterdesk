import type { Candle, Decimal, Fill, Market, Order, Position } from "@pewterdesk/core";
import {
  AreaSeries,
  type AutoscaleInfo,
  BarSeries,
  BaselineSeries,
  CandlestickSeries,
  createChart,
  createSeriesMarkers,
  HistogramSeries,
  type IChartApi,
  type IPriceLine,
  type ISeriesApi,
  LineSeries,
  LineStyle,
  type MouseEventParams,
  type SeriesMarker,
  type SeriesType,
  type Time,
  type UTCTimestamp,
} from "lightweight-charts";
import {
  type PointerEvent,
  type Ref,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from "react";
import { LuX } from "react-icons/lu";
import { type MessageKey, t as tr } from "../../i18n";
import { type DrawnCandle, formatCountdown, joinedCandle, joinedCandles } from "../../lib/chart";
import { formatCompact, formatNumber, formatSigned } from "../../lib/format";
import {
  bollinger,
  type ChartType,
  ema as emaOf,
  heikinAshi,
  type IndicatorId,
  macd,
  PANE_INDICATORS,
  PARAMS,
  rsi,
  type Series,
  sma,
  vwap,
} from "../../lib/indicators";
import { toastError } from "../../lib/toasts";
import {
  type ChartLevel,
  type ExitKind,
  fillMarks,
  pnlAt,
  tradeLevels,
} from "../../lib/tradeMarks";
import { chartOptions, type Tokens, tokens, withAlpha } from "./chartTheme";
import { TokenIcon } from "./TokenIcon";

// Display-only: candles go through JS numbers for drawing.

const toTime = (ms: number) => Math.floor(ms / 1000) as UTCTimestamp;
/** Bars from the oldest candle at which older ones are fetched. */
const LOAD_OLDER_MARGIN = 50;
/** The price pane's share of the height next to each indicator pane. */
const PRICE_PANE_STRETCH = 3;
/** Height of the title strip added above a screenshot. */
const SHOT_TITLE_PX = 32;
/** From the last price's line to the top of the countdown under its label. */
const COUNTDOWN_OFFSET_PX = 10;
/** Closest two trade labels may sit, centre to centre, before the lower one moves down. */
const LEVEL_LABEL_GAP_PX = 20;
/** How far from a movable line, in px, the pointer can grab it. */
const GRAB_PX = 5;
/** How long a moved TP or SL waits for the account to show it before letting go. */
const SETTLE_MS = 10_000;

/** A TP or SL being dragged, being saved, or saved and awaiting the account. */
interface ExitDrag {
  id: string;
  kind: ExitKind;
  /** Where it was before the drag. */
  from: number;
  price: number;
  state: "dragging" | "saving" | "saved";
}

type Any = ISeriesApi<SeriesType>;
type LinePoint = { time: UTCTimestamp; value?: number };

/** Everything drawn on the chart, per the chart type and indicators chosen. */
interface Drawn {
  main?: Any;
  volume?: ISeriesApi<"Histogram">;
  /** One line per indicator value (SMA, BB's three, RSI, MACD's two, ...). */
  lines: Partial<Record<LineKey, ISeriesApi<"Line">>>;
  macdHist?: ISeriesApi<"Histogram">;
}

type LineKey =
  | "sma"
  | "ema"
  | "bbUpper"
  | "bbMiddle"
  | "bbLower"
  | "vwap"
  | "rsi"
  | "macd"
  | "signal";

/** Every value an indicator line shows, per candle. */
type Computed = Record<LineKey, Series> & { histogram: Series };

function compute(candles: readonly Candle[], indicators: ReadonlySet<IndicatorId>): Computed {
  const closes = candles.map((c) => Number(c.close));
  const none: Series = [];
  const bb = indicators.has("bollinger")
    ? bollinger(closes, PARAMS.bollinger.period, PARAMS.bollinger.mult)
    : [];
  const m = indicators.has("macd")
    ? macd(closes, PARAMS.macd.fast, PARAMS.macd.slow, PARAMS.macd.signal)
    : [];
  return {
    sma: indicators.has("sma") ? sma(closes, PARAMS.sma) : none,
    ema: indicators.has("ema") ? emaOf(closes, PARAMS.ema) : none,
    bbUpper: bb.map((b) => b?.upper),
    bbMiddle: bb.map((b) => b?.middle),
    bbLower: bb.map((b) => b?.lower),
    vwap: indicators.has("vwap")
      ? vwap(
          candles.map((c) => ({
            openTime: c.openTime,
            high: Number(c.high),
            low: Number(c.low),
            close: Number(c.close),
            volume: Number(c.volume),
          })),
        )
      : none,
    rsi: indicators.has("rsi") ? rsi(closes, PARAMS.rsi) : none,
    macd: m.map((p) => p.macd),
    signal: m.map((p) => p.signal),
    histogram: m.map((p) => p.histogram),
  };
}

/** The main series' points for `type`, from candles joined as drawn. */
function mainData(type: ChartType, candles: readonly Candle[], drawn: readonly DrawnCandle[]) {
  const shown = type === "heikinAshi" ? heikinAshi(drawn) : drawn;
  if (type === "line" || type === "area" || type === "baseline") {
    return candles.map((c, i) => ({
      time: toTime(c.openTime),
      value: (shown[i] as DrawnCandle).close,
    }));
  }
  return candles.map((c, i) => ({ time: toTime(c.openTime), ...(shown[i] as DrawnCandle) }));
}

/** Colored like its candle as drawn, so a bar's color matches the body above it. */
function volume(c: Candle, drawn: DrawnCandle, t: Tokens) {
  const up = drawn.close >= drawn.open;
  return { time: toTime(c.openTime), value: Number(c.volume), color: up ? t.buyTint : t.sellTint };
}

const linePoint = (c: Candle, value: number | undefined): LinePoint =>
  value === undefined ? { time: toTime(c.openTime) } : { time: toTime(c.openTime), value };

/** Creates the series for a chart type and set of indicators on a fresh chart. */
function build(
  chart: IChartApi,
  type: ChartType,
  indicators: ReadonlySet<IndicatorId>,
  t: Tokens,
): Drawn {
  const up = { upColor: t.buy, downColor: t.sell };
  let main: Any;
  switch (type) {
    case "bars":
      main = chart.addSeries(BarSeries, { ...up, thinBars: false });
      break;
    case "line":
      main = chart.addSeries(LineSeries, { color: t.line, lineWidth: 2 });
      break;
    case "area":
      main = chart.addSeries(AreaSeries, {
        // Neutral, like the line style: blue and brass are the indicators' colors.
        lineColor: t.line,
        topColor: withAlpha(t.line, 0.22),
        bottomColor: withAlpha(t.line, 0.02),
        lineWidth: 2,
      });
      break;
    case "baseline":
      main = chart.addSeries(BaselineSeries, {
        topLineColor: t.buy,
        topFillColor1: withAlpha(t.buy, 0.28),
        topFillColor2: withAlpha(t.buy, 0.04),
        bottomLineColor: t.sell,
        bottomFillColor1: withAlpha(t.sell, 0.04),
        bottomFillColor2: withAlpha(t.sell, 0.28),
        lineWidth: 2,
      });
      break;
    default:
      // Candles, hollow candles (rising bodies unfilled) and Heikin-Ashi.
      main = chart.addSeries(CandlestickSeries, {
        ...up,
        upColor: type === "hollow" ? "rgba(0, 0, 0, 0)" : t.buy,
        borderUpColor: t.buy,
        borderDownColor: t.sell,
        wickUpColor: t.buy,
        wickDownColor: t.sell,
      });
  }
  const drawn: Drawn = { main, lines: {} };
  const hasVolume = indicators.has("volume");
  if (hasVolume) {
    drawn.volume = chart.addSeries(HistogramSeries, {
      priceScaleId: "volume",
      priceLineVisible: false,
      lastValueVisible: false,
    });
    chart.priceScale("volume").applyOptions({ scaleMargins: { top: 0.8, bottom: 0 } });
  }
  // Headroom at the top for the title and readout; room at the bottom for volume.
  chart
    .priceScale("right")
    .applyOptions({ scaleMargins: { top: 0.16, bottom: hasVolume ? 0.24 : 0.06 } });

  const line = (key: LineKey, color: string, pane = 0, width: 1 | 2 = 1) => {
    drawn.lines[key] = chart.addSeries(
      LineSeries,
      {
        color,
        lineWidth: width,
        priceLineVisible: false,
        lastValueVisible: false,
        crosshairMarkerVisible: false,
      },
      pane,
    );
  };
  if (indicators.has("sma")) line("sma", t.brass, 0, 2);
  if (indicators.has("ema")) line("ema", t.info, 0, 2);
  if (indicators.has("bollinger")) {
    line("bbUpper", t.muted);
    line("bbMiddle", t.muted);
    line("bbLower", t.muted);
  }
  if (indicators.has("vwap")) line("vwap", t.warning, 0, 2);

  // Indicators with a scale of their own get a pane each, under the price.
  let pane = 0;
  for (const id of PANE_INDICATORS) {
    if (!indicators.has(id)) continue;
    pane += 1;
    if (id === "rsi") {
      line("rsi", t.brass, pane, 2);
      const r = drawn.lines.rsi;
      r?.applyOptions({
        autoscaleInfoProvider: () => ({ priceRange: { minValue: 0, maxValue: 100 } }),
      });
      for (const price of [70, 30]) {
        r?.createPriceLine({
          price,
          color: t.muted,
          lineStyle: LineStyle.Dashed,
          lineWidth: 1,
          axisLabelVisible: false,
        });
      }
    } else {
      drawn.macdHist = chart.addSeries(
        HistogramSeries,
        { priceLineVisible: false, lastValueVisible: false },
        pane,
      );
      line("macd", t.info, pane, 2);
      line("signal", t.warning, pane, 2);
    }
  }
  chart.panes().forEach((p, i) => {
    p.setStretchFactor(i === 0 ? PRICE_PANE_STRETCH : 1);
  });
  return drawn;
}

/** Removes every series and every indicator pane. */
function clear(chart: IChartApi, drawn: Drawn) {
  const all = [drawn.main, drawn.volume, drawn.macdHist, ...Object.values(drawn.lines)];
  for (const s of all) if (s) chart.removeSeries(s as Any);
  for (let i = chart.panes().length - 1; i > 0; i--) chart.removePane(i);
}

/** Readout rows for the active indicators: label, and the values at `i`. */
function indicatorRows(
  indicators: readonly IndicatorId[],
  v: Computed,
  i: number,
  decimals: number,
) {
  const price = (x: number | undefined) => (x === undefined ? "-" : formatNumber(x, decimals));
  const plain = (x: number | undefined, dp = 2) => (x === undefined ? "-" : formatNumber(x, dp));
  const rows: { id: IndicatorId; label: string; values: string }[] = [];
  for (const id of indicators) {
    switch (id) {
      case "sma":
        rows.push({
          id,
          label: `${tr("indicator.sma.short")} ${PARAMS.sma}`,
          values: price(v.sma[i]),
        });
        break;
      case "ema":
        rows.push({
          id,
          label: `${tr("indicator.ema.short")} ${PARAMS.ema}`,
          values: price(v.ema[i]),
        });
        break;
      case "bollinger":
        rows.push({
          id,
          label: `${tr("indicator.bollinger.short")} ${PARAMS.bollinger.period} ${PARAMS.bollinger.mult}`,
          values: [v.bbUpper[i], v.bbMiddle[i], v.bbLower[i]].map(price).join("  "),
        });
        break;
      case "vwap":
        rows.push({ id, label: tr("indicator.vwap.short"), values: price(v.vwap[i]) });
        break;
      case "rsi":
        rows.push({
          id,
          label: `${tr("indicator.rsi.short")} ${PARAMS.rsi}`,
          values: plain(v.rsi[i]),
        });
        break;
      case "macd": {
        const { fast, slow, signal } = PARAMS.macd;
        const dp = Math.max(decimals, 2);
        rows.push({
          id,
          label: `${tr("indicator.macd.short")} ${fast} ${slow} ${signal}`,
          values: [v.macd[i], v.signal[i], v.histogram[i]].map((x) => plain(x, dp)).join("  "),
        });
        break;
      }
      default:
        // Volume is in the OHLC readout.
        break;
    }
  }
  return rows;
}

/**
 * The top-left readout: open, high, low, close, the change and volume of
 * the candle under the crosshair, or of the latest one, then each
 * indicator's value there. Values are the candle as drawn (joined), so they
 * match the body on screen.
 */
function Legend({
  title,
  market,
  candle,
  drawn,
  decimals,
  showVolume,
  rows,
  onRemove,
}: {
  title?: string;
  market?: Market;
  candle: Candle;
  drawn: DrawnCandle;
  decimals: number;
  showVolume: boolean;
  rows: ReturnType<typeof indicatorRows>;
  onRemove?: (id: IndicatorId) => void;
}) {
  const change = drawn.close - drawn.open;
  const pct = drawn.open ? (change / drawn.open) * 100 : 0;
  const trend = change >= 0 ? "up" : "down";
  const price = (v: number) => formatNumber(v, decimals);
  const item = (label: string, value: string, className = "pd-ohlc-item", hideLabel = false) => (
    <div className={className}>
      <dt className={hideLabel ? "pd-visually-hidden" : "pd-ohlc-label"}>{label}</dt>
      <dd>{value}</dd>
    </div>
  );
  return (
    <div className="pd-ohlc">
      {title && (
        <p className="pd-ohlc-title">
          {market && <TokenIcon market={market} size={18} />}
          <span className="pd-ohlc-name">{title}</span>
        </p>
      )}
      <dl className="pd-ohlc-values" data-trend={trend}>
        {item(tr("chart.open"), price(drawn.open))}
        {item(tr("chart.high"), price(drawn.high))}
        {item(tr("chart.low"), price(drawn.low))}
        {item(tr("chart.close"), price(drawn.close))}
        {item(
          tr("chart.change"),
          `${formatSigned(change, decimals)} (${formatSigned(pct)}%)`,
          "pd-ohlc-item",
          true,
        )}
        {showVolume &&
          item(
            tr("chart.volume"),
            formatCompact(Number(candle.volume)),
            "pd-ohlc-item pd-ohlc-volume",
          )}
      </dl>
      {rows.length > 0 && (
        <ul className="pd-ohlc-indicators">
          {rows.map((r) => (
            <li key={r.id} data-indicator={r.id}>
              <span className="pd-ohlc-indicator-name">{r.label}</span>
              <span className="pd-ohlc-indicator-values">{r.values}</span>
              {onRemove && (
                <button
                  type="button"
                  className="pd-ohlc-remove"
                  aria-label={tr("indicator.remove", {
                    name: tr(`indicator.${r.id}` as MessageKey),
                  })}
                  onClick={() => onRemove(r.id)}
                >
                  <LuX size={12} aria-hidden />
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** A trade level's line color: the side for the position, brass for orders. */
function levelColor(level: ChartLevel, t: Tokens): string {
  switch (level.kind) {
    case "position":
      return level.side === "short" ? t.sell : t.buy;
    case "takeProfit":
      return t.buy;
    case "stopLoss":
      return t.sell;
    case "liquidation":
      return t.warning;
    default:
      return t.brass;
  }
}

const SIDE_KEY: Record<string, MessageKey> = {
  long: "side.long",
  short: "side.short",
  buy: "side.buy",
  sell: "side.sell",
};

/** What a level's tag on the chart says, after the design's "LONG 250 @ 37.912 · +121.50". */
function levelLabel(level: ChartLevel, decimals: number): string {
  const price = formatNumber(level.price, decimals);
  const pnl = level.pnl === undefined ? "-" : formatSigned(level.pnl);
  const side = level.side ? tr(SIDE_KEY[level.side] as MessageKey) : "";
  const size = level.size === undefined ? "" : formatNumber(level.size);
  switch (level.kind) {
    case "position":
      return tr("chart.trade.position", { side, size, price, pnl });
    case "takeProfit":
      return tr("chart.trade.takeProfit", { price, pnl });
    case "stopLoss":
      return tr("chart.trade.stopLoss", { price, pnl });
    case "liquidation":
      return tr("chart.trade.liquidation", {
        price,
        distance: level.distance === undefined ? "-" : `${formatSigned(level.distance * 100, 1)}%`,
      });
    default:
      return tr("chart.trade.order", {
        side,
        size,
        price,
        type: tr(`orderType.${level.orderType ?? "limit"}` as MessageKey),
      });
  }
}

/** What a parent can ask of the chart. */
export interface CandleChartHandle {
  /** The chart as an image, with the title strip above it. */
  screenshot(): HTMLCanvasElement | undefined;
}

interface CandleChartProps {
  /** Oldest first; the last one may still be forming. */
  candles: Candle[];
  /** Changes when the market or interval does, so the view resets. */
  seriesKey: string;
  /** Decimal places for the price scale. */
  priceDecimals: number;
  /** Above the OHLC readout, e.g. "HYPE-USDC · 1h · Hyperliquid". */
  title?: string;
  /** Shown as a logo before the title. */
  market?: Market;
  /** Asked for older candles when the view nears the oldest one. */
  onNeedOlder?: () => void;
  /** How the price is drawn; candles by default. */
  chartType?: ChartType;
  /** Indicators on the chart, in the order added. Volume by default. */
  indicators?: readonly IndicatorId[];
  /** Offered as a × beside each indicator in the readout. */
  onRemoveIndicator?: (id: IndicatorId) => void;
  /**
   * The candle width in ms: shown as the time left until the latest candle
   * closes, under the last price on the price scale. None without it.
   */
  intervalMs?: number;
  /**
   * The account's position in this market, drawn as its entry, take-profit,
   * stop-loss and liquidation lines.
   */
  position?: Position;
  /** The account's open orders in this market, a line at each one's price. */
  orders?: readonly Order[];
  /** The account's fills in this market, as entry and exit marks on their candles. */
  fills?: readonly Fill[];
  /**
   * Moves the position's TP or SL to a price dragged to; with it, their lines
   * can be grabbed. Resolves to the price set (on the tick), or undefined if
   * nothing changed; rejects with the message to show.
   */
  onMoveExit?: (kind: ExitKind, price: number) => Promise<Decimal | undefined>;
  ref?: Ref<CandleChartHandle>;
}

const DEFAULT_INDICATORS: readonly IndicatorId[] = ["volume"];
const NO_ORDERS: readonly Order[] = [];
const NO_FILLS: readonly Fill[] = [];

/**
 * The price chart, drawn by lightweight-charts: candles, bars, Heikin-Ashi,
 * line, area or baseline, with indicators on top or in panes below. Colors
 * come from the brand tokens and follow theme and colorblind switches. Each
 * candle is drawn joined to the one before (see `joinedCandle`).
 */
export function CandleChart({
  candles,
  seriesKey,
  priceDecimals,
  title,
  market,
  onNeedOlder,
  chartType = "candles",
  indicators = DEFAULT_INDICATORS,
  onRemoveIndicator,
  intervalMs,
  position,
  orders = NO_ORDERS,
  fills = NO_FILLS,
  onMoveExit,
  ref,
}: CandleChartProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const countdownRef = useRef<HTMLDivElement>(null);
  const levelsRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi>(null);
  const drawnRef = useRef<Drawn>(null);
  const tokensRef = useRef<Tokens>(null);
  /** What's on the chart, to tell a live update from a new series. */
  const shown = useRef({ key: "", count: 0, first: 0, last: 0 });
  /** The latest `onNeedOlder`, for the chart's range listener. */
  const needOlder = useRef(onNeedOlder);
  needOlder.current = onNeedOlder;
  /** Open time of the candle under the crosshair; unset shows the latest. */
  const [hovered, setHovered] = useState<number>();
  /** Bumped by a theme change, which rebuilds the series in the new colors. */
  const [styleVersion, setStyleVersion] = useState(0);
  const active = new Set(indicators);
  const indicatorsKey = [...indicators].sort().join(",");

  // Create once; restyle whenever the theme or market colors change.
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const t = tokens(host);
    tokensRef.current = t;
    const chart = createChart(host, { ...chartOptions(t), autoSize: true });
    chartRef.current = chart;

    const onCrosshair = (param: MouseEventParams) => {
      setHovered(typeof param.time === "number" ? param.time * 1000 : undefined);
    };
    chart.subscribeCrosshairMove(onCrosshair);

    // Scrolled back to near the oldest candle: ask for older ones before the
    // user runs out.
    const onRange = (range: { from: number; to: number } | null) => {
      if (range && range.from < LOAD_OLDER_MARGIN) needOlder.current?.();
    };
    chart.timeScale().subscribeVisibleLogicalRangeChange(onRange);

    const observer = new MutationObserver(() => {
      const next = tokens(host);
      tokensRef.current = next;
      chart.applyOptions(chartOptions(next));
      setStyleVersion((v) => v + 1);
    });
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["data-theme", "data-market"],
    });
    return () => {
      observer.disconnect();
      chart.unsubscribeCrosshairMove(onCrosshair);
      chart.timeScale().unsubscribeVisibleLogicalRangeChange(onRange);
      chart.remove();
      chartRef.current = null;
      drawnRef.current = null;
      // A recreated chart starts empty (StrictMode does this on every mount
      // in development), so the next data must be drawn in full, not as an
      // update to candles it never had.
      shown.current = { key: "", count: 0, first: 0, last: 0 };
    };
  }, []);

  // (Re)build the series whenever the chart type, the indicators or the
  // theme change; the data effect below then draws them in full.
  // biome-ignore lint/correctness/useExhaustiveDependencies: `indicatorsKey` stands for `active`; `styleVersion` forces a rebuild
  useEffect(() => {
    const chart = chartRef.current;
    const t = tokensRef.current;
    if (!chart || !t) return;
    if (drawnRef.current) clear(chart, drawnRef.current);
    drawnRef.current = build(chart, chartType, active, t);
    drawnRef.current.main?.applyOptions({
      priceFormat: { type: "price", precision: priceDecimals, minMove: 10 ** -priceDecimals },
    });
    shown.current = { ...shown.current, key: "", count: 0 };
  }, [chartType, indicatorsKey, styleVersion]);

  useEffect(() => {
    drawnRef.current?.main?.applyOptions({
      priceFormat: { type: "price", precision: priceDecimals, minMove: 10 ** -priceDecimals },
    });
  }, [priceDecimals]);

  // Push data: a whole new series (or a rebuild) resets; otherwise only the
  // last candle changed or one was added, so update in place.
  // biome-ignore lint/correctness/useExhaustiveDependencies: `chartType`/`indicatorsKey`/`styleVersion` redraw after a rebuild
  useEffect(() => {
    const d = drawnRef.current;
    const t = tokensRef.current;
    const main = d?.main;
    const last = candles.at(-1);
    if (!d || !main || !t) return;
    const prev = shown.current;
    const drawn = joinedCandles(candles);
    const points = mainData(chartType, candles, drawn);
    const values = compute(candles, active);
    // Same series continued: same key, same oldest candle. A replaced series
    // (e.g. fresh history over cached candles) resets even at the same length.
    const incremental =
      prev.key === seriesKey &&
      last !== undefined &&
      candles[0]?.openTime === prev.first &&
      candles.length - prev.count <= 1 &&
      candles.length >= prev.count &&
      last.openTime >= prev.last;
    const lineEntries = Object.entries(d.lines) as [LineKey, ISeriesApi<"Line">][];
    const hist = (c: Candle, i: number) => {
      const h = values.histogram[i];
      return h === undefined
        ? { time: toTime(c.openTime) }
        : { time: toTime(c.openTime), value: h, color: h >= 0 ? t.buyTint : t.sellTint };
    };
    if (incremental && last) {
      const i = candles.length - 1;
      main.update(points[i] as never);
      d.volume?.update(volume(last, drawn[i] as DrawnCandle, t));
      for (const [key, s] of lineEntries) s.update(linePoint(last, values[key][i]));
      d.macdHist?.update(hist(last, i));
    } else {
      // Older candles joined on the left (same series, same newest candle):
      // keep the view on the same candles, which have moved right by that many.
      const timeScale = chartRef.current?.timeScale();
      const added =
        prev.key === seriesKey && prev.first > 0 && last?.openTime === prev.last
          ? candles.findIndex((c) => c.openTime === prev.first)
          : -1;
      const view = added > 0 ? timeScale?.getVisibleLogicalRange() : null;
      main.setData(points as never);
      if (chartType === "baseline" && points[0] && "value" in points[0]) {
        main.applyOptions({ baseValue: { type: "price", price: points[0].value } } as never);
      }
      d.volume?.setData(candles.map((c, i) => volume(c, drawn[i] as DrawnCandle, t)));
      for (const [key, s] of lineEntries) {
        s.setData(candles.map((c, i) => linePoint(c, values[key][i])));
      }
      d.macdHist?.setData(candles.map(hist));
      if (view) {
        timeScale?.setVisibleLogicalRange({ from: view.from + added, to: view.to + added });
      } else if (prev.key !== seriesKey) {
        timeScale?.scrollToRealTime();
      }
    }
    shown.current = {
      key: seriesKey,
      count: candles.length,
      first: candles[0]?.openTime ?? 0,
      last: last?.openTime ?? 0,
    };
  }, [candles, seriesKey, chartType, indicatorsKey, styleVersion]);

  // The candle countdown, kept under the last price's label on the price
  // scale: followed every frame (the scale moves as prices do and as it's
  // dragged), its text changing once a second. Written to the DOM directly,
  // so a ticking clock doesn't re-render the chart.
  // biome-ignore lint/correctness/useExhaustiveDependencies: `chartType`/`styleVersion` rebuild the series it reads
  useEffect(() => {
    const el = countdownRef.current;
    if (!el || !intervalMs) return;
    let frame = 0;
    let text = "";
    const hide = () => {
      el.hidden = true;
    };
    const follow = () => {
      frame = requestAnimationFrame(follow);
      const chart = chartRef.current;
      const main = drawnRef.current?.main;
      const last = main?.data().at(-1) as
        | { time: number; value?: number; open?: number; close?: number }
        | undefined;
      const price = last?.close ?? last?.value;
      if (!chart || !main || !last || price === undefined) return hide();
      const y = main.priceToCoordinate(price);
      const paneHeight = chart.panes()[0]?.getHeight() ?? 0;
      if (y === null || y < 0 || y > paneHeight) return hide();
      const next = formatCountdown(last.time * 1000 + intervalMs - Date.now());
      if (next !== text) {
        text = next;
        el.textContent = next;
      }
      // Coloured like the label it hangs from: the candle's direction for
      // candles and bars, neutral for the line styles.
      const trend =
        last.open === undefined || last.close === undefined
          ? "flat"
          : last.close >= last.open
            ? "up"
            : "down";
      if (el.dataset.trend !== trend) el.dataset.trend = trend;
      el.style.width = `${chart.priceScale("right").width()}px`;
      el.style.transform = `translateY(${Math.round(y + COUNTDOWN_OFFSET_PX)}px)`;
      el.hidden = false;
    };
    frame = requestAnimationFrame(follow);
    return () => {
      cancelAnimationFrame(frame);
      hide();
    };
  }, [intervalMs, chartType, styleVersion]);

  const levels = useMemo(() => tradeLevels(position, orders), [position, orders]);
  const [drag, setDrag] = useState<ExitDrag>();
  // A TP or SL being moved is drawn where it's going, PnL and all.
  const drawnLevels = drag
    ? levels.map((l) =>
        l.id === drag.id
          ? {
              ...l,
              price: drag.price,
              pnl: position ? pnlAt(position, drag.price, Number(position.size)) : l.pnl,
            }
          : l,
      )
    : levels;
  // Lines change only when a price does, not with every PnL tick.
  const linesKey = drawnLevels.map((l) => `${l.kind}:${l.side}:${l.price}`).join(",");

  // A saved move holds its line until the account shows the new price (or
  // gives up after a while), so it doesn't jump back in between.
  // biome-ignore lint/correctness/useExhaustiveDependencies: `linesKey` stands for `levels`, which change with every PnL tick
  useEffect(() => {
    if (drag?.state !== "saved") return;
    if (levels.find((l) => l.id === drag.id)?.price !== drag.from) {
      setDrag(undefined);
      return;
    }
    const id = setTimeout(() => setDrag(undefined), SETTLE_MS);
    return () => clearTimeout(id);
  }, [drag, linesKey]);

  // The levels' lines, on the main series (rebuilt with it). Their tags are
  // HTML, positioned below.
  // biome-ignore lint/correctness/useExhaustiveDependencies: `linesKey` stands for `drawnLevels`; the rest rebuild the series
  useEffect(() => {
    const main = drawnRef.current?.main;
    const t = tokensRef.current;
    if (!main || !t) return;
    // Price lines don't count towards the price scale, so scrolled to candles
    // that don't reach them, they'd fall off it: the scale takes them in.
    // The liquidation price is left out, as it can be far enough away to
    // flatten the candles.
    const prices = drawnLevels.filter((l) => l.kind !== "liquidation").map((l) => l.price);
    main.applyOptions({
      autoscaleInfoProvider: (base: () => AutoscaleInfo | null) => {
        const info = base();
        if (!info?.priceRange || prices.length === 0) return info;
        const { minValue, maxValue } = info.priceRange;
        return {
          ...info,
          priceRange: {
            minValue: Math.min(minValue, ...prices),
            maxValue: Math.max(maxValue, ...prices),
          },
        };
      },
    });
    const lines: IPriceLine[] = drawnLevels.map((level) =>
      main.createPriceLine({
        price: level.price,
        color: levelColor(level, t),
        lineStyle: LineStyle.Dashed,
        lineWidth: 1,
        axisLabelVisible: true,
      }),
    );
    return () => {
      // Gone already if the chart was removed first.
      if (!chartRef.current) return;
      for (const line of lines) main.removePriceLine(line);
    };
  }, [linesKey, chartType, indicatorsKey, styleVersion]);

  // Fills only move to other candles when the candles loaded do.
  const firstOpen = candles[0]?.openTime;
  // biome-ignore lint/correctness/useExhaustiveDependencies: `candles` is read through its length and oldest candle
  const marks = useMemo(
    () => fillMarks(fills, candles, intervalMs),
    [fills, candles.length, firstOpen, intervalMs],
  );

  // biome-ignore lint/correctness/useExhaustiveDependencies: `chartType`/`indicatorsKey`/`styleVersion` rebuild the series
  useEffect(() => {
    const main = drawnRef.current?.main;
    const t = tokensRef.current;
    if (!main || !t || marks.length === 0) return;
    const markers: SeriesMarker<Time>[] = marks.map((m) => ({
      time: toTime(m.time),
      position: m.side === "buy" ? "atPriceBottom" : "atPriceTop",
      price: m.price,
      shape: m.side === "buy" ? "arrowUp" : "arrowDown",
      color: m.side === "buy" ? t.buy : t.sell,
    }));
    const plugin = createSeriesMarkers(main, markers);
    return () => {
      if (chartRef.current) plugin.detach();
    };
  }, [marks, chartType, indicatorsKey, styleVersion]);

  // The level tags, kept on their lines as the price scale moves (every
  // frame, like the countdown) and nudged apart where lines sit close.
  useEffect(() => {
    const box = levelsRef.current;
    if (!box || !linesKey) return;
    let frame = 0;
    const follow = () => {
      frame = requestAnimationFrame(follow);
      const chart = chartRef.current;
      const main = drawnRef.current?.main;
      if (!chart || !main) return;
      const paneHeight = chart.panes()[0]?.getHeight() ?? 0;
      box.style.width = `${chart.timeScale().width()}px`;
      const tags = [...box.children] as HTMLElement[];
      const placed = tags
        .map((el) => ({ el, y: main.priceToCoordinate(Number(el.dataset.price)) }))
        .sort((a, b) => (a.y ?? 0) - (b.y ?? 0));
      let prev = Number.NEGATIVE_INFINITY;
      for (const { el, y } of placed) {
        if (y === null || y < 0 || y > paneHeight) {
          el.hidden = true;
          continue;
        }
        const at = Math.max(y, prev + LEVEL_LABEL_GAP_PX);
        prev = at;
        el.style.transform = `translateY(${Math.round(at)}px) translateY(-50%)`;
        el.hidden = false;
      }
    };
    frame = requestAnimationFrame(follow);
    return () => cancelAnimationFrame(frame);
  }, [linesKey]);

  /** The movable TP or SL under the pointer: its tag, or within a few px of its line. */
  const grabbable = (e: PointerEvent<HTMLDivElement>): ChartLevel | undefined => {
    const chart = chartRef.current;
    const main = drawnRef.current?.main;
    const host = hostRef.current;
    if (!onMoveExit || !chart || !main || !host) return undefined;
    const tag = (e.target as HTMLElement).closest<HTMLElement>("[data-movable]");
    if (tag) return drawnLevels.find((l) => l.id === tag.dataset.id);
    const rect = host.getBoundingClientRect();
    // Not over the price scale, which drags to rescale.
    if (e.clientX - rect.left > chart.timeScale().width()) return undefined;
    const y = e.clientY - rect.top;
    return drawnLevels.find((l) => {
      const at = l.movable ? main.priceToCoordinate(l.price) : null;
      return at !== null && Math.abs(at - y) <= GRAB_PX;
    });
  };

  // Grabbed before the chart sees the press, so it doesn't pan as well.
  const onGrab = (e: PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0 || (drag && drag.state !== "saved")) return;
    const level = grabbable(e);
    if (!level || (level.kind !== "takeProfit" && level.kind !== "stopLoss")) return;
    e.stopPropagation();
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    chartRef.current?.applyOptions({ handleScroll: false, handleScale: false });
    setDrag({
      id: level.id,
      kind: level.kind,
      from: level.price,
      price: level.price,
      state: "dragging",
    });
  };

  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    const el = e.currentTarget;
    if (drag?.state === "dragging") {
      const main = drawnRef.current?.main;
      const host = hostRef.current;
      const price =
        main && host ? main.coordinateToPrice(e.clientY - host.getBoundingClientRect().top) : null;
      if (price !== null && price > 0) setDrag({ ...drag, price });
      return;
    }
    // The resize cursor over a line that can be grabbed. Set directly, as
    // it changes with every move.
    if (grabbable(e)) el.dataset.grab = "";
    else delete el.dataset.grab;
  };

  const onRelease = (e: PointerEvent<HTMLDivElement>, cancelled: boolean) => {
    if (drag?.state !== "dragging") return;
    if (e.currentTarget.hasPointerCapture(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId);
    }
    chartRef.current?.applyOptions({ handleScroll: true, handleScale: true });
    if (cancelled || !onMoveExit || drag.price === drag.from) return setDrag(undefined);
    const move = drag;
    setDrag({ ...move, state: "saving" });
    onMoveExit(move.kind, move.price).then(
      (price) =>
        setDrag(
          price === undefined ? undefined : { ...move, price: Number(price), state: "saved" },
        ),
      (err: unknown) => {
        setDrag(undefined);
        toastError(tr("toast.exitNotMoved"), err);
      },
    );
  };

  useImperativeHandle(
    ref,
    () => ({
      screenshot() {
        const chart = chartRef.current;
        const t = tokensRef.current;
        if (!chart || !t) return undefined;
        const shot = chart.takeScreenshot(true, false);
        // The canvas is at device pixels; scale the title strip to match.
        const scale = shot.width / (hostRef.current?.clientWidth || shot.width);
        const strip = SHOT_TITLE_PX * scale;
        const out = document.createElement("canvas");
        out.width = shot.width;
        out.height = shot.height + strip;
        const ctx = out.getContext("2d");
        if (!ctx) return shot;
        ctx.fillStyle = t.bg;
        ctx.fillRect(0, 0, out.width, out.height);
        ctx.fillStyle = t.line;
        ctx.font = `600 ${13 * scale}px ${t.font || "monospace"}`;
        ctx.textBaseline = "middle";
        ctx.fillText(title ?? "", 10 * scale, strip / 2);
        ctx.drawImage(shot, 0, strip);
        return out;
      },
    }),
    [title],
  );

  // The hovered candle (found from its open time, newest first since that's
  // where the crosshair usually is), or the latest.
  let index = candles.length - 1;
  if (hovered !== undefined) {
    for (let i = candles.length - 1; i >= 0; i--) {
      if (candles[i]?.openTime === hovered) {
        index = i;
        break;
      }
    }
  }
  const current = candles[index];
  const before = candles[index - 1];
  const rows =
    current && indicators.some((id) => id !== "volume")
      ? indicatorRows(indicators, compute(candles, active), index, priceDecimals)
      : [];

  return (
    <div
      className="pd-candle-chart"
      data-dragging={drag?.state === "dragging" || undefined}
      onPointerDownCapture={onGrab}
      onPointerMove={onPointerMove}
      onPointerUp={(e) => onRelease(e, false)}
      onPointerCancel={(e) => onRelease(e, true)}
    >
      <div ref={hostRef} className="pd-candle-host" />
      <div ref={countdownRef} className="pd-candle-countdown pd-num" hidden aria-hidden />
      {drawnLevels.length > 0 && (
        <div ref={levelsRef} className="pd-chart-levels" aria-hidden>
          {drawnLevels.map((level) => (
            <span
              key={level.id}
              className="pd-chart-level pd-num"
              data-id={level.id}
              data-kind={level.kind}
              data-side={level.side}
              data-price={level.price}
              data-movable={(onMoveExit && level.movable) || undefined}
              data-busy={(drag?.id === level.id && drag.state === "saving") || undefined}
              hidden
            >
              {levelLabel(level, priceDecimals)}
            </span>
          ))}
        </div>
      )}
      {current && (
        <Legend
          title={title}
          market={market}
          candle={current}
          drawn={joinedCandle(current, before ? Number(before.close) : undefined)}
          decimals={priceDecimals}
          showVolume={active.has("volume")}
          rows={rows}
          onRemove={onRemoveIndicator}
        />
      )}
    </div>
  );
}
