import type { CSSProperties } from "react";
import { t } from "../../i18n";
import type { RowMode } from "./OrderBookView";

// Placeholders shaped like the real views, so nothing jumps when data lands.
// Each side renders more rows than any panel fits; the side's overflow clips
// the rest, so no measuring is needed.
const ROWS = 40;

/** Widths that look organic but stay the same on every render. */
const PRICE_W = [62, 58, 66, 60, 64, 56, 63, 59];
const SIZE_W = [38, 52, 30, 46, 58, 34, 44, 50, 28, 40];
const EXTRA_W = [48, 44, 52, 40, 50, 46];

const pick = (widths: number[], i: number) => widths[i % widths.length] ?? 50;

function Bar({ width, style }: { width: number; style?: CSSProperties }) {
  return <span className="pd-skel" style={{ width: `${width}%`, ...style }} />;
}

function SkeletonRow({ i, mode }: { i: number; mode: RowMode }) {
  if (mode === "stacked") {
    return (
      <div className="pd-book-row pd-skel-row">
        <span>
          <Bar width={pick(PRICE_W, i) / 2} />
        </span>
        <span>
          <Bar width={pick(SIZE_W, i * 3)} style={{ height: 7 }} />
        </span>
      </div>
    );
  }
  return (
    <div className="pd-book-row pd-skel-row">
      <span>
        <Bar width={pick(PRICE_W, i)} />
      </span>
      <span>
        <Bar width={pick(SIZE_W, i * 3)} />
      </span>
      <span>
        <Bar width={pick(EXTRA_W, i * 5)} />
      </span>
    </div>
  );
}

/**
 * A trade row's placeholder. Unlike book levels, a trade's price has the
 * market's fixed number of digits and its time is always "HH:MM:SS", so those
 * bars keep one width; only the size varies.
 */
function TradeSkeletonRow({ i, mode }: { i: number; mode: RowMode }) {
  if (mode === "stacked") {
    // Line 1: price left, time right. Line 2: "250 HYPE · Buy".
    return (
      <div className="pd-book-row pd-skel-row">
        <span className="pd-row-line">
          <Bar width={30} />
          <Bar width={24} style={{ height: 7 }} />
        </span>
        <span>
          <Bar width={pick(SIZE_W, i * 3) * 0.8 + 12} style={{ height: 7 }} />
        </span>
      </div>
    );
  }
  return (
    <div className="pd-book-row pd-skel-row">
      <span>
        <Bar width={60} />
      </span>
      <span>
        <Bar width={pick(SIZE_W, i * 3)} />
      </span>
      <span>
        <Bar width={66} />
      </span>
    </div>
  );
}

function StaticHeader({ labels }: { labels: string[] }) {
  return (
    <div className="pd-book-head">
      {labels.map((label) => (
        <span key={label}>{label}</span>
      ))}
    </div>
  );
}

const rows = Array.from({ length: ROWS }, (_, i) => i);

export function OrderBookSkeleton({ mode = "table" }: { mode?: RowMode }) {
  return (
    <div
      className="pd-book"
      data-mode={mode}
      role="status"
      aria-busy="true"
      aria-label={t("book.loading")}
    >
      {mode === "table" && (
        <StaticHeader labels={[t("col.price"), t("col.size"), t("col.total")]} />
      )}
      <div className="pd-book-side" data-side="ask" aria-hidden>
        {rows.map((i) => (
          <SkeletonRow key={i} i={i} mode={mode} />
        ))}
      </div>
      <div className="pd-book-spread" aria-hidden>
        <Bar width={22} style={{ height: 14 }} />
        <Bar width={30} />
      </div>
      <div className="pd-book-side" data-side="bid" aria-hidden>
        {rows.map((i) => (
          <SkeletonRow key={i} i={i + 7} mode={mode} />
        ))}
      </div>
      <div className="pd-book-ratio" aria-hidden>
        <Bar width={12} />
        <span className="pd-skel pd-skel-ratio" />
        <Bar width={12} />
      </div>
    </div>
  );
}

export function TradesSkeleton({ mode = "table" }: { mode?: RowMode }) {
  return (
    <div
      className="pd-trades"
      data-mode={mode}
      role="status"
      aria-busy="true"
      aria-label={t("trades.loading")}
    >
      {mode === "table" && <StaticHeader labels={[t("col.price"), t("col.size"), t("col.time")]} />}
      <div className="pd-trades-list pd-skel-list" aria-hidden>
        {rows.map((i) => (
          <TradeSkeletonRow key={i} i={i + 3} mode={mode} />
        ))}
      </div>
    </div>
  );
}
