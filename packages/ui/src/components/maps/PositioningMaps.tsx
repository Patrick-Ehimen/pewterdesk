import type { Market, VenueId } from "@pewterdesk/core";
import { type ReactNode, useState } from "react";
import { dateFormat, t } from "../../i18n";
import { formatCompact, formatNumber } from "../../lib/format";
import {
  type CoinRow,
  FUNDING_UNITS,
  type FundingUnit,
  fundingGap,
  fundingIn,
  OI_WINDOWS,
  type OiQuadrant,
  type OiWindow,
  oiQuadrant,
} from "../../lib/mapStats";
import { TokenIcon } from "../trading/TokenIcon";
import { HoverCard, heat, labelsOf, MapFrame, MapState, Seg, signedPct, useSize } from "./kit";

export interface MapVenue {
  id: VenueId;
  label: string;
}

export type FundingSort = "volume" | "gap" | "high" | "low";
export const FUNDING_SORTS: readonly FundingSort[] = ["volume", "gap", "high", "low"];
/** Coins in the funding table. */
const FUNDING_ROWS = 40;

/** A rate in the unit shown, as a percentage. */
const rateText = (perHour: number | undefined, unit: FundingUnit) =>
  perHour === undefined
    ? "-"
    : signedPct(fundingIn(perHour, unit), unit === "8h" ? 4 : 1).replace("+-", "-");

/** The coin's highest funding across venues, per hour. */
const topRate = (row: CoinRow, pick: (a: number, b: number) => number) =>
  Object.values(row.venues).reduce<number | undefined>(
    (best, q) =>
      q?.funding === undefined ? best : best === undefined ? q.funding : pick(best, q.funding),
    undefined,
  );

/**
 * Funding on every venue side by side, coin by coin: who pays what, and
 * where the venues disagree (the gap, widest first when sorted by it).
 */
export function FundingMap({
  rows,
  venues,
  unit,
  onUnit,
  sort,
  onSort,
  iconFor,
  onTrade,
  loading,
  loader,
}: {
  rows: readonly CoinRow[];
  venues: readonly MapVenue[];
  unit: FundingUnit;
  onUnit: (u: FundingUnit) => void;
  sort: FundingSort;
  onSort: (s: FundingSort) => void;
  /** A coin's market for its logo (and a click), on the venue on screen if listed. */
  iconFor: (base: string) => Market | undefined;
  onTrade: (base: string) => void;
  loading: boolean;
  loader?: ReactNode;
}) {
  const sorted = [...rows].sort((a, b) => {
    if (sort === "gap") return (fundingGap(b) ?? -1) - (fundingGap(a) ?? -1);
    if (sort === "high") return (topRate(b, Math.max) ?? -1) - (topRate(a, Math.max) ?? -1);
    if (sort === "low") return (topRate(a, Math.min) ?? 1) - (topRate(b, Math.min) ?? 1);
    return b.volume - a.volume;
  });
  const shown = sorted.slice(0, FUNDING_ROWS);
  // Full colour at 0.05% per 8 hours (about 55% a year): already a crowded trade.
  const scale = 0.0005 / 8;
  const gaps = [...rows]
    .filter((r) => fundingGap(r) !== undefined)
    .sort((a, b) => (fundingGap(b) ?? 0) - (fundingGap(a) ?? 0))
    .slice(0, 6);

  return (
    <MapFrame
      title={t("mapx.funding.title")}
      controls={
        <>
          <Seg
            options={FUNDING_UNITS}
            value={unit}
            onChange={onUnit}
            label={t("mapx.unit")}
            text={(u) => t(`mapx.funding.${u}`)}
          />
          <Seg
            options={FUNDING_SORTS}
            value={sort}
            onChange={onSort}
            label={t("mapx.sort")}
            text={(s) => t(`mapx.funding.sort.${s}`)}
          />
        </>
      }
      note={t("mapx.funding.note")}
      state={
        shown.length === 0 ? (
          <MapState
            loader={loading ? loader : undefined}
            message={loading ? undefined : t("mapx.none")}
          />
        ) : undefined
      }
      side={
        gaps.length > 0 && (
          <>
            <h3>{t("mapx.funding.gaps")}</h3>
            <ul className="pd-mx-gaps">
              {gaps.map((r) => {
                const quotes = venues
                  .map((v) => ({ v, rate: r.venues[v.id]?.funding }))
                  .filter((q): q is { v: MapVenue; rate: number } => q.rate !== undefined)
                  .sort((a, b) => b.rate - a.rate);
                const high = quotes[0];
                const low = quotes[quotes.length - 1];
                return (
                  <li key={r.base}>
                    <button type="button" onClick={() => onTrade(r.base)}>
                      <span className="pd-mx-name">
                        <TokenIcon market={iconFor(r.base)} size={14} />
                        {r.base}
                        <span className="pd-num pd-muted">{rateText(fundingGap(r), unit)}</span>
                      </span>
                      {high && low && (
                        <span className="pd-mx-gap-venues">
                          <span>
                            {high.v.label}{" "}
                            <b className="pd-num pd-mx-gap-rate">{rateText(high.rate, unit)}</b>
                          </span>
                          <span>
                            {low.v.label}{" "}
                            <b className="pd-num pd-mx-gap-rate">{rateText(low.rate, unit)}</b>
                          </span>
                        </span>
                      )}
                    </button>
                  </li>
                );
              })}
            </ul>
          </>
        )
      }
    >
      <div className="pd-mx-scroll">
        <table className="pd-mx-table">
          <thead>
            <tr>
              <th>{t("mapx.coin")}</th>
              {venues.map((v) => (
                <th key={v.id}>{v.label}</th>
              ))}
              <th>{t("mapx.funding.gap")}</th>
            </tr>
          </thead>
          <tbody>
            {shown.map((r) => (
              <tr key={r.base} onClick={() => onTrade(r.base)}>
                <td className="pd-mx-td">
                  <span className="pd-mx-name">
                    <TokenIcon market={iconFor(r.base)} size={16} />
                    {r.base}
                  </span>
                </td>
                {venues.map((v) => {
                  const rate = r.venues[v.id]?.funding;
                  const h = heat(rate, scale);
                  return (
                    <td
                      key={v.id}
                      className="pd-mx-td pd-mx-cell pd-num"
                      data-heat={h["data-heat"]}
                      style={h.style}
                    >
                      {rateText(rate, unit)}
                    </td>
                  );
                })}
                <td className="pd-mx-td pd-num pd-muted">{rateText(fundingGap(r), unit)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </MapFrame>
  );
}

export interface OiPoint {
  market: Market;
  priceChange?: number;
  oiChange?: number;
  /** Open interest in quote currency, which sizes the dot. */
  oiValue: number;
}

/** "35m", "1h 20m": how long the samples cover. */
const spanText = (minutes: number) => {
  const m = Math.round(minutes);
  return m < 60 ? `${m}m` : `${Math.floor(m / 60)}h${m % 60 ? ` ${m % 60}m` : ""}`;
};

const QUADRANTS: readonly OiQuadrant[] = ["newLongs", "shortCovering", "newShorts", "longsClosing"];

/**
 * Price change against open-interest change, one dot per market sized by
 * its open interest: the four corners read as new longs, short covering,
 * new shorts and longs closing. The biggest moves of each are listed.
 */
export function OpenInterestMap({
  points,
  window,
  onWindow,
  since,
  history,
  soFarMinutes,
  loader,
  onTrade,
}: {
  points: readonly OiPoint[];
  window: OiWindow;
  onWindow: (w: OiWindow) => void;
  /** When the app started collecting, where the venue publishes no history. */
  since?: number;
  /** The venue serves an hourly history (otherwise it's collected while the app runs). */
  history: boolean;
  /**
   * Set while the app's own samples don't yet cover the window: the changes
   * shown are over this many minutes instead.
   */
  soFarMinutes?: number;
  loader?: ReactNode;
  onTrade: (market: Market) => void;
}) {
  const [ref, size] = useSize<HTMLDivElement>();
  const [hover, setHover] = useState<string>();
  // What the changes cover: the window, or the time collected so far.
  const span = soFarMinutes === undefined ? window.toUpperCase() : spanText(soFarMinutes);
  const known = points.filter(
    (p): p is OiPoint & { priceChange: number; oiChange: number } =>
      p.priceChange !== undefined && p.oiChange !== undefined,
  );
  // Scale to the bulk of the points, so one outlier doesn't squash the rest.
  const extent = (values: number[]) => {
    const sorted = values.map(Math.abs).sort((a, b) => a - b);
    return Math.max(sorted[Math.floor(sorted.length * 0.95)] ?? 0, 0.002) * 1.1;
  };
  const xMax = extent(known.map((p) => p.priceChange));
  const yMax = extent(known.map((p) => p.oiChange));
  const biggest = Math.max(...known.map((p) => p.oiValue), 1);
  const pad = 28;
  const w = Math.max(size.width, 1);
  const h = Math.max(size.height, 1);
  const x = (v: number) =>
    pad + ((Math.max(-xMax, Math.min(xMax, v)) + xMax) / (2 * xMax)) * (w - 2 * pad);
  const y = (v: number) =>
    h - pad - ((Math.max(-yMax, Math.min(yMax, v)) + yMax) / (2 * yMax)) * (h - 2 * pad);
  const tip = known.find((p) => p.market.id === hover);
  const nameOf = labelsOf(known.map((p) => p.market));
  const clock = dateFormat({ hour: "2-digit", minute: "2-digit", hour12: false });

  return (
    <MapFrame
      title={t("mapx.oi.title")}
      controls={
        <Seg options={OI_WINDOWS} value={window} onChange={onWindow} label={t("mapx.window")} />
      }
      legend={
        soFarMinutes !== undefined &&
        known.length > 0 && (
          <span>{t("mapx.oi.soFar", { span, window: window.toUpperCase() })}</span>
        )
      }
      note={
        history
          ? t("mapx.oi.noteHistory")
          : t("mapx.oi.noteSession", { since: since ? clock.format(since) : "-" })
      }
      state={
        known.length === 0 ? (
          <MapState
            loader={history ? loader : undefined}
            message={
              history
                ? undefined
                : `${t("mapx.oi.collecting", { window: window.toUpperCase() })} ${t("mapx.oi.tryBybit")}`
            }
          />
        ) : undefined
      }
      side={
        known.length > 0 &&
        QUADRANTS.map((q) => {
          const inQ = known
            .filter((p) => oiQuadrant(p.priceChange, p.oiChange) === q)
            .sort((a, b) => Math.abs(b.oiChange) - Math.abs(a.oiChange))
            .slice(0, 4);
          return (
            <section key={q} className="pd-mx-quad" data-quad={q}>
              <h3>
                {t(`mapx.oi.${q}`)}
                <span className="pd-muted pd-num">
                  {known.filter((p) => oiQuadrant(p.priceChange, p.oiChange) === q).length}
                </span>
              </h3>
              <ul className="pd-mx-list">
                {inQ.map((p) => (
                  <li key={p.market.id}>
                    <button type="button" onClick={() => onTrade(p.market)}>
                      <TokenIcon market={p.market} size={14} />
                      <span>{nameOf(p.market)}</span>
                      <span className="pd-num pd-muted">
                        {t("mapx.oi.short", { value: signedPct(p.oiChange, 1) })}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            </section>
          );
        })
      }
    >
      <div ref={ref} className="pd-mx-fill" onPointerLeave={() => setHover(undefined)}>
        <svg className="pd-mx-plot" width={w} height={h} role="img" aria-label={t("mapx.oi.title")}>
          <line className="pd-mx-axis" x1={x(0)} x2={x(0)} y1={pad / 2} y2={h - pad / 2} />
          <line className="pd-mx-axis" x1={pad / 2} x2={w - pad / 2} y1={y(0)} y2={y(0)} />
          <text className="pd-mx-quad-label" x={w - pad} y={pad} textAnchor="end">
            {t("mapx.oi.newLongs")}
          </text>
          <text className="pd-mx-quad-label" x={w - pad} y={h - pad} textAnchor="end">
            {t("mapx.oi.shortCovering")}
          </text>
          <text className="pd-mx-quad-label" x={pad} y={pad}>
            {t("mapx.oi.newShorts")}
          </text>
          <text className="pd-mx-quad-label" x={pad} y={h - pad}>
            {t("mapx.oi.longsClosing")}
          </text>
          <text className="pd-mx-axis-label" x={w - pad / 2} y={y(0) - 6} textAnchor="end">
            {t("mapx.oi.priceAxis")}
          </text>
          <text className="pd-mx-axis-label" x={x(0) + 6} y={pad / 2 + 4}>
            {t("mapx.oi.oiAxis")}
          </text>
          {known.map((p) => {
            const r = 3 + Math.sqrt(p.oiValue / biggest) * 13;
            const big = r > 9;
            return (
              // biome-ignore lint/a11y/noStaticElementInteractions: the list beside it is the keyboard way in
              <g
                key={p.market.id}
                className="pd-mx-dot"
                data-heat={p.priceChange >= 0 ? "up" : "down"}
                data-hover={hover === p.market.id || undefined}
                onPointerEnter={() => setHover(p.market.id)}
                onClick={() => onTrade(p.market)}
              >
                <circle cx={x(p.priceChange)} cy={y(p.oiChange)} r={r} />
                {big && (
                  <text x={x(p.priceChange)} y={y(p.oiChange) - r - 3} textAnchor="middle">
                    {nameOf(p.market)}
                  </text>
                )}
              </g>
            );
          })}
        </svg>
        {tip && (
          <HoverCard at={{ x: x(tip.priceChange), y: y(tip.oiChange) }} box={size}>
            <div className="pd-map-card-head">
              <TokenIcon market={tip.market} size={18} />
              <strong>{tip.market.symbol}</strong>
            </div>
            <dl>
              <dt>{t("mapx.oi.price", { window: span })}</dt>
              <dd className={`pd-num ${tip.priceChange >= 0 ? "pd-up" : "pd-down"}`}>
                {signedPct(tip.priceChange)}
              </dd>
              <dt>{t("mapx.oi.oi", { window: span })}</dt>
              <dd className="pd-num">{signedPct(tip.oiChange)}</dd>
              <dt>{t("mapx.oi.value")}</dt>
              <dd className="pd-num">${formatCompact(tip.oiValue)}</dd>
            </dl>
            <p className="pd-mx-tip-note">
              {t(`mapx.oi.${oiQuadrant(tip.priceChange, tip.oiChange)}Hint`)}
            </p>
          </HoverCard>
        )}
      </div>
    </MapFrame>
  );
}

export interface LongShortRow {
  base: string;
  /** The venue on screen's market for the coin, for the logo and a click. */
  market?: Market;
  /** Share of accounts long now, 0 to 1. */
  long: number;
  /** The long share a day ago. */
  dayAgo?: number;
}

export type LongShortSort = "long" | "short" | "change";
export const LONG_SHORT_SORTS: readonly LongShortSort[] = ["long", "short", "change"];

/**
 * Bybit's share of accounts long and short on its busiest markets, as one
 * bar each (long from the left, short from the right), with the day's
 * change: a read of where the crowd leans.
 */
export function LongShortMap({
  rows,
  sort,
  onSort,
  progress,
  loader,
  error,
  onTrade,
}: {
  rows: readonly LongShortRow[];
  sort: LongShortSort;
  onSort: (s: LongShortSort) => void;
  progress: { done: number; total: number };
  loader?: ReactNode;
  error?: string;
  onTrade: (row: LongShortRow) => void;
}) {
  const change = (r: LongShortRow) => (r.dayAgo === undefined ? 0 : r.long - r.dayAgo);
  const sorted = [...rows].sort((a, b) =>
    sort === "long"
      ? b.long - a.long
      : sort === "short"
        ? a.long - b.long
        : Math.abs(change(b)) - Math.abs(change(a)),
  );
  const avg = rows.length ? rows.reduce((a, r) => a + r.long, 0) / rows.length : 0;
  const loadingMore = progress.done < progress.total;

  return (
    <MapFrame
      title={t("mapx.ls.title")}
      controls={
        <Seg
          options={LONG_SHORT_SORTS}
          value={sort}
          onChange={onSort}
          label={t("mapx.sort")}
          text={(s) => t(`mapx.ls.sort.${s}`)}
        />
      }
      legend={
        rows.length > 0 && (
          <>
            <span className="pd-num">
              {t("mapx.ls.average", { value: formatNumber(avg * 100, 1) })}
            </span>
            {loadingMore && (
              <span className="pd-muted pd-num">
                {t("mapx.progress", { done: progress.done, total: progress.total })}
              </span>
            )}
          </>
        )
      }
      note={t("mapx.ls.note")}
      state={
        error ? (
          <MapState error={error} />
        ) : rows.length === 0 ? (
          <MapState loader={loader} progress={progress} />
        ) : undefined
      }
    >
      <div className="pd-mx-scroll">
        <ol className="pd-mx-ls">
          {sorted.map((r) => {
            const d = change(r);
            return (
              <li key={r.base}>
                <button type="button" onClick={() => onTrade(r)} disabled={!r.market}>
                  <span className="pd-mx-name">
                    <TokenIcon market={r.market} size={16} />
                    {r.base}
                  </span>
                  <span className="pd-num pd-up">{`${formatNumber(r.long * 100, 1)}%`}</span>
                  <span className="pd-mx-split" aria-hidden>
                    <span className="pd-mx-split-long" style={{ width: `${r.long * 100}%` }} />
                    <span className="pd-mx-split-mid" />
                  </span>
                  <span className="pd-num pd-down">{`${formatNumber((1 - r.long) * 100, 1)}%`}</span>
                  <span className="pd-num pd-muted">
                    {r.dayAgo === undefined
                      ? "-"
                      : t("mapx.ls.change", {
                          value: `${d >= 0 ? "+" : ""}${formatNumber(d * 100, 1)}`,
                        })}
                  </span>
                </button>
              </li>
            );
          })}
        </ol>
      </div>
    </MapFrame>
  );
}
