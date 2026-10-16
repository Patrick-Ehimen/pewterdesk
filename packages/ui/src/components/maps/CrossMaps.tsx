import type { Market, VenueId } from "@pewterdesk/core";
import { type ReactNode, useState } from "react";
import { t } from "../../i18n";
import { formatNumber } from "../../lib/format";
import { type CoinRow, priceSpreads } from "../../lib/mapStats";
import { TokenIcon } from "../trading/TokenIcon";
import { HistoryProgress, heat, labelsOf, MapFrame, MapState, Seg } from "./kit";
import type { MapVenue } from "./PositioningMaps";

export type CorrWindow = "24h" | "7d";
export const CORR_WINDOWS: readonly CorrWindow[] = ["24h", "7d"];
export const CORR_HOURS: Record<CorrWindow, number> = { "24h": 24, "7d": 168 };
export type CorrSize = "10" | "20" | "30";
export const CORR_SIZES: readonly CorrSize[] = ["10", "20", "30"];

const corrText = (v: number | undefined) => (v === undefined ? "-" : formatNumber(v, 2));

/**
 * How the busiest markets' hourly returns move together, every pair in a
 * grid (blue together, orange apart); and the markets least tied to the
 * busiest one, usually BTC.
 */
export function CorrelationMap({
  markets,
  matrix,
  window,
  onWindow,
  size,
  onSize,
  progress,
  loader,
  extra,
  onTrade,
}: {
  /** In the matrix's order, busiest first. */
  markets: readonly Market[];
  matrix: readonly (readonly (number | undefined)[])[];
  window: CorrWindow;
  onWindow: (w: CorrWindow) => void;
  size: CorrSize;
  onSize: (s: CorrSize) => void;
  progress: { done: number; total: number };
  loader?: ReactNode;
  /** More controls after the view's own (the Crypto / All filter). */
  extra?: ReactNode;
  onTrade: (market: Market) => void;
}) {
  const [hover, setHover] = useState<[number, number]>();
  const nameOf = labelsOf(markets);
  const anchor = markets[0];
  const loose = markets
    .map((m, i) => ({ m, v: matrix[0]?.[i] }))
    .slice(1)
    .filter((r): r is { m: Market; v: number } => r.v !== undefined)
    .sort((a, b) => a.v - b.v);
  const pair = hover && {
    a: markets[hover[0]],
    b: markets[hover[1]],
    v: matrix[hover[0]]?.[hover[1]],
  };
  const avg = (() => {
    const values: number[] = [];
    matrix.forEach((row, i) => {
      row.forEach((v, j) => {
        if (j > i && v !== undefined) values.push(v);
      });
    });
    return values.length ? values.reduce((a, b) => a + b, 0) / values.length : undefined;
  })();

  return (
    <MapFrame
      title={t("mapx.corr.title")}
      controls={
        <>
          <Seg options={CORR_WINDOWS} value={window} onChange={onWindow} label={t("mapx.window")} />
          <Seg
            options={CORR_SIZES}
            value={size}
            onChange={onSize}
            label={t("mapx.top")}
            text={(n) => t("mapx.topN", { count: n })}
          />
          {extra}
        </>
      }
      legend={
        <>
          <HistoryProgress {...progress} />
          {pair?.a && pair.b ? (
            <span className="pd-num">{`${nameOf(pair.a)} × ${nameOf(pair.b)}  ${corrText(pair.v)}`}</span>
          ) : (
            avg !== undefined && (
              <span className="pd-num">{t("mapx.corr.average", { value: corrText(avg) })}</span>
            )
          )}
        </>
      }
      note={t("mapx.corr.note")}
      state={markets.length < 2 ? <MapState loader={loader} progress={progress} /> : undefined}
      side={
        anchor &&
        loose.length > 0 && (
          <>
            <h3>{t("mapx.corr.loosest", { base: anchor.base })}</h3>
            <ol className="pd-mx-list">
              {loose.slice(0, 8).map((r) => (
                <li key={r.m.id}>
                  <button type="button" onClick={() => onTrade(r.m)}>
                    <TokenIcon market={r.m} size={14} />
                    <span>{nameOf(r.m)}</span>
                    <span className="pd-num pd-muted">{corrText(r.v)}</span>
                  </button>
                </li>
              ))}
            </ol>
            <h3>{t("mapx.corr.tightest", { base: anchor.base })}</h3>
            <ol className="pd-mx-list">
              {loose
                .slice(-5)
                .reverse()
                .map((r) => (
                  <li key={r.m.id}>
                    <button type="button" onClick={() => onTrade(r.m)}>
                      <TokenIcon market={r.m} size={14} />
                      <span>{nameOf(r.m)}</span>
                      <span className="pd-num pd-muted">{corrText(r.v)}</span>
                    </button>
                  </li>
                ))}
            </ol>
          </>
        )
      }
    >
      <div className="pd-mx-scroll">
        <div
          className="pd-mx-corr"
          style={{ gridTemplateColumns: `56px repeat(${markets.length}, minmax(22px, 1fr))` }}
          onPointerLeave={() => setHover(undefined)}
        >
          <span />
          {markets.map((m, j) => (
            <span key={m.id} className="pd-mx-corr-col" data-on={hover?.[1] === j || undefined}>
              {nameOf(m)}
            </span>
          ))}
          {markets.map((a, i) => (
            <div key={a.id} className="pd-mx-corr-row">
              <span className="pd-mx-corr-head" data-on={hover?.[0] === i || undefined}>
                {nameOf(a)}
              </span>
              {markets.map((b, j) => {
                const v = matrix[i]?.[j];
                // Blue moving together, orange apart; from 0.2 up is colour.
                const h = heat(v === undefined || i === j ? undefined : v, 1, ["info", "warn"]);
                return (
                  <span
                    key={b.id}
                    className="pd-mx-corr-cell pd-num"
                    data-heat={i === j ? "flat" : h["data-heat"]}
                    data-self={i === j || undefined}
                    style={h.style}
                    onPointerEnter={() => setHover([i, j])}
                  >
                    {markets.length <= 20 && i !== j
                      ? corrText(v).replace(/^0/, "").replace(/^-0/, "-")
                      : ""}
                  </span>
                );
              })}
            </div>
          ))}
        </div>
      </div>
    </MapFrame>
  );
}

export type SpreadSort = "volume" | "width";
export const SPREAD_SORTS: readonly SpreadSort[] = ["volume", "width"];
/** Coins listed. */
const SPREAD_ROWS = 40;
/** Wider than this, two listings are taken for different contracts. */
const MAX_SPREAD_BPS = 500;
/** The strip's half-width in basis points; wider gaps sit at its edge. */
const SPREAD_SPAN = 30;

/**
 * The same coin's mark price on every venue that lists it, against their
 * median: one strip per coin with a mark per venue, in basis points.
 */
export function SpreadMap({
  rows,
  venues,
  sort,
  onSort,
  iconFor,
  onTrade,
  loading,
  loader,
}: {
  rows: readonly CoinRow[];
  venues: readonly MapVenue[];
  sort: SpreadSort;
  onSort: (s: SpreadSort) => void;
  iconFor: (base: string) => Market | undefined;
  onTrade: (base: string) => void;
  loading: boolean;
  loader?: ReactNode;
}) {
  const listed = rows
    .filter((r) => Object.keys(r.venues).length >= 2)
    .map((r) => ({ row: r, spread: priceSpreads(r) }))
    // Five percent apart is a different contract (a 1000x unit, a renamed
    // token), not a spread.
    .filter(({ spread }) => spread.width < MAX_SPREAD_BPS);
  const shown = (
    sort === "width" ? [...listed].sort((a, b) => b.spread.width - a.spread.width) : listed
  ).slice(0, SPREAD_ROWS);
  const pos = (bps: number) =>
    50 + (Math.max(-SPREAD_SPAN, Math.min(SPREAD_SPAN, bps)) / SPREAD_SPAN) * 50;

  return (
    <MapFrame
      title={t("mapx.spread.title")}
      controls={
        <Seg
          options={SPREAD_SORTS}
          value={sort}
          onChange={onSort}
          label={t("mapx.sort")}
          text={(s) => t(`mapx.spread.sort.${s}`)}
        />
      }
      legend={venues.map((v) => (
        <span key={v.id} className="pd-mx-venue-key">
          <i className="pd-mx-venue-dot" data-venue={v.id} aria-hidden />
          {v.label}
        </span>
      ))}
      note={t("mapx.spread.note", { span: SPREAD_SPAN })}
      state={
        shown.length === 0 ? (
          <MapState
            loader={loading ? loader : undefined}
            message={loading ? undefined : t("mapx.spread.none")}
          />
        ) : undefined
      }
    >
      <div className="pd-mx-scroll">
        <div className="pd-mx-spread-axis" aria-hidden>
          <span />
          <span className="pd-mx-spread-scale">
            <span>{`-${SPREAD_SPAN}`}</span>
            <span>0</span>
            <span>{`+${SPREAD_SPAN} bps`}</span>
          </span>
          <span />
        </div>
        <ol className="pd-mx-spread">
          {shown.map(({ row, spread }) => (
            <li key={row.base}>
              <button type="button" onClick={() => onTrade(row.base)}>
                <span className="pd-mx-name">
                  <TokenIcon market={iconFor(row.base)} size={16} />
                  {row.base}
                  <span className="pd-num pd-muted">
                    {formatNumber(spread.median, spread.median < 1 ? 5 : 2)}
                  </span>
                </span>
                <span className="pd-mx-strip">
                  <span className="pd-mx-strip-zero" />
                  {(Object.entries(spread.bps) as [VenueId, number][]).map(([venue, bps]) => (
                    <i
                      key={venue}
                      className="pd-mx-venue-dot"
                      data-venue={venue}
                      style={{ left: `${pos(bps)}%` }}
                      title={`${venues.find((v) => v.id === venue)?.label ?? venue} ${bps >= 0 ? "+" : ""}${formatNumber(bps, 1)} bps`}
                    />
                  ))}
                </span>
                <span className="pd-num">{`${formatNumber(spread.width, 1)} bps`}</span>
              </button>
            </li>
          ))}
        </ol>
      </div>
    </MapFrame>
  );
}
