import type {
  AccountSnapshot,
  Announcement,
  Candle,
  CandleInterval,
  ClosedTrade,
  Fill,
  FundingPayment,
  FundingRate,
  Liquidation,
  MarginMode,
  Market,
  MarketHistory,
  MarketStats,
  MarketSummary,
  OpenInterestPoint,
  Order,
  OrderAmend,
  OrderBook,
  OrderRequest,
  PositionProtection,
  Trade,
  TradeSettings,
  VenueError,
  VenueId,
} from "@pewterdesk/core";
import { type HeatCoin, type HeatSector, t } from "@pewterdesk/ui";
import { Channel, invoke, isTauri } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { trackFeed } from "../lib/feedActivity";

/**
 * StreamEvent as serde emits it from venues.rs: adjacently tagged, so
 * `closed` arrives without `data`. Keep in sync with venues.rs.
 */
export type StreamEvent<T> = { event: "update"; data: T } | { event: "closed" };

export interface StreamHandlers<T> {
  onUpdate: (value: T) => void;
  /** The venue ended the stream; nothing more will arrive. */
  onClosed: () => void;
  /** The subscribe command itself failed; `message` is safe to display. */
  onError: (message: string) => void;
}

const venueErrorKinds = new Set(["unsupported", "invalidRequest", "rejected", "network", "key"]);

/** Narrows an invoke rejection to a VenueError, or undefined if it isn't one. */
export function asVenueError(raw: unknown): VenueError | undefined {
  if (typeof raw === "object" && raw !== null && "kind" in raw) {
    const kind = (raw as { kind: unknown }).kind;
    if (typeof kind === "string" && venueErrorKinds.has(kind)) return raw as VenueError;
  }
  return undefined;
}

/**
 * A one-line message for the UI. Venue details are safe to show - venues.rs
 * guarantees they carry no key material - but an unrecognised rejection is
 * never echoed, since we don't know what's in it.
 */
export function describeVenueError(error: VenueError | undefined): string {
  if (!error) return t("error.failed");
  switch (error.kind) {
    case "unsupported":
      return t("error.unsupported", { detail: error.detail });
    case "invalidRequest":
      return t("error.invalidRequest", { detail: error.detail });
    case "rejected":
      return t("error.rejected", { detail: error.detail });
    case "network":
      return t("error.network", { detail: error.detail });
    case "key":
      return error.detail.kind === "notFound"
        ? t("error.noKey")
        : t("error.key", { detail: error.detail.detail });
  }
}

/** Rejects with an Error whose message is safe to display. */
async function call<T>(command: string, args: Record<string, unknown>): Promise<T> {
  if (!isTauri()) throw new Error(t("error.noTauri"));
  try {
    return await invoke<T>(command, args);
  } catch (e) {
    throw new Error(describeVenueError(asVenueError(e)));
  }
}

/**
 * Starts a subscription command and returns a function that ends it. Safe to
 * call the returned function before the command resolves - the subscription
 * is torn down as soon as its id arrives, and no handler fires after it.
 */
function subscribe<T>(
  command: string,
  args: Record<string, unknown>,
  handlers: StreamHandlers<T>,
): () => void {
  let stopped = false;
  let id: number | undefined;
  // For the connection panel and the order book's stale overlay.
  const feed = trackFeed(command, args.venue as VenueId);

  if (!isTauri()) {
    queueMicrotask(() => {
      if (stopped) return;
      feed.failed();
      handlers.onError(t("error.noTauri"));
    });
  } else {
    const channel = new Channel<StreamEvent<T>>();
    channel.onmessage = (message) => {
      if (stopped) return;
      if (message.event === "update") {
        feed.update(message.data);
        handlers.onUpdate(message.data);
      } else {
        feed.closed();
        handlers.onClosed();
      }
    };
    invoke<number>(command, { ...args, onEvent: channel }).then(
      (subscriptionId) => {
        id = subscriptionId;
        if (stopped) void invoke("unsubscribe", { id });
      },
      (e) => {
        if (stopped) return;
        feed.failed();
        handlers.onError(describeVenueError(asVenueError(e)));
      },
    );
  }

  return () => {
    if (stopped) return;
    stopped = true;
    feed.stop();
    if (id !== undefined) void invoke("unsubscribe", { id });
  };
}

export const venueClient = {
  markets: (venue: VenueId) => call<Market[]>("markets", { venue }),

  orderBook: (venue: VenueId, market: string) => call<OrderBook>("order_book", { venue, market }),

  account: (venue: VenueId, address: string) =>
    call<AccountSnapshot>("account", { venue, address }),

  /**
   * Places an order for `account` (an account id from `lib/account.ts`).
   * Rust builds the key reference itself and, for now, takes Bybit demo
   * accounts only. Resolves once the venue has accepted it.
   */
  placeOrder: (venue: VenueId, account: string, request: OrderRequest) =>
    call<Order>("place_order", { venue, account, request }),

  cancelOrder: (venue: VenueId, account: string, market: string, orderId: string) =>
    call<void>("cancel_order", { venue, account, market, orderId }),

  /** Changes an open order's price, size or attached TP/SL. */
  amendOrder: (
    venue: VenueId,
    account: string,
    market: string,
    orderId: string,
    amend: OrderAmend,
  ) => call<void>("amend_order", { venue, account, market, orderId, amend }),

  /** Changes a position's TP, SL and trailing stop; each kept, removed or set. */
  setProtection: (
    venue: VenueId,
    account: string,
    market: string,
    protection: PositionProtection,
  ) => call<void>("set_position_protection", { venue, account, market, protection }),

  /** The venue's latest announcements, newest first. */
  announcements: (venue: VenueId) => call<Announcement[]>("announcements", { venue }),

  /** The account's margin mode and its leverage on `market`. */
  tradeSettings: (venue: VenueId, address: string, market: string) =>
    call<TradeSettings>("trade_settings", { venue, address, market }),

  setLeverage: (venue: VenueId, account: string, market: string, leverage: string) =>
    call<void>("set_leverage", { venue, account, market, leverage }),

  setMarginMode: (venue: VenueId, account: string, market: string, mode: MarginMode) =>
    call<void>("set_margin_mode", { venue, account, market, mode }),

  subscribeOrderBook: (venue: VenueId, market: string, handlers: StreamHandlers<OrderBook>) =>
    subscribe("subscribe_order_book", { venue, market }, handlers),

  subscribeTrades: (venue: VenueId, market: string, handlers: StreamHandlers<Trade[]>) =>
    subscribe("subscribe_trades", { venue, market }, handlers),

  subscribeMarketStats: (venue: VenueId, market: string, handlers: StreamHandlers<MarketStats>) =>
    subscribe("subscribe_market_stats", { venue, market }, handlers),

  /** Up to `count` candles that opened before `before` (ms), oldest first; empty when there are no more. */
  candles: (
    venue: VenueId,
    market: string,
    interval: CandleInterval,
    before: number,
    count: number,
  ) => call<Candle[]>("candles", { venue, market, interval, before, count }),

  subscribeCandles: (
    venue: VenueId,
    market: string,
    interval: CandleInterval,
    handlers: StreamHandlers<Candle[]>,
  ) => subscribe("subscribe_candles", { venue, market, interval }, handlers),

  subscribeMarketSummaries: (venue: VenueId, handlers: StreamHandlers<MarketSummary[]>) =>
    subscribe("subscribe_market_summaries", { venue }, handlers),

  subscribeMarketHistory: (venue: VenueId, handlers: StreamHandlers<MarketHistory>) =>
    subscribe("subscribe_market_history", { venue }, handlers),

  /** Every market's liquidations as they happen, in batches. */
  subscribeLiquidations: (venue: VenueId, handlers: StreamHandlers<Liquidation[]>) =>
    subscribe("subscribe_liquidations", { venue }, handlers),

  /** A market's hourly open interest over the last `hours` hours, oldest first. */
  openInterestHistory: (venue: VenueId, market: string, hours: number) =>
    call<OpenInterestPoint[]>("open_interest_history", { venue, market, hours }),

  fundingHistory: (venue: VenueId, market: string, startTime: number) =>
    call<FundingRate[]>("funding_history", { venue, market, startTime }),

  /** The market's logo as SVG markup, or undefined. Render it only via `TokenIcon`. */
  marketIcon: async (venue: VenueId, market: string) =>
    (await call<string | null>("market_icon", { venue, market })) ?? undefined,

  /** The account's recent fills, newest first. */
  fills: (venue: VenueId, address: string) => call<Fill[]>("fills", { venue, address }),

  closedTrades: (venue: VenueId, address: string) =>
    call<ClosedTrade[]>("closed_trades", { venue, address }),

  /** Funding paid or received since `startTime` (ms), newest first. */
  fundingPayments: (venue: VenueId, address: string, startTime: number) =>
    call<FundingPayment[]>("funding_payments", { venue, address, startTime }),

  /** Recent orders in any state, newest first. */
  orderHistory: (venue: VenueId, address: string) =>
    call<Order[]>("order_history", { venue, address }),

  subscribeAccount: (venue: VenueId, address: string, handlers: StreamHandlers<AccountSnapshot>) =>
    subscribe("subscribe_account", { venue, address }, handlers),
};

/**
 * A connected account as `wallet.rs` reports it: public addresses only, never
 * the key. Keep in sync with `WalletInfo` there.
 */
export interface WalletInfo {
  venue: VenueId;
  address: string;
  /** The stored trade-only key's address. */
  agent: string;
  agentName: string | null;
  /** Ms since the epoch. */
  validUntil: number | null;
}

/**
 * Onboarding. `connect` hands the pasted key to Rust once, which checks it
 * against the venue and stores it in the keychain; nothing returns it.
 */
export const walletClient = {
  connect: (venue: VenueId, address: string, key: string) =>
    call<WalletInfo>("connect_wallet", { venue, address, key }),

  status: (venue: VenueId, address: string) =>
    call<WalletInfo | null>("wallet_status", { venue, address }),

  disconnect: (venue: VenueId, address: string) =>
    call<void>("disconnect_wallet", { venue, address }),

  /**
   * Connecting through a wallet: Rust generates the agent key and returns
   * the approval for the wallet to sign; `finishApproval` hands back the
   * signature, which Rust checks before sending it and storing the key.
   */
  beginApproval: (venue: VenueId, address: string, chainId: number) =>
    call<unknown>("begin_agent_approval", { venue, address, chainId }),

  finishApproval: (signature: string) => call<WalletInfo>("finish_agent_approval", { signature }),

  cancelApproval: () => call<void>("cancel_agent_approval", {}),

  /**
   * Connecting a browser-extension wallet: Rust serves a one-time page on
   * 127.0.0.1 and opens it in the system browser, where the extension signs.
   * `strings` is that page's text, in the user's language.
   */
  startBrowser: (strings: Record<string, string>) =>
    call<void>("start_browser_connect", { strings }),

  reopenBrowser: () => call<void>("reopen_browser_connect", {}),

  cancelBrowser: () => call<void>("cancel_browser_connect", {}),

  /** What the browser page reports: connected (with the account), or closed. */
  onBrowser: (
    handler: (event: { status: "connected"; wallet: WalletInfo } | { status: "ended" }) => void,
  ): (() => void) => {
    if (!isTauri()) return () => {};
    const unlisten = listen<{ status: "connected"; wallet: WalletInfo } | { status: "ended" }>(
      "browser-connect",
      (e) => handler(e.payload),
    );
    return () => {
      void unlisten.then((stop) => stop());
    };
  },
};

/**
 * A connected Bybit API key, as `bybit_key.rs` describes it: the account and
 * what the key may do, never the key. Keep in sync with `BybitKeyInfo` there.
 */
export interface BybitKeyInfo {
  /** The Bybit account: its UID, or `demo:` and the UID for a demo account. */
  uid: string;
  /** A Demo Trading account: demo funds, on Bybit's demo host. */
  demo: boolean;
  /** Whether Bybit answered just now; offline, only `uid` is known. */
  checked: boolean;
  readOnly: boolean;
  subAccount: boolean;
  ipRestricted: boolean;
  /** ISO 8601, when the key lapses. */
  expiresAt: string | null;
  /** As `Group.Permission`, e.g. `ContractTrade.Order`. */
  permissions: string[];
  /** Why a stored key no longer passes the check, if it doesn't. */
  problem: string | null;
}

/**
 * Connecting Bybit with an API key. `connect` hands the key and secret to
 * Rust once; Rust asks Bybit what the key may do and stores it only if it
 * can trade contracts and nothing else. Nothing returns either half.
 */
export const bybitKeyClient = {
  connect: (apiKey: string, apiSecret: string, demo: boolean) =>
    call<BybitKeyInfo>("connect_bybit_key", { apiKey, apiSecret, demo }),

  status: (uid: string) => call<BybitKeyInfo | null>("bybit_key_status", { uid }),

  disconnect: (uid: string) => call<void>("disconnect_bybit_key", { uid }),

  /** The live accounts (UIDs) that may trade. */
  liveAccounts: () => call<string[]>("live_trading_accounts", {}),

  /**
   * Turns live trading on or off for a live account. Turning it on has Rust
   * check the stored key with Bybit again, and refuses if it isn't trade-only.
   */
  setLive: (uid: string, on: boolean) => call<void>("set_live_trading", { uid, on }),
};

/** What a coin link is, for its label and icon. Mirrors `LinkKind` in `coin_info.rs`. */
export type CoinLinkKind =
  | "explorer"
  | "github"
  | "x"
  | "reddit"
  | "telegram"
  | "website"
  | "whitepaper"
  | "forum";

/** A link Rust fetched for a coin: shown by its host, opened by its index. */
export interface CoinLink {
  kind: CoinLinkKind;
  label: string;
  index: number;
}

/**
 * A coin's overview from CoinGecko, as `coin_info.rs` describes it. Amounts
 * in USD; each is null where CoinGecko has none. Keep in sync with
 * `CoinInfo` there.
 */
export interface CoinInfo {
  id: string;
  name: string;
  symbol: string;
  /** Plain text, paragraphs separated by blank lines. */
  description: string;
  tags: string[];
  marketCap: number | null;
  fdv: number | null;
  circulatingSupply: number | null;
  totalSupply: number | null;
  maxSupply: number | null;
  links: CoinLink[];
}

/**
 * Coin overviews, fetched by Rust from CoinGecko. Links open only through
 * Rust, by index into what it fetched; the optional demo key goes to the
 * keychain and never comes back.
 */
/** One liquidation on OKX, from its public history. */
export interface OkxLiquidation {
  /** The swap's base coin, e.g. "BTC". */
  base: string;
  side: "long" | "short";
  price: number;
  /** In base units. */
  size: number;
  time: number;
}

/** OKX's public liquidation history: a data source for the Maps page, not a venue. */
export const okxClient = {
  /** The swaps whose liquidations can be read, e.g. "BTC-USDT". */
  markets: () => call<string[]>("okx_liquidation_markets", {}),
  /** A swap's liquidations since `since` (ms; at most a day back), newest first. */
  liquidations: (market: string, since: number) =>
    call<OkxLiquidation[]>("okx_liquidations", { market, since }),
};

/** A news site's headline. Its link stays in Rust; `newsClient.open` opens it. */
export interface Article {
  /** Names the article to `newsClient.open`. */
  id: string;
  /** The publisher's id, e.g. "coindesk". */
  source: string;
  /** The publisher's name, e.g. "CoinDesk". */
  sourceName: string;
  title: string;
  summary: string;
  /** The publisher's own labels, e.g. "Markets". */
  tags: string[];
  /** Milliseconds since the Unix epoch. */
  time: number;
}

export const newsClient = {
  /** The news sites' latest headlines, newest first. */
  feed: () => call<Article[]>("news_feed", {}),
  /** Opens an article in the browser, by the id `feed` gave it. */
  open: (id: string) => call<void>("open_news_article", { id }),
};

export const coinClient = {
  /** The overview for a market's base coin, or null if CoinGecko doesn't list it. */
  info: (base: string) => call<CoinInfo | null>("coin_info", { base }),

  /**
   * A coin's logo from CoinGecko as SVG markup, by its ticker (a size
   * multiplier in front is dropped), or undefined if CoinGecko has none.
   */
  logo: async (base: string): Promise<string | undefined> =>
    (await call<string | null>("coin_logo", { base })) ?? undefined,

  /** A sector's largest coins by market cap, for the market heatmap. */
  markets: (sector: HeatSector) => call<HeatCoin[]>("coin_markets", { sector }),

  open: (id: string, index: number) => call<void>("open_coin_link", { id, index }),

  setKey: (key: string) => call<void>("set_coingecko_key", { key }),

  hasKey: () => call<boolean>("has_coingecko_key", {}),

  clearKey: () => call<void>("clear_coingecko_key", {}),
};
