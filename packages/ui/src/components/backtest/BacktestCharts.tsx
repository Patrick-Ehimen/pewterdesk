import {
  AreaSeries,
  CandlestickSeries,
  ColorType,
  createChart,
  createSeriesMarkers,
  createTextWatermark,
  HistogramSeries,
  type IChartApi,
  type IPriceLine,
  type ISeriesApi,
  type ISeriesMarkersPluginApi,
  type ITextWatermarkPluginApi,
  LineSeries,
  LineStyle,
  type SeriesMarker,
  type Time,
  type UTCTimestamp,
} from "lightweight-charts";
import { type KeyboardEvent, type PointerEvent, useEffect, useRef, useState } from "react";
import { chartOptions, tokens, withAlpha } from "../trading/chartTheme";

// The Backtest page's charts: TradingView's Lightweight Charts, coloured
// from the theme's tokens like the app's other charts. They only draw.

const sec = (ms: number) => Math.floor(ms / 1000) as UTCTimestamp;

export interface BacktestBar {
  /** Open time, ms. */
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
}

/** A line drawn over the candles (an average), one value per candle. */
export interface ChartLine {
  values: readonly (number | null | undefined)[];
  /** A token's name ("info", "brass", "muted"), so themes apply. */
  tone: "info" | "brass" | "muted" | "warning";
  label: string;
}

export interface BacktestChartTrade {
  n: number;
  side: "long" | "short";
  openTime: number;
  closeTime: number;
  entry: number;
  exit: number;
  r: number;
  pnl: number;
  stop?: number;
}

/** The bar a time falls in: the last that opened at or before it. */
function snap(times: readonly number[], at: number): number | undefined {
  let lo = 0;
  let hi = times.length - 1;
  let found: number | undefined;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const t = times[mid] ?? 0;
    if (t <= at) {
      found = t;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return found;
}

/**
 * The market's own candles over the backtest, every trade marked where it
 * was entered and where it was closed (with what it made, in R), the
 * strategy's lines over them, and where the held-out period starts. A
 * focused trade is scrolled into view with its entry and stop drawn.
 */
export function BacktestChart({
  bars,
  lines = [],
  trades,
  holdOutFrom,
  holdOutLabel,
  focus,
  focusLabel,
  stopLabel,
  onPickTrade,
  view,
  onRange,
  watermark,
  className,
}: {
  bars: readonly BacktestBar[];
  lines?: readonly ChartLine[];
  trades: readonly BacktestChartTrade[];
  /** The first held-out candle's index; none when nothing is held out. */
  holdOutFrom?: number;
  holdOutLabel?: string;
  /** A trade's number, to scroll to and draw. */
  focus?: number;
  /** Written over the focused trade's span ("Trade #17 · +$975"). */
  focusLabel?: string;
  /** The focused trade's stop line's title. */
  stopLabel?: string;
  onPickTrade?: (n: number) => void;
  /** Candles to show, by index (from, to); applied each time a new one is given. */
  view?: { from: number; to: number };
  /** The candles on screen, by index, as the chart moves. */
  onRange?: (from: number, to: number) => void;
  watermark?: string;
  className?: string;
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi>(null);
  const candleRef = useRef<ISeriesApi<"Candlestick">>(null);
  const markersRef = useRef<ISeriesMarkersPluginApi<Time>>(null);
  const lineRefs = useRef<ISeriesApi<"Line">[]>([]);
  const markRef = useRef<ITextWatermarkPluginApi<Time>>(null);
  const priceLines = useRef<IPriceLine[]>([]);
  const pick = useRef(onPickTrade);
  pick.current = onPickTrade;
  const tradesRef = useRef(trades);
  tradesRef.current = trades;
  const rangeRef = useRef(onRange);
  rangeRef.current = onRange;
  const placeRef = useRef<() => void>(() => {});
  // The focused trade's span on screen, in pixels from the pane's left.
  const [box, setBox] = useState<{ left: number; width: number }>();

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const t = tokens(host);
    const chart = createChart(host, { ...chartOptions(t), autoSize: true });
    const candles = chart.addSeries(CandlestickSeries, {
      upColor: t.up,
      downColor: t.down,
      borderUpColor: t.up,
      borderDownColor: t.down,
      wickUpColor: t.up,
      wickDownColor: t.down,
    });
    chartRef.current = chart;
    candleRef.current = candles;
    markersRef.current = createSeriesMarkers(candles, []);
    const pane = chart.panes()[0];
    if (pane) {
      markRef.current = createTextWatermark(pane, {
        horzAlign: "center",
        vertAlign: "center",
        lines: [],
      });
    }
    // A click on a candle inside a trade picks that trade.
    chart.subscribeClick((param) => {
      if (param.time === undefined || !pick.current) return;
      const at = (param.time as number) * 1000;
      const hit = tradesRef.current.find((tr) => tr.openTime <= at && at <= tr.closeTime);
      if (hit) pick.current(hit.n);
    });
    const moved = () => {
      placeRef.current();
      const r = chart.timeScale().getVisibleLogicalRange();
      if (r) rangeRef.current?.(r.from, r.to);
    };
    chart.timeScale().subscribeVisibleLogicalRangeChange(moved);
    chart.timeScale().subscribeSizeChange(moved);
    return () => {
      chart.remove();
      chartRef.current = null;
      candleRef.current = null;
      markersRef.current = null;
      lineRefs.current = [];
      priceLines.current = [];
      markRef.current = null;
    };
  }, []);

  // The market's name, faint behind the candles; changed in place.
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    markRef.current?.applyOptions({
      lines: watermark
        ? [
            {
              text: watermark,
              color: withAlpha(tokens(host).line, 0.06),
              fontSize: 36,
              fontStyle: "600",
            },
          ]
        : [],
    });
  }, [watermark]);

  // Candles and lines; the view fitted to the whole run.
  useEffect(() => {
    const chart = chartRef.current;
    const candles = candleRef.current;
    const host = hostRef.current;
    if (!chart || !candles || !host) return;
    const t = tokens(host);
    // Prices to the market's own precision: whole dollars for BTC, more for a small coin.
    const typical = bars[bars.length >> 1]?.close ?? 1;
    const precision =
      typical >= 10_000
        ? 0
        : typical >= 1000
          ? 1
          : typical >= 10
            ? 2
            : typical >= 1
              ? 3
              : typical >= 0.01
                ? 5
                : 7;
    candles.applyOptions({ priceFormat: { type: "price", precision, minMove: 10 ** -precision } });
    candles.setData(
      bars.map((b) => ({
        time: sec(b.time),
        open: b.open,
        high: b.high,
        low: b.low,
        close: b.close,
      })),
    );
    for (const s of lineRefs.current) chart.removeSeries(s);
    lineRefs.current = lines.map((l) => {
      const s = chart.addSeries(LineSeries, {
        color: t[l.tone],
        lineWidth: 1,
        priceLineVisible: false,
        lastValueVisible: false,
        crosshairMarkerVisible: false,
        title: l.label,
      });
      s.setData(
        bars.flatMap((b, i) => {
          const v = l.values[i];
          return v === null || v === undefined || !Number.isFinite(v)
            ? []
            : [{ time: sec(b.time), value: v }];
        }),
      );
      return s;
    });
    chart.timeScale().fitContent();
  }, [bars, lines]);

  // Every entry and exit, and where the held-out period starts.
  useEffect(() => {
    const host = hostRef.current;
    const markers = markersRef.current;
    if (!host || !markers) return;
    const t = tokens(host);
    const times = bars.map((b) => b.time);
    const out: SeriesMarker<Time>[] = [];
    for (const tr of trades) {
      const open = snap(times, tr.openTime);
      const close = snap(times, tr.closeTime);
      const long = tr.side === "long";
      if (open !== undefined) {
        out.push({
          time: sec(open),
          position: long ? "belowBar" : "aboveBar",
          shape: long ? "arrowUp" : "arrowDown",
          color: long ? t.buy : t.sell,
          text: tr.n === focus ? `#${tr.n}` : "",
        });
      }
      if (close !== undefined) {
        out.push({
          time: sec(close),
          position: long ? "aboveBar" : "belowBar",
          shape: long ? "arrowDown" : "arrowUp",
          color: long ? t.sell : t.buy,
          text: `${tr.r >= 0 ? "+" : ""}${tr.r.toFixed(1)}R`,
          size: tr.n === focus ? 1.4 : 0.8,
        });
      }
    }
    const split = holdOutFrom === undefined ? undefined : bars[holdOutFrom];
    if (split) {
      out.push({
        time: sec(split.time),
        position: "aboveBar",
        shape: "square",
        color: t.info,
        text: holdOutLabel ?? "",
      });
    }
    out.sort((a, b) => (a.time as number) - (b.time as number));
    markers.setMarkers(out);
  }, [bars, trades, holdOutFrom, holdOutLabel, focus]);

  // The focused trade: scrolled to, its entry and stop drawn.
  useEffect(() => {
    const chart = chartRef.current;
    const candles = candleRef.current;
    const host = hostRef.current;
    if (!chart || !candles || !host) return;
    for (const l of priceLines.current) candles.removePriceLine(l);
    priceLines.current = [];
    const tr = trades.find((x) => x.n === focus);
    if (!tr || bars.length === 0) {
      chart.timeScale().fitContent();
      return;
    }
    const t = tokens(host);
    priceLines.current.push(
      candles.createPriceLine({
        price: tr.entry,
        color: t.line,
        lineWidth: 1,
        lineStyle: LineStyle.Dashed,
        axisLabelVisible: true,
        title: `#${tr.n}`,
      }),
    );
    if (tr.stop !== undefined) {
      priceLines.current.push(
        candles.createPriceLine({
          price: tr.stop,
          color: t.sell,
          lineWidth: 1,
          lineStyle: LineStyle.Dotted,
          axisLabelVisible: true,
          title: stopLabel ?? "stop",
        }),
      );
    }
    const step = bars.length > 1 ? (bars[1]?.time ?? 0) - (bars[0]?.time ?? 0) : 3_600_000;
    const held = Math.max(step, tr.closeTime - tr.openTime);
    const pad = Math.max(held * 1.5, step * 30);
    chart.timeScale().setVisibleRange({
      from: sec(Math.max(bars[0]?.time ?? 0, tr.openTime - pad)),
      to: sec(Math.min(bars.at(-1)?.time ?? tr.closeTime, tr.closeTime + pad)),
    });
  }, [focus, trades, bars, stopLabel]);

  // The focused trade's span, shaded and labelled; placed again as the chart moves.
  useEffect(() => {
    const place = () => {
      const chart = chartRef.current;
      const tr = tradesRef.current.find((x) => x.n === focus);
      if (!chart || !tr) {
        setBox(undefined);
        return;
      }
      const times = bars.map((b) => b.time);
      const open = snap(times, tr.openTime);
      const close = snap(times, tr.closeTime);
      const scale = chart.timeScale();
      const a = open === undefined ? null : scale.timeToCoordinate(sec(open));
      const b = close === undefined ? null : scale.timeToCoordinate(sec(close));
      if (a === null && b === null) {
        setBox(undefined);
        return;
      }
      const width = scale.width();
      const left = Math.max(0, a ?? 0);
      const right = Math.min(width, b ?? width);
      setBox(right > left ? { left, width: right - left } : undefined);
    };
    placeRef.current = place;
    place();
  }, [focus, bars]);

  // A range asked for from outside (the equity strip's window).
  useEffect(() => {
    if (view) chartRef.current?.timeScale().setVisibleLogicalRange(view);
  }, [view]);

  return (
    <div className={className ?? "pd-bt-chart"}>
      <div ref={hostRef} className="pd-bt-chart-host" />
      {box && (
        <div
          className="pd-bt-focus"
          style={{ left: box.left, width: box.width }}
          aria-hidden="true"
        >
          {focusLabel && <span>{focusLabel}</span>}
        </div>
      )}
    </div>
  );
}

export interface EquityLine {
  label: string;
  values: readonly number[];
  /** A CSS colour the canvas can paint, or a token's name. */
  color: "brass" | "muted" | "info" | (string & {});
  dashed?: boolean;
}

/**
 * Equity over the run, against holding the market, with each line's fall
 * from its own high in a pane beneath.
 */
export function EquityChart({
  times,
  lines,
  drawdownOf = 0,
  money,
  className,
}: {
  /** One per value, ms. */
  times: readonly number[];
  lines: readonly EquityLine[];
  /** Which line's drawdown fills the lower pane; -1 for none. */
  drawdownOf?: number;
  money: (v: number) => string;
  className?: string;
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  const fmt = useRef(money);
  fmt.current = money;

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const t = tokens(host);
    const chart = createChart(host, {
      ...chartOptions(t),
      autoSize: true,
      grid: { vertLines: { visible: false }, horzLines: { color: t.grid } },
    });
    const paint = (c: string) => (c in t ? t[c as keyof typeof t] : c);
    for (const l of lines) {
      const s = chart.addSeries(LineSeries, {
        color: paint(l.color),
        lineWidth: l.dashed ? 1 : 2,
        lineStyle: l.dashed ? LineStyle.Dashed : LineStyle.Solid,
        priceLineVisible: false,
        lastValueVisible: true,
        title: l.label,
        priceFormat: { type: "custom", formatter: (v: number) => fmt.current(v), minMove: 0.01 },
      });
      s.setData(
        times
          .map((ms, i) => ({ time: sec(ms), value: l.values[i] ?? Number.NaN }))
          .filter((p) => Number.isFinite(p.value)),
      );
    }
    const of = lines[drawdownOf];
    if (of) {
      let peak = -Infinity;
      const dd = of.values.map((v) => {
        peak = Math.max(peak, v);
        return peak > 0 ? (v / peak - 1) * 100 : 0;
      });
      const area = chart.addSeries(
        AreaSeries,
        {
          lineColor: t.sell,
          topColor: withAlpha(t.sell, 0.05),
          bottomColor: withAlpha(t.sell, 0.35),
          lineWidth: 1,
          priceLineVisible: false,
          invertFilledArea: true,
          priceFormat: {
            type: "custom",
            formatter: (v: number) => `${v.toFixed(1)}%`,
            minMove: 0.01,
          },
        },
        1,
      );
      area.setData(times.map((ms, i) => ({ time: sec(ms), value: dd[i] ?? 0 })));
      const panes = chart.panes();
      panes[1]?.setHeight(Math.max(60, Math.round(host.clientHeight * 0.26)));
    }
    chart.timeScale().fitContent();
    return () => chart.remove();
  }, [times, lines, drawdownOf]);

  return <div ref={hostRef} className={className ?? "pd-bt-equity"} />;
}

/** Each month's return as a bar (green up, red down), holding's as a line over them. */
export function MonthlyChart({
  months,
  className,
  labels,
}: {
  /** The month's first day (ms), its return and holding's, as fractions. */
  months: readonly { at: number; ret: number; hold: number }[];
  labels: { run: string; hold: string };
  className?: string;
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const t = tokens(host);
    const chart = createChart(host, {
      ...chartOptions(t),
      autoSize: true,
      grid: { vertLines: { visible: false }, horzLines: { color: t.grid } },
      timeScale: { borderColor: t.border, timeVisible: false },
    });
    const pctFmt = {
      type: "custom" as const,
      formatter: (v: number) => `${v.toFixed(1)}%`,
      minMove: 0.01,
    };
    const bars = chart.addSeries(HistogramSeries, {
      priceFormat: pctFmt,
      priceLineVisible: false,
      title: labels.run,
    });
    bars.setData(
      months.map((m) => ({
        time: sec(m.at),
        value: m.ret * 100,
        color: withAlpha(m.ret >= 0 ? t.buy : t.sell, 0.75),
      })),
    );
    const hold = chart.addSeries(LineSeries, {
      color: t.muted,
      lineWidth: 1,
      lineStyle: LineStyle.Dashed,
      pointMarkersVisible: true,
      priceLineVisible: false,
      lastValueVisible: false,
      title: labels.hold,
      priceFormat: pctFmt,
    });
    hold.setData(months.map((m) => ({ time: sec(m.at), value: m.hold * 100 })));
    chart.timeScale().fitContent();
    return () => chart.remove();
  }, [months, labels]);
  return <div ref={hostRef} className={className ?? "pd-bt-monthly"} />;
}

export interface PeriodSeries {
  label: string;
  /** A token's name, so themes apply. */
  tone: "line" | "brass" | "info" | "warning" | "muted";
  /** Closes, oldest first; `time` in ms. */
  points: readonly { time: number; value: number }[];
}

/**
 * Markets over a backtest's period. One market: its closes, the days it's
 * tuned on in the theme's text and the held-out days in the info colour.
 * Several: each as its change from the start (%), a line of its own, and
 * a marker where the held-out days begin.
 */
export function PeriodChart({
  series,
  holdOutFrom,
  heldOutLabel,
  className,
}: {
  series: readonly PeriodSeries[];
  /** The first held-out day (ms); none when nothing is held out. */
  holdOutFrom?: number;
  heldOutLabel?: string;
  className?: string;
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const t = tokens(host);
    const many = series.length > 1;
    const chart = createChart(host, {
      ...chartOptions(t),
      autoSize: true,
      grid: { vertLines: { visible: false }, horzLines: { visible: false } },
      rightPriceScale: { visible: many, borderVisible: false },
      timeScale: { borderColor: t.border, timeVisible: false },
      handleScroll: false,
      handleScale: false,
    });
    const style = {
      priceLineVisible: false,
      lastValueVisible: false,
      crosshairMarkerVisible: false,
    };
    const split = holdOutFrom ?? Number.POSITIVE_INFINITY;
    if (!many) {
      const points = series[0]?.points ?? [];
      const tuned = chart.addSeries(AreaSeries, {
        ...style,
        lineWidth: 2,
        lineColor: t.line,
        topColor: withAlpha(t.line, 0.12),
        bottomColor: withAlpha(t.line, 0),
      });
      // The held-out line starts on the last tuned day, so the two meet.
      const lastIn = points.reduce((i, p, k) => (p.time < split ? k : i), -1);
      tuned.setData(
        points.slice(0, lastIn + 1).map((p) => ({ time: sec(p.time), value: p.value })),
      );
      if (lastIn < points.length - 1) {
        const out = chart.addSeries(AreaSeries, {
          ...style,
          lineWidth: 2,
          lineColor: t.info,
          topColor: withAlpha(t.info, 0.16),
          bottomColor: withAlpha(t.info, 0),
        });
        out.setData(
          points.slice(Math.max(0, lastIn)).map((p) => ({ time: sec(p.time), value: p.value })),
        );
      }
    } else {
      const pctFormat = {
        type: "custom" as const,
        formatter: (v: number) => `${v >= 0 ? "+" : ""}${v.toFixed(0)}%`,
        minMove: 0.01,
      };
      series.forEach((s, k) => {
        const base = s.points[0]?.value;
        if (!base) return;
        const line = chart.addSeries(LineSeries, {
          ...style,
          lineWidth: 2,
          color: t[s.tone],
          priceFormat: pctFormat,
        });
        line.setData(
          s.points.map((p) => ({ time: sec(p.time), value: (p.value / base - 1) * 100 })),
        );
        // Where the held-out days begin, once, on the first line.
        const at = s.points.find((p) => p.time >= split);
        if (k === 0 && at) {
          createSeriesMarkers(line, [
            {
              time: sec(at.time),
              position: "aboveBar",
              shape: "square",
              color: t.info,
              text: heldOutLabel ?? "",
            },
          ]);
        }
      });
    }
    chart.timeScale().fitContent();
    return () => chart.remove();
  }, [series, holdOutFrom, heldOutLabel]);
  return <div ref={hostRef} className={className ?? "pd-bt-period"} />;
}

/**
 * A run's equity as a small line, for a list: no axes, no grid, nothing to
 * scroll. Brass when it made money, the quiet colour when it didn't.
 */
export function SparkChart({
  times,
  values,
  className,
}: {
  /** One per value, ms. */
  times: readonly number[];
  values: readonly number[];
  className?: string;
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const host = hostRef.current;
    if (!host || values.length < 2) return;
    const t = tokens(host);
    const up = (values.at(-1) ?? 0) >= (values[0] ?? 0);
    const chart = createChart(host, {
      ...chartOptions(t),
      autoSize: true,
      layout: {
        ...chartOptions(t).layout,
        background: { type: ColorType.Solid, color: "transparent" },
      },
      grid: { vertLines: { visible: false }, horzLines: { visible: false } },
      rightPriceScale: { visible: false },
      leftPriceScale: { visible: false },
      timeScale: { visible: false, borderVisible: false },
      crosshair: { vertLine: { visible: false }, horzLine: { visible: false } },
      handleScroll: false,
      handleScale: false,
    });
    const line = chart.addSeries(LineSeries, {
      color: up ? t.brass : t.muted,
      lineWidth: 1,
      priceLineVisible: false,
      lastValueVisible: false,
      crosshairMarkerVisible: false,
    });
    // Times can repeat once thinned: one point per time.
    const seen = new Set<number>();
    line.setData(
      times.flatMap((ms, i) => {
        const time = sec(ms);
        const value = values[i];
        if (seen.has(time) || value === undefined || !Number.isFinite(value)) return [];
        seen.add(time);
        return [{ time, value }];
      }),
    );
    chart.timeScale().fitContent();
    return () => chart.remove();
  }, [times, values]);
  return <div ref={hostRef} className={className ?? "pd-bt-spark"} aria-hidden="true" />;
}

/**
 * The whole run in a strip: equity against holding, the fall from each high
 * beneath, the held-out days shaded, and a window over the candles the price
 * chart shows. Dragging the window (or its edges) moves the price chart; a
 * click elsewhere centres it there.
 */
export function EquityStrip({
  equity,
  buyHold,
  holdOutFrom,
  holdOutLabel,
  window: win,
  onWindow,
  money,
  label,
  className,
}: {
  /** One per candle. */
  equity: readonly number[];
  buyHold: readonly number[];
  /** The first held-out candle's index; none when nothing is held out. */
  holdOutFrom?: number;
  holdOutLabel?: string;
  /** The price chart's candles, by index. */
  window?: { from: number; to: number };
  onWindow?: (from: number, to: number) => void;
  money: (v: number) => string;
  /** For assistive tech: what the strip is. */
  label: string;
  className?: string;
}) {
  const n = equity.length;
  const W = 1000;
  const TOP = 64;
  const DD = 26;
  const H = TOP + 6 + DD;
  const values = [...equity, ...buyHold].filter(Number.isFinite);
  const lo = values.length ? Math.min(...values) : 0;
  const hi = values.length ? Math.max(...values) : 1;
  const pad = (hi - lo) * 0.08 || 1;
  const yLo = lo - pad;
  const yHi = hi + pad;
  const x = (i: number) => (n > 1 ? (i / (n - 1)) * W : 0);
  const y = (v: number) => TOP - ((v - yLo) / (yHi - yLo)) * TOP;
  const path = (vs: readonly number[]) =>
    vs
      .map((v, i) =>
        Number.isFinite(v) ? `${i === 0 ? "M" : "L"}${x(i).toFixed(1)},${y(v).toFixed(1)}` : "",
      )
      .join("");
  const falls = (vs: readonly number[]) => {
    let peak = Number.NEGATIVE_INFINITY;
    return vs.map((v) => {
      peak = Math.max(peak, v);
      return peak > 0 ? v / peak - 1 : 0;
    });
  };
  const dd = falls(equity);
  const holdDd = falls(buyHold);
  const worst = Math.min(-0.0001, ...dd, ...holdDd);
  const ddY = (f: number) => TOP + 6 + (f / worst) * DD;
  const area = (fs: readonly number[]) =>
    `M0,${TOP + 6}${fs.map((f, i) => `L${x(i).toFixed(1)},${ddY(f).toFixed(1)}`).join("")}L${W},${TOP + 6}Z`;

  const hostRef = useRef<HTMLDivElement>(null);
  const drag = useRef<{ mode: "move" | "left" | "right"; at: number; from: number; to: number }>(
    undefined,
  );
  const span = win ? Math.max(1, win.to - win.from) : Math.max(10, Math.round(n * 0.15));
  const clampWin = (from: number, to: number) => {
    const w = to - from;
    const f = Math.max(0, Math.min(n - 1 - w, from));
    return { from: f, to: f + w };
  };
  const indexAt = (clientX: number) => {
    const r = hostRef.current?.querySelector("svg")?.getBoundingClientRect();
    if (!r || r.width === 0) return 0;
    return ((clientX - r.left) / r.width) * (n - 1);
  };
  const onDown = (e: PointerEvent) => {
    if (!onWindow || n < 2) return;
    const at = indexAt(e.clientX);
    const from = win?.from ?? 0;
    const to = win?.to ?? span;
    const edge = (8 / Math.max(1, hostRef.current?.clientWidth ?? 1)) * (n - 1);
    let mode: "move" | "left" | "right" = "move";
    if (win && Math.abs(at - from) <= edge) mode = "left";
    else if (win && Math.abs(at - to) <= edge) mode = "right";
    else if (!win || at < from || at > to) {
      const c = clampWin(at - span / 2, at + span / 2);
      onWindow(c.from, c.to);
      drag.current = { mode: "move", at, from: c.from, to: c.to };
      e.currentTarget.setPointerCapture(e.pointerId);
      return;
    }
    drag.current = { mode, at, from, to };
    e.currentTarget.setPointerCapture(e.pointerId);
  };
  const onMove = (e: PointerEvent) => {
    const d = drag.current;
    if (!d || !onWindow) return;
    const delta = indexAt(e.clientX) - d.at;
    if (d.mode === "move") {
      const c = clampWin(d.from + delta, d.to + delta);
      onWindow(c.from, c.to);
    } else if (d.mode === "left") {
      onWindow(Math.max(0, Math.min(d.to - 5, d.from + delta)), d.to);
    } else {
      onWindow(d.from, Math.min(n - 1, Math.max(d.from + 5, d.to + delta)));
    }
  };
  const onUp = () => {
    drag.current = undefined;
  };
  const onKey = (e: KeyboardEvent) => {
    if (!onWindow || !win) return;
    const step = Math.max(1, Math.round(span / 4));
    if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
      e.preventDefault();
      const by = e.key === "ArrowLeft" ? -step : step;
      const c = clampWin(win.from + by, win.to + by);
      onWindow(c.from, c.to);
    }
  };

  const pctOf = (i: number) => `${(Math.max(0, Math.min(n - 1, i)) / Math.max(1, n - 1)) * 100}%`;
  const out = holdOutFrom !== undefined && holdOutFrom < n ? holdOutFrom : undefined;
  const start = equity[0] ?? 0;
  const top = Math.max(...values.filter(Number.isFinite), start);

  return (
    <div className={className ?? "pd-bt-strip"}>
      <div
        ref={hostRef}
        className="pd-bt-strip-plot"
        role="slider"
        tabIndex={0}
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={Math.max(0, n - 1)}
        aria-valuenow={Math.round(win?.from ?? 0)}
        onPointerDown={onDown}
        onPointerMove={onMove}
        onPointerUp={onUp}
        onPointerCancel={onUp}
        onKeyDown={onKey}
      >
        <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" aria-hidden="true">
          {out !== undefined && (
            <rect className="pd-bt-strip-out" x={x(out)} y={0} width={W - x(out)} height={H} />
          )}
          <line className="pd-bt-strip-base" x1={0} x2={W} y1={y(start)} y2={y(start)} />
          <path className="pd-bt-strip-hold-dd" d={area(holdDd)} />
          <path className="pd-bt-strip-dd" d={area(dd)} />
          <path className="pd-bt-strip-hold" d={path(buyHold)} />
          <path className="pd-bt-strip-run" d={path(equity)} />
          {out !== undefined && (
            <line className="pd-bt-strip-split" x1={x(out)} x2={x(out)} y1={0} y2={H} />
          )}
        </svg>
        {out !== undefined && holdOutLabel && (
          <span className="pd-bt-strip-outlabel" style={{ left: pctOf(out) }}>
            {holdOutLabel}
          </span>
        )}
        {win && n > 1 && (
          <div
            className="pd-bt-strip-win"
            style={{
              left: pctOf(win.from),
              width: `calc(${pctOf(win.to)} - ${pctOf(win.from)})`,
            }}
          >
            <i />
            <i />
          </div>
        )}
      </div>
      <div className="pd-bt-strip-axis" aria-hidden="true">
        <span style={{ top: `${(y(top) / H) * 100}%` }}>{money(top)}</span>
        <span style={{ top: `${(y(start) / H) * 100}%` }}>{money(start)}</span>
        <span style={{ top: `${((TOP + 6) / H) * 100}%` }}>0%</span>
        <span style={{ top: "100%" }}>{`${(worst * 100).toFixed(0)}%`}</span>
      </div>
    </div>
  );
}
