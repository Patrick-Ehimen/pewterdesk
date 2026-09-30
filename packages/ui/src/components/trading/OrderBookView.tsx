import type { BookLevel, OrderBook } from "@pewterdesk/core";
import { useEffect, useMemo, useRef, useState } from "react";
import { t } from "../../i18n";
import { decimalsOf, formatNumber, formatPercent, formatSigned } from "../../lib/format";
import { type Column, ColumnHeader, Hint, unitHint } from "../common/ColumnHeader";
import { FloatingTip, TipRows, useHoveredRow } from "../common/Tooltip";

/** How book and trade rows are laid out: one line in columns, or two stacked lines. */
export type RowMode = "table" | "stacked";

/** Height of one row in px, per mode. Keep in sync with `.pd-book-row` in styles.css. */
export const ROW_HEIGHT: Record<RowMode, number> = { table: 24, stacked: 40 };

export interface BookRow {
  price: string;
  size: string;
  /** Cumulative size from the spread out to this level. */
  total: number;
  /** Cumulative price × size from the spread out to this level, in the quote asset. */
  notional: number;
  /** `total` as a share of the deepest side shown, 0–1, for the depth bar. */
  depth: number;
}

export interface BookLadder {
  /** Worst first, so the best ask sits just above the spread. */
  asks: BookRow[];
  /**
   * Places to show running totals with: the finest size shown, so a BTC
   * book's 0.08 doesn't round to 0 (capped, so a dust level can't widen it).
   */
  sizeDecimals: number;
  /** Best first. */
  bids: BookRow[];
  mid?: number;
  /**
   * Places to show the mid and spread with: the book's own price precision.
   * A mid on a half-tick rounds to it, e.g. 91.9935 shows as 91.994.
   */
  midDecimals: number;
  spread?: number;
  spreadBps?: number;
  /**
   * Bid size over bid + ask size, 0–1, across every level the venue sent -
   * not just the ones shown, so resizing the panel doesn't move it.
   * Undefined for an empty book.
   */
  bidShare?: number;
}

const sumSizes = (levels: BookLevel[]) => levels.reduce((sum, l) => sum + Number(l.size), 0);

function accumulate(levels: BookLevel[], depth: number): Omit<BookRow, "depth">[] {
  let total = 0;
  let notional = 0;
  return levels.slice(0, depth).map((level) => {
    const size = Number(level.size);
    total += size;
    notional += size * Number(level.price);
    return { price: level.price, size: level.size, total, notional };
  });
}

/** The most places a running total shows with. */
const MAX_SIZE_DECIMALS = 5;

/** Top `depth` levels per side, with cumulative totals and spread stats. */
export function bookLadder(book: OrderBook, depth: number): BookLadder {
  const asks = accumulate(book.asks, depth);
  const bids = accumulate(book.bids, depth);
  const deepest = Math.max(asks.at(-1)?.total ?? 0, bids.at(-1)?.total ?? 0) || 1;
  const withDepth = (row: Omit<BookRow, "depth">): BookRow => ({
    ...row,
    depth: row.total / deepest,
  });

  const bestAsk = book.asks[0];
  const bestBid = book.bids[0];
  const tickDecimals = Math.max(
    ...[bestBid, bestAsk].map((level) => (level ? decimalsOf(level.price) : 0)),
  );
  const sizeDecimals = Math.min(
    MAX_SIZE_DECIMALS,
    Math.max(0, ...[...asks, ...bids].map((row) => decimalsOf(row.size))),
  );
  const ladder: BookLadder = {
    asks: asks.map(withDepth).reverse(),
    bids: bids.map(withDepth),
    sizeDecimals,
    midDecimals: tickDecimals,
  };
  const bidSize = sumSizes(book.bids);
  const askSize = sumSizes(book.asks);
  if (bidSize + askSize > 0) ladder.bidShare = bidSize / (bidSize + askSize);
  if (bestAsk && bestBid) {
    const ask = Number(bestAsk.price);
    const bid = Number(bestBid.price);
    ladder.mid = (ask + bid) / 2;
    ladder.spread = ask - bid;
    ladder.spreadBps = (ladder.spread / ladder.mid) * 10_000;
  }
  return ladder;
}

type BookSide = "bid" | "ask";

const rowKey = (side: BookSide, price: string) => `${side}:${price}`;

/** Every level's size, keyed like the rows ("bid:92.809"). */
export function levelSizes(book: OrderBook): Map<string, string> {
  const sizes = new Map<string, string>();
  for (const level of book.bids) sizes.set(rowKey("bid", level.price), level.size);
  for (const level of book.asks) sizes.set(rowKey("ask", level.price), level.size);
  return sizes;
}

/** Levels that are new or whose size changed since `before`. */
export function changedLevels(
  before: ReadonlyMap<string, string>,
  after: ReadonlyMap<string, string>,
): string[] {
  return [...after].filter(([key, size]) => before.get(key) !== size).map(([key]) => key);
}

/**
 * How many times each level has changed while this book was on screen. A row
 * re-keys its flash on a new count, so each change restarts the flash. The
 * first book, and a switch to another market, flash nothing.
 */
function useLevelFlashes(book: OrderBook): ReadonlyMap<string, number> {
  const sizes = useRef(new Map<string, string>());
  const counts = useRef(new Map<string, number>());
  const market = useRef<string>(undefined);
  return useMemo(() => {
    const next = levelSizes(book);
    if (market.current === book.market && sizes.current.size > 0) {
      for (const key of changedLevels(sizes.current, next)) {
        counts.current.set(key, (counts.current.get(key) ?? 0) + 1);
      }
      // Levels that left the book start over if they come back.
      for (const key of counts.current.keys()) if (!next.has(key)) counts.current.delete(key);
    } else {
      counts.current = new Map();
    }
    sizes.current = next;
    market.current = book.market;
    return new Map(counts.current);
  }, [book]);
}

/** Sizes and totals in the coin (HYPE), or valued in the quote asset (USDC). */
export type BookUnit = "base" | "quote";
export const BOOK_UNITS: readonly BookUnit[] = ["base", "quote"];

function Row({
  row,
  side,
  mode,
  unit,
  sizeDecimals,
  quoteDecimals,
  flash,
}: {
  row: BookRow;
  side: BookSide;
  mode: RowMode;
  unit: BookUnit;
  /** Places for the running total (see `BookLadder.sizeDecimals`). */
  sizeDecimals: number;
  /** Places for values in the quote asset, the same on every row. */
  quoteDecimals: number;
  /** Changes when the level does; unset if it hasn't changed yet. */
  flash?: number;
}) {
  const size =
    unit === "quote"
      ? formatNumber(Number(row.size) * Number(row.price), quoteDecimals)
      : formatNumber(row.size);
  const total =
    unit === "quote"
      ? formatNumber(row.notional, quoteDecimals)
      : formatNumber(row.total, sizeDecimals);
  return (
    <div className="pd-book-row" data-side={side} data-key={rowKey(side, row.price)}>
      <div className="pd-book-depth" style={{ width: `${row.depth * 100}%` }} />
      {flash !== undefined && <div key={flash} className="pd-book-flash" aria-hidden />}
      {mode === "table" ? (
        <>
          <span className="pd-book-price">{formatNumber(row.price)}</span>
          <span>{size}</span>
          <span>{total}</span>
        </>
      ) : (
        <>
          <span className="pd-book-price">{formatNumber(row.price)}</span>
          <span className="pd-row-sub">
            {size} <span aria-hidden>·</span> Σ {total}
          </span>
        </>
      )}
    </div>
  );
}

export type PriceTrend = "up" | "down";

/**
 * Which way `price` last moved. Holds the last direction until the price
 * moves the other way, like a ticker; undefined until the first move.
 * Pass the value as displayed, so moves too small to see don't flip it.
 */
export function usePriceTrend(price: number | undefined): PriceTrend | undefined {
  const previous = useRef<number>(undefined);
  const [trend, setTrend] = useState<PriceTrend>();
  useEffect(() => {
    if (price === undefined) return;
    const before = previous.current;
    if (before !== undefined && price !== before) setTrend(price > before ? "up" : "down");
    previous.current = price;
  }, [price]);
  return trend;
}

interface LevelTipProps {
  row: BookRow;
  side: BookSide;
  mid?: number;
  priceDecimals: number;
  base?: string;
  quote?: string;
}

/** What it takes to trade through to this level, for the hovered row's tooltip. */
function LevelTip({ row, side, mid, priceDecimals, base, quote }: LevelTipProps) {
  const unit = (text: string, asset?: string) => (asset ? `${text} ${asset}` : text);
  const size = Number(row.size);
  const price = Number(row.price);
  const fromMid = mid ? (price - mid) / mid : undefined;
  return (
    <TipRows
      title={`${t(side === "ask" ? "side.ask" : "side.bid")} ${formatNumber(row.price)}`}
      side={side}
      rows={[
        [t("tip.sizeHere"), unit(formatNumber(row.size), base)],
        [t("tip.valueHere"), unit(formatNumber(size * price, 2), quote)],
        [t("tip.totalToHere"), unit(formatNumber(row.total, decimalsOf(row.size)), base)],
        [t("tip.valueToHere"), unit(formatNumber(row.notional, 2), quote)],
        [t("tip.avgFill"), formatNumber(row.notional / row.total, priceDecimals)],
        [t("tip.fromMid"), fromMid === undefined ? "-" : `${formatSigned(fromMid * 100, 3)}%`],
      ]}
    />
  );
}

/**
 * How many whole rows fit in the element, tracked as it resizes. A callback
 * ref, so it follows the element when a different one mounts (switching
 * the book between both sides and one).
 */
function useRowsThatFit<T extends HTMLElement>(rowHeight: number) {
  const [el, setEl] = useState<T | null>(null);
  const [rows, setRows] = useState(0);
  useEffect(() => {
    if (!el) return;
    const observer = new ResizeObserver(([entry]) => {
      if (entry) setRows(Math.floor(entry.contentRect.height / rowHeight));
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [el, rowHeight]);
  return [setEl, rows] as const;
}

/** Bid vs ask size as a split bar, bids on the left. */
function BookRatio({ bidShare }: { bidShare: number }) {
  const bidPct = bidShare * 100;
  const bids = formatPercent(bidShare, 1);
  const asks = formatPercent(1 - bidShare, 1);
  return (
    <div className="pd-book-ratio" role="img" aria-label={t("book.ratio", { bids, asks })}>
      <span className="pd-ratio-label" data-side="bid">
        <b>{t("book.ratioBid")}</b>
        {bids}
      </span>
      <div className="pd-ratio-bar">
        <div data-side="bid" style={{ width: `${bidPct}%` }} />
        <div data-side="ask" style={{ width: `${100 - bidPct}%` }} />
      </div>
      <span className="pd-ratio-label" data-side="ask">
        {asks}
        <b>{t("book.ratioAsk")}</b>
      </span>
    </div>
  );
}

interface OrderBookViewProps {
  book: OrderBook;
  /** Levels per side. Omit to show as many as fit the height the book is given. */
  depth?: number;
  /** Base asset, e.g. "HYPE", for the column hints. */
  base?: string;
  quote?: string;
  /** Defaults to "table". "stacked" drops the column header for two-line rows. */
  mode?: RowMode;
  /** Both sides (default), or one of them given the whole height. */
  sides?: BookSides;
  /** Sizes and totals in the coin (default) or valued in the quote asset. */
  unit?: BookUnit;
  /** Offered as a switch beside the Size and Total headers. */
  onUnitChange?: (unit: BookUnit) => void;
}

/** Which of the book's sides show. */
export type BookSides = "both" | "bids" | "asks";
export const BOOK_SIDES: readonly BookSides[] = ["both", "bids", "asks"];

const SIDES_LABEL = {
  both: "book.both",
  bids: "book.bids",
  asks: "book.asks",
} as const;

/** The view buttons' glyphs: bids green, asks red, beside the rows' lines. */
function SidesIcon({ sides }: { sides: BookSides }) {
  const lines = (
    <g fill="currentColor" opacity="0.55">
      <rect x="10" y="3" width="7" height="1.6" rx="0.8" />
      <rect x="10" y="7.2" width="7" height="1.6" rx="0.8" />
      <rect x="10" y="11.4" width="7" height="1.6" rx="0.8" />
      <rect x="10" y="15.6" width="7" height="1.6" rx="0.8" />
    </g>
  );
  return (
    <svg width="20" height="20" viewBox="0 0 20 20" fill="none" strokeWidth="1.6" aria-hidden>
      {sides === "both" ? (
        <>
          <rect x="2.5" y="2.5" width="5" height="6" rx="1" className="pd-sides-bid" />
          <rect x="2.5" y="11.5" width="5" height="6" rx="1" className="pd-sides-ask" />
        </>
      ) : (
        <rect
          x="2.5"
          y="2.5"
          width="5"
          height="15"
          rx="1"
          className={sides === "bids" ? "pd-sides-bid" : "pd-sides-ask"}
        />
      )}
      {lines}
    </svg>
  );
}

/** The book's view buttons: buys and sells, buys only, sells only. */
export function BookSidesPicker({
  value,
  onChange,
}: {
  value: BookSides;
  onChange: (sides: BookSides) => void;
}) {
  return (
    <div className="pd-book-sides" role="radiogroup" aria-label={t("book.view")}>
      {BOOK_SIDES.map((s) => (
        // biome-ignore lint/a11y/useSemanticElements: icon-style radio, like the other segmented controls
        <button
          key={s}
          type="button"
          role="radio"
          aria-checked={s === value}
          aria-label={t(SIDES_LABEL[s])}
          title={t(SIDES_LABEL[s])}
          onClick={() => onChange(s)}
        >
          <SidesIcon sides={s} />
        </button>
      ))}
    </div>
  );
}

function bookColumns(
  base?: string,
  quote?: string,
  unit: BookUnit = "base",
  onSwitch?: () => void,
): Column[] {
  // Size and total are in whichever asset the book is showing them in.
  const sizeAsset = unit === "quote" ? quote : base;
  const named = (label: string) => (sizeAsset ? `${label} (${sizeAsset})` : label);
  const otherAsset = unit === "quote" ? base : quote;
  const switchTo =
    onSwitch && otherAsset ? { onSwitch, switchLabel: t("book.unit", { asset: otherAsset }) } : {};
  return [
    {
      label: t("col.price"),
      hint: (
        <Hint title={t("col.price")}>
          {t("hint.book.price")}
          {unitHint(quote)}
        </Hint>
      ),
    },
    {
      label: named(t("col.size")),
      ...switchTo,
      hint: (
        <Hint title={t("col.size")}>
          {t("hint.book.size")}
          {unitHint(sizeAsset)}
        </Hint>
      ),
    },
    {
      label: named(t("col.total")),
      ...switchTo,
      hint: (
        <Hint title={t("col.total")}>
          {t("hint.book.total")}
          {unitHint(sizeAsset)}
        </Hint>
      ),
    },
  ];
}

/**
 * Fills its container's height, so give it one (e.g. a flex column child).
 * Both sides get an equal share of what's left after the header, spread and
 * ratio bar; the level count follows from that. With one side, it gets it
 * all: bids under the spread, or asks over it.
 */
export function OrderBookView({
  book,
  depth,
  base,
  quote,
  mode = "table",
  sides = "both",
  unit = "base",
  onUnitChange,
}: OrderBookViewProps) {
  // Showing sides are the same flex size, so measuring one is enough.
  const [sideRef, rowsThatFit] = useRowsThatFit<HTMLDivElement>(ROW_HEIGHT[mode]);
  const ladder = bookLadder(book, depth ?? Math.max(rowsThatFit, 1));
  // Quote values: whole units when the book runs to hundreds, else cents,
  // the same on every row so the column lines up.
  const deepestValue = Math.max(0, ...[...ladder.asks, ...ladder.bids].map((r) => r.notional));
  const quoteDecimals = deepestValue >= 100 ? 0 : 2;
  const { midDecimals } = ladder;
  const midShown = ladder.mid === undefined ? undefined : Number(ladder.mid.toFixed(midDecimals));
  const trend = usePriceTrend(midShown);
  const flashes = useLevelFlashes(book);
  const hover = useHoveredRow<HTMLDivElement>();
  const hovered = [
    ...ladder.asks.map((row) => ({ row, side: "ask" as const })),
    ...ladder.bids.map((row) => ({ row, side: "bid" as const })),
  ].find(({ row, side }) => rowKey(side, row.price) === hover.key);

  return (
    <div ref={hover.containerRef} className="pd-book" data-mode={mode} {...hover.handlers}>
      {mode === "table" && (
        <ColumnHeader
          columns={bookColumns(
            base,
            quote,
            unit,
            onUnitChange && (() => onUnitChange(unit === "quote" ? "base" : "quote")),
          )}
        />
      )}
      {sides !== "bids" && (
        <div ref={sideRef} className="pd-book-side" data-side="ask">
          {ladder.asks.map((row) => (
            <Row
              key={row.price}
              row={row}
              side="ask"
              mode={mode}
              unit={unit}
              quoteDecimals={quoteDecimals}
              sizeDecimals={ladder.sizeDecimals}
              flash={flashes.get(rowKey("ask", row.price))}
            />
          ))}
        </div>
      )}
      <div className="pd-book-spread">
        <span className="pd-book-mid" data-trend={trend}>
          {midShown === undefined ? "-" : formatNumber(midShown, midDecimals)}
          {trend && (
            <span className="pd-book-trend" aria-hidden>
              {trend === "up" ? "▲" : "▼"}
            </span>
          )}
        </span>
        {ladder.spread !== undefined && ladder.spreadBps !== undefined && (
          <span className="pd-muted">
            {t("book.spread", {
              spread: formatNumber(ladder.spread, midDecimals),
              bps: formatNumber(ladder.spreadBps, 1),
            })}
          </span>
        )}
      </div>
      {sides !== "asks" && (
        <div ref={sides === "bids" ? sideRef : undefined} className="pd-book-side" data-side="bid">
          {ladder.bids.map((row) => (
            <Row
              key={row.price}
              row={row}
              side="bid"
              mode={mode}
              unit={unit}
              quoteDecimals={quoteDecimals}
              sizeDecimals={ladder.sizeDecimals}
              flash={flashes.get(rowKey("bid", row.price))}
            />
          ))}
        </div>
      )}
      {ladder.bidShare !== undefined && <BookRatio bidShare={ladder.bidShare} />}
      {/* The level may leave the book while hovered; the tip goes with it. */}
      {hovered && (
        <FloatingTip getAnchor={hover.anchor} axis="horizontal" className="pd-tip-row">
          <LevelTip
            row={hovered.row}
            side={hovered.side}
            mid={ladder.mid}
            priceDecimals={midDecimals}
            base={base}
            quote={quote}
          />
        </FloatingTip>
      )}
    </div>
  );
}
