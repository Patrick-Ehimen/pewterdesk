import { t } from "@pewterdesk/ui";
import type { CSSProperties } from "react";

// The Traders page's loading states: the shared shimmer (`.pd-skel`), shaped
// like what's coming, so nothing jumps when the data lands. Widths come from
// fixed lists, so a skeleton looks the same on every render.

const WIDE = [62, 48, 70, 55, 66, 44, 58, 74, 51, 60];
const NUM = [56, 70, 48, 64, 52, 76, 60, 44];
const pick = (widths: readonly number[], i: number) => widths[i % widths.length] ?? 55;

/** One shimmer bar: `width` in % of its cell (or px with `px`). */
export function Bar({
  width,
  height,
  px = false,
  style,
}: {
  width: number;
  height?: number;
  px?: boolean;
  style?: CSSProperties;
}) {
  return (
    <span
      className="pd-skel"
      style={{ width: px ? width : `${width}%`, ...(height ? { height } : {}), ...style }}
    />
  );
}

/** A trader's picture, not yet drawn. */
const Avatar = ({ size = 28 }: { size?: number }) => (
  <span className="pd-skel tr-skel-avatar" style={{ width: size, height: size }} />
);

/** Leaderboard rows: one per trader, under the real column headers. */
export function BoardSkeletonRows({ okx, rows = 14 }: { okx: boolean; rows?: number }) {
  return (
    <tbody className="tr-skel" aria-hidden>
      {Array.from({ length: rows }, (_, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: fixed placeholder rows
        <tr key={i}>
          <td className="tr-rank">
            <Bar width={14} px />
          </td>
          <td>
            <span className="tr-skel-who">
              <Avatar />
              <span className="tr-skel-lines">
                <Bar width={pick(WIDE, i) * 1.6} px />
                {i % 4 === 1 && <Bar width={64} px height={7} />}
              </span>
            </span>
          </td>
          {Array.from({ length: okx ? 6 : 4 }, (_, c) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: fixed placeholder cells
            <td key={c} className="num">
              <Bar width={pick(NUM, i + c * 3)} />
            </td>
          ))}
          <td>
            {okx ? (
              <Bar width={86} height={14} />
            ) : (
              <span className="tr-skel-pips">
                {[0, 1, 2, 3].map((p) => (
                  <Bar key={p} width={20} px height={14} />
                ))}
              </span>
            )}
          </td>
          <td className="tr-star">
            <Bar width={15} px height={15} />
          </td>
        </tr>
      ))}
    </tbody>
  );
}

/**
 * Table rows for a trader's positions or closed trades: `cols` cells, a side
 * tag in column `sideAt`, text before it and numbers after.
 */
export function TableSkeletonRows({
  cols,
  rows = 5,
  sideAt = 1,
}: {
  cols: number;
  rows?: number;
  sideAt?: number;
}) {
  return (
    <tbody className="tr-skel" aria-hidden>
      {Array.from({ length: rows }, (_, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: fixed placeholder rows
        <tr key={i}>
          {Array.from({ length: cols }, (_, c) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: fixed placeholder cells
            <td key={c} className={c > sideAt ? "num" : undefined}>
              {c === sideAt ? (
                <Bar width={38} px height={16} />
              ) : (
                <Bar width={pick(NUM, i + c * 2)} />
              )}
            </td>
          ))}
        </tr>
      ))}
    </tbody>
  );
}

/** A PnL chart, not yet drawn: an axis and a rising, wandering run of bars. */
export function LineSkeleton({ height }: { height: number }) {
  return (
    <div
      className="tr-skel tr-skel-line"
      style={{ height }}
      role="status"
      aria-busy="true"
      aria-label={t("traders.loading")}
    >
      <span className="tr-skel-axis" aria-hidden>
        <Bar width={40} px />
        <Bar width={34} px />
        <Bar width={38} px />
      </span>
      <span className="tr-skel-plot" aria-hidden>
        {Array.from({ length: 60 }, (_, i) => {
          const h = 18 + i * 0.9 + 9 * Math.sin(i / 4) + 4 * Math.sin(i / 1.3);
          // biome-ignore lint/suspicious/noArrayIndexKey: fixed placeholder bars
          return <span key={i} className="pd-skel" style={{ height: `${Math.min(92, h)}%` }} />;
        })}
      </span>
    </div>
  );
}

/** A KPI's value, not yet in. */
export const ValueSkeleton = () => <Bar width={72} px height={16} />;

/** "What they trade": share bars. */
export function BarsSkeleton({ rows = 5 }: { rows?: number }) {
  return (
    <div className="tr-bars tr-skel" aria-hidden>
      {Array.from({ length: rows }, (_, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: fixed placeholder rows
        <div key={i} className="tr-bar-row">
          <Bar width={pick(NUM, i) / 2 + 20} />
          <Bar width={pick(WIDE, i) - 10} height={6} />
          <Bar width={80} />
        </div>
      ))}
    </div>
  );
}

/** Week by week: a row of bars around the middle line. */
export function WeeksSkeleton() {
  return (
    <div className="tr-weeks tr-skel" aria-hidden>
      {Array.from({ length: 12 }, (_, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: fixed placeholder bars
        <span key={i} className="tr-week">
          <span className="pd-skel tr-skel-week" style={{ height: `${12 + ((i * 7) % 5) * 7}%` }} />
        </span>
      ))}
    </div>
  );
}

/** "Where they agree": cards with dots, a split bar and two lines. */
export function AgreeSkeleton({ cards = 4 }: { cards?: number }) {
  return (
    <div
      className="tr-agree tr-skel"
      role="status"
      aria-busy="true"
      aria-label={t("traders.loading")}
    >
      {Array.from({ length: cards }, (_, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: fixed placeholder cards
        <div key={i} className="tr-agree-card" aria-hidden>
          <div className="tr-agree-top">
            <Bar width={34} px height={12} />
            <Bar width={30} px />
          </div>
          <Bar width={70} height={9} />
          <Bar width={100} height={5} />
          <Bar width={pick(WIDE, i)} />
          <Bar width={pick(NUM, i) - 10} height={7} />
        </div>
      ))}
    </div>
  );
}

/** One trader's positions, as chips not yet in. */
export function ChipsSkeleton({ i = 0 }: { i?: number }) {
  return (
    <span className="tr-skel tr-skel-chips" aria-hidden>
      {Array.from({ length: 2 + (i % 3) }, (_, c) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: fixed placeholder chips
        <Bar key={c} width={70 + ((i + c) % 3) * 18} px height={20} />
      ))}
    </span>
  );
}

/** A member's side, not yet read. */
export const SideSkeleton = () => <Bar width={34} px height={14} />;
