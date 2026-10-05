import type { OrderBook } from "@pewterdesk/core";
import { type PointerEvent, useEffect, useId, useRef, useState } from "react";
import { t } from "../../i18n";
import { avgFillTo, type DepthLevel, depthLevels, depthWithin } from "../../lib/depth";
import {
  decimalsOf,
  formatCompact,
  formatNumber,
  formatPercent,
  formatSigned,
} from "../../lib/format";

// Display-only arithmetic, as in the order book. The curves are cumulative
// notional (price × size, in the quote asset), so levels at different prices
// compare.

/** The dashed band either side of the mid, as a fraction of it: the default width. */
export const BAND = 0.005;
/** Band labels: px per character of the mono type, the gap to their line, and a row's height. */
const BAND_CHAR_W = 7;
const BAND_LABEL_GAP = 6;
const BAND_ROW_H = 34;
/** Room kept clear at the plot's edge for the venue label under an outside band label. */
const BAND_EDGE_ROOM = 48;
/** The narrowest band, and the step the arrow keys move it by (0.05%). */
const BAND_MIN = 0.0005;
const BAND_KEY = "pd.depth.band";

/** The band width last chosen on this device, or the default. */
function storedBand(): number {
  try {
    const saved = Number(localStorage.getItem(BAND_KEY));
    return Number.isFinite(saved) && saved >= BAND_MIN && saved < 1 ? saved : BAND;
  } catch {
    return BAND;
  }
}

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

/** Share of the plot's height the cumulative curves and the level bars may use. */
const CURVE_H = 0.86;
const BARS_H = 0.42;
/** The closest two level bars are ever drawn, in px. */
const BAR_PITCH_MIN = 2;

/** What the depth chart draws, as the Depth tab's settings choose. */
export interface DepthDisplay {
  /** Curves as straight runs between levels instead of steps. */
  smooth: boolean;
  grid: boolean;
  /** A bar for each level's own size, under the curves. */
  bars: boolean;
  /** Pick out the unusually large levels. */
  walls: boolean;
  /** The draggable ±band around the mid. */
  band: boolean;
  /** How many bars fit across the plot; levels closer than that share one. */
  columns: number;
}
export const DEFAULT_DEPTH_DISPLAY: DepthDisplay = {
  smooth: false,
  grid: true,
  bars: true,
  walls: true,
  band: true,
  columns: 200,
};

interface Hover {
  x: number;
  y: number;
  side: "bid" | "ask";
  level: DepthLevel;
  sideTotal: number;
}

interface DepthChartProps {
  book: OrderBook;
  /** Venue name labelling each curve, e.g. "Hyperliquid". */
  venue?: string;
  /** Base asset, e.g. "HYPE", for sizes in the detailed hover. */
  base?: string;
  /**
   * The detailed view (shown when the panel is expanded): zoomed to ±range
   * of the mid, with a mid label, a cumulative axis on the right, and a
   * hover that adds cumulative size and the average fill to reach a level.
   */
  detailed?: boolean;
  /** Half-width of the detailed view around the mid, as a fraction (0.01 = ±1%). */
  range?: number;
  /** The compact view zoomed to ±span of the mid, in place of the whole book. */
  span?: number;
  display?: DepthDisplay;
}

/**
 * The book's depth: cumulative notional stepping out from the mid (bids left
 * in green, asks right in red) over bars for each level, with the largest
 * levels picked out and a band around the mid that can be dragged wider or
 * narrower (both lines move together, mirrored). Hover for a level's details.
 */
export function DepthChart({
  book,
  venue,
  base,
  detailed = false,
  range = 0.01,
  span,
  display = DEFAULT_DEPTH_DISPLAY,
}: DepthChartProps) {
  const gradientId = useId();
  const [ref, { width, height }] = useSize<HTMLDivElement>();
  const [hover, setHover] = useState<Hover>();
  const [band, setBand] = useState(storedBand);
  const dragging = useRef(false);
  useEffect(() => {
    try {
      localStorage.setItem(BAND_KEY, String(band));
    } catch {
      // Storage unavailable; the band just won't survive a restart.
    }
  }, [band]);

  const all = depthLevels(book);
  const bestBid = all.bids[0];
  const bestAsk = all.asks[0];
  const decimals = decimalsOf(book.bids[0]?.price ?? book.asks[0]?.price ?? "0");
  if (!bestBid || !bestAsk || !all.bids.at(-1) || !all.asks.at(-1)) {
    return <div ref={ref} className="pd-depth" />;
  }

  const mid = (bestBid.price + bestAsk.price) / 2;
  // Compact: the whole book, unless zoomed to a span. Detailed: ±range around the mid.
  const reach = detailed ? range : span;
  const minP = reach ? mid * (1 - reach) : (all.bids.at(-1)?.price ?? mid);
  const maxP = reach ? mid * (1 + reach) : (all.asks.at(-1)?.price ?? mid);
  const bids = reach ? all.bids.filter((l) => l.price >= minP) : all.bids;
  const asks = reach ? all.asks.filter((l) => l.price <= maxP) : all.asks;
  const bidTotal = bids.at(-1)?.cumulative ?? 0;
  const askTotal = asks.at(-1)?.cumulative ?? 0;

  const PAD = { top: 44, right: detailed ? 62 : 14, bottom: 28, left: 14 };
  const plotW = Math.max(width - PAD.left - PAD.right, 1);
  const plotH = Math.max(height - PAD.top - PAD.bottom, 1);
  const floor = PAD.top + plotH;
  const right = PAD.left + plotW;
  const x = (price: number) => PAD.left + ((price - minP) / (maxP - minP || 1)) * plotW;
  const maxCum = Math.max(bidTotal, askTotal) || 1;
  const yCum = (total: number) => floor - (total / maxCum) * plotH * CURVE_H;

  // Bars as wide as the tightest gap between levels allows.
  const prices = [...bids, ...asks].map((l) => l.price).sort((a, b) => a - b);
  let gap = Number.POSITIVE_INFINITY;
  for (let i = 1; i < prices.length; i++) {
    const d = (prices[i] ?? 0) - (prices[i - 1] ?? 0);
    if (d > 0) gap = Math.min(gap, d);
  }
  const pitch = ((Number.isFinite(gap) ? gap : 0) / (maxP - minP || 1)) * plotW;
  // A deep book has more levels than the plot has pixels; drawn one bar each
  // they merge into a solid block. Levels sharing a column are summed instead.
  const barPitch = Math.max(plotW / Math.max(display.columns, 1), BAR_PITCH_MIN);
  const dense = pitch < barPitch;
  const barW = dense ? Math.max(barPitch - 1, 1) : Math.min(Math.max(pitch * 0.7, 2), 12);
  const bars = (levels: DepthLevel[]) => {
    if (!dense) return levels.map((l) => ({ at: x(l.price), notional: l.notional, wall: l.wall }));
    const columns = new Map<number, { at: number; notional: number; wall: boolean }>();
    for (const l of levels) {
      const column = Math.floor((x(l.price) - PAD.left) / barPitch);
      const bar = columns.get(column);
      if (bar) {
        bar.notional += l.notional;
        bar.wall ||= Boolean(l.wall);
      } else {
        columns.set(column, {
          at: PAD.left + (column + 0.5) * barPitch,
          notional: l.notional,
          wall: Boolean(l.wall),
        });
      }
    }
    return [...columns.values()];
  };
  const bidBars = bars(bids);
  const askBars = bars(asks);
  const maxLevel = Math.max(...[...bidBars, ...askBars].map((b) => b.notional), 0) || 1;
  const barH = (notional: number) => (notional / maxLevel) * plotH * BARS_H;

  /** An area from the mid outward (stepped, or level to level), closed down to the axis. */
  const area = (levels: DepthLevel[]) => {
    let d = `M ${x(mid)} ${floor}`;
    let prev = 0;
    for (const l of levels) {
      if (!display.smooth) d += ` L ${x(l.price)} ${yCum(prev)}`;
      d += ` L ${x(l.price)} ${yCum(l.cumulative)}`;
      prev = l.cumulative;
    }
    const last = levels.at(-1);
    return last ? `${d} L ${x(last.price)} ${floor} Z` : d;
  };
  const edge = (levels: DepthLevel[]) => area(levels).replace(/ L [^L]* Z$/, "");

  const biggest = (levels: DepthLevel[]) =>
    levels.reduce<DepthLevel | undefined>(
      (top, l) => (!top || l.notional > top.notional ? l : top),
      undefined,
    );
  const bidWall = biggest(bids.filter((l) => l.wall));
  const askWall = biggest(asks.filter((l) => l.wall));

  // The band mirrors around the mid: both lines are one width, so moving one
  // moves the other the opposite way. It stays inside the view.
  const bandMax = reach ? reach * 0.98 : Math.max(mid - minP, maxP - mid) / mid;
  const clampBand = (b: number) => Math.min(Math.max(b, BAND_MIN), Math.max(bandMax, BAND_MIN));
  const bandWidth = clampBand(band);
  const bandLow = mid * (1 - bandWidth);
  const bandHigh = mid * (1 + bandWidth);
  const bidShare = bidTotal / (bidTotal + askTotal || 1);
  const pct = formatNumber(bandWidth * 100, 2);
  // Where each band line's labels go. Between the lines when both fit there;
  // on a deep book the lines sit close together, so each goes outside its
  // line instead, or onto a lower row when there's no room outside either.
  const bandLines = [
    { price: bandLow, side: "bid" as const, depth: depthWithin(bids, mid, bandWidth) },
    { price: bandHigh, side: "ask" as const, depth: depthWithin(asks, mid, bandWidth) },
  ].map((b) => {
    const priceText = formatNumber(b.price, decimals);
    const depthText = `$${formatCompact(b.depth)} ${t("depth.band", { pct })}`;
    const room = Math.max(priceText.length, depthText.length) * BAND_CHAR_W + BAND_LABEL_GAP;
    return { ...b, priceText, depthText, room };
  });
  const [bidLine, askLine] = bandLines;
  const bandInside = x(bandHigh) - x(bandLow) >= (bidLine?.room ?? 0) + (askLine?.room ?? 0) + 8;
  const bidOut = !bandInside && x(bandLow) - PAD.left >= (bidLine?.room ?? 0) + BAND_EDGE_ROOM;
  const askOut = !bandInside && right - x(bandHigh) >= (askLine?.room ?? 0) + BAND_EDGE_ROOM;
  const bandLabels = bandLines.map((b) => {
    const out = b.side === "bid" ? bidOut : askOut;
    const otherOut = b.side === "bid" ? askOut : bidOut;
    // Towards the mid unless it's outside: bid labels then run right, ask labels left.
    const towardsRight = (b.side === "bid") !== out;
    // Two labels sharing the space between the lines: the ask's drops a row.
    const lowered = !bandInside && !out && (b.side === "ask" || otherOut);
    return {
      ...b,
      anchor: towardsRight ? ("start" as const) : ("end" as const),
      labelX: x(b.price) + (towardsRight ? BAND_LABEL_GAP : -BAND_LABEL_GAP),
      labelY: PAD.top + 6 + (lowered ? BAND_ROW_H : 0),
    };
  });
  const priceAt = (px: number) => minP + ((px - PAD.left) / plotW) * (maxP - minP);

  // Compact: a few evenly spaced ticks clear of the ends and best prices.
  // Detailed: halfway to each end, with 0% at the mid.
  const ticks = detailed
    ? [mid * (1 - range / 2), mid * (1 + range / 2)]
    : [0.2, 0.4, 0.6, 0.8]
        .map((f) => minP + f * (maxP - minP))
        .filter((p) => {
          // Clear of the best bid's label (left of its price) and the best ask's (right).
          const half = (formatNumber(p, decimals).length * BAND_CHAR_W) / 2 + 10;
          const label = formatNumber(bestAsk.price, decimals).length * BAND_CHAR_W + 6;
          return x(p) + half < x(bestBid.price) - label || x(p) - half > x(bestAsk.price) + label;
        });

  const onMove = (e: PointerEvent<HTMLDivElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const px = e.clientX - rect.left;
    const py = e.clientY - rect.top;
    if (dragging.current) {
      setBand(clampBand(Math.abs(priceAt(px) - mid) / mid));
      return;
    }
    if (px < PAD.left || px > right) return setHover(undefined);
    const side = px <= x(mid) ? "bid" : "ask";
    const levels = side === "bid" ? bids : asks;
    if (levels.length === 0) return setHover(undefined);
    const nearest = levels.reduce((best, l) =>
      Math.abs(x(l.price) - px) < Math.abs(x(best.price) - px) ? l : best,
    );
    setHover({
      x: px,
      y: py,
      side,
      level: nearest,
      sideTotal: side === "bid" ? bidTotal : askTotal,
    });
  };

  const hx = hover ? (detailed ? x(hover.level.price) : hover.x) : 0;
  const tipLeft = detailed
    ? hx + 206 > width
      ? Math.max(hx - 216, 4)
      : hx + 14
    : Math.min((hover?.x ?? 0) + 14, width - 190);
  const tipTop = detailed
    ? Math.max(Math.min(yCum(hover?.level.cumulative ?? 0) - 40, height - 150), 4)
    : Math.max(Math.min((hover?.y ?? 0) - 20, height - 120), 4);

  return (
    <div
      ref={ref}
      className="pd-depth"
      onPointerMove={onMove}
      onPointerLeave={() => setHover(undefined)}
      onPointerUp={(e) => {
        dragging.current = false;
        e.currentTarget.releasePointerCapture?.(e.pointerId);
      }}
      onPointerCancel={() => {
        dragging.current = false;
      }}
    >
      {width > 0 && (
        <svg
          className="pd-depth-plot"
          width={width}
          height={height}
          role="img"
          aria-label={t("tab.depth")}
        >
          <defs>
            {(["bid", "ask"] as const).map((side) => (
              <linearGradient key={side} id={`${gradientId}-${side}`} x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" className={`pd-depth-stop-${side}`} stopOpacity={0.32} />
                <stop offset="100%" className={`pd-depth-stop-${side}`} stopOpacity={0.03} />
              </linearGradient>
            ))}
          </defs>

          {/* Grid; the detailed view labels it on the right with cumulative notional */}
          {(detailed ? [0.25, 0.5, 0.75, 1] : [0.25, 0.5, 0.75]).map((f) => {
            const y = detailed ? floor - f * plotH * CURVE_H : PAD.top + plotH * f;
            return (
              <g key={f}>
                {display.grid && (
                  <line className="pd-depth-grid" x1={PAD.left} x2={right} y1={y} y2={y} />
                )}
                {detailed && (
                  <text className="pd-depth-tick" x={right + 6} y={y + 4}>
                    ${formatCompact(maxCum * f)}
                  </text>
                )}
              </g>
            );
          })}

          {/* Bid/ask split (the detailed view has the imbalance card instead) */}
          {!detailed && (
            <g transform={`translate(${width / 2 - 45}, 8)`}>
              <rect className="pd-depth-split-bid" width={90 * bidShare} height={3} rx={1.5} />
              <rect
                className="pd-depth-split-ask"
                x={90 * bidShare}
                width={90 * (1 - bidShare)}
                height={3}
                rx={1.5}
              />
              <text className="pd-depth-label" x={45} y={18} textAnchor="middle">
                {formatPercent(bidShare, 0)} / {formatPercent(1 - bidShare, 0)}
              </text>
            </g>
          )}

          {/* Cumulative areas */}
          <path d={area(bids)} fill={`url(#${gradientId}-bid)`} />
          <path d={area(asks)} fill={`url(#${gradientId}-ask)`} />
          {venue && bids.length > 0 && (
            <text
              className="pd-depth-venue"
              data-side="bid"
              x={PAD.left + 2}
              y={yCum(bidTotal) - 6}
            >
              {venue}
            </text>
          )}
          {venue && asks.length > 0 && (
            <text
              className="pd-depth-venue"
              data-side="ask"
              x={right - 2}
              y={yCum(askTotal) - 6}
              textAnchor="end"
            >
              {venue}
            </text>
          )}

          {/* Level bars; walls outlined and glowing */}
          {(display.bars ? (["bid", "ask"] as const) : []).map((side) =>
            (side === "bid" ? bidBars : askBars).map((l) => (
              <rect
                key={`${side}${l.at}`}
                className="pd-depth-bar"
                data-side={side}
                data-wall={(display.walls && l.wall) || undefined}
                x={l.at - barW / 2}
                y={floor - barH(l.notional)}
                width={barW}
                height={Math.max(barH(l.notional), 1)}
                rx={1}
              />
            )),
          )}

          {/* The curves' edges, over the bars so they stay readable */}
          <path className="pd-depth-edge-bid" d={edge(bids)} />
          <path className="pd-depth-edge-ask" d={edge(asks)} />

          {/* Detailed: the mid, as a dashed line and a boxed label */}
          {detailed && (
            <>
              <line className="pd-depth-mid" x1={x(mid)} x2={x(mid)} y1={PAD.top - 4} y2={floor} />
              <g transform={`translate(${x(mid)}, 6)`}>
                <rect className="pd-depth-mid-box" x={-38} width={76} height={32} rx={3} />
                <text className="pd-depth-mid-label" y={13} textAnchor="middle">
                  {t("depth.mid")}
                </text>
                <text className="pd-depth-mid-price" y={27} textAnchor="middle">
                  {formatNumber(mid, decimals + 1)}
                </text>
              </g>
            </>
          )}

          {/* ▼ over each side's largest level */}
          {[
            { wall: bidWall, side: "bid" },
            { wall: askWall, side: "ask" },
          ].map(({ wall, side }) =>
            wall && display.walls ? (
              <path
                key={side}
                className="pd-depth-marker"
                data-side={side}
                d={`M ${x(wall.price) - 5} ${PAD.top - 12} h 10 l -5 7 z`}
              >
                <title>{t("depth.wall")}</title>
              </path>
            ) : null,
          )}

          {/* ±band around the mid */}
          {bandLabels.map((b) =>
            display.band && b.price > minP && b.price < maxP ? (
              <g
                key={b.side}
                className="pd-depth-handle"
                role="slider"
                tabIndex={0}
                aria-label={t("depth.dragBand")}
                aria-valuemin={BAND_MIN * 100}
                aria-valuemax={Math.max(bandMax, BAND_MIN) * 100}
                aria-valuenow={Number((bandWidth * 100).toFixed(2))}
                aria-valuetext={`±${pct}% · ${formatNumber(b.price, decimals)}`}
                onPointerDown={(e) => {
                  dragging.current = true;
                  setHover(undefined);
                  ref.current?.setPointerCapture(e.pointerId);
                }}
                onKeyDown={(e) => {
                  // Outward widens: left on the bid line, right on the ask line.
                  const step = BAND_MIN * (e.shiftKey ? 5 : 1);
                  const outward = b.side === "bid" ? "ArrowLeft" : "ArrowRight";
                  const inward = b.side === "bid" ? "ArrowRight" : "ArrowLeft";
                  if (e.key === outward) setBand(clampBand(bandWidth + step));
                  else if (e.key === inward) setBand(clampBand(bandWidth - step));
                  else return;
                  e.preventDefault();
                }}
              >
                <rect
                  className="pd-depth-hit"
                  x={x(b.price) - 7}
                  y={PAD.top - 14}
                  width={14}
                  height={floor - PAD.top + 14}
                />
                <line
                  className="pd-depth-band"
                  x1={x(b.price)}
                  x2={x(b.price)}
                  y1={PAD.top - 6}
                  y2={floor}
                />
                <rect
                  className="pd-depth-knob"
                  x={x(b.price) - 5}
                  y={PAD.top - 14}
                  width={10}
                  height={9}
                  rx={2}
                />
                <text
                  className="pd-depth-band-label"
                  x={b.labelX}
                  y={b.labelY}
                  textAnchor={b.anchor}
                >
                  {b.priceText}
                </text>
                <text
                  className="pd-depth-band-depth"
                  data-side={b.side}
                  x={b.labelX}
                  y={b.labelY + 16}
                  textAnchor={b.anchor}
                >
                  {b.depthText}
                </text>
              </g>
            ) : null,
          )}

          {/* Axis */}
          <line className="pd-depth-axis" x1={PAD.left} x2={right} y1={floor} y2={floor} />
          <text
            className="pd-depth-tick"
            data-strong={!detailed || undefined}
            x={PAD.left}
            y={height - 8}
          >
            {formatNumber(minP, decimals)}
          </text>
          {ticks.map((p) => (
            <text key={p} className="pd-depth-tick" x={x(p)} y={height - 8} textAnchor="middle">
              {formatNumber(p, decimals)}
            </text>
          ))}
          {detailed ? (
            <text
              className="pd-depth-tick"
              data-strong
              x={x(mid)}
              y={height - 8}
              textAnchor="middle"
            >
              0%
            </text>
          ) : (
            <>
              <text
                className="pd-depth-tick"
                data-strong
                x={x(bestBid.price) - 4}
                y={height - 8}
                textAnchor="end"
              >
                {formatNumber(bestBid.price, decimals)}
              </text>
              <text className="pd-depth-tick" data-strong x={x(bestAsk.price) + 4} y={height - 8}>
                {formatNumber(bestAsk.price, decimals)}
              </text>
            </>
          )}
          <text
            className="pd-depth-tick"
            data-strong={!detailed || undefined}
            x={right}
            y={height - 8}
            textAnchor="end"
          >
            {formatNumber(maxP, decimals)}
          </text>

          {hover && (
            <g>
              <line className="pd-depth-cursor" x1={hx} x2={hx} y1={PAD.top - 6} y2={floor} />
              {detailed && (
                <circle
                  className="pd-depth-dot"
                  data-side={hover.side}
                  cx={hx}
                  cy={yCum(hover.level.cumulative)}
                  r={4.5}
                />
              )}
            </g>
          )}
        </svg>
      )}

      {/* Each side's total, top right, over the chart */}
      <div className="pd-depth-legend">
        <span className="pd-depth-legend-item" data-side="bid">
          <i aria-hidden /> {t("depth.bids")} <strong>${formatCompact(bidTotal)}</strong>
        </span>
        <span className="pd-depth-legend-item" data-side="ask">
          <i aria-hidden /> {t("depth.asks")} <strong>${formatCompact(askTotal)}</strong>
        </span>
      </div>

      {hover && (
        <div className="pd-depth-tip" style={{ left: tipLeft, top: tipTop }}>
          {detailed && (
            <strong className="pd-depth-tip-title" data-side={hover.side}>
              {formatNumber(hover.level.price, decimals)} ·{" "}
              {formatSigned(((hover.level.price - mid) / mid) * 100)}%
            </strong>
          )}
          <dl>
            {!detailed && (
              <div>
                <dt>{t("col.price")}</dt>
                <dd>{formatNumber(hover.level.price, decimals)}</dd>
              </div>
            )}
            <div>
              <dt>{t("col.size")}</dt>
              <dd>${formatCompact(hover.level.notional)}</dd>
            </div>
            {detailed && (
              <div>
                <dt>{t("depth.cumSize")}</dt>
                <dd>
                  {formatNumber(hover.level.cumSize, 2)}
                  {base ? ` ${base}` : ""}
                </dd>
              </div>
            )}
            <div>
              <dt>{t(detailed ? "depth.notional" : "depth.cumulative")}</dt>
              <dd>${formatCompact(hover.level.cumulative)}</dd>
            </div>
            <div>
              <dt>{t("depth.bookShare")}</dt>
              <dd>{formatPercent(hover.level.cumulative / (hover.sideTotal || 1), 1)}</dd>
            </div>
            {detailed && (
              <div>
                <dt>{t(hover.side === "bid" ? "depth.sellInto" : "depth.buyInto")}</dt>
                <dd>{formatNumber(avgFillTo(hover.level), decimals + 1)}</dd>
              </div>
            )}
          </dl>
        </div>
      )}
    </div>
  );
}
