import type { Market } from "@pewterdesk/core";
import { hierarchy, treemap, treemapSquarify } from "d3-hierarchy";
import { type CSSProperties, type ReactNode, useState } from "react";
import { dateFormat, t } from "../../i18n";
import { formatCompact, formatNumber, formatPercent } from "../../lib/format";
import {
  BAND_FRAMES,
  type BandFrame,
  type BandRead,
  type BandZone,
  type ConfluenceRead,
  CROSS_WINDOWS,
  type CrossWindow,
  type EmaCross,
  FLOW_WINDOWS,
  type FlowWindow,
  LOWER_ZONES,
  type MoneyFlow,
  type NakedPoc,
  type ObvRead,
  PERF_WINDOWS,
  type PerfWindow,
  RANGE_WINDOWS,
  type RangeWindow,
  type Squeeze,
  UPPER_ZONES,
  type ValueRead,
  type VolumeShare,
} from "../../lib/mapStats";
import type { VolumeProfile } from "../../lib/volumeProfile";
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
import { MAP_TOPS, type MapTop, PERF_SCALE } from "./MomentumMaps";
import { LIST_MAX, RangeBar, RankList, toneOf } from "./StrengthMaps";

// The Maps page's volume and momentum scanners: where each market sits
// against its volume profile, one market's profile in full, money flow and
// on-balance volume, where the venue's volume is moving, how well a
// market's timeframes agree, fresh EMA crosses and tight Bollinger bands.
// All from the hourly history the page already reads.

interface ScanProps {
  progress: { done: number; total: number };
  loader?: ReactNode;
  /** More controls after the view's own (the Crypto / All filter). */
  extra?: ReactNode;
  onTrade: (market: Market) => void;
}

export interface ValueRow {
  market: Market;
  price: number;
  read: ValueRead;
}

/** Every market against its value area: stretched above it, or below it. */
export function ValueAreaMap({
  rows,
  window,
  onWindow,
  progress,
  loader,
  extra,
  onTrade,
}: ScanProps & {
  rows: readonly ValueRow[];
  window: RangeWindow;
  onWindow: (w: RangeWindow) => void;
}) {
  const nameOf = labelsOf(rows.map((r) => r.market));
  const by = (place: ValueRead["place"]) => rows.filter((r) => r.read.place === place);
  const above = by("above").sort((a, b) => b.read.toPoc - a.read.toPoc);
  const below = by("below").sort((a, b) => a.read.toPoc - b.read.toPoc);
  const list = (items: readonly ValueRow[]) =>
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
              <RangeBar
                position={Math.max(
                  0,
                  Math.min(1, (r.price - r.read.val) / (r.read.vah - r.read.val)),
                )}
              />
              <span className={`pd-num ${toneOf(r.read.toPoc)}`}>{signedPct(r.read.toPoc)}</span>
              <span className="pd-num pd-muted">{formatNumber(r.read.poc)}</span>
            </button>
          </li>
        ))}
      </ol>
    );

  return (
    <MapFrame
      title={t("mapx.value.title")}
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
            <span className="pd-up pd-num">{t("mapx.value.above", { count: above.length })}</span>
            <span className="pd-num">{t("mapx.value.inside", { count: by("inside").length })}</span>
            <span className="pd-down pd-num">{t("mapx.value.below", { count: below.length })}</span>
          </>
        )
      }
      note={t("mapx.value.note")}
      state={rows.length === 0 ? <MapState loader={loader} progress={progress} /> : undefined}
    >
      <div className="pd-mx-scroll pd-mx-rank-cols">
        <section className="pd-mx-rank-col">
          <h3>{t("mapx.value.aboveTitle", { window: window.toUpperCase() })}</h3>
          {list(above)}
        </section>
        <section className="pd-mx-rank-col">
          <h3>{t("mapx.value.belowTitle", { window: window.toUpperCase() })}</h3>
          {list(below)}
        </section>
      </div>
    </MapFrame>
  );
}

export type ProfileSpan = "7d" | "30d";
export const PROFILE_SPANS: readonly ProfileSpan[] = ["7d", "30d"];
export const PROFILE_HOURS: Record<ProfileSpan, number> = { "7d": 168, "30d": 720 };

/**
 * One market's volume at price over a week or a month: the histogram, its
 * point of control and value area, the price now, and the days' points of
 * control nothing has traded back through.
 */
export function ProfileMap({
  market,
  profile,
  price,
  naked,
  span,
  onSpan,
  controls,
  loader,
  error,
}: {
  market?: Market;
  profile?: VolumeProfile;
  /** The price now. */
  price?: number;
  naked: readonly NakedPoc[];
  span: ProfileSpan;
  onSpan: (s: ProfileSpan) => void;
  /** The market picker. */
  controls?: ReactNode;
  loader?: ReactNode;
  error?: string;
}) {
  const [ref, size] = useSize<HTMLDivElement>();
  const pad = 24;
  const scaleW = 72;
  const w = Math.max(size.width, 1);
  const h = Math.max(size.height, 1);
  const lo = profile?.rows[0]?.low ?? 0;
  const hi = profile?.rows[profile.rows.length - 1]?.high ?? 1;
  const y = (v: number) => h - pad - ((v - lo) / (hi - lo || 1)) * (h - 2 * pad);
  const length = w - scaleW - 2 * pad;
  const poc = profile?.rows[profile.poc];
  const vah = profile?.rows[profile.valueHigh];
  const val = profile?.rows[profile.valueLow];
  const pocPrice = poc && (poc.low + poc.high) / 2;
  const day = dateFormat({ month: "short", day: "numeric" });
  const level = (key: string, value: number, cls: string, label: string) => (
    <g key={key}>
      <line className={cls} x1={pad} x2={w - scaleW} y1={y(value)} y2={y(value)} />
      <text
        className="pd-mx-axis-label"
        x={w - scaleW + 4}
        y={y(value) + 4}
      >{`${label} ${formatNumber(value)}`}</text>
    </g>
  );
  const shown = naked.filter((n) => n.price >= lo && n.price <= hi);

  return (
    <MapFrame
      title={t("mapx.profile.title")}
      controls={
        <>
          {controls}
          <Seg options={PROFILE_SPANS} value={span} onChange={onSpan} label={t("mapx.window")} />
        </>
      }
      note={t("mapx.profile.note")}
      state={
        error ? <MapState error={error} /> : !profile ? <MapState loader={loader} /> : undefined
      }
      side={
        profile &&
        pocPrice !== undefined && (
          <>
            <div className="pd-mx-stats">
              <div className="pd-mx-stat">
                <span>{t("mapx.profile.poc")}</span>
                <strong className="pd-num">{formatNumber(pocPrice)}</strong>
              </div>
              <div className="pd-mx-stat">
                <span>{t("mapx.profile.vah")}</span>
                <strong className="pd-num">{vah ? formatNumber(vah.high) : "-"}</strong>
              </div>
              <div className="pd-mx-stat">
                <span>{t("mapx.profile.val")}</span>
                <strong className="pd-num">{val ? formatNumber(val.low) : "-"}</strong>
              </div>
            </div>
            <h3>{t("mapx.profile.naked")}</h3>
            {naked.length === 0 ? (
              <p className="pd-muted pd-mx-empty-line">{t("mapx.breakout.none")}</p>
            ) : (
              <ol className="pd-mx-list pd-mx-naked">
                {[...naked]
                  .reverse()
                  .slice(0, 10)
                  .map((n) => (
                    <li key={n.time}>
                      <span className="pd-num">{formatNumber(n.price)}</span>
                      <span className="pd-num pd-muted">{day.format(n.time)}</span>
                    </li>
                  ))}
              </ol>
            )}
          </>
        )
      }
    >
      <div ref={ref} className="pd-mx-fill">
        {profile && (
          <svg
            className="pd-mx-plot"
            width={w}
            height={h}
            role="img"
            aria-label={market ? `${t("mapx.profile.title")} ${market.symbol}` : undefined}
          >
            {profile.rows.map((row, i) => {
              const top = y(row.high);
              const height = Math.max(1, y(row.low) - top - 1);
              const inValue = i >= profile.valueLow && i <= profile.valueHigh;
              const upW = (row.up / (profile.max || 1)) * length;
              const downW = (row.down / (profile.max || 1)) * length;
              return (
                // biome-ignore lint/suspicious/noArrayIndexKey: rows are positions on the scale
                <g key={i} className="pd-mx-prow" data-value={inValue || undefined}>
                  <rect
                    className="pd-mx-prow-up"
                    x={pad}
                    y={top}
                    width={Math.max(upW, 0)}
                    height={height}
                  />
                  <rect
                    className="pd-mx-prow-down"
                    x={pad + upW}
                    y={top}
                    width={Math.max(downW, 0)}
                    height={height}
                  />
                </g>
              );
            })}
            {shown.map((n) => level(`n${n.time}`, n.price, "pd-mx-naked-line", ""))}
            {vah && level("vah", vah.high, "pd-mx-axis", "VAH")}
            {val && level("val", val.low, "pd-mx-axis", "VAL")}
            {pocPrice !== undefined && level("poc", pocPrice, "pd-mx-poc", "POC")}
            {price !== undefined &&
              price >= lo &&
              price <= hi &&
              level("price", price, "pd-mx-price", "")}
          </svg>
        )}
      </div>
    </MapFrame>
  );
}

export interface FlowRow {
  market: Market;
  flow: MoneyFlow;
}

/** Value traded on up hours against down hours: where money has been going in. */
export function MoneyFlowMap({
  rows,
  window,
  onWindow,
  progress,
  loader,
  extra,
  onTrade,
}: ScanProps & {
  rows: readonly FlowRow[];
  window: FlowWindow;
  onWindow: (w: FlowWindow) => void;
}) {
  const inflow = rows.filter((r) => r.flow.net > 0).sort((a, b) => b.flow.net - a.flow.net);
  const outflow = rows.filter((r) => r.flow.net < 0).sort((a, b) => a.flow.net - b.flow.net);
  const max = Math.max(...rows.map((r) => Math.abs(r.flow.net)), 0);
  const money = (v: number) => `${v < 0 ? "-" : "+"}$${formatCompact(Math.abs(v))}`;
  const ratioOf = new Map(rows.map((r) => [r.market.id, r.flow.ratio]));
  const ratio = (m: Market) => (
    <span className="pd-num pd-muted">{signedPct(ratioOf.get(m.id), 0)}</span>
  );
  const asRows = (list: readonly FlowRow[]) =>
    list.slice(0, LIST_MAX).map((r) => ({ market: r.market, value: r.flow.net }));

  return (
    <MapFrame
      title={t("mapx.money.title")}
      controls={
        <>
          <Seg options={FLOW_WINDOWS} value={window} onChange={onWindow} label={t("mapx.window")} />
          {extra}
        </>
      }
      legend={
        rows.length > 0 && (
          <>
            <HistoryProgress {...progress} />
            <span className="pd-up pd-num">{t("mapx.money.in", { count: inflow.length })}</span>
            <span className="pd-down pd-num">{t("mapx.money.out", { count: outflow.length })}</span>
          </>
        )
      }
      note={t("mapx.money.note")}
      state={rows.length === 0 ? <MapState loader={loader} progress={progress} /> : undefined}
    >
      <div className="pd-mx-scroll pd-mx-rank-cols">
        <RankList
          title={t("mapx.money.inTitle")}
          rows={asRows(inflow)}
          max={max}
          value={() => "up"}
          text={money}
          extra={ratio}
          onTrade={onTrade}
        />
        <RankList
          title={t("mapx.money.outTitle")}
          rows={asRows(outflow)}
          max={max}
          value={() => "down"}
          text={money}
          extra={ratio}
          onTrade={onTrade}
        />
      </div>
    </MapFrame>
  );
}

export interface ObvRow {
  market: Market;
  read: ObvRead;
}

/** Markets whose on-balance volume and price disagree. */
export function ObvMap({
  rows,
  window,
  onWindow,
  progress,
  loader,
  extra,
  onTrade,
}: ScanProps & {
  rows: readonly ObvRow[];
  window: RangeWindow;
  onWindow: (w: RangeWindow) => void;
}) {
  const asRows = (kind: ObvRead["kind"]) =>
    rows
      .filter((r) => r.read.kind === kind)
      .sort((a, b) => Math.abs(b.read.gap) - Math.abs(a.read.gap))
      .map((r) => ({ market: r.market, value: r.read.gap }));
  const bullish = asRows("bullish");
  const bearish = asRows("bearish");
  const placeOf = new Map(rows.map((r) => [r.market.id, r.read]));
  const pos = (v: number) => formatPercent(v, 0);
  const places = (m: Market) => {
    const read = placeOf.get(m.id);
    return (
      <span className="pd-num pd-muted" title={t("mapx.obv.places")}>
        {read ? `${pos(read.price)} / ${pos(read.obv)}` : "-"}
      </span>
    );
  };

  return (
    <MapFrame
      title={t("mapx.obv.title")}
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
            <span className="pd-up pd-num">{t("mapx.obv.bullish", { count: bullish.length })}</span>
            <span className="pd-down pd-num">
              {t("mapx.obv.bearish", { count: bearish.length })}
            </span>
          </>
        )
      }
      note={t("mapx.obv.note")}
      state={rows.length === 0 ? <MapState loader={loader} progress={progress} /> : undefined}
    >
      <div className="pd-mx-scroll pd-mx-rank-cols">
        <RankList
          title={t("mapx.obv.bullishTitle")}
          rows={bullish.slice(0, LIST_MAX)}
          max={1}
          value={() => "up"}
          text={(v) => formatNumber(Math.abs(v) * 100, 0)}
          extra={places}
          onTrade={onTrade}
        />
        <RankList
          title={t("mapx.obv.bearishTitle")}
          rows={bearish.slice(0, LIST_MAX)}
          max={1}
          value={() => "down"}
          text={(v) => formatNumber(Math.abs(v) * 100, 0)}
          extra={places}
          onTrade={onTrade}
        />
      </div>
    </MapFrame>
  );
}

export interface ShareTile {
  market: Market;
  share: VolumeShare;
}

/** Each market's share of the venue's volume, coloured by how it compares with the week's. */
export function VolumeRotationMap({
  tiles,
  top,
  onTop,
  progress,
  loader,
  extra,
  onTrade,
}: ScanProps & {
  tiles: readonly ShareTile[];
  top: MapTop;
  onTop: (top: MapTop) => void;
}) {
  const [ref, size] = useSize<HTMLDivElement>();
  const [hover, setHover] = useState<{ id: string; x: number; y: number }>();
  const shown = [...tiles].sort((a, b) => b.share.day - a.share.day).slice(0, Number(top));
  const root = treemap<{ children?: ShareTile[] } | ShareTile>()
    .tile(treemapSquarify)
    .size([Math.max(size.width, 1), Math.max(size.height, 1)])
    .paddingInner(1)
    .round(true)(
    hierarchy<{ children?: ShareTile[] } | ShareTile>({ children: shown }, (d) =>
      "children" in d ? d.children : undefined,
    ).sum((d) => ("share" in d ? d.share.day : 0)),
  );
  const tip = hover && shown.find((s) => s.market.id === hover.id);
  const nameOf = labelsOf(shown.map((s) => s.market));
  const rising = shown.filter((s) => s.share.change > 0.25).length;

  return (
    <MapFrame
      title={t("mapx.rotationVol.title")}
      controls={
        <>
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
        shown.length > 0 && (
          <>
            <HistoryProgress {...progress} />
            <span className="pd-num">{t("mapx.rotationVol.rising", { count: rising })}</span>
          </>
        )
      }
      note={t("mapx.rotationVol.note")}
      state={shown.length === 0 ? <MapState loader={loader} progress={progress} /> : undefined}
    >
      <div ref={ref} className="pd-mx-fill" onPointerLeave={() => setHover(undefined)}>
        {root.leaves().map((leaf) => {
          if (!("market" in leaf.data)) return null;
          const d = leaf.data;
          const w = leaf.x1 - leaf.x0;
          const h = leaf.y1 - leaf.y0;
          const tone = heat(d.share.change, 1, ["warn", "info"]);
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
                  {h > 36 && (
                    <span className="pd-mx-tile-value pd-num">{signedPct(d.share.change, 0)}</span>
                  )}
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
              <dt>{t("mapx.rotationVol.day")}</dt>
              <dd className="pd-num">{formatPercent(tip.share.day)}</dd>
              <dt>{t("mapx.rotationVol.week")}</dt>
              <dd className="pd-num">{formatPercent(tip.share.week)}</dd>
              <dt>{t("mapx.rotationVol.change")}</dt>
              <dd className="pd-num">{signedPct(tip.share.change, 0)}</dd>
            </dl>
          </HoverCard>
        )}
      </div>
    </MapFrame>
  );
}

export interface MatrixRow {
  market: Market;
  changes: Partial<Record<PerfWindow, number>>;
  /** Windows up less windows down. */
  score: number;
}

export type MatrixSide = "up" | "down";
export const MATRIX_SIDES: readonly MatrixSide[] = ["up", "down"];

/** Markets by timeframe in one grid, those whose timeframes agree most first. */
export function MomentumMatrix({
  rows,
  side,
  onSide,
  progress,
  loader,
  extra,
  onTrade,
}: ScanProps & {
  rows: readonly MatrixRow[];
  side: MatrixSide;
  onSide: (s: MatrixSide) => void;
}) {
  const sum = (r: MatrixRow) =>
    PERF_WINDOWS.reduce((a, w) => a + (r.changes[w] ?? 0) / PERF_SCALE[w], 0);
  const sign = side === "up" ? 1 : -1;
  const ranked = [...rows]
    .sort((a, b) => sign * (b.score - a.score) || sign * (sum(b) - sum(a)))
    .slice(0, LIST_MAX);
  const nameOf = labelsOf(ranked.map((r) => r.market));
  const all = (s: number) => rows.filter((r) => r.score === s).length;

  return (
    <MapFrame
      title={t("mapx.matrix.title")}
      controls={
        <>
          <Seg
            options={MATRIX_SIDES}
            value={side}
            onChange={onSide}
            label={t("mapx.matrix.side")}
            text={(s) => t(`mapx.matrix.side.${s}`)}
          />
          {extra}
        </>
      }
      legend={
        rows.length > 0 && (
          <>
            <HistoryProgress {...progress} />
            <span className="pd-up pd-num">
              {t("mapx.matrix.allUp", { count: all(PERF_WINDOWS.length) })}
            </span>
            <span className="pd-down pd-num">
              {t("mapx.matrix.allDown", { count: all(-PERF_WINDOWS.length) })}
            </span>
          </>
        )
      }
      note={t("mapx.matrix.note")}
      state={rows.length === 0 ? <MapState loader={loader} progress={progress} /> : undefined}
    >
      <div className="pd-mx-scroll">
        <div className="pd-mx-matrix">
          <span />
          {PERF_WINDOWS.map((w) => (
            <span key={w} className="pd-mx-fhist-col pd-mx-matrix-col">
              {w.toUpperCase()}
            </span>
          ))}
          {ranked.map((r) => (
            <div key={r.market.id} className="pd-mx-fhist-row">
              <button type="button" className="pd-mx-name" onClick={() => onTrade(r.market)}>
                <TokenIcon market={r.market} size={14} />
                {nameOf(r.market)}
              </button>
              {PERF_WINDOWS.map((w) => {
                const tone = heat(r.changes[w], PERF_SCALE[w]);
                return (
                  <span
                    key={w}
                    className="pd-mx-cell pd-mx-matrix-cell pd-num"
                    data-heat={tone["data-heat"]}
                    style={tone.style}
                  >
                    {signedPct(r.changes[w], 1)}
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

export interface CrossRow {
  market: Market;
  cross: EmaCross;
}

/** Markets whose 20- and 50-hour EMAs crossed lately, freshest first. */
export function EmaCrossMap({
  rows,
  window,
  onWindow,
  progress,
  loader,
  extra,
  onTrade,
}: ScanProps & {
  rows: readonly CrossRow[];
  window: CrossWindow;
  onWindow: (w: CrossWindow) => void;
}) {
  const of = (direction: EmaCross["direction"]) =>
    rows
      .filter((r) => r.cross.direction === direction)
      .sort((a, b) => a.cross.hoursAgo - b.cross.hoursAgo);
  const up = of("up");
  const down = of("down");
  const max = Math.max(...rows.map((r) => Math.abs(r.cross.gap)), 0);
  const agoOf = new Map(rows.map((r) => [r.market.id, r.cross.hoursAgo]));
  const ago = (m: Market) => (
    <span className="pd-num pd-muted">{t("mapx.cross.ago", { hours: agoOf.get(m.id) ?? 0 })}</span>
  );
  const asRows = (list: readonly CrossRow[]) =>
    list.slice(0, LIST_MAX).map((r) => ({ market: r.market, value: r.cross.gap }));

  return (
    <MapFrame
      title={t("mapx.cross.title")}
      controls={
        <>
          <Seg
            options={CROSS_WINDOWS}
            value={window}
            onChange={onWindow}
            label={t("mapx.window")}
          />
          {extra}
        </>
      }
      legend={<HistoryProgress {...progress} />}
      note={t("mapx.cross.note")}
      state={
        progress.done === 0 ? (
          <MapState loader={loader} progress={progress} />
        ) : rows.length === 0 ? (
          <MapState message={t("mapx.cross.none")} />
        ) : undefined
      }
    >
      <div className="pd-mx-scroll pd-mx-rank-cols">
        <RankList
          title={t("mapx.cross.upTitle", { count: up.length })}
          rows={asRows(up)}
          max={max}
          value={() => "up"}
          text={(v) => signedPct(v)}
          extra={ago}
          onTrade={onTrade}
        />
        <RankList
          title={t("mapx.cross.downTitle", { count: down.length })}
          rows={asRows(down)}
          max={max}
          value={() => "down"}
          text={(v) => signedPct(v)}
          extra={ago}
          onTrade={onTrade}
        />
      </div>
    </MapFrame>
  );
}

export interface SqueezeRow {
  market: Market;
  squeeze: Squeeze;
  change24h?: number;
}

/** Only the tightest quarter of a market's own history counts as a squeeze. */
const SQUEEZE_RANK = 0.25;

/** Markets whose Bollinger bands are tight against their own history. */
export function SqueezeMap({
  rows,
  progress,
  loader,
  extra,
  onTrade,
}: ScanProps & { rows: readonly SqueezeRow[] }) {
  const ranked = rows
    .filter((r) => r.squeeze.rank <= SQUEEZE_RANK)
    .sort((a, b) => a.squeeze.rank - b.squeeze.rank || a.squeeze.bandwidth - b.squeeze.bandwidth);
  const nameOf = labelsOf(ranked.map((r) => r.market));

  return (
    <MapFrame
      title={t("mapx.squeeze.title")}
      controls={extra}
      legend={
        rows.length > 0 && (
          <>
            <HistoryProgress {...progress} />
            <span className="pd-num">{t("mapx.squeeze.count", { count: ranked.length })}</span>
          </>
        )
      }
      note={t("mapx.squeeze.note")}
      state={rows.length === 0 ? <MapState loader={loader} progress={progress} /> : undefined}
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
                    data-heat="info"
                    style={{ width: `${(1 - r.squeeze.rank / SQUEEZE_RANK) * 100}%` }}
                  />
                </span>
                <span className="pd-num">{formatPercent(r.squeeze.bandwidth)}</span>
                <span className={`pd-num ${toneOf(r.change24h)}`}>{signedPct(r.change24h)}</span>
              </button>
            </li>
          ))}
        </ol>
      </div>
    </MapFrame>
  );
}

export interface BandRow {
  market: Market;
  read: BandRead;
}

/**
 * Where each market's price is against its Bollinger bands: outside them, at
 * them or near them, on the upper side and the lower. Markets mid-band are
 * only counted.
 */
export function BollingerMap({
  rows,
  frame,
  onFrame,
  progress,
  loader,
  extra,
  onTrade,
}: ScanProps & {
  rows: readonly BandRow[];
  frame: BandFrame;
  onFrame: (f: BandFrame) => void;
}) {
  const nameOf = labelsOf(rows.map((r) => r.market));
  const count = (zone: BandZone) => rows.filter((r) => r.read.zone === zone).length;
  const side = (zones: readonly BandZone[], order: 1 | -1) =>
    rows
      .filter((r) => zones.includes(r.read.zone))
      .sort((a, b) => order * (b.read.percentB - a.read.percentB))
      .slice(0, LIST_MAX);
  const list = (items: readonly BandRow[]) =>
    items.length === 0 ? (
      <p className="pd-muted pd-mx-empty-line">{t("mapx.breakout.none")}</p>
    ) : (
      <ol className="pd-mx-bars pd-mx-band-rows">
        {items.map((r) => (
          <li key={r.market.id}>
            <button type="button" onClick={() => onTrade(r.market)}>
              <span className="pd-mx-name">
                <TokenIcon market={r.market} size={16} />
                {nameOf(r.market)}
              </span>
              <RangeBar position={Math.max(0, Math.min(1, r.read.percentB))} />
              <span className="pd-num">{formatNumber(r.read.percentB * 100, 0)}%</span>
              <span className="pd-mx-chip" data-zone={r.read.zone}>
                {t(`mapx.bands.${r.read.zone}` as const)}
              </span>
            </button>
          </li>
        ))}
      </ol>
    );
  const stat = (zone: Exclude<BandZone, "middle">) => (
    <div key={zone} className="pd-mx-stat" data-zone={zone}>
      <span>{t(`mapx.bands.${zone}`)}</span>
      <strong className="pd-num">{count(zone)}</strong>
    </div>
  );

  return (
    <MapFrame
      title={t("mapx.bands.title")}
      controls={
        <>
          <Seg
            options={BAND_FRAMES}
            value={frame}
            onChange={onFrame}
            label={t("mapx.bands.frame")}
          />
          {extra}
        </>
      }
      legend={
        rows.length > 0 && (
          <>
            <HistoryProgress {...progress} />
            <span className="pd-num">{t("mapx.bands.middle", { count: count("middle") })}</span>
          </>
        )
      }
      note={t("mapx.bands.note")}
      state={rows.length === 0 ? <MapState loader={loader} progress={progress} /> : undefined}
      side={
        rows.length > 0 && (
          <div className="pd-mx-stats">{[...UPPER_ZONES, ...LOWER_ZONES].map(stat)}</div>
        )
      }
    >
      <div className="pd-mx-scroll pd-mx-rank-cols">
        <section className="pd-mx-rank-col">
          <h3>{t("mapx.bands.upperTitle")}</h3>
          {list(side(UPPER_ZONES, 1))}
        </section>
        <section className="pd-mx-rank-col">
          <h3>{t("mapx.bands.lowerTitle")}</h3>
          {list(side(LOWER_ZONES, -1))}
        </section>
      </div>
    </MapFrame>
  );
}

export interface ConfluenceRow {
  market: Market;
  read: ConfluenceRead;
}

/**
 * Where RSI and the bands agree: markets overbought at or near the upper
 * band, and oversold at or near the lower. Anything else is only counted.
 */
export function ConfluenceMap({
  rows,
  frame,
  onFrame,
  progress,
  loader,
  extra,
  onTrade,
}: ScanProps & {
  rows: readonly ConfluenceRow[];
  frame: BandFrame;
  onFrame: (f: BandFrame) => void;
}) {
  const nameOf = labelsOf(rows.map((r) => r.market));
  const sideOf = (side: "upper" | "lower") =>
    rows
      .filter((r) => r.read.side === side)
      .sort((a, b) => (side === "upper" ? b.read.rsi - a.read.rsi : a.read.rsi - b.read.rsi));
  const upper = sideOf("upper");
  const lower = sideOf("lower");
  const list = (items: readonly ConfluenceRow[]) =>
    items.length === 0 ? (
      <p className="pd-muted pd-mx-empty-line">{t("mapx.breakout.none")}</p>
    ) : (
      <ol className="pd-mx-bars pd-mx-conf-rows">
        {items.slice(0, LIST_MAX).map((r) => (
          <li key={r.market.id}>
            <button type="button" onClick={() => onTrade(r.market)}>
              <span className="pd-mx-name">
                <TokenIcon market={r.market} size={16} />
                {nameOf(r.market)}
              </span>
              <span
                className="pd-num pd-mx-conf-rsi"
                data-zone={r.read.side === "upper" ? "overbought" : "oversold"}
              >
                {formatNumber(r.read.rsi, 1)}
              </span>
              <RangeBar position={Math.max(0, Math.min(1, r.read.band.percentB))} />
              <span className="pd-num pd-mx-conf-b">
                {formatNumber(r.read.band.percentB * 100, 0)}%
              </span>
              <span className="pd-mx-chip">{t(`mapx.bands.${r.read.band.zone}` as const)}</span>
            </button>
          </li>
        ))}
      </ol>
    );

  return (
    <MapFrame
      title={t("mapx.conf.title")}
      controls={
        <>
          <Seg
            options={BAND_FRAMES}
            value={frame}
            onChange={onFrame}
            label={t("mapx.bands.frame")}
          />
          {extra}
        </>
      }
      legend={
        rows.length > 0 && (
          <>
            <HistoryProgress {...progress} />
            <span className="pd-num">{t("mapx.conf.checked", { count: rows.length })}</span>
          </>
        )
      }
      note={t("mapx.conf.note")}
      state={rows.length === 0 ? <MapState loader={loader} progress={progress} /> : undefined}
      side={
        rows.length > 0 && (
          <div className="pd-mx-stats">
            <div className="pd-mx-stat" data-zone="overbought">
              <span>{t("mapx.conf.upperTitle")}</span>
              <strong className="pd-num">{upper.length}</strong>
            </div>
            <div className="pd-mx-stat" data-zone="oversold">
              <span>{t("mapx.conf.lowerTitle")}</span>
              <strong className="pd-num">{lower.length}</strong>
            </div>
          </div>
        )
      }
    >
      <div className="pd-mx-scroll pd-mx-rank-cols">
        <section className="pd-mx-rank-col">
          <h3>{t("mapx.conf.upperTitle")}</h3>
          {list(upper)}
        </section>
        <section className="pd-mx-rank-col">
          <h3>{t("mapx.conf.lowerTitle")}</h3>
          {list(lower)}
        </section>
      </div>
    </MapFrame>
  );
}
