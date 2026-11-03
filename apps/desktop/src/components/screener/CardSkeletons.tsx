import { t } from "@pewterdesk/ui";

// Placeholders for the Screener's cards while their data loads, shaped like
// what lands there (rows of a name and figures, the trend's bar and counts),
// so nothing jumps when it does.

/** Widths that look organic but stay the same on every render. */
const NAME_W = [58, 44, 66, 50, 62, 48];
const FIGURE_W = [16, 20, 14, 18];

const pick = (widths: readonly number[], i: number) => widths[i % widths.length] ?? 50;

/** `rows` rows of a name (with a token's dot, for movers) and `figures` figures. */
export function RowsSkeleton({
  rows,
  figures,
  dot = false,
}: {
  rows: number;
  figures: number;
  dot?: boolean;
}) {
  return (
    <div className="card-skel" role="status" aria-label={t("feed.loading")}>
      {Array.from({ length: rows }, (_, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: placeholders have no identity
        <div key={i} className="card-skel-row pd-skel-row">
          <span className="card-skel-name">
            {dot && <span className="pd-skel pd-skel-dot" />}
            <span className="pd-skel" style={{ width: `${pick(NAME_W, i)}%` }} />
          </span>
          {Array.from({ length: figures }, (_, f) => (
            <span
              // biome-ignore lint/suspicious/noArrayIndexKey: placeholders have no identity
              key={f}
              className="pd-skel"
              style={{ width: `${pick(FIGURE_W, i + f)}%` }}
            />
          ))}
        </div>
      ))}
    </div>
  );
}

/** The price trend's bar, its three counts and the line under them. */
export function TrendSkeleton() {
  return (
    <div className="card-skel trend-skel pd-skel-row" role="status" aria-label={t("feed.loading")}>
      <span className="pd-skel trend-skel-bar" />
      <div className="trend-skel-counts">
        {(["down", "flat", "up"] as const).map((side) => (
          <span key={side} className="trend-skel-count" data-side={side}>
            <span className="pd-skel trend-skel-number" />
            <span className="pd-skel trend-skel-label" />
          </span>
        ))}
      </div>
      <span className="pd-skel trend-skel-line" />
    </div>
  );
}
