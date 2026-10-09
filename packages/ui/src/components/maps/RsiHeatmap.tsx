import type { Market } from "@pewterdesk/core";
import { type PointerEvent, useEffect, useMemo, useRef, useState } from "react";
import { LuArrowDown, LuArrowUp, LuChartScatter, LuRefreshCw, LuTable } from "react-icons/lu";
import { type MessageKey, t } from "../../i18n";
import { formatCompact, formatNumber, formatSigned } from "../../lib/format";
import { RSI_FRAMES, RSI_ZONES, type RsiFrame, type RsiZone, rsiZone } from "../../lib/marketMaps";
import { Select } from "../common/Select";
import { EmptyState } from "../common/Status";
import { TokenIcon } from "../trading/TokenIcon";

const ZONE_LABEL: Record<RsiZone, MessageKey> = {
  overbought: "rsi.overbought",
  strong: "rsi.strong",
  neutral: "rsi.neutral",
  weak: "rsi.weak",
  oversold: "rsi.oversold",
};
/** Each band's RSI range, top to bottom. */
const BANDS: { zone: RsiZone; from: number; to: number }[] = [
  { zone: "overbought", from: 70, to: 100 },
  { zone: "strong", from: 60, to: 70 },
  { zone: "neutral", from: 40, to: 60 },
  { zone: "weak", from: 30, to: 40 },
  { zone: "oversold", from: 0, to: 30 },
];
/** The scale never moves: values past it sit on its edge. */
const RSI_MIN = 10;
const RSI_MAX = 90;
const PAD = { top: 18, right: 150, bottom: 14, left: 44 };
/** A label's rough size, for keeping labels from overlapping. */
const CHAR_W = 6.1;
const LABEL_H = 11;
/** How near (px) the pointer must be to a dot for its card. */
const HOVER_REACH = 12;

/** How the readings are laid out: dots on the fixed chart, or rows to sort. */
export const RSI_VIEWS = ["chart", "table"] as const;
export type RsiView = (typeof RSI_VIEWS)[number];

export type RsiScope = "all" | "50" | "100";
export const RSI_SCOPES: readonly RsiScope[] = ["all", "50", "100"];

/** What the card shows beside a market's RSI. */
export interface RsiQuote {
  price: number;
  change24h: number;
  volume: number;
}

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

const price = (v: number) => formatNumber(v, v < 1 ? 5 : v < 100 ? 3 : 2);

/** One market in the table. */
interface Row {
  market: Market;
  /** Its place by volume, from 1: the chart's column. */
  rank: number;
  value: number;
  previous?: number;
  zone: RsiZone;
  quote?: RsiQuote;
}

type SortKey = "rank" | "name" | "price" | "volume" | "change" | "rsi" | "previous";

const SORT_VALUE: Record<SortKey, (row: Row) => number | string | undefined> = {
  rank: (r) => r.rank,
  name: (r) => r.market.base.toLowerCase(),
  price: (r) => r.quote?.price,
  volume: (r) => r.quote?.volume,
  change: (r) => r.quote?.change24h,
  rsi: (r) => r.value,
  previous: (r) => r.previous,
};

/**
 * The same readings as rows: each market with its price, volume, the day's
 * change, and its RSI now and one candle ago. Any column sorts; a row opens
 * the market to trade.
 */
function RsiTable({
  rows,
  frame,
  onTrade,
}: {
  rows: readonly Row[];
  frame: RsiFrame;
  onTrade: (market: Market) => void;
}) {
  const [sort, setSort] = useState<{ key: SortKey; down: boolean }>({ key: "rank", down: false });
  const sorted = useMemo(() => {
    const value = SORT_VALUE[sort.key];
    return [...rows].sort((a, b) => {
      const x = value(a);
      const y = value(b);
      // A market with no number for the column goes last, either way up.
      if (x === undefined || y === undefined) return x === y ? 0 : x === undefined ? 1 : -1;
      const order = typeof x === "string" ? x.localeCompare(String(y)) : x - Number(y);
      return sort.down ? -order : order;
    });
  }, [rows, sort]);
  const head = (key: SortKey, label: string, text = false) => (
    <th
      className={text ? "pd-rsi-th pd-rsi-th-text" : "pd-rsi-th"}
      aria-sort={sort.key === key ? (sort.down ? "descending" : "ascending") : "none"}
    >
      <button
        type="button"
        className="pd-rsi-sort"
        data-on={sort.key === key || undefined}
        // Numbers start from the largest; a second click turns it round.
        onClick={() =>
          setSort((now) =>
            now.key === key
              ? { key, down: !now.down }
              : { key, down: key !== "rank" && key !== "name" },
          )
        }
      >
        {label}
        {sort.key === key &&
          (sort.down ? <LuArrowDown size={12} aria-hidden /> : <LuArrowUp size={12} aria-hidden />)}
      </button>
    </th>
  );
  return (
    <div className="pd-rsi-table-wrap">
      <table className="pd-rsi-table">
        <thead>
          <tr>
            {head("rank", "#", true)}
            {head("name", t("col.market"), true)}
            {head("price", t("col.price"))}
            {head("volume", t("heat.volume"))}
            {head("change", "24h %")}
            {head("rsi", t("rsi.now", { frame: t(`rsi.frame.${frame}`) }))}
            {head("previous", t("rsi.before"))}
          </tr>
        </thead>
        <tbody>
          {sorted.map((row) => (
            <tr key={row.market.id} className="pd-rsi-row">
              <td className="pd-rsi-td pd-rsi-td-text pd-muted pd-num">{row.rank}</td>
              <td className="pd-rsi-td pd-rsi-td-text">
                <button
                  type="button"
                  className="pd-rsi-name"
                  title={t("rsi.clickToTrade")}
                  onClick={() => onTrade(row.market)}
                >
                  <TokenIcon market={row.market} size={22} />
                  <strong>{row.market.base}</strong>
                  <span className="pd-muted pd-rsi-ticker">{row.market.symbol}</span>
                </button>
              </td>
              <td className="pd-rsi-td pd-num">{row.quote ? price(row.quote.price) : "–"}</td>
              <td className="pd-rsi-td pd-num">
                {row.quote ? `$${formatCompact(row.quote.volume)}` : "–"}
              </td>
              <td
                className={`pd-rsi-td pd-num ${row.quote ? (row.quote.change24h >= 0 ? "pd-up" : "pd-down") : ""}`}
              >
                {row.quote ? `${formatSigned(row.quote.change24h * 100, 2)}%` : "–"}
              </td>
              <td className="pd-rsi-td pd-num pd-rsi-value" data-zone={row.zone}>
                {formatNumber(row.value, 1)}
              </td>
              <td
                className="pd-rsi-td pd-num pd-rsi-value"
                data-zone={row.previous === undefined ? undefined : rsiZone(row.previous)}
              >
                {row.previous === undefined ? "–" : formatNumber(row.previous, 1)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {sorted.length === 0 && <EmptyState>{t("rsi.noRows")}</EmptyState>}
    </div>
  );
}

interface Point {
  market: Market;
  value: number;
  previous?: number;
  zone: RsiZone;
  x: number;
  y: number;
}

interface RsiHeatmapProps {
  /** Every market, busiest first: each keeps its slot across the chart, loaded or not. */
  slots: readonly Market[];
  values: ReadonlyMap<string, { value: number; previous?: number }>;
  quotes?: ReadonlyMap<string, RsiQuote>;
  frame: RsiFrame;
  onFrame: (frame: RsiFrame) => void;
  scope: RsiScope;
  onScope: (scope: RsiScope) => void;
  /** The chart of dots, or the same readings as a table. */
  view: RsiView;
  onView: (view: RsiView) => void;
  /** Markets read so far this pass, while loading. */
  progress?: { done: number; total: number };
  loading: boolean;
  onRefresh: () => void;
  onTrade: (market: Market) => void;
}

/**
 * Every market's RSI(14) on one fixed chart, after coinglass's RSI heatmap:
 * each market has its own column (busiest on the left) and the scale is
 * always 10 to 90, so dots stay put while values load and refresh. Bands
 * mark overbought, strong, neutral, weak and oversold; a dotted line runs
 * back to the RSI one candle earlier; the market average runs across.
 * Hover a dot for its numbers; click it to trade. The table view lists the
 * same readings as rows that sort by any column.
 */
export function RsiHeatmap({
  slots,
  values,
  quotes,
  frame,
  onFrame,
  scope,
  onScope,
  view,
  onView,
  progress,
  loading,
  onRefresh,
  onTrade,
}: RsiHeatmapProps) {
  const [ref, { width, height }] = useSize<HTMLDivElement>();
  const [zones, setZones] = useState<ReadonlySet<RsiZone>>(new Set(RSI_ZONES));
  const [hover, setHover] = useState<string>();

  const plotW = Math.max(width - PAD.left - PAD.right, 1);
  const plotH = Math.max(height - PAD.top - PAD.bottom, 1);
  const y = (v: number) =>
    PAD.top + ((RSI_MAX - Math.min(Math.max(v, RSI_MIN), RSI_MAX)) / (RSI_MAX - RSI_MIN)) * plotH;
  const columns = scope === "all" ? slots : slots.slice(0, Number(scope));

  // biome-ignore lint/correctness/useExhaustiveDependencies: `y` follows `plotH`
  const points = useMemo(() => {
    const out: Point[] = [];
    columns.forEach((market, i) => {
      const reading = values.get(market.id);
      if (!reading) return;
      const zone = rsiZone(reading.value);
      out.push({
        market,
        value: reading.value,
        previous: reading.previous,
        zone,
        x: PAD.left + ((i + 0.5) / Math.max(columns.length, 1)) * plotW,
        y: y(reading.value),
      });
    });
    return out;
  }, [columns, values, plotW, plotH]);
  const shown = points.filter((p) => zones.has(p.zone));
  const average = points.length ? points.reduce((s, p) => s + p.value, 0) / points.length : 50;
  /** A band's label, moved clear of the average's tag in the margin if they'd meet. */
  const bandLabelY = (wanted: number, top: number, bottom: number) => {
    if (points.length === 0) return wanted;
    const tag = y(average);
    if (Math.abs(wanted - 6 - tag) > 20) return wanted;
    const above = tag - 18;
    const below = tag + 30;
    return above - 12 > top ? above : below < bottom ? below : wanted;
  };

  // Labels where they fit, busiest markets first: above the dot, else
  // below, else beside it. The rest show their name in the hover card.
  const labels = useMemo(() => {
    const taken: [number, number, number, number][] = [];
    const out = new Map<string, { x: number; y: number }>();
    const free = (x: number, top: number, w: number) =>
      !taken.some(([a, b, c, d]) => x < c && x + w > a && top < d && top + LABEL_H > b);
    for (const p of shown) {
      const w = p.market.base.length * CHAR_W;
      for (const [dx, dy] of [
        [-w / 2, -6],
        [-w / 2, 15],
        [6, 4],
        [-w - 6, 4],
      ] as const) {
        const lx = p.x + dx;
        const ly = p.y + dy;
        if (lx < PAD.left || lx + w > PAD.left + plotW) continue;
        if (ly - LABEL_H < PAD.top || ly > PAD.top + plotH) continue;
        if (free(lx, ly - LABEL_H, w)) {
          taken.push([lx, ly - LABEL_H, lx + w, ly]);
          out.set(p.market.id, { x: lx, y: ly });
          break;
        }
      }
    }
    return out;
  }, [shown, plotW, plotH]);

  // The nearest dot to the pointer, if close enough.
  const onMove = (e: PointerEvent<HTMLDivElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const px = e.clientX - rect.left;
    const py = e.clientY - rect.top;
    let best: Point | undefined;
    let bestD = HOVER_REACH * HOVER_REACH;
    for (const p of shown) {
      const d = (p.x - px) ** 2 + (p.y - py) ** 2;
      if (d < bestD) {
        bestD = d;
        best = p;
      }
    }
    setHover(best?.market.id);
  };
  // The table's rows: the same markets, zones and scope as the chart.
  const rows = useMemo(() => {
    const out: Row[] = [];
    columns.forEach((market, i) => {
      const reading = values.get(market.id);
      if (!reading) return;
      const zone = rsiZone(reading.value);
      if (!zones.has(zone)) return;
      out.push({
        market,
        rank: i + 1,
        value: reading.value,
        previous: reading.previous,
        zone,
        quote: quotes?.get(market.id),
      });
    });
    return out;
  }, [columns, values, zones, quotes]);
  const hovered = hover ? shown.find((p) => p.market.id === hover) : undefined;
  const quote = hovered ? quotes?.get(hovered.market.id) : undefined;

  return (
    <div className="pd-rsi-map">
      <div className="pd-rsi-bar">
        <h2 className="pd-rsi-title">{t("rsi.title")}</h2>
        <span className="app-spacer" />
        {progress && loading && (
          <span className="pd-muted pd-rsi-progress" role="status">
            {t("rsi.loading", { done: progress.done, total: progress.total })}
          </span>
        )}
        {/* biome-ignore lint/a11y/useSemanticElements: a two-way toggle of icon buttons */}
        <div className="pd-rsi-views" role="group" aria-label={t("rsi.view")}>
          {RSI_VIEWS.map((v) => (
            <button
              key={v}
              type="button"
              aria-pressed={view === v}
              className="pd-rsi-view"
              aria-label={t(v === "chart" ? "rsi.view.chart" : "rsi.view.table")}
              title={t(v === "chart" ? "rsi.view.chart" : "rsi.view.table")}
              onClick={() => onView(v)}
            >
              {v === "chart" ? (
                <LuChartScatter size={15} aria-hidden />
              ) : (
                <LuTable size={15} aria-hidden />
              )}
            </button>
          ))}
        </div>
        <Select<RsiScope>
          label={t("rsi.scope")}
          value={scope}
          options={RSI_SCOPES.map((s) => ({
            value: s,
            label: s === "all" ? t("rsi.all") : t("rsi.top", { n: s }),
          }))}
          onChange={onScope}
        />
        <Select<RsiFrame>
          label={t("rsi.frame")}
          value={frame}
          options={RSI_FRAMES.map((f) => ({ value: f, label: t(`rsi.frame.${f}`) }))}
          onChange={onFrame}
        />
        <button
          type="button"
          className="pd-rsi-refresh"
          aria-label={t("rsi.refresh")}
          title={t("rsi.refresh")}
          data-busy={loading || undefined}
          onClick={onRefresh}
        >
          <LuRefreshCw size={15} aria-hidden />
        </button>
      </div>
      {/* biome-ignore lint/a11y/useSemanticElements: a row of toggle chips, not a form */}
      <div className="pd-rsi-legend" role="group" aria-label={t("rsi.zones")}>
        {RSI_ZONES.map((z) => (
          <button
            key={z}
            type="button"
            className="pd-rsi-chip"
            data-zone={z}
            aria-pressed={zones.has(z)}
            onClick={() =>
              setZones((s) => {
                const next = new Set(s);
                if (next.has(z)) next.delete(z);
                else next.add(z);
                return next;
              })
            }
          >
            <i className="pd-rsi-chip-swatch" aria-hidden />
            {t(ZONE_LABEL[z])}
          </button>
        ))}
      </div>
      {view === "table" && <RsiTable rows={rows} frame={frame} onTrade={onTrade} />}
      {/* biome-ignore lint/a11y/noStaticElementInteractions: hovering finds the nearest of hundreds of dots; every market is also on the Trade page's picker */}
      <div
        ref={ref}
        hidden={view === "table"}
        className="pd-rsi-stage"
        onPointerMove={onMove}
        onPointerLeave={() => setHover(undefined)}
        onClick={() => hovered && onTrade(hovered.market)}
        onKeyDown={(e) => e.key === "Enter" && hovered && onTrade(hovered.market)}
        data-pointer={hovered ? true : undefined}
        role="presentation"
      >
        {slots.length === 0 ? (
          <EmptyState>{t("feed.loading")}</EmptyState>
        ) : (
          width > 0 && (
            <svg
              className="pd-rsi-svg"
              width={width}
              height={height}
              role="img"
              aria-label={t("maps.rsi")}
            >
              {BANDS.map((b) => {
                const top = y(Math.min(b.to, RSI_MAX));
                const bottom = y(Math.max(b.from, RSI_MIN));
                return (
                  <g key={b.zone}>
                    <rect
                      className="pd-rsi-band"
                      data-zone={b.zone}
                      x={PAD.left}
                      y={top}
                      width={plotW}
                      height={bottom - top}
                    />
                    <text
                      className="pd-rsi-band-label"
                      data-zone={b.zone}
                      x={PAD.left + plotW + 12}
                      y={bandLabelY((top + bottom) / 2 + 6, top, bottom)}
                    >
                      {t(ZONE_LABEL[b.zone])}
                    </text>
                  </g>
                );
              })}
              {[10, 20, 30, 40, 50, 60, 70, 80, 90].map((v) => (
                <g key={v}>
                  <line
                    className="pd-rsi-grid"
                    x1={PAD.left}
                    x2={PAD.left + plotW}
                    y1={y(v)}
                    y2={y(v)}
                  />
                  <text className="pd-rsi-tick" x={PAD.left - 10} y={y(v) + 4}>
                    {v}
                  </text>
                </g>
              ))}
              {points.length > 0 && (
                <>
                  <line
                    className="pd-rsi-avg"
                    x1={PAD.left}
                    x2={PAD.left + plotW}
                    y1={y(average)}
                    y2={y(average)}
                  />
                  {/* The average's value, in the margin beside its line */}
                  <g transform={`translate(${PAD.left + plotW + 8}, ${y(average)})`}>
                    <rect
                      className="pd-rsi-avg-tag"
                      x={0}
                      y={-11}
                      width={PAD.right - 12}
                      height={22}
                      rx={4}
                    />
                    <text className="pd-rsi-avg-label" x={8} y={4}>
                      {t("rsi.average", { value: formatNumber(average, 2) })}
                    </text>
                  </g>
                </>
              )}
              {shown.map((p) =>
                p.previous !== undefined ? (
                  <line
                    key={`s${p.market.id}`}
                    className="pd-rsi-stem"
                    data-zone={p.zone}
                    x1={p.x}
                    x2={p.x}
                    y1={y(p.previous)}
                    y2={p.y}
                  />
                ) : null,
              )}
              {shown.map((p) => (
                <circle
                  key={p.market.id}
                  className="pd-rsi-dot"
                  data-zone={p.zone}
                  data-hover={hover === p.market.id || undefined}
                  cx={p.x}
                  cy={p.y}
                  r={hover === p.market.id ? 6 : 4.2}
                />
              ))}
              {shown.map((p) => {
                const at = labels.get(p.market.id);
                return at ? (
                  <text key={`l${p.market.id}`} className="pd-rsi-label" x={at.x} y={at.y}>
                    {p.market.base}
                  </text>
                ) : null;
              })}
            </svg>
          )
        )}
        {hovered && (
          <div
            className="pd-map-card pd-rsi-card"
            style={{
              left: hovered.x + 240 > width ? hovered.x - 234 : hovered.x + 14,
              top: Math.min(Math.max(hovered.y - 60, 8), height - 190),
            }}
            aria-hidden
          >
            <div className="pd-map-card-head">
              <TokenIcon market={hovered.market} size={18} />
              <strong>{hovered.market.symbol}</strong>
              <span className="pd-rsi-tag" data-zone={hovered.zone}>
                {t(ZONE_LABEL[hovered.zone])}
              </span>
            </div>
            <dl>
              <dt>{t("rsi.now", { frame: t(`rsi.frame.${frame}`) })}</dt>
              <dd className="pd-num">{formatNumber(hovered.value, 2)}</dd>
              {hovered.previous !== undefined && (
                <div className="pd-map-card-row">
                  <dt>{t("rsi.before")}</dt>
                  <dd className="pd-num">{formatNumber(hovered.previous, 2)}</dd>
                </div>
              )}
              {quote && (
                <div className="pd-map-card-row">
                  <dt>{t("col.price")}</dt>
                  <dd className="pd-num">{price(quote.price)}</dd>
                  <dt>24H</dt>
                  <dd className={`pd-num ${quote.change24h >= 0 ? "pd-up" : "pd-down"}`}>
                    {formatSigned(quote.change24h * 100, 2)}%
                  </dd>
                  <dt>{t("rsi.volume")}</dt>
                  <dd className="pd-num">${formatCompact(quote.volume)}</dd>
                </div>
              )}
            </dl>
            <p className="pd-rsi-card-hint">{t("rsi.clickToTrade")}</p>
          </div>
        )}
      </div>
    </div>
  );
}
