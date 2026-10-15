import { dateFormat, formatNumber } from "@pewterdesk/ui";
import { type ReactNode, useEffect, useRef, useState } from "react";
import type { Bar } from "../../lib/backtest";

// The Bots page's charts, drawn as SVG at the size of their box. Colours
// come from the theme's tokens through CSS classes (`bots.css`): brass for
// the strategy, green and red for market data only.

/** A box's size, followed as it changes. */
export function useBox<T extends HTMLElement>() {
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

const PAD = { top: 10, right: 64, bottom: 22, left: 8 };

const dayMonth = () => dateFormat({ day: "numeric", month: "short", timeZone: "UTC" });

/** Even, round-numbered steps between two values. */
function ticks(min: number, max: number, count: number): number[] {
  const span = max - min || Math.abs(max) || 1;
  const raw = span / count;
  const power = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * power).find((s) => s >= raw) ?? raw;
  const out: number[] = [];
  for (let v = Math.ceil(min / step) * step; v <= max + 1e-9; v += step) out.push(v);
  return out;
}

/** Dates along the bottom: about one per 110 px. */
function dateTicks(times: readonly number[], width: number): number[] {
  const count = Math.max(2, Math.floor(width / 110));
  if (times.length < 2) return [];
  const every = Math.max(1, Math.floor(times.length / count));
  const out: number[] = [];
  for (let i = 0; i < times.length; i += every) out.push(i);
  return out;
}

export interface Line {
  values: readonly (number | undefined)[];
  /** A class from `bots.css`: `bt-line-strategy`, `bt-line-hold`, `bt-line-run-1`... */
  className: string;
}

interface EquityChartProps {
  times: readonly number[];
  lines: readonly Line[];
  /** The first held-out candle, shaded from there on. */
  holdOutFrom?: number;
  holdOutLabel?: string;
  /** Drawdown at each candle (fractions, 0 or below), drawn under the equity. */
  drawdown?: readonly number[];
  drawdownLabel?: ReactNode;
  /** The last value of the first line, tagged on the price scale. */
  tagLast?: boolean;
}

/** Equity curves over the run, with the held-out days shaded and the drawdown under them. */
export function EquityChart({
  times,
  lines,
  holdOutFrom,
  holdOutLabel,
  drawdown,
  drawdownLabel,
  tagLast,
}: EquityChartProps) {
  const [ref, { width, height }] = useBox<HTMLDivElement>();
  const ddHeight = drawdown ? Math.min(110, height * 0.3) : 0;
  const top = PAD.top;
  const bottom = height - PAD.bottom - (drawdown ? ddHeight + 18 : 0);
  const plotW = Math.max(1, width - PAD.left - PAD.right);
  const all = lines.flatMap((l) => l.values.filter((v): v is number => v !== undefined));
  const min = Math.min(...all);
  const max = Math.max(...all);
  const pad = (max - min) * 0.08 || 1;
  const lo = min - pad;
  const hi = max + pad;
  const n = Math.max(1, times.length - 1);
  const x = (i: number) => PAD.left + (i / n) * plotW;
  const y = (v: number) => bottom - ((v - lo) / (hi - lo)) * (bottom - top);
  const path = (values: readonly (number | undefined)[]) => {
    let d = "";
    let pen = false;
    values.forEach((v, i) => {
      if (v === undefined) {
        pen = false;
        return;
      }
      d += `${pen ? "L" : "M"}${x(i).toFixed(1)},${y(v).toFixed(1)}`;
      pen = true;
    });
    return d;
  };
  const ddTop = height - PAD.bottom - ddHeight;
  const ddMin = drawdown ? Math.min(-0.0001, ...drawdown) : -1;
  const ddY = (v: number) => ddTop + (v / ddMin) * ddHeight;
  const first = lines[0];
  const last = first?.values.at(-1);
  return (
    <div ref={ref} className="bt-chart">
      {width > 0 && height > 0 && all.length > 0 && (
        <svg width={width} height={height} role="img" aria-hidden>
          {holdOutFrom !== undefined && holdOutFrom < times.length && (
            <g>
              <rect
                className="bt-holdout"
                x={x(holdOutFrom)}
                y={top}
                width={x(n) - x(holdOutFrom)}
                height={(drawdown ? ddTop + ddHeight : bottom) - top}
              />
              {holdOutLabel && (
                <text className="bt-axis" x={x(holdOutFrom) + 6} y={top + 12}>
                  {holdOutLabel}
                </text>
              )}
            </g>
          )}
          {ticks(lo, hi, 4).map((v) => (
            <g key={v}>
              <line className="bt-grid" x1={PAD.left} x2={PAD.left + plotW} y1={y(v)} y2={y(v)} />
              <text className="bt-axis" x={PAD.left + plotW + 6} y={y(v) + 4}>
                {formatNumber(v, 0)}
              </text>
            </g>
          ))}
          {lines.map((l) => (
            <path key={l.className} className={`bt-line ${l.className}`} d={path(l.values)} />
          ))}
          {tagLast && last !== undefined && (
            <text className="bt-tag" x={PAD.left + plotW + 6} y={y(last) + 4}>
              {formatNumber(last, 0)}
            </text>
          )}
          {drawdown && (
            <g>
              <line className="bt-grid" x1={PAD.left} x2={PAD.left + plotW} y1={ddTop} y2={ddTop} />
              <path
                className="bt-drawdown"
                d={`M${x(0)},${ddTop}${drawdown.map((v, i) => `L${x(i).toFixed(1)},${ddY(v).toFixed(1)}`).join("")}L${x(n)},${ddTop}Z`}
              />
              {drawdownLabel && (
                <foreignObject x={PAD.left} y={ddTop - 18} width={plotW} height={18}>
                  <div className="bt-dd-label">{drawdownLabel}</div>
                </foreignObject>
              )}
            </g>
          )}
          {dateTicks(times, plotW).map((i) => (
            <text key={i} className="bt-axis" x={x(i)} y={height - 6} textAnchor="middle">
              {dayMonth().format(times[i] ?? 0)}
            </text>
          ))}
        </svg>
      )}
    </div>
  );
}

export interface Marker {
  index: number;
  kind: "entryLong" | "entryShort" | "exit";
}

export interface Level {
  price: number;
  label?: string;
  /** `buy`, `sell`, `stop`, `entry` - classes in `bots.css`. */
  tone: "buy" | "sell" | "stop" | "entry";
  /** Drawn from this candle on, else across. */
  from?: number;
}

interface CandleChartProps {
  bars: readonly Bar[];
  lines?: readonly Line[];
  markers?: readonly Marker[];
  levels?: readonly Level[];
  holdOutFrom?: number;
  holdOutLabel?: string;
  /** A span of candles drawn highlighted, e.g. the trade on screen. */
  highlight?: { from: number; to: number };
  /** The last close, tagged on the price scale. */
  last?: number;
  decimals?: number;
}

/** Candles, with indicator lines, trade marks and horizontal levels over them. */
export function CandleChart({
  bars,
  lines = [],
  markers = [],
  levels = [],
  holdOutFrom,
  holdOutLabel,
  highlight,
  last,
  decimals = 2,
}: CandleChartProps) {
  const [ref, { width, height }] = useBox<HTMLDivElement>();
  const plotW = Math.max(1, width - PAD.left - PAD.right - (levels.some((l) => l.label) ? 40 : 0));
  const top = PAD.top;
  const bottom = height - PAD.bottom;
  const prices = [...bars.flatMap((b) => [b.high, b.low]), ...levels.map((l) => l.price)];
  const min = Math.min(...prices);
  const max = Math.max(...prices);
  const pad = (max - min) * 0.05 || 1;
  const lo = min - pad;
  const hi = max + pad;
  const slot = plotW / Math.max(1, bars.length);
  const x = (i: number) => PAD.left + (i + 0.5) * slot;
  const y = (v: number) => bottom - ((v - lo) / (hi - lo)) * (bottom - top);
  const body = Math.max(1, slot * 0.6);
  const times = bars.map((b) => b.time);
  // Labelled levels take the price scale's place: two columns of prices would collide.
  const priceLabels = !levels.some((l) => l.label);
  return (
    <div ref={ref} className="bt-chart">
      {width > 0 && height > 0 && bars.length > 0 && (
        <svg width={width} height={height} role="img" aria-hidden>
          {holdOutFrom !== undefined && holdOutFrom < bars.length && (
            <g>
              <rect
                className="bt-holdout"
                x={x(holdOutFrom) - slot / 2}
                y={top}
                width={x(bars.length - 1) + slot / 2 - (x(holdOutFrom) - slot / 2)}
                height={bottom - top}
              />
              {holdOutLabel && (
                <text className="bt-axis" x={x(holdOutFrom) + 4} y={top + 12}>
                  {holdOutLabel}
                </text>
              )}
            </g>
          )}
          {highlight && (
            <rect
              className="bt-highlight"
              x={x(highlight.from) - slot / 2}
              y={top}
              width={x(highlight.to) - x(highlight.from) + slot}
              height={bottom - top}
            />
          )}
          {ticks(lo, hi, 5).map((v) => (
            <g key={v}>
              <line className="bt-grid" x1={PAD.left} x2={PAD.left + plotW} y1={y(v)} y2={y(v)} />
              {priceLabels && (
                <text className="bt-axis" x={PAD.left + plotW + 6} y={y(v) + 4}>
                  {formatNumber(v, decimals)}
                </text>
              )}
            </g>
          ))}
          {bars.map((b, i) => {
            const up = b.close >= b.open;
            return (
              <g key={b.time} className={up ? "bt-up" : "bt-down"}>
                <line x1={x(i)} x2={x(i)} y1={y(b.high)} y2={y(b.low)} className="bt-wick" />
                <rect
                  x={x(i) - body / 2}
                  y={y(Math.max(b.open, b.close))}
                  width={body}
                  height={Math.max(1, Math.abs(y(b.open) - y(b.close)))}
                />
              </g>
            );
          })}
          {lines.map((l) => {
            let d = "";
            let pen = false;
            l.values.forEach((v, i) => {
              if (v === undefined) {
                pen = false;
                return;
              }
              d += `${pen ? "L" : "M"}${x(i).toFixed(1)},${y(v).toFixed(1)}`;
              pen = true;
            });
            return <path key={l.className} className={`bt-line ${l.className}`} d={d} />;
          })}
          {levels.map((l) => (
            <g
              key={`${l.tone}:${l.price}:${l.label ?? ""}`}
              className={`bt-level bt-level-${l.tone}`}
            >
              <line
                x1={l.from === undefined ? PAD.left : x(l.from)}
                x2={PAD.left + plotW}
                y1={y(l.price)}
                y2={y(l.price)}
              />
              {l.label && (
                <text x={PAD.left + plotW + 6} y={y(l.price) + 4}>
                  {l.label}
                </text>
              )}
            </g>
          ))}
          {markers.map((m) => {
            const bar = bars[m.index];
            if (!bar) return null;
            const cx = x(m.index);
            if (m.kind === "exit") {
              const cy = y(bar.high) - 8;
              return (
                <path
                  key={`${m.kind}${m.index}`}
                  className="bt-mark-exit"
                  d={`M${cx - 3},${cy - 3}L${cx + 3},${cy + 3}M${cx + 3},${cy - 3}L${cx - 3},${cy + 3}`}
                />
              );
            }
            const long = m.kind === "entryLong";
            const cy = long ? y(bar.low) + 9 : y(bar.high) - 9;
            return (
              <path
                key={`${m.kind}${m.index}`}
                className={long ? "bt-mark-long" : "bt-mark-short"}
                d={
                  long
                    ? `M${cx},${cy - 4}L${cx + 4},${cy + 3}L${cx - 4},${cy + 3}Z`
                    : `M${cx},${cy + 4}L${cx + 4},${cy - 3}L${cx - 4},${cy - 3}Z`
                }
              />
            );
          })}
          {last !== undefined && (
            <g className="bt-last">
              <rect
                x={PAD.left + plotW + 2}
                y={y(last) - 8}
                width={PAD.right - 4}
                height={16}
                rx={2}
              />
              <text x={PAD.left + plotW + 6} y={y(last) + 4}>
                {formatNumber(last, decimals)}
              </text>
            </g>
          )}
          {dateTicks(times, plotW).map((i) => (
            <text key={i} className="bt-axis" x={x(i)} y={height - 6} textAnchor="middle">
              {dayMonth().format(times[i] ?? 0)}
            </text>
          ))}
        </svg>
      )}
    </div>
  );
}

interface BarsChartProps {
  values: readonly number[];
  labels: readonly string[];
  /** Each bar's tone: `buy` / `sell` (market data), `run` (brass) or `muted`. */
  tones: readonly ("buy" | "sell" | "run" | "muted")[];
  /** The count over each bar. */
  showValues?: boolean;
}

/** Vertical bars, a label under each. */
export function BarsChart({ values, labels, tones, showValues }: BarsChartProps) {
  const [ref, { width, height }] = useBox<HTMLDivElement>();
  const max = Math.max(1, ...values);
  const gap = 6;
  const barW = (width - gap * (values.length - 1)) / Math.max(1, values.length);
  const bottom = height - 18;
  const top = showValues ? 16 : 4;
  return (
    <div ref={ref} className="bt-chart">
      {width > 0 && height > 0 && (
        <svg width={width} height={height} role="img" aria-hidden>
          <line className="bt-grid" x1={0} x2={width} y1={bottom} y2={bottom} />
          {values.map((v, i) => {
            const h = ((bottom - top) * v) / max;
            const bx = i * (barW + gap);
            return (
              // biome-ignore lint/suspicious/noArrayIndexKey: one bar per bucket, in order
              <g key={i} className={`bt-bar bt-bar-${tones[i] ?? "muted"}`}>
                <rect x={bx} y={bottom - h} width={barW} height={Math.max(v > 0 ? 1 : 0, h)} />
                {showValues && (
                  <text
                    className="bt-axis"
                    x={bx + barW / 2}
                    y={bottom - h - 4}
                    textAnchor="middle"
                  >
                    {v}
                  </text>
                )}
                <text className="bt-axis" x={bx + barW / 2} y={height - 4} textAnchor="middle">
                  {labels[i]}
                </text>
              </g>
            );
          })}
        </svg>
      )}
    </div>
  );
}
