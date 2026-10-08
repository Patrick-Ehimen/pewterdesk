import type { Market } from "@pewterdesk/core";
import { hierarchy, treemap, treemapSquarify } from "d3-hierarchy";
import { type CSSProperties, type ReactNode, useEffect, useRef, useState } from "react";
import { dateFormat, t } from "../../i18n";
import { formatCompact, formatNumber } from "../../lib/format";
import { HOUR_MS, type LiqEvent, liqByMarket, liqTotals, sourceOf } from "../../lib/liquidations";
import { EmptyState } from "../common/Status";
import { TokenIcon } from "../trading/TokenIcon";

export type LiqWindow = "1h" | "4h" | "12h" | "24h";
export const LIQ_WINDOWS: readonly LiqWindow[] = ["1h", "4h", "12h", "24h"];
const WINDOW_MS: Record<LiqWindow, number> = {
  "1h": HOUR_MS,
  "4h": 4 * HOUR_MS,
  "12h": 12 * HOUR_MS,
  "24h": 24 * HOUR_MS,
};
/** Markets in the treemap; the rest are summed as "Others". */
const TREEMAP_MARKETS = 40;
/** Rows in the live list. */
const FEED_ROWS = 80;
const CLOCK: Intl.DateTimeFormatOptions = {
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hour12: false,
};

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

interface Leaf {
  market: string;
  long: number;
  short: number;
  total: number;
}
type TreeNode = { children: Leaf[] } | Leaf;

interface LiquidationsProps {
  /** Newest first: the past day's history and the live feed together. */
  events: readonly LiqEvent[];
  /** The past day's history still being read: markets done of the total. */
  backfill?: { done: number; total: number };
  /** Shown in the map while that history loads and there's nothing to draw yet. */
  loader?: ReactNode;
  /** For names and logos, by `Market::id`. */
  markets: ReadonlyMap<string, Market>;
  window: LiqWindow;
  onWindow: (window: LiqWindow) => void;
  onTrade: (market: Market) => void;
  /** The feed can't be read (the venue serves none, or it failed). */
  error?: string;
}

/**
 * The venue's liquidations, after coinglass: a treemap of markets by value
 * liquidated over the window (red where longs were liquidated, green where
 * shorts were, deeper the more one-sided), totals for 1, 4, 12 and 24
 * hours, and the live list. The past day comes from OKX's public history
 * and what happens now from Bybit's public feed; the totals and the map
 * count both, the live list shows the feed.
 */
export function Liquidations({
  events,
  backfill,
  loader,
  markets,
  window,
  onWindow,
  onTrade,
  error,
}: LiquidationsProps) {
  const [mapRef, { width, height }] = useSize<HTMLDivElement>();
  const [hover, setHover] = useState<{ market: string; x: number; y: number }>();
  // Re-summed every few seconds, so the windows slide even when it's quiet.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 5000);
    return () => clearInterval(id);
  }, []);

  const live = events.filter((e) => sourceOf(e) === "bybit");
  // Still reading (a total of 0 is the moment before the markets are known).
  const fetching =
    backfill !== undefined && (backfill.total === 0 || backfill.done < backfill.total);
  const byMarket = liqByMarket(events, now, WINDOW_MS[window]);
  const top: Leaf[] = byMarket.slice(0, TREEMAP_MARKETS);
  const others = byMarket.slice(TREEMAP_MARKETS).reduce<Leaf>(
    (o, m) => ({
      market: "",
      long: o.long + m.long,
      short: o.short + m.short,
      total: o.total + m.total,
    }),
    { market: "", long: 0, short: 0, total: 0 },
  );
  const leaves = others.total > 0 ? [...top, others] : top;
  const root = treemap<TreeNode>()
    .tile(treemapSquarify)
    .size([Math.max(width, 1), Math.max(height, 1)])
    .paddingInner(1)
    .round(true)(
    hierarchy<TreeNode>({ children: leaves }, (d) =>
      "children" in d ? d.children : undefined,
    ).sum((d) => ("total" in d ? d.total : 0)),
  );
  const nameOf = (id: string) => markets.get(id)?.base ?? id.replace(/USDT$|USDC$|PERP$/, "");
  // The hovered tile's numbers over the window, by side and by exchange.
  const tip = (() => {
    if (!hover) return undefined;
    const leaf = leaves.find((l) => l.market === hover.market);
    if (!leaf) return undefined;
    const inTop = new Set(top.map((l) => l.market));
    const cutoff = now - WINDOW_MS[window];
    let count = 0;
    let largest = 0;
    for (const e of events) {
      if (e.time < cutoff) continue;
      // "Others" gathers every market outside the top ones.
      if (hover.market ? e.market !== hover.market : inTop.has(e.market)) continue;
      count += 1;
      largest = Math.max(largest, e.value);
    }
    return {
      ...leaf,
      name: hover.market ? nameOf(hover.market) : t("liq.others"),
      market: hover.market ? markets.get(hover.market) : undefined,
      count,
      largest,
    };
  })();

  return (
    <div className="pd-liq">
      <section className="pd-liq-main">
        <div className="pd-liq-bar">
          <h2>{t("liq.heatmap")}</h2>
          <div className="pd-map-seg" role="radiogroup" aria-label={t("liq.window")}>
            {LIQ_WINDOWS.map((w) => (
              // biome-ignore lint/a11y/useSemanticElements: compact segmented control
              <button
                key={w}
                type="button"
                role="radio"
                aria-checked={w === window}
                data-checked={w === window || undefined}
                onClick={() => onWindow(w)}
              >
                {w.toUpperCase()}
              </button>
            ))}
          </div>
          {backfill && backfill.done < backfill.total && (
            <span className="pd-muted pd-liq-progress" role="status">
              {t("liq.backfill", { done: backfill.done, total: backfill.total })}
            </span>
          )}
          <span className="pd-liq-key">
            <i className="pd-liq-swatch" data-side="long" aria-hidden /> {t("liq.longs")}
            <i className="pd-liq-swatch" data-side="short" aria-hidden /> {t("liq.shorts")}
          </span>
        </div>
        <div ref={mapRef} className="pd-liq-map" onPointerLeave={() => setHover(undefined)}>
          {error ? (
            <EmptyState>{error}</EmptyState>
          ) : leaves.length === 0 ? (
            fetching && loader ? (
              <div className="pd-liq-loading" role="status" aria-label={t("feed.loading")}>
                {loader}
              </div>
            ) : (
              <EmptyState>{t("liq.waiting")}</EmptyState>
            )
          ) : (
            root.leaves().map((leaf) => {
              const d = leaf.data as Leaf;
              const w = leaf.x1 - leaf.x0;
              const h = leaf.y1 - leaf.y0;
              const longShare = d.total > 0 ? d.long / d.total : 0.5;
              const side = longShare >= 0.5 ? "long" : "short";
              const market = d.market ? markets.get(d.market) : undefined;
              const big = w > 90 && h > 54;
              const name = d.market ? nameOf(d.market) : t("liq.others");
              return (
                <button
                  key={d.market || "others"}
                  type="button"
                  className="pd-liq-cell"
                  data-side={side}
                  data-tradable={market ? true : undefined}
                  style={
                    {
                      left: leaf.x0,
                      top: leaf.y0,
                      width: w,
                      height: h,
                      fontSize: Math.min(Math.max(Math.sqrt(w * h) / 7, 10), 40),
                    } as CSSProperties
                  }
                  onPointerMove={(e) => {
                    const box = e.currentTarget.parentElement?.getBoundingClientRect();
                    setHover({
                      market: d.market,
                      x: e.clientX - (box?.left ?? 0),
                      y: e.clientY - (box?.top ?? 0),
                    });
                  }}
                  onClick={() => market && onTrade(market)}
                >
                  {w > 34 && h > 20 && (
                    <>
                      <span className="pd-liq-name">
                        {big && market && <TokenIcon market={market} size={18} />}
                        {name}
                      </span>
                      {h > 38 && (
                        <span className="pd-liq-value pd-num">${formatCompact(d.total)}</span>
                      )}
                    </>
                  )}
                </button>
              );
            })
          )}
          {tip && hover && (
            <div
              className="pd-map-card pd-liq-tip"
              style={{
                left: hover.x + 264 > width ? Math.max(hover.x - 256, 4) : hover.x + 16,
                top: Math.min(Math.max(hover.y - 30, 4), Math.max(height - 210, 4)),
              }}
              aria-hidden
            >
              <div className="pd-map-card-head">
                {tip.market && <TokenIcon market={tip.market} size={18} />}
                <strong>{tip.name}</strong>
                <span className="pd-muted">{window.toUpperCase()}</span>
              </div>
              <dl>
                <dt>{t("liq.totals")}</dt>
                <dd className="pd-num">${formatCompact(tip.total)}</dd>
                <dt>{t("liq.longs")}</dt>
                <dd className="pd-num pd-down">${formatCompact(tip.long)}</dd>
                <dt>{t("liq.shorts")}</dt>
                <dd className="pd-num pd-up">${formatCompact(tip.short)}</dd>
                <dt>{t("liq.count")}</dt>
                <dd className="pd-num">{formatNumber(tip.count, 0)}</dd>
                {tip.largest > 0 && (
                  <div className="pd-map-card-row">
                    <dt>{t("liq.largest")}</dt>
                    <dd className="pd-num">${formatCompact(tip.largest)}</dd>
                  </div>
                )}
              </dl>
              <div className="pd-liq-tip-bar">
                <span
                  className="pd-liq-tip-long"
                  style={{ width: `${tip.total > 0 ? (tip.long / tip.total) * 100 : 50}%` }}
                />
                <span className="pd-liq-tip-short" style={{ flex: 1 }} />
              </div>
            </div>
          )}
        </div>
      </section>

      <aside className="pd-liq-side">
        <h2>{t("liq.totals")}</h2>
        <div className="pd-liq-cards">
          {LIQ_WINDOWS.map((w) => {
            const sum = liqTotals(events, now, WINDOW_MS[w]);
            return (
              <div key={w} className="pd-liq-card" data-on={w === window || undefined}>
                <div className="pd-liq-card-head">
                  <span className="pd-liq-card-label">
                    {t("liq.rekt", { window: w.toUpperCase() })}
                  </span>
                  <strong className="pd-num">${formatCompact(sum.total)}</strong>
                </div>
                <div className="pd-liq-card-row">
                  <span className="pd-liq-card-label">{t("liq.longs")}</span>
                  <span className="pd-num pd-down">${formatCompact(sum.long)}</span>
                </div>
                <div className="pd-liq-card-row">
                  <span className="pd-liq-card-label">{t("liq.shorts")}</span>
                  <span className="pd-num pd-up">${formatCompact(sum.short)}</span>
                </div>
              </div>
            );
          })}
        </div>
        <p className="pd-liq-note">{t("liq.note")}</p>
        <h2>{t("liq.live")}</h2>
        <div className="pd-liq-feed" role="log" aria-live="polite">
          <div className="pd-liq-feed-head">
            <span>{t("col.market")}</span>
            <span>{t("col.price")}</span>
            <span>{t("liq.value")}</span>
            <span>{t("liq.time")}</span>
          </div>
          {live.slice(0, FEED_ROWS).map((e) => {
            const market = markets.get(e.market);
            return (
              <button
                key={`${e.market}${e.time}${e.price}${e.size}${e.side}`}
                type="button"
                className="pd-liq-row"
                data-side={e.side}
                data-tradable={market ? true : undefined}
                onClick={() => market && onTrade(market)}
              >
                <span className="pd-liq-row-name">
                  {market && <TokenIcon market={market} size={14} />}
                  {nameOf(e.market)}
                  <em>{t(e.side === "long" ? "liq.long" : "liq.short")}</em>
                </span>
                <span className="pd-num">
                  {formatNumber(Number(e.price), Number(e.price) < 1 ? 5 : 2)}
                </span>
                <span className="pd-num">${formatCompact(e.value)}</span>
                <span className="pd-num pd-muted">{dateFormat(CLOCK).format(e.time)}</span>
              </button>
            );
          })}
        </div>
      </aside>
    </div>
  );
}
