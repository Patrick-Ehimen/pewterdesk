import type { Candle, Market, MarketSummary, VenueId } from "@pewterdesk/core";
import {
  decimalsOf,
  formatNumber,
  formatSigned,
  type IconLoader,
  ListedBy,
  matchesSearch,
  Sparkline,
  TokenIcon,
  TokenIconProvider,
  t,
} from "@pewterdesk/ui";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { LuExternalLink, LuPower, LuSearch } from "react-icons/lu";
import { appClient } from "../api/appClient";
import { venueClient } from "../api/venueClient";
import { useStoredChoice } from "../hooks/useStoredChoice";
import { TRAY_MODE_LABEL, TRAY_MODES, type TrayMode } from "../hooks/useTraySync";
import { useAccount, useMarketSummaries, useMarkets } from "../hooks/useVenueFeeds";
import { parseWatchlist, watchKey } from "../hooks/useWatchlist";
import { connectedAddress } from "../lib/account";
import { loadMarket } from "../lib/selectedMarket";
import {
  loadMarkets,
  loadSpark,
  loadSummaries,
  saveMarkets,
  saveSpark,
  saveSummaries,
} from "../lib/trayCache";

const VENUE: VenueId = "hyperliquid";
const VENUE_LABEL = "Hyperliquid";
/** Market logos, as in the main window; stable so TokenIcon's cache holds. */
const loadIcon: IconLoader = (market) => venueClient.marketIcon(VENUE, market);
/** The hero moves on to the next market this often. */
const HERO_ADVANCE_MS = 5000;
/** Top Movers lists this many, biggest 24h move first. */
const MOVERS = 25;
/** The hero's sparkline: the last 24 hours in 15-minute candles. */
const SPARK_CANDLES = 96;

type Tab = "favorites" | "movers";
type Group = "perps" | "hip3";
type SortBy = "price" | "change";

interface Row {
  market: Market;
  summary?: MarketSummary;
  price?: number;
  change?: number;
}

/** The watchlist as saved by the main window (the two share storage). */
function readWatchlist(): string[] {
  try {
    const prefix = watchKey(VENUE, "");
    return parseWatchlist(localStorage.getItem("pd.watchlist"))
      .filter((k) => k.startsWith(prefix))
      .map((k) => k.slice(prefix.length));
  } catch {
    return [];
  }
}

/** Whether the panel is showing: it's only ever visible while focused. */
function useOpen() {
  const [open, setOpen] = useState(() => document.hasFocus());
  useEffect(() => {
    const on = () => setOpen(true);
    const off = () => setOpen(false);
    window.addEventListener("focus", on);
    window.addEventListener("blur", off);
    return () => {
      window.removeEventListener("focus", on);
      window.removeEventListener("blur", off);
    };
  }, []);
  return open;
}

/** Cached prices are saved at most this often while live ones stream in. */
const SAVE_SUMMARIES_MS = 15_000;

/**
 * The last 24 hours of `market` in 15-minute closes, for the hero's
 * sparkline: the cached line at once, fetched again only once it's stale.
 */
function useSparkline(market: string | undefined, enabled: boolean): number[] {
  const [closes, setCloses] = useState<number[]>([]);
  useEffect(() => {
    if (!market || !enabled) return;
    const cached = loadSpark(market);
    setCloses(cached?.closes ?? []);
    if (cached?.fresh) return;
    let current = true;
    venueClient.candles(VENUE, market, "15m", Date.now(), SPARK_CANDLES).then(
      (candles: Candle[]) => {
        const fresh = candles.map((c) => Number(c.close));
        saveSpark(market, fresh);
        if (current) setCloses(fresh);
      },
      () => {},
    );
    return () => {
      current = false;
    };
  }, [market, enabled]);
  return closes;
}

const trendOf = (v: number | undefined) =>
  v === undefined ? undefined : v >= 0 ? ("up" as const) : ("down" as const);

/** A shimmering placeholder bar, like the main window's skeletons. */
const Skel = ({ width, height = 9 }: { width: number; height?: number }) => (
  <span className="pd-skel" style={{ width, height }} aria-hidden />
);

/** Rows shown while the list has nothing to show yet. */
const SKELETON_ROWS = [74, 62, 80, 58, 70, 66];

const priceText = (row: Row) =>
  row.summary ? formatNumber(row.summary.markPrice, decimalsOf(row.summary.markPrice)) : "—";

/**
 * The menu-bar (tray) panel, after the exchange-style tray menus: search,
 * a hero card for the market on screen (or a favourite) with its 24h
 * sparkline, Favorites and Top Movers split into Perps and HIP-3, then the
 * account, what the menu bar shows, and open / quit. Prices are fetched
 * only while it's open.
 */
export function TrayPanel() {
  const open = useOpen();
  const rootRef = useRef<HTMLElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState("");
  const [starred, setStarred] = useState(readWatchlist);
  const [onScreen, setOnScreen] = useState(loadMarket);
  const [tab, setTab] = useState<Tab>("favorites");
  const [group, setGroup] = useState<Group>("perps");
  const [sort, setSort] = useState<{ by: SortBy; descending: boolean }>();
  const [heroIndex, setHeroIndex] = useState(0);
  // Paused while the pointer is on the hero, so a price can be read.
  const [heroHeld, setHeroHeld] = useState(false);
  // Bumped by a dot click, which restarts the countdown.
  const [heroPicked, setHeroPicked] = useState(0);

  // Each opening: re-read what the main window may have changed, start
  // fresh, and put the cursor in the search box.
  useEffect(() => {
    if (!open) return;
    setStarred(readWatchlist());
    setOnScreen(loadMarket());
    setQuery("");
    setHeroIndex(0);
    searchRef.current?.focus();
  }, [open]);

  // Live data when there is some; until then, what the panel last saw, so
  // it draws at once and refreshes behind it.
  const markets = useMarkets(VENUE);
  const [cachedMarkets] = useState(loadMarkets);
  const liveMarkets = markets.status === "live" ? markets.data : undefined;
  useEffect(() => {
    if (liveMarkets) saveMarkets(liveMarkets);
  }, [liveMarkets]);
  const marketList = liveMarkets ?? cachedMarkets;

  const summaries = useMarketSummaries(VENUE, open);
  const [cachedSummaries] = useState(loadSummaries);
  const liveSummaries =
    summaries.status === "live" || summaries.status === "closed" ? summaries.data : undefined;
  const savedAt = useRef(0);
  useEffect(() => {
    if (!liveSummaries || Date.now() - savedAt.current < SAVE_SUMMARIES_MS) return;
    savedAt.current = Date.now();
    saveSummaries(liveSummaries);
  }, [liveSummaries]);
  const bySummary = new Map((liveSummaries ?? cachedSummaries).map((s) => [s.market, s]));
  const rowOf = (market: Market): Row => {
    const summary = bySummary.get(market.id);
    const price = Number(summary?.markPrice);
    const prev = Number(summary?.prevDayPrice);
    return {
      market,
      summary,
      price: summary ? price : undefined,
      change: prev > 0 ? (price - prev) / prev : undefined,
    };
  };
  const find = (id: string | undefined) => marketList.find((m) => m.id === id);

  // The hero: the market on screen, then the favourites, one at a time.
  const heroMarkets = [find(onScreen), ...starred.map(find)].filter(
    (m, i, all): m is Market => m !== undefined && all.findIndex((x) => x?.id === m.id) === i,
  );
  const hero = heroMarkets[heroIndex % Math.max(heroMarkets.length, 1)];
  // Moves on by itself while the panel is open and there's somewhere to go.
  const heroCount = heroMarkets.length;
  // biome-ignore lint/correctness/useExhaustiveDependencies: `heroPicked` restarts the timer after a dot click
  useEffect(() => {
    if (!open || heroHeld || heroCount < 2) return;
    const id = setInterval(() => setHeroIndex((i) => (i + 1) % heroCount), HERO_ADVANCE_MS);
    return () => clearInterval(id);
  }, [open, heroHeld, heroCount, heroPicked]);
  const heroRow = hero && rowOf(hero);
  const spark = useSparkline(hero?.id, open);

  // With nothing starred there's no Favorites tab.
  const hasFavorites = starred.length > 0;
  const activeTab: Tab = hasFavorites ? tab : "movers";
  const inGroup = (m: Market) => (group === "hip3" ? Boolean(m.listedBy) : !m.listedBy);
  const pool = (() => {
    const needle = query.trim();
    if (needle) return marketList.filter((m) => matchesSearch(m, needle)).map(rowOf);
    if (activeTab === "favorites")
      return starred
        .map(find)
        .filter((m): m is Market => !!m)
        .map(rowOf);
    return marketList
      .map(rowOf)
      .filter((r) => r.change !== undefined)
      .sort((a, b) => Math.abs(b.change ?? 0) - Math.abs(a.change ?? 0))
      .slice(0, MOVERS * 2);
  })();
  const counts = {
    perps: pool.filter((r) => !r.market.listedBy).length,
    hip3: pool.filter((r) => r.market.listedBy).length,
  };
  let rows = pool.filter((r) => inGroup(r.market));
  if (!query.trim() && activeTab === "movers") rows = rows.slice(0, MOVERS);
  if (sort) {
    const key = (r: Row) => (sort.by === "price" ? r.price : r.change);
    const dir = sort.descending ? -1 : 1;
    rows = [...rows].sort((a, b) => {
      const x = key(a);
      const y = key(b);
      if (x === undefined || y === undefined) return x === undefined ? 1 : -1;
      return dir * (x - y);
    });
  }

  // Nothing to show yet: no market list (live or saved), or, for Top
  // Movers, no prices to rank by.
  const waiting = marketList.length === 0 && markets.status !== "error";
  const listWaiting =
    !query.trim() &&
    (waiting || (activeTab === "movers" && bySummary.size === 0 && rows.length === 0));

  const address = connectedAddress();
  const account = useAccount(VENUE, open ? address : undefined);
  const snapshot =
    account.status === "live" || account.status === "closed" ? account.data : undefined;
  const pnl = snapshot?.positions.reduce((sum, p) => sum + Number(p.unrealizedPnl), 0);

  const [mode, setMode] = useStoredChoice<TrayMode>("pd.tray.mode", TRAY_MODES, "pricePnl");
  const pickMode = (next: TrayMode) => {
    setMode(next);
    void appClient.setTrayMode(next);
  };

  // Fit the window to what's in it.
  useLayoutEffect(() => {
    const height = rootRef.current?.getBoundingClientRect().height;
    if (height) void appClient.resizeTrayPanel(Math.ceil(height));
  });

  // ⌘O opens pewterdesk, ⌘Q quits, Escape clears the search, then closes.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      if (mod && e.key.toLowerCase() === "o") void appClient.openMainFromTray();
      else if (mod && e.key.toLowerCase() === "q") void appClient.quitFromTray();
      else if (e.key === "Escape") {
        if (searchRef.current?.value) setQuery("");
        else window.blur();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const sortHeader = (by: SortBy, label: string) => {
    const active = sort?.by === by;
    return (
      <button
        type="button"
        className="tray-sort"
        data-active={active || undefined}
        onClick={() =>
          setSort((s) =>
            s?.by === by ? { by, descending: !s.descending } : { by, descending: true },
          )
        }
      >
        {label}
        <span aria-hidden>{active ? (sort?.descending ? "▼" : "▲") : "↕"}</span>
      </button>
    );
  };

  return (
    <TokenIconProvider load={loadIcon}>
      <main ref={rootRef} className="tray-panel" aria-label={t("tray.panel")}>
        <label className="tray-search">
          <LuSearch size={15} aria-hidden />
          <input
            ref={searchRef}
            type="search"
            placeholder={t("markets.search")}
            aria-label={t("markets.search")}
            spellCheck={false}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </label>

        {/* Nothing loaded yet (first launch, no saved data): a hero-shaped placeholder */}
        {!hero && waiting && !query.trim() && (
          <section className="tray-hero" aria-busy="true">
            <span className="tray-hero-main tray-hero-skel">
              <span className="tray-hero-top">
                <span className="pd-skel tray-skel-dot" aria-hidden />
                <span className="tray-hero-name">
                  <Skel width={78} height={11} />
                  <Skel width={40} />
                </span>
              </span>
              <span className="tray-hero-price">
                <Skel width={92} height={16} />
              </span>
              <span className="tray-hero-spark">
                <Skel width={120} height={40} />
              </span>
            </span>
          </section>
        )}

        {hero && heroRow && !query.trim() && (
          <section
            className="tray-hero"
            aria-label={hero.symbol}
            onPointerEnter={() => setHeroHeld(true)}
            onPointerLeave={() => setHeroHeld(false)}
          >
            <button
              type="button"
              // Re-keyed per market, so each one fades in.
              key={hero.id}
              className="tray-hero-main"
              onClick={() => void appClient.selectMarketFromTray(hero.id)}
            >
              <span className="tray-hero-top">
                <TokenIcon market={hero} size={22} />
                <span className="tray-hero-name">
                  <strong>{hero.symbol}</strong>
                  {heroRow.summary ? (
                    <span className="pd-num" data-trend={trendOf(heroRow.change)}>
                      {heroRow.change === undefined
                        ? "—"
                        : `${formatSigned(heroRow.change * 100)}%`}
                    </span>
                  ) : (
                    <Skel width={40} />
                  )}
                </span>
              </span>
              <span className="tray-hero-price pd-num" data-trend={trendOf(heroRow.change)}>
                {heroRow.summary ? priceText(heroRow) : <Skel width={92} height={16} />}
              </span>
              <span className="tray-hero-spark">
                {spark.length > 1 ? (
                  <Sparkline values={spark} width={120} height={40} />
                ) : (
                  <Skel width={120} height={40} />
                )}
              </span>
            </button>
            {heroMarkets.length > 1 && (
              <div className="tray-dots" role="tablist" aria-label={t("tab.watchlist")}>
                {heroMarkets.map((m, i) => (
                  <button
                    key={m.id}
                    type="button"
                    role="tab"
                    aria-selected={m.id === hero.id}
                    aria-label={m.symbol}
                    onClick={() => {
                      setHeroIndex(i);
                      setHeroPicked((n) => n + 1);
                    }}
                  />
                ))}
              </div>
            )}
          </section>
        )}

        <section className="tray-markets">
          {!query.trim() && (
            <div className="tray-tabs" role="tablist">
              {hasFavorites && (
                <button
                  type="button"
                  role="tab"
                  aria-selected={activeTab === "favorites"}
                  onClick={() => setTab("favorites")}
                >
                  {t("picker.favorites")}
                </button>
              )}
              <button
                type="button"
                role="tab"
                aria-selected={activeTab === "movers"}
                onClick={() => setTab("movers")}
              >
                {t("screener.filter.movers")}
              </button>
            </div>
          )}
          <div className="tray-groups" role="radiogroup">
            {(["perps", "hip3"] as const).map((g) => (
              // biome-ignore lint/a11y/useSemanticElements: chip-style radio, like the app's others
              <button
                key={g}
                type="button"
                role="radio"
                aria-checked={group === g}
                onClick={() => setGroup(g)}
              >
                {t(g === "perps" ? "picker.perps" : "screener.filter.builder")} ({counts[g]})
              </button>
            ))}
          </div>
          <div className="tray-head">
            <span>{t("picker.name")}</span>
            {sortHeader("price", t("col.price"))}
            {sortHeader("change", t("picker.change"))}
          </div>
          <ul className="tray-list" aria-busy={listWaiting || undefined}>
            {listWaiting &&
              SKELETON_ROWS.map((w, i) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: fixed placeholder rows
                <li key={i} className="tray-skel-row" aria-hidden>
                  <span className="tray-coin">
                    <Skel width={w} />
                    <Skel width={24} />
                  </span>
                  <Skel width={58} />
                  <Skel width={44} />
                </li>
              ))}
            {rows.map((r) => (
              <li key={r.market.id}>
                <button
                  type="button"
                  onClick={() => void appClient.selectMarketFromTray(r.market.id)}
                >
                  <span className="tray-coin">
                    <strong>{r.market.symbol}</strong>
                    <span className="pd-lev">{r.market.maxLeverage}x</span>
                    <ListedBy market={r.market} hint={false} />
                  </span>
                  <span className="pd-num" data-trend={trendOf(r.change)}>
                    {r.summary ? priceText(r) : <Skel width={58} />}
                  </span>
                  <span className="pd-num tray-change" data-trend={trendOf(r.change)}>
                    {!r.summary ? (
                      <Skel width={44} />
                    ) : r.change === undefined ? (
                      "—"
                    ) : (
                      `${formatSigned(r.change * 100)}%`
                    )}
                  </span>
                </button>
              </li>
            ))}
          </ul>
          {rows.length === 0 && query.trim() && (
            <p className="tray-muted tray-empty">{t("markets.noMatch", { query: query.trim() })}</p>
          )}
        </section>

        <section className="tray-section" aria-labelledby="tray-account">
          <h2 id="tray-account" className="tray-label">
            {t("tray.account")} · {VENUE_LABEL}
          </h2>
          {snapshot ? (
            <>
              <p className="tray-equity pd-num">
                {formatNumber(snapshot.equity, 2)}
                {pnl !== undefined && <span data-trend={trendOf(pnl)}> {formatSigned(pnl)}</span>}
              </p>
              <ul className="tray-positions">
                {snapshot.positions.map((p) => {
                  const upnl = Number(p.unrealizedPnl);
                  return (
                    <li key={`${p.market}:${p.side}`}>
                      <span>
                        <strong>{p.market}</strong>{" "}
                        <span data-trend={p.side === "long" ? "up" : "down"}>
                          {t(p.side === "long" ? "side.long" : "side.short").toLowerCase()}{" "}
                          {formatNumber(p.size)}
                        </span>
                      </span>
                      <span className="pd-num" data-trend={trendOf(upnl)}>
                        {formatSigned(upnl)}
                      </span>
                    </li>
                  );
                })}
              </ul>
            </>
          ) : (
            <p className="tray-muted">{t("tray.noAccount")}</p>
          )}
        </section>

        <section className="tray-section" aria-labelledby="tray-show">
          <h2 id="tray-show" className="tray-label">
            {t("tray.showInMenuBar")}
          </h2>
          <div className="tray-modes" role="radiogroup" aria-labelledby="tray-show">
            {TRAY_MODES.map((m) => (
              // biome-ignore lint/a11y/useSemanticElements: compact segmented control, like the app's others
              <button
                key={m}
                type="button"
                role="radio"
                aria-checked={m === mode}
                onClick={() => pickMode(m)}
              >
                {t(TRAY_MODE_LABEL[m])}
              </button>
            ))}
          </div>
        </section>

        <nav className="tray-actions">
          <button type="button" onClick={() => void appClient.openMainFromTray()}>
            <LuExternalLink size={15} aria-hidden />
            <span>{t("tray.open")}</span>
            <kbd>⌘ O</kbd>
          </button>
          <button type="button" onClick={() => void appClient.quitFromTray()}>
            <LuPower size={15} aria-hidden />
            <span>{t("tray.quit")}</span>
            <kbd>⌘ Q</kbd>
          </button>
        </nav>
      </main>
    </TokenIconProvider>
  );
}
