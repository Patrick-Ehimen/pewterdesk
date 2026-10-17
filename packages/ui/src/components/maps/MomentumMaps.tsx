import type { Market } from "@pewterdesk/core";
import { hierarchy, treemap, treemapSquarify } from "d3-hierarchy";
import { type CSSProperties, type ReactNode, useState } from "react";
import { t } from "../../i18n";
import { formatCompact, formatNumber } from "../../lib/format";
import {
  median,
  PERF_WINDOWS,
  type PerfWindow,
  VOL_MEASURES,
  type VolMeasure,
  type VolRegime,
  volRegime,
} from "../../lib/mapStats";
import { TokenIcon } from "../trading/TokenIcon";
import {
  HistoryProgress,
  HoverCard,
  heat,
  labelsOf,
  MapFrame,
  MapState,
  pointerIn,
  Seg,
  signedPct,
  useSize,
} from "./kit";

export type MapTop = "30" | "60" | "100";
export const MAP_TOPS: readonly MapTop[] = ["30", "60", "100"];

/** How far a window's change goes before its tile is at full colour. */
const PERF_SCALE: Record<PerfWindow, number> = { "1h": 0.015, "4h": 0.03, "24h": 0.08, "7d": 0.2 };

export interface PerfTile {
  market: Market;
  price: number;
  /** The day's volume in quote currency, which sizes the tile. */
  volume: number;
  changes: Partial<Record<PerfWindow, number>>;
}

/**
 * Every market's return over a window as a treemap, sized by the day's
 * volume: what's leading and lagging on this venue, at a glance.
 */
export function PerformanceMap({
  tiles,
  window,
  onWindow,
  top,
  onTop,
  progress,
  loader,
  extra,
  onTrade,
}: {
  tiles: readonly PerfTile[];
  window: PerfWindow;
  onWindow: (w: PerfWindow) => void;
  top: MapTop;
  onTop: (top: MapTop) => void;
  /** Markets whose history has arrived, of all listed. */
  progress: { done: number; total: number };
  loader?: ReactNode;
  /** More controls after the view's own (the Crypto / All filter). */
  extra?: ReactNode;
  onTrade: (market: Market) => void;
}) {
  const [ref, size] = useSize<HTMLDivElement>();
  const [hover, setHover] = useState<{ id: string; x: number; y: number }>();
  const shown = [...tiles]
    .filter((tile) => tile.volume > 0)
    .sort((a, b) => b.volume - a.volume)
    .slice(0, Number(top));
  const root = treemap<{ children?: PerfTile[] } | PerfTile>()
    .tile(treemapSquarify)
    .size([Math.max(size.width, 1), Math.max(size.height, 1)])
    .paddingInner(1)
    .round(true)(
    hierarchy<{ children?: PerfTile[] } | PerfTile>({ children: shown }, (d) =>
      "children" in d ? d.children : undefined,
    ).sum((d) => ("volume" in d ? d.volume : 0)),
  );
  const tip = hover && shown.find((s) => s.market.id === hover.id);
  const known = shown.map((s) => s.changes[window]).filter((c): c is number => c !== undefined);
  const up = known.filter((c) => c > 0).length;
  const nameOf = labelsOf(shown.map((s) => s.market));

  return (
    <MapFrame
      title={t("mapx.perf.title")}
      controls={
        <>
          <Seg options={PERF_WINDOWS} value={window} onChange={onWindow} label={t("mapx.window")} />
          <Seg
            options={MAP_TOPS}
            value={top}
            onChange={onTop}
            label={t("mapx.top")}
            text={(n) => t("mapx.topN", { count: n })}
          />
          {extra}
        </>
      }
      legend={
        known.length > 0 && (
          <>
            <HistoryProgress {...progress} />
            <span className="pd-up pd-num">{t("mapx.perf.up", { count: up })}</span>
            <span className="pd-down pd-num">
              {t("mapx.perf.down", { count: known.length - up })}
            </span>
            <span className="pd-num">
              {t("mapx.perf.median", { value: signedPct(median(known)) })}
            </span>
          </>
        )
      }
      note={t("mapx.perf.note")}
      state={shown.length === 0 ? <MapState loader={loader} progress={progress} /> : undefined}
    >
      <div ref={ref} className="pd-mx-fill" onPointerLeave={() => setHover(undefined)}>
        {/* With no tiles, the empty root is the one leaf. */}
        {root.leaves().map((leaf) => {
          if (!("market" in leaf.data)) return null;
          const d = leaf.data;
          const w = leaf.x1 - leaf.x0;
          const h = leaf.y1 - leaf.y0;
          const change = d.changes[window];
          const tone = heat(change, PERF_SCALE[window]);
          return (
            <button
              key={d.market.id}
              type="button"
              className="pd-mx-tile"
              data-heat={tone["data-heat"]}
              style={
                {
                  ...tone.style,
                  left: leaf.x0,
                  top: leaf.y0,
                  width: w,
                  height: h,
                  fontSize: Math.min(Math.max(Math.sqrt(w * h) / 7, 10), 30),
                } as CSSProperties
              }
              onPointerMove={(e) => setHover({ id: d.market.id, ...pointerIn(e) })}
              onClick={() => onTrade(d.market)}
            >
              {w > 34 && h > 20 && (
                <>
                  <span className="pd-mx-tile-name">
                    {w > 90 && h > 50 && <TokenIcon market={d.market} size={16} />}
                    {nameOf(d.market)}
                  </span>
                  {h > 36 && <span className="pd-mx-tile-value pd-num">{signedPct(change)}</span>}
                </>
              )}
            </button>
          );
        })}
        {tip && hover && (
          <HoverCard at={hover} box={size}>
            <div className="pd-map-card-head">
              <TokenIcon market={tip.market} size={18} />
              <strong>{tip.market.symbol}</strong>
            </div>
            <dl>
              <dt>{t("col.price")}</dt>
              <dd className="pd-num">{formatNumber(tip.price)}</dd>
              {PERF_WINDOWS.map((w) => (
                <div key={w} className="pd-map-card-row">
                  <dt>{w.toUpperCase()}</dt>
                  <dd className={`pd-num ${tone(tip.changes[w])}`}>{signedPct(tip.changes[w])}</dd>
                </div>
              ))}
              <dt>{t("mapx.volume24h")}</dt>
              <dd className="pd-num">${formatCompact(tip.volume)}</dd>
            </dl>
          </HoverCard>
        )}
      </div>
    </MapFrame>
  );
}

const tone = (v: number | undefined) =>
  v === undefined ? "" : v > 0 ? "pd-up" : v < 0 ? "pd-down" : "";

export interface VolRow {
  market: Market;
  /** Annualised realised volatility over the day and the week. */
  vol24h?: number;
  vol7d?: number;
  /** The average true range of the last 14 hours, as a share of price. */
  atr?: number;
  change24h?: number;
}

/** How many of the ranking's rows are listed: the top 40, the top 100, or every one. */
export type VolRows = "40" | "100" | "all";
export const VOL_ROW_COUNTS: readonly VolRows[] = ["40", "100", "all"];
/** Which markets the ranking lists, by how the day's volatility compares with the week's. */
export type VolFilter = "all" | VolRegime;
export const VOL_FILTERS: readonly VolFilter[] = ["all", "expanding", "steady", "contracting"];

/**
 * Markets ranked by how much they move (realised volatility over the day or
 * the week, or the hourly ATR), each marked expanding or contracting by the
 * day against the week; the quietest markets alongside.
 */
export function VolatilityMap({
  rows,
  measure,
  onMeasure,
  rowCount,
  onRowCount,
  filter,
  onFilter,
  progress,
  loader,
  extra,
  onTrade,
}: {
  rows: readonly VolRow[];
  measure: VolMeasure;
  onMeasure: (m: VolMeasure) => void;
  rowCount: VolRows;
  onRowCount: (rows: VolRows) => void;
  filter: VolFilter;
  onFilter: (filter: VolFilter) => void;
  progress: { done: number; total: number };
  loader?: ReactNode;
  /** More controls after the view's own (the Crypto / All filter). */
  extra?: ReactNode;
  onTrade: (market: Market) => void;
}) {
  const valued = rows
    .map((r) => ({ ...r, value: r[measure], regime: volRegime(r.vol24h, r.vol7d) }))
    .filter((r): r is typeof r & { value: number } => r.value !== undefined);
  const ranked = [...valued].sort((a, b) => b.value - a.value);
  // The regimes and the quietest stay the whole market's; the list follows the filter.
  const listed = filter === "all" ? ranked : ranked.filter((r) => r.regime === filter);
  const shown = rowCount === "all" ? listed : listed.slice(0, Number(rowCount));
  const max = ranked[0]?.value ?? 0;
  const count = (regime: VolRegime) => valued.filter((r) => r.regime === regime).length;
  const label = (m: VolMeasure) => t(`mapx.vol.${m}`);
  const show = (v: number) => formatNumber(v * 100, measure === "atr" ? 2 : 0);
  const nameOf = labelsOf(ranked.map((r) => r.market));

  return (
    <MapFrame
      title={t("mapx.vol.title")}
      controls={
        <>
          <Seg
            options={VOL_MEASURES}
            value={measure}
            onChange={onMeasure}
            label={t("mapx.measure")}
            text={label}
          />
          <Seg
            options={VOL_FILTERS}
            value={filter}
            onChange={onFilter}
            label={t("mapx.vol.filter")}
            text={(f) => (f === "all" ? t("mapx.vol.allRegimes") : t(`mapx.vol.${f}`))}
          />
          <Seg
            options={VOL_ROW_COUNTS}
            value={rowCount}
            onChange={onRowCount}
            label={t("mapx.rows")}
            text={(n) => (n === "all" ? t("mapx.rowsAll") : t("mapx.topN", { count: n }))}
          />
          {extra}
        </>
      }
      legend={
        ranked.length > 0 && (
          <>
            <span className="pd-num">
              {t("mapx.vol.shown", { shown: shown.length, ranked: listed.length })}
            </span>
            <HistoryProgress {...progress} />
          </>
        )
      }
      note={t("mapx.vol.note")}
      state={ranked.length === 0 ? <MapState loader={loader} progress={progress} /> : undefined}
      side={
        ranked.length > 0 && (
          <>
            <h3>{t("mapx.vol.regimes")}</h3>
            <div className="pd-mx-stats">
              {(["expanding", "steady", "contracting"] as const).map((r) => (
                <div key={r} className="pd-mx-stat" data-regime={r}>
                  <span>{t(`mapx.vol.${r}`)}</span>
                  <strong className="pd-num">{count(r)}</strong>
                </div>
              ))}
              <div className="pd-mx-stat">
                <span>{t("mapx.vol.median", { measure: label(measure) })}</span>
                <strong className="pd-num">{`${show(median(ranked.map((r) => r.value)) ?? 0)}%`}</strong>
              </div>
            </div>
            <h3>{t("mapx.vol.quietest")}</h3>
            <ol className="pd-mx-list">
              {ranked
                .slice(-8)
                .reverse()
                .map((r) => (
                  <li key={r.market.id}>
                    <button type="button" onClick={() => onTrade(r.market)}>
                      <TokenIcon market={r.market} size={14} />
                      <span>{nameOf(r.market)}</span>
                      <span className="pd-num pd-muted">{`${show(r.value)}%`}</span>
                    </button>
                  </li>
                ))}
            </ol>
          </>
        )
      }
    >
      <div className="pd-mx-scroll">
        {shown.length === 0 && <MapState message={t("mapx.vol.noneInRegime")} />}
        <ol className="pd-mx-bars">
          {shown.map((r, i) => (
            <li key={r.market.id}>
              <button type="button" onClick={() => onTrade(r.market)}>
                <span className="pd-mx-rank pd-num">{i + 1}</span>
                <span className="pd-mx-name">
                  <TokenIcon market={r.market} size={16} />
                  {nameOf(r.market)}
                </span>
                <span className="pd-mx-track">
                  <span
                    className="pd-mx-fillbar"
                    data-heat="warn"
                    style={{ width: `${max > 0 ? (r.value / max) * 100 : 0}%` }}
                  />
                </span>
                <span className="pd-num">{`${show(r.value)}%`}</span>
                <span className={`pd-num ${tone(r.change24h)}`}>{signedPct(r.change24h)}</span>
                {r.regime ? (
                  <span className="pd-mx-chip" data-regime={r.regime}>
                    {t(`mapx.vol.${r.regime}`)}
                  </span>
                ) : (
                  <span />
                )}
              </button>
            </li>
          ))}
        </ol>
      </div>
    </MapFrame>
  );
}
