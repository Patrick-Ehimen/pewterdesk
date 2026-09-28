import { logo } from "@pewterdesk/assets";
import type { AccountSnapshot, Market, OrderBook, VenueId } from "@pewterdesk/core";
import {
  AccountSummary,
  decimalsOf,
  FundingHistoryTable,
  type IconLoader,
  MarketStatsBar,
  OpenOrdersTable,
  OptionsMenu,
  OrderBookSkeleton,
  OrderBookView,
  OrderTicket,
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
import { type ReactNode, useCallback, useEffect, useState } from "react";
import { appClient } from "./api/appClient";
import { venueClient } from "./api/venueClient";
import { AboutDialog } from "./components/about/AboutDialog";
import { FeedView } from "./components/FeedView";
import { HeaderActions } from "./components/header/HeaderActions";
import { LayoutBar } from "./components/layout/LayoutBar";
import { PanelPalette } from "./components/layout/PanelPalette";
import { WorkspaceGrid } from "./components/layout/WorkspaceGrid";
import { ComingSoonPage } from "./components/pages/ComingSoonPage";
import { PortfolioPage } from "./components/pages/PortfolioPage";
import { MarketsPanel } from "./components/panels/MarketsPanel";
import {
  pageLabel,
  pageOptions,
  ROW_MODES,
  rowModeOptions,
  VIEW_KEYS,
} from "./components/preferences";
import { type Connection, StatusBar } from "./components/StatusBar";
import { SettingsPage } from "./components/settings/SettingsPage";
import { ConnectWalletDialog } from "./components/wallet/ConnectWalletDialog";
import { isLightTheme, useAppearance } from "./hooks/useAppearance";
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
import type { Page } from "./lib/pages";
import { type PanelKind, panelKindOf } from "./lib/panels";
import {
  defaultQuickTradePosition,
  loadQuickTrade,
  type QuickTradeState,
  saveQuickTrade,
} from "./lib/quickTrade";
import { loadMarket, saveMarket } from "./lib/selectedMarket";
import {
  addPanel,
  DEFAULT_PRESET,
  type ExpandMode,
  fillGaps,
  removePanel,
  saveAs,
} from "./lib/workspace";

// The only venue with an adapter so far.
const VENUE: VenueId = "hyperliquid";
/**
 * Hyperliquid's base-tier perp fees (taker / maker), for the order ticket.
 * Builder-deployed (HIP-3) markets scale these per deployer, so they show none.
 */
const HYPERLIQUID_FEES = { taker: 0.00045, maker: 0.00015 };
/** Hyperliquid's default cap on how far a market order may fill from the touch. */
const HYPERLIQUID_MAX_SLIPPAGE = 0.08;

/** The launch splash stays up at least this long after the page starts, and at most this. */
const MIN_SPLASH_MS = 1200;
const MAX_SPLASH_MS = 8000;

/** Market logos, fetched by the venue adapter; stable so TokenIcon's cache holds. */
const loadIcon: IconLoader = (market) => venueClient.marketIcon(VENUE, market);
const VENUE_LABEL = "Hyperliquid";
const DEFAULT_MARKET = "HYPE";

type ActivityTab = "positions" | "orders" | "fills" | "funding" | "orderHistory";
type BookTab = "book" | "trades";
const SOUND = ["on", "off"] as const;

/**
 * The connected account's activity, tabbed: open positions and orders (live),
 * and its trade, funding and order history (fetched while their tab is open).
 */
function ActivityPanel({
  account,
  address,
  symbolFor,
}: {
  account: Feed<AccountSnapshot>;
  address: string | undefined;
  symbolFor: SymbolFor;
}) {
  const [tab, setTab] = useState<ActivityTab>("positions");
  const snapshot = account.status === "live" || account.status === "closed" ? account.data : null;
  const fills = useAccountFills(VENUE, address, tab === "fills");
  const funding = useAccountFunding(VENUE, address, tab === "funding");
  const orderHistory = useOrderHistory(VENUE, address, tab === "orderHistory");
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
  book,
  market,
  marketsLoading,
}: {
  book: Feed<OrderBook>;
  market?: Market;
  /** No market can be picked until the list arrives; show the skeleton meanwhile. */
  marketsLoading: boolean;
}) {
  const [tab, setTab] = useState<BookTab>("book");
  const [bookMode, setBookMode] = useStoredChoice<RowMode>(VIEW_KEYS.book, ROW_MODES, "table");
  const [tradesMode, setTradesMode] = useStoredChoice<RowMode>(
    VIEW_KEYS.trades,
    ROW_MODES,
    "table",
  );
  const trades = useTrades(VENUE, tab === "trades" ? market?.id : undefined);
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
          <OptionsMenu
            label={t(tab === "book" ? "menu.bookOptions" : "menu.tradesOptions")}
            heading={t("menu.view")}
            options={rowModeOptions()}
            value={tab === "book" ? bookMode : tradesMode}
            onChange={tab === "book" ? setBookMode : setTradesMode}
          />
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
              <OrderBookView
                book={data}
                base={market?.base}
                quote={market?.quote}
                mode={bookMode}
              />
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
  const markets = useMarkets(VENUE);
  // The last market viewed, so a restart opens where you left off.
  const [selectedId, setSelectedId] = useState(loadMarket);
  useEffect(() => {
    if (selectedId) saveMarket(selectedId);
  }, [selectedId]);
  const address = connectedAddress();
  const appearance = useAppearance();
  const themeTransition = useThemeTransition(appearance.setTheme);
  const watchlist = useWatchlist(VENUE);
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
  const [walletOpen, setWalletOpen] = useState(false);
  const [aboutOpen, setAboutOpen] = useState(false);
  // A market picked from the tray panel's watchlist goes on screen.
  useEffect(() => appClient.onTraySelectMarket((id) => setSelectedId(id)), []);
  // Opened from the macOS menu bar's "About PewterDesk".
  useEffect(() => appClient.onOpenAbout(() => setAboutOpen(true)), []);
  // Nothing plays sounds yet; this is the preference fill alerts will read.
  const [sound, setSound] = useStoredChoice("pd.sound", SOUND, "on");

  const marketList = markets.status === "live" ? markets.data : [];
  const selected: Market | undefined =
    marketList.find((m) => m.id === selectedId) ??
    marketList.find((m) => m.id === DEFAULT_MARKET) ??
    marketList[0];

  const book = useOrderBook(VENUE, selected?.id);
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
  // The bottom bar's indicator: live once the book streams, offline if the
  // market list or the stream fails, connecting until then.
  const connection: Connection =
    markets.status === "error" || book.status === "error" || book.status === "closed"
      ? "offline"
      : book.status === "live"
        ? "online"
        : "connecting";
  // Prices for the market picker, only while it's open (shared with the screener's feed).
  const [pickerOpen, setPickerOpen] = useState(false);
  const pickerSummaries = useMarketSummaries(VENUE, pickerOpen);

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
  const stats = useMarketStats(VENUE, selected?.id);
  const account = useAccount(VENUE, address);
  const accountData =
    account.status === "live" || account.status === "closed" ? account.data : undefined;
  // The menu-bar (tray) item: price and PnL, even with the window closed.
  useTraySync({
    market: selected,
    stats: stats.status === "live" || stats.status === "closed" ? stats.data : undefined,
    account: accountData,
  });

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
            venue={VENUE}
            venueName={VENUE_LABEL}
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
            book={book}
            market={selected}
            marketsLoading={markets.status === "loading"}
          />
        );
      case "account":
        return (
          <div className="app-scroll">
            <FeedView
              feed={account}
              idle={t("feed.connectWallet")}
              live={(data) => <AccountSummary snapshot={data} quote={selected?.quote ?? "USDC"} />}
            />
          </div>
        );
      case "positions":
        return <ActivityPanel account={account} address={address} symbolFor={symbolFor} />;
      case "trade":
        // Orders can't be placed yet, so no onSubmit: the button says why.
        return (
          <div className="app-scroll">
            <OrderTicket
              market={selected}
              book={bookData}
              account={accountData}
              fees={selected?.listedBy ? undefined : HYPERLIQUID_FEES}
              maxSlippage={HYPERLIQUID_MAX_SLIPPAGE}
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
        return VENUE_LABEL;
      default:
        return null;
    }
  };

  return (
    <TokenIconProvider load={loadIcon}>
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
          <span className="app-chip">
            <span className="pd-live-dot" data-live={book.status === "live" || undefined} />
            {VENUE_LABEL}
          </span>
          <div className="app-spacer" />
          {/* The market on screen, beside its watchlist star. */}
          {selected && (
            <span className="app-market-pill">
              <TokenIcon market={selected} size={22} />
              <strong>
                {selected.base}
                {selected.quote}
              </strong>
              <span className="app-quote-badge">{selected.quote}</span>
            </span>
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
            venue={VENUE_LABEL}
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
                    venue={VENUE_LABEL}
                    stats={
                      stats.status === "live" || stats.status === "closed" ? stats.data : undefined
                    }
                    markets={marketList}
                    onSelectMarket={(m) => setSelectedId(m.id)}
                    summaries={
                      pickerSummaries.status === "live" || pickerSummaries.status === "closed"
                        ? pickerSummaries.data
                        : undefined
                    }
                    starred={watchlist.starred}
                    onToggleStar={(m) => watchlist.toggle(m.id)}
                    onPickerOpen={setPickerOpen}
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

        <StatusBar connection={connection} venue={VENUE_LABEL} />

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
