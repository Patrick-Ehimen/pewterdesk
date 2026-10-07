import { type ReactNode, useEffect, useRef, useState } from "react";
import { dateFormat, t } from "../../i18n";
import { formatCompact, formatNumber } from "../../lib/format";
import type { LiqMap } from "../../lib/liqModel";
import { EmptyState } from "../common/Status";

const PAD = { top: 10, right: 76, bottom: 26, left: 56 };
const DAY_HOUR: Intl.DateTimeFormatOptions = { month: "short", day: "numeric", hour: "2-digit" };

/** Width and height of an element, tracked as it resizes. */
function useSize<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const observer = new ResizeObserver(([entry]) => {
      if (entry) setSize({ width: entry.contentRect.width, height: entry.contentRect.height });
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  return [ref, size] as const;
}

/** The theme's colours, read at draw time so a theme switch repaints right. */
function palette(el: HTMLElement) {
  const css = getComputedStyle(el);
  const v = (name: string) => css.getPropertyValue(name).trim();
  return {
    bg: v("--pd-bg"),
    low: v("--pd-info"),
    high: v("--pd-brass"),
    hot: v("--pd-text"),
    up: v("--pd-buy"),
    down: v("--pd-sell"),
    grid: v("--pd-border"),
    text: v("--pd-pewter"),
  };
}

/** A CSS colour as [r, g, b], through a canvas (which normalises any syntax). */
function rgb(ctx: CanvasRenderingContext2D, color: string): [number, number, number] {
  ctx.fillStyle = "#000";
  ctx.fillStyle = color;
  const parsed = ctx.fillStyle;
  if (parsed.startsWith("#")) {
    const n = Number.parseInt(parsed.slice(1, 7), 16);
    return [n >> 16, (n >> 8) & 255, n & 255];
  }
  const [r = 0, g = 0, b = 0] = parsed.match(/[\d.]+/g)?.map(Number) ?? [];
  return [r, g, b];
}

const mix = (a: number[], b: number[], k: number) => a.map((x, i) => x + ((b[i] ?? 0) - x) * k);

interface LiqHeatmapProps {
  map?: LiqMap;
  loading: boolean;
  /** Above the chart, e.g. the market picker and the span. */
  controls: ReactNode;
  /** Shown while a market's history loads, e.g. the app's loading mark. */
  loader?: ReactNode;
  /** Under the chart: how the estimate was made. */
  note: string;
  error?: string;
}

/**
 * Estimated liquidation levels over time, after coinglass's liquidation
 * heatmap: brighter where more positions would be liquidated, with the
 * price's candles drawn over it. The threshold scales the colours, so smaller levels
 * show up (lower) or only the largest do (higher). It's a model's
 * estimate; see `liqModel`.
 */
export function LiqHeatmap({ map, loading, controls, loader, note, error }: LiqHeatmapProps) {
  const [ref, { width, height }] = useSize<HTMLDivElement>();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [threshold, setThreshold] = useState(0.4);
  const [hover, setHover] = useState<{ x: number; y: number; col: number; row: number }>();

  const plotW = Math.max(width - PAD.left - PAD.right, 1);
  const plotH = Math.max(height - PAD.top - PAD.bottom, 1);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !map || width === 0) return;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height * dpr);
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const p = palette(canvas);
    const bg = rgb(ctx, p.bg);
    const low = rgb(ctx, p.low);
    const high = rgb(ctx, p.high);
    const hot = rgb(ctx, p.hot);
    ctx.clearRect(0, 0, width, height);
    ctx.fillStyle = p.bg;
    ctx.fillRect(PAD.left, PAD.top, plotW, plotH);
    const cols = map.cells.length;
    const rows = map.prices.length;
    const cw = plotW / cols;
    const rh = plotH / rows;
    // The colour scale tops out at (1 - threshold) of the largest level, so a
    // higher threshold saturates sooner and leaves only the big levels lit.
    const top = map.max * Math.max(1 - threshold, 0.02);
    for (let c = 0; c < cols; c++) {
      const column = map.cells[c];
      if (!column) continue;
      for (let r = 0; r < rows; r++) {
        const v = column[r] ?? 0;
        if (v <= 0) continue;
        const k = Math.min(v / top, 1);
        const color =
          k < 0.6
            ? mix(bg, low, k / 0.6)
            : k < 0.92
              ? mix(low, high, (k - 0.6) / 0.32)
              : mix(high, hot, (k - 0.92) / 0.08);
        ctx.fillStyle = `rgb(${color.map((x) => Math.round(x)).join(",")})`;
        ctx.fillRect(
          PAD.left + c * cw,
          PAD.top + plotH - (r + 1) * rh,
          Math.ceil(cw) + 0.5,
          Math.ceil(rh) + 0.5,
        );
      }
    }
    // Row centres are evenly spaced, so the rows span half a step past each end.
    const step = (map.prices[1] ?? 0) - (map.prices[0] ?? 0);
    const lo = (map.prices[0] ?? 0) - step / 2;
    const span = rows * step;
    const yOf = (price: number) => PAD.top + plotH - ((price - lo) / (span || 1)) * plotH;
    // The price, as candles over the levels: green up, red down.
    const body = Math.max(Math.min(cw * 0.62, 12), 1);
    map.candles.forEach((k, c) => {
      const x = PAD.left + (c + 0.5) * cw;
      ctx.strokeStyle = k.close >= k.open ? p.up : p.down;
      ctx.fillStyle = ctx.strokeStyle;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(Math.round(x) + 0.5, yOf(k.high));
      ctx.lineTo(Math.round(x) + 0.5, yOf(k.low));
      ctx.stroke();
      const top = yOf(Math.max(k.open, k.close));
      const height = Math.max(yOf(Math.min(k.open, k.close)) - top, 1);
      ctx.fillRect(x - body / 2, top, body, height);
    });
    // Axes: prices on the right, times underneath.
    ctx.fillStyle = p.text;
    ctx.font = "11px ui-monospace, monospace";
    ctx.textAlign = "left";
    for (let i = 0; i <= 6; i++) {
      const price = lo + (span * i) / 6;
      const y = yOf(price);
      ctx.fillText(
        formatNumber(price, price < 1 ? 5 : price < 100 ? 3 : 0),
        PAD.left + plotW + 8,
        y + 4,
      );
    }
    ctx.textAlign = "center";
    const ticks = Math.min(6, cols);
    for (let i = 0; i < ticks; i++) {
      const c = Math.round(((cols - 1) * i) / Math.max(ticks - 1, 1));
      const time = map.times[c];
      if (time === undefined) continue;
      ctx.fillText(
        dateFormat(DAY_HOUR).format(time),
        PAD.left + (c + 0.5) * cw,
        PAD.top + plotH + 18,
      );
    }
  }, [map, width, height, threshold, plotW, plotH]);

  const hovered =
    hover && map
      ? {
          price: map.prices[hover.row] ?? 0,
          value: map.cells[hover.col]?.[hover.row] ?? 0,
          time: map.times[hover.col] ?? 0,
        }
      : undefined;

  return (
    <div className="pd-liqmap">
      <div className="pd-liqmap-bar">
        {controls}
        <label className="pd-liqmap-threshold">
          {t("liqmap.threshold", { value: formatNumber(threshold, 2) })}
          <span className="pd-leverage-slider">
            <input
              type="range"
              min={0}
              max={0.98}
              step={0.02}
              value={threshold}
              style={{ ["--pd-fill" as string]: `${(threshold / 0.98) * 100}%` }}
              onChange={(e) => setThreshold(Number(e.target.value))}
            />
          </span>
        </label>
      </div>
      <div
        ref={ref}
        className="pd-liqmap-stage"
        onPointerMove={(e) => {
          if (!map) return;
          const rect = e.currentTarget.getBoundingClientRect();
          const x = e.clientX - rect.left;
          const y = e.clientY - rect.top;
          const col = Math.floor(((x - PAD.left) / plotW) * map.cells.length);
          const row = Math.floor(((PAD.top + plotH - y) / plotH) * map.prices.length);
          if (col < 0 || col >= map.cells.length || row < 0 || row >= map.prices.length) {
            setHover(undefined);
            return;
          }
          setHover({ x, y, col, row });
        }}
        onPointerLeave={() => setHover(undefined)}
      >
        {error ? (
          <EmptyState>{error}</EmptyState>
        ) : !map ? (
          loading && loader ? (
            <div className="pd-liqmap-loading" role="status" aria-label={t("feed.loading")}>
              {loader}
            </div>
          ) : (
            <EmptyState>{loading ? t("feed.loading") : t("liqmap.empty")}</EmptyState>
          )
        ) : (
          <canvas
            ref={canvasRef}
            className="pd-liqmap-canvas"
            style={{ width, height }}
            aria-label={t("maps.liqHeatmap")}
            role="img"
          />
        )}
        {hover && hovered && (
          <div
            className="pd-map-card pd-liqmap-card"
            style={{ left: Math.min(hover.x + 14, width - 220), top: Math.max(hover.y - 70, 6) }}
            aria-hidden
          >
            <dl>
              <dt>{t("liq.time")}</dt>
              <dd className="pd-num">{dateFormat(DAY_HOUR).format(hovered.time)}</dd>
              <dt>{t("col.price")}</dt>
              <dd className="pd-num">{formatNumber(hovered.price, hovered.price < 1 ? 5 : 2)}</dd>
              <dt>{t("liqmap.level")}</dt>
              <dd className="pd-num">${formatCompact(hovered.value)}</dd>
            </dl>
          </div>
        )}
      </div>
      <p className="pd-liqmap-note">{note}</p>
    </div>
  );
}
