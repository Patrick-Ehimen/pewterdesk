import { logo } from "@pewterdesk/assets";
import type { AccountSnapshot, Market, OrderBook, VenueId } from "@pewterdesk/core";
import {
  AccountSummary,
  bookLadder,
  EmptyState,
  formatNumber,
  MarketList,
  MarketStatsBar,
  OpenOrdersTable,
  OptionsMenu,
  OrderBookSkeleton,
  OrderBookView,
  PositionsTable,
  type RowMode,
  type SymbolFor,
  Tabs,
  TradesSkeleton,
  TradesView,
  t,
} from "@pewterdesk/ui";
import { type ReactNode, useCallback, useState } from "react";
import { HeaderActions } from "./components/header/HeaderActions";
import { LayoutBar } from "./components/layout/LayoutBar";
import { PanelPalette } from "./components/layout/PanelPalette";
import { WorkspaceGrid } from "./components/layout/WorkspaceGrid";
import { ROW_MODES, rowModeOptions, VIEW_KEYS } from "./components/preferences";
import { SettingsPage } from "./components/settings/SettingsPage";
import { ConnectWalletDialog } from "./components/wallet/ConnectWalletDialog";
import { isLightTheme, useAppearance } from "./hooks/useAppearance";
import { useStoredChoice } from "./hooks/useStoredChoice";
import { useThemeTransition } from "./hooks/useThemeTransition";
import {
  type Feed,
  useAccount,
  useMarketStats,
  useMarkets,
  useOrderBook,
  useTrades,
} from "./hooks/useVenueFeeds";
import { useWatchlist } from "./hooks/useWatchlist";
import { useWorkspace } from "./hooks/useWorkspace";
import { type PanelKind, panelKindOf } from "./lib/panels";
import { loadAddress, saveAddress } from "./lib/watchAddress";
import { addPanel, DEFAULT_PRESET, fillGaps, removePanel, saveAs } from "./lib/workspace";

// The only venue with an adapter so far.
const VENUE: VenueId = "hyperliquid";
const VENUE_LABEL = "Hyperliquid";
const DEFAULT_MARKET = "HYPE";

type ActivityTab = "positions" | "orders";
type BookTab = "book" | "trades";
const SOUND = ["on", "off"] as const;

/** Renders `live` for live or closed feeds, and a placeholder otherwise. */
function FeedView<T>({
  feed,
  idle,
  loading,
  live,
}: {
  feed: Feed<T>;
  idle?: ReactNode;
  /** Shown while loading, e.g. a skeleton; defaults to a plain message. */
  loading?: ReactNode;
  live: (data: T) => ReactNode;
}) {
  switch (feed.status) {
    case "idle":
      return <EmptyState>{idle}</EmptyState>;
    case "loading":
      return loading ?? <EmptyState>{t("feed.loading")}</EmptyState>;
    case "error":
      return <EmptyState error>{feed.message}</EmptyState>;
    case "live":
    case "closed":
      return (
        <>
          {feed.status === "closed" && (
            <p className="pd-stale" role="status">
              {t("feed.closed")}
            </p>
          )}
          {live(feed.data)}
        </>
      );
  }
}

/** Positions and open orders, tabbed. Each instance keeps its own tab. */
function ActivityPanel({
  account,
  symbolFor,
}: {
  account: Feed<AccountSnapshot>;
  symbolFor: SymbolFor;
}) {
  const [tab, setTab] = useState<ActivityTab>("positions");
  const snapshot = account.status === "live" || account.status === "closed" ? account.data : null;
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
        ]}
        active={tab}
        onChange={setTab}
      />
      <div className="app-scroll">
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
      </div>
    </>
  );
}

/**
 * Order book and trade tape, tabbed. The tape only subscribes while its tab
 * is showing; the book feed is shared with the header's mid price.
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
  const [selectedId, setSelectedId] = useState<string>();
  const [address, setAddress] = useState(loadAddress);
  const appearance = useAppearance();
  const themeTransition = useThemeTransition(appearance.setTheme);
  const watchlist = useWatchlist(VENUE);
  const [workspace, setWorkspace] = useWorkspace();
  const [editing, setEditing] = useState(false);
  const [dragging, setDragging] = useState<PanelKind>();
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [walletOpen, setWalletOpen] = useState(false);
  // Nothing plays sounds yet; this is the preference fill alerts will read.
  const [sound, setSound] = useStoredChoice("pd.sound", SOUND, "on");
  const watch = (next: string | undefined) => {
    saveAddress(next);
    setAddress(next);
  };

  const marketList = markets.status === "live" ? markets.data : [];
  const selected: Market | undefined =
    marketList.find((m) => m.id === selectedId) ??
    marketList.find((m) => m.id === DEFAULT_MARKET) ??
    marketList[0];

  const book = useOrderBook(VENUE, selected?.id);
  const stats = useMarketStats(VENUE, selected?.id);
  const account = useAccount(VENUE, address);

  const symbolFor = useCallback(
    (id: string) => marketList.find((m) => m.id === id)?.symbol ?? id,
    [marketList],
  );

  /** Leaving edit mode closes any gaps the edits left behind. */
  const finishEditing = () => {
    setEditing(false);
    setWorkspace((w) => ({ ...w, layout: fillGaps(w.layout) }));
  };

  const ladder =
    book.status === "live" || book.status === "closed" ? bookLadder(book.data, 1) : undefined;

  const placed = new Set(
    workspace.layout.flatMap((p) => {
      const kind = panelKindOf(p.i);
      return kind ? [kind] : [];
    }),
  );

  const renderPanel = (kind: PanelKind): ReactNode => {
    switch (kind) {
      case "markets":
        return (
          <div className="app-scroll">
            <FeedView
              feed={markets}
              live={(data) => (
                <MarketList
                  markets={data}
                  selected={selected?.id}
                  onSelect={(m) => setSelectedId(m.id)}
                  starred={watchlist.starred}
                  onToggleStar={(m) => watchlist.toggle(m.id)}
                />
              )}
            />
          </div>
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
              idle={t("feed.connectToWatch")}
              live={(data) => <AccountSummary snapshot={data} quote={selected?.quote ?? "USDC"} />}
            />
          </div>
        );
      case "positions":
        return <ActivityPanel account={account} symbolFor={symbolFor} />;
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
    <div className="app" data-editing={editing || undefined}>
      <header className="app-header">
        {/* The logo goes home: back to the trading workspace, out of settings or layout editing. */}
        <button
          type="button"
          className="app-logo-button"
          aria-label={t("header.home")}
          title={t("header.home")}
          onClick={() => {
            setSettingsOpen(false);
            if (editing) finishEditing();
          }}
        >
          <img
            className="app-logo"
            src={isLightTheme(appearance.theme) ? logo.horizontal.lightBg : logo.horizontal.darkBg}
            alt="pewterdesk"
          />
        </button>
        <span className="app-chip">
          <span className="pd-live-dot" data-live={book.status === "live" || undefined} />
          {VENUE_LABEL}
        </span>
        {selected && (
          <span className="app-chip app-chip-market">
            {selected.symbol}
            <span className="pd-muted">{t("header.upTo", { leverage: selected.maxLeverage })}</span>
          </span>
        )}
        <div className="app-stat">
          <span className="app-stat-value">
            {ladder?.mid === undefined ? "—" : formatNumber(ladder.mid, ladder.midDecimals)}
          </span>
          <span className="app-stat-label">{t("header.mid")}</span>
        </div>
        <div className="app-spacer" />
        <HeaderActions
          marketSymbol={selected?.symbol}
          starred={selected !== undefined && watchlist.starred.has(selected.id)}
          onToggleStar={() => selected && watchlist.toggle(selected.id)}
          editing={editing}
          onToggleLayout={() => {
            setSettingsOpen(false);
            editing ? finishEditing() : setEditing(true);
          }}
          soundOn={sound === "on"}
          onSound={(on) => setSound(on ? "on" : "off")}
          settingsOpen={settingsOpen}
          onToggleSettings={() => {
            if (editing) finishEditing();
            setSettingsOpen((open) => !open);
          }}
          theme={appearance.theme}
          onTheme={themeTransition.switchTheme}
          address={address}
          onOpenWallet={() => setWalletOpen(true)}
        />
      </header>

      {settingsOpen ? (
        <SettingsPage
          onClose={() => setSettingsOpen(false)}
          soundOn={sound === "on"}
          onSound={(on) => setSound(on ? "on" : "off")}
          theme={appearance.theme}
          onTheme={themeTransition.switchTheme}
          marketColors={appearance.market}
          onMarketColors={appearance.setMarket}
          address={address}
          onWatch={watch}
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
              renderStatsBar={() => (
                <MarketStatsBar
                  market={selected}
                  venue={VENUE_LABEL}
                  stats={
                    stats.status === "live" || stats.status === "closed" ? stats.data : undefined
                  }
                  markets={marketList}
                  onSelectMarket={(m) => setSelectedId(m.id)}
                />
              )}
            />
            {editing && (
              <PanelPalette
                placed={placed}
                onDragStart={setDragging}
                onDragEnd={() => setDragging(undefined)}
                onAdd={(kind) => setWorkspace((w) => ({ ...w, layout: addPanel(w.layout, kind) }))}
              />
            )}
          </div>
        </>
      )}

      <ConnectWalletDialog
        open={walletOpen}
        onClose={() => setWalletOpen(false)}
        address={address}
        onWatch={watch}
      />

      {/* Covers the app while a theme switch happens underneath. */}
      {themeTransition.overlay}
    </div>
  );
}
