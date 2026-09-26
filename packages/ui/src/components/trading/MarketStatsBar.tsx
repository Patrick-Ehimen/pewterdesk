import type { Market, MarketStats } from "@pewterdesk/core";
import { type ReactNode, useEffect, useRef, useState, type WheelEvent } from "react";
import { LuInfo } from "react-icons/lu";
import { t } from "../../i18n";
import { decimalsOf, formatNumber, formatSigned, trendClass } from "../../lib/format";
import { Tooltip } from "../common/Tooltip";
import { MarketPicker } from "./MarketPicker";
import { usePriceTrend } from "./OrderBookView";

/** Milliseconds since the epoch, re-read every `everyMs`. */
function useNow(everyMs: number) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), everyMs);
    return () => clearInterval(id);
  }, [everyMs]);
  return now;
}

/** "00:32:15" */
function clock(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(Math.floor(total / 3600))}:${pad(Math.floor((total % 3600) / 60))}:${pad(total % 60)}`;
}

/**
 * Tracks whether a horizontal scroller has content hidden on either side (for
 * the edge fades), and turns a vertical mouse wheel into sideways scrolling.
 */
function useSideScroll<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [edges, setEdges] = useState({ before: false, after: false });
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const update = () => {
      const before = el.scrollLeft > 1;
      const after = el.scrollLeft + el.clientWidth < el.scrollWidth - 1;
      setEdges((prev) =>
        prev.before === before && prev.after === after ? prev : { before, after },
      );
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(el);
    for (const child of el.children) observer.observe(child);
    el.addEventListener("scroll", update, { passive: true });
    return () => {
      observer.disconnect();
      el.removeEventListener("scroll", update);
    };
  }, []);
  const onWheel = (e: WheelEvent<T>) => {
    const el = ref.current;
    // Only a mostly-vertical wheel, and only when there's somewhere to go.
    if (!el || Math.abs(e.deltaY) <= Math.abs(e.deltaX) || el.scrollWidth <= el.clientWidth) return;
    el.scrollLeft += e.deltaY;
  };
  return { ref, ...edges, onWheel };
}

/** A skeleton bar standing in for a value that hasn't arrived. */
const Pending = ({ width }: { width: number }) => (
  <span className="pd-skel" style={{ width, height: 10 }} aria-hidden />
);

function Stat({ label, children }: { label: ReactNode; children: ReactNode }) {
  return (
    <div className="pd-stat">
      <span className="pd-stat-label">{label}</span>
      <span className="pd-stat-value">{children}</span>
    </div>
  );
}

interface MarketStatsBarProps {
  /** The market on screen; unset while the market list loads. */
  market?: Market;
  /** The venue's display name, e.g. "Hyperliquid". */
  venue: string;
  /** Unset until the first update arrives. */
  stats?: MarketStats;
  markets: Market[];
  onSelectMarket: (market: Market) => void;
}

/**
 * The market's headline numbers in one row: mark and mid, index, the day's
 * change, range and volume, open interest, and funding with a countdown to
 * the next payment.
 */
export function MarketStatsBar({
  market,
  venue,
  stats,
  markets,
  onSelectMarket,
}: MarketStatsBarProps) {
  const now = useNow(1000);
  const scroller = useSideScroll<HTMLDivElement>();
  const priceDecimals = stats ? decimalsOf(stats.markPrice) : 2;
  const mark = stats ? Number(stats.markPrice) : undefined;
  const trend = usePriceTrend(mark);

  const prev = stats ? Number(stats.prevDayPrice) : Number.NaN;
  const change = mark !== undefined ? mark - prev : Number.NaN;

  // The venue says when the current interval pays; if an update is late,
  // keep counting through later intervals rather than sitting at zero.
  let nextFunding = stats?.nextFundingTime ?? 0;
  const interval = (stats?.fundingIntervalSecs ?? 3600) * 1000;
  while (stats && nextFunding <= now) nextFunding += interval;
  const intervalHours = interval / 3_600_000;

  return (
    <section
      className="pd-stats"
      aria-busy={!stats}
      aria-label={stats ? (market?.symbol ?? venue) : t("stats.loading")}
    >
      {/* Pinned: the picker, market and price never scroll away. */}
      <div className="pd-stats-fixed">
        <MarketPicker markets={markets} selected={market?.id} onSelect={onSelectMarket} />

        <div className="pd-stats-market">
          <span className="pd-coin" aria-hidden>
            {market?.base.slice(0, 1) ?? ""}
          </span>
          <div className="pd-stats-name">
            <strong>{market?.symbol ?? <Pending width={90} />}</strong>
            <span className="pd-muted">
              {venue}
              {market && (
                <Tooltip
                  className="pd-stats-info"
                  content={t("stats.marketInfo", {
                    venue,
                    leverage: market.maxLeverage,
                    tick: market.tickSize,
                    min: market.minSize,
                  })}
                >
                  <LuInfo size={13} aria-hidden />
                  <span className="pd-visually-hidden">{t("col.market")}</span>
                </Tooltip>
              )}
            </span>
          </div>
        </div>

        <div className="pd-stats-price">
          <Tooltip content={t("stats.markHint")}>
            <strong
              className={`pd-stats-mark ${trend === "up" ? "pd-up" : trend === "down" ? "pd-down" : ""}`}
            >
              {stats ? formatNumber(stats.markPrice, priceDecimals) : <Pending width={80} />}
            </strong>
          </Tooltip>
          <Tooltip content={`${t("stats.mid")}: ${t("stats.midHint")}`}>
            <span className="pd-stats-mid">
              {stats?.midPrice ? formatNumber(stats.midPrice, priceDecimals) : "—"}
            </span>
          </Tooltip>
        </div>
      </div>

      <span className="pd-stats-divider" aria-hidden />

      {/* The stat columns scroll sideways when the bar is too narrow. */}
      <div
        ref={scroller.ref}
        className="pd-stats-scroll"
        data-more-before={scroller.before || undefined}
        data-more-after={scroller.after || undefined}
        onWheel={scroller.onWheel}
      >
        <Stat label={<Tooltip content={t("stats.indexHint")}>{t("stats.index")}</Tooltip>}>
          {stats?.indexPrice ? (
            formatNumber(stats.indexPrice, priceDecimals)
          ) : (
            <Pending width={60} />
          )}
        </Stat>
        <Stat label={t("stats.change")}>
          {stats ? (
            <span className={trendClass(change)}>
              {formatSigned(change, priceDecimals)} ({formatSigned((change / prev) * 100)}%)
            </span>
          ) : (
            <Pending width={110} />
          )}
        </Stat>
        <Stat label={t("stats.high")}>
          {stats?.dayHigh ? formatNumber(stats.dayHigh, priceDecimals) : <Pending width={60} />}
        </Stat>
        <Stat label={t("stats.low")}>
          {stats?.dayLow ? formatNumber(stats.dayLow, priceDecimals) : <Pending width={60} />}
        </Stat>
        <Stat label={t("stats.volume", { asset: market?.quote ?? "" })}>
          {stats ? formatNumber(stats.dayVolume, 2) : <Pending width={110} />}
        </Stat>
        <Stat label={t("stats.openInterest", { asset: market?.base ?? "" })}>
          {stats ? formatNumber(stats.openInterest, 2) : <Pending width={90} />}
        </Stat>
        <Stat
          label={
            <Tooltip content={t("stats.fundingHint", { hours: intervalHours })}>
              {t("stats.funding")}
            </Tooltip>
          }
        >
          {stats ? (
            <>
              <span className="pd-stats-funding">
                {formatSigned(Number(stats.fundingRate) * 100, 4)}%
              </span>
              {" / "}
              {clock(nextFunding - now)} ({intervalHours}h)
            </>
          ) : (
            <Pending width={130} />
          )}
        </Stat>
      </div>
    </section>
  );
}
