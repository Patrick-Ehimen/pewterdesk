import { type ReactNode, useEffect, useRef, useState } from "react";
import { dateFormat, t } from "../../i18n";
import { formatCompact, formatNumber } from "../../lib/format";
import type { BookColumn } from "../../lib/mapStats";
import { HoverCard, MapFrame, MapState, useSize } from "./kit";

export type BookSpan = "0.5" | "1" | "2";
export const BOOK_SPANS: readonly BookSpan[] = ["0.5", "1", "2"];

/** Columns the width holds at least, so the first few aren't each a wide band. */
const MIN_COLUMNS = 30;
/** Width kept free on the right for the price labels. */
const AXIS = 64;

/**
 * The order book's resting liquidity over time, after Bookmap: a column a
 * second, brighter where more size rests at a price, with the mid price
 * drawn through it. Walls that hold, pull or get eaten show as bands that
 * last, vanish or get crossed.
 */
export function BookHeatmap({
  columns,
  capacity,
  top,
  step,
  rows,
  decimals,
  controls,
  loader,
  error,
}: {
  /** Oldest first. */
  columns: readonly BookColumn[];
  /** The most columns across the width (the oldest scroll off past it). */
  capacity: number;
  /** The top row's lower edge, and each row's height in price. */
  top: number;
  step: number;
  rows: number;
  decimals: number;
  controls?: ReactNode;
  loader?: ReactNode;
  error?: string;
}) {
  const [ref, size] = useSize<HTMLDivElement>();
  const canvas = useRef<HTMLCanvasElement>(null);
  const [hover, setHover] = useState<{ x: number; y: number; col: number; row: number }>();
  const plotW = Math.max(size.width - AXIS, 1);
  const plotH = Math.max(size.height, 1);
  // Fewer columns stretch across the width until there are `capacity` of
  // them, so the map is full from the first seconds rather than a sliver.
  const across = Math.min(capacity, Math.max(columns.length, MIN_COLUMNS));
  const colW = plotW / across;
  const rowH = plotH / rows;
  const offset = across - columns.length;

  useEffect(() => {
    const el = canvas.current;
    if (!el || size.width === 0) return;
    const ratio = window.devicePixelRatio || 1;
    el.width = Math.round(plotW * ratio);
    el.height = Math.round(plotH * ratio);
    const ctx = el.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    ctx.clearRect(0, 0, plotW, plotH);
    const css = getComputedStyle(el);
    const hot = css.getPropertyValue("--pd-warning").trim() || "orange";
    const warm = css.getPropertyValue("--pd-info").trim() || "steelblue";
    const line = css.getPropertyValue("--pd-text").trim() || "white";
    // Scale to the bigger cells, so one huge wall doesn't wash out the rest.
    const values: number[] = [];
    for (const c of columns) for (const v of c.rows) if (v > 0) values.push(v);
    values.sort((a, b) => a - b);
    const full = values[Math.floor(values.length * 0.97)] ?? 1;
    columns.forEach((c, i) => {
      const x = (offset + i) * colW;
      c.rows.forEach((v, r) => {
        if (!(v > 0)) return;
        const s = Math.min(v / full, 1);
        ctx.globalAlpha = 0.15 + s * 0.85;
        ctx.fillStyle = s > 0.6 ? hot : warm;
        ctx.fillRect(x, r * rowH, Math.ceil(colW), Math.ceil(rowH));
      });
    });
    ctx.globalAlpha = 1;
    ctx.strokeStyle = line;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    columns.forEach((c, i) => {
      const x = (offset + i + 0.5) * colW;
      const y = ((top + step - c.mid) / step) * rowH;
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    ctx.stroke();
  }, [columns, size.width, plotW, plotH, colW, rowH, offset, top, step]);

  /** The middle of a row's price band (row 0 sits just above `top`). */
  const priceAt = (row: number) => top + step * (0.5 - row);
  const ticks = Array.from({ length: 6 }, (_, i) => Math.round((i / 5) * (rows - 1)));
  const tipCol = hover ? columns[hover.col - offset] : undefined;
  const clock = dateFormat({
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
  const last = columns[columns.length - 1];

  return (
    <MapFrame
      title={t("mapx.book.title")}
      controls={controls}
      legend={
        last && (
          <span className="pd-num">
            {t("mapx.book.mid", { price: formatNumber(last.mid, decimals) })}
          </span>
        )
      }
      note={t("mapx.book.note")}
      state={
        error ? (
          <MapState error={error} />
        ) : columns.length === 0 ? (
          <MapState loader={loader} />
        ) : undefined
      }
    >
      <div
        ref={ref}
        className="pd-mx-fill pd-mx-book"
        onPointerMove={(e) => {
          const box = e.currentTarget.getBoundingClientRect();
          const x = e.clientX - box.left;
          const y = e.clientY - box.top;
          if (x > plotW) return setHover(undefined);
          setHover({ x, y, col: Math.floor(x / colW), row: Math.floor(y / rowH) });
        }}
        onPointerLeave={() => setHover(undefined)}
      >
        <canvas
          ref={canvas}
          style={{ width: plotW, height: plotH }}
          aria-label={t("mapx.book.title")}
        />
        <div className="pd-mx-book-axis" style={{ width: AXIS }} aria-hidden>
          {ticks.map((r) => (
            <span key={r} className="pd-num pd-mx-book-tick" style={{ top: (r + 0.5) * rowH }}>
              {formatNumber(priceAt(r), decimals)}
            </span>
          ))}
        </div>
        {hover && tipCol && (
          <HoverCard at={hover} box={size}>
            <dl>
              <dt>{t("col.price")}</dt>
              <dd className="pd-num">{formatNumber(priceAt(hover.row), decimals)}</dd>
              <dt>{t("mapx.book.resting")}</dt>
              <dd className="pd-num">${formatCompact(tipCol.rows[hover.row] ?? 0)}</dd>
              <dt>{t("liq.time")}</dt>
              <dd className="pd-num">{clock.format(tipCol.time)}</dd>
            </dl>
          </HoverCard>
        )}
      </div>
    </MapFrame>
  );
}
