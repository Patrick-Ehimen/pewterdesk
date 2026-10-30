import type { Market } from "@pewterdesk/core";
import { type ReactNode, useState } from "react";
import { dateFormat, t } from "../../i18n";
import { formatCompact, formatNumber } from "../../lib/format";
import {
  cvdSeries,
  FLOW_BUCKET_MS,
  FLOW_BUCKETS,
  type FlowBucket,
  type FlowTrade,
  FUNDING_BUCKET_MS,
  LARGE_SHARES,
  type LargeShare,
  largeTrades,
} from "../../lib/mapStats";
import { TokenIcon } from "../trading/TokenIcon";
import { HoverCard, heat, labelsOf, MapFrame, MapState, Seg, signedPct, useSize } from "./kit";

// The order-flow views (one market's trades: who's been the aggressor, and
// where the size went), funding over the week, and the liquidation
// leaderboard. Order flow is built from the venue's trade stream while the
// view is open, with the recent trades it opens with: there's no history
// of every trade to read further back.

const clock = () =>
  dateFormat({ hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });

/** Since when the trades go back, for the note under a flow view. */
function sinceText(trades: readonly FlowTrade[]): string {
  const first = trades.reduce((a, tr) => Math.min(a, tr.time), Number.POSITIVE_INFINITY);
  return Number.isFinite(first) ? clock().format(first) : "-";
}

/**
 * The market's price, and its cumulative volume delta under it: buying by
 * aggressors less selling, bucket by bucket, since the view began
 * collecting trades.
 */
export function CvdMap({
  market,
  trades,
  bucket,
  onBucket,
  controls,
  loader,
  error,
}: {
  market?: Market;
  trades: readonly FlowTrade[];
  bucket: FlowBucket;
  onBucket: (b: FlowBucket) => void;
  /** The market picker. */
  controls?: ReactNode;
  loader?: ReactNode;
  error?: string;
}) {
  const [ref, size] = useSize<HTMLDivElement>();
  const [hover, setHover] = useState<number>();
  const points = cvdSeries(trades, FLOW_BUCKET_MS[bucket]);
  const pad = 36;
  const w = Math.max(size.width, 1);
  const h = Math.max(size.height, 1);
  const split = h * 0.55;
  const prices = points.map((p) => p.price);
  const pLo = Math.min(...prices);
  const pHi = Math.max(...prices);
  const deltas = points.map((p) => p.cvd);
  const dAbs = Math.max(...deltas.map(Math.abs), 1e-12);
  const x = (i: number) => pad + (i / Math.max(points.length - 1, 1)) * (w - 2 * pad);
  const yPrice = (v: number) =>
    split - 12 - (pHi > pLo ? (v - pLo) / (pHi - pLo) : 0.5) * (split - 12 - pad / 2);
  const yDelta = (v: number) => split + 12 + ((dAbs - v) / (2 * dAbs)) * (h - split - 12 - pad / 2);
  const path = (ys: number[]) =>
    ys.map((v, i) => `${i === 0 ? "M" : "L"}${x(i).toFixed(1)},${v.toFixed(1)}`).join(" ");
  const last = points[points.length - 1];
  const bought = trades.filter((tr) => tr.side === "buy").reduce((a, tr) => a + tr.size, 0);
  const sold = trades.filter((tr) => tr.side === "sell").reduce((a, tr) => a + tr.size, 0);
  const at = hover === undefined ? undefined : points[hover];
  const base = market?.base ?? "";

  return (
    <MapFrame
      title={t("mapx.cvd.title")}
      controls={
        <>
          {controls}
          <Seg
            options={FLOW_BUCKETS}
            value={bucket}
            onChange={onBucket}
            label={t("mapx.cvd.bucket")}
            text={(b) => b}
          />
        </>
      }
      legend={
        last && (
          <>
            <span className={`pd-num ${last.cvd > 0 ? "pd-up" : last.cvd < 0 ? "pd-down" : ""}`}>
              {t("mapx.cvd.delta", {
                value: `${last.cvd > 0 ? "+" : ""}${formatCompact(last.cvd)} ${base}`,
              })}
            </span>
            <span className="pd-num">{t("mapx.cvd.trades", { count: trades.length })}</span>
          </>
        )
      }
      note={t("mapx.cvd.note", { since: sinceText(trades) })}
      state={
        error ? (
          <MapState error={error} />
        ) : points.length < 2 ? (
          <MapState
            loader={loader}
            message={trades.length > 0 ? t("mapx.flow.collecting") : undefined}
          />
        ) : undefined
      }
      side={
        trades.length > 0 && (
          <div className="pd-mx-stats">
            <div className="pd-mx-stat">
              <span>{t("mapx.cvd.bought")}</span>
              <strong className="pd-num pd-up">{`${formatCompact(bought)} ${base}`}</strong>
            </div>
            <div className="pd-mx-stat">
              <span>{t("mapx.cvd.sold")}</span>
              <strong className="pd-num pd-down">{`${formatCompact(sold)} ${base}`}</strong>
            </div>
            <div className="pd-mx-stat">
              <span>{t("mapx.cvd.buyShare")}</span>
              <strong className="pd-num">
                {bought + sold > 0 ? `${formatNumber((bought / (bought + sold)) * 100, 1)}%` : "-"}
              </strong>
            </div>
          </div>
        )
      }
    >
      <div ref={ref} className="pd-mx-fill" onPointerLeave={() => setHover(undefined)}>
        <svg
          className="pd-mx-plot"
          width={w}
          height={h}
          role="img"
          aria-label={t("mapx.cvd.title")}
          onPointerMove={(e) => {
            if (points.length < 2) return;
            const box = e.currentTarget.getBoundingClientRect();
            const share = (e.clientX - box.left - pad) / (w - 2 * pad);
            setHover(
              Math.max(0, Math.min(points.length - 1, Math.round(share * (points.length - 1)))),
            );
          }}
        >
          <text className="pd-mx-axis-label" x={pad} y={pad / 2}>
            {t("mapx.cvd.priceLabel")}
          </text>
          <text className="pd-mx-axis-label" x={pad} y={split + 6}>
            {t("mapx.cvd.deltaLabel")}
          </text>
          <line className="pd-mx-axis" x1={pad} x2={w - pad} y1={yDelta(0)} y2={yDelta(0)} />
          <path
            className="pd-mx-line"
            data-heat="flat"
            d={path(points.map((p) => yPrice(p.price)))}
          />
          <path
            className="pd-mx-line"
            data-heat={last && last.cvd >= 0 ? "up" : "down"}
            d={path(points.map((p) => yDelta(p.cvd)))}
          />
          {at && hover !== undefined && (
            <line
              className="pd-mx-cursor"
              x1={x(hover)}
              x2={x(hover)}
              y1={pad / 2}
              y2={h - pad / 2}
            />
          )}
        </svg>
        {at && hover !== undefined && (
          <HoverCard at={{ x: x(hover), y: pad }} box={size}>
            <div className="pd-map-card-head">
              <strong>{clock().format(at.time)}</strong>
            </div>
            <dl>
              <dt>{t("col.price")}</dt>
              <dd className="pd-num">{formatNumber(at.price)}</dd>
              <dt>{t("mapx.cvd.bought")}</dt>
              <dd className="pd-num pd-up">{formatCompact(at.buy)}</dd>
              <dt>{t("mapx.cvd.sold")}</dt>
              <dd className="pd-num pd-down">{formatCompact(at.sell)}</dd>
              <dt>{t("mapx.cvd.deltaLabel")}</dt>
              <dd className="pd-num">{formatCompact(at.cvd)}</dd>
            </dl>
          </HoverCard>
        )}
      </div>
    </MapFrame>
  );
}

/**
 * The market's biggest trades as bubbles on price and time, sized by value
 * and coloured by who took liquidity, with the largest listed beside them.
 */
export function LargeTradesMap({
  market,
  trades,
  share,
  onShare,
  controls,
  loader,
  error,
}: {
  market?: Market;
  trades: readonly FlowTrade[];
  share: LargeShare;
  onShare: (s: LargeShare) => void;
  controls?: ReactNode;
  loader?: ReactNode;
  error?: string;
}) {
  const [ref, size] = useSize<HTMLDivElement>();
  const [hover, setHover] = useState<string>();
  const big = largeTrades(trades, Number(share) / 100);
  const pad = 36;
  const w = Math.max(size.width, 1);
  const h = Math.max(size.height, 1);
  const times = trades.map((tr) => tr.time);
  const tLo = Math.min(...times);
  const tHi = Math.max(...times);
  const prices = trades.map((tr) => tr.price);
  const pLo = Math.min(...prices);
  const pHi = Math.max(...prices);
  const x = (time: number) => pad + (tHi > tLo ? (time - tLo) / (tHi - tLo) : 0.5) * (w - 2 * pad);
  const y = (price: number) =>
    h - pad - (pHi > pLo ? (price - pLo) / (pHi - pLo) : 0.5) * (h - 2 * pad);
  const value = (tr: FlowTrade) => tr.price * tr.size;
  const biggest = Math.max(...big.trades.map(value), 1);
  const tip = big.trades.find((tr) => tr.id === hover);
  const boughtBig = big.trades
    .filter((tr) => tr.side === "buy")
    .reduce((a, tr) => a + value(tr), 0);
  const soldBig = big.trades.filter((tr) => tr.side === "sell").reduce((a, tr) => a + value(tr), 0);
  const ranked = [...big.trades].sort((a, b) => value(b) - value(a));
  const time = clock();

  return (
    <MapFrame
      title={t("mapx.large.title")}
      controls={
        <>
          {controls}
          <Seg
            options={LARGE_SHARES}
            value={share}
            onChange={onShare}
            label={t("mapx.large.share")}
            text={(s) => t("mapx.large.top", { share: s })}
          />
        </>
      }
      legend={
        big.trades.length > 0 && (
          <span className="pd-num">
            {t("mapx.large.threshold", { value: `$${formatCompact(big.threshold)}` })}
          </span>
        )
      }
      note={t("mapx.large.note", { since: sinceText(trades) })}
      state={
        error ? (
          <MapState error={error} />
        ) : trades.length < 10 ? (
          <MapState
            loader={loader}
            message={trades.length > 0 ? t("mapx.flow.collecting") : undefined}
          />
        ) : undefined
      }
      side={
        big.trades.length > 0 && (
          <>
            <div className="pd-mx-stats">
              <div className="pd-mx-stat">
                <span>{t("mapx.large.bought")}</span>
                <strong className="pd-num pd-up">${formatCompact(boughtBig)}</strong>
              </div>
              <div className="pd-mx-stat">
                <span>{t("mapx.large.sold")}</span>
                <strong className="pd-num pd-down">${formatCompact(soldBig)}</strong>
              </div>
            </div>
            <h3>{t("mapx.large.biggest")}</h3>
            <ol className="pd-mx-list pd-mx-trades">
              {ranked.slice(0, 10).map((tr) => (
                <li key={tr.id}>
                  <span className={tr.side === "buy" ? "pd-up" : "pd-down"}>
                    {t(tr.side === "buy" ? "side.buy" : "side.sell")}
                  </span>
                  <span className="pd-num">${formatCompact(value(tr))}</span>
                  <span className="pd-num pd-muted">{formatNumber(tr.price)}</span>
                  <span className="pd-num pd-muted">{time.format(tr.time)}</span>
                </li>
              ))}
            </ol>
          </>
        )
      }
    >
      <div ref={ref} className="pd-mx-fill" onPointerLeave={() => setHover(undefined)}>
        <svg
          className="pd-mx-plot"
          width={w}
          height={h}
          role="img"
          aria-label={t("mapx.large.title")}
        >
          <text className="pd-mx-axis-label" x={pad / 2} y={pad / 2}>
            {market ? `${market.symbol} · ${formatNumber(pHi)}` : formatNumber(pHi)}
          </text>
          <text className="pd-mx-axis-label" x={pad / 2} y={h - pad / 2 + 4}>
            {formatNumber(pLo)}
          </text>
          {big.trades.map((tr) => {
            const r = 3 + Math.sqrt(value(tr) / biggest) * 16;
            return (
              <g
                key={tr.id}
                className="pd-mx-dot"
                data-heat={tr.side === "buy" ? "up" : "down"}
                data-hover={hover === tr.id || undefined}
                onPointerEnter={() => setHover(tr.id)}
              >
                <circle cx={x(tr.time)} cy={y(tr.price)} r={r} />
              </g>
            );
          })}
        </svg>
        {tip && (
          <HoverCard at={{ x: x(tip.time), y: y(tip.price) }} box={size}>
            <div className="pd-map-card-head">
              {market && <TokenIcon market={market} size={18} />}
              <strong className={tip.side === "buy" ? "pd-up" : "pd-down"}>
                {t(tip.side === "buy" ? "side.buy" : "side.sell")}
              </strong>
            </div>
            <dl>
              <dt>{t("col.price")}</dt>
              <dd className="pd-num">{formatNumber(tip.price)}</dd>
              <dt>{t("col.size")}</dt>
              <dd className="pd-num">{`${formatNumber(tip.size)} ${market?.base ?? ""}`}</dd>
              <dt>{t("mapx.large.value")}</dt>
              <dd className="pd-num">${formatCompact(value(tip))}</dd>
              <dt>{t("col.time")}</dt>
              <dd className="pd-num">{time.format(tip.time)}</dd>
            </dl>
          </HoverCard>
        )}
      </div>
    </MapFrame>
  );
}

export interface FundingHistoryRow {
  market: Market;
  /** 8-hour-equivalent funding in each bucket, oldest first. */
  buckets: readonly (number | undefined)[];
}

export type FundingHistoryPick = "volume" | "extreme";
export const FUNDING_HISTORY_PICKS: readonly FundingHistoryPick[] = ["volume", "extreme"];
export type FundingHistorySize = "20" | "40";
export const FUNDING_HISTORY_SIZES: readonly FundingHistorySize[] = ["20", "40"];

/** A funding rate as the heatmap writes it: per 8 hours, in percent. */
const ratePct = (v: number | undefined) =>
  v === undefined ? "-" : `${v > 0 ? "+" : ""}${formatNumber(v * 100, 4)}%`;

/**
 * Funding over the last 7 days, markets down and 8-hour buckets across:
 * orange where longs paid, blue where shorts did - so a market that has
 * been crowded for days stands out from one that only is now.
 */
export function FundingHistoryMap({
  rows,
  start,
  pick,
  onPick,
  size: count,
  onSize,
  progress,
  loader,
  onTrade,
}: {
  rows: readonly FundingHistoryRow[];
  /** When the first bucket begins. */
  start: number;
  pick: FundingHistoryPick;
  onPick: (p: FundingHistoryPick) => void;
  size: FundingHistorySize;
  onSize: (s: FundingHistorySize) => void;
  progress: { done: number; total: number };
  loader?: ReactNode;
  onTrade: (market: Market) => void;
}) {
  const [hover, setHover] = useState<[number, number]>();
  const nameOf = labelsOf(rows.map((r) => r.market));
  const all = rows.flatMap((r) => r.buckets.filter((b): b is number => b !== undefined));
  const scale = Math.max(
    ...all
      .map(Math.abs)
      .sort((a, b) => a - b)
      .slice(0, Math.ceil(all.length * 0.95)),
    0.0001,
  );
  const day = dateFormat({ weekday: "short" });
  const span = dateFormat({ weekday: "short", hour: "2-digit", minute: "2-digit", hour12: false });
  const columns = rows[0]?.buckets.length ?? 0;
  const cell = hover && rows[hover[0]];
  const cellValue = hover && cell ? cell.buckets[hover[1]] : undefined;

  return (
    <MapFrame
      title={t("mapx.fundingHist.title")}
      controls={
        <>
          <Seg
            options={FUNDING_HISTORY_PICKS}
            value={pick}
            onChange={onPick}
            label={t("mapx.fundingHist.pick")}
            text={(p) => t(`mapx.fundingHist.pick.${p}`)}
          />
          <Seg
            options={FUNDING_HISTORY_SIZES}
            value={count}
            onChange={onSize}
            label={t("mapx.top")}
            text={(n) => t("mapx.topN", { count: n })}
          />
        </>
      }
      legend={
        cell && hover ? (
          <span className="pd-num">
            {`${nameOf(cell.market)} · ${span.format(start + hover[1] * FUNDING_BUCKET_MS)} · ${ratePct(cellValue)}`}
          </span>
        ) : (
          progress.done < progress.total && (
            <span className="pd-muted pd-num">
              {t("mapx.progress", { done: progress.done, total: progress.total })}
            </span>
          )
        )
      }
      note={t("mapx.fundingHist.note")}
      state={rows.length === 0 ? <MapState loader={loader} progress={progress} /> : undefined}
    >
      <div className="pd-mx-scroll">
        <div
          className="pd-mx-fhist"
          style={{ gridTemplateColumns: `110px repeat(${columns}, minmax(14px, 1fr)) 84px` }}
          onPointerLeave={() => setHover(undefined)}
        >
          <span />
          {Array.from({ length: columns }, (_, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: columns are positions in time
            <span key={i} className="pd-mx-fhist-col">
              {i % 3 === 0 ? day.format(start + i * FUNDING_BUCKET_MS) : ""}
            </span>
          ))}
          <span className="pd-mx-fhist-col">{t("mapx.fundingHist.avg")}</span>
          {rows.map((r, ri) => {
            const known = r.buckets.filter((b): b is number => b !== undefined);
            const avg = known.length ? known.reduce((a, b) => a + b, 0) / known.length : undefined;
            return (
              <div key={r.market.id} className="pd-mx-fhist-row">
                <button type="button" className="pd-mx-name" onClick={() => onTrade(r.market)}>
                  <TokenIcon market={r.market} size={14} />
                  {nameOf(r.market)}
                </button>
                {r.buckets.map((b, i) => {
                  const tone = heat(b, scale, ["warn", "info"]);
                  return (
                    <span
                      // biome-ignore lint/suspicious/noArrayIndexKey: cells are positions in time
                      key={i}
                      className="pd-mx-cell"
                      data-heat={tone["data-heat"]}
                      style={tone.style}
                      onPointerEnter={() => setHover([ri, i])}
                    />
                  );
                })}
                <span
                  className={`pd-num ${avg === undefined ? "" : avg > 0 ? "pd-warn" : "pd-info"}`}
                >
                  {ratePct(avg)}
                </span>
              </div>
            );
          })}
        </div>
      </div>
    </MapFrame>
  );
}

export interface LiqBoardRow {
  market: Market | undefined;
  /** The market's id or coin, as the feed named it. */
  name: string;
  /** Value of longs and of shorts liquidated, in quote currency. */
  long: number;
  short: number;
}

/**
 * The markets with the most liquidated over the window, longs to the left
 * and shorts to the right: which side got squeezed, coin by coin.
 */
export function LiqLeaderboard({
  rows,
  controls,
  loader,
  error,
  onTrade,
}: {
  rows: readonly LiqBoardRow[];
  /** The window picker. */
  controls?: ReactNode;
  loader?: ReactNode;
  error?: string;
  onTrade: (market: Market) => void;
}) {
  const shown = rows.slice(0, 40);
  const max = Math.max(...shown.map((r) => Math.max(r.long, r.short)), 1);
  const longs = rows.reduce((a, r) => a + r.long, 0);
  const shorts = rows.reduce((a, r) => a + r.short, 0);
  const total = longs + shorts;

  return (
    <MapFrame
      title={t("mapx.liqBoard.title")}
      controls={controls}
      legend={
        total > 0 && (
          <>
            <span className="pd-down pd-num">
              {t("mapx.liqBoard.longs", { value: `$${formatCompact(longs)}` })}
            </span>
            <span className="pd-up pd-num">
              {t("mapx.liqBoard.shorts", { value: `$${formatCompact(shorts)}` })}
            </span>
            <span className="pd-num">
              {t("mapx.liqBoard.longShare", { value: signedPct(longs / total - 0.5, 0) })}
            </span>
          </>
        )
      }
      note={t("mapx.liqBoard.note")}
      state={
        error ? (
          <MapState error={error} />
        ) : shown.length === 0 ? (
          <MapState loader={loader} />
        ) : undefined
      }
    >
      <div className="pd-mx-scroll">
        <div className="pd-mx-liqboard-head">
          <span>{t("mapx.liqBoard.longsHead")}</span>
          <span />
          <span className="pd-mx-liqboard-shorts">{t("mapx.liqBoard.shortsHead")}</span>
        </div>
        <ol className="pd-mx-liqboard">
          {shown.map((r) => (
            <li key={r.name}>
              <button
                type="button"
                disabled={!r.market}
                onClick={() => r.market && onTrade(r.market)}
              >
                <span className="pd-num pd-down">
                  {r.long > 0 ? `$${formatCompact(r.long)}` : ""}
                </span>
                <span className="pd-mx-liqboard-bar" data-side="long">
                  <span
                    className="pd-mx-liqboard-fill"
                    style={{ width: `${(r.long / max) * 100}%` }}
                  />
                </span>
                <span className="pd-mx-name">
                  {r.market && <TokenIcon market={r.market} size={14} />}
                  {r.market?.base ?? r.name}
                </span>
                <span className="pd-mx-liqboard-bar" data-side="short">
                  <span
                    className="pd-mx-liqboard-fill"
                    style={{ width: `${(r.short / max) * 100}%` }}
                  />
                </span>
                <span className="pd-num pd-up">
                  {r.short > 0 ? `$${formatCompact(r.short)}` : ""}
                </span>
              </button>
            </li>
          ))}
        </ol>
      </div>
    </MapFrame>
  );
}
