import type { BookLevel, OrderBook } from "@pewterdesk/core";
import { useEffect, useRef, useState } from "react";
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
   * Bid size over bid + ask size, 0–1, across every level the venue sent —
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
  const ladder: BookLadder = {
    asks: asks.map(withDepth).reverse(),
    bids: bids.map(withDepth),
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

function Row({ row, side, mode }: { row: BookRow; side: BookSide; mode: RowMode }) {
  return (
    <div className="pd-book-row" data-side={side} data-key={rowKey(side, row.price)}>
      <div className="pd-book-depth" style={{ width: `${row.depth * 100}%` }} />
      {mode === "table" ? (
        <>
          <span className="pd-book-price">{formatNumber(row.price)}</span>
          <span>{formatNumber(row.size)}</span>
          <span>{formatNumber(row.total, 0)}</span>
        </>
      ) : (
        <>
          <span className="pd-book-price">{formatNumber(row.price)}</span>
          <span className="pd-row-sub">
            {formatNumber(row.size)} <span aria-hidden>·</span> Σ {formatNumber(row.total, 0)}
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
        [t("tip.fromMid"), fromMid === undefined ? "—" : `${formatSigned(fromMid * 100, 3)}%`],
      ]}
    />
  );
}

/** How many whole rows fit in the element, tracked as it resizes. */
function useRowsThatFit<T extends HTMLElement>(rowHeight: number) {
  const ref = useRef<T>(null);
  const [rows, setRows] = useState(0);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const observer = new ResizeObserver(([entry]) => {
      if (entry) setRows(Math.floor(entry.contentRect.height / rowHeight));
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [rowHeight]);
  return [ref, rows] as const;
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
}

function bookColumns(base?: string, quote?: string): Column[] {
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
      label: t("col.size"),
      hint: (
        <Hint title={t("col.size")}>
          {t("hint.book.size")}
          {unitHint(base)}
        </Hint>
      ),
    },
    {
      label: t("col.total"),
      hint: (
        <Hint title={t("col.total")}>
          {t("hint.book.total")}
          {unitHint(base)}
        </Hint>
      ),
    },
  ];
}

/**
 * Fills its container's height, so give it one (e.g. a flex column child).
 * Both sides get an equal share of what's left after the header, spread and
 * ratio bar; the level count follows from that.
 */
export function OrderBookView({ book, depth, base, quote, mode = "table" }: OrderBookViewProps) {
  // Both sides are the same flex size, so measuring the asks is enough.
  const [askSideRef, rowsThatFit] = useRowsThatFit<HTMLDivElement>(ROW_HEIGHT[mode]);
  const ladder = bookLadder(book, depth ?? Math.max(rowsThatFit, 1));
  const { midDecimals } = ladder;
  const midShown = ladder.mid === undefined ? undefined : Number(ladder.mid.toFixed(midDecimals));
  const trend = usePriceTrend(midShown);
  const hover = useHoveredRow<HTMLDivElement>();
  const hovered = [
    ...ladder.asks.map((row) => ({ row, side: "ask" as const })),
    ...ladder.bids.map((row) => ({ row, side: "bid" as const })),
  ].find(({ row, side }) => rowKey(side, row.price) === hover.key);

  return (
    <div ref={hover.containerRef} className="pd-book" data-mode={mode} {...hover.handlers}>
      {mode === "table" && <ColumnHeader columns={bookColumns(base, quote)} />}
      <div ref={askSideRef} className="pd-book-side" data-side="ask">
        {ladder.asks.map((row) => (
          <Row key={row.price} row={row} side="ask" mode={mode} />
        ))}
      </div>
      <div className="pd-book-spread">
        <span className="pd-book-mid" data-trend={trend}>
          {midShown === undefined ? "—" : formatNumber(midShown, midDecimals)}
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
      <div className="pd-book-side" data-side="bid">
        {ladder.bids.map((row) => (
          <Row key={row.price} row={row} side="bid" mode={mode} />
        ))}
      </div>
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
