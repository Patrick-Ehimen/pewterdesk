import type { Candle, Market } from "@pewterdesk/core";
import {
  AreaSeries,
  BarSeries,
  BaselineSeries,
  CandlestickSeries,
  createChart,
  HistogramSeries,
  type IChartApi,
  type ISeriesApi,
  LineSeries,
  LineStyle,
  type MouseEventParams,
  type SeriesType,
  type UTCTimestamp,
} from "lightweight-charts";
import { type Ref, useEffect, useImperativeHandle, useRef, useState } from "react";
import { LuX } from "react-icons/lu";
import { type MessageKey, t as tr } from "../../i18n";
import { type DrawnCandle, joinedCandle, joinedCandles } from "../../lib/chart";
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
  ref?: Ref<CandleChartHandle>;
}

const DEFAULT_INDICATORS: readonly IndicatorId[] = ["volume"];

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
  ref,
}: CandleChartProps) {
  const hostRef = useRef<HTMLDivElement>(null);
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
    <div className="pd-candle-chart">
      <div ref={hostRef} className="pd-candle-host" />
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
