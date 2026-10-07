import type { Market } from "@pewterdesk/core";
import { type HierarchyRectangularNode, hierarchy, treemap, treemapSquarify } from "d3-hierarchy";
import { type CSSProperties, type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { LuSearch } from "react-icons/lu";
import { type MessageKey, t } from "../../i18n";
import { formatCompact, formatSigned } from "../../lib/format";
import { Select } from "../common/Select";
import { EmptyState } from "../common/Status";
import { TokenIcon } from "../trading/TokenIcon";

export const HEAT_SECTORS = [
  "layer1",
  "smartContracts",
  "ethereum",
  "proofOfWork",
  "defi",
  "memes",
  "solana",
  "ai",
  "layer2",
  "realWorldAssets",
] as const;
export type HeatSector = (typeof HEAT_SECTORS)[number];
export type HeatIndex = "marketCap" | "volume";
export const HEAT_INDEXES: readonly HeatIndex[] = ["marketCap", "volume"];
export type HeatPeriod = "1h" | "24h" | "7d";
export const HEAT_PERIODS: readonly HeatPeriod[] = ["1h", "24h", "7d"];
export type HeatTop = "10" | "20" | "50";
export const HEAT_TOPS: readonly HeatTop[] = ["10", "20", "50"];

/** One coin as the heatmap takes it; figures in USD, changes as fractions. */
export interface HeatCoin {
  symbol: string;
  name: string;
  marketCap: number;
  price: number;
  volume: number;
  change1h?: number | null;
  change24h?: number | null;
  change7d?: number | null;
}
export interface HeatGroup {
  sector: HeatSector;
  coins: readonly HeatCoin[];
}

const SECTOR_LABEL: Record<HeatSector, MessageKey> = {
  layer1: "heat.sector.layer1",
  smartContracts: "heat.sector.smartContracts",
  ethereum: "heat.sector.ethereum",
  proofOfWork: "heat.sector.proofOfWork",
  defi: "heat.sector.defi",
  memes: "heat.sector.memes",
  solana: "heat.sector.solana",
  ai: "heat.sector.ai",
  layer2: "heat.sector.layer2",
  realWorldAssets: "heat.sector.realWorldAssets",
};
const PERIOD_LABEL: Record<HeatPeriod, MessageKey> = {
  "1h": "heat.period.1h",
  "24h": "heat.period.24h",
  "7d": "heat.period.7d",
};
/** The move at which a tile's colour is at full strength, per period. */
const FULL_AT: Record<HeatPeriod, number> = { "1h": 0.02, "24h": 0.06, "7d": 0.15 };
/** The legend's steps, strongest fall to strongest rise. */
const LEGEND = [-1, -0.6, -0.25, 0, 0.25, 0.6, 1];
/** A sector's block of tiles: its height, the gap between blocks, and the width that fits two a row. */
const BLOCK_H = 340;
const BLOCK_GAP = 14;
const TWO_COLUMNS_AT = 860;
/** Rows in the hover table. */
const TABLE_ROWS = 10;

const changeOf = (coin: HeatCoin, period: HeatPeriod) =>
  (period === "1h" ? coin.change1h : period === "24h" ? coin.change24h : coin.change7d) ??
  undefined;

/** A tile's colour for a move of `k` (-1 to 1 of full strength): red to green through grey. */
function toneFor(k: number | undefined): CSSProperties {
  if (k === undefined || k === 0)
    return { "--heat-tone": "var(--pd-pewter)", "--heat-mix": "22%" } as CSSProperties;
  return {
    "--heat-tone": k > 0 ? "var(--pd-buy)" : "var(--pd-sell)",
    "--heat-mix": `${Math.round(24 + Math.min(Math.abs(k), 1) * 56)}%`,
  } as CSSProperties;
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

interface Tile {
  sector: HeatSector;
  coin: HeatCoin;
}
type TreeNode = { children: TreeNode[] } | { sector: HeatSector; children: TreeNode[] } | Tile;

/** A sector on the page: its tiles, or none while its coins are still loading. */
interface Block {
  sector: HeatSector;
  total: number;
  leaves?: HierarchyRectangularNode<TreeNode>[];
}

interface MarketHeatmapProps {
  /** Sectors loaded so far, each with its coins, largest first. */
  groups: readonly HeatGroup[];
  index: HeatIndex;
  onIndex: (index: HeatIndex) => void;
  colourBy: HeatPeriod;
  onColourBy: (period: HeatPeriod) => void;
  top: HeatTop;
  onTop: (top: HeatTop) => void;
  /** Tickers left off the map. */
  excluded: ReadonlySet<string>;
  onExcluded: (excluded: Set<string>) => void;
  /** Sectors read so far, while more are loading. */
  progress?: { done: number; total: number };
  /** Shown in a sector's block while its coins load, e.g. the app's loading mark. */
  loader?: ReactNode;
  error?: string;
  /** The venue's market for a ticker, if it lists one: its tile opens it. */
  marketFor: (symbol: string) => Market | undefined;
  onTrade: (market: Market) => void;
}

/**
 * The market as a heatmap, after coinglass's market cap heatmap: coins
 * grouped by sector (a coin sits in each sector it belongs to), each tile
 * sized by market cap or 24h volume and coloured by its price change, red
 * to green. Hover a tile for its sector's table; click one the venue lists
 * to trade it. Coins can be left off (BTC and ETH dwarf the rest).
 */
export function MarketHeatmap({
  groups,
  index,
  onIndex,
  colourBy,
  onColourBy,
  top,
  onTop,
  excluded,
  onExcluded,
  progress,
  loader,
  error,
  marketFor,
  onTrade,
}: MarketHeatmapProps) {
  const [ref, { width, height }] = useSize<HTMLDivElement>();
  // Sectors are still arriving (or none has yet): the missing ones show as loading.
  const waiting = !error && (!progress || progress.done < progress.total);
  const [hover, setHover] = useState<{
    sector: HeatSector;
    symbol: string;
    x: number;
    y: number;
  }>();
  const [picking, setPicking] = useState(false);
  const [query, setQuery] = useState("");
  const pickerRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!picking) return;
    const close = (e: PointerEvent) => {
      if (!pickerRef.current?.contains(e.target as Node)) setPicking(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setPicking(false);
    document.addEventListener("pointerdown", close);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", close);
      document.removeEventListener("keydown", onKey);
    };
  }, [picking]);

  const shown = useMemo(
    () =>
      groups
        .map((g) => ({
          sector: g.sector,
          coins: [...g.coins]
            .filter((c) => !excluded.has(c.symbol) && c[index] > 0)
            .sort((a, b) => b[index] - a[index])
            .slice(0, Number(top)),
        }))
        .filter((g) => g.coins.length > 0),
    [groups, excluded, index, top],
  );
  // Each sector is its own block, two to a row where there's room, so
  // every one has space for its name and its coins; the page scrolls.
  const columns = width >= TWO_COLUMNS_AT ? 2 : 1;
  const blockW = Math.max(Math.floor((width - (columns - 1) * BLOCK_GAP) / columns), 1);
  // In a fixed order, so a sector arriving doesn't move the others; one
  // still to arrive holds its place with the loading mark.
  const blocks = useMemo(() => {
    if (width === 0) return [];
    const loaded = new Set(groups.map((g) => g.sector));
    const filled = new Map(
      shown.map((g) => {
        const root = hierarchy<TreeNode>(
          { children: g.coins.map((coin) => ({ sector: g.sector, coin })) },
          (d) => ("children" in d ? d.children : undefined),
        ).sum((d) => ("coin" in d ? d.coin[index] : 0));
        const block: Block = {
          sector: g.sector,
          total: g.coins.reduce((sum, c) => sum + c[index], 0),
          leaves: treemap<TreeNode>()
            .tile(treemapSquarify.ratio(1.3))
            .size([blockW, BLOCK_H])
            .paddingInner(1)
            .round(true)(root)
            .leaves(),
        };
        return [g.sector, block] as const;
      }),
    );
    const out: Block[] = [];
    for (const sector of HEAT_SECTORS) {
      const block = filled.get(sector);
      if (block) out.push(block);
      // Not loaded yet: it waits in place. Loaded with every coin excluded: left out.
      else if (waiting && !loaded.has(sector)) out.push({ sector, total: 0 });
    }
    return out;
  }, [shown, groups, waiting, index, width, blockW]);

  // Every coin once, largest first, for the exclude list.
  const allCoins = useMemo(() => {
    const seen = new Map<string, HeatCoin>();
    for (const g of groups) for (const c of g.coins) if (!seen.has(c.symbol)) seen.set(c.symbol, c);
    return [...seen.values()].sort((a, b) => b.marketCap - a.marketCap);
  }, [groups]);
  const needle = query.trim().toLowerCase();
  const listed = allCoins.filter(
    (c) =>
      !needle || c.symbol.toLowerCase().includes(needle) || c.name.toLowerCase().includes(needle),
  );

  const hoverGroup = hover ? shown.find((g) => g.sector === hover.sector) : undefined;
  const hoverRows = (() => {
    if (!hover || !hoverGroup) return [];
    const rows = hoverGroup.coins.slice(0, TABLE_ROWS);
    const at = hoverGroup.coins.find((c) => c.symbol === hover.symbol);
    return at && !rows.includes(at) ? [...rows.slice(0, TABLE_ROWS - 1), at] : rows;
  })();
  const indexLabel = t(index === "marketCap" ? "heat.marketCap" : "heat.volume");

  return (
    <div className="pd-mheat">
      <div className="pd-mheat-bar">
        <div className="pd-mheat-field">
          <span>{t("heat.index")}</span>
          <Select<HeatIndex>
            label={t("heat.index")}
            value={index}
            options={HEAT_INDEXES.map((i) => ({
              value: i,
              label: t(i === "marketCap" ? "heat.marketCap" : "heat.volume"),
            }))}
            onChange={onIndex}
          />
        </div>
        <div className="pd-mheat-field">
          <span>{t("heat.colourBy")}</span>
          <Select<HeatPeriod>
            label={t("heat.colourBy")}
            value={colourBy}
            options={HEAT_PERIODS.map((p) => ({ value: p, label: t(PERIOD_LABEL[p]) }))}
            onChange={onColourBy}
          />
        </div>
        <div className="pd-mheat-field">
          <span>{t("heat.showTop")}</span>
          <Select<HeatTop>
            label={t("heat.showTop")}
            value={top}
            options={HEAT_TOPS.map((n) => ({ value: n, label: n }))}
            onChange={onTop}
          />
        </div>
        <div className="pd-mheat-field" ref={pickerRef}>
          <span>{t("heat.exclude")}</span>
          <button
            type="button"
            className="pd-mheat-exclude"
            aria-expanded={picking}
            onClick={() => setPicking((p) => !p)}
          >
            {excluded.size > 0 ? t("heat.excluded", { n: excluded.size }) : t("heat.exclude")}
          </button>
          {picking && (
            <div className="pd-mheat-picker">
              <label className="pd-search pd-mheat-picker-search">
                <LuSearch size={14} aria-hidden />
                <input
                  type="search"
                  placeholder={t("markets.search")}
                  aria-label={t("markets.search")}
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                />
              </label>
              <div className="pd-mheat-picker-list">
                {listed.slice(0, 200).map((c) => (
                  <label key={c.symbol} className="pd-mheat-picker-row">
                    <input
                      type="checkbox"
                      className="pd-mheat-picker-check"
                      checked={excluded.has(c.symbol)}
                      onChange={(e) => {
                        const next = new Set(excluded);
                        if (e.target.checked) next.add(c.symbol);
                        else next.delete(c.symbol);
                        onExcluded(next);
                      }}
                    />
                    <strong>{c.symbol}</strong>
                    <span className="pd-muted">{c.name}</span>
                  </label>
                ))}
              </div>
              {excluded.size > 0 && (
                <button
                  type="button"
                  className="pd-mheat-clear"
                  onClick={() => onExcluded(new Set())}
                >
                  {t("heat.clear")}
                </button>
              )}
            </div>
          )}
        </div>
        <span className="app-spacer" />
        {progress && progress.done < progress.total && (
          <span className="pd-muted pd-mheat-progress" role="status">
            {t("heat.loading", { done: progress.done, total: progress.total })}
          </span>
        )}
        <span className="pd-mheat-legend" aria-hidden>
          {LEGEND.map((k) => (
            <i key={k} className="pd-mheat-swatch" style={toneFor(k)} />
          ))}
        </span>
      </div>

      <div ref={ref} className="pd-mheat-stage" onPointerLeave={() => setHover(undefined)}>
        {error && shown.length === 0 ? (
          <EmptyState>{error}</EmptyState>
        ) : blocks.length === 0 ? (
          <EmptyState>{t("feed.loading")}</EmptyState>
        ) : (
          <div
            className="pd-mheat-grid"
            style={{ gridTemplateColumns: `repeat(${columns}, ${blockW}px)`, gap: BLOCK_GAP }}
          >
            {blocks.map((block) => (
              <section key={block.sector} className="pd-mheat-block">
                <h3 className="pd-mheat-sector">
                  {t(SECTOR_LABEL[block.sector])}
                  {block.leaves && (
                    <span className="pd-mheat-sector-total pd-num">
                      ${formatCompact(block.total)}
                    </span>
                  )}
                </h3>
                <div
                  className="pd-mheat-tiles"
                  style={{ height: BLOCK_H }}
                  data-loading={!block.leaves || undefined}
                  // Off the tiles (a heading, the gap to the next sector): no card.
                  onPointerLeave={() => setHover(undefined)}
                >
                  {!block.leaves && (
                    <span role="status" aria-label={t("feed.loading")}>
                      {loader}
                    </span>
                  )}
                  {block.leaves?.map((leaf) => {
                    const { sector, coin } = leaf.data as Tile;
                    const w = leaf.x1 - leaf.x0;
                    const h = leaf.y1 - leaf.y0;
                    const change = changeOf(coin, colourBy);
                    const market = marketFor(coin.symbol);
                    const size = Math.min(Math.max(Math.sqrt(w * h) / 5.5, 9), 56);
                    return (
                      <button
                        key={coin.symbol}
                        type="button"
                        className="pd-mheat-tile"
                        data-hover={
                          (hover?.sector === sector && hover.symbol === coin.symbol) || undefined
                        }
                        data-tradable={market ? true : undefined}
                        aria-label={`${coin.symbol} ${indexLabel} $${formatCompact(coin[index])}${
                          change === undefined ? "" : `, ${formatSigned(change * 100, 2)}%`
                        }`}
                        style={{
                          left: leaf.x0,
                          top: leaf.y0,
                          width: w,
                          height: h,
                          fontSize: size,
                          ...toneFor(change === undefined ? undefined : change / FULL_AT[colourBy]),
                        }}
                        onPointerMove={(e) => {
                          // Where the pointer is in the scrolling stage's own content.
                          const stage = ref.current;
                          const box = stage?.getBoundingClientRect();
                          setHover({
                            sector,
                            symbol: coin.symbol,
                            x: e.clientX - (box?.left ?? 0) + (stage?.scrollLeft ?? 0),
                            y: e.clientY - (box?.top ?? 0) + (stage?.scrollTop ?? 0),
                          });
                        }}
                        onClick={() => market && onTrade(market)}
                      >
                        {w > 30 && h > 16 && <span className="pd-mheat-name">{coin.symbol}</span>}
                        {w > 54 && h > size * 2.3 && (
                          <span className="pd-mheat-value pd-num">
                            ${formatCompact(coin[index])}
                          </span>
                        )}
                      </button>
                    );
                  })}
                </div>
              </section>
            ))}
          </div>
        )}

        {hover && hoverGroup && (
          <div
            className="pd-map-card pd-mheat-card"
            style={{
              left: hover.x + 384 > width ? Math.max(hover.x - 376, 4) : hover.x + 16,
              top: Math.max(
                Math.min(
                  hover.y - 40,
                  (ref.current?.scrollTop ?? 0) + height - 70 - hoverRows.length * 30,
                ),
                (ref.current?.scrollTop ?? 0) + 4,
              ),
            }}
            aria-hidden
          >
            <strong className="pd-mheat-card-title">{t(SECTOR_LABEL[hoverGroup.sector])}</strong>
            <table>
              <thead>
                <tr>
                  <th className="pd-mheat-th">{t("heat.symbol")}</th>
                  <th className="pd-mheat-th pd-mheat-num pd-num">{indexLabel}</th>
                  <th className="pd-mheat-th pd-mheat-num pd-num">
                    {t("heat.change", { period: t(PERIOD_LABEL[colourBy]) })}
                  </th>
                </tr>
              </thead>
              <tbody>
                {hoverRows.map((c) => {
                  const change = changeOf(c, colourBy);
                  const market = marketFor(c.symbol);
                  return (
                    <tr key={c.symbol}>
                      <td
                        className="pd-mheat-td pd-mheat-td-name"
                        data-at={c.symbol === hover.symbol || undefined}
                      >
                        {market && <TokenIcon market={market} size={16} />}
                        {c.symbol}
                      </td>
                      <td
                        className="pd-mheat-td pd-mheat-num pd-num"
                        data-at={c.symbol === hover.symbol || undefined}
                      >
                        ${formatCompact(c[index])}
                      </td>
                      <td
                        data-at={c.symbol === hover.symbol || undefined}
                        className={`pd-mheat-td pd-mheat-num pd-num ${change === undefined ? "" : change >= 0 ? "pd-up" : "pd-down"}`}
                      >
                        {change === undefined ? "-" : `${formatSigned(change * 100, 2)}%`}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
      <p className="pd-mheat-note">{t("heat.source")}</p>
    </div>
  );
}
