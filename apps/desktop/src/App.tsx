import { logo, venueLogos } from "@pewterdesk/assets";
import type { AccountSnapshot, Market, OrderBook, VenueId } from "@pewterdesk/core";
import {
  AccountSummary,
  AlertsPopover,
  BOOK_SIDES,
  BOOK_UNITS,
  type BookSides,
  BookSidesPicker,
  type BookUnit,
  decimalsOf,
  FundingHistoryTable,
  formatSigned,
  type IconLoader,
  MarketPicker,
  MarketStatsBar,
  OpenOrdersTable,
  OptionsMenu,
  OrderBookSkeleton,
  OrderBookView,
  OrderTicket,
  PnlCard,
  PositionsTable,
  QuickTrade,
  type RowMode,
  type SymbolFor,
  Tabs,
  TokenIcon,
  TokenIconProvider,
  TradeHistoryTable,
  TradesSkeleton,
  TradesView,
  t,
} from "@pewterdesk/ui";
import { type ReactNode, useCallback, useEffect, useRef, useState } from "react";
import { LuWallet } from "react-icons/lu";
import { appClient } from "./api/appClient";
import { venueClient } from "./api/venueClient";
import { AboutDialog } from "./components/about/AboutDialog";
import { ConnectionBanner } from "./components/ConnectionBanner";
import { ago } from "./components/ConnectionPanel";
import { FeedView } from "./components/FeedView";
import { HeaderActions } from "./components/header/HeaderActions";
import { LayoutBar } from "./components/layout/LayoutBar";
import { PanelPalette } from "./components/layout/PanelPalette";
import { WorkspaceGrid } from "./components/layout/WorkspaceGrid";
import { ComingSoonPage } from "./components/pages/ComingSoonPage";
import { PortfolioPage } from "./components/pages/PortfolioPage";
import { MarketsPanel } from "./components/panels/MarketsPanel";
import { pageLabel, pageOptions, ROW_MODES, VIEW_KEYS } from "./components/preferences";
import { BEAT_MS, StatusBar } from "./components/StatusBar";
import { SettingsPage } from "./components/settings/SettingsPage";
import { Clock, Funding, Latency } from "./components/statusbar/BarInfo";
import { Movement } from "./components/statusbar/Movement";
import { Tickers } from "./components/statusbar/Tickers";
import { ConnectWalletDialog } from "./components/wallet/ConnectWalletDialog";
import { useAlerts } from "./hooks/useAlerts";
import { isLightTheme, useAppearance } from "./hooks/useAppearance";
import { useConnection } from "./hooks/useConnection";
import { useFeedAge } from "./hooks/useFeedAge";
import { useStoredChoice } from "./hooks/useStoredChoice";
import { useThemeTransition } from "./hooks/useThemeTransition";
import { useTraySync } from "./hooks/useTraySync";
import {
  type Feed,
  useAccount,
  useAccountFills,
  useAccountFunding,
  useMarketStats,
  useMarketSummaries,
  useMarkets,
  useOrderBook,
  useOrderHistory,
  useTrades,
} from "./hooks/useVenueFeeds";
import { useWatchlist } from "./hooks/useWatchlist";
import { useWorkspace } from "./hooks/useWorkspace";
import { connectedAddress } from "./lib/account";
import { FEED_TIMEOUT_MS } from "./lib/feedActivity";
import { peekSavedIcon, withIconCache } from "./lib/iconCache";
import type { Page } from "./lib/pages";
import { type PanelKind, panelKindOf } from "./lib/panels";
import { defaultPnlPosition, loadPnlCard, type PnlCardState, savePnlCard } from "./lib/pnlCard";
import {
  defaultQuickTradePosition,
  loadQuickTrade,
  type QuickTradeState,
  saveQuickTrade,
} from "./lib/quickTrade";
import { loadMarket, saveMarket } from "./lib/selectedMarket";
import { loadVenue, saveVenue, VENUE_IDS, VENUES } from "./lib/venues";
import {
  addPanel,
  DEFAULT_PRESET,
  type ExpandMode,
  fillGaps,
  removePanel,
  saveAs,
} from "./lib/workspace";

/** The launch splash stays up at least this long after the page starts, and at most this. */
const MIN_SPLASH_MS = 2000;
const MAX_SPLASH_MS = 8000;

/** Market logos, fetched by the venue adapter; stable so TokenIcon's cache holds. */
// Saved between sessions (lib/iconCache), so they draw at once on the next launch.
const loadIcon: IconLoader = withIconCache((market, venue) =>
  venueClient.marketIcon(venue, market),
);
/** The venue chips in the market picker. */
const VENUE_CHIPS = VENUE_IDS.map((id) => ({
  id,
  label: VENUES[id].label,
  logo: venueLogos[id],
}));

type ActivityTab = "positions" | "orders" | "fills" | "funding" | "orderHistory";
type BookTab = "book" | "trades";
const SOUND = ["on", "off"] as const;

/**
 * The connected account's activity, tabbed: open positions and orders (live),
 * and its trade, funding and order history (fetched while their tab is open).
 */
function ActivityPanel({
  venue,
  account,
  address,
  symbolFor,
}: {
  venue: VenueId;
  account: Feed<AccountSnapshot>;
  address: string | undefined;
  symbolFor: SymbolFor;
}) {
  const [tab, setTab] = useState<ActivityTab>("positions");
  const snapshot = account.status === "live" || account.status === "closed" ? account.data : null;
  const fills = useAccountFills(venue, address, tab === "fills");
  const funding = useAccountFunding(venue, address, tab === "funding");
  const orderHistory = useOrderHistory(venue, address, tab === "orderHistory");
  const loading = <p className="pd-empty">{t("history.loading")}</p>;
  return (
    <>
      <Tabs
        tabs={[
          {
            id: "positions",
            label: `${t("tab.positions")}${snapshot ? ` (${snapshot.positions.length})` : ""}`,
          },
          {
            id: "orders",
            label: `${t("tab.openOrders")}${snapshot ? ` (${snapshot.openOrders.length})` : ""}`,
          },
          { id: "fills", label: t("tab.tradeHistory") },
          { id: "funding", label: t("tab.fundingHistory") },
          { id: "orderHistory", label: t("tab.orderHistory") },
        ]}
        active={tab}
        onChange={setTab}
      />
      <div className="app-scroll">
        {tab === "fills" ? (
          <FeedView
            feed={fills}
            idle={t("feed.noAccount")}
            loading={loading}
            live={(data) => <TradeHistoryTable fills={data} symbolFor={symbolFor} />}
          />
        ) : tab === "funding" ? (
          <FeedView
            feed={funding}
            idle={t("feed.noAccount")}
            loading={loading}
            live={(data) => <FundingHistoryTable payments={data} symbolFor={symbolFor} />}
          />
        ) : tab === "orderHistory" ? (
          <FeedView
            feed={orderHistory}
            idle={t("feed.noAccount")}
            loading={loading}
            live={(data) => (
              <OpenOrdersTable
                orders={data}
                symbolFor={symbolFor}
                empty={t("history.ordersEmpty")}
              />
            )}
          />
        ) : (
          <FeedView
            feed={account}
            idle={t("feed.noAccount")}
            live={(data) =>
              tab === "positions" ? (
                <PositionsTable positions={data.positions} symbolFor={symbolFor} />
              ) : (
                <OpenOrdersTable orders={data.openOrders} symbolFor={symbolFor} />
              )
            }
          />
        )}
      </div>
    </>
  );
}

/**
 * Order book and trade tape, tabbed. The tape only subscribes while its tab
 * is showing; the book feed is shared with the quick-trade bar's prices.
 */
function OrderBookPanel({
  venue,
  book,
  market,
  marketsLoading,
}: {
  venue: VenueId;
  book: Feed<OrderBook>;
  market?: Market;
  /** No market can be picked until the list arrives; show the skeleton meanwhile. */
  marketsLoading: boolean;
}) {
  const [tab, setTab] = useState<BookTab>("book");
  // Table or stacked rows, for the book and the tape, are set in Settings;
  // the panel picks the book's sides.
  const [bookMode] = useStoredChoice<RowMode>(VIEW_KEYS.book, ROW_MODES, "table");
  // Sizes and totals in the coin, or valued in the quote asset.
  const [bookUnit, setBookUnit] = useStoredChoice<BookUnit>("pd.book.unit", BOOK_UNITS, "base");
  // Buys and sells, or one side given the whole panel.
  const [bookSides, setBookSides] = useStoredChoice<BookSides>("pd.book.sides", BOOK_SIDES, "both");
  const [tradesMode] = useStoredChoice<RowMode>(VIEW_KEYS.trades, ROW_MODES, "table");
  const trades = useTrades(venue, tab === "trades" ? market?.id : undefined);
  // Stale: the book has gone quiet past its timeout, the network is gone, or
  // the stream ended. Its last prices stay up, dimmed, with a warning.
  const { feed: bookFeed, now, network } = useFeedAge("book", venue, tab === "book");
  const quietMs = bookFeed?.last === undefined ? undefined : now - bookFeed.last;
  const stale =
    book.status === "closed" ||
    (book.status === "live" &&
      quietMs !== undefined &&
      (quietMs > FEED_TIMEOUT_MS.book || !network));
  const skeleton =
    tab === "book" ? <OrderBookSkeleton mode={bookMode} /> : <TradesSkeleton mode={tradesMode} />;
  return (
    <>
      <Tabs
        tabs={[
          { id: "book", label: t("tab.orderBook") },
          { id: "trades", label: t("tab.trades") },
        ]}
        active={tab}
        onChange={setTab}
        aside={
          tab === "book" ? <BookSidesPicker value={bookSides} onChange={setBookSides} /> : undefined
        }
      />
      <div className="app-fill">
        {marketsLoading ? (
          skeleton
        ) : tab === "book" ? (
          <FeedView
            feed={book}
            idle={t("feed.pickMarket")}
            loading={skeleton}
            live={(data) => (
              <div className="book-stale-wrap" data-stale={stale || undefined}>
                <OrderBookView
                  book={data}
                  base={market?.base}
                  quote={market?.quote}
                  mode={bookMode}
                  sides={bookSides}
                  unit={bookUnit}
                  onUnitChange={setBookUnit}
                />
                {stale && (
                  <div className="book-stale" role="alert">
                    <strong className="book-stale-age">{ago(quietMs ?? 0)}</strong>
                    <p className="book-stale-title">{t("book.stale")}</p>
                    <p>{t("book.staleHint")}</p>
                  </div>
                )}
              </div>
            )}
          />
        ) : (
          <FeedView
            feed={trades}
            idle={t("feed.pickMarket")}
            loading={skeleton}
            live={(data) => (
              <TradesView
                trades={data}
                base={market?.base}
                quote={market?.quote}
                mode={tradesMode}
              />
            )}
          />
        )}
      </div>
    </>
  );
}

export function App() {
  // The venue and market on screen, so a restart opens where you left off.
  // Each venue remembers its own last market.
  const [venue, setVenue] = useState(loadVenue);
  const venueInfo = VENUES[venue];
  const markets = useMarkets(venue);
  const [selectedId, setSelectedId] = useState(() => loadMarket(venue));
  useEffect(() => {
    if (selectedId) saveMarket(selectedId, venue);
  }, [selectedId, venue]);
  /** Puts `marketId` on `next` on screen (or that venue's last market). */
  const showMarket = (next: VenueId, marketId?: string) => {
    if (next !== venue) {
      setVenue(next);
      saveVenue(next);
    }
    setSelectedId(marketId ?? loadMarket(next));
  };
  // Aster serves account data only to signed requests, which need a
  // connected API wallet; until then it has no account to show.
  const address = venue === "hyperliquid" ? connectedAddress() : undefined;
  const appearance = useAppearance();
  const themeTransition = useThemeTransition(appearance.setTheme);
  const watchlist = useWatchlist(venue);
  const [workspace, setWorkspace] = useWorkspace();
  const [editing, setEditing] = useState(false);
  const [dragging, setDragging] = useState<PanelKind>();
  // A panel shown over its neighbours; a view only, the layout is untouched.
  const [expanded, setExpanded] = useState<{ id: string; mode: ExpandMode }>();
  useEffect(() => {
    if (!expanded) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setExpanded(undefined);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [expanded]);
  const [page, setPage] = useState<Page>("trade");
  // Market alerts, checked while the app runs; the popover is the header's bell.
  const [alertsOpen, setAlertsOpen] = useState(false);
  const alerts = useAlerts(alertsOpen);
  const [walletOpen, setWalletOpen] = useState(false);
  const [aboutOpen, setAboutOpen] = useState(false);
  // A market picked from the tray panel goes on screen, switching venue if need be.
  const showFromTray = useRef(showMarket);
  showFromTray.current = showMarket;
  useEffect(
    () =>
      appClient.onTraySelectMarket(({ venue, marketId }) => {
        if (VENUE_IDS.includes(venue)) showFromTray.current(venue, marketId);
      }),
    [],
  );
  // Opened from the macOS menu bar's "About PewterDesk".
  useEffect(() => appClient.onOpenAbout(() => setAboutOpen(true)), []);
  // Nothing plays sounds yet; this is the preference fill alerts will read.
  const [sound, setSound] = useStoredChoice("pd.sound", SOUND, "on");

  const marketList = markets.status === "live" ? markets.data : [];
  const selected: Market | undefined =
    marketList.find((m) => m.id === selectedId) ??
    marketList.find((m) => m.id === venueInfo.defaultMarket) ??
    marketList[0];

  const book = useOrderBook(venue, selected?.id);
  // The launch splash gives way once there's something to show (the market
  // list, or its error), and after at most 8 seconds regardless; at least
  // MIN_SPLASH_MS after the page started, so it doesn't just flash.
  const marketsSettled = markets.status !== "loading";
  useEffect(() => {
    const ready = () => void appClient.appReady().catch(() => {});
    const timer = marketsSettled
      ? setTimeout(ready, Math.max(0, MIN_SPLASH_MS - performance.now()))
      : setTimeout(ready, MAX_SPLASH_MS);
    return () => clearTimeout(timer);
  }, [marketsSettled]);
  // The status badge's heartbeat: one tick per BEAT_MS of order-book time
  // while it streams, so it stops as soon as the feed does.
  const beat = book.status === "live" ? Math.floor(book.data.time / BEAT_MS) : undefined;
  // The market picker can browse another venue's markets (its chips); a
  // pick there switches the screen to that venue. Prices only while it's
  // open (shared with the screener's feed).
  const [pickerOpen, setPickerOpenState] = useState(false);
  const [pickerVenue, setPickerVenue] = useState(venue);
  const setPickerOpen = (open: boolean) => {
    setPickerOpenState(open);
    if (open) setPickerVenue(venue);
  };
  const browsing = pickerOpen && pickerVenue !== venue;
  const otherMarkets = useMarkets(browsing ? pickerVenue : undefined);
  const otherWatchlist = useWatchlist(pickerVenue);
  const pickerSummaries = useMarketSummaries(pickerOpen ? pickerVenue : venue, pickerOpen);
  const pickerWatchlist = browsing ? otherWatchlist : watchlist;
  const pickerProps = {
    markets: browsing ? (otherMarkets.status === "live" ? otherMarkets.data : []) : marketList,
    // Skeleton rows until the browsed venue's list arrives.
    loading: browsing
      ? otherMarkets.status === "loading" || otherMarkets.status === "idle"
      : markets.status === "loading",
    selected: selected?.id,
    onSelect: (m: Market) => showMarket(m.venue, m.id),
    // Undefined while prices load (cells shimmer); empty if they failed (cells read "-").
    summaries:
      pickerSummaries.status === "live" || pickerSummaries.status === "closed"
        ? pickerSummaries.data
        : pickerSummaries.status === "error"
          ? []
          : undefined,
    starred: pickerWatchlist.starred,
    onToggleStar: (m: Market) => pickerWatchlist.toggle(m.id),
    venues: VENUE_CHIPS,
    venue: pickerOpen ? pickerVenue : venue,
    onVenueChange: setPickerVenue,
  };

  // The floating quick-trade bar: open or not, and where, survive a restart.
  const [quickTrade, setQuickTrade] = useState(loadQuickTrade);
  const updateQuickTrade = (next: QuickTradeState) => {
    setQuickTrade(next);
    saveQuickTrade(next);
  };
  const [quickQty, setQuickQty] = useState("");
  // Computed once: a fresh object each render would keep resetting the bar.
  const [quickDefault] = useState(defaultQuickTradePosition);
  const bookData = book.status === "live" || book.status === "closed" ? book.data : undefined;
  const bestBid = bookData?.bids[0]?.price;
  const bestAsk = bookData?.asks[0]?.price;
  const stats = useMarketStats(venue, selected?.id);
  // The bottom bar's status, from what's actually arriving: offline when the
  // network or a feed goes, connecting while the venue has gone quiet.
  const connection = useConnection(
    book.status === "live" ? book.data : undefined,
    stats.status === "live" ? stats.data : undefined,
    markets.status === "error" || book.status === "error" || book.status === "closed",
  );
  const account = useAccount(venue, address);
  const accountData =
    account.status === "live" || account.status === "closed" ? account.data : undefined;
  // The bottom bar: the account's floating PnL, and BTC, ETH and SOL's
  // prices from the venue's summaries (shared with the screener's feed).
  const [pnlCard, setPnlCard] = useState(loadPnlCard);
  const updatePnlCard = (next: PnlCardState) => {
    setPnlCard(next);
    savePnlCard(next);
  };
  const [pnlDefault] = useState(defaultPnlPosition);
  const balance = accountData ? Number(accountData.equity) : undefined;
  const unrealized = accountData?.positions.reduce((sum, p) => sum + Number(p.unrealizedPnl), 0);
  const pnlTrend =
    unrealized === undefined || unrealized === 0 ? undefined : unrealized > 0 ? "up" : "down";
  const barSummaries = useMarketSummaries(venue, true);
  const barPrices =
    barSummaries.status === "live" || barSummaries.status === "closed"
      ? barSummaries.data
      : undefined;
  // The menu-bar (tray) item: price and PnL, even with the window closed.
  useTraySync({
    market: selected,
    stats: stats.status === "live" || stats.status === "closed" ? stats.data : undefined,
    account: accountData,
  });

  const maxLeverageFor = useCallback(
    (id: string) => marketList.find((m) => m.id === id)?.maxLeverage,
    [marketList],
  );

  const symbolFor = useCallback(
    (id: string) => marketList.find((m) => m.id === id)?.symbol ?? id,
    [marketList],
  );

  /** Switches page; leaving the workspace ends layout editing (closing its gaps). */
  const goTo = (next: Page) => {
    if (next !== "trade" && editing) finishEditing();
    setPage(next);
  };

  /** Leaving edit mode closes any gaps the edits left behind. */
  const finishEditing = () => {
    setEditing(false);
    setWorkspace((w) => ({ ...w, layout: fillGaps(w.layout) }));
  };

  const placed = new Set(
    workspace.layout.flatMap((p) => {
      const kind = panelKindOf(p.i);
      return kind ? [kind] : [];
    }),
  );

  const renderPanel = (kind: PanelKind, id: string): ReactNode => {
    switch (kind) {
      case "markets":
        return (
          <MarketsPanel
            venue={venue}
            venueName={venueInfo.label}
            markets={markets}
            market={selected}
            onSelect={(m) => setSelectedId(m.id)}
            book={book}
            starred={watchlist.starred}
            onToggleStar={(m) => watchlist.toggle(m.id)}
            expanded={expanded?.id === id ? expanded.mode : undefined}
            onExpand={(mode) => setExpanded(mode ? { id, mode } : undefined)}
          />
        );
      case "orderBook":
        return (
          <OrderBookPanel
            venue={venue}
            book={book}
            market={selected}
            marketsLoading={markets.status === "loading"}
          />
        );
      case "account":
        return (
          <div className="app-scroll">
            {/* Before a wallet is connected the summary reads zero, not a prompt. */}
            {account.status === "idle" ? (
              <AccountSummary />
            ) : (
              <FeedView
                feed={account}
                live={(data) => <AccountSummary snapshot={data} maxLeverageFor={maxLeverageFor} />}
              />
            )}
          </div>
        );
      case "positions":
        return (
          <ActivityPanel venue={venue} account={account} address={address} symbolFor={symbolFor} />
        );
      case "trade":
        // Orders can't be placed yet, so no onSubmit: the button says why.
        return (
          <div className="app-scroll">
            <OrderTicket
              market={selected}
              book={bookData}
              account={accountData}
              fees={selected?.listedBy ? undefined : venueInfo.fees}
              maxSlippage={venueInfo.maxSlippage}
              onConnect={() => setWalletOpen(true)}
            />
          </div>
        );
    }
  };

  const renderAside = (kind: PanelKind): ReactNode => {
    switch (kind) {
      case "orderBook":
        return selected?.symbol;
      case "account":
        return venueInfo.label;
      default:
        return null;
    }
  };

  return (
    <TokenIconProvider load={loadIcon} peek={peekSavedIcon}>
      <div className="app" data-editing={editing || undefined}>
        <header className="app-header">
          {/* The logo goes home: back to the trading workspace, out of settings or layout editing. */}
          <button
            type="button"
            className="app-logo-button"
            aria-label={t("header.home")}
            title={t("header.home")}
            onClick={() => goTo("trade")}
          >
            <img
              className="app-logo"
              src={
                isLightTheme(appearance.theme) ? logo.horizontal.lightBg : logo.horizontal.darkBg
              }
              alt="pewterdesk"
            />
          </button>
          <OptionsMenu
            label={t("nav.menu")}
            heading={t("nav.menu")}
            triggerText={pageLabel(page)}
            className="app-page-menu"
            options={pageOptions()}
            value={page}
            onChange={goTo}
          />
          <div className="app-spacer" />
          {/* The market on screen, beside its watchlist star; opens the market picker. */}
          {selected && (
            <MarketPicker
              {...pickerProps}
              onOpenChange={setPickerOpen}
              triggerClassName="app-market-pill"
              trigger={
                <>
                  <TokenIcon market={selected} size={22} />
                  <strong>
                    {selected.base}
                    {selected.quote}
                  </strong>
                  <span className="app-quote-badge">{selected.quote}</span>
                </>
              }
            />
          )}
          <HeaderActions
            marketSymbol={selected?.symbol}
            starred={selected !== undefined && watchlist.starred.has(selected.id)}
            onToggleStar={() => selected && watchlist.toggle(selected.id)}
            quickTradeOpen={quickTrade.open}
            onToggleQuickTrade={() => updateQuickTrade({ ...quickTrade, open: !quickTrade.open })}
            editing={editing}
            onToggleLayout={() => {
              if (editing) {
                finishEditing();
              } else {
                setPage("trade");
                setExpanded(undefined);
                setEditing(true);
              }
            }}
            soundOn={sound === "on"}
            onSound={(on) => setSound(on ? "on" : "off")}
            alerts={
              <AlertsPopover
                alerts={alerts.alerts}
                fired={alerts.fired}
                unseen={alerts.unseen}
                paused={alerts.paused}
                onPausedChange={alerts.setPaused}
                market={selected}
                venues={VENUE_CHIPS}
                currentOf={alerts.currentOf}
                onCreate={alerts.create}
                onToggle={alerts.toggle}
                onDelete={alerts.remove}
                onClearFired={alerts.clearFired}
                onShowMarket={(v, m) => {
                  setPage("trade");
                  showMarket(v, m);
                }}
                onOpenChange={(open) => {
                  setAlertsOpen(open);
                  // Opening or closing it counts as having seen what fired.
                  alerts.markSeen();
                }}
              />
            }
            settingsOpen={page === "settings"}
            onToggleSettings={() => goTo(page === "settings" ? "trade" : "settings")}
            theme={appearance.theme}
            onTheme={themeTransition.switchTheme}
            address={address}
            onOpenWallet={() => setWalletOpen(true)}
          />
        </header>

        {page === "portfolio" ? (
          <PortfolioPage
            account={account}
            markets={marketList}
            venue={venueInfo.label}
            onConnect={() => setWalletOpen(true)}
          />
        ) : page === "journal" ? (
          <ComingSoonPage
            title="nav.journal"
            subtitle="journal.subtitle"
            description="journal.soon"
          />
        ) : page === "news" ? (
          <ComingSoonPage title="nav.news" subtitle="news.subtitle" description="news.soon" />
        ) : page === "settings" ? (
          <SettingsPage
            onClose={() => goTo("trade")}
            soundOn={sound === "on"}
            onSound={(on) => setSound(on ? "on" : "off")}
            theme={appearance.theme}
            onTheme={themeTransition.switchTheme}
            marketColors={appearance.market}
            onMarketColors={appearance.setMarket}
            address={address}
            onOpenWallet={() => setWalletOpen(true)}
            onResetLayout={() =>
              setWorkspace((w) => ({
                ...w,
                layout: DEFAULT_PRESET.layout,
                active: DEFAULT_PRESET.name,
              }))
            }
            onClearWatchlist={watchlist.clear}
          />
        ) : (
          <>
            {editing && (
              <LayoutBar
                active={workspace.active}
                saved={workspace.saved}
                onApply={(l) =>
                  setWorkspace((w) => ({ ...w, layout: fillGaps(l.layout), active: l.name }))
                }
                onSaveAs={(name) => setWorkspace((w) => saveAs(w, name))}
                onDelete={(name) =>
                  setWorkspace((w) => ({ ...w, saved: w.saved.filter((s) => s.name !== name) }))
                }
                onDone={finishEditing}
              />
            )}

            <ConnectionBanner venue={venueInfo.label} connection={connection} />
            <div className="app-body">
              <WorkspaceGrid
                layout={workspace.layout}
                editing={editing}
                dragging={dragging}
                onChange={(layout) => setWorkspace((w) => ({ ...w, layout }))}
                onDrop={(kind, at) => {
                  setDragging(undefined);
                  setWorkspace((w) => ({ ...w, layout: addPanel(w.layout, kind, at) }));
                }}
                onRemove={(id) =>
                  setWorkspace((w) => ({ ...w, layout: fillGaps(removePanel(w.layout, id)) }))
                }
                renderPanel={renderPanel}
                renderAside={renderAside}
                expanded={expanded}
                renderStatsBar={() => (
                  <MarketStatsBar
                    market={selected}
                    venue={venueInfo.label}
                    stats={
                      stats.status === "live" || stats.status === "closed" ? stats.data : undefined
                    }
                    markets={pickerProps.markets}
                    onSelectMarket={pickerProps.onSelect}
                    summaries={pickerProps.summaries}
                    starred={pickerProps.starred}
                    onToggleStar={pickerProps.onToggleStar}
                    onPickerOpen={setPickerOpen}
                    venues={pickerProps.venues}
                    pickerVenue={pickerProps.venue}
                    onPickerVenueChange={pickerProps.onVenueChange}
                    pickerLoading={pickerProps.loading}
                  />
                )}
              />
              {editing && (
                <PanelPalette
                  placed={placed}
                  onDragStart={setDragging}
                  onDragEnd={() => setDragging(undefined)}
                  onAdd={(kind) =>
                    setWorkspace((w) => ({ ...w, layout: addPanel(w.layout, kind) }))
                  }
                />
              )}
            </div>
          </>
        )}

        <ConnectWalletDialog open={walletOpen} onClose={() => setWalletOpen(false)} />

        <StatusBar
          connection={connection}
          venue={venueInfo.label}
          venueId={venue}
          market={selected?.id}
          venueLogo={venueLogos[venue]}
          beat={beat}
          right={
            <>
              <Funding
                stats={
                  stats.status === "live" || stats.status === "closed" ? stats.data : undefined
                }
                market={selected?.symbol}
              />
              <Latency venue={venue} />
              <Clock />
            </>
          }
        >
          <button
            type="button"
            className="app-bar-button app-bar-pnl"
            aria-pressed={pnlCard.open}
            title={t("pnl.toggle")}
            onClick={() => updatePnlCard({ ...pnlCard, open: !pnlCard.open })}
          >
            <LuWallet size={13} aria-hidden />
            {t("pnl.pnl")}
            <span className="pd-num" data-trend={pnlTrend}>
              {unrealized === undefined ? "-" : formatSigned(unrealized, 2)}
            </span>
          </button>
          <Movement
            venue={venue}
            markets={marketList}
            onOpenMarket={(v, id) => showMarket(v, id)}
          />
          <Tickers
            venue={venue}
            ids={venueInfo.majors}
            markets={marketList}
            summaries={barPrices}
            onOpen={(m) => showMarket(m.venue, m.id)}
          />
        </StatusBar>

        {/* Orders can't be placed yet, so no onLong/onShort: the buttons show why. */}
        {quickTrade.open && page === "trade" && (
          <QuickTrade
            base={selected?.base}
            bid={bestBid === undefined ? undefined : Number(bestBid)}
            ask={bestAsk === undefined ? undefined : Number(bestAsk)}
            decimals={decimalsOf(bestBid ?? bestAsk ?? "0")}
            qty={quickQty}
            onQty={setQuickQty}
            position={quickTrade.position ?? quickDefault}
            onMove={(position) => updateQuickTrade({ ...quickTrade, position })}
            onClose={() => updateQuickTrade({ ...quickTrade, open: false })}
          />
        )}

        {pnlCard.open && (
          <PnlCard
            venue={venueInfo.label}
            venueLogo={venueLogos[venue]}
            quote={selected?.quote ?? "USDC"}
            balance={balance}
            pnl={unrealized}
            connected={accountData !== undefined}
            onConnect={() => setWalletOpen(true)}
            position={pnlCard.position ?? pnlDefault}
            onMove={(position) => updatePnlCard({ ...pnlCard, position })}
            onClose={() => updatePnlCard({ ...pnlCard, open: false })}
          />
        )}

        <AboutDialog
          open={aboutOpen}
          onClose={() => setAboutOpen(false)}
          logoSrc={
            isLightTheme(appearance.theme) ? logo.horizontal.lightBg : logo.horizontal.darkBg
          }
        />

        {/* Covers the app while a theme switch happens underneath. */}
        {themeTransition.overlay}
      </div>
    </TokenIconProvider>
  );
}
