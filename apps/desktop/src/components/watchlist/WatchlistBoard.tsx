import type { Candle, Market, MarketHistory, Position, VenueId } from "@pewterdesk/core";
import {
  type AlertDraft,
  type AlertKind,
  decimalsOf,
  distanceToFire,
  EmptyState,
  type FiredAlert,
  formatCompact,
  formatNumber,
  formatSigned,
  type MarketAlert,
  type ScreenerRow,
  Select,
  TokenIcon,
  t,
} from "@pewterdesk/ui";
import { type FormEvent, useEffect, useMemo, useState } from "react";
import { LuBell, LuPlus, LuTrash2, LuX } from "react-icons/lu";
import { venueClient } from "../../api/venueClient";
import { useScreenerData } from "../../hooks/useScreenerData";
import {
  LIST_NAME_MAX,
  lastDay,
  listPerformance,
  marketsOn,
  nearestPriceAlert,
  positionIn,
  rangeShare,
  STARRED,
  useLists,
} from "../../lib/watchlists";
import { useReportError } from "../FeedView";
import { MarketSelect } from "./MarketSelect";

/** What the board needs of the app's market alerts (`hooks/useAlerts`). */
export interface BoardAlerts {
  alerts: readonly MarketAlert[];
  fired: readonly FiredAlert[];
  create: (draft: AlertDraft) => void;
  remove: (id: string) => void;
  currentOf: (venue: VenueId, market: string, kind: AlertKind) => number | undefined;
}

interface WatchlistBoardProps {
  venue: VenueId;
  markets: Market[];
  selected?: string;
  onSelect: (market: Market) => void;
  /** The starred markets on this venue, by id; the "Starred" list. */
  starred: ReadonlySet<string>;
  onToggleStar: (market: Market) => void;
  /** The account's open positions on this venue. */
  positions: readonly Position[];
  alerts: BoardAlerts;
}

const up = (v: number) => (v > 0 ? "up" : v < 0 ? "down" : undefined);
const arrow = (v: number) => (v >= 0 ? "▲" : "▼");

/**
 * The Watchlist tab (after the Watchlist mockup in `design/`): the lists,
 * each list's markets as cards (price, the day's line and range, funding,
 * open interest, volume, your position, the nearest price alert), and the
 * alerts beside them with a form for a new one. Lists other than the
 * starred one are the trader's own; cards show the venue on screen.
 */
export function WatchlistBoard({
  venue,
  markets,
  selected,
  onSelect,
  starred,
  onToggleStar,
  positions,
  alerts,
}: WatchlistBoardProps) {
  const data = useScreenerData(venue, markets, true);
  useReportError(data.error);
  const lists = useLists();
  const { state } = lists;
  const byId = useMemo(() => new Map(markets.map((m) => [m.id, m])), [markets]);
  const rows = useMemo(() => new Map(data.rows.map((r) => [r.market.id, r])), [data.rows]);

  const all = [
    { id: STARRED, name: t("wl.starred"), ids: [...starred] },
    ...state.lists.map((l) => ({ id: l.id, name: l.name, ids: marketsOn(l.keys, venue) })),
  ];
  const active = all.find((l) => l.id === state.active) ?? all[0];
  const shown = (active?.ids ?? []).filter((id) => byId.has(id));
  const fetched = useDayCandles(venue, shown, data.histories);
  /** A market's hourly candles: the screener's, or fetched for the card. */
  const historyOf = (id: string): MarketHistory | undefined =>
    data.histories.get(id) ??
    (fetched.has(id) ? { market: id, interval: "1h", candles: fetched.get(id) ?? [] } : undefined);
  const performance = listPerformance(shown.map((id) => rows.get(id)?.change24h ?? Number.NaN));
  // What an alert watches now: from this board's own prices on the venue on
  // screen, which are always live here; elsewhere, as the alerts read it.
  const nowOf = (v: VenueId, market: string, kind: AlertKind) => {
    const row = v === venue ? rows.get(market) : undefined;
    if (row && kind === "price") return row.price;
    if (row && kind === "funding") return row.funding * 100;
    return alerts.currentOf(v, market, kind);
  };
  const toggleIn = (market: Market) =>
    active?.id === STARRED
      ? onToggleStar(market)
      : lists.toggle(state.active, `${venue}:${market.id}`);

  return (
    // The wrapper is what the board's layout measures (a container query):
    // the panel can be any width.
    <div className="wl-wrap">
      <div className="wl-board">
        <ListsColumn
          lists={all.map((l) => ({
            id: l.id,
            name: l.name,
            count: l.ids.filter((id) => byId.has(id)).length,
          }))}
          active={active?.id ?? STARRED}
          onActive={lists.setActive}
          onCreate={lists.create}
          onRename={lists.rename}
          onRemove={lists.remove}
          performance={performance}
          size={shown.length}
        />
        <section className="wl-cards" aria-label={active?.name}>
          {shown.length === 0 && (
            <EmptyState>{active?.id === STARRED ? t("wl.emptyStarred") : t("wl.empty")}</EmptyState>
          )}
          {shown.map((id) => {
            const market = byId.get(id) as Market;
            return (
              <MarketCard
                key={id}
                market={market}
                row={rows.get(id)}
                day={lastDay(historyOf(id), Date.now())}
                position={positionIn(positions, id)}
                alert={nearestPriceAlert(alerts.alerts, venue, id, rows.get(id)?.price ?? 0)}
                selected={selected === id}
                onSelect={() => onSelect(market)}
                onRemove={() => toggleIn(market)}
              />
            );
          })}
          <AddMarket markets={markets} listed={new Set(shown)} onAdd={(m) => toggleIn(m)} />
        </section>
        <AlertsColumn
          venue={venue}
          markets={markets}
          selected={selected}
          alerts={alerts}
          nowOf={nowOf}
        />
      </div>
    </div>
  );
}

function ListsColumn({
  lists,
  active,
  onActive,
  onCreate,
  onRename,
  onRemove,
  performance,
  size,
}: {
  lists: { id: string; name: string; count: number }[];
  active: string;
  onActive: (id: string) => void;
  onCreate: (name: string) => void;
  onRename: (id: string, name: string) => void;
  onRemove: (id: string) => void;
  performance?: number;
  size: number;
}) {
  const [naming, setNaming] = useState<string>();
  const [editing, setEditing] = useState<{ id: string; name: string }>();
  const submitNew = (e: FormEvent) => {
    e.preventDefault();
    if (naming?.trim()) onCreate(naming);
    setNaming(undefined);
  };
  return (
    <aside className="wl-lists" aria-label={t("wl.lists")}>
      <h3 className="wl-label">{t("wl.lists")}</h3>
      {/* At a narrow width the column folds into this picker. */}
      <Select
        className="wl-list-picker"
        label={t("wl.lists")}
        value={active}
        options={lists.map((l) => ({ value: l.id, label: `${l.name} (${l.count})` }))}
        onChange={onActive}
      />
      <ul className="wl-list-items">
        {lists.map((l) => (
          <li key={l.id}>
            {editing?.id === l.id ? (
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  onRename(l.id, editing.name);
                  setEditing(undefined);
                }}
              >
                <input
                  className="wl-input"
                  aria-label={t("wl.rename")}
                  maxLength={LIST_NAME_MAX}
                  value={editing.name}
                  // biome-ignore lint/a11y/noAutofocus: renaming starts in the field
                  autoFocus
                  onChange={(e) => setEditing({ id: l.id, name: e.target.value })}
                  onBlur={() => setEditing(undefined)}
                />
              </form>
            ) : (
              <button
                type="button"
                className="wl-list"
                aria-current={active === l.id || undefined}
                onClick={() => onActive(l.id)}
                onDoubleClick={() => l.id !== STARRED && setEditing({ id: l.id, name: l.name })}
                title={l.id === STARRED ? undefined : t("wl.renameHint")}
              >
                <span>{l.name}</span>
                <span className="wl-count pd-num">{l.count}</span>
              </button>
            )}
            {l.id !== STARRED && editing?.id !== l.id && (
              <button
                type="button"
                className="wl-list-remove"
                aria-label={t("wl.removeList", { name: l.name })}
                title={t("wl.removeList", { name: l.name })}
                onClick={() => onRemove(l.id)}
              >
                <LuTrash2 size={13} aria-hidden />
              </button>
            )}
          </li>
        ))}
      </ul>
      {naming === undefined ? (
        <button type="button" className="wl-new-list" onClick={() => setNaming("")}>
          <LuPlus size={14} aria-hidden />
          {t("wl.newList")}
        </button>
      ) : (
        <form className="wl-new-list-form" onSubmit={submitNew}>
          <input
            className="wl-input"
            aria-label={t("wl.newList")}
            placeholder={t("wl.listName")}
            maxLength={LIST_NAME_MAX}
            value={naming}
            // biome-ignore lint/a11y/noAutofocus: naming starts in the field
            autoFocus
            onChange={(e) => setNaming(e.target.value)}
            onBlur={() => !naming.trim() && setNaming(undefined)}
          />
        </form>
      )}
      <div className="wl-performance">
        <span className="wl-label">{t("wl.performance")}</span>
        {performance === undefined ? (
          <strong className="pd-num">-</strong>
        ) : (
          <strong className="pd-num" data-trend={up(performance)}>
            {`${arrow(performance)} ${formatSigned(performance * 100)}%`}
          </strong>
        )}
        <span className="pd-muted">{t("wl.performanceNote", { count: size })}</span>
      </div>
    </aside>
  );
}

function MarketCard({
  market,
  row,
  day,
  position,
  alert,
  selected,
  onSelect,
  onRemove,
}: {
  market: Market;
  row?: ScreenerRow;
  day?: { low: number; high: number; closes: number[] };
  position?: Position;
  alert?: MarketAlert;
  selected: boolean;
  onSelect: () => void;
  onRemove: () => void;
}) {
  const decimals = row ? decimalsOf(row.rawPrice) : decimalsOf(market.tickSize);
  const price = (v: number) => formatNumber(v, decimals);
  const pnl = position ? Number(position.unrealizedPnl) : 0;
  return (
    // biome-ignore lint/a11y/useSemanticElements: a card holding its own buttons, so not a button itself
    <div
      className="wl-card"
      data-selected={selected || undefined}
      role="button"
      tabIndex={0}
      aria-label={market.symbol}
      onClick={onSelect}
      onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && onSelect()}
    >
      <header className="wl-card-head">
        <TokenIcon market={market} size={18} />
        <strong>{market.symbol}</strong>
        <span className="wl-chip pd-num">{`${market.maxLeverage}x`}</span>
        <span className="wl-spacer" />
        {alert && (
          <span className="wl-alert-chip pd-num" title={t("wl.alertAt")}>
            <LuBell size={12} aria-hidden />
            {price(alert.value)}
          </span>
        )}
        <button
          type="button"
          className="wl-card-remove"
          aria-label={t("wl.removeMarket", { symbol: market.symbol })}
          title={t("wl.removeMarket", { symbol: market.symbol })}
          onClick={(e) => {
            e.stopPropagation();
            onRemove();
          }}
        >
          <LuX size={13} aria-hidden />
        </button>
      </header>
      {row ? (
        <p className="wl-price">
          <span className="pd-num">{price(row.price)}</span>
          <small className="pd-num" data-trend={up(row.change24h)}>
            {`${arrow(row.change24h)} ${formatSigned(row.change24h * 100)}%`}
          </small>
        </p>
      ) : (
        <p className="wl-price wl-loading">{t("feed.loading")}</p>
      )}
      <Area values={day?.closes ?? row?.spark?.slice(-24) ?? []} change={row?.change24h} />
      {day && row && (
        <div className="wl-range">
          <span className="wl-range-bar" aria-hidden>
            <span style={{ left: `${rangeShare(row.price, day.low, day.high) * 100}%` }} />
          </span>
          <span className="wl-range-labels pd-num">
            <span>{`L ${price(day.low)}`}</span>
            <span>{t("wl.range")}</span>
            <span>{`H ${price(day.high)}`}</span>
          </span>
        </div>
      )}
      {row && (
        <dl className="wl-stats">
          <div>
            <dt>{t("wl.funding")}</dt>
            <dd className="pd-num">{`${formatSigned(row.funding * 100, 4)}%`}</dd>
          </div>
          <div>
            <dt>{t("wl.oi")}</dt>
            <dd className="pd-num">{`$${formatCompact(row.openInterest)}`}</dd>
          </div>
          <div>
            <dt>{t("wl.volume")}</dt>
            <dd className="pd-num">{`$${formatCompact(row.volume)}`}</dd>
          </div>
        </dl>
      )}
      <footer className="wl-card-foot">
        {position ? (
          <>
            <span data-trend={position.side === "long" ? "up" : "down"}>
              {t(position.side === "long" ? "wl.long" : "wl.short", {
                size: formatNumber(Number(position.size), decimalsOf(market.sizeStep)),
              })}
            </span>
            <span className="pd-num" data-trend={up(pnl)}>
              {`${arrow(pnl)} ${formatSigned(pnl)}`}
            </span>
          </>
        ) : (
          <>
            <span className="pd-muted">{t("wl.noPosition")}</span>
            <span className="pd-muted">-</span>
          </>
        )}
      </footer>
    </div>
  );
}

/**
 * The day's closes as a filled line, coloured as the 24h change is (so it
 * agrees with the figure above it), or by which way the line went.
 */
function Area({ values, change }: { values: readonly number[]; change?: number }) {
  if (values.length < 2) return <div className="wl-area wl-area-empty" aria-hidden />;
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || 1;
  const points = values.map((v, i) => [
    (i / (values.length - 1)) * 100,
    38 - ((v - min) / span) * 34,
  ]);
  const line = points
    .map(([x, y], i) => `${i ? "L" : "M"}${x?.toFixed(2)},${y?.toFixed(2)}`)
    .join(" ");
  const rose = change === undefined ? (values.at(-1) ?? 0) >= (values[0] ?? 0) : change >= 0;
  const trend = rose ? "up" : "down";
  return (
    <svg
      className="wl-area"
      data-trend={trend}
      viewBox="0 0 100 40"
      preserveAspectRatio="none"
      aria-hidden
    >
      <path className="wl-area-fill" d={`${line} L100,40 L0,40 Z`} />
      <path className="wl-area-line" d={line} vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

/** A card at the end of the list for adding a market to it. */
function AddMarket({
  markets,
  listed,
  onAdd,
}: {
  markets: readonly Market[];
  listed: ReadonlySet<string>;
  onAdd: (market: Market) => void;
}) {
  return (
    <div className="wl-card wl-add">
      <span className="wl-label">{t("wl.addMarket")}</span>
      <MarketSelect
        markets={markets}
        exclude={listed}
        onPick={onAdd}
        label={t("wl.addMarket")}
        fixed
        placeholder={
          <>
            <LuPlus size={14} aria-hidden />
            {t("wl.addPlaceholder")}
          </>
        }
      />
    </div>
  );
}

type FormKind = "above" | "below" | "funding";

type NowOf = (venue: VenueId, market: string, kind: AlertKind) => number | undefined;

function AlertsColumn({
  venue,
  markets,
  selected,
  alerts,
  nowOf,
}: {
  venue: VenueId;
  markets: readonly Market[];
  selected?: string;
  alerts: BoardAlerts;
  nowOf: NowOf;
}) {
  const active = alerts.alerts.filter((a) => a.active);
  const last = alerts.fired[0];
  /**
   * The market an alert is on, for its logo. Alerts on another venue aren't
   * in `markets`; the icon needs only the id and venue to fetch theirs.
   */
  const marketOf = (a: Pick<MarketAlert, "venue" | "market" | "symbol">): Market =>
    (a.venue === venue ? markets.find((m) => m.id === a.market) : undefined) ??
    ({ id: a.market, venue: a.venue, symbol: a.symbol, base: a.symbol.split("-")[0] } as Market);
  const time = new Intl.DateTimeFormat("en-GB", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZone: "UTC",
  });
  const valueText = (a: Pick<MarketAlert, "kind" | "value">) =>
    a.kind === "funding" ? `${formatNumber(a.value, 4)}%` : formatNumber(a.value);
  return (
    <aside className="wl-alerts" aria-label={t("wl.alerts")}>
      <h3 className="wl-alerts-head">
        {t("wl.alerts")}
        <span className="pd-muted pd-num">{t("wl.activeCount", { count: active.length })}</span>
      </h3>
      {last && (
        <div className="wl-triggered" role="status">
          <span className="wl-triggered-top">
            <strong className="wl-alert-coin">
              <TokenIcon market={marketOf(last)} size={16} />
              {t("wl.triggered")}
            </strong>
            <span className="pd-num">{`${time.format(last.time)} UTC`}</span>
          </span>
          <p>
            {t(last.condition === "above" ? "wl.crossedAbove" : "wl.crossedBelow", {
              symbol: last.symbol,
              value: valueText(last),
            })}
          </p>
          <span className="pd-muted">
            {(last.notify ?? [])
              .map((c) =>
                c === "desktop"
                  ? t("wl.sentDesktop")
                  : c === "sound"
                    ? t("wl.sentSound")
                    : undefined,
              )
              .filter(Boolean)
              .join(" · ") || t("wl.sentApp")}
          </span>
        </div>
      )}
      <h4 className="wl-label">{t("wl.active")}</h4>
      {active.length === 0 ? (
        <p className="pd-muted wl-none">{t("wl.noAlerts")}</p>
      ) : (
        <ul className="wl-alert-rows">
          {active.map((a) => {
            const now = nowOf(a.venue, a.market, a.kind);
            const gap = distanceToFire(a, now);
            return (
              <li key={a.id}>
                <strong className="wl-alert-coin">
                  <TokenIcon market={marketOf(a)} size={16} />
                  {a.symbol.split("-")[0]}
                </strong>
                <span>
                  {t(
                    a.kind === "funding"
                      ? a.condition === "above"
                        ? "wl.fundingAbove"
                        : "wl.fundingBelow"
                      : a.condition === "above"
                        ? "wl.crossesAbove"
                        : "wl.crossesBelow",
                  )}{" "}
                  <span className="pd-num">{valueText(a)}</span>
                </span>
                <span className="pd-muted pd-num">
                  {a.kind === "funding"
                    ? now === undefined
                      ? "-"
                      : t("wl.now", { value: `${formatNumber(now, 4)}%` })
                    : gap === undefined
                      ? "-"
                      : `${formatSigned(gap * 100, 1)}%`}
                </span>
                <button
                  type="button"
                  className="wl-alert-remove"
                  aria-label={t("wl.removeAlert")}
                  title={t("wl.removeAlert")}
                  onClick={() => alerts.remove(a.id)}
                >
                  <LuX size={12} aria-hidden />
                </button>
              </li>
            );
          })}
        </ul>
      )}
      <NewAlert venue={venue} markets={markets} selected={selected} alerts={alerts} nowOf={nowOf} />
    </aside>
  );
}

function NewAlert({
  venue,
  markets,
  selected,
  alerts,
  nowOf,
}: {
  venue: VenueId;
  markets: readonly Market[];
  selected?: string;
  alerts: BoardAlerts;
  nowOf: NowOf;
}) {
  const [market, setMarket] = useState(selected ?? markets[0]?.id ?? "");
  const [kind, setKind] = useState<FormKind>("above");
  const [value, setValue] = useState("");
  const [desktop, setDesktop] = useState(true);
  const [sound, setSound] = useState(true);
  const [repeat, setRepeat] = useState(false);
  // The market on screen, until another one is picked here.
  useEffect(() => {
    if (selected) setMarket(selected);
  }, [selected]);
  const watched: AlertKind = kind === "funding" ? "funding" : "price";
  const now = market ? nowOf(venue, market, watched) : undefined;
  const found = markets.find((m) => m.id === market);
  const amount = Number(value);
  const valid = found !== undefined && value.trim() !== "" && Number.isFinite(amount);
  const create = (e: FormEvent) => {
    e.preventDefault();
    if (!valid || !found) return;
    // Funding fires on whichever side of now its line is.
    const condition =
      kind === "funding" ? (now !== undefined && amount < now ? "below" : "above") : kind;
    alerts.create({
      kind: watched,
      venue,
      market: found.id,
      symbol: found.symbol,
      condition,
      value: amount,
      repeat: repeat ? "every" : "once",
      notify: [
        "app",
        ...(desktop ? (["desktop"] as const) : []),
        ...(sound ? (["sound"] as const) : []),
      ],
    });
    setValue("");
  };
  return (
    <form className="wl-new-alert" onSubmit={create}>
      <h4>{t("wl.newAlert")}</h4>
      <div className="wl-new-alert-fields">
        <div className="wl-field">
          <span>{t("wl.market")}</span>
          <MarketSelect
            markets={markets}
            value={market}
            onPick={(m) => setMarket(m.id)}
            label={t("wl.market")}
            placeholder={t("wl.market")}
          />
        </div>
        <label>
          <span>{kind === "funding" ? t("wl.fundingPct") : t("wl.price")}</span>
          <input
            className="wl-input pd-num"
            inputMode="decimal"
            placeholder={
              now === undefined ? "" : formatNumber(now, kind === "funding" ? 4 : undefined)
            }
            value={value}
            onChange={(e) => setValue(e.target.value.replace(",", "."))}
          />
        </label>
      </div>
      <div className="wl-seg" role="radiogroup" aria-label={t("wl.condition")}>
        {(["above", "below", "funding"] as const).map((k) => (
          // biome-ignore lint/a11y/useSemanticElements: a segmented choice, like the app's others
          <button
            key={k}
            type="button"
            role="radio"
            aria-checked={kind === k}
            onClick={() => setKind(k)}
          >
            {t(
              k === "above"
                ? "wl.crossesAboveShort"
                : k === "below"
                  ? "wl.crossesBelowShort"
                  : "wl.funding",
            )}
          </button>
        ))}
      </div>
      <div className="wl-checks">
        <label>
          <input type="checkbox" checked={desktop} onChange={(e) => setDesktop(e.target.checked)} />
          {t("wl.desktop")}
        </label>
        <label>
          <input type="checkbox" checked={sound} onChange={(e) => setSound(e.target.checked)} />
          {t("wl.sound")}
        </label>
        <label>
          <input type="checkbox" checked={repeat} onChange={(e) => setRepeat(e.target.checked)} />
          {t("wl.repeat")}
        </label>
      </div>
      <button type="submit" className="wl-create" disabled={!valid}>
        {t("wl.create")}
      </button>
    </form>
  );
}

/** How often a card's own candles are read again. */
const DAY_REFRESH_MS = 10 * 60_000;
/** Hourly candles a card reads: the last day, and one before it. */
const DAY_CANDLES = 26;

/**
 * The last day's hourly candles for the cards the screener's history hasn't
 * reached yet (it streams the busiest markets first, so a quiet one can take
 * minutes): read one market at a time, and again every few minutes.
 */
function useDayCandles(
  venue: VenueId,
  ids: readonly string[],
  histories: ReadonlyMap<string, MarketHistory>,
): ReadonlyMap<string, Candle[]> {
  const [read, setRead] = useState<{
    venue: VenueId;
    at: Map<string, number>;
    candles: Map<string, Candle[]>;
  }>(() => ({ venue, at: new Map(), candles: new Map() }));
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setTick((n) => n + 1), DAY_REFRESH_MS);
    return () => clearInterval(id);
  }, []);
  const wanted = ids.filter((id) => !histories.has(id)).join("|");
  // biome-ignore lint/correctness/useExhaustiveDependencies: `tick` reads them again; `wanted` stands for the ids
  useEffect(() => {
    const fresh = read.venue === venue ? read : { venue, at: new Map(), candles: new Map() };
    const due = wanted
      .split("|")
      .filter((id) => id && Date.now() - (fresh.at.get(id) ?? 0) >= DAY_REFRESH_MS);
    if (due.length === 0) return;
    let live = true;
    void (async () => {
      for (const id of due) {
        if (!live) return;
        try {
          const candles = await venueClient.candles(venue, id, "1h", Date.now() + 1, DAY_CANDLES);
          if (!live) return;
          setRead((r) => {
            const base = r.venue === venue ? r : { venue, at: new Map(), candles: new Map() };
            return {
              venue,
              at: new Map(base.at).set(id, Date.now()),
              candles: new Map(base.candles).set(id, candles),
            };
          });
        } catch {
          // Tried again on the next round.
        }
      }
    })();
    return () => {
      live = false;
    };
  }, [venue, wanted, tick]);
  return read.venue === venue ? read.candles : new Map();
}
