import type { Candle, Market } from "@pewterdesk/core";
import {
  CandlestickSeries,
  createChart,
  HistogramSeries,
  type IChartApi,
  type ISeriesApi,
  type MouseEventParams,
  type UTCTimestamp,
} from "lightweight-charts";
import { useEffect, useRef, useState } from "react";
import { t as tr } from "../../i18n";
import { type DrawnCandle, joinedCandle, joinedCandles } from "../../lib/chart";
import { formatCompact, formatNumber, formatSigned } from "../../lib/format";
import { chartOptions, type Tokens, tokens } from "./chartTheme";
import { TokenIcon } from "./TokenIcon";

// Display-only: candles go through JS numbers for drawing.

const toTime = (ms: number) => Math.floor(ms / 1000) as UTCTimestamp;
/** Bars from the oldest candle at which older ones are fetched. */
const LOAD_OLDER_MARGIN = 50;

function bar(c: Candle, drawn: DrawnCandle) {
  return { time: toTime(c.openTime), ...drawn };
}

/** Colored like its candle as drawn, so a bar's color matches the body above it. */
function volume(c: Candle, drawn: DrawnCandle, t: Tokens) {
  const up = drawn.close >= drawn.open;
  return { time: toTime(c.openTime), value: Number(c.volume), color: up ? t.buyTint : t.sellTint };
}

/**
 * The top-left readout: open, high, low, close, the change and volume of
 * the candle under the crosshair, or of the latest one. Values are the
 * candle as drawn (joined), so they match the body on screen.
 */
function Legend({
  title,
  market,
  candle,
  drawn,
  decimals,
}: {
  title?: string;
  market?: Market;
  candle: Candle;
  drawn: DrawnCandle;
  decimals: number;
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
        {item(
          tr("chart.volume"),
          formatCompact(Number(candle.volume)),
          "pd-ohlc-item pd-ohlc-volume",
        )}
      </dl>
    </div>
  );
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
}

/**
 * Candlesticks with a volume strip underneath, drawn by lightweight-charts.
 * Colors come from the brand tokens and follow theme and colorblind switches.
 * Each candle is drawn joined to the one before (see `joinedCandle`).
 */
export function CandleChart({
  candles,
  seriesKey,
  priceDecimals,
  title,
  market,
  onNeedOlder,
}: CandleChartProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi>(null);
  const priceRef = useRef<ISeriesApi<"Candlestick">>(null);
  const volumeRef = useRef<ISeriesApi<"Histogram">>(null);
  const tokensRef = useRef<Tokens>(null);
  /** What's on the chart, to tell a live update from a new series. */
  const shown = useRef({ key: "", count: 0, first: 0, last: 0 });
  /** The latest `onNeedOlder`, for the chart's range listener. */
  const needOlder = useRef(onNeedOlder);
  needOlder.current = onNeedOlder;
  /** Open time of the candle under the crosshair; unset shows the latest. */
  const [hovered, setHovered] = useState<number>();

  // Create once; restyle whenever the theme or market colors change.
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const t = tokens(host);
    tokensRef.current = t;
    const chart = createChart(host, { ...chartOptions(t), autoSize: true });
    const price = chart.addSeries(CandlestickSeries, {
      upColor: t.buy,
      downColor: t.sell,
      borderUpColor: t.buy,
      borderDownColor: t.sell,
      wickUpColor: t.buy,
      wickDownColor: t.sell,
    });
    const vol = chart.addSeries(HistogramSeries, {
      priceScaleId: "volume",
      priceLineVisible: false,
      lastValueVisible: false,
    });
    chart.priceScale("volume").applyOptions({ scaleMargins: { top: 0.8, bottom: 0 } });
    // Headroom at the top for the title and OHLC readout.
    chart.priceScale("right").applyOptions({ scaleMargins: { top: 0.14, bottom: 0.24 } });
    chartRef.current = chart;
    priceRef.current = price;
    volumeRef.current = vol;

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

    const restyle = () => {
      const next = tokens(host);
      tokensRef.current = next;
      chart.applyOptions(chartOptions(next));
      price.applyOptions({
        upColor: next.buy,
        downColor: next.sell,
        borderUpColor: next.buy,
        borderDownColor: next.sell,
        wickUpColor: next.buy,
        wickDownColor: next.sell,
      });
      // Volume colors are per bar, so force a full redraw.
      shown.current = { key: "", count: 0, first: 0, last: 0 };
    };
    const observer = new MutationObserver(restyle);
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
      priceRef.current = null;
      volumeRef.current = null;
      // A recreated chart starts empty (StrictMode does this on every mount
      // in development), so the next data must be drawn in full, not as an
      // update to candles it never had.
      shown.current = { key: "", count: 0, first: 0, last: 0 };
    };
  }, []);

  useEffect(() => {
    priceRef.current?.applyOptions({
      priceFormat: { type: "price", precision: priceDecimals, minMove: 10 ** -priceDecimals },
    });
  }, [priceDecimals]);

  // Push data: a whole new series (or a restyle) resets; otherwise only the
  // last candle changed or one was added, so update in place.
  useEffect(() => {
    const price = priceRef.current;
    const vol = volumeRef.current;
    const t = tokensRef.current;
    const last = candles.at(-1);
    if (!price || !vol || !t) return;
    const prev = shown.current;
    // Same series continued: same key, same oldest candle. A replaced series
    // (e.g. fresh history over cached candles) resets even at the same length.
    const incremental =
      prev.key === seriesKey &&
      last !== undefined &&
      candles[0]?.openTime === prev.first &&
      candles.length - prev.count <= 1 &&
      candles.length >= prev.count &&
      last.openTime >= prev.last;
    if (incremental && last) {
      const before = candles.at(-2);
      const drawn = joinedCandle(last, before ? Number(before.close) : undefined);
      price.update(bar(last, drawn));
      vol.update(volume(last, drawn, t));
    } else {
      const drawn = joinedCandles(candles);
      // Older candles joined on the left (same series, same newest candle):
      // keep the view on the same candles, which have moved right by that many.
      const timeScale = chartRef.current?.timeScale();
      const added =
        prev.key === seriesKey && prev.first > 0 && last?.openTime === prev.last
          ? candles.findIndex((c) => c.openTime === prev.first)
          : -1;
      const view = added > 0 ? timeScale?.getVisibleLogicalRange() : null;
      price.setData(candles.map((c, i) => bar(c, drawn[i] as DrawnCandle)));
      vol.setData(candles.map((c, i) => volume(c, drawn[i] as DrawnCandle, t)));
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
  }, [candles, seriesKey]);

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
        />
      )}
    </div>
  );
}
