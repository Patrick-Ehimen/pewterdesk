import type { Candle } from "@pewterdesk/core";
import {
  CandlestickSeries,
  createChart,
  createSeriesMarkers,
  createTextWatermark,
  type IChartApi,
  type IPriceLine,
  type ISeriesApi,
  type ISeriesMarkersPluginApi,
  type ITextWatermarkPluginApi,
  LineStyle,
  type Time,
  type UTCTimestamp,
} from "lightweight-charts";
import { useEffect, useRef } from "react";
import { chartOptions, tokens, withAlpha } from "./chartTheme";

export interface ChartLevel {
  id: string;
  price: number;
  /** A CSS colour the canvas can paint (no `var()`). */
  color: string;
  /** Beside the line, on the price axis; none when empty. */
  label: string;
  dashed?: boolean;
}

/** A note pinned above the candle it was written on. */
export interface ChartPin {
  /** Milliseconds. */
  at: number;
  label: string;
}

const time = (ms: number) => Math.floor(ms / 1000) as UTCTimestamp;

/** Candles from the oldest one held at which older ones are asked for. */
const OLDER_AT = 20;

/**
 * Each chart's view, by `viewKey` (market and interval): how many candles
 * it shows and how far its right edge is from the latest. Kept from the
 * latest candle rather than by date, so coming back finds the same zoom on
 * today's candles. Kept on this machine, between sessions too.
 */
interface View {
  span: number;
  fromEnd: number;
}
const VIEWS_KEY = "pd.levelsChart.views";
const MAX_VIEWS = 60;
let views: Map<string, View> | undefined;

function savedViews(): Map<string, View> {
  if (views) return views;
  views = new Map();
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(VIEWS_KEY) ?? "[]");
    if (Array.isArray(raw)) {
      for (const entry of raw) {
        const [key, view] = Array.isArray(entry) ? entry : [];
        if (
          typeof key === "string" &&
          typeof view?.span === "number" &&
          typeof view?.fromEnd === "number" &&
          view.span > 1
        ) {
          views.set(key, { span: view.span, fromEnd: view.fromEnd });
        }
      }
    }
  } catch {
    // Unreadable or no storage: views start fitted.
  }
  return views;
}

let writing: ReturnType<typeof setTimeout> | undefined;
function keepView(key: string, view: View) {
  const all = savedViews();
  all.delete(key);
  all.set(key, view);
  while (all.size > MAX_VIEWS) {
    const oldest = all.keys().next().value;
    if (oldest === undefined) break;
    all.delete(oldest);
  }
  // Written once the view settles, not on every frame of a drag.
  clearTimeout(writing);
  writing = setTimeout(() => {
    try {
      localStorage.setItem(VIEWS_KEY, JSON.stringify([...all]));
    } catch {
      // Storage full or off: kept for this session.
    }
  }, 400);
}

/**
 * Candles with the trader's levels drawn across them as price lines, and
 * their notes pinned to the candles they were written on. It only draws:
 * a click can hand back the price under it (`onPick`), and nothing else.
 */
export function LevelsChart({
  candles,
  levels,
  pins = [],
  onPick,
  /** Changes when the market or interval does: the view is fitted again. */
  viewKey,
  /** Written large and faint behind the candles, as TradingView does: the market. */
  watermark,
  onNeedOlder,
  className,
}: {
  candles: readonly Candle[];
  levels: readonly ChartLevel[];
  pins?: readonly ChartPin[];
  onPick?: (price: number) => void;
  viewKey?: string;
  watermark?: string;
  /** Asked for older candles when the view nears the oldest one held (scrolled or zoomed back). */
  onNeedOlder?: () => void;
  className?: string;
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi>(null);
  const seriesRef = useRef<ISeriesApi<"Candlestick">>(null);
  const markersRef = useRef<ISeriesMarkersPluginApi<Time>>(null);
  const lines = useRef<IPriceLine[]>([]);
  const markRef = useRef<ITextWatermarkPluginApi<Time>>(null);
  const fitted = useRef<string | undefined>(undefined);
  const viewKeyRef = useRef(viewKey);
  viewKeyRef.current = viewKey;
  const pick = useRef(onPick);
  pick.current = onPick;
  const older = useRef(onNeedOlder);
  older.current = onNeedOlder;

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const t = tokens(host);
    const chart = createChart(host, {
      ...chartOptions(t),
      autoSize: true,
      // No grid: the levels are the lines that matter here.
      grid: { vertLines: { visible: false }, horzLines: { visible: false } },
    });
    const series = chart.addSeries(CandlestickSeries, {
      upColor: t.up,
      downColor: t.down,
      borderUpColor: t.up,
      borderDownColor: t.down,
      wickUpColor: t.up,
      wickDownColor: t.down,
    });
    chartRef.current = chart;
    seriesRef.current = series;
    markersRef.current = createSeriesMarkers(series, []);
    const pane = chart.panes()[0];
    if (pane) markRef.current = createTextWatermark(pane, { lines: [] });
    // Near the oldest candle: the next page is asked for. The caller fetches
    // one page at a time and stops when the venue has no more.
    chart.timeScale().subscribeVisibleLogicalRangeChange((range) => {
      if (!range) return;
      if (range.from < OLDER_AT) older.current?.();
      // Once this market's view is placed, where the trader takes it is kept.
      const key = viewKeyRef.current;
      const count = series.data().length;
      if (key && fitted.current === key && count > 0) {
        keepView(key, { span: range.to - range.from, fromEnd: count - 1 - range.to });
      }
    });
    chart.subscribeClick((param) => {
      if (!param.point || !pick.current) return;
      const price = series.coordinateToPrice(param.point.y);
      if (price !== null && price > 0) pick.current(price);
    });
    return () => {
      chart.remove();
      chartRef.current = null;
      seriesRef.current = null;
      markersRef.current = null;
      markRef.current = null;
      lines.current = [];
    };
  }, []);

  // The candles; the view is fitted once per market and interval.
  useEffect(() => {
    const series = seriesRef.current;
    if (!series) return;
    series.setData(
      candles.map((c) => ({
        time: time(c.openTime),
        open: Number(c.open),
        high: Number(c.high),
        low: Number(c.low),
        close: Number(c.close),
      })),
    );
    if (candles.length > 0 && fitted.current !== viewKey) {
      // The view the trader left this market and interval at, else all of it.
      const kept = viewKey ? savedViews().get(viewKey) : undefined;
      const scale = chartRef.current?.timeScale();
      if (kept && scale) {
        const to = candles.length - 1 - kept.fromEnd;
        scale.setVisibleLogicalRange({ from: to - kept.span, to });
      } else {
        scale?.fitContent();
      }
      fitted.current = viewKey;
    }
  }, [candles, viewKey]);

  // The market's name behind the candles, in the theme's text at a whisper,
  // sized to the chart: about a third of its width, kept between 18 and 40px.
  useEffect(() => {
    const host = hostRef.current;
    const mark = markRef.current;
    if (!host || !mark) return;
    const color = withAlpha(tokens(host).line, 0.07);
    const draw = () => {
      const width = host.clientWidth;
      const size = watermark
        ? Math.round(
            Math.min(40, Math.max(18, (width * 0.33) / Math.max(watermark.length, 4) / 0.6)),
          )
        : 0;
      mark.applyOptions({
        horzAlign: "center",
        vertAlign: "center",
        lines: watermark ? [{ text: watermark, color, fontSize: size, fontStyle: "600" }] : [],
      });
    };
    draw();
    const resize = new ResizeObserver(draw);
    resize.observe(host);
    return () => resize.disconnect();
  }, [watermark]);

  // The levels, drawn again whenever they change.
  useEffect(() => {
    const series = seriesRef.current;
    if (!series) return;
    for (const line of lines.current) series.removePriceLine(line);
    lines.current = levels.map((l) =>
      series.createPriceLine({
        price: l.price,
        color: l.color,
        lineWidth: 2,
        lineStyle: l.dashed ? LineStyle.Dashed : LineStyle.Solid,
        axisLabelVisible: true,
        title: l.label,
      }),
    );
  }, [levels]);

  // Each note on the candle it was written in.
  useEffect(() => {
    const host = hostRef.current;
    const markers = markersRef.current;
    if (!host || !markers) return;
    const t = tokens(host);
    const opens = candles.map((c) => c.openTime);
    const placed = pins.flatMap((p) => {
      // The last candle that opened at or before the note.
      let at: number | undefined;
      for (const open of opens) if (open <= p.at) at = open;
      return at === undefined ? [] : [{ at, label: p.label }];
    });
    markers.setMarkers(
      placed
        .sort((a, b) => a.at - b.at)
        .map((p) => ({
          time: time(p.at),
          position: "aboveBar" as const,
          shape: "circle" as const,
          color: t.brass,
          text: p.label,
        })),
    );
  }, [pins, candles]);

  return (
    <div
      ref={hostRef}
      className={className ?? "pd-levels-chart"}
      data-picking={onPick ? true : undefined}
    />
  );
}
