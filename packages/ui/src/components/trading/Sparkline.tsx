/** A tiny line of `values`, green if it ended higher than it started, red if lower. */
export function Sparkline({
  values,
  width = 120,
  height = 26,
}: {
  values: readonly number[];
  width?: number;
  height?: number;
}) {
  if (values.length < 2) return null;
  // Every 4th point is plenty at this size (168 hourly closes → 42).
  const points = values.filter((_, i) => i % 4 === 0 || i === values.length - 1);
  const min = Math.min(...points);
  const max = Math.max(...points);
  const span = max - min || 1;
  const d = points
    .map((v, i) => {
      const x = (i / (points.length - 1)) * width;
      const y = height - 2 - ((v - min) / span) * (height - 4);
      return `${i === 0 ? "M" : "L"}${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");
  const up = (values.at(-1) ?? 0) >= (values[0] ?? 0);
  return (
    <svg className="pd-spark" data-up={up || undefined} width={width} height={height} aria-hidden>
      <path d={d} />
    </svg>
  );
}
