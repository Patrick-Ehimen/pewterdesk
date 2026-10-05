import type { OrderBook } from "@pewterdesk/core";
import { t } from "../../i18n";
import { depthLevels, imbalance, largestWalls } from "../../lib/depth";
import { decimalsOf, formatNumber, formatPercent, formatSigned } from "../../lib/format";
import { DepthChart, type DepthDisplay } from "./DepthChart";

/** Breathing room past the book's outermost level, so the curves don't touch the edges. */
const FIT_MARGIN = 1.08;

interface DepthViewProps {
  book: OrderBook;
  venue?: string;
  base?: string;
  /** Zoom to ±span of the mid, in place of fitting the visible book. */
  span?: number;
  display?: DepthDisplay;
}

/**
 * The Depth tab when the panel is expanded, after the design: the detailed
 * depth chart, zoomed to fit the visible book, and two readouts underneath -
 * book imbalance across that span, and the largest walls.
 */
export function DepthView({ book, venue, base, span, display }: DepthViewProps) {
  const { bids, asks } = depthLevels(book);
  const bestBid = bids[0];
  const bestAsk = asks[0];
  const mid = bestBid && bestAsk ? (bestBid.price + bestAsk.price) / 2 : 0;
  // Zoom to the furthest visible level from the mid, plus a little room.
  const reach =
    mid > 0
      ? Math.max(mid - (bids.at(-1)?.price ?? mid), (asks.at(-1)?.price ?? mid) - mid) / mid
      : 0;
  const range = span ?? Math.max(reach * FIT_MARGIN, 0.0005);
  const decimals = decimalsOf(book.bids[0]?.price ?? book.asks[0]?.price ?? "0");

  const balance = imbalance(bids, asks, mid, range);
  const walls = largestWalls(bids, asks, mid, 3);
  const reading =
    Math.abs(balance.bidShare - 0.5) < 0.05
      ? t("depth.imbalanceEven")
      : t(balance.bidShare > 0.5 ? "depth.imbalanceBids" : "depth.imbalanceAsks");
  const imbalanceTitle = t("depth.imbalance", {
    pct: formatNumber(range * 100, range < 0.001 ? 3 : range < 0.01 ? 2 : 0),
  });

  return (
    <div className="pd-depth-view">
      <DepthChart book={book} venue={venue} base={base} detailed range={range} display={display} />

      <div className="pd-depth-cards">
        <section className="pd-depth-card" aria-label={imbalanceTitle}>
          <h3>{imbalanceTitle}</h3>
          <div className="pd-depth-shares">
            <strong className="pd-up">{formatPercent(balance.bidShare, 0)}</strong>
            <strong className="pd-down">{formatPercent(1 - balance.bidShare, 0)}</strong>
          </div>
          <div className="pd-ratio-bar" aria-hidden>
            <div data-side="bid" style={{ width: `${balance.bidShare * 100}%` }} />
            <div data-side="ask" style={{ width: `${(1 - balance.bidShare) * 100}%` }} />
          </div>
          <p>{reading}</p>
        </section>

        <section className="pd-depth-card" aria-label={t("depth.walls")}>
          <h3>{t("depth.walls")}</h3>
          {walls.length === 0 ? (
            <p>{t("depth.noWalls")}</p>
          ) : (
            <ul className="pd-depth-walls">
              {walls.map((w) => (
                <li key={`${w.side}${w.price}`}>
                  <span className="pd-depth-dot-mark" data-side={w.side} aria-hidden />
                  <span className={w.side === "bid" ? "pd-up" : "pd-down"}>
                    {formatNumber(w.price, decimals)}
                  </span>
                  <span>
                    {formatNumber(w.size, 0)}
                    {base ? ` ${base}` : ""}
                  </span>
                  <span className="pd-muted">{formatSigned(w.fromMid * 100)}%</span>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </div>
  );
}
