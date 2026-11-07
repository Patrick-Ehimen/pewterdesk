import { formatCompact } from "@pewterdesk/ui";
import { useEffect, useRef, useState } from "react";

// A line of cumulative PnL (or ROI): green where it ends above where it
// started, red where below; a dashed line at zero when zero is in range.
// It draws only.

interface Props {
  /** [x, y], oldest first; x only orders them. */
  points: readonly (readonly [number, number])[];
  height: number;
  /** Axis labels on the left, in the values' own units. */
  axis?: boolean;
  /** Format for the axis; compact USD by default. */
  format?: (value: number) => string;
  label: string;
}

/** As wide as its container, redrawn when that changes. */
export function PnlLine(props: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const observer = new ResizeObserver(() => setWidth(Math.floor(el.clientWidth)));
    observer.observe(el);
    setWidth(Math.floor(el.clientWidth));
    return () => observer.disconnect();
  }, []);
  return (
    <div ref={ref} className="tr-line-box" style={{ height: props.height }}>
      {width > 0 && <Line {...props} width={width} />}
    </div>
  );
}

function Line({
  points,
  width,
  height,
  axis = false,
  format = formatCompact,
  label,
}: Props & { width: number }) {
  const first = points[0];
  const last = points[points.length - 1];
  if (points.length < 2 || !first || !last) return null;
  const left = axis ? 52 : 1;
  const top = 6;
  const bottom = height - 6;
  const ys = points.map((p) => p[1]);
  const lo = Math.min(...ys, axis ? 0 : Number.POSITIVE_INFINITY);
  const hi = Math.max(...ys, axis ? 0 : Number.NEGATIVE_INFINITY);
  const span = hi - lo || 1;
  const x0 = first[0];
  const xSpan = last[0] - x0 || 1;
  const x = (v: number) => left + ((v - x0) / xSpan) * (width - left - 1);
  const y = (v: number) => bottom - ((v - lo) / span) * (bottom - top);
  const d = points
    .map((p, i) => `${i ? "L" : "M"}${x(p[0]).toFixed(1)} ${y(p[1]).toFixed(1)}`)
    .join(" ");
  const up = last[1] >= first[1];
  const ticks = axis ? [lo, lo + span / 2, hi] : [];
  return (
    <svg
      className="tr-line"
      viewBox={`0 0 ${width} ${height}`}
      width={width}
      height={height}
      role="img"
      aria-label={label}
    >
      {ticks.map((v) => (
        <g key={v}>
          <line className="tr-line-grid" x1={left} x2={width} y1={y(v)} y2={y(v)} />
          <text className="tr-line-tick" x={left - 6} y={y(v) + 4} textAnchor="end">
            {format(v)}
          </text>
        </g>
      ))}
      {lo < 0 && hi > 0 && (
        <line className="tr-line-zero" x1={left} x2={width} y1={y(0)} y2={y(0)} />
      )}
      {axis && (
        <path
          className="tr-line-area"
          d={`${d} L${x(last[0]).toFixed(1)} ${bottom} L${left} ${bottom}Z`}
        />
      )}
      <path
        className="tr-line-path"
        data-up={up || undefined}
        d={d}
        vectorEffect="non-scaling-stroke"
      />
    </svg>
  );
}
