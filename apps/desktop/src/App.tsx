import { logo, venueLogos } from "@pewterdesk/assets";
import type {
  AccountSnapshot,
  ClosedTrade,
  Market,
  Order,
  OrderAmend,
  OrderBook,
  OrderRequest,
  Position,
  PositionProtection,
  VenueId,
} from "@pewterdesk/core";
import {
  AccountSummary,
  AlertsPopover,
  BOOK_SIDES,
  BOOK_UNITS,
  type BookSides,
  BookSidesPicker,
  type BookUnit,
  ClosedTradesTable,
  closedRoi,
  dateFormat,
  decimalsOf,
  FundingHistoryTable,
  formatNumber,
  formatSigned,
  type IconLoader,
  MarketPicker,
  MarketStatsBar,
  OpenOrdersPanel,
  OpenOrdersTable,
  OptionsMenu,
  OrderBookSkeleton,
  OrderBookView,
  OrderTicket,
  PnlCard,
  PnlShareDialog,
  PositionsTable,
  QuickTrade,
  type RowMode,
  type ShareCard,
  SummarySkeleton,
  type SymbolFor,
  TableSkeleton,
  Tabs,
  TokenIcon,
  TokenIconProvider,
  TradeHistoryTable,
  TradesSkeleton,
  TradesView,
  t,
} from "@pewterdesk/ui";
import {
  type ReactNode,
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { LuWallet } from "react-icons/lu";
import { appClient } from "./api/appClient";
import { venueClient } from "./api/venueClient";
import { AboutDialog } from "./components/about/AboutDialog";
import { ConnectionBanner } from "./components/ConnectionBanner";
import { ago } from "./components/ConnectionPanel";
import { FeedView } from "./components/FeedView";
import { HeaderActions } from "./components/header/HeaderActions";
import { VenueSwitcher } from "./components/header/VenueSwitcher";
import { LayoutBar } from "./components/layout/LayoutBar";
import { PanelPalette } from "./components/layout/PanelPalette";
import { WorkspaceGrid } from "./components/layout/WorkspaceGrid";
import { Onboarding } from "./components/onboarding/Onboarding";
import { ComingSoonPage } from "./components/pages/ComingSoonPage";
import { PortfolioPage } from "./components/pages/PortfolioPage";
import { VenuesPage } from "./components/pages/VenuesPage";
import { MarketsPanel } from "./components/panels/MarketsPanel";
import { pageLabel, pageOptions, ROW_MODES, VIEW_KEYS } from "./components/preferences";
import { BEAT_MS, StatusBar } from "./components/StatusBar";
import { SettingsPage } from "./components/settings/SettingsPage";
import { Clock, Funding, Latency } from "./components/statusbar/BarInfo";
import { Movement } from "./components/statusbar/Movement";
import { Tickers } from "./components/statusbar/Tickers";
import { WatchlistBar } from "./components/statusbar/WatchlistBar";
import { accountName } from "./components/wallet/AccountList";
import { ApiKeyDialog } from "./components/wallet/ApiKeyDialog";
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
  useClosedTrades,
  useMarketStats,
  useMarketSummaries,
  useMarkets,
  useOrderBook,
  useOrderHistory,
  useTrades,
} from "./hooks/useVenueFeeds";
import { useWatchlist } from "./hooks/useWatchlist";
import { useWorkspace } from "./hooks/useWorkspace";
import {
  accountsState,
  activeAccount,
  canTrade,
  isDemoAccount,
  subscribeAccounts,
} from "./lib/account";
import { FEED_TIMEOUT_MS } from "./lib/feedActivity";
import { peekSavedIcon, withIconCache } from "./lib/iconCache";
import { firstIcon, iconSources } from "./lib/marketIcons";
import { loadOnboarding, type OnboardingState, saveOnboarding } from "./lib/onboarding";
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
// Bybit serves none, so its markets borrow the coin's logo (lib/marketIcons).
const loadIcon: IconLoader = withIconCache((market, venue) =>
  firstIcon(iconSources(venue, market), venueClient.marketIcon),
);
/** The venue chips in the market picker. */
const VENUE_CHIPS = VENUE_IDS.map((id) => ({
  id,
  label: VENUES[id].label,
  logo: venueLogos[id],
}));

type ActivityTab = "positions" | "orders" | "closedPnl" | "fills" | "funding" | "orderHistory";
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
  onCancel,
  quoteFor,
  baseFor,
  tickFor,
  onProtect,
  onAmend,
  onShare,
}: {
  venue: VenueId;
  account: Feed<AccountSnapshot>;
  address: string | undefined;
  symbolFor: SymbolFor;
  /** Cancels an open order; unset where the account can't trade. */
  onCancel?: (order: Order) => Promise<void>;
  /** The coin a market's PnL and value are in, shown beside them. */
  quoteFor: (marketId: string) => string;
  /** The coin a market's size is in, e.g. "BTC". */
  baseFor: (marketId: string) => string;
  /** A market's price tick. */
  tickFor: (marketId: string) => string;
  /** Changes an open order; unset where the account can't trade. */
  onAmend?: (order: Order, amend: OrderAmend) => Promise<void>;
  /** Opens the P&L share card for a position or a closed trade. */
  onShare: (from: { position: Position } | { closed: ClosedTrade }) => void;
  /** Sets a position's TP, SL and trailing stop; unset where the account can't trade. */
  onProtect?: (position: Position, protection: PositionProtection) => Promise<void>;
}) {
  const [tab, setTab] = useState<ActivityTab>("positions");
  const snapshot = account.status === "live" || account.status === "closed" ? account.data : null;
  const fills = useAccountFills(venue, address, tab === "fills");
  const funding = useAccountFunding(venue, address, tab === "funding");
  const orderHistory = useOrderHistory(venue, address, tab === "orderHistory");
  const closed = useClosedTrades(venue, address, tab === "closedPnl");
  const loading = <TableSkeleton columns={6} />;
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
          { id: "closedPnl", label: t("tab.closedPnl") },
          { id: "fills", label: t("tab.tradeHistory") },
          { id: "funding", label: t("tab.fundingHistory") },
          { id: "orderHistory", label: t("tab.orderHistory") },
        ]}
        active={tab}
        onChange={setTab}
      />
      <div className="app-scroll">
        {tab === "closedPnl" ? (
          <FeedView
            feed={closed}
            idle={t("feed.noAccount")}
            loading={loading}
            live={(data) => (
              <ClosedTradesTable
                trades={data}
                symbolFor={symbolFor}
                quoteFor={quoteFor}
                baseFor={baseFor}
                onShare={(c) => onShare({ closed: c })}
              />
            )}
          />
        ) : tab === "fills" ? (
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
            loading={loading}
            live={(data) =>
              tab === "positions" ? (
                <PositionsTable
                  positions={data.positions}
                  symbolFor={symbolFor}
                  quoteFor={quoteFor}
                  baseFor={baseFor}
                  tickFor={tickFor}
                  onProtect={onProtect}
                  onShare={(p) => onShare({ position: p })}
                />
              ) : (
                <OpenOrdersPanel
                  orders={data.openOrders}
                  symbolFor={symbolFor}
                  quoteFor={quoteFor}
                  baseFor={baseFor}
                  onCancel={onCancel}
                  onAmend={onAmend}
                  tickFor={tickFor}
                />
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
  // The venue's active account: a main address, or on Bybit a UID (read
  // with the API key Rust keeps in the keychain). A venue can have several.
  const accounts = useSyncExternalStore(subscribeAccounts, accountsState);
  const activeOnVenue = activeAccount(accounts, venue);
  const address = activeOnVenue?.id;
  // Orders go only where Rust allows them: Bybit demo accounts, for now.
  const trading = canTrade(activeOnVenue) ? activeOnVenue : undefined;
  const placeOrder = trading
    ? async (request: OrderRequest) => {
        await venueClient.placeOrder(trading.venue, trading.id, request);
      }
    : undefined;
  const cancelOrder = trading
    ? async (order: Order) => {
        await venueClient.cancelOrder(trading.venue, trading.id, order.market, order.id);
      }
    : undefined;
  // The P&L share card: built from a position (live) or a closed trade.
  const [shareCard, setShareCard] = useState<Omit<ShareCard, "demoLabel">>();
  const openShare = (from: { position: Position } | { closed: ClosedTrade }) => {
    const quote = quoteFor("position" in from ? from.position.market : from.closed.market);
    const side = "position" in from ? from.position.side : from.closed.side;
    const lev = "position" in from ? from.position.leverage : from.closed.leverage;
    const sideLabel = `${t(side === "long" ? "side.long" : "side.short")}${
      lev ? ` ${formatNumber(lev)}x` : ""
    }`;
    const brandLogo = isLightTheme(appearance.theme)
      ? logo.horizontal.lightBg
      : logo.horizontal.darkBg;
    const base = {
      venue: venueInfo.label,
      venueLogo: venueLogos[venue],
      brandLogo,
      sideLabel,
      side,
    };
    if ("position" in from) {
      const p = from.position;
      const pnl = Number(p.unrealizedPnl);
      const margin = Number(p.margin);
      setShareCard({
        ...base,
        market: symbolFor(p.market),
        profit: pnl >= 0,
        roi:
          margin > 0
            ? { label: t("share.roi"), value: `${formatSigned((pnl / margin) * 100)}%` }
            : undefined,
        pnl: { label: t("share.unrealized", { quote }), value: formatSigned(pnl) },
        prices: [
          { label: t("share.entry"), value: formatNumber(p.entryPrice) },
          { label: t("share.market"), value: formatNumber(p.markPrice) },
        ],
        footnote: dateFormat({ dateStyle: "medium", timeStyle: "short" }).format(Date.now()),
      });
    } else {
      const c = from.closed;
      const pnl = Number(c.closedPnl);
      const roi = closedRoi(c);
      setShareCard({
        ...base,
        market: symbolFor(c.market),
        profit: pnl >= 0,
        roi:
          roi === undefined ? undefined : { label: t("share.roi"), value: `${formatSigned(roi)}%` },
        pnl: { label: t("share.realized", { quote }), value: formatSigned(pnl) },
        prices: [
          { label: t("share.entry"), value: formatNumber(c.entryPrice) },
          { label: t("share.exit"), value: formatNumber(c.exitPrice) },
        ],
        footnote: dateFormat({ dateStyle: "medium", timeStyle: "short" }).format(c.time),
      });
    }
  };
  const amend = trading
    ? async (order: Order, change: OrderAmend) => {
        await venueClient.amendOrder(trading.venue, trading.id, order.market, order.id, change);
      }
    : undefined;
  const protect = trading
    ? async (position: Position, protection: PositionProtection) => {
        await venueClient.setProtection(trading.venue, trading.id, position.market, protection);
      }
    : undefined;
  const appearance = useAppearance();
  const themeTransition = useThemeTransition(appearance.setTheme);
  // First-run setup, until it's done; it also picks which venues show.
  const [setup, setSetup] = useState(loadOnboarding);
  const venueChips = VENUE_CHIPS.filter((chip) => setup.venues.includes(chip.id));
  const finishSetup = (next: OnboardingState) => {
    saveOnboarding(next);
    setSetup(next);
    const first = next.venues[0];
    if (first && !next.venues.includes(venue)) showMarket(first);
  };
  /** Adds a venue to the terminal, or removes it (never the last one). */
  const toggleVenue = (id: VenueId) => {
    const has = setup.venues.includes(id);
    if (has && setup.venues.length === 1) return;
    const venues = VENUE_IDS.filter((v) => (v === id ? !has : setup.venues.includes(v)));
    finishSetup({ ...setup, venues });
  };
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
  // The exchange whose API-key dialog is open (Bybit connects with a key, not a wallet).
  const [apiKeyFor, setApiKeyFor] = useState<VenueId>();
  /** Opens the venue's own connect flow: a wallet, or an exchange API key. */
  const openConnect = (id: VenueId = venue) =>
    VENUES[id].auth === "apiKey" ? setApiKeyFor(id) : setWalletOpen(true);
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
    venues: venueChips,
    onManageVenues: () => goTo("venues"),
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
  /** A market's price tick, e.g. "0.1". */
  const tickFor = useCallback(
    (id: string) => marketList.find((m) => m.id === id)?.tickSize ?? "0.01",
    [marketList],
  );
  /** The coin a market's size is counted in, e.g. "BTC". */
  const baseFor = useCallback(
    (id: string) => marketList.find((m) => m.id === id)?.base ?? id,
    [marketList],
  );
  /** The coin a market settles in, and its PnL is counted in: USDT or USDC. */
  const quoteFor = useCallback(
    (id: string) =>
      marketList.find((m) => m.id === id)?.quote ??
      (venue === "hyperliquid" || !id.endsWith("USDT") ? "USDC" : "USDT"),
    [marketList, venue],
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
                loading={<SummarySkeleton rows={5} />}
                live={(data) => <AccountSummary snapshot={data} maxLeverageFor={maxLeverageFor} />}
              />
            )}
          </div>
        );
      case "positions":
        return (
          <ActivityPanel
            venue={venue}
            account={account}
            address={address}
            symbolFor={symbolFor}
            onCancel={cancelOrder}
            quoteFor={quoteFor}
            baseFor={baseFor}
            tickFor={tickFor}
            onProtect={protect}
            onAmend={amend}
            onShare={openShare}
          />
        );
      case "trade":
        // Orders go to Bybit demo accounts only, for now; elsewhere there's no
        // onSubmit, and the button says why.
        return (
          <div className="app-scroll">
            <OrderTicket
              market={selected}
              book={bookData}
              account={accountData}
              fees={selected?.listedBy ? undefined : venueInfo.fees}
              maxSlippage={venueInfo.maxSlippage}
              onConnect={() => openConnect()}
              onSubmit={placeOrder}
              unavailableReason={
                venue === "bybit" && activeOnVenue && !trading ? t("ticket.demoOnly") : undefined
              }
              accountBadge={
                activeOnVenue && isDemoAccount(activeOnVenue) ? t("accounts.demo") : undefined
              }
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

  if (!setup.done) {
    return (
      <Onboarding
        initial={setup}
        theme={appearance.theme}
        onTheme={themeTransition.switchTheme}
        onDone={finishSetup}
      />
    );
  }

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
          <VenueSwitcher
            venue={venue}
            venues={setup.venues}
            onChange={(id) => {
              showMarket(id);
              goTo("trade");
            }}
            onSeeAll={() => goTo("venues")}
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
                venues={venueChips}
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
            accountName={activeOnVenue && accountName(accounts, activeOnVenue)}
            account={activeOnVenue}
            demo={activeOnVenue !== undefined && isDemoAccount(activeOnVenue)}
            connectAuth={venueInfo.auth}
            onOpenWallet={() => openConnect()}
          />
        </header>

        {page === "portfolio" ? (
          <PortfolioPage
            account={account}
            markets={marketList}
            venue={venueInfo.label}
            connectAuth={venueInfo.auth}
            onConnect={() => openConnect()}
          />
        ) : page === "venues" ? (
          <VenuesPage
            chosen={setup.venues}
            onToggle={toggleVenue}
            onManage={(id) => {
              showMarket(id);
              openConnect(id);
            }}
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
            address={activeAccount(accounts, "hyperliquid")?.id}
            onOpenWallet={() => setWalletOpen(true)}
            onResetLayout={() =>
              setWorkspace((w) => ({
                ...w,
                layout: DEFAULT_PRESET.layout,
                active: DEFAULT_PRESET.name,
              }))
            }
            onClearWatchlist={watchlist.clear}
            onRunSetup={() => {
              const again = { ...setup, done: false };
              saveOnboarding(again);
              setSetup(again);
              goTo("trade");
            }}
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
                    onPickerManageVenues={pickerProps.onManageVenues}
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
        <ApiKeyDialog
          open={apiKeyFor !== undefined}
          onClose={() => setApiKeyFor(undefined)}
          venue={apiKeyFor ?? venue}
        />

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
          {/* PnL, Market movement and Watchlist sit close together, as one group. */}
          <div className="app-bar-group">
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
            <WatchlistBar
              venue={venue}
              venues={setup.venues}
              markets={marketList}
              onOpenMarket={(v, id) => showMarket(v, id)}
            />
          </div>
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
            connectText={t(venueInfo.auth === "apiKey" ? "pnl.connectApiKey" : "pnl.connect")}
            onConnect={() => openConnect()}
            position={pnlCard.position ?? pnlDefault}
            onMove={(position) => updatePnlCard({ ...pnlCard, position })}
            scale={pnlCard.scale}
            onResize={(scale) => updatePnlCard({ ...pnlCard, scale })}
            onClose={() => updatePnlCard({ ...pnlCard, open: false })}
          />
        )}

        {shareCard && (
          <PnlShareDialog
            card={shareCard}
            demo={activeOnVenue !== undefined && isDemoAccount(activeOnVenue)}
            onSave={appClient.saveShareImage}
            onClose={() => setShareCard(undefined)}
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
