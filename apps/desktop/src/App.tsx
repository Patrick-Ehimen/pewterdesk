import { logo, venueLogos } from "@pewterdesk/assets";
import type {
  AccountSnapshot,
  AlgoSpec,
  ClosedTrade,
  Fill,
  FundingPayment,
  MarginMode,
  Market,
  Order,
  OrderAmend,
  OrderBook,
  OrderRequest,
  Origin,
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
  firedAlertText,
  formatNumber,
  formatSigned,
  MarketPicker,
  MarketStatsBar,
  NotificationCentre,
  OpenOrdersPanel,
  OpenOrdersTable,
  OptionsMenu,
  OrderBookSkeleton,
  OrderBookView,
  OrderTicket,
  orderText,
  PnlCard,
  PnlShareDialog,
  PositionDrawer,
  PositionsTable,
  QuickTrade,
  type RowMode,
  type ShareCard,
  SummarySkeleton,
  type SymbolFor,
  TableSkeleton,
  Tabs,
  type TicketRuleNote,
  Toasts,
  TokenIcon,
  TokenIconProvider,
  TradeHistoryTable,
  TradesSkeleton,
  TradesView,
  t,
  ticketOrder,
  toast,
} from "@pewterdesk/ui";
import {
  type ReactNode,
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { LuPlus, LuWallet, LuX } from "react-icons/lu";
import { appClient } from "./api/appClient";
import { blockText, venueClient } from "./api/venueClient";
import { AboutDialog } from "./components/about/AboutDialog";
import { CommandMenu } from "./components/CommandMenu";
import { ConnectionBanner } from "./components/ConnectionBanner";
import { ago } from "./components/ConnectionPanel";
import { FeedView } from "./components/FeedView";
import { AppLogo } from "./components/header/AppLogo";
import { HeaderActions } from "./components/header/HeaderActions";
import { VenueSwitcher } from "./components/header/VenueSwitcher";
import { LayoutBar } from "./components/layout/LayoutBar";
import { PanelPalette } from "./components/layout/PanelPalette";
import { WorkspaceGrid } from "./components/layout/WorkspaceGrid";
import { Onboarding } from "./components/onboarding/Onboarding";
import { BotsPage } from "./components/pages/BotsPage";
import { MapsPage } from "./components/pages/MapsPage";
import { MultiChartPage } from "./components/pages/MultiChartPage";
import { NewsPage } from "./components/pages/NewsPage";
import { PortfolioPage } from "./components/pages/PortfolioPage";
import { TradingRulesPage } from "./components/pages/TradingRulesPage";
import { VenuesPage } from "./components/pages/VenuesPage";
import { AlgoChartChips, AlgosPanel } from "./components/panels/AlgosPanel";
import { CalendarPanel } from "./components/panels/CalendarPanel";
import { CliPanel } from "./components/panels/CliPanel";
import { MarketsPanel } from "./components/panels/MarketsPanel";
import { NewsWirePanel } from "./components/panels/NewsWirePanel";
import { PaperBanner } from "./components/paper/PaperBanner";
import { type PaperDialogMode, PaperFundsDialog } from "./components/paper/PaperFundsDialog";
import { PaperSwitch } from "./components/paper/PaperSwitch";
import {
  pageLabel,
  pageOptions,
  ROW_MODES,
  themeOptions,
  VIEW_KEYS,
} from "./components/preferences";
import { RulesBanner } from "./components/rules/RulesBanner";
import { BEAT_MS, StatusBar } from "./components/StatusBar";
import { SettingsPage, type SettingsSection } from "./components/settings/SettingsPage";
import { Clock, Funding, Latency } from "./components/statusbar/BarInfo";
import { Movement } from "./components/statusbar/Movement";
import { Tickers } from "./components/statusbar/Tickers";
import { WatchlistBar } from "./components/statusbar/WatchlistBar";
import { accountName } from "./components/wallet/AccountList";
import { ApiKeyDialog } from "./components/wallet/ApiKeyDialog";
import { ConnectWalletDialog } from "./components/wallet/ConnectWalletDialog";
import { useAlerts } from "./hooks/useAlerts";
import { useAlgos } from "./hooks/useAlgos";
import { isLightTheme, THEMES, useAppearance } from "./hooks/useAppearance";
import { useConnection } from "./hooks/useConnection";
import { useFeedAge } from "./hooks/useFeedAge";
import { useOiRecorder } from "./hooks/useMapData";
import { usePaper } from "./hooks/usePaper";
import { usePositionDetail } from "./hooks/usePositionDetail";
import { useStoredChoice } from "./hooks/useStoredChoice";
import { useThemeTransition } from "./hooks/useThemeTransition";
import { useTradeSettings } from "./hooks/useTradeSettings";
import { useTradingRules } from "./hooks/useTradingRules";
import { useTraySync } from "./hooks/useTraySync";
import {
  type Feed,
  useAccount,
  useAccountFills,
  useAccountFunding,
  useAnnouncements,
  useClosedHistory,
  useClosedTrades,
  useMarketStats,
  useMarketSummaries,
  useMarkets,
  useNewsWire,
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
import { accountEvents } from "./lib/accountEvents";
import type { AlgoTarget } from "./lib/algos";
import { FEED_TIMEOUT_MS } from "./lib/feedActivity";
import {
  liquidationDistance,
  positionKey,
  RISK_CLEAR,
  RISK_WITHIN,
  slippageBps,
} from "./lib/float";
import { type HotkeyAction, hotkeyFor, isTyping } from "./lib/hotkeys";
import { peekSavedIcon } from "./lib/iconCache";
import { liveTradingUids, refreshLiveTrading, subscribeLiveTrading } from "./lib/liveTrading";
import { loadIcon } from "./lib/loadIcon";
import {
  clearNotes,
  currentNoteSettings,
  currentNotes,
  markNotesRead,
  type NoteChannel,
  type NoteInput,
  notifyEvent,
  subscribeNotes,
} from "./lib/notifications";
import { desktopNotify } from "./lib/notify";
import { loadOnboarding, type OnboardingState, saveOnboarding } from "./lib/onboarding";
import { loadOrderConfirm, type OrderConfirmPrefs, saveOrderConfirm } from "./lib/orderConfirm";
import { startHistory, stepped, stepTo, visited } from "./lib/pageHistory";
import type { Page } from "./lib/pages";
import { type PanelKind, panelKindOf } from "./lib/panels";
import type { PaperState } from "./lib/paper";
import { isPaperMode, subscribePaper } from "./lib/paperStore";
import { HISTORY_MS } from "./lib/performance";
import { defaultPnlPosition, loadPnlCard, type PnlCardState, savePnlCard } from "./lib/pnlCard";
import {
  allTimePnl,
  EMPTY_HISTORY,
  loadPnlHistory,
  type PnlHistory,
  recordPnl,
  resetPnl,
  savePnlHistory,
} from "./lib/pnlHistory";
import {
  defaultQuickTradePosition,
  loadQuickTrade,
  type QuickTradeState,
  saveQuickTrade,
} from "./lib/quickTrade";
import { loadMarket, saveMarket } from "./lib/selectedMarket";
import { playSound, type SoundKind } from "./lib/sound";
import {
  activePage,
  closed,
  loadTabs,
  MAX_TABS,
  opened,
  saveTabs,
  type TabsState,
  selected as tabSelected,
  stepped as tabStepped,
  withPage,
} from "./lib/tabs";
import { flashTray } from "./lib/trayFlash";
import { loadVenue, saveVenue, VENUE_IDS, VENUES } from "./lib/venues";
import {
  addPanel,
  DEFAULT_PRESET,
  type ExpandMode,
  fillGaps,
  isChanged,
  newLayout,
  removePanel,
  saveAs,
  withLayout,
} from "./lib/workspace";

/** The launch splash stays up at least this long after the page starts, and at most this. */
const MIN_SPLASH_MS = 2000;
const MAX_SPLASH_MS = 8000;

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
  onSelectPosition,
  paper,
}: {
  venue: VenueId;
  account: Feed<AccountSnapshot>;
  /** In paper mode, the paper account: its history replaces the venue's. */
  paper?: PaperState;
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
  /** Brings a position's market on screen, on the chart. */
  onSelectPosition: (position: Position) => void;
  /** Sets a position's TP, SL and trailing stop; unset where the account can't trade. */
  onProtect?: (position: Position, protection: PositionProtection) => Promise<void>;
}) {
  const [tab, setTab] = useState<ActivityTab>("positions");
  const snapshot = account.status === "live" || account.status === "closed" ? account.data : null;
  // Paper mode reads the paper account's own history, and never the venue's.
  const from = paper ? undefined : address;
  const venueFills = useAccountFills(venue, from, tab === "fills");
  const venueFunding = useAccountFunding(venue, from, tab === "funding");
  const venueOrders = useOrderHistory(venue, from, tab === "orderHistory");
  const venueClosed = useClosedTrades(venue, from, tab === "closedPnl");
  const fills: Feed<Fill[]> = paper ? { status: "live", data: paper.fills } : venueFills;
  const funding: Feed<FundingPayment[]> = paper
    ? { status: "live", data: paper.funding }
    : venueFunding;
  const orderHistory: Feed<Order[]> = paper ? { status: "live", data: paper.history } : venueOrders;
  const closed: Feed<ClosedTrade[]> = paper ? { status: "live", data: paper.closed } : venueClosed;
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
                  onSelect={onSelectPosition}
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
  markPrice,
}: {
  venue: VenueId;
  book: Feed<OrderBook>;
  market?: Market;
  /** No market can be picked until the list arrives; show the skeleton meanwhile. */
  marketsLoading: boolean;
  /** The market's mark price, for beside the book's own. */
  markPrice?: string;
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
                  markPrice={markPrice}
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
  // Bumped to bring the Markets panel to the chart (a position was clicked).
  const [chartRequest, setChartRequest] = useState(0);
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
  // The trader's own rules, kept and enforced in Rust; where this account stands.
  const tradingRules = useTradingRules(venue, address);
  // Orders go only where Rust allows them: Bybit demo accounts, for now.
  const liveUids = useSyncExternalStore(subscribeLiveTrading, liveTradingUids);
  // Rust keeps the list; the page's copy is refreshed once it's up.
  useEffect(() => {
    void refreshLiveTrading();
  }, []);
  // Paper trading (Hyperliquid and Aster, which have no demo): the Trade
  // page trades a simulated account on live prices, and nothing goes to the
  // venue. Every order path below picks the paper account or the live one
  // here, once; a live call checks again that the venue hasn't been switched
  // to paper since.
  const paperOn = useSyncExternalStore(subscribePaper, () => isPaperMode(venue));
  // The paper account's funds dialog, or its reset confirmation.
  const [paperDialog, setPaperDialog] = useState<PaperDialogMode>();
  const live = paperOn ? undefined : canTrade(activeOnVenue, liveUids) ? activeOnVenue : undefined;
  /** Throws if the venue went to paper after this render: a live call never goes out then. */
  const stillLive = (v: VenueId) => {
    if (isPaperMode(v)) throw new Error(t("paper.switched"));
  };
  const trading = live;
  /** A live account that's trading: real funds, which the ticket says. */
  const tradingLive = trading !== undefined && !isDemoAccount(trading);
  /** Where orders go: the paper account, a live (or demo) one, or nowhere. */
  const route = paperOn ? "paper" : trading ? "live" : undefined;
  /** "Paper · " in front of what a paper order's notifications say. */
  const paperTag = (text: string) => (route === "paper" ? `${t("paper.badge")} · ${text}` : text);
  /**
   * The rules' answer for the ticket's order before it's sent, for a live
   * (or demo) account with rules on; paper orders aren't checked. Only what
   * fails is returned: refusing, or a warning where the rules only warn.
   */
  const rulesOn = tradingRules.view?.on === true;
  const checkRules =
    route === "live" && trading && rulesOn
      ? async (request: OrderRequest): Promise<TicketRuleNote[]> => {
          const checks = await venueClient.checkTradingRules(trading.venue, trading.id, request);
          const warnOnly = tradingRules.view?.rules.breach === "warn";
          return checks
            .filter((c) => !c.ok)
            .map((c) => ({ rule: c.rule, message: blockText(c.rule), refuses: !warnOnly }));
        }
      : undefined;
  // Each order function takes where in the app it was called from, which
  // the engine logs with the command (it grants nothing).
  const placeOrder = route
    ? async (request: OrderRequest, origin?: Origin) => {
        // Every way of placing one (ticket, quick trade, the drawer) says how
        // it went here, once.
        const text = paperTag(orderText(request, baseFor(request.market)));
        try {
          if (route === "paper") await paper.place(request);
          else if (trading) {
            stillLive(trading.venue);
            await venueClient.placeOrder(trading.venue, trading.id, request, origin);
            tradingRules.refresh();
          }
          notifyEvent({
            type: "order",
            title: t("toast.orderPlaced"),
            body: text,
            sound: "order",
            venue,
            market: request.market,
          });
        } catch (err) {
          const why = err instanceof Error ? err.message : t("ticket.failed");
          notifyEvent({
            type: "order",
            title: t("toast.orderRejected"),
            body: `${text} · ${why}`,
            tone: "warn",
            sound: "error",
            venue,
            market: request.market,
          });
          throw err;
        }
      }
    : undefined;
  const cancelOrder = route
    ? async (order: Order, origin?: Origin) => {
        if (route === "paper") await paper.cancel(order);
        else if (trading) {
          stillLive(trading.venue);
          await venueClient.cancelOrder(trading.venue, trading.id, order.market, order.id, origin);
        }
        notifyEvent({
          type: "order",
          title: t("toast.orderCancelled"),
          body: paperTag(orderLine(order)),
          sound: "cancel",
          venue,
          market: order.market,
        });
      }
    : undefined;
  // The P&L share card: built from a position (live) or a closed trade.
  const [shareCard, setShareCard] = useState<Omit<ShareCard, "demoLabel">>();
  const openShare = (from: { position: Position } | { closed: ClosedTrade }) => {
    const quote = quoteFor("position" in from ? from.position.market : from.closed.market);
    const side = "position" in from ? from.position.side : from.closed.side;
    const lev = "position" in from ? from.position.leverage : from.closed.leverage;
    const when = (time: number) =>
      dateFormat({ dateStyle: "medium", timeStyle: "short" }).format(time);
    const brandLogo = isLightTheme(appearance.theme)
      ? logo.horizontal.lightBg
      : logo.horizontal.darkBg;
    const base = {
      venue: venueInfo.label,
      venueLogo: venueLogos[venue],
      brandLogo,
      side,
      position: {
        label: t("share.position"),
        value: t(side === "long" ? "side.long" : "side.short"),
      },
      leverage: lev ? { label: t("share.leverage"), value: `${formatNumber(lev)}x` } : undefined,
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
            ? {
                label: t("share.roi"),
                short: t("share.roi"),
                value: `${formatSigned((pnl / margin) * 100)}%`,
              }
            : undefined,
        pnl: {
          label: t("share.unrealized", { quote }),
          short: t("share.pnlShort"),
          value: formatSigned(pnl),
        },
        prices: [
          { label: t("share.entry"), value: formatNumber(p.entryPrice), kind: "entry" },
          { label: t("share.market"), value: formatNumber(p.markPrice), kind: "mark" },
        ],
        footnote: t("share.asOf", { date: when(Date.now()) }),
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
          roi === undefined
            ? undefined
            : { label: t("share.roi"), short: t("share.roi"), value: `${formatSigned(roi)}%` },
        pnl: {
          label: t("share.realized", { quote }),
          short: t("share.pnlShort"),
          value: formatSigned(pnl),
        },
        prices: [
          { label: t("share.entry"), value: formatNumber(c.entryPrice), kind: "entry" },
          { label: t("share.exit"), value: formatNumber(c.exitPrice), kind: "exit" },
        ],
        footnote: t("share.closedAt", { date: when(c.time) }),
      });
    }
  };
  const amend = route
    ? async (order: Order, change: OrderAmend, origin?: Origin) => {
        if (route === "paper") await paper.amend(order, change);
        else if (trading) {
          stillLive(trading.venue);
          await venueClient.amendOrder(
            trading.venue,
            trading.id,
            order.market,
            order.id,
            change,
            origin,
          );
        }
        notifyEvent({
          type: "order",
          title: t("toast.orderChanged"),
          body: paperTag(symbolFor(order.market)),
          sound: "saved",
          venue,
          market: order.market,
        });
      }
    : undefined;
  const protect = route
    ? async (position: Position, protection: PositionProtection, origin?: Origin) => {
        if (route === "paper") await paper.protect(position, protection);
        else if (trading) {
          stillLive(trading.venue);
          await venueClient.setProtection(
            trading.venue,
            trading.id,
            position.market,
            protection,
            origin,
          );
        }
        notifyEvent({
          type: "order",
          title: t("toast.protectionSaved"),
          body: paperTag(symbolFor(position.market)),
          sound: "saved",
          venue,
          market: position.market,
        });
      }
    : undefined;
  /** The order functions as called from `origin`, for the engine's log. */
  const from = (origin: Origin) => ({
    place: placeOrder && ((request: OrderRequest) => placeOrder(request, origin)),
    cancel: cancelOrder && ((order: Order) => cancelOrder(order, origin)),
    amend: amend && ((order: Order, change: OrderAmend) => amend(order, change, origin)),
    protect:
      protect &&
      ((position: Position, protection: PositionProtection) =>
        protect(position, protection, origin)),
  });
  /** "Buy 120 BTC @ 80,000": an open order in a line. */
  const orderLine = (order: Order) =>
    `${t(order.side === "buy" ? "side.buy" : "side.sell")} ${formatNumber(order.size)} ${baseFor(order.market)}${
      order.price ? ` @ ${formatNumber(order.price)}` : ""
    }`;
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
  // Remembered, so a reload comes back to the page that was open.
  // The header's tabs: each holds a page of its own, and the one on screen's
  // is the page. Kept, so a reload comes back to the same tabs.
  const [tabs, setTabs] = useState(loadTabs);
  useEffect(() => saveTabs(tabs), [tabs]);
  const page = activePage(tabs);
  const setPage = useCallback((next: Page) => setTabs((now) => withPage(now, next)), []);
  // The pages opened this session, for stepping back and forward. However
  // a page was opened (the menu, the palette, a shortcut), it lands here.
  const [history, setHistory] = useState(() => startHistory(page));
  useEffect(() => setHistory((h) => visited(h, page)), [page]);
  // Market alerts, checked while the app runs; the popover is the header's bell.
  const [alertsOpen, setAlertsOpen] = useState(false);
  // The command palette: Cmd+K (Ctrl+K off macOS), from anywhere in the window.
  const [paletteOpen, setPaletteOpen] = useState(false);
  // Which Settings section a shortcut asked for ("?" opens the hotkeys list).
  const [settingsSection, setSettingsSection] = useState<SettingsSection>();
  // The venue whose wallet dialog is open (Hyperliquid and Aster connect with a wallet).
  const [walletFor, setWalletFor] = useState<VenueId>();
  // The exchange whose API-key dialog is open (Bybit connects with a key, not a wallet).
  const [apiKeyFor, setApiKeyFor] = useState<VenueId>();
  /**
   * Opens the venue's own connect flow: a wallet, or an exchange API key.
   * A venue that can't connect yet says so, rather than opening another's.
   */
  const openConnect = (id: VenueId = venue) => {
    if (!VENUES[id].connectable) {
      toast({ title: VENUES[id].label, body: t("venues.connectSoon"), tone: "warn" });
    } else if (VENUES[id].auth === "apiKey") {
      setApiKeyFor(id);
    } else {
      setWalletFor(id);
    }
  };
  const [aboutOpen, setAboutOpen] = useState(false);
  // A market picked from the tray panel goes on screen, switching venue if need be.
  const showFromTray = useRef(showMarket);
  showFromTray.current = showMarket;
  // biome-ignore lint/correctness/useExhaustiveDependencies: `setPage` is a state setter, the same every render
  useEffect(
    () =>
      appClient.onTraySelectMarket(({ venue, marketId, chart }) => {
        if (!VENUE_IDS.includes(venue)) return;
        showFromTray.current(venue, marketId);
        // From the floating window: straight to that market's chart.
        if (chart) {
          setPage("trade");
          setChartRequest((n) => n + 1);
        }
      }),
    [],
  );
  // Opened from the macOS menu bar's "About PewterDesk".
  useEffect(() => appClient.onOpenAbout(() => setAboutOpen(true)), []);
  // Whether the app's sounds play (lib/sound reads the same stored choice).
  const [sound, setSound] = useStoredChoice("pd.sound", SOUND, "on");
  // Switched on, it says so; the choice is saved before the sound checks it.
  const changeSound = (on: boolean) => {
    setSound(on ? "on" : "off");
    if (on) setTimeout(() => playSound("saved"), 80);
  };

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
  // The ticket's confirmation: on by default; turning it back on in Settings
  // also forgets "don't confirm orders under…".
  const [orderConfirm, setOrderConfirm] = useState(loadOrderConfirm);
  const updateOrderConfirm = (next: OrderConfirmPrefs) => {
    setOrderConfirm(next);
    saveOrderConfirm(next);
  };
  // One market order of a quantity, built like the ticket's (size on the
  // market's step, the venue's slippage bound): the quick trade bar's, and
  // the Multi-chart page's buttons.
  const marketOrder = placeOrder
    ? async (market: Market, side: "buy" | "sell", sizeBase: number, origin?: Origin) => {
        const built = ticketOrder({
          market,
          type: "market",
          side,
          sizeBase,
          limitPrice: "",
          trigger: "",
          reduceOnly: false,
          tpsl: false,
          maxSlippage: venueInfo.maxSlippage,
        });
        if (!("request" in built)) {
          toast({ title: t("quick.title"), body: t("ticket.needSize"), tone: "warn" });
          // Not placed: what's typed is kept.
          throw new Error(t("ticket.needSize"));
        }
        await placeOrder(built.request, origin);
      }
    : undefined;
  const quickOrder =
    marketOrder && selected
      ? (side: "buy" | "sell") => marketOrder(selected, side, Number(quickQty) || 0, "quick-trade")
      : undefined;
  // Why orders can't be placed here, where there's a better reason than "not yet".
  const tradeUnavailable = !paperOn && activeOnVenue && !trading ? t("ticket.liveOff") : undefined;
  // Computed once: a fresh object each render would keep resetting the bar.
  const [quickDefault] = useState(defaultQuickTradePosition);
  const bookData = book.status === "live" || book.status === "closed" ? book.data : undefined;
  const bestBid = bookData?.bids[0]?.price;
  const bestAsk = bookData?.asks[0]?.price;
  const stats = useMarketStats(venue, selected?.id);
  const barSummaries = useMarketSummaries(venue, true);
  const paper = usePaper({
    venue,
    markets: marketList,
    summaries:
      barSummaries.status === "live" || barSummaries.status === "closed"
        ? barSummaries.data
        : undefined,
    selected,
    bid: bestBid,
    ask: bestAsk,
  });
  const statsData = stats.status === "live" || stats.status === "closed" ? stats.data : undefined;
  // The bottom bar's status, from what's actually arriving: offline when the
  // network or a feed goes, connecting while the venue has gone quiet.
  const connection = useConnection(
    book.status === "live" ? book.data : undefined,
    stats.status === "live" ? stats.data : undefined,
    markets.status === "error" || book.status === "error" || book.status === "closed",
  );
  // In paper mode the venue's own account isn't read at all: the panels show the paper one.
  const venueAccount = useAccount(venue, paperOn ? undefined : address);
  const account = paperOn ? paper.account : venueAccount;
  // The Portfolio page's history: read only while that page is open.
  const venueClosed = useClosedHistory(
    venue,
    paperOn ? undefined : address,
    HISTORY_MS,
    page === "portfolio",
  );
  const closedHistory: Feed<ClosedTrade[]> = paperOn
    ? { status: "live", data: paper.state.closed }
    : venueClosed;
  /** Whose account is on screen: the paper one, or the venue account's. */
  const accountKey = paperOn ? `paper:${venue}` : address && `${venue}:${address}`;
  // The position open in the drawer, followed live in the account; it goes
  // when the position does (closed), or with a switch of venue or account.
  const [drawerFor, setDrawerFor] = useState<{ market: string; side: Position["side"] }>();
  const drawerPosition =
    drawerFor && (account.status === "live" || account.status === "closed")
      ? account.data.positions.find(
          (p) => p.market === drawerFor.market && p.side === drawerFor.side,
        )
      : undefined;
  const drawerDetail = usePositionDetail(
    venue,
    paperOn ? undefined : address,
    drawerPosition,
    paperOn ? paper.state : undefined,
  );
  const venueSettings = useTradeSettings(
    venue,
    paperOn ? undefined : address,
    selected?.id,
    trading,
    "ticket",
  );
  const tradeSettings = paperOn
    ? {
        settings: paper.settings,
        setLeverage: paper.setLeverage,
        setMarginMode: paper.setMarginMode,
      }
    : venueSettings;
  const { setLeverage: applyLeverage, setMarginMode: applyMarginMode } = tradeSettings;
  const changeLeverage =
    applyLeverage &&
    (async (leverage: number) => {
      await applyLeverage(leverage);
      playSound("saved");
      toast({
        title: t("toast.leverageSet"),
        body: t("toast.leverageBody", { symbol: selected?.symbol ?? "", leverage }),
      });
    });
  const changeMarginMode =
    applyMarginMode &&
    (async (mode: MarginMode) => {
      await applyMarginMode(mode);
      playSound("saved");
      toast({
        title: t("toast.marginSet"),
        body: t(mode === "isolated" ? "ticket.isolated" : "ticket.cross"),
      });
    });

  // What happens to the account between snapshots (fills, positions opened
  // and closed), as toasts. The first snapshot of an account is the baseline.
  const lastSnapshot = useRef<{ key: string; data: AccountSnapshot } | undefined>(undefined);
  const liveAccount =
    account.status === "live" || account.status === "closed" ? account.data : undefined;
  // The alerts, with the connected account's positions for the PnL and
  // liquidation-distance ones.
  const alerts = useAlerts(alertsOpen, liveAccount);
  // Hyperliquid and Aster publish no open-interest history: sample it for the Maps page.
  useOiRecorder();
  // The notification centre: everything `notifyEvent` has recorded.
  const notes = useSyncExternalStore(subscribeNotes, currentNotes);
  const noteSettings = useSyncExternalStore(subscribeNotes, currentNoteSettings);
  // biome-ignore lint/correctness/useExhaustiveDependencies: runs per snapshot; the lookups it reads are stable enough
  useEffect(() => {
    if (!liveAccount || !accountKey) return;
    const key = accountKey;
    const prev = lastSnapshot.current;
    lastSnapshot.current = { key, data: liveAccount };
    if (!prev || prev.key !== key) return;
    const events = accountEvents(prev.data, liveAccount);
    // One sound for the snapshot, however many things changed in it.
    let sound: SoundKind | undefined = "fill";
    const announce = (input: Omit<NoteInput, "sound" | "venue">) => {
      notifyEvent({ ...input, sound, venue });
      sound = undefined;
    };
    for (const event of events) {
      if (event.kind === "partialFill") {
        const o = event.order;
        announce({
          type: "fill",
          market: o.market,
          title: t("toast.partiallyFilled"),
          tone: o.side,
          body: t("toast.partialBody", {
            side: t(o.side === "buy" ? "side.buy" : "side.sell"),
            filled: formatNumber(o.filledSize),
            size: formatNumber(o.size),
            base: baseFor(o.market),
            price: o.price ? formatNumber(o.price) : "-",
            resting: formatNumber(Number(o.size) - Number(o.filledSize), decimalsOf(o.size)),
          }),
        });
        continue;
      }
      const p = event.position;
      const side = t(p.side === "long" ? "side.long" : "side.short");
      const tone = p.side === "long" ? "buy" : "sell";
      if (event.kind === "positionResized") {
        const grew = Number(p.size) > Number(event.from);
        announce({
          type: "position",
          market: p.market,
          title: t(grew ? "toast.positionIncreased" : "toast.positionReduced"),
          tone,
          body: t("toast.resizeBody", {
            side,
            from: formatNumber(event.from),
            to: formatNumber(p.size),
            base: baseFor(p.market),
          }),
        });
      } else {
        const opened = event.kind === "positionOpened";
        announce({
          type: "position",
          market: p.market,
          title: t(opened ? "toast.positionOpened" : "toast.positionClosed"),
          tone: opened ? tone : "neutral",
          body: t("toast.positionBody", {
            side,
            size: formatNumber(p.size),
            base: baseFor(p.market),
            price: formatNumber(opened ? p.entryPrice : p.markPrice),
          }),
        });
      }
    }
  }, [liveAccount]);

  // A market alert that fires says so, wherever you are in the app.
  const newestFired = alerts.fired[0];
  const lastFired = useRef(newestFired?.id);
  useEffect(() => {
    if (!newestFired || newestFired.id === lastFired.current) return;
    const until = alerts.fired.findIndex((f) => f.id === lastFired.current);
    lastFired.current = newestFired.id;
    let sound: SoundKind | undefined = "alert";
    for (const f of alerts.fired.slice(0, until === -1 ? 1 : until).reverse()) {
      // Each alert goes only where it was set to: in app, desktop, sound, the menu bar.
      const only = f.notify?.flatMap((c): NoteChannel[] =>
        c === "app" ? ["toast"] : c === "desktop" ? ["desktop"] : c === "sound" ? ["sound"] : [],
      );
      notifyEvent({
        type: "alert",
        title: t("toast.alert"),
        body: firedAlertText(f),
        sound,
        only,
        venue: f.venue,
        market: f.market || undefined,
      });
      if (f.notify?.includes("menuBar")) flashTray(firedAlertText(f));
      if (!only || only.includes("sound")) sound = undefined;
    }
  }, [newestFired, alerts.fired]);

  // A position close to its liquidation price: a toast and a sound, once, and again only after it has moved back out of range.
  const warned = useRef(new Set<string>());
  // biome-ignore lint/correctness/useExhaustiveDependencies: runs per snapshot; the lookups it reads are stable enough
  useEffect(() => {
    // No snapshot (loading, or a reconnect) says nothing about the positions:
    // what was warned about stays warned about.
    if (!liveAccount) return;
    const still = new Set<string>();
    for (const p of liveAccount.positions) {
      const distance = liquidationDistance(p);
      if (distance === undefined) continue;
      const key = positionKey(p);
      const already = warned.current.has(key);
      // Warned once within the threshold; forgotten only once it's back out
      // past a wider one, so hovering at the edge doesn't warn again.
      if (already && distance <= RISK_CLEAR) still.add(key);
      if (already || distance > RISK_WITHIN) continue;
      still.add(key);
      // A toast here; outside the app, the floating window shows it as a
      // notification of its own (FloatWindow), so no system one as well.
      notifyEvent({
        type: "risk",
        title: t("notify.liqTitle", { symbol: symbolFor(p.market) }),
        body: t("notify.liqBody", { pct: formatNumber(distance * 100, 2) }),
        tone: "warn",
        sound: "alert",
        noDesktop: true,
        venue,
        market: p.market,
      });
    }
    warned.current = still;
  }, [liveAccount]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: a switch of venue or account closes it
  useEffect(() => setDrawerFor(undefined), [venue, address]);
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
  // The floating card's PnL: all time (realised over the account's life plus
  // what's open), from its last reset, sampled for its line.
  const pnlAccount = accountKey || undefined;
  // Tagged with its account, so a sample can't land in the previous one's history.
  const [pnlStore, setPnlStore] = useState<{ account?: string; history: PnlHistory }>({
    history: EMPTY_HISTORY,
  });
  const pnlHistory = pnlStore.account === pnlAccount ? pnlStore.history : EMPTY_HISTORY;
  useEffect(() => {
    setPnlStore({
      account: pnlAccount,
      history: pnlAccount ? loadPnlHistory(pnlAccount) : EMPTY_HISTORY,
    });
  }, [pnlAccount]);
  const allTime =
    accountData && unrealized !== undefined
      ? allTimePnl(
          accountData.realizedPnl === undefined ? undefined : Number(accountData.realizedPnl),
          unrealized,
        )
      : undefined;
  useEffect(() => {
    if (!pnlAccount || allTime === undefined || !accountData) return;
    setPnlStore((s) => {
      if (s.account !== pnlAccount) return s;
      const history = recordPnl(s.history, accountData.time || Date.now(), allTime);
      savePnlHistory(pnlAccount, history);
      return { account: pnlAccount, history };
    });
  }, [pnlAccount, allTime, accountData]);
  const resetCardPnl = () => {
    if (!pnlAccount || allTime === undefined) return;
    const next = resetPnl(Date.now(), allTime);
    savePnlHistory(pnlAccount, next);
    setPnlStore({ account: pnlAccount, history: next });
  };
  const pnlTrend =
    unrealized === undefined || unrealized === 0 ? undefined : unrealized > 0 ? "up" : "down";
  // Read only while the News page is open.
  // Bybit's, whichever venue is on screen: no other venue publishes any the app can read.
  const announcements = useAnnouncements("bybit", page === "news");
  const newsWire = useNewsWire(page === "news");
  const barPrices =
    barSummaries.status === "live" || barSummaries.status === "closed"
      ? barSummaries.data
      : undefined;
  // BTC's price on this venue (the first of its majors), for the card's BTC figures.
  const btcMark = barPrices?.find((s) => s.market === venueInfo.majors[0])?.markPrice;
  const btcPrice = btcMark ? Number(btcMark) : undefined;
  // The menu-bar (tray) item: price and PnL, even with the window closed.
  useTraySync({
    market: selected,
    stats: stats.status === "live" || stats.status === "closed" ? stats.data : undefined,
    // The menu bar shows real money only: never a paper account's P&L.
    account: paperOn ? undefined : accountData,
  });

  const maxLeverageFor = useCallback(
    (id: string) => marketList.find((m) => m.id === id)?.maxLeverage,
    [marketList],
  );

  const symbolFor = useCallback(
    (id: string) => marketList.find((m) => m.id === id)?.symbol ?? id,
    [marketList],
  );
  // Algo orders: the engine runs them; this keeps them on screen and says
  // when one ends, or stops or pauses on its own.
  const algoBook = useAlgos(symbolFor);
  /** Who a new algo trades for: the live (or demo) account on screen, never paper. */
  const algoTarget: AlgoTarget | undefined =
    route === "live" && trading
      ? {
          venue: trading.venue,
          account: trading.id,
          maxSlippageBps: slippageBps(venueInfo.maxSlippage),
        }
      : undefined;
  const algoUnavailable = paperOn ? t("algo.noPaper") : trading ? undefined : t("algo.noAccount");
  /** Starts an algo from `origin`; unset where none can be started. */
  const startAlgoFrom = (origin: Origin) =>
    algoTarget
      ? async (spec: AlgoSpec) => {
          await algoBook.start(spec, origin);
        }
      : undefined;
  const haltAlgos = async () => {
    await algoBook.halt();
  };
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

  /** Puts another set of tabs up; like `goTo`, leaving the workspace ends layout editing. */
  const showTabs = (next: TabsState) => {
    if (next === tabs) return;
    if (activePage(next) !== "trade" && editing) finishEditing();
    setTabs(next);
  };

  /** One page back or forward through the ones opened, where there is one. */
  const step = (by: -1 | 1) => {
    const to = stepTo(history, by);
    if (to === undefined) return;
    setHistory(stepped(history, by));
    goTo(to);
  };
  // The app-wide shortcuts (`lib/hotkeys.ts`; Settings lists them), and a
  // mouse's side buttons for back and forward. Each page adds its own keys.
  const onHotkey = (action: HotkeyAction) => {
    switch (action.type) {
      case "palette":
        return setPaletteOpen((open) => !open);
      case "page":
        return goTo(action.page);
      case "settings":
        setSettingsSection(undefined);
        return goTo(page === "settings" ? "trade" : "settings");
      case "help":
        setSettingsSection("hotkeys");
        return goTo("settings");
      case "newTab":
        return showTabs(opened(tabs));
      case "tab":
        return showTabs(tabStepped(tabs, action.by));
      case "back":
        return step(-1);
      case "forward":
        return step(1);
      case "quickTrade":
        // The bar belongs to the Trade page.
        if (page === "trade") updateQuickTrade({ ...quickTrade, open: !quickTrade.open });
        return;
    }
  };
  const hotkeyRef = useRef(onHotkey);
  hotkeyRef.current = onHotkey;
  const stepRef = useRef(step);
  stepRef.current = step;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const action = hotkeyFor(e, isTyping(e.target));
      if (!action) return;
      e.preventDefault();
      hotkeyRef.current(action);
    };
    const onMouse = (e: MouseEvent) => {
      if (e.button !== 3 && e.button !== 4) return;
      e.preventDefault();
      stepRef.current(e.button === 3 ? -1 : 1);
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("mouseup", onMouse);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("mouseup", onMouse);
    };
  }, []);

  /** Leaving edit mode closes any gaps the edits left behind. */
  const finishEditing = () => {
    setEditing(false);
    setWorkspace((w) => withLayout(w, fillGaps(w.layout)));
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
            address={address}
            account={accountData}
            paperFills={paperOn ? paper.state.fills : undefined}
            positions={accountData?.positions}
            alerts={alerts}
            onProtect={from("chart").protect}
            showChart={chartRequest}
            chartOverlay={<AlgoChartChips algos={algoBook.algos} market={selected} />}
          />
        );
      case "orderBook":
        return (
          <OrderBookPanel
            venue={venue}
            book={book}
            market={selected}
            marketsLoading={markets.status === "loading"}
            markPrice={statsData?.markPrice}
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
            onCancel={from("activity").cancel}
            quoteFor={quoteFor}
            baseFor={baseFor}
            tickFor={tickFor}
            onProtect={from("activity").protect}
            onAmend={from("activity").amend}
            onShare={openShare}
            paper={paperOn ? paper.state : undefined}
            onSelectPosition={(p) => {
              showMarket(venue, p.market);
              setChartRequest((n) => n + 1);
              setDrawerFor({ market: p.market, side: p.side });
            }}
          />
        );
      case "wire":
        // Tree News and Phoenix, live: text from Rust; a ticker shows its market here.
        return (
          <NewsWirePanel
            markets={marketList}
            onMarket={(marketId) => showMarket(venue, marketId)}
            onAddKey={() => {
              setSettingsSection("advanced");
              goTo("settings");
            }}
          />
        );
      case "calendar":
        // The week's economic calendar: text from Rust, no links.
        return <CalendarPanel />;
      case "algos":
        // Chasers, TWAPs and ladders: the engine runs them, through the same gate.
        return (
          <AlgosPanel
            algos={algoBook.algos}
            history={algoBook.history}
            onLoadHistory={algoBook.loadHistory}
            market={selected}
            symbolFor={symbolFor}
            target={algoTarget}
            unavailable={algoUnavailable}
            onStart={(spec) => algoBook.start(spec, "app")}
            onPause={algoBook.pause}
            onResume={algoBook.resume}
            onStop={algoBook.stop}
            onHalt={algoBook.halt}
          />
        );
      case "cli":
        // The palette's commands, typed into a panel; nothing is sent until confirmed.
        return (
          <CliPanel
            markets={marketList}
            current={selected}
            where={activeOnVenue?.name || venueInfo.label}
            summaries={
              barSummaries.status === "live" || barSummaries.status === "closed"
                ? barSummaries.data
                : undefined
            }
            account={liveAccount}
            maxSlippageBps={slippageBps(venueInfo.maxSlippage)}
            place={from("cli-panel").place}
            cancel={from("cli-panel").cancel}
            protect={from("cli-panel").protect}
            startAlgo={startAlgoFrom("cli-panel")}
            algoTarget={algoTarget}
            halt={haltAlgos}
            onMarket={(marketId) => showMarket(venue, marketId)}
            onPage={goTo}
          />
        );
      case "trade":
        // Orders go to Bybit accounts (a live one once live trading is on);
        // elsewhere there's no onSubmit, and the button says why.
        return (
          <div className="app-scroll">
            <OrderTicket
              market={selected}
              book={bookData}
              account={accountData}
              accountNotice={
                paperOn
                  ? // Paper needs no wallet: until prices arrive it waits, never "Connect".
                    t("paper.waiting")
                  : address === undefined
                    ? undefined
                    : account.status === "error"
                      ? // The venue's reason, without "Invalid request:" in front.
                        account.message.replace(/^[^:]{1,24}: /, "")
                      : t("feed.loading")
              }
              fees={selected?.listedBy ? undefined : venueInfo.fees}
              maxSlippage={venueInfo.maxSlippage}
              onConnect={() => openConnect()}
              onSubmit={from("ticket").place}
              unavailableReason={tradeUnavailable}
              accountBadge={
                paperOn
                  ? t("paper.badge")
                  : tradingLive
                    ? t("apiKey.live")
                    : activeOnVenue && isDemoAccount(activeOnVenue)
                      ? t("accounts.demo")
                      : undefined
              }
              accountBadgeTone={tradingLive ? "live" : undefined}
              settings={tradeSettings.settings}
              onLeverage={changeLeverage}
              onMarginMode={changeMarginMode}
              confirmOrders={orderConfirm.enabled}
              confirmSkipUnder={orderConfirm.skipUnder}
              onConfirmSkipUnder={(skipUnder) => updateOrderConfirm({ enabled: true, skipUnder })}
              fallbackPrice={statsData ? Number(statsData.markPrice) || undefined : undefined}
              checkRules={checkRules}
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
            <AppLogo className="app-logo" />
          </button>
          {/* The tabs: the one on screen is the page menu, so its page can be
              changed; the others switch to theirs. */}
          <nav className="app-tabs" aria-label={t("tabs.label")}>
            {tabs.tabs.map((tab) => (
              <span
                key={tab.id}
                className="app-tab"
                data-active={tab.id === tabs.active || undefined}
              >
                {tab.id === tabs.active ? (
                  <OptionsMenu
                    label={t("nav.menu")}
                    heading={t("nav.menu")}
                    triggerText={pageLabel(page)}
                    className="app-page-menu"
                    menuClassName="app-page-list"
                    options={pageOptions()}
                    value={page}
                    onChange={goTo}
                  />
                ) : (
                  <button
                    type="button"
                    className="app-tab-button"
                    onClick={() => showTabs(tabSelected(tabs, tab.id))}
                  >
                    {pageLabel(tab.page)}
                  </button>
                )}
                {tabs.tabs.length > 1 && (
                  <button
                    type="button"
                    className="app-tab-close"
                    aria-label={t("tabs.close", { page: pageLabel(tab.page) })}
                    title={t("tabs.close", { page: pageLabel(tab.page) })}
                    onClick={() => showTabs(closed(tabs, tab.id))}
                  >
                    <LuX size={12} aria-hidden />
                  </button>
                )}
              </span>
            ))}
            {tabs.tabs.length < MAX_TABS && (
              <button
                type="button"
                className="pd-icon-button app-tab-add"
                aria-label={t("tabs.new")}
                title={t("tabs.new")}
                onClick={() => showTabs(opened(tabs))}
              >
                <LuPlus size={15} aria-hidden />
              </button>
            )}
          </nav>
          <VenueSwitcher
            venue={venue}
            venues={setup.venues}
            // The page stays as it is: Portfolio, News or Maps for the new venue.
            onChange={(id) => showMarket(id)}
            onSeeAll={() => goTo("venues")}
          />
          {paper.available && (
            <PaperSwitch on={paperOn} venue={venueInfo.label} onChange={paper.setOn} />
          )}
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
            onPalette={() => setPaletteOpen(true)}
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
            onSound={changeSound}
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
                onCreate={(draft) => {
                  alerts.create(draft);
                  playSound("saved");
                }}
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
            notifications={
              <NotificationCentre
                notes={notes.map((n) => ({
                  ...n,
                  // Openable when it names a market on a venue the app knows.
                  marketLabel:
                    n.market && VENUE_IDS.some((v) => v === n.venue)
                      ? n.venue === venue
                        ? symbolFor(n.market)
                        : n.market
                      : undefined,
                }))}
                dnd={noteSettings.dnd}
                onRead={markNotesRead}
                onClear={clearNotes}
                onGoTo={(id) => {
                  const n = notes.find((x) => x.id === id);
                  const v = VENUE_IDS.find((x) => x === n?.venue);
                  if (!n?.market || !v) return;
                  setPage("trade");
                  showMarket(v, n.market);
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
            closed={closedHistory}
            accountKey={accountKey || undefined}
            onShare={(c) => openShare({ closed: c })}
            markets={marketList}
            venue={paperOn ? `${venueInfo.label} · ${t("paper.badge")}` : venueInfo.label}
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
        ) : page === "bots" ? (
          <BotsPage
            venue={venue}
            venueLabel={(v) => VENUES[v].label}
            markets={marketList}
            priceOf={(m) => {
              const mark = Number(barPrices?.find((s) => s.market === m)?.markPrice);
              return mark > 0 ? mark : undefined;
            }}
            marketLabel={(v, m) =>
              (v === venue ? marketList.find((x) => x.id === m)?.symbol : undefined) ?? m
            }
          />
        ) : page === "rules" ? (
          <TradingRulesPage
            venue={venue}
            account={address}
            equity={accountData ? Number(accountData.equity) : undefined}
            views={tradingRules.views}
            status={tradingRules.status}
            error={tradingRules.error}
            venueLabel={(id) => VENUES[id].label}
            coinOf={baseFor}
            onSave={tradingRules.save}
            onRemove={tradingRules.remove}
            onConnect={() => openConnect()}
          />
        ) : page === "news" ? (
          <NewsPage
            venue={venue}
            venueLabel={venueInfo.label}
            announcer={VENUES.bybit.label}
            news={announcements}
            wire={newsWire}
            markets={marketList}
            summaries={
              barSummaries.status === "live" || barSummaries.status === "closed"
                ? barSummaries.data
                : undefined
            }
            positions={liveAccount?.positions ?? []}
            onTrade={(id) => {
              showMarket(venue, id);
              setPage("trade");
            }}
          />
        ) : page === "charts" ? (
          <MultiChartPage
            venue={venue}
            venues={venueChips}
            account={accountData}
            onTrade={(v, id) => {
              showMarket(v, id);
              setPage("trade");
            }}
            onProtect={from("multichart").protect}
            onOrder={marketOrder && ((m, side, size) => marketOrder(m, side, size, "multichart"))}
            tradeUnavailable={tradeUnavailable ?? t("quick.unavailable")}
          />
        ) : page === "maps" ? (
          <MapsPage
            venue={venue}
            venueLabel={venueInfo.label}
            markets={marketList}
            selected={selected?.id}
            onTrade={(m) => {
              showMarket(venue, m.id);
              setPage("trade");
            }}
          />
        ) : page === "settings" ? (
          <SettingsPage
            section={settingsSection}
            onClose={() => goTo("trade")}
            soundOn={sound === "on"}
            onSound={changeSound}
            confirmOrders={orderConfirm.enabled}
            onConfirmOrders={(enabled) => {
              updateOrderConfirm({ enabled });
              playSound("saved");
            }}
            onTestNotification={() =>
              // Says how it went: a banner that doesn't appear is otherwise silence.
              void desktopNotify(t("notify.testTitle"), t("notify.testBody"), true).then((sent) =>
                toast(
                  sent
                    ? { title: t("notify.testSent"), body: t("notify.testSentHelp") }
                    : {
                        title: t("notify.testFailed"),
                        body: t("notify.testFailedHelp"),
                        tone: "warn",
                      },
                ),
              )
            }
            theme={appearance.theme}
            onTheme={themeTransition.switchTheme}
            marketColors={appearance.market}
            onMarketColors={appearance.setMarket}
            address={activeAccount(accounts, "hyperliquid")?.id}
            onOpenWallet={() => setWalletFor("hyperliquid")}
            onResetLayout={() =>
              setWorkspace((w) => ({
                ...w,
                layout: DEFAULT_PRESET.layout,
                active: DEFAULT_PRESET.name,
              }))
            }
            activeLayout={workspace.active}
            savedLayouts={workspace.saved}
            onApplyLayout={(l) => {
              setWorkspace((w) => ({ ...w, layout: fillGaps(l.layout), active: l.name }));
              goTo("trade");
            }}
            onEditLayout={() => {
              setEditing(true);
              goTo("trade");
            }}
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
                changed={isChanged(workspace)}
                onSaveAs={(name) => setWorkspace((w) => saveAs(w, name))}
                onNew={(name) => setWorkspace((w) => newLayout(w, name))}
                onDelete={(name) =>
                  setWorkspace((w) => ({ ...w, saved: w.saved.filter((s) => s.name !== name) }))
                }
                onDone={finishEditing}
                onBrowse={() => {
                  setSettingsSection("layout");
                  goTo("settings");
                }}
              />
            )}

            <ConnectionBanner venue={venueInfo.label} connection={connection} />
            {paperOn && (
              <PaperBanner
                venue={venueInfo.label}
                quote={selected?.quote ?? "USD"}
                snapshot={accountData}
                start={paper.state.start}
                onFunds={() => setPaperDialog("funds")}
                onReset={() => setPaperDialog("reset")}
                onLive={() => paper.setOn(false)}
              />
            )}
            <RulesBanner
              rules={tradingRules.view?.rules}
              status={tradingRules.status}
              onOpen={() => goTo("rules")}
            />
            <div className="app-body">
              <WorkspaceGrid
                layout={workspace.layout}
                editing={editing}
                dragging={dragging}
                onChange={(layout) => setWorkspace((w) => withLayout(w, layout))}
                onDrop={(kind, at) => {
                  setDragging(undefined);
                  setWorkspace((w) => withLayout(w, addPanel(w.layout, kind, at)));
                }}
                onRemove={(id) =>
                  setWorkspace((w) => withLayout(w, fillGaps(removePanel(w.layout, id))))
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
                  onAdd={(kind) => setWorkspace((w) => withLayout(w, addPanel(w.layout, kind)))}
                />
              )}
            </div>
          </>
        )}

        <ConnectWalletDialog
          open={walletFor !== undefined}
          // The last venue stays while the dialog closes, so it doesn't flip to another's.
          venue={walletFor ?? (VENUES[venue].auth === "wallet" ? venue : "hyperliquid")}
          onClose={() => setWalletFor(undefined)}
        />
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
            // "Open in chart": the market, on the Trade page, wherever it's asked from.
            onOpen={(m) => {
              showMarket(m.venue, m.id);
              goTo("trade");
            }}
          />
        </StatusBar>

        {/* Market orders, where the account can trade; elsewhere the buttons show why. */}
        {quickTrade.open && page === "trade" && (
          <QuickTrade
            base={selected?.base}
            quote={selected?.quote}
            onLong={quickOrder && (() => quickOrder("buy"))}
            onShort={quickOrder && (() => quickOrder("sell"))}
            unavailableReason={tradeUnavailable}
            bid={bestBid === undefined ? undefined : Number(bestBid)}
            ask={bestAsk === undefined ? undefined : Number(bestAsk)}
            decimals={decimalsOf(bestBid ?? bestAsk ?? "0")}
            qty={quickQty}
            onQty={setQuickQty}
            position={quickTrade.position ?? quickDefault}
            // Over the chart, where it's used, not over the tables around it.
            within={() => document.querySelector("[data-quick-trade-area]")}
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
            pnl={allTime === undefined ? undefined : allTime - pnlHistory.baseline}
            connected={accountData !== undefined}
            unit={pnlCard.unit ?? "quote"}
            onUnit={(unit) =>
              updatePnlCard({ ...pnlCard, unit: unit === "btc" ? "btc" : undefined })
            }
            btcPrice={btcPrice}
            history={pnlHistory.points}
            showChart={pnlCard.chart ?? false}
            onToggleChart={() => updatePnlCard({ ...pnlCard, chart: !pnlCard.chart || undefined })}
            onReset={resetCardPnl}
            since={pnlHistory.resetAt}
            breakdown={
              unrealized === undefined
                ? undefined
                : {
                    realized:
                      accountData?.realizedPnl === undefined
                        ? undefined
                        : Number(accountData.realizedPnl),
                    open: unrealized,
                  }
            }
            connectText={t(venueInfo.auth === "apiKey" ? "pnl.connectApiKey" : "pnl.connect")}
            onConnect={() => openConnect()}
            position={pnlCard.position ?? pnlDefault}
            onMove={(position) => updatePnlCard({ ...pnlCard, position })}
            scale={pnlCard.scale}
            onResize={(scale) => updatePnlCard({ ...pnlCard, scale })}
            onClose={() => updatePnlCard({ ...pnlCard, open: false })}
          />
        )}

        {drawerPosition && (
          <PositionDrawer
            key={`${drawerPosition.market}:${drawerPosition.side}`}
            position={drawerPosition}
            symbol={symbolFor(drawerPosition.market)}
            base={baseFor(drawerPosition.market)}
            quote={quoteFor(drawerPosition.market)}
            tick={tickFor(drawerPosition.market)}
            fills={drawerDetail.fills?.fills}
            openedAt={drawerDetail.fills?.openedAt}
            funding={drawerDetail.funding}
            pnlHistory={drawerDetail.pnl}
            maxSlippage={venueInfo.maxSlippage}
            onProtect={protect && ((protection) => protect(drawerPosition, protection, "drawer"))}
            onPlace={from("drawer").place}
            onShare={() => openShare({ position: drawerPosition })}
            onClose={() => setDrawerFor(undefined)}
          />
        )}

        {shareCard && (
          <PnlShareDialog
            card={shareCard}
            demo={paperOn || (activeOnVenue !== undefined && isDemoAccount(activeOnVenue))}
            demoText={paperOn ? t("paper.badge") : undefined}
            onSave={appClient.saveShareImage}
            onShare={appClient.openShare}
            onClose={() => setShareCard(undefined)}
          />
        )}

        <AboutDialog open={aboutOpen} onClose={() => setAboutOpen(false)} />
        <PaperFundsDialog
          mode={paperOn ? paperDialog : undefined}
          venue={venueInfo.label}
          quote={selected?.quote ?? "USD"}
          withdrawable={paper.withdrawable}
          onAdjust={(amount) => {
            paper.adjust(amount);
            notifyEvent({
              type: "order",
              title: t(amount > 0 ? "paper.added" : "paper.reduced"),
              body: `${t("paper.badge")} · ${formatNumber(Math.abs(amount), 2)} ${selected?.quote ?? ""}`.trim(),
              sound: "saved",
              venue,
            });
          }}
          onReset={() => {
            paper.reset();
            notifyEvent({
              type: "order",
              title: t("paper.resetDone"),
              body: t("paper.badge"),
              sound: "saved",
              venue,
            });
          }}
          onClose={() => setPaperDialog(undefined)}
        />
        <CommandMenu
          open={paletteOpen}
          onClose={() => setPaletteOpen(false)}
          markets={marketList}
          current={selected}
          summaries={
            barSummaries.status === "live" || barSummaries.status === "closed"
              ? barSummaries.data
              : undefined
          }
          positions={liveAccount?.positions ?? []}
          orders={liveAccount?.openOrders ?? []}
          maxSlippageBps={slippageBps(venueInfo.maxSlippage)}
          place={from("palette").place}
          cancel={from("palette").cancel}
          protect={from("palette").protect}
          startAlgo={startAlgoFrom("palette")}
          algoTarget={algoTarget}
          halt={haltAlgos}
          themes={themeOptions()}
          onTheme={(theme) => {
            const next = THEMES.find((th) => th === theme);
            if (next) themeTransition.switchTheme(next);
          }}
          venues={venueChips}
          onVenue={(id) => showMarket(id)}
          onMarket={(id) => {
            showMarket(venue, id);
            goTo("trade");
          }}
          onPage={goTo}
          onAlerts={() => {
            goTo("trade");
            setAlertsOpen(true);
          }}
          onFloat={() => void appClient.toggleFloat()}
          onLayout={() => {
            setPage("trade");
            setExpanded(undefined);
            setEditing(true);
          }}
        />

        {/* Covers the app while a theme switch happens underneath. */}
        <Toasts />

        {themeTransition.overlay}
      </div>
    </TokenIconProvider>
  );
}
