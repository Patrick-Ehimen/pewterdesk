import {
  BaselineSeries,
  createChart,
  type IChartApi,
  type ISeriesApi,
  LineSeries,
  LineStyle,
  type MouseEventParams,
  type UTCTimestamp,
} from "lightweight-charts";
import { useEffect, useRef, useState } from "react";
import { dateFormat, t as tr } from "../../i18n";
import { formatSigned } from "../../lib/format";
import {
  annualised,
  BUCKET_MS,
  type FundingPoint,
  type FundingResolution,
} from "../../lib/funding";
import { FloatingTip, TipRows } from "../common/Tooltip";
import { chartOptions, type Tokens, tokens } from "./chartTheme";

const toTime = (ms: number) => Math.floor(ms / 1000) as UTCTimestamp;
/** Funding is tiny: four decimals of a percent for a period, two for the running total. */
const pct = (decimals: number) => (v: number) => `${(v * 100).toFixed(decimals)}%`;
const RATE_DECIMALS = 4;
const TOTAL_DECIMALS = 2;

function seriesStyles(t: Tokens) {
  return {
    rate: {
      topLineColor: t.buy,
      bottomLineColor: t.sell,
      // Lines only, as in the design; no fills.
      topFillColor1: "transparent",
      topFillColor2: "transparent",
      bottomFillColor1: "transparent",
      bottomFillColor2: "transparent",
    },
    total: { color: t.line },
  };
}

/**
 * The hovered period, e.g. "27 Sep, 08:00–16:00 UTC", or "27 Sep" for a day.
 * UTC, like the chart's axis and the periods themselves.
 */
function periodLabel(time: number, resolution: FundingResolution): string {
  const day = dateFormat({ day: "numeric", month: "short", timeZone: "UTC" }).format(time);
  if (resolution === "1d") return day;
  const hm = dateFormat({ hour: "2-digit", minute: "2-digit", hour12: false, timeZone: "UTC" });
  return `${day}, ${hm.format(time)}–${hm.format(time + BUCKET_MS[resolution])} UTC`;
}

/** Hovered period's tooltip: when, the rate, as a yearly rate, the running total, who paid. */
function FundingTip({ point, resolution }: { point: FundingPoint; resolution: FundingResolution }) {
  return (
    <TipRows
      title={periodLabel(point.time, resolution)}
      side={point.rate >= 0 ? "bid" : "ask"}
      rows={[
        [tr("funding.rate"), `${formatSigned(point.rate * 100, RATE_DECIMALS)}%`],
        [tr("heatmap.annual"), `${formatSigned(annualised(point.rate, resolution) * 100)}%`],
        [tr("funding.cumulative"), `${formatSigned(point.cumulative * 100, TOTAL_DECIMALS)}%`],
        [tr("heatmap.paid"), tr(point.rate >= 0 ? "heatmap.longsPaid" : "heatmap.shortsPaid")],
      ]}
    />
  );
}

interface FundingChartProps {
  points: FundingPoint[];
  /** The periods' length, for the tooltip's time span and yearly rate. */
  resolution: FundingResolution;
  /** Changes with the market or resolution, so the view refits. */
  seriesKey: string;
}

/**
 * Funding over time: each period's rate on the left axis (green where longs
 * paid, red where shorts did, split at zero), and the running total on the
 * right. Hover to read a period; otherwise the latest shows.
 */
export function FundingChart({ points, resolution, seriesKey }: FundingChartProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi>(null);
  const rateRef = useRef<ISeriesApi<"Baseline">>(null);
  const totalRef = useRef<ISeriesApi<"Line">>(null);
  const fitted = useRef("");
  const [hovered, setHovered] = useState<number>();
  /** Where the crosshair is in the plot, for the tooltip's anchor; unset off the plot. */
  const [pointer, setPointer] = useState<{ x: number; y: number }>();
  const anchorRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const t = tokens(host);
    const styles = seriesStyles(t);
    const chart = createChart(host, {
      ...chartOptions(t),
      autoSize: true,
      leftPriceScale: { visible: true, borderColor: t.border },
      rightPriceScale: { visible: true, borderColor: t.border },
    });
    const rate = chart.addSeries(BaselineSeries, {
      ...styles.rate,
      priceScaleId: "left",
      baseValue: { type: "price", price: 0 },
      lineWidth: 2,
      priceLineVisible: false,
      lastValueVisible: false,
      priceFormat: { type: "custom", formatter: pct(RATE_DECIMALS), minMove: 1e-8 },
    });
    // The zero line the colors split at, dotted as in the design.
    const zero = rate.createPriceLine({
      price: 0,
      color: t.crosshair,
      lineStyle: LineStyle.Dotted,
      lineWidth: 1,
      axisLabelVisible: false,
    });
    const total = chart.addSeries(LineSeries, {
      ...styles.total,
      priceScaleId: "right",
      lineWidth: 2,
      priceLineVisible: false,
      lastValueVisible: false,
      priceFormat: { type: "custom", formatter: pct(TOTAL_DECIMALS), minMove: 1e-6 },
    });
    chart.priceScale("left").applyOptions({ scaleMargins: { top: 0.08, bottom: 0.08 } });
    chart.priceScale("right").applyOptions({ scaleMargins: { top: 0.08, bottom: 0.08 } });
    chartRef.current = chart;
    rateRef.current = rate;
    totalRef.current = total;

    const onCrosshair = (param: MouseEventParams) => {
      const time = typeof param.time === "number" ? param.time * 1000 : undefined;
      setHovered(time);
      setPointer(time !== undefined && param.point ? param.point : undefined);
    };
    chart.subscribeCrosshairMove(onCrosshair);

    const restyle = () => {
      const next = tokens(host);
      const s = seriesStyles(next);
      chart.applyOptions({
        ...chartOptions(next),
        leftPriceScale: { borderColor: next.border },
        rightPriceScale: { borderColor: next.border },
      });
      rate.applyOptions(s.rate);
      total.applyOptions(s.total);
      zero.applyOptions({ color: next.crosshair });
    };
    const observer = new MutationObserver(restyle);
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["data-theme", "data-market"],
    });
    return () => {
      observer.disconnect();
      chart.unsubscribeCrosshairMove(onCrosshair);
      chart.remove();
      chartRef.current = null;
      rateRef.current = null;
      totalRef.current = null;
      fitted.current = "";
    };
  }, []);

  // A few hundred points at most, so every change just redraws them all.
  useEffect(() => {
    const rate = rateRef.current;
    const total = totalRef.current;
    if (!rate || !total) return;
    rate.setData(points.map((p) => ({ time: toTime(p.time), value: p.rate })));
    total.setData(points.map((p) => ({ time: toTime(p.time), value: p.cumulative })));
    if (fitted.current !== seriesKey) {
      chartRef.current?.timeScale().fitContent();
      fitted.current = seriesKey;
    }
  }, [points, seriesKey]);

  const hoveredPoint = hovered === undefined ? undefined : points.find((p) => p.time === hovered);
  const shown = hoveredPoint || points.at(-1);
  // Point the tooltip at the funding line itself, at the hovered period.
  const lineY = hoveredPoint ? rateRef.current?.priceToCoordinate(hoveredPoint.rate) : null;
  const anchor = pointer && { x: pointer.x, y: lineY ?? pointer.y };

  return (
    <div className="pd-funding-chart">
      {/* A row of its own above the plot, clear of both price axes. */}
      <div className="pd-funding-legends">
        <div className="pd-funding-legend">
          <span className="pd-funding-swatch" data-kind="rate" aria-hidden />
          <span>{tr("funding.rate")}</span>
          {shown && (
            <span className="pd-num" data-trend={shown.rate >= 0 ? "up" : "down"}>
              {pct(RATE_DECIMALS)(shown.rate)}
            </span>
          )}
        </div>
        <div className="pd-funding-legend">
          <span className="pd-funding-swatch" data-kind="total" aria-hidden />
          <span>{tr("funding.cumulative")}</span>
          {shown && <span className="pd-num">{pct(TOTAL_DECIMALS)(shown.cumulative)}</span>}
        </div>
      </div>
      <div className="pd-funding-plot">
        <div ref={hostRef} className="pd-candle-host" />
        {anchor && (
          <div
            ref={anchorRef}
            className="pd-funding-anchor"
            style={{ left: anchor.x, top: anchor.y }}
            aria-hidden
          />
        )}
      </div>
      {hoveredPoint && anchor && (
        <FloatingTip getAnchor={() => anchorRef.current} axis="horizontal" className="pd-tip-row">
          <FundingTip point={hoveredPoint} resolution={resolution} />
        </FloatingTip>
      )}
    </div>
  );
}
