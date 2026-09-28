import type { Market } from "@pewterdesk/core";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { LuSearch } from "react-icons/lu";
import { type MessageKey, t } from "../../i18n";
import {
  decimalsOf,
  formatCompact,
  formatNumber,
  formatSigned,
  trendClass,
} from "../../lib/format";
import {
  FILTERS,
  matchesFilter,
  matchesSearch,
  type ScreenerFilter,
  type ScreenerRow,
  type ScreenerSort,
  SIGNAL_RULES,
  type Signal,
  sortRows,
} from "../../lib/screener";
import { StarButton } from "../common/StarButton";
import { EmptyState } from "../common/Status";
import { Tooltip } from "../common/Tooltip";
import { ListedBy } from "./ListedBy";
import { Sparkline } from "./Sparkline";
import { TokenIcon } from "./TokenIcon";

/** Columns that can be hidden; market, price and 24H always show. */
type OptionalColumn =
  | "change1h"
  | "change7d"
  | "volume"
  | "openInterest"
  | "funding"
  | "rsi1h"
  | "signal";
const OPTIONAL: readonly OptionalColumn[] = [
  "change1h",
  "change7d",
  "volume",
  "openInterest",
  "funding",
  "rsi1h",
  "signal",
];
const COLUMN_LABEL: Record<OptionalColumn | "market" | "price" | "change24h", MessageKey> = {
  market: "col.market",
  price: "col.price",
  change1h: "screener.col.change1h",
  change24h: "screener.col.change24h",
  change7d: "screener.col.change7d",
  volume: "screener.col.volume",
  openInterest: "screener.col.oi",
  funding: "screener.col.funding",
  rsi1h: "screener.col.rsi",
  signal: "screener.col.signal",
};
const COLUMNS_KEY = "pd.screener.hidden";

function storedHidden(): Set<OptionalColumn> {
  try {
    const saved: unknown = JSON.parse(localStorage.getItem(COLUMNS_KEY) ?? "[]");
    return new Set(Array.isArray(saved) ? OPTIONAL.filter((c) => saved.includes(c)) : []);
  } catch {
    return new Set();
  }
}

const FILTER_LABEL: Record<ScreenerFilter, MessageKey> = {
  all: "screener.filter.all",
  movers: "screener.filter.movers",
  funding: "screener.filter.funding",
  oi: "screener.filter.oi",
  hl: "screener.filter.hl",
  builder: "screener.filter.builder",
  starred: "screener.filter.starred",
};

const SIGNAL_LABEL: Record<Signal, MessageKey> = {
  overbought: "signal.overbought",
  oversold: "signal.oversold",
  oiSpike: "signal.oiSpike",
  crowdedLong: "signal.crowdedLong",
  negativeFunding: "signal.negativeFunding",
  momentum: "signal.momentum",
};

/** The rule behind each signal, for its tooltip. */
function signalHint(signal: Signal): string {
  const r = SIGNAL_RULES;
  switch (signal) {
    case "overbought":
      return t("signalHint.overbought", { n: r.overbought });
    case "oversold":
      return t("signalHint.oversold", { n: r.oversold });
    case "oiSpike":
      return t("signalHint.oiSpike", { pct: r.oiSpike * 100 });
    case "crowdedLong":
      return t("signalHint.crowdedLong", { pct: r.crowdedLongApr * 100 });
    case "negativeFunding":
      return t("signalHint.negativeFunding", { pct: r.negativeFundingApr * 100 });
    case "momentum":
      return t("signalHint.momentum", { pct: r.momentum24h * 100 });
  }
}

/** A placeholder while a market's candle history hasn't arrived yet. */
const Pending = ({ width = 36 }: { width?: number }) => (
  <span className="pd-skel" style={{ width, height: 9 }} aria-hidden />
);

/** Skeleton rows while the first snapshot loads; the scroll area clips any extra. */
const SKELETON_ROWS = 18;
/** Widths that look organic but stay the same on every render. */
const NAME_W = [34, 42, 28, 38, 46, 30, 40, 36];
const NUM_W = [48, 56, 40, 52, 44, 60, 46, 50, 38];
const at = (widths: number[], i: number) => widths[i % widths.length] ?? 40;

const pct = (v: number | undefined, decimals = 2) =>
  v === undefined ? (
    <Pending />
  ) : (
    <span className={trendClass(v)}>{formatSigned(v * 100, decimals)}%</span>
  );

/** "Columns" button with a checkbox for each optional column. */
function ColumnsMenu({
  hidden,
  onChange,
}: {
  hidden: ReadonlySet<OptionalColumn>;
  onChange: (hidden: Set<OptionalColumn>) => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: PointerEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("pointerdown", close);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", close);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);
  return (
    <div ref={ref} className="pd-columns">
      <button
        type="button"
        className="pd-columns-button"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        {t("screener.columns")}
      </button>
      {open && (
        <fieldset className="pd-columns-menu">
          <legend className="pd-visually-hidden">{t("screener.columns")}</legend>
          {OPTIONAL.map((c) => (
            <label key={c}>
              <input
                type="checkbox"
                checked={!hidden.has(c)}
                onChange={(e) => {
                  const next = new Set(hidden);
                  if (e.target.checked) next.delete(c);
                  else next.add(c);
                  onChange(next);
                }}
              />
              {t(COLUMN_LABEL[c])}
            </label>
          ))}
        </fieldset>
      )}
    </div>
  );
}

interface ScreenerProps {
  rows: readonly ScreenerRow[];
  /** `Market::id` of the market on screen. */
  selected?: string;
  onSelect: (market: Market) => void;
  starred: ReadonlySet<string>;
  onToggleStar: (market: Market) => void;
  /** `compact` for the panel's normal size; `full` when it's expanded. */
  variant?: "compact" | "full";
  /** Only starred markets (the Watchlist tab); hides the filter chips. */
  watchlistOnly?: boolean;
  /** Right of the toolbar, e.g. "Hyperliquid perps · updated 04:12:37 UTC". */
  meta?: ReactNode;
  /** Shown under the toolbar while 1H/7D/RSI are still filling in. */
  progress?: string;
  /** The first snapshot hasn't arrived: skeleton rows in place of markets. */
  loading?: boolean;
}

/**
 * Every market, after the design's screener: filter chips with counts,
 * search, a column picker, and sortable columns. The compact variant keeps
 * price, 24H, volume and funding; the full one adds 1H, 7D, OI, RSI and a
 * signal. Click a market to put it on screen.
 */
export function Screener({
  rows,
  selected,
  onSelect,
  starred,
  onToggleStar,
  variant = "compact",
  watchlistOnly = false,
  meta,
  progress,
  loading = false,
}: ScreenerProps) {
  const full = variant === "full";
  const [filter, setFilter] = useState<ScreenerFilter>("all");
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<{ by: ScreenerSort; descending: boolean }>({
    by: "change24h",
    descending: true,
  });
  const [hidden, setHidden] = useState(storedHidden);
  useEffect(() => {
    try {
      localStorage.setItem(COLUMNS_KEY, JSON.stringify([...hidden]));
    } catch {
      // Storage unavailable; the choice just won't survive a restart.
    }
  }, [hidden]);

  const active: ScreenerFilter = watchlistOnly ? "starred" : filter;
  const needle = query.trim();
  const shown = sortRows(
    rows.filter((r) => matchesFilter(r, active, starred) && matchesSearch(r.market, needle)),
    sort.by,
    sort.descending,
  );
  const show = (c: OptionalColumn) => {
    if (!full) return c === "volume" || c === "funding";
    return !hidden.has(c);
  };

  const header = (id: ScreenerSort | "signal", label: MessageKey, numeric: boolean) => {
    if (id === "signal") return <th key={id}>{t(label)}</th>;
    const isActive = sort.by === id;
    return (
      <th
        key={id}
        className={numeric ? "pd-num" : undefined}
        aria-sort={isActive ? (sort.descending ? "descending" : "ascending") : "none"}
      >
        <button
          type="button"
          className="pd-sort"
          data-active={isActive || undefined}
          onClick={() =>
            setSort((s) => ({
              by: id,
              // A new column starts high-to-low (names A–Z); clicking again flips it.
              descending: s.by === id ? !s.descending : id !== "market",
            }))
          }
        >
          {t(label)}
          <span aria-hidden>{isActive ? (sort.descending ? "▼" : "▲") : ""}</span>
        </button>
      </th>
    );
  };

  const empty =
    watchlistOnly && starred.size === 0
      ? t("markets.watchlistEmpty")
      : needle
        ? t("markets.noMatch", { query })
        : active === "oi"
          ? t("screener.oiWait")
          : t("screener.noRows");

  return (
    <div className="pd-screener" data-variant={variant}>
      <div className="pd-screener-bar">
        {!watchlistOnly && (
          <div className="pd-chips" role="radiogroup" aria-label={t("markets.show")}>
            {FILTERS.map((f) => {
              const count = rows.filter((r) => matchesFilter(r, f, starred)).length;
              return (
                // biome-ignore lint/a11y/useSemanticElements: chip-style radio, like the other segmented controls
                <button
                  key={f}
                  type="button"
                  role="radio"
                  aria-checked={f === filter}
                  className="pd-chip"
                  onClick={() => setFilter(f)}
                >
                  {t(FILTER_LABEL[f])}
                  <span className="pd-chip-count">{loading ? <Pending width={12} /> : count}</span>
                </button>
              );
            })}
          </div>
        )}
        <span className="app-spacer" />
        <label className="pd-search">
          <LuSearch size={14} aria-hidden />
          <input
            type="search"
            placeholder={t("markets.search")}
            aria-label={t("markets.search")}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </label>
        {full && <ColumnsMenu hidden={hidden} onChange={setHidden} />}
      </div>
      {(meta || progress) && full && (
        <div className="pd-screener-meta">
          {progress && (
            <span role="status" className="pd-muted">
              {progress}
            </span>
          )}
          <span className="app-spacer" />
          {meta}
        </div>
      )}

      <div className="pd-screener-scroll">
        <table
          className="pd-table pd-screener-table"
          aria-busy={loading || undefined}
          aria-label={loading ? t("feed.loading") : undefined}
        >
          <thead>
            <tr>
              <th className="pd-star-col">
                <span className="pd-visually-hidden">{t("markets.watchlistColumn")}</span>
              </th>
              {header("market", COLUMN_LABEL.market, false)}
              {header("price", COLUMN_LABEL.price, true)}
              {show("change1h") && header("change1h", COLUMN_LABEL.change1h, true)}
              {header("change24h", COLUMN_LABEL.change24h, true)}
              {show("change7d") && header("change7d", COLUMN_LABEL.change7d, false)}
              {show("volume") && header("volume", COLUMN_LABEL.volume, true)}
              {show("openInterest") && header("openInterest", COLUMN_LABEL.openInterest, true)}
              {show("funding") && header("funding", COLUMN_LABEL.funding, true)}
              {show("rsi1h") && header("rsi1h", COLUMN_LABEL.rsi1h, true)}
              {show("signal") && header("signal", COLUMN_LABEL.signal, false)}
            </tr>
          </thead>
          {loading && (
            <tbody className="pd-skel-body" aria-hidden>
              {Array.from({ length: SKELETON_ROWS }, (_, i) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: fixed placeholder rows
                <tr key={i} className="pd-skel-row">
                  <td className="pd-star-col">
                    <Pending width={12} />
                  </td>
                  <td>
                    <span className="pd-skel-name">
                      <span className="pd-skel pd-skel-dot" />
                      <Pending width={at(NAME_W, i)} />
                    </span>
                  </td>
                  <td className="pd-num">
                    <Pending width={at(NUM_W, i)} />
                  </td>
                  {show("change1h") && (
                    <td className="pd-num">
                      <Pending width={at(NUM_W, i + 2) - 8} />
                    </td>
                  )}
                  <td className="pd-num">
                    <Pending width={at(NUM_W, i + 4) - 4} />
                  </td>
                  {show("change7d") && (
                    <td className="pd-spark-cell">
                      <Pending width={110} />
                    </td>
                  )}
                  {show("volume") && (
                    <td className="pd-num">
                      <Pending width={at(NUM_W, i + 1)} />
                    </td>
                  )}
                  {show("openInterest") && (
                    <td className="pd-num">
                      <Pending width={at(NUM_W, i + 3)} />
                    </td>
                  )}
                  {show("funding") && (
                    <td className="pd-num">
                      <Pending width={at(NUM_W, i + 5)} />
                    </td>
                  )}
                  {show("rsi1h") && (
                    <td className="pd-num">
                      <Pending width={22} />
                    </td>
                  )}
                  {show("signal") && (
                    <td>{i % 3 === 0 && <Pending width={at(NUM_W, i) + 12} />}</td>
                  )}
                </tr>
              ))}
            </tbody>
          )}
          <tbody>
            {shown.map((r) => (
              <tr
                key={r.market.id}
                className="pd-row-select"
                aria-selected={r.market.id === selected}
              >
                <td className="pd-star-col">
                  <StarButton
                    starred={starred.has(r.market.id)}
                    name={r.market.symbol}
                    size={14}
                    className="pd-star-small"
                    onToggle={() => onToggleStar(r.market)}
                  />
                </td>
                <td>
                  <button
                    type="button"
                    className="pd-row-button"
                    onClick={() => onSelect(r.market)}
                  >
                    <TokenIcon market={r.market} />
                    {r.market.base}
                  </button>
                  <ListedBy market={r.market} />
                  <span className="pd-lev">{r.market.maxLeverage}x</span>
                </td>
                <td className="pd-num">{formatNumber(r.price, decimalsOf(r.rawPrice))}</td>
                {show("change1h") && <td className="pd-num">{pct(r.change1h)}</td>}
                <td className="pd-num">
                  <span className="pd-change-cell" data-trend={r.change24h >= 0 ? "up" : "down"}>
                    {formatSigned(r.change24h * 100)}%
                  </span>
                </td>
                {show("change7d") && (
                  <td className="pd-spark-cell">
                    {r.spark ? <Sparkline values={r.spark} /> : <Pending width={110} />}
                  </td>
                )}
                {show("volume") && <td className="pd-num">${formatCompact(r.volume)}</td>}
                {show("openInterest") && (
                  <td className="pd-num">${formatCompact(r.openInterest)}</td>
                )}
                {show("funding") && (
                  <td className="pd-num">
                    <span className={r.funding < 0 ? "pd-funding-neg" : undefined}>
                      {formatSigned(r.funding * 100, 4)}%
                    </span>
                    {full && <span className="pd-apr">{formatSigned(r.fundingApr * 100, 1)}%</span>}
                  </td>
                )}
                {show("rsi1h") && (
                  <td className="pd-num">
                    {r.rsi1h === undefined ? (
                      <Pending width={22} />
                    ) : (
                      <span
                        className="pd-rsi"
                        data-zone={
                          r.rsi1h >= SIGNAL_RULES.overbought
                            ? "high"
                            : r.rsi1h <= SIGNAL_RULES.oversold
                              ? "low"
                              : undefined
                        }
                      >
                        {formatNumber(r.rsi1h, 0)}
                      </span>
                    )}
                  </td>
                )}
                {show("signal") && (
                  <td>
                    {r.signal && (
                      <Tooltip content={signalHint(r.signal)} className="pd-signal-tip">
                        <span className="pd-signal" data-signal={r.signal}>
                          {t(SIGNAL_LABEL[r.signal])}
                        </span>
                      </Tooltip>
                    )}
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
        {!loading && shown.length === 0 && <EmptyState>{empty}</EmptyState>}
      </div>
    </div>
  );
}
