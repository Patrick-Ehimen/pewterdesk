import type { Market } from "@pewterdesk/core";
import { type ReactNode, useState } from "react";
import { dateFormat, t } from "../../i18n";
import { formatCompact, formatNumber } from "../../lib/format";
import {
  type BreadthNow,
  type BreadthPoint,
  median,
  PERF_WINDOWS,
  type PerfWindow,
  RANGE_WINDOWS,
  type RangePlace,
  type RangeWindow,
  ROTATION_LENSES,
  ROTATION_QUADRANTS,
  type RotationLens,
  type RotationQuadrant,
  rotationQuadrant,
  SPIKE_WINDOWS,
  type SpikeWindow,
  type VolumeSpike,
} from "../../lib/mapStats";
import { TokenIcon } from "../trading/TokenIcon";
import {
  HistoryProgress,
  HoverCard,
  labelsOf,
  MapFrame,
  MapState,
  Seg,
  signedPct,
  useSize,
} from "./kit";

// The Maps page's strength and breadth views: each market against BTC
// (relative strength, rotation, beta), where it sits in its range, unusual
// volume, and how broad the market's move is. All from the hourly history
// every market already has on this page.

export const toneOf = (v: number | undefined) =>
  v === undefined ? "" : v > 0 ? "pd-up" : v < 0 ? "pd-down" : "";

/** Most markets a ranking lists. */
export const LIST_MAX = 100;

/** Points scaled to the bulk of the values, so one outlier doesn't squash the rest. */
function extent(values: readonly number[], floor: number): number {
  const sorted = values.map(Math.abs).sort((a, b) => a - b);
  return Math.max(sorted[Math.floor(sorted.length * 0.95)] ?? 0, floor) * 1.1;
}

/** One side of a ranking: its markets, each with a bar for its value against the biggest. */
export function RankList({
  title,
  rows,
  max,
  value,
  text,
  extra,
  onTrade,
}: {
  title: string;
  rows: readonly { market: Market; value: number }[];
  max: number;
  value: (v: number) => "up" | "down" | "warn" | "info";
  text: (v: number) => string;
  extra?: (market: Market) => ReactNode;
  onTrade: (market: Market) => void;
}) {
  const nameOf = labelsOf(rows.map((r) => r.market));
  return (
    <section className="pd-mx-rank-col">
      <h3>{title}</h3>
      <ol className="pd-mx-bars pd-mx-bars-compact">
        {rows.map((r, i) => (
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
                  data-heat={value(r.value)}
                  style={{ width: `${max > 0 ? (Math.abs(r.value) / max) * 100 : 0}%` }}
                />
              </span>
              <span className={`pd-num ${toneOf(r.value)}`}>{text(r.value)}</span>
              {extra ? extra(r.market) : <span />}
            </button>
          </li>
        ))}
      </ol>
    </section>
  );
}

export interface StrengthRow {
  market: Market;
  /** The market's return over each window. */
  changes: Partial<Record<PerfWindow, number>>;
}

/**
 * Every market against BTC over a window: its return less BTC's. The ones
 * running ahead on one side, the ones falling behind on the other.
 */
export function RelativeStrengthMap({
  rows,
  benchmark,
  window,
  onWindow,
  progress,
  loader,
  extra,
  onTrade,
}: {
  rows: readonly StrengthRow[];
  /** BTC's own row; none until its history is in. */
  benchmark?: StrengthRow;
  window: PerfWindow;
  onWindow: (w: PerfWindow) => void;
  progress: { done: number; total: number };
  loader?: ReactNode;
  extra?: ReactNode;
  onTrade: (market: Market) => void;
}) {
  const bench = benchmark?.changes[window];
  const ranked = rows
    .filter((r) => r.market.id !== benchmark?.market.id)
    .flatMap((r) => {
      const change = r.changes[window];
      return change === undefined || bench === undefined
        ? []
        : [{ market: r.market, value: change - bench }];
    })
    .sort((a, b) => b.value - a.value);
  const ahead = ranked.filter((r) => r.value > 0);
  const behind = ranked.filter((r) => r.value < 0).reverse();
  const max = Math.max(...ranked.map((r) => Math.abs(r.value)), 0);
  const changeOf = new Map(rows.map((r) => [r.market.id, r.changes[window]]));
  const pct = (v: number) => signedPct(v);

  return (
    <MapFrame
      title={t("mapx.rs.title")}
      controls={
        <>
          <Seg options={PERF_WINDOWS} value={window} onChange={onWindow} label={t("mapx.window")} />
          {extra}
        </>
      }
      legend={
        ranked.length > 0 && (
          <>
            <HistoryProgress {...progress} />
            <span className="pd-num">{t("mapx.rs.benchmark", { change: signedPct(bench) })}</span>
            <span className="pd-up pd-num">{t("mapx.rs.ahead", { count: ahead.length })}</span>
            <span className="pd-down pd-num">{t("mapx.rs.behind", { count: behind.length })}</span>
          </>
        )
      }
      note={t("mapx.rs.note")}
      state={
        ranked.length === 0 ? (
          <MapState
            loader={loader}
            progress={progress}
            message={benchmark ? undefined : rows.length > 0 ? t("mapx.rs.noBenchmark") : undefined}
          />
        ) : undefined
      }
    >
      <div className="pd-mx-scroll pd-mx-rank-cols">
        <RankList
          title={t("mapx.rs.aheadTitle")}
          rows={ahead.slice(0, LIST_MAX)}
          max={max}
          value={() => "up"}
          text={pct}
          extra={(m) => <span className="pd-num pd-muted">{signedPct(changeOf.get(m.id))}</span>}
          onTrade={onTrade}
        />
        <RankList
          title={t("mapx.rs.behindTitle")}
          rows={behind.slice(0, LIST_MAX)}
          max={max}
          value={() => "down"}
          text={pct}
          extra={(m) => <span className="pd-num pd-muted">{signedPct(changeOf.get(m.id))}</span>}
          onTrade={onTrade}
        />
      </div>
    </MapFrame>
  );
}

export interface RotationPoint {
  market: Market;
  /** Return against BTC's over the trend window, and over the momentum window. */
  trend: number;
  momentum: number;
  /** The day's volume in quote currency, which sizes the dot. */
  volume: number;
}

/**
 * Where each market stands against BTC: ahead or behind over the trend
 * window (across), and gaining or losing ground lately (up and down), in
 * the four quadrants a rotation runs through.
 */
export function RotationMap({
  points,
  lens,
  onLens,
  progress,
  loader,
  extra,
  onTrade,
}: {
  points: readonly RotationPoint[];
  lens: RotationLens;
  onLens: (lens: RotationLens) => void;
  progress: { done: number; total: number };
  loader?: ReactNode;
  extra?: ReactNode;
  onTrade: (market: Market) => void;
}) {
  const [ref, size] = useSize<HTMLDivElement>();
  const [hover, setHover] = useState<string>();
  const xMax = extent(
    points.map((p) => p.trend),
    0.01,
  );
  const yMax = extent(
    points.map((p) => p.momentum),
    0.005,
  );
  const biggest = Math.max(...points.map((p) => p.volume), 1);
  const pad = 28;
  const w = Math.max(size.width, 1);
  const h = Math.max(size.height, 1);
  const x = (v: number) =>
    pad + ((Math.max(-xMax, Math.min(xMax, v)) + xMax) / (2 * xMax)) * (w - 2 * pad);
  const y = (v: number) =>
    h - pad - ((Math.max(-yMax, Math.min(yMax, v)) + yMax) / (2 * yMax)) * (h - 2 * pad);
  const tip = points.find((p) => p.market.id === hover);
  const nameOf = labelsOf(points.map((p) => p.market));
  const quadOf = (p: RotationPoint) => rotationQuadrant(p.trend, p.momentum);
  const corner: Record<RotationQuadrant, { x: number; y: number; anchor: "start" | "end" }> = {
    leading: { x: w - pad, y: pad, anchor: "end" },
    weakening: { x: w - pad, y: h - pad, anchor: "end" },
    lagging: { x: pad, y: h - pad, anchor: "start" },
    improving: { x: pad, y: pad, anchor: "start" },
  };

  return (
    <MapFrame
      title={t("mapx.rotation.title")}
      controls={
        <>
          <Seg
            options={ROTATION_LENSES}
            value={lens}
            onChange={onLens}
            label={t("mapx.rotation.lens")}
            text={(l) => t(`mapx.rotation.lens.${l}`)}
          />
          {extra}
        </>
      }
      legend={<HistoryProgress {...progress} />}
      note={t("mapx.rotation.note")}
      state={points.length === 0 ? <MapState loader={loader} progress={progress} /> : undefined}
      side={
        points.length > 0 &&
        ROTATION_QUADRANTS.map((q) => {
          const inQ = points.filter((p) => quadOf(p) === q);
          return (
            <section key={q} className="pd-mx-quad" data-rotation={q}>
              <h3>
                {t(`mapx.rotation.${q}`)}
                <span className="pd-muted pd-num">{inQ.length}</span>
              </h3>
              <ul className="pd-mx-list">
                {[...inQ]
                  .sort((a, b) => b.volume - a.volume)
                  .slice(0, 4)
                  .map((p) => (
                    <li key={p.market.id}>
                      <button type="button" onClick={() => onTrade(p.market)}>
                        <TokenIcon market={p.market} size={14} />
                        <span>{nameOf(p.market)}</span>
                        <span className="pd-num pd-muted">{signedPct(p.trend, 1)}</span>
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
        <svg
          className="pd-mx-plot"
          width={w}
          height={h}
          role="img"
          aria-label={t("mapx.rotation.title")}
        >
          <line className="pd-mx-axis" x1={x(0)} x2={x(0)} y1={pad / 2} y2={h - pad / 2} />
          <line className="pd-mx-axis" x1={pad / 2} x2={w - pad / 2} y1={y(0)} y2={y(0)} />
          {ROTATION_QUADRANTS.map((q) => (
            <text
              key={q}
              className="pd-mx-quad-label"
              x={corner[q].x}
              y={corner[q].y}
              textAnchor={corner[q].anchor}
            >
              {t(`mapx.rotation.${q}`)}
            </text>
          ))}
          <text className="pd-mx-axis-label" x={w - pad / 2} y={y(0) - 6} textAnchor="end">
            {t("mapx.rotation.trendAxis", { hours: t(`mapx.rotation.trend.${lens}`) })}
          </text>
          <text className="pd-mx-axis-label" x={x(0) + 6} y={pad / 2 + 4}>
            {t("mapx.rotation.momentumAxis", { hours: t(`mapx.rotation.momentum.${lens}`) })}
          </text>
          {points.map((p) => {
            const r = 3 + Math.sqrt(p.volume / biggest) * 12;
            return (
              // biome-ignore lint/a11y/noStaticElementInteractions: the lists beside it are the keyboard way in
              <g
                key={p.market.id}
                className="pd-mx-dot"
                data-rotation={quadOf(p)}
                data-hover={hover === p.market.id || undefined}
                onPointerEnter={() => setHover(p.market.id)}
                onClick={() => onTrade(p.market)}
              >
                <circle cx={x(p.trend)} cy={y(p.momentum)} r={r} />
                {r > 8 && (
                  <text x={x(p.trend)} y={y(p.momentum) - r - 3} textAnchor="middle">
                    {nameOf(p.market)}
                  </text>
                )}
              </g>
            );
          })}
        </svg>
        {tip && (
          <HoverCard at={{ x: x(tip.trend), y: y(tip.momentum) }} box={size}>
            <div className="pd-map-card-head">
              <TokenIcon market={tip.market} size={18} />
              <strong>{tip.market.symbol}</strong>
            </div>
            <dl>
              <dt>{t("mapx.rotation.trendShort", { hours: t(`mapx.rotation.trend.${lens}`) })}</dt>
              <dd className={`pd-num ${toneOf(tip.trend)}`}>{signedPct(tip.trend)}</dd>
              <dt>
                {t("mapx.rotation.momentumShort", { hours: t(`mapx.rotation.momentum.${lens}`) })}
              </dt>
              <dd className={`pd-num ${toneOf(tip.momentum)}`}>{signedPct(tip.momentum)}</dd>
              <dt>{t("mapx.volume24h")}</dt>
              <dd className="pd-num">${formatCompact(tip.volume)}</dd>
            </dl>
            <p className="pd-mx-tip-note">{t(`mapx.rotation.${quadOf(tip)}Hint`)}</p>
          </HoverCard>
        )}
      </div>
    </MapFrame>
  );
}

export interface BreakoutRow {
  market: Market;
  price: number;
  place: RangePlace;
}

/** Within this share of the range's edge, a market is pressing it. */
const PRESSING = 0.1;

/** A market's place in its range, as a bar with a marker. */
export function RangeBar({ position }: { position: number }) {
  return (
    <span className="pd-mx-range" aria-hidden>
      <span className="pd-mx-range-mark" style={{ left: `${position * 100}%` }} />
    </span>
  );
}

/**
 * Markets pressing the top of their range, and the bottom: where a breakout
 * or a breakdown would start.
 */
export function BreakoutMap({
  rows,
  window,
  onWindow,
  progress,
  loader,
  extra,
  onTrade,
}: {
  rows: readonly BreakoutRow[];
  window: RangeWindow;
  onWindow: (w: RangeWindow) => void;
  progress: { done: number; total: number };
  loader?: ReactNode;
  extra?: ReactNode;
  onTrade: (market: Market) => void;
}) {
  const highs = rows
    .filter((r) => r.place.position >= 1 - PRESSING)
    .sort((a, b) => b.place.toHigh - a.place.toHigh);
  const lows = rows
    .filter((r) => r.place.position <= PRESSING)
    .sort((a, b) => a.place.toLow - b.place.toLow);
  const nameOf = labelsOf(rows.map((r) => r.market));
  const list = (items: readonly BreakoutRow[], which: "high" | "low") =>
    items.length === 0 ? (
      <p className="pd-muted pd-mx-empty-line">{t("mapx.breakout.none")}</p>
    ) : (
      <ol className="pd-mx-bars pd-mx-range-rows">
        {items.slice(0, LIST_MAX).map((r) => (
          <li key={r.market.id}>
            <button type="button" onClick={() => onTrade(r.market)}>
              <span className="pd-mx-name">
                <TokenIcon market={r.market} size={16} />
                {nameOf(r.market)}
              </span>
              <RangeBar position={r.place.position} />
              <span className="pd-num">
                {signedPct(which === "high" ? r.place.toHigh : r.place.toLow)}
              </span>
              <span className="pd-num pd-muted">
                {formatNumber(which === "high" ? r.place.high : r.place.low)}
              </span>
            </button>
          </li>
        ))}
      </ol>
    );

  return (
    <MapFrame
      title={t("mapx.breakout.title")}
      controls={
        <>
          <Seg
            options={RANGE_WINDOWS}
            value={window}
            onChange={onWindow}
            label={t("mapx.window")}
          />
          {extra}
        </>
      }
      legend={
        rows.length > 0 && (
          <>
            <HistoryProgress {...progress} />
            <span className="pd-up pd-num">
              {t("mapx.breakout.nearHigh", { count: highs.length })}
            </span>
            <span className="pd-down pd-num">
              {t("mapx.breakout.nearLow", { count: lows.length })}
            </span>
          </>
        )
      }
      note={t("mapx.breakout.note")}
      state={rows.length === 0 ? <MapState loader={loader} progress={progress} /> : undefined}
    >
      <div className="pd-mx-scroll pd-mx-rank-cols">
        <section className="pd-mx-rank-col">
          <h3>{t("mapx.breakout.highsTitle", { window: window.toUpperCase() })}</h3>
          {list(highs, "high")}
        </section>
        <section className="pd-mx-rank-col">
          <h3>{t("mapx.breakout.lowsTitle", { window: window.toUpperCase() })}</h3>
          {list(lows, "low")}
        </section>
      </div>
    </MapFrame>
  );
}

export interface SpikeRow {
  market: Market;
  spike: VolumeSpike;
}

/** Markets trading far more than they usually do, the biggest surge first. */
export function VolumeSpikeMap({
  rows,
  window,
  onWindow,
  progress,
  loader,
  extra,
  onTrade,
}: {
  rows: readonly SpikeRow[];
  window: SpikeWindow;
  onWindow: (w: SpikeWindow) => void;
  progress: { done: number; total: number };
  loader?: ReactNode;
  extra?: ReactNode;
  onTrade: (market: Market) => void;
}) {
  const ranked = [...rows].sort((a, b) => b.spike.ratio - a.spike.ratio);
  const surging = ranked.filter((r) => r.spike.ratio >= 2).length;
  const max = ranked[0]?.spike.ratio ?? 0;
  const nameOf = labelsOf(ranked.map((r) => r.market));
  const typical = median(ranked.map((r) => r.spike.ratio));

  return (
    <MapFrame
      title={t("mapx.spikes.title")}
      controls={
        <>
          <Seg
            options={SPIKE_WINDOWS}
            value={window}
            onChange={onWindow}
            label={t("mapx.window")}
            text={(w) => t(`mapx.spikes.window.${w}`)}
          />
          {extra}
        </>
      }
      legend={
        ranked.length > 0 && (
          <>
            <HistoryProgress {...progress} />
            <span className="pd-num">{t("mapx.spikes.surging", { count: surging })}</span>
            {typical !== undefined && (
              <span className="pd-num">
                {t("mapx.spikes.median", { ratio: formatNumber(typical, 2) })}
              </span>
            )}
          </>
        )
      }
      note={t("mapx.spikes.note")}
      state={ranked.length === 0 ? <MapState loader={loader} progress={progress} /> : undefined}
    >
      <div className="pd-mx-scroll">
        <ol className="pd-mx-bars pd-mx-spikes">
          {ranked.slice(0, LIST_MAX).map((r, i) => (
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
                    data-heat={r.spike.ratio >= 2 ? "warn" : "info"}
                    style={{ width: `${max > 0 ? (r.spike.ratio / max) * 100 : 0}%` }}
                  />
                </span>
                <span className="pd-num">{`${formatNumber(r.spike.ratio, 1)}×`}</span>
                <span className={`pd-num ${toneOf(r.spike.change)}`}>
                  {signedPct(r.spike.change)}
                </span>
              </button>
            </li>
          ))}
        </ol>
      </div>
    </MapFrame>
  );
}

/** A line over 0 to 100%, its points spread across the width. */
function sharePath(values: readonly number[], w: number, h: number, pad: number): string {
  if (values.length < 2) return "";
  return values
    .map((v, i) => {
      const x = pad + (i / (values.length - 1)) * (w - 2 * pad);
      const y = h - pad - v * (h - 2 * pad);
      return `${i === 0 ? "M" : "L"}${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");
}

/**
 * How broad the market's move is: the share of markets up on the day and
 * above their averages now, new highs against new lows, and the share
 * above their 20-hour EMA hour by hour.
 */
export function BreadthMap({
  now,
  series,
  progress,
  loader,
  extra,
}: {
  now: BreadthNow;
  series: readonly BreadthPoint[];
  progress: { done: number; total: number };
  loader?: ReactNode;
  extra?: ReactNode;
}) {
  const [ref, size] = useSize<HTMLDivElement>();
  const [hover, setHover] = useState<number>();
  const pad = 28;
  const w = Math.max(size.width, 1);
  const h = Math.max(size.height, 1);
  const pct = (v: number) => `${formatNumber(v * 100, 0)}%`;
  const at = hover === undefined ? undefined : series[hover];
  const clock = dateFormat({ weekday: "short", hour: "2-digit", minute: "2-digit", hour12: false });
  const stats: { key: string; label: string; value: string; tone?: string }[] = [
    {
      key: "up",
      label: t("mapx.breadth.up24h"),
      value: pct(now.up24h),
      tone: toneShare(now.up24h),
    },
    {
      key: "ema20",
      label: t("mapx.breadth.aboveEma20"),
      value: pct(now.aboveEma20),
      tone: toneShare(now.aboveEma20),
    },
    {
      key: "ema50",
      label: t("mapx.breadth.aboveEma50"),
      value: pct(now.aboveEma50),
      tone: toneShare(now.aboveEma50),
    },
    {
      key: "hl",
      label: t("mapx.breadth.highsLows"),
      value: `${now.newHighs} / ${now.newLows}`,
      tone: now.newHighs > now.newLows ? "pd-up" : now.newHighs < now.newLows ? "pd-down" : "",
    },
  ];

  return (
    <MapFrame
      title={t("mapx.breadth.title")}
      controls={extra}
      legend={
        now.total > 0 && (
          <>
            <HistoryProgress {...progress} />
            <span className="pd-num">{t("mapx.breadth.counted", { count: now.total })}</span>
          </>
        )
      }
      note={t("mapx.breadth.note")}
      state={now.total === 0 ? <MapState loader={loader} progress={progress} /> : undefined}
      side={
        now.total > 0 && (
          <div className="pd-mx-stats">
            {stats.map((s) => (
              <div key={s.key} className="pd-mx-stat">
                <span>{s.label}</span>
                <strong className={`pd-num ${s.tone ?? ""}`}>{s.value}</strong>
              </div>
            ))}
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
          aria-label={t("mapx.breadth.title")}
          onPointerMove={(e) => {
            if (series.length < 2) return;
            const box = e.currentTarget.getBoundingClientRect();
            const share = (e.clientX - box.left - pad) / (w - 2 * pad);
            setHover(
              Math.max(0, Math.min(series.length - 1, Math.round(share * (series.length - 1)))),
            );
          }}
        >
          {[0.25, 0.5, 0.75].map((v) => (
            <g key={v}>
              <line
                className={v === 0.5 ? "pd-mx-axis" : "pd-mx-grid"}
                x1={pad}
                x2={w - pad}
                y1={h - pad - v * (h - 2 * pad)}
                y2={h - pad - v * (h - 2 * pad)}
              />
              <text
                className="pd-mx-axis-label"
                x={pad - 4}
                y={h - pad - v * (h - 2 * pad) + 4}
                textAnchor="end"
              >
                {pct(v)}
              </text>
            </g>
          ))}
          <path
            className="pd-mx-line"
            data-heat="info"
            d={sharePath(
              series.map((p) => p.aboveEma),
              w,
              h,
              pad,
            )}
          />
          <path
            className="pd-mx-line pd-mx-line-soft"
            data-heat="flat"
            d={sharePath(
              series.map((p) => p.up24h),
              w,
              h,
              pad,
            )}
          />
          {at && hover !== undefined && (
            <line
              className="pd-mx-cursor"
              x1={pad + (hover / Math.max(series.length - 1, 1)) * (w - 2 * pad)}
              x2={pad + (hover / Math.max(series.length - 1, 1)) * (w - 2 * pad)}
              y1={pad}
              y2={h - pad}
            />
          )}
          <text className="pd-mx-axis-label" x={w - pad} y={pad - 8} textAnchor="end">
            <tspan className="pd-mx-key" data-heat="info">
              ━{" "}
            </tspan>
            {t("mapx.breadth.lineEma")}
            <tspan className="pd-mx-key" data-heat="flat">
              {"   ━ "}
            </tspan>
            {t("mapx.breadth.lineUp")}
          </text>
        </svg>
        {at && hover !== undefined && (
          <HoverCard
            at={{ x: pad + (hover / Math.max(series.length - 1, 1)) * (w - 2 * pad), y: pad + 20 }}
            box={size}
          >
            <div className="pd-map-card-head">
              <strong>{clock.format(at.time)}</strong>
            </div>
            <dl>
              <dt>{t("mapx.breadth.lineEma")}</dt>
              <dd className="pd-num">{pct(at.aboveEma)}</dd>
              <dt>{t("mapx.breadth.lineUp")}</dt>
              <dd className="pd-num">{pct(at.up24h)}</dd>
              <dt>{t("mapx.breadth.markets")}</dt>
              <dd className="pd-num">{at.count}</dd>
            </dl>
          </HoverCard>
        )}
      </div>
    </MapFrame>
  );
}

const toneShare = (v: number) => (v > 0.55 ? "pd-up" : v < 0.45 ? "pd-down" : "");

export interface BetaPoint {
  market: Market;
  beta: number;
  correlation: number;
  /** Annualised volatility over the window. */
  vol: number;
  volume: number;
}

export type BetaWindow = "24h" | "7d";
export const BETA_WINDOWS: readonly BetaWindow[] = ["24h", "7d"];
export const BETA_HOURS: Record<BetaWindow, number> = { "24h": 24, "7d": 168 };

/**
 * Each market's beta to BTC (across) against its own volatility (up): which
 * coins swing harder than BTC and which barely follow it.
 */
export function BetaMap({
  points,
  window,
  onWindow,
  progress,
  loader,
  extra,
  onTrade,
}: {
  points: readonly BetaPoint[];
  window: BetaWindow;
  onWindow: (w: BetaWindow) => void;
  progress: { done: number; total: number };
  loader?: ReactNode;
  extra?: ReactNode;
  onTrade: (market: Market) => void;
}) {
  const [ref, size] = useSize<HTMLDivElement>();
  const [hover, setHover] = useState<string>();
  const betas = points.map((p) => p.beta).sort((a, b) => a - b);
  const xHi = Math.max(betas[Math.floor(betas.length * 0.97)] ?? 2, 1.5) * 1.05;
  const xLo = Math.min(betas[Math.floor(betas.length * 0.03)] ?? 0, 0);
  const vols = points.map((p) => p.vol).sort((a, b) => a - b);
  const yHi = Math.max(vols[Math.floor(vols.length * 0.97)] ?? 1, 0.2) * 1.05;
  const biggest = Math.max(...points.map((p) => p.volume), 1);
  const pad = 32;
  const w = Math.max(size.width, 1);
  const h = Math.max(size.height, 1);
  const x = (v: number) =>
    pad + ((Math.max(xLo, Math.min(xHi, v)) - xLo) / (xHi - xLo)) * (w - 2 * pad);
  const y = (v: number) => h - pad - (Math.max(0, Math.min(yHi, v)) / yHi) * (h - 2 * pad);
  const tip = points.find((p) => p.market.id === hover);
  const nameOf = labelsOf(points.map((p) => p.market));
  const byBeta = [...points].sort((a, b) => b.beta - a.beta);
  const listOf = (items: readonly BetaPoint[]) => (
    <ol className="pd-mx-list">
      {items.map((p) => (
        <li key={p.market.id}>
          <button type="button" onClick={() => onTrade(p.market)}>
            <TokenIcon market={p.market} size={14} />
            <span>{nameOf(p.market)}</span>
            <span className="pd-num pd-muted">{formatNumber(p.beta, 2)}</span>
          </button>
        </li>
      ))}
    </ol>
  );

  return (
    <MapFrame
      title={t("mapx.beta.title")}
      controls={
        <>
          <Seg options={BETA_WINDOWS} value={window} onChange={onWindow} label={t("mapx.window")} />
          {extra}
        </>
      }
      legend={<HistoryProgress {...progress} />}
      note={t("mapx.beta.note")}
      state={points.length === 0 ? <MapState loader={loader} progress={progress} /> : undefined}
      side={
        points.length > 0 && (
          <>
            <h3>{t("mapx.beta.highest")}</h3>
            {listOf(byBeta.slice(0, 6))}
            <h3>{t("mapx.beta.lowest")}</h3>
            {listOf(byBeta.slice(-6).reverse())}
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
          aria-label={t("mapx.beta.title")}
        >
          <line className="pd-mx-axis" x1={x(1)} x2={x(1)} y1={pad / 2} y2={h - pad / 2} />
          <text className="pd-mx-axis-label" x={x(1) + 6} y={pad / 2 + 4}>
            {t("mapx.beta.oneLine")}
          </text>
          <text className="pd-mx-axis-label" x={w - pad / 2} y={h - pad / 2 - 4} textAnchor="end">
            {t("mapx.beta.betaAxis")}
          </text>
          <text className="pd-mx-axis-label" x={pad / 2} y={pad / 2 + 4}>
            {t("mapx.beta.volAxis")}
          </text>
          {points.map((p) => {
            const r = 3 + Math.sqrt(p.volume / biggest) * 12;
            return (
              // biome-ignore lint/a11y/noStaticElementInteractions: the lists beside it are the keyboard way in
              <g
                key={p.market.id}
                className="pd-mx-dot"
                data-heat={p.beta >= 1 ? "warn" : "info"}
                data-hover={hover === p.market.id || undefined}
                onPointerEnter={() => setHover(p.market.id)}
                onClick={() => onTrade(p.market)}
              >
                <circle cx={x(p.beta)} cy={y(p.vol)} r={r} />
                {r > 8 && (
                  <text x={x(p.beta)} y={y(p.vol) - r - 3} textAnchor="middle">
                    {nameOf(p.market)}
                  </text>
                )}
              </g>
            );
          })}
        </svg>
        {tip && (
          <HoverCard at={{ x: x(tip.beta), y: y(tip.vol) }} box={size}>
            <div className="pd-map-card-head">
              <TokenIcon market={tip.market} size={18} />
              <strong>{tip.market.symbol}</strong>
            </div>
            <dl>
              <dt>{t("mapx.beta.beta")}</dt>
              <dd className="pd-num">{formatNumber(tip.beta, 2)}</dd>
              <dt>{t("mapx.beta.correlation")}</dt>
              <dd className="pd-num">{formatNumber(tip.correlation, 2)}</dd>
              <dt>{t("mapx.beta.vol")}</dt>
              <dd className="pd-num">{`${formatNumber(tip.vol * 100, 0)}%`}</dd>
              <dt>{t("mapx.volume24h")}</dt>
              <dd className="pd-num">${formatCompact(tip.volume)}</dd>
            </dl>
          </HoverCard>
        )}
      </div>
    </MapFrame>
  );
}
