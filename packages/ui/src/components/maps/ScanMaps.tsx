import type { Market, VenueId } from "@pewterdesk/core";
import { type ReactNode, useContext, useState } from "react";
import { t } from "../../i18n";
import { formatCompact, formatNumber, formatPercent } from "../../lib/format";
import {
  type Carry,
  type Crowding,
  type Divergence,
  type EdgeCell,
  type EdgeMarket,
  type ExposureGroup,
  inRegimeFilter,
  LAG_REACH,
  type LeadLag,
  type LevelKind,
  type LevelsRead,
  type MarketReadings,
  PAIR_MIN_CORRELATION,
  type PairRow,
  passesScan,
  REGIME_FILTERS,
  type RegimeFilter,
  type RegimeKind,
  type RegimeRead,
  SCAN_DIVERGENCE,
  SCAN_FUNDING,
  SCAN_NEAR,
  SCAN_RULES,
  SCAN_STRETCH,
  SCAN_VOL,
  type ScanFilters,
  type ScanRule,
  SECTOR_PERIODS,
  type SectorPeriod,
  type SectorRow,
  type Stretch,
  VOL_RANK_SIDES,
  type VolRank,
  type VolRankSide,
} from "../../lib/mapScans";
import { BAND_FRAMES, type BandFrame } from "../../lib/mapStats";
import { StarButton } from "../common/StarButton";
import { TokenIcon } from "../trading/TokenIcon";
import {
  HistoryProgress,
  heat,
  labelsOf,
  MapFrame,
  MapState,
  ScanActionsContext,
  Seg,
  signedPct,
} from "./kit";

// The Maps page's scans, each a ranked table: what a market is doing, how far
// it has gone, who is crowded, how markets move together, and the trader's own
// results. They read; a row opens its market, and nothing here places anything.

/** Rows a table shows: past that it's noise, and slow to scroll. */
const ROW_MAX = 80;
const HOURS = Array.from({ length: 24 }, (_, h) => h);
const DAYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"] as const;

/** A market's name in a row, with its star where the page gives it one. */
function MarketName({ market, name }: { market: Market; name: string }) {
  const actions = useContext(ScanActionsContext);
  return (
    <span className="pd-mx-name">
      {actions && (
        // biome-ignore lint/a11y/noStaticElementInteractions: only stops the row's own click
        // biome-ignore lint/a11y/useKeyWithClickEvents: the star inside takes the keyboard
        <span onClick={(e) => e.stopPropagation()}>
          <StarButton
            starred={actions.starred(market)}
            name={market.symbol}
            size={13}
            onToggle={() => actions.onStar(market)}
          />
        </span>
      )}
      <TokenIcon market={market} size={16} />
      {name}
    </span>
  );
}

interface ScanProps {
  progress: { done: number; total: number };
  loader: ReactNode;
  extra?: ReactNode;
  onTrade: (market: Market) => void;
}

interface Column<R> {
  head: string;
  cell: (row: R) => ReactNode;
  /** A heat cell's value and scale. */
  heat?: (row: R) => [number | undefined, number];
}

/** A table of rows, sharing one look. The first column reads as the row's name. */
function ScanTable<R>({
  rows,
  columns,
  keyOf,
  onOpen,
}: {
  rows: readonly R[];
  columns: readonly Column<R>[];
  keyOf: (row: R) => string;
  onOpen?: (row: R) => void;
}) {
  return (
    <div className="pd-mx-scroll">
      <table className="pd-mx-table">
        <thead>
          <tr>
            {columns.map((c) => (
              <th key={c.head}>{c.head}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.slice(0, ROW_MAX).map((row) => (
            <tr
              key={keyOf(row)}
              data-still={onOpen ? undefined : true}
              onClick={onOpen && (() => onOpen(row))}
            >
              {columns.map((c) => {
                const tone = c.heat ? heat(...c.heat(row)) : undefined;
                return (
                  <td
                    key={c.head}
                    className={`pd-mx-td pd-num ${tone ? "pd-mx-cell" : ""}`}
                    {...tone}
                  >
                    {c.cell(row)}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** A scan's frame: what's loading, how many it found, and its note. */
function ScanFrame({
  title,
  note,
  count,
  controls,
  progress,
  loader,
  empty,
  markets,
  children,
}: {
  title: string;
  note: string;
  count?: number;
  /** What it found, to save as a list. */
  markets?: readonly Market[];
  controls?: ReactNode;
  progress: { done: number; total: number };
  loader: ReactNode;
  /** Nothing to show, though the data is all in. */
  empty?: string;
  children: ReactNode;
}) {
  const waiting = count === 0 && progress.total > 0 && progress.done < progress.total;
  return (
    <MapFrame
      title={title}
      markets={markets}
      controls={controls}
      legend={
        <>
          <HistoryProgress {...progress} />
          {count !== undefined && count > 0 && (
            <span className="pd-num">{t("mapx.scan.count", { count })}</span>
          )}
        </>
      }
      note={note}
      state={
        count !== 0 ? undefined : waiting || !empty ? (
          <MapState loader={loader} progress={progress} />
        ) : (
          <MapState message={empty} />
        )
      }
    >
      {children}
    </MapFrame>
  );
}

const marketCell = <R extends { market: Market }>(nameOf: (m: Market) => string) => ({
  head: t("col.market"),
  cell: (r: R) => <MarketName market={r.market} name={nameOf(r.market)} />,
});

export interface RegimeRow {
  market: Market;
  read: RegimeRead;
  change24h?: number;
}

const REGIME_TONE: Record<RegimeKind, "up" | "down" | "info" | "warn"> = {
  trendUp: "up",
  trendDown: "down",
  ranging: "info",
  choppy: "warn",
};

/** Whether each market is trending, ranging, or swinging without getting anywhere. */
export function RegimeMap({
  rows,
  filter,
  onFilter,
  progress,
  loader,
  extra,
  onTrade,
}: ScanProps & {
  rows: readonly RegimeRow[];
  filter: RegimeFilter;
  onFilter: (f: RegimeFilter) => void;
}) {
  const shown = rows
    .filter((r) => inRegimeFilter(r.read.kind, filter))
    .sort((a, b) => b.read.adx - a.read.adx);
  const nameOf = labelsOf(shown.map((r) => r.market));
  return (
    <ScanFrame
      title={t("mapx.regime.title")}
      markets={shown.map((r) => r.market)}
      note={t("mapx.regime.note")}
      count={shown.length}
      empty={t("mapx.scan.none")}
      progress={progress}
      loader={loader}
      controls={
        <>
          <Seg
            options={REGIME_FILTERS}
            value={filter}
            onChange={onFilter}
            label={t("mapx.regime.filter")}
            text={(f) => t(`mapx.regime.filter.${f}`)}
          />
          {extra}
        </>
      }
    >
      <ScanTable
        rows={shown}
        keyOf={(r) => r.market.id}
        onOpen={(r) => onTrade(r.market)}
        columns={[
          marketCell<RegimeRow>(nameOf),
          {
            head: t("mapx.regime.state"),
            cell: (r) => (
              <span className="pd-mx-tag" data-tone={REGIME_TONE[r.read.kind]}>
                {t(`mapx.regime.${r.read.kind}`)}
              </span>
            ),
          },
          { head: t("mapx.regime.adx"), cell: (r) => formatNumber(r.read.adx, 1) },
          {
            head: t("mapx.regime.efficiency"),
            cell: (r) => formatPercent(r.read.efficiency, 0),
          },
          {
            head: t("mapx.scan.change24h"),
            cell: (r) => signedPct(r.change24h),
            heat: (r) => [r.change24h, 0.1],
          },
        ]}
      />
    </ScanFrame>
  );
}

export interface LevelRow {
  market: Market;
  price: number;
  read: LevelsRead;
}

/** How close each market is to the levels traders watch, nearest first. */
export function KeyLevelsMap({
  rows,
  progress,
  loader,
  extra,
  onTrade,
}: ScanProps & { rows: readonly LevelRow[] }) {
  const shown = [...rows].sort(
    (a, b) => Math.abs(a.read.nearest.distance) - Math.abs(b.read.nearest.distance),
  );
  const nameOf = labelsOf(shown.map((r) => r.market));
  const away = (r: LevelRow, kind: LevelKind) =>
    r.read.levels.find((l) => l.kind === kind)?.distance;
  const column = (kind: LevelKind): Column<LevelRow> => ({
    head: t(`mapx.levels.${kind}`),
    cell: (r) => signedPct(away(r, kind)),
    heat: (r) => [away(r, kind), 0.1],
  });
  return (
    <ScanFrame
      title={t("mapx.levels.title")}
      markets={shown.map((r) => r.market)}
      note={t("mapx.levels.note")}
      count={shown.length}
      progress={progress}
      loader={loader}
      controls={extra}
    >
      <ScanTable
        rows={shown}
        keyOf={(r) => r.market.id}
        onOpen={(r) => onTrade(r.market)}
        columns={[
          marketCell<LevelRow>(nameOf),
          {
            head: t("mapx.levels.nearest"),
            cell: (r) => t(`mapx.levels.${r.read.nearest.kind}`),
          },
          { head: t("mapx.levels.away"), cell: (r) => signedPct(r.read.nearest.distance) },
          column("dayOpen"),
          column("weekOpen"),
          column("prevHigh"),
          column("prevLow"),
          column("weekHigh"),
          column("weekLow"),
        ]}
      />
    </ScanFrame>
  );
}

export interface DivergenceRow {
  market: Market;
  read: Divergence;
}

/** Price making a new extreme that RSI doesn't confirm. */
export function DivergenceMap({
  rows,
  frame,
  onFrame,
  progress,
  loader,
  extra,
  onTrade,
}: ScanProps & {
  rows: readonly DivergenceRow[];
  frame: BandFrame;
  onFrame: (f: BandFrame) => void;
}) {
  const shown = [...rows].sort((a, b) => a.read.barsAgo - b.read.barsAgo);
  const nameOf = labelsOf(shown.map((r) => r.market));
  return (
    <ScanFrame
      title={t("mapx.divergence.title")}
      markets={shown.map((r) => r.market)}
      note={t("mapx.divergence.note")}
      count={shown.length}
      empty={t("mapx.scan.none")}
      progress={progress}
      loader={loader}
      controls={
        <>
          <Seg
            options={BAND_FRAMES}
            value={frame}
            onChange={onFrame}
            label={t("mapx.scan.frame")}
          />
          {extra}
        </>
      }
    >
      <ScanTable
        rows={shown}
        keyOf={(r) => r.market.id}
        onOpen={(r) => onTrade(r.market)}
        columns={[
          marketCell<DivergenceRow>(nameOf),
          {
            head: t("mapx.divergence.kind"),
            cell: (r) => (
              <span className="pd-mx-tag" data-tone={r.read.kind === "bullish" ? "up" : "down"}>
                {t(`mapx.divergence.${r.read.kind}`)}
              </span>
            ),
          },
          {
            head: t("mapx.divergence.rsi"),
            cell: (r) => `${formatNumber(r.read.rsiFrom, 0)} → ${formatNumber(r.read.rsiTo, 0)}`,
          },
          { head: t("mapx.divergence.price"), cell: (r) => signedPct(r.read.priceChange) },
          { head: t("mapx.divergence.ago"), cell: (r) => r.read.barsAgo },
        ]}
      />
    </ScanFrame>
  );
}

export interface StretchRow {
  market: Market;
  read: Stretch;
}

/** How far each market has gone from where it has traded, furthest first. */
export function StretchMap({
  rows,
  progress,
  loader,
  extra,
  onTrade,
}: ScanProps & { rows: readonly StretchRow[] }) {
  const shown = [...rows].sort((a, b) => Math.abs(b.read.z) - Math.abs(a.read.z));
  const nameOf = labelsOf(shown.map((r) => r.market));
  return (
    <ScanFrame
      title={t("mapx.stretch.title")}
      markets={shown.map((r) => r.market)}
      note={t("mapx.stretch.note")}
      count={shown.length}
      progress={progress}
      loader={loader}
      controls={extra}
    >
      <ScanTable
        rows={shown}
        keyOf={(r) => r.market.id}
        onOpen={(r) => onTrade(r.market)}
        columns={[
          marketCell<StretchRow>(nameOf),
          {
            head: t("mapx.stretch.z"),
            cell: (r) => `${r.read.z > 0 ? "+" : ""}${formatNumber(r.read.z, 2)}`,
            heat: (r) => [r.read.z, 3],
          },
          { head: t("mapx.stretch.vwap"), cell: (r) => signedPct(r.read.fromVwap) },
          { head: t("mapx.stretch.ema"), cell: (r) => signedPct(r.read.fromEma) },
        ]}
      />
    </ScanFrame>
  );
}

export interface VolRankRow {
  market: Market;
  read: VolRank;
  change24h?: number;
}

/** Each market's volatility against its own history: the quietest, or the wildest. */
export function VolRankMap({
  rows,
  side,
  onSide,
  progress,
  loader,
  extra,
  onTrade,
}: ScanProps & {
  rows: readonly VolRankRow[];
  side: VolRankSide;
  onSide: (s: VolRankSide) => void;
}) {
  const shown = [...rows].sort((a, b) =>
    side === "quiet" ? a.read.rank - b.read.rank : b.read.rank - a.read.rank,
  );
  const nameOf = labelsOf(shown.map((r) => r.market));
  return (
    <ScanFrame
      title={t("mapx.volRank.title")}
      markets={shown.map((r) => r.market)}
      note={t("mapx.volRank.note")}
      count={shown.length}
      progress={progress}
      loader={loader}
      controls={
        <>
          <Seg
            options={VOL_RANK_SIDES}
            value={side}
            onChange={onSide}
            label={t("mapx.volRank.side")}
            text={(s) => t(`mapx.volRank.${s}`)}
          />
          {extra}
        </>
      }
    >
      <ScanTable
        rows={shown}
        keyOf={(r) => r.market.id}
        onOpen={(r) => onTrade(r.market)}
        columns={[
          marketCell<VolRankRow>(nameOf),
          {
            head: t("mapx.volRank.rank"),
            cell: (r) => formatPercent(r.read.rank, 0),
            heat: (r) => [r.read.rank - 0.5, 0.5],
          },
          { head: t("mapx.volRank.atr"), cell: (r) => formatPercent(r.read.atr) },
          {
            head: t("mapx.scan.change24h"),
            cell: (r) => signedPct(r.change24h),
            heat: (r) => [r.change24h, 0.1],
          },
        ]}
      />
    </ScanFrame>
  );
}

export interface CrowdRow {
  market: Market;
  read: Crowding;
  oiChange?: number;
  priceChange?: number;
}

/** Markets where one side is paying up, still adding, and not being rewarded. */
export function CrowdedMap({
  rows,
  progress,
  loader,
  extra,
  onTrade,
}: ScanProps & { rows: readonly CrowdRow[] }) {
  const shown = [...rows].sort((a, b) => b.read.score - a.read.score);
  const nameOf = labelsOf(shown.map((r) => r.market));
  return (
    <ScanFrame
      title={t("mapx.crowded.title")}
      markets={shown.map((r) => r.market)}
      note={t("mapx.crowded.note")}
      count={shown.length}
      progress={progress}
      loader={loader}
      controls={extra}
    >
      <ScanTable
        rows={shown}
        keyOf={(r) => r.market.id}
        onOpen={(r) => onTrade(r.market)}
        columns={[
          marketCell<CrowdRow>(nameOf),
          {
            head: t("mapx.crowded.score"),
            cell: (r) => r.read.score,
            heat: (r) => [r.read.score, 100],
          },
          {
            head: t("mapx.crowded.side"),
            cell: (r) => t(`mapx.crowded.${r.read.side}`),
          },
          { head: t("mapx.crowded.funding"), cell: (r) => signedPct(r.read.apr, 1) },
          { head: t("mapx.crowded.oi"), cell: (r) => signedPct(r.oiChange) },
          { head: t("mapx.scan.change24h"), cell: (r) => signedPct(r.priceChange) },
        ]}
      />
    </ScanFrame>
  );
}

/** Long one venue and short another, for the funding between them. */
export function CarryMap({
  rows,
  labelOf,
  iconFor,
  loading,
  loader,
  onTrade,
}: {
  rows: readonly Carry[];
  labelOf: (venue: VenueId) => string;
  iconFor: (base: string) => Market | undefined;
  loading: boolean;
  loader: ReactNode;
  onTrade: (base: string) => void;
}) {
  const shown = [...rows].sort((a, b) => b.apr - a.apr);
  return (
    <ScanFrame
      title={t("mapx.carry.title")}
      markets={shown.flatMap((r) => iconFor(r.base) ?? [])}
      note={t("mapx.carry.note")}
      count={shown.length}
      empty={loading ? undefined : t("mapx.scan.none")}
      progress={{ done: 0, total: 0 }}
      loader={loader}
    >
      <ScanTable
        rows={shown}
        keyOf={(r) => r.base}
        onOpen={(r) => onTrade(r.base)}
        columns={[
          {
            head: t("mapx.coin"),
            cell: (r) => (
              <span className="pd-mx-name">
                <TokenIcon market={iconFor(r.base)} size={16} />
                {r.base}
              </span>
            ),
          },
          { head: t("mapx.carry.long"), cell: (r) => labelOf(r.longVenue) },
          { head: t("mapx.carry.short"), cell: (r) => labelOf(r.shortVenue) },
          {
            head: t("mapx.carry.apr"),
            cell: (r) => formatPercent(r.apr, 1),
            heat: (r) => [r.apr, 1],
          },
          {
            head: t("mapx.carry.breakEven"),
            cell: (r) => t("mapx.carry.days", { days: formatNumber(r.breakEvenDays, 1) }),
          },
          { head: t("mapx.carry.gap"), cell: (r) => signedPct(r.priceGap, 3) },
          { head: t("mapx.carry.volume"), cell: (r) => formatCompact(r.volume) },
        ]}
      />
    </ScanFrame>
  );
}

/** Markets that move together, and how stretched each pair is now. */
export function PairsMap({
  rows,
  progress,
  loader,
  extra,
  onTrade,
}: ScanProps & { rows: readonly PairRow<Market>[] }) {
  // Each market once: it's in many pairs, and that isn't two markets sharing a coin.
  const nameOf = labelsOf([...new Set(rows.flatMap((r) => [r.a, r.b]))]);
  return (
    <ScanFrame
      title={t("mapx.pairs.title")}
      markets={rows.flatMap((r) => [r.a, r.b])}
      note={t("mapx.pairs.note", { min: formatNumber(PAIR_MIN_CORRELATION, 1) })}
      count={rows.length}
      empty={t("mapx.scan.none")}
      progress={progress}
      loader={loader}
      controls={extra}
    >
      <ScanTable
        rows={rows}
        keyOf={(r) => `${r.a.id}/${r.b.id}`}
        onOpen={(r) => onTrade(r.z >= 0 ? r.a : r.b)}
        columns={[
          {
            head: t("mapx.pairs.pair"),
            cell: (r) => (
              <span className="pd-mx-name">
                <TokenIcon market={r.a} size={16} />
                {nameOf(r.a)} / {nameOf(r.b)}
              </span>
            ),
          },
          {
            head: t("mapx.stretch.z"),
            cell: (r) => `${r.z > 0 ? "+" : ""}${formatNumber(r.z, 2)}`,
            heat: (r) => [r.z, 3],
          },
          { head: t("mapx.pairs.corr"), cell: (r) => formatNumber(r.correlation, 2) },
          { head: t("mapx.scan.change24h"), cell: (r) => signedPct(r.change24h) },
          {
            head: t("mapx.pairs.read"),
            cell: (r) => t("mapx.pairs.rich", { name: nameOf(r.z >= 0 ? r.a : r.b) }),
          },
        ]}
      />
    </ScanFrame>
  );
}

export interface LagRow {
  market: Market;
  read: LeadLag;
}

/** Which markets tend to move before BTC, and which after. */
export function LeadLagMap({
  rows,
  progress,
  loader,
  extra,
  onTrade,
}: ScanProps & { rows: readonly LagRow[] }) {
  const shown = [...rows].sort(
    (a, b) => a.read.lag - b.read.lag || b.read.correlation - a.read.correlation,
  );
  const nameOf = labelsOf(shown.map((r) => r.market));
  return (
    <ScanFrame
      title={t("mapx.lag.title")}
      markets={shown.map((r) => r.market)}
      note={t("mapx.lag.note", { hours: LAG_REACH })}
      count={shown.length}
      progress={progress}
      loader={loader}
      controls={extra}
    >
      <ScanTable
        rows={shown}
        keyOf={(r) => r.market.id}
        onOpen={(r) => onTrade(r.market)}
        columns={[
          marketCell<LagRow>(nameOf),
          {
            head: t("mapx.lag.when"),
            cell: (r) =>
              r.read.lag === 0
                ? t("mapx.lag.together")
                : t(r.read.lag < 0 ? "mapx.lag.leads" : "mapx.lag.follows", {
                    hours: Math.abs(r.read.lag),
                  }),
          },
          { head: t("mapx.lag.fit"), cell: (r) => formatNumber(r.read.correlation, 2) },
          { head: t("mapx.lag.same"), cell: (r) => formatNumber(r.read.together, 2) },
        ]}
      />
    </ScanFrame>
  );
}

/** Where the money is going: each sector's move, strongest first. */
export function SectorRotationMap<S extends string>({
  rows,
  period,
  onPeriod,
  labelOf,
  progress,
  loader,
  error,
}: {
  rows: readonly SectorRow<S>[];
  period: SectorPeriod;
  onPeriod: (p: SectorPeriod) => void;
  labelOf: (sector: S) => string;
  progress: { done: number; total: number };
  loader: ReactNode;
  error?: string;
}) {
  const column = (p: SectorPeriod): Column<SectorRow<S>> => ({
    head: p.toUpperCase(),
    cell: (r) => signedPct(r.changes[p]),
    heat: (r) => [r.changes[p], p === "1h" ? 0.02 : p === "24h" ? 0.08 : 0.2],
  });
  return (
    <MapFrame
      title={t("mapx.sectors.title")}
      note={t("mapx.sectors.note")}
      legend={<HistoryProgress {...progress} />}
      controls={
        <Seg options={SECTOR_PERIODS} value={period} onChange={onPeriod} label={t("mapx.window")} />
      }
      state={
        rows.length === 0 ? (
          <MapState loader={loader} progress={progress} error={error} />
        ) : undefined
      }
    >
      <ScanTable
        rows={rows}
        keyOf={(r) => r.sector}
        columns={[
          { head: t("mapx.sectors.sector"), cell: (r) => labelOf(r.sector) },
          column("1h"),
          column("24h"),
          column("7d"),
          { head: t("mapx.sectors.up"), cell: (r) => formatPercent(r.upShare, 0) },
          {
            head: t("mapx.sectors.best"),
            cell: (r) => r.best && `${r.best.symbol} ${signedPct(r.best.change, 1)}`,
          },
          {
            head: t("mapx.sectors.worst"),
            cell: (r) => r.worst && `${r.worst.symbol} ${signedPct(r.worst.change, 1)}`,
          },
        ]}
      />
    </MapFrame>
  );
}

/** A trader's closed P&L by weekday and hour, and by market. */
export function EdgeMap({
  grid,
  markets,
  total,
  nameOf,
  connected,
  loading,
  error,
  loader,
}: {
  grid: readonly (readonly EdgeCell[])[];
  markets: readonly EdgeMarket[];
  total: number;
  nameOf: (id: string) => string;
  connected: boolean;
  loading: boolean;
  error?: string;
  loader: ReactNode;
}) {
  const [hover, setHover] = useState<{ day: number; hour: number }>();
  const scale = Math.max(...grid.flat().map((c) => Math.abs(c.pnl)), 0);
  const tip = hover && grid[hover.day]?.[hover.hour];
  const none = !connected
    ? t("mapx.mine.connect")
    : markets.length === 0 && !loading
      ? t("mapx.edge.none")
      : undefined;
  return (
    <MapFrame
      title={t("mapx.edge.title")}
      note={t("mapx.edge.note")}
      legend={
        tip && hover && tip.trades > 0 ? (
          <span className="pd-num">
            {t("mapx.edge.cell", {
              day: t(`mapx.day.${DAYS[hover.day] ?? "mon"}`),
              hour: String(hover.hour).padStart(2, "0"),
              pnl: formatNumber(tip.pnl, 2),
              count: tip.trades,
            })}
          </span>
        ) : (
          markets.length > 0 && (
            <span className="pd-num">{t("mapx.edge.total", { pnl: formatNumber(total, 2) })}</span>
          )
        )
      }
      state={
        error || none || loading ? (
          <MapState loader={loader} error={error} message={none} />
        ) : undefined
      }
      side={
        markets.length > 0 && (
          <ScanTable
            rows={markets}
            keyOf={(m) => m.market}
            columns={[
              { head: t("col.market"), cell: (m) => nameOf(m.market) },
              { head: t("mapx.edge.trades"), cell: (m) => m.trades },
              {
                head: t("mapx.edge.wins"),
                cell: (m) => formatPercent(m.wins / m.trades, 0),
              },
              {
                head: t("mapx.edge.pnl"),
                cell: (m) => formatNumber(m.pnl, 2),
                heat: (m) => [m.pnl, Math.max(...markets.map((x) => Math.abs(x.pnl)), 1)],
              },
            ]}
          />
        )
      }
    >
      <div className="pd-mx-scroll">
        <div className="pd-mx-season" onPointerLeave={() => setHover(undefined)}>
          <span />
          {HOURS.map((h) => (
            <span key={h} className="pd-mx-season-hour pd-num">
              {h % 3 === 0 ? String(h).padStart(2, "0") : ""}
            </span>
          ))}
          {DAYS.map((d, day) => (
            <div key={d} className="pd-mx-season-row">
              <span className="pd-mx-season-day">{t(`mapx.day.${d}`)}</span>
              {HOURS.map((h) => {
                const c = grid[day]?.[h];
                const tone = heat(c && c.trades > 0 ? c.pnl : undefined, scale);
                return (
                  <span
                    key={h}
                    className="pd-mx-season-cell"
                    data-heat={tone["data-heat"]}
                    style={tone.style}
                    onPointerEnter={() => setHover({ day, hour: h })}
                  />
                );
              })}
            </div>
          ))}
        </div>
      </div>
    </MapFrame>
  );
}

/** Open positions gathered into the bets they really are. */
export function ExposureMap({
  groups,
  connected,
  loader,
  progress,
  onTrade,
}: {
  groups: readonly ExposureGroup<Market>[];
  connected: boolean;
  loader: ReactNode;
  progress: { done: number; total: number };
  onTrade: (market: Market) => void;
}) {
  const none = !connected ? t("mapx.mine.connect") : t("mapx.exposure.none");
  return (
    <MapFrame
      title={t("mapx.exposure.title")}
      markets={groups.flatMap((g) => g.members.map((m) => m.market))}
      note={t("mapx.exposure.note")}
      legend={<HistoryProgress {...progress} />}
      state={groups.length === 0 ? <MapState message={none} loader={loader} /> : undefined}
    >
      <ScanTable
        rows={groups}
        keyOf={(g) => g.members.map((m) => m.market.id).join(",")}
        onOpen={(g) => {
          const first = g.members[0];
          if (first) onTrade(first.market);
        }}
        columns={[
          {
            head: t("mapx.exposure.bet"),
            cell: (g) => (
              <span className="pd-mx-name">
                {g.members.map((m) => (
                  <span key={m.market.id} className="pd-mx-exposure" data-side={m.side}>
                    <TokenIcon market={m.market} size={16} />
                    {m.market.base}
                  </span>
                ))}
              </span>
            ),
          },
          { head: t("mapx.exposure.value"), cell: (g) => formatCompact(g.value) },
          {
            head: t("mapx.exposure.share"),
            cell: (g) => formatPercent(g.share, 0),
            heat: (g) => [g.members.length > 1 ? g.share : 0, 1],
          },
          {
            head: t("mapx.exposure.tie"),
            cell: (g) => (g.correlation === undefined ? "-" : formatNumber(g.correlation, 2)),
          },
        ]}
      />
    </MapFrame>
  );
}

export interface ScannerRow {
  market: Market;
  read: MarketReadings;
}

/** Scan alerts, for the page to show beside the scanner. */
export interface ScanAlertsPanel {
  /** Whether the rule is on for the venue's starred markets. */
  starred: (rule: ScanRule) => boolean;
  onStarred: (rule: ScanRule) => void;
  /** The market alerts: a label and how to take each off. */
  items: readonly { id: string; label: string; onRemove: () => void }[];
}

const FILTER_OPTIONS = {
  near: SCAN_NEAR,
  stretch: SCAN_STRETCH,
  vol: SCAN_VOL,
  divergence: SCAN_DIVERGENCE,
  funding: SCAN_FUNDING,
} as const;

const anyOr = (option: string, text: () => string) =>
  option === "any" ? t("mapx.scanner.any") : text();

/** Every market's readings in one table, cut down by the conditions picked. */
export function ScannerMap({
  rows,
  filters,
  onFilters,
  alerts,
  progress,
  loader,
  extra,
  onTrade,
}: ScanProps & {
  rows: readonly ScannerRow[];
  filters: ScanFilters;
  onFilters: (change: Partial<ScanFilters>) => void;
  alerts: ScanAlertsPanel;
}) {
  const shown = rows
    .filter((r) => passesScan(r.read, filters))
    .sort((a, b) => (b.read.regime?.adx ?? 0) - (a.read.regime?.adx ?? 0));
  const nameOf = labelsOf(shown.map((r) => r.market));
  const waiting = rows.length === 0;
  return (
    <MapFrame
      title={t("mapx.scanner.title")}
      markets={shown.map((r) => r.market)}
      note={t("mapx.scanner.note")}
      controls={extra}
      legend={
        <>
          <HistoryProgress {...progress} />
          <span className="pd-num">{t("mapx.scan.count", { count: shown.length })}</span>
        </>
      }
      state={waiting ? <MapState loader={loader} progress={progress} /> : undefined}
      side={
        <div className="pd-mx-alerts">
          <h3>{t("mapx.alerts.title")}</h3>
          <p>{t("mapx.alerts.note")}</p>
          <span className="pd-muted">{t("mapx.alerts.starred")}</span>
          {SCAN_RULES.map((rule) => (
            <button
              key={rule}
              type="button"
              aria-pressed={alerts.starred(rule)}
              onClick={() => alerts.onStarred(rule)}
            >
              {t(`mapx.alert.rule.${rule}`)}
            </button>
          ))}
          {alerts.items.length === 0 ? (
            <p>{t("mapx.alerts.none")}</p>
          ) : (
            <ul>
              {alerts.items.map((item) => (
                <li key={item.id}>
                  <span>{item.label}</span>
                  <button
                    type="button"
                    aria-label={t("mapx.alerts.remove")}
                    title={t("mapx.alerts.remove")}
                    onClick={item.onRemove}
                  >
                    ×
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      }
    >
      <div className="pd-mx-filters">
        <span className="pd-mx-filter">
          {t("mapx.scanner.regime")}
          <Seg
            options={REGIME_FILTERS}
            value={filters.regime}
            onChange={(regime) => onFilters({ regime })}
            label={t("mapx.scanner.regime")}
            text={(f) => t(`mapx.regime.filter.${f}`)}
          />
        </span>
        <span className="pd-mx-filter">
          {t("mapx.scanner.near")}
          <Seg
            options={FILTER_OPTIONS.near}
            value={filters.near}
            onChange={(near) => onFilters({ near })}
            label={t("mapx.scanner.near")}
            text={(o) => anyOr(o, () => `${o}%`)}
          />
        </span>
        <span className="pd-mx-filter">
          {t("mapx.scanner.stretch")}
          <Seg
            options={FILTER_OPTIONS.stretch}
            value={filters.stretch}
            onChange={(stretch) => onFilters({ stretch })}
            label={t("mapx.scanner.stretch")}
            text={(o) => anyOr(o, () => `${o}σ`)}
          />
        </span>
        <span className="pd-mx-filter">
          {t("mapx.scanner.vol")}
          <Seg
            options={FILTER_OPTIONS.vol}
            value={filters.vol}
            onChange={(vol) => onFilters({ vol })}
            label={t("mapx.scanner.vol")}
            text={(o) => (o === "any" ? t("mapx.scanner.any") : t(`mapx.volRank.${o}`))}
          />
        </span>
        <span className="pd-mx-filter">
          {t("mapx.scanner.div")}
          <Seg
            options={FILTER_OPTIONS.divergence}
            value={filters.divergence}
            onChange={(divergence) => onFilters({ divergence })}
            label={t("mapx.scanner.div")}
            text={(o) => (o === "any" ? t("mapx.scanner.any") : t(`mapx.divergence.${o}`))}
          />
        </span>
        <span className="pd-mx-filter">
          {t("mapx.scanner.funding")}
          <Seg
            options={FILTER_OPTIONS.funding}
            value={filters.funding}
            onChange={(funding) => onFilters({ funding })}
            label={t("mapx.scanner.funding")}
            text={(o) => (o === "any" ? t("mapx.scanner.any") : t(`mapx.scanner.${o}`))}
          />
        </span>
      </div>
      {shown.length === 0 ? (
        <MapState message={t("mapx.scan.none")} />
      ) : (
        <ScanTable
          rows={shown}
          keyOf={(r) => r.market.id}
          onOpen={(r) => onTrade(r.market)}
          columns={[
            marketCell<ScannerRow>(nameOf),
            {
              head: t("mapx.regime.state"),
              cell: (r) =>
                r.read.regime && (
                  <span className="pd-mx-tag" data-tone={REGIME_TONE[r.read.regime.kind]}>
                    {t(`mapx.regime.${r.read.regime.kind}`)}
                  </span>
                ),
            },
            {
              head: t("mapx.scanner.level"),
              cell: (r) =>
                r.read.levels &&
                `${t(`mapx.levels.${r.read.levels.nearest.kind}`)} ${signedPct(
                  r.read.levels.nearest.distance,
                )}`,
            },
            {
              head: t("mapx.stretch.z"),
              cell: (r) => (r.read.stretch ? formatNumber(r.read.stretch.z, 2) : "-"),
              heat: (r) => [r.read.stretch?.z, 3],
            },
            {
              head: t("mapx.volRank.rank"),
              cell: (r) => (r.read.vol ? formatPercent(r.read.vol.rank, 0) : "-"),
            },
            {
              head: t("mapx.scanner.div"),
              cell: (r) =>
                r.read.divergence ? t(`mapx.divergence.${r.read.divergence.kind}`) : "-",
            },
            { head: t("mapx.scanner.funding"), cell: (r) => signedPct(r.read.fundingApr, 1) },
            {
              head: t("mapx.scan.change24h"),
              cell: (r) => signedPct(r.read.change24h),
              heat: (r) => [r.read.change24h, 0.1],
            },
          ]}
        />
      )}
    </MapFrame>
  );
}
