import type { Market, VenueId } from "@pewterdesk/core";
import {
  decimalsOf,
  EmptyState,
  formatCompact,
  formatNumber,
  formatSigned,
  inScope,
  isPreset,
  MapSeg,
  type MessageKey,
  needsHistory,
  opsFor,
  parseScreenNumber,
  type Rating,
  ratingOf,
  runScreen,
  SaveList,
  SCREEN_COLUMNS,
  SCREEN_PRESETS,
  SCREEN_STATES,
  SCREEN_UNIT,
  ScanActionsContext,
  type Screen,
  type ScreenColumn,
  type ScreenFilter,
  type ScreenInput,
  type ScreenOp,
  type ScreenScope,
  type ScreenValue,
  Select,
  StarButton,
  screenColumns,
  TokenIcon,
  t,
  trendClass,
} from "@pewterdesk/ui";
import { useEffect, useMemo, useState } from "react";
import {
  LuArrowDown,
  LuArrowUp,
  LuChevronDown,
  LuChevronsDown,
  LuChevronsUp,
  LuChevronUp,
  LuColumns3,
  LuPlus,
  LuSearch,
  LuX,
} from "react-icons/lu";
import { useMarketHistories } from "../../hooks/useMapData";
import { useMarketCaps, useMarketSummaries, useMarkets } from "../../hooks/useVenueFeeds";
import { useWatchlist, watchKey } from "../../hooks/useWatchlist";
import { dayChanges } from "../../lib/marketMovers";
import { keepCurrent, keepSaved, loadCurrent, loadSaved, MAX_SAVED } from "../../lib/screens";
import { matchesSearch } from "../../lib/tokenDetails";
import { useLists } from "../../lib/watchlists";
import { LoadingMark } from "../Splash";
import { TopMovers, TrendDistribution } from "../screener/MarketMovers";
import { MarketSentiment } from "../screener/MarketSentiment";
import { TokenDetails } from "../screener/TokenDetails";
import { TrendingSectors } from "../screener/TrendingSectors";

const SCOPES: readonly ScreenScope[] = ["crypto", "all"];
/** Rows drawn at most: a venue lists a few hundred markets. */
const ROWS_MAX = 500;
/** How often the clock the key levels are read against moves on. */
const REFRESH_MS = 30_000;

/** Columns whose sign is the point: shown with it, in green or red. */
const SIGNED = new Set<ScreenColumn>([
  "change1h",
  "change4h",
  "change24h",
  "change7d",
  "funding",
  "vwapZ",
  "fromEma",
  "level",
]);

const label = (c: ScreenColumn) => t(`screens.col.${c}`);
// Only the enum columns have states, and presets come with the app: both named in en.ts.
const stateLabel = (c: ScreenColumn, value: string) =>
  SCREEN_UNIT[c] === "rating"
    ? t(`screens.rating.${value}` as MessageKey)
    : t(`screens.state.${c}.${value}` as MessageKey);
const screenName = (s: Screen) =>
  isPreset(s) ? t(`screens.preset.${s.name}` as MessageKey) : s.name;

/** A value as the table shows it. */
function valueText(column: ScreenColumn, value: ScreenValue, market: Market): string {
  if (value === undefined) return "-";
  if (typeof value === "string") return stateLabel(column, value);
  if (SCREEN_UNIT[column] === "rating") return stateLabel(column, ratingOf(value));
  switch (SCREEN_UNIT[column]) {
    case "price":
      return formatNumber(value, decimalsOf(market.tickSize));
    case "usd":
      return `$${formatCompact(value)}`;
    case "pct":
      return SIGNED.has(column)
        ? `${formatSigned(value * 100, 2)}%`
        : `${formatNumber(value * 100, 1)}%`;
    default:
      return SIGNED.has(column) ? formatSigned(value, 2) : formatNumber(value, 1);
  }
}

/** A filter's number as typed back: a percentage for "pct", compact for "usd". */
function typedText(column: ScreenColumn, n: number): string {
  const unit = SCREEN_UNIT[column];
  if (unit === "usd") return `$${formatCompact(n)}`;
  if (unit === "pct") return `${formatNumber(n, Number.isInteger(n) ? 0 : 2)}%`;
  return formatNumber(n, Number.isInteger(n) ? 0 : 2);
}

function filterText(f: ScreenFilter): string {
  const name = label(f.column);
  if (f.op === "is") return `${name}: ${stateLabel(f.column, String(f.value))}`;
  const value = typedText(f.column, Number(f.value));
  if (f.op === "between") {
    return t("screens.filter.between", { name, from: value, to: typedText(f.column, f.to ?? 0) });
  }
  return t(`screens.filter.${f.op}`, { name, value });
}

interface ScreenerPageProps {
  /** The venue on screen: where the page starts. */
  venue: VenueId;
  /** The venues turned on, to pick from. */
  venues: readonly { id: VenueId; label: string; logo?: string }[];
  /** Opens a market on the Trade page. */
  onTrade: (venue: VenueId, market: string) => void;
}

/**
 * The Screener: one venue's markets in a table of the columns the trader
 * picks, kept to those that pass every filter, sorted by any column. Screens
 * can be saved, and some come with the app. Everything is read from what the
 * app already reads (each market's summary and its last week of hourly
 * candles); it places nothing.
 */
export function ScreenerPage({ venue: onScreen, venues, onTrade }: ScreenerPageProps) {
  const [venue, setVenue] = useState<VenueId>(onScreen);
  useEffect(() => setVenue(onScreen), [onScreen]);
  const [screen, setScreen] = useState<Screen>(loadCurrent);
  useEffect(() => keepCurrent(screen), [screen]);
  const [saved, setSaved] = useState<Screen[]>(loadSaved);
  useEffect(() => keepSaved(saved), [saved]);

  const marketsFeed = useMarkets(venue);
  const markets =
    marketsFeed.status === "live" || marketsFeed.status === "closed" ? marketsFeed.data : undefined;
  const summaryFeed = useMarketSummaries(venue, true);
  const summaries =
    summaryFeed.status === "live" || summaryFeed.status === "closed" ? summaryFeed.data : undefined;
  const columns = screenColumns(screen);
  // Market caps, for the Market column's sort: crypto markets only (a
  // stock's ticker would match some unrelated coin), read once it's asked for.
  const capBases = useMemo(
    () =>
      columns.includes("marketCap") && markets
        ? [...new Set(markets.filter((m) => inScope(m, "crypto")).map((m) => m.base))].sort()
        : undefined,
    [columns, markets],
  );
  const capsFeed = useMarketCaps(venue, capBases);
  const caps = capsFeed.status === "live" ? capsFeed.data : undefined;
  const histories = useMarketHistories(venue, columns.some(needsHistory));

  // The key levels are the day's and the week's: read against a clock that
  // moves on now and then. Prices move the rows as the summaries come in.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), REFRESH_MS);
    return () => clearInterval(id);
  }, []);
  const summaryById = useMemo(
    () => new Map((summaries ?? []).map((s) => [s.market, s])),
    [summaries],
  );
  const inputs = useMemo<ScreenInput[]>(
    () =>
      (markets ?? []).map((market) => ({
        market,
        summary: summaryById.get(market.id),
        candles: histories.get(market.id)?.candles,
        now,
        marketCap: inScope(market, "crypto") ? caps?.[market.base] : undefined,
      })),
    [markets, summaryById, histories, now, caps],
  );
  const rows = useMemo(() => runScreen(screen, inputs), [screen, inputs]);
  // Ranked in the screen's order, then searched: a market keeps its number.
  const [query, setQuery] = useState("");
  const found = useMemo(
    () =>
      rows
        .map((row, i) => ({ ...row, rank: i + 1 }))
        .filter((row) => matchesSearch(row.market, query)),
    [rows, query],
  );
  const shown = found.slice(0, ROWS_MAX);
  const [details, setDetails] = useState<string>();
  // The day's moves, in the screen's scope (crypto only, or everything).
  const changes = useMemo(
    () =>
      dayChanges(
        (markets ?? []).filter((m) => inScope(m, screen.scope)),
        summaryById,
      ),
    [markets, summaryById, screen.scope],
  );
  const detailed = details ? markets?.find((m) => m.id === details) : undefined;
  const progress = {
    done: (markets ?? []).filter((m) => histories.has(m.id)).length,
    total: markets?.length ?? 0,
  };

  const watch = useWatchlist(venue);
  const lists = useLists();
  const actions = {
    starred: (m: Market) => watch.starred.has(m.id),
    onStar: (m: Market) => watch.toggle(m.id),
    onSaveList: (name: string, found: readonly Market[]) =>
      lists.createWith(
        name,
        found.map((m) => watchKey(venue, m.id)),
      ),
  };

  const change = (update: Partial<Screen>) => setScreen((s) => ({ ...s, ...update }));
  const savedOne = saved.find((s) => s.id === screen.id);
  const changed =
    JSON.stringify(screen) !==
    JSON.stringify(savedOne ?? SCREEN_PRESETS.find((p) => p.id === screen.id));

  const [naming, setNaming] = useState(false);
  const saveAs = (name: string) => {
    const copy = { ...screen, id: crypto.randomUUID(), name };
    setSaved((list) => [...list, copy].slice(0, MAX_SAVED));
    setScreen(copy);
    setNaming(false);
  };
  const saveOver = () => setSaved((list) => list.map((s) => (s.id === screen.id ? screen : s)));
  const remove = () => {
    setSaved((list) => list.filter((s) => s.id !== screen.id));
    setScreen(SCREEN_PRESETS[0] as Screen);
  };

  const sortBy = (column: ScreenColumn) =>
    change({
      sort:
        screen.sort.column === column
          ? { column, desc: !screen.sort.desc }
          : { column, desc: SCREEN_UNIT[column] !== "enum" },
    });

  const waiting = !markets || !summaries;
  const filling = columns.some(needsHistory) && progress.done < progress.total;

  return (
    <div className="page screener">
      <header className="screener-head">
        <h1>{t("nav.screener")}</h1>
        <Select
          value={venue}
          options={venues.map((v) => ({ value: v.id, label: v.label, icon: v.logo }))}
          onChange={setVenue}
          label={t("screens.venue")}
        />
        <Select
          value={screen.id}
          options={[
            ...SCREEN_PRESETS.map((p) => ({ value: p.id, label: screenName(p) })),
            ...saved.map((s) => ({ value: s.id, label: s.name })),
          ]}
          onChange={(id) => {
            const next = saved.find((s) => s.id === id) ?? SCREEN_PRESETS.find((p) => p.id === id);
            if (next) setScreen(next);
          }}
          label={t("screens.screen")}
        />
        {naming ? (
          <NameInput onSave={saveAs} onCancel={() => setNaming(false)} />
        ) : (
          <div className="screener-actions">
            {savedOne && changed && (
              <button type="button" onClick={saveOver}>
                {t("screens.save")}
              </button>
            )}
            <button
              type="button"
              onClick={() => setNaming(true)}
              disabled={saved.length >= MAX_SAVED}
            >
              {t("screens.saveAs")}
            </button>
            {savedOne && (
              <button type="button" onClick={remove}>
                {t("screens.delete")}
              </button>
            )}
          </div>
        )}
        <span className="app-spacer" />
        <MapSeg
          options={SCOPES}
          value={screen.scope}
          onChange={(scope) => change({ scope })}
          label={t("mapx.scope")}
          text={(s) => t(`mapx.scope.${s}`)}
        />
      </header>

      <div className="screener-cards">
        <MarketSentiment />
        <TrendingSectors markets={markets ?? []} onOpen={setDetails} />
        <TopMovers changes={changes} loading={waiting} onOpen={setDetails} />
        <TrendDistribution changes={changes} loading={waiting} />
      </div>

      <div className="screener-bar">
        <ul className="screener-filters" aria-label={t("screens.filters")}>
          {screen.filters.map((f, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: filters have no id; their place is it
            <li key={i} className="screener-chip">
              <span>{filterText(f)}</span>
              <button
                type="button"
                aria-label={t("screens.removeFilter")}
                title={t("screens.removeFilter")}
                onClick={() => change({ filters: screen.filters.filter((_, j) => j !== i) })}
              >
                <LuX size={13} aria-hidden />
              </button>
            </li>
          ))}
          <li>
            <AddFilter onAdd={(f) => change({ filters: [...screen.filters, f] })} />
          </li>
        </ul>
        <ColumnPicker columns={screen.columns} onChange={(c) => change({ columns: c })} />
      </div>

      <section className="screener-body">
        <ScanActionsContext.Provider value={actions}>
          <div className="screener-meta">
            <label className="screener-search">
              <LuSearch size={14} aria-hidden />
              <input
                type="search"
                value={query}
                placeholder={t("screens.search")}
                aria-label={t("screens.search")}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={(e) => e.key === "Escape" && setQuery("")}
              />
            </label>
            <span className="pd-num">{t("screens.count", { count: found.length })}</span>
            {filling && (
              <span className="pd-muted pd-num">
                {t("screens.filling", { done: progress.done, total: progress.total })}
              </span>
            )}
            <span className="app-spacer" />
            <SaveList markets={shown.map((r) => r.market)} />
          </div>
          {waiting ? (
            <div className="screener-state">
              <LoadingMark size={44} />
            </div>
          ) : shown.length === 0 ? (
            <EmptyState>
              {query.trim() && rows.length > 0
                ? t("screens.noMatch", { query: query.trim() })
                : t(filling ? "screens.waiting" : "screens.none")}
            </EmptyState>
          ) : (
            <div className="screener-scroll">
              <table className="screener-table">
                <thead>
                  <tr>
                    <th aria-label={t("screens.star")} />
                    <th className="screener-rank" title={t("screens.rank")}>
                      #
                    </th>
                    <th
                      aria-sort={
                        screen.sort.column === "marketCap"
                          ? screen.sort.desc
                            ? "descending"
                            : "ascending"
                          : undefined
                      }
                    >
                      {/* Largest market cap first, then smallest on a second click. */}
                      <button
                        type="button"
                        title={t("screens.sortCap")}
                        onClick={() => sortBy("marketCap")}
                      >
                        {t("screens.market")}
                        {screen.sort.column === "marketCap" &&
                          (screen.sort.desc ? (
                            <LuArrowDown size={12} aria-hidden />
                          ) : (
                            <LuArrowUp size={12} aria-hidden />
                          ))}
                      </button>
                    </th>
                    {screen.columns.map((c) => (
                      <th
                        key={c}
                        aria-sort={
                          screen.sort.column === c
                            ? screen.sort.desc
                              ? "descending"
                              : "ascending"
                            : undefined
                        }
                      >
                        <button type="button" onClick={() => sortBy(c)}>
                          {label(c)}
                          {screen.sort.column === c &&
                            (screen.sort.desc ? (
                              <LuArrowDown size={12} aria-hidden />
                            ) : (
                              <LuArrowUp size={12} aria-hidden />
                            ))}
                        </button>
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {shown.map(({ market, values, rank }) => (
                    <tr key={market.id} onClick={() => setDetails(market.id)}>
                      {/* biome-ignore lint/a11y/useKeyWithClickEvents: the star is its own button */}
                      <td onClick={(e) => e.stopPropagation()}>
                        <StarButton
                          starred={watch.starred.has(market.id)}
                          name={market.symbol}
                          size={14}
                          onToggle={() => watch.toggle(market.id)}
                        />
                      </td>
                      <td className="screener-rank pd-num pd-muted">{rank}</td>
                      <td>
                        <button
                          type="button"
                          className="screener-market"
                          title={t("screens.details")}
                          onClick={(e) => {
                            e.stopPropagation();
                            setDetails(market.id);
                          }}
                        >
                          <TokenIcon market={market} />
                          <span>{market.symbol}</span>
                          {market.maxLeverage > 0 && (
                            <span
                              className="screener-lev"
                              title={t("screens.leverage", { value: market.maxLeverage })}
                            >
                              {market.maxLeverage}x
                            </span>
                          )}
                        </button>
                      </td>
                      {screen.columns.map((c) => {
                        const v = values[c];
                        if (SCREEN_UNIT[c] === "rating") {
                          return (
                            <td key={c}>
                              {typeof v === "number" ? <RatingText rating={ratingOf(v)} /> : "-"}
                            </td>
                          );
                        }
                        return (
                          <td
                            key={c}
                            className={`pd-num ${typeof v === "number" && SIGNED.has(c) ? trendClass(v) : ""}`}
                          >
                            {valueText(c, v, market)}
                          </td>
                        );
                      })}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </ScanActionsContext.Provider>
      </section>

      {detailed && (
        <TokenDetails
          key={detailed.id}
          market={detailed}
          venue={venue}
          summary={summaryById.get(detailed.id)}
          starred={watch.starred.has(detailed.id)}
          onStar={() => watch.toggle(detailed.id)}
          onTrade={() => onTrade(venue, detailed.id)}
          onClose={() => setDetails(undefined)}
        />
      )}
    </div>
  );
}

const RATING_ICON = {
  strongBuy: LuChevronsUp,
  buy: LuChevronUp,
  neutral: undefined,
  sell: LuChevronDown,
  strongSell: LuChevronsDown,
} as const;

/** "Strong buy" with its chevrons: green leaning up, red leaning down. */
function RatingText({ rating }: { rating: Rating }) {
  const Icon = RATING_ICON[rating];
  const lean = rating.endsWith("uy") ? "pd-up" : rating.endsWith("ell") ? "pd-down" : "pd-muted";
  return (
    <span className={`screener-rating ${lean}`}>
      {Icon && <Icon size={14} aria-hidden />}
      {t(`screens.rating.${rating}`)}
    </span>
  );
}

function NameInput({ onSave, onCancel }: { onSave: (name: string) => void; onCancel: () => void }) {
  const [name, setName] = useState("");
  const save = () => (name.trim() ? onSave(name.trim()) : onCancel());
  return (
    <input
      className="screener-name"
      // biome-ignore lint/a11y/noAutofocus: it opens to be typed into
      autoFocus
      value={name}
      maxLength={40}
      placeholder={t("screens.name")}
      aria-label={t("screens.name")}
      onChange={(e) => setName(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === "Enter") save();
        if (e.key === "Escape") onCancel();
      }}
      onBlur={save}
    />
  );
}

/** "+ Filter": a column, how it compares, and the value. */
function AddFilter({ onAdd }: { onAdd: (filter: ScreenFilter) => void }) {
  const [open, setOpen] = useState(false);
  const [column, setColumn] = useState<ScreenColumn>("rsi1h");
  const ops = opsFor(column);
  const [op, setOp] = useState<ScreenOp>("below");
  const shownOp = ops.includes(op) ? op : (ops[0] as ScreenOp);
  const states = SCREEN_STATES[column] ?? [];
  const [text, setText] = useState("");
  const [to, setTo] = useState("");
  const [state, setState] = useState("");

  if (!open) {
    return (
      <button type="button" className="screener-add" onClick={() => setOpen(true)}>
        <LuPlus size={13} aria-hidden />
        {t("screens.addFilter")}
      </button>
    );
  }

  const value = parseScreenNumber(text);
  const top = parseScreenNumber(to);
  const pickedState = states.includes(state) ? state : states[0];
  const filter: ScreenFilter | undefined =
    shownOp === "is"
      ? pickedState
        ? { column, op: "is", value: pickedState }
        : undefined
      : value === undefined
        ? undefined
        : shownOp === "between"
          ? top === undefined
            ? undefined
            : { column, op: "between", value, to: top }
          : { column, op: shownOp, value };
  const unit = SCREEN_UNIT[column];
  const hint = t(
    unit === "pct" ? "screens.hintPct" : unit === "usd" ? "screens.hintUsd" : "screens.hintNum",
  );
  const add = () => {
    if (!filter) return;
    onAdd(filter);
    setOpen(false);
    setText("");
    setTo("");
  };

  return (
    <form
      className="screener-form"
      onSubmit={(e) => {
        e.preventDefault();
        add();
      }}
    >
      <Select
        value={column}
        options={SCREEN_COLUMNS.map((c) => ({ value: c, label: label(c) }))}
        onChange={setColumn}
        label={t("screens.column")}
      />
      <Select
        value={shownOp}
        options={ops.map((o) => ({ value: o, label: t(`screens.op.${o}`) }))}
        onChange={setOp}
        label={t("screens.compare")}
      />
      {shownOp === "is" ? (
        <Select
          value={pickedState ?? ""}
          options={states.map((s) => ({ value: s, label: stateLabel(column, s) }))}
          onChange={setState}
          label={t("screens.value")}
        />
      ) : (
        <>
          <input
            // biome-ignore lint/a11y/noAutofocus: it opens to be typed into
            autoFocus
            value={text}
            inputMode="decimal"
            placeholder={hint}
            aria-label={t("screens.value")}
            aria-invalid={text !== "" && value === undefined}
            onChange={(e) => setText(e.target.value)}
          />
          {shownOp === "between" && (
            <input
              value={to}
              inputMode="decimal"
              placeholder={hint}
              aria-label={t("screens.valueTo")}
              aria-invalid={to !== "" && top === undefined}
              onChange={(e) => setTo(e.target.value)}
            />
          )}
        </>
      )}
      <button type="submit" disabled={!filter}>
        {t("screens.add")}
      </button>
      <button type="button" onClick={() => setOpen(false)}>
        {t("screens.cancel")}
      </button>
    </form>
  );
}

/** Which columns show, and in what order. */
function ColumnPicker({
  columns,
  onChange,
}: {
  columns: readonly ScreenColumn[];
  onChange: (columns: ScreenColumn[]) => void;
}) {
  const [open, setOpen] = useState(false);
  const hidden = SCREEN_COLUMNS.filter((c) => !columns.includes(c));
  const move = (i: number, by: number) => {
    const next = [...columns];
    const [c] = next.splice(i, 1);
    if (c) next.splice(i + by, 0, c);
    onChange(next);
  };
  return (
    <div className="screener-columns">
      <button type="button" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        <LuColumns3 size={14} aria-hidden />
        {t("screens.columns")}
      </button>
      {open && (
        <div className="screener-columns-panel">
          <ol>
            {columns.map((c, i) => (
              <li key={c}>
                <span className="screener-col-name">{label(c)}</span>
                <button
                  type="button"
                  className="screener-col-move"
                  aria-label={t("screens.moveUp")}
                  disabled={i === 0}
                  onClick={() => move(i, -1)}
                >
                  <LuArrowUp size={13} aria-hidden />
                </button>
                <button
                  type="button"
                  className="screener-col-move"
                  aria-label={t("screens.moveDown")}
                  disabled={i === columns.length - 1}
                  onClick={() => move(i, 1)}
                >
                  <LuArrowDown size={13} aria-hidden />
                </button>
                <button
                  type="button"
                  className="screener-col-move"
                  aria-label={t("screens.hideColumn")}
                  disabled={columns.length === 1}
                  onClick={() => onChange(columns.filter((x) => x !== c))}
                >
                  <LuX size={13} aria-hidden />
                </button>
              </li>
            ))}
          </ol>
          {hidden.length > 0 && (
            <div className="screener-columns-add">
              <span className="pd-muted">{t("screens.addColumn")}</span>
              <div className="screener-col-chips">
                {hidden.map((c) => (
                  <button
                    key={c}
                    type="button"
                    className="screener-col-add"
                    onClick={() => onChange([...columns, c])}
                  >
                    {label(c)}
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
