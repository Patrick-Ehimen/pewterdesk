import type {
  AccountSnapshot,
  AlgoSpec,
  AlgoView,
  Announcement,
  Candle,
  CandleInterval,
  ClosedTrade,
  Fill,
  FundingPayment,
  FundingRate,
  Liquidation,
  LongShortPoint,
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
  Origin,
  PositionProtection,
  StopMode,
  Trade,
  TradeSettings,
  VenueError,
  VenueId,
} from "@pewterdesk/core";
import {
  type AnalysisKind,
  type HeatCoin,
  type HeatSector,
  type MessageKey,
  t,
} from "@pewterdesk/ui";
import { Channel, invoke, isTauri } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { trackFeed } from "../lib/feedActivity";
import type { RuleCheck, RulesStatus, RulesView, TradingRules } from "../lib/tradingRules";

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

const venueErrorKinds = new Set([
  "unsupported",
  "invalidRequest",
  "rejected",
  "network",
  "key",
  "blocked",
]);

/** The trading rules' reasons for refusing an order, by the code Rust sends. */
const BLOCK_TEXT: Record<string, MessageKey> = {
  lockedDailyLoss: "rules.block.lockedDailyLoss",
  lockedMaxDrawdown: "rules.block.lockedMaxDrawdown",
  hours: "rules.block.hours",
  news: "rules.block.news",
  newsUnchecked: "rules.block.newsUnchecked",
  coolOff: "rules.block.coolOff",
  revenge: "rules.block.revenge",
  tradesPerDay: "rules.block.tradesPerDay",
  positionSize: "rules.block.positionSize",
  leverage: "rules.block.leverage",
  tradeRisk: "rules.block.tradeRisk",
  dailyLeft: "rules.block.dailyLeft",
  needsStop: "rules.block.needsStop",
  unchecked: "rules.block.unchecked",
  lockedAmend: "rules.block.lockedAmend",
  lockedStop: "rules.block.lockedStop",
  // Not a rule: the engine couldn't record the order in its event log, so
  // it didn't send it.
  unrecorded: "rules.block.unrecorded",
  // Not a rule: the daemon (pdd) trades this account; one engine per account.
  "another-engine": "rules.block.anotherEngine",
};

/** What a trading rule's code means, in words. */
export const blockText = (rule: string) => t(BLOCK_TEXT[rule] ?? "rules.block.other");

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
    case "blocked":
      return blockText(error.detail);
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
  /** Every account's trading rules: whether they're on, and any change waiting. */
  tradingRules: () => call<RulesView[]>("trading_rules", {}),

  /**
   * Saves `account`'s rules under `name`. Tightening applies now; a
   * loosening, or turning them off, waits for 00:00 UTC (it comes back as
   * `pending`). Resolves to every account's rules.
   */
  setTradingRules: (
    venue: VenueId,
    account: string,
    name: string,
    on: boolean,
    rules: TradingRules,
  ) => call<RulesView[]>("set_trading_rules", { venue, account, name, on, rules }),

  /** Forgets `account`'s rules at once, on or off. */
  deleteTradingRules: (venue: VenueId, account: string) =>
    call<RulesView[]>("delete_trading_rules", { venue, account }),

  /** Where `account` stands against the rules; null while they aren't its. */
  tradingRulesStatus: (venue: VenueId, account: string) =>
    call<RulesStatus | null>("trading_rules_status", { venue, account }),

  /** What each rule says about an order before it's sent. */
  checkTradingRules: (venue: VenueId, account: string, request: OrderRequest) =>
    call<RuleCheck[]>("check_trading_rules", { venue, account, request }),

  // The trading commands. `origin` says where in the app each came from,
  // for the engine's event log; it grants nothing.
  placeOrder: (venue: VenueId, account: string, request: OrderRequest, origin: Origin = "app") =>
    call<Order>("place_order", { venue, account, request, origin }),

  cancelOrder: (
    venue: VenueId,
    account: string,
    market: string,
    orderId: string,
    origin: Origin = "app",
  ) => call<void>("cancel_order", { venue, account, market, orderId, origin }),

  /** Changes an open order's price, size or attached TP/SL. */
  amendOrder: (
    venue: VenueId,
    account: string,
    market: string,
    orderId: string,
    amend: OrderAmend,
    origin: Origin = "app",
  ) => call<void>("amend_order", { venue, account, market, orderId, amend, origin }),

  /** Changes a position's TP, SL and trailing stop; each kept, removed or set. */
  setProtection: (
    venue: VenueId,
    account: string,
    market: string,
    protection: PositionProtection,
    origin: Origin = "app",
  ) => call<void>("set_position_protection", { venue, account, market, protection, origin }),

  // Algo orders (`algos.rs`): every order an algo sends goes through the
  // engine's router and gate, like the trading commands above.

  /** Starts an algo; refused at once if the account can't trade. */
  startAlgo: (spec: AlgoSpec, origin: Origin = "app") =>
    call<AlgoView>("start_algo", { spec, origin }),

  /** This session's algos, newest first. */
  algos: () => call<AlgoView[]>("algos", {}),

  /** Algos that are over, newest first. */
  algoHistory: (limit = 50) => call<AlgoView[]>("algo_history", { limit }),

  pauseAlgo: (id: string) => call<void>("pause_algo", { id }),

  resumeAlgo: (id: string) => call<void>("resume_algo", { id }),

  /** Stops an algo: cancels what it has open, then at market the rest if asked. */
  stopAlgo: (id: string, mode: StopMode) => call<void>("stop_algo", { id, mode }),

  /** Stops every algo and cancels what they placed; how many it stopped. */
  haltAlgos: () => call<number>("halt_algos", {}),

  /** Every change to an algo, as it happens. Returns a function that stops listening. */
  onAlgo: (handler: (view: AlgoView) => void): (() => void) => {
    if (!isTauri()) return () => {};
    const unlisten = listen<AlgoView>("algo", (e) => handler(e.payload));
    return () => {
      void unlisten.then((stop) => stop());
    };
  },

  /** The venue's latest announcements, newest first. */
  announcements: (venue: VenueId) => call<Announcement[]>("announcements", { venue }),

  /** The account's margin mode and its leverage on `market`. */
  tradeSettings: (venue: VenueId, address: string, market: string) =>
    call<TradeSettings>("trade_settings", { venue, address, market }),

  setLeverage: (
    venue: VenueId,
    account: string,
    market: string,
    leverage: string,
    origin: Origin = "app",
  ) => call<void>("set_leverage", { venue, account, market, leverage, origin }),

  setMarginMode: (
    venue: VenueId,
    account: string,
    market: string,
    mode: MarginMode,
    origin: Origin = "app",
  ) => call<void>("set_margin_mode", { venue, account, market, mode, origin }),

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

  /** `mainnet`: Binance's or BloFin's mainnet figures even while its market data is Demo Trading's. */
  subscribeMarketSummaries: (
    venue: VenueId,
    handlers: StreamHandlers<MarketSummary[]>,
    mainnet = false,
  ) => subscribe("subscribe_market_summaries", { venue, mainnet }, handlers),

  subscribeMarketHistory: (venue: VenueId, handlers: StreamHandlers<MarketHistory>) =>
    subscribe("subscribe_market_history", { venue }, handlers),

  /** Every market's liquidations as they happen, in batches. */
  subscribeLiquidations: (venue: VenueId, handlers: StreamHandlers<Liquidation[]>) =>
    subscribe("subscribe_liquidations", { venue }, handlers),

  /** A market's hourly open interest over the last `hours` hours, oldest first. */
  openInterestHistory: (venue: VenueId, market: string, hours: number) =>
    call<OpenInterestPoint[]>("open_interest_history", { venue, market, hours }),
  /** The share of a market's accounts long and short, hourly, oldest first (Bybit only). */
  longShortRatio: (venue: VenueId, market: string, hours: number) =>
    call<LongShortPoint[]>("long_short_ratio", { venue, market, hours }),

  fundingHistory: (venue: VenueId, market: string, startTime: number) =>
    call<FundingRate[]>("funding_history", { venue, market, startTime }),

  /** The market's logo as SVG markup, or undefined. Render it only via `TokenIcon`. */
  marketIcon: async (venue: VenueId, market: string) =>
    (await call<string | null>("market_icon", { venue, market })) ?? undefined,

  /** The account's recent fills, newest first. */
  fills: (venue: VenueId, address: string) => call<Fill[]>("fills", { venue, address }),

  closedTrades: (venue: VenueId, address: string, since?: number) =>
    call<ClosedTrade[]>("closed_trades", { venue, address, since }),

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
   * Turns live trading on or off for a Hyperliquid or Aster account. Turning
   * it on has Rust check the stored API wallet with the venue again.
   */
  setLive: (venue: VenueId, address: string, on: boolean) =>
    call<void>("set_wallet_trading", { venue, address, on }),

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
  startBrowser: (venue: VenueId, strings: Record<string, string>) =>
    call<void>("start_browser_connect", { venue, strings }),

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

/**
 * A connected Binance API key, as `binance_key.rs` describes it: the account
 * and what the key may do, never the key. Keep in sync with `BinanceKeyInfo`
 * there.
 */
export interface BinanceKeyInfo {
  /** The Binance account: its UID, or `demo:` and the UID for Demo Trading. */
  uid: string;
  /** A Demo Trading account: demo funds, on Binance's demo host. */
  demo: boolean;
  /** Whether Binance answered just now; offline, only `uid` is known. */
  checked: boolean;
  ipRestricted: boolean;
  /** The futures account is in Hedge Mode, whose orders pewterdesk doesn't send. */
  hedgeMode: boolean;
  /** What it has on, by Binance's name (`enableFutures`); empty for a demo key. */
  permissions: string[];
  /** Why a stored key no longer passes the check, if it doesn't. */
  problem: string | null;
}

/**
 * Connecting Binance with an API key, as `bybitKeyClient` does for Bybit:
 * Rust asks Binance what the key may do and stores it only if it can trade
 * futures and nothing else. Nothing returns either half.
 */
export const binanceKeyClient = {
  connect: (apiKey: string, apiSecret: string, demo: boolean) =>
    call<BinanceKeyInfo>("connect_binance_key", { apiKey, apiSecret, demo }),

  status: (uid: string) => call<BinanceKeyInfo | null>("binance_key_status", { uid }),

  disconnect: (uid: string) => call<void>("disconnect_binance_key", { uid }),

  /**
   * Turns live trading on or off for a live account. Turning it on has Rust
   * check the stored key with Binance again, and refuses if it isn't trade-only.
   */
  setLive: (uid: string, on: boolean) => call<void>("set_binance_trading", { uid, on }),

  /**
   * Reads Binance's market data from Demo Trading's exchange, which lists
   * markets and prices of its own, or mainnet's. True if it changed.
   */
  setDemoData: (demo: boolean) => call<boolean>("set_binance_demo_data", { demo }),
};

/**
 * A connected BloFin Demo Trading key, as `blofin_key.rs` describes it: the
 * account, never the key. Keep in sync with `BlofinKeyInfo` there.
 */
export interface BlofinKeyInfo {
  /** The BloFin account: `demo:` and its UID. */
  uid: string;
  /** Always true: only Demo Trading accounts connect. */
  demo: boolean;
  /** Whether BloFin answered just now; offline, only `uid` is known. */
  checked: boolean;
  ipRestricted: boolean;
  /** The account is in Hedge Mode, where pewterdesk places nothing. */
  hedgeMode: boolean;
  /** Why a stored key no longer passes the check, if it doesn't. */
  problem: string | null;
}

/**
 * Connecting a BloFin Demo Trading account with an API key, its secret and
 * passphrase (empty for a key made without one), handed to Rust once. Rust refuses a live key (BloFin can't
 * say whether one may transfer funds) and stores a demo one once BloFin has
 * answered for it. Nothing returns the key, secret or passphrase.
 */
export const blofinKeyClient = {
  connect: (apiKey: string, apiSecret: string, demo: boolean, passphrase: string) =>
    call<BlofinKeyInfo>("connect_blofin_key", { apiKey, apiSecret, passphrase, demo }),

  status: (uid: string) => call<BlofinKeyInfo | null>("blofin_key_status", { uid }),

  disconnect: (uid: string) => call<void>("disconnect_blofin_key", { uid }),

  /**
   * Reads BloFin's market data from Demo Trading's exchange, which lists
   * markets of its own, or mainnet's. True if it changed.
   */
  setDemoData: (demo: boolean) => call<boolean>("set_blofin_demo_data", { demo }),
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

/** How much a calendar event is expected to move its currency. */
export type CalendarImpact = "high" | "medium" | "low" | "holiday";

/** A scheduled economic release or event (the week's calendar). Text only. */
export interface CalendarEvent {
  title: string;
  /** The currency it's about ("USD"), or "All". */
  currency: string;
  /** Milliseconds since the Unix epoch. */
  time: number;
  impact: CalendarImpact;
  forecast: string | null;
  previous: string | null;
}

/** A news aggregator the wire reads. */
export type WireSource = "tree" | "phoenix";

/** One headline or post from the news wire. Text only; its link stays in Rust. */
export interface WireItem {
  /** Names its link to `wireClient.open`. */
  id: string;
  source: WireSource;
  kind: "tweet" | "news";
  /** The account's display name, or the outlet ("DECRYPT"). */
  author: string;
  /** The X handle, without "@". */
  handle: string | null;
  text: string;
  /** Tickers the aggregator found in it. */
  coins: string[];
  /** Milliseconds since the Unix epoch. */
  time: number;
  flag: "retweet" | "quote" | "reply" | null;
  important: boolean;
  /** Where its link goes ("x.com"), if it has one. */
  linkHost: string | null;
}

/** A source's connection, as serde sends it. */
type RawFeedState = "connecting" | "needsKey" | "down" | { live: { delayed: boolean } };

export type FeedState =
  | { state: "connecting" | "needsKey" | "down" }
  | { state: "live"; delayed: boolean };

export type WireEvent =
  | { type: "items"; items: WireItem[] }
  | { type: "status"; source: WireSource; state: FeedState };

type RawWireEvent =
  | { type: "items"; items: WireItem[] }
  | { type: "status"; source: WireSource; state: RawFeedState };

const feedState = (raw: RawFeedState): FeedState =>
  typeof raw === "string" ? { state: raw } : { state: "live", delayed: raw.live.delayed };

export const wireClient = {
  /** Tree's recent items, then everything live from both sources, with their states. */
  subscribe: (handlers: StreamHandlers<WireEvent>) =>
    subscribe<RawWireEvent>(
      "subscribe_news_wire",
      {},
      {
        ...handlers,
        onUpdate: (e) =>
          handlers.onUpdate(e.type === "status" ? { ...e, state: feedState(e.state) } : e),
      },
    ),
  /** Which sources have an API key stored (never the key). */
  keys: () => call<Record<WireSource, boolean>>("news_keys", {}),
  setKey: (source: WireSource, key: string) => call<void>("set_news_key", { source, key }),
  clearKey: (source: WireSource) => call<void>("clear_news_key", { source }),
  /** Opens an item's link in the browser, by its id. */
  open: (id: string) => call<void>("open_wire_link", { id }),
};

export const calendarClient = {
  /** This week's economic calendar, soonest first. */
  events: () => call<CalendarEvent[]>("economic_calendar", {}),
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

/** One market's line in the snapshot sent with a question to the AI analyst. */
export interface AiSnapshotRow {
  symbol: string;
  price: number;
  /** Over 24 hours, in percent. */
  change: number | null;
  /** The current funding rate, as a fraction. */
  funding: number | null;
  volume: number | null;
  openInterest: number | null;
}

/** What's on screen when the trader asks. */
export interface AiContext {
  venue: VenueId;
  market: string | null;
  interval: CandleInterval | null;
  snapshot: AiSnapshotRow[];
  /** The connected account on each venue, read only with account access on. */
  accounts: {
    venue: VenueId;
    account: string;
  }[] /** Deep Think: the model reasons harder on this question. */;
  deep: boolean;
}

export type AiBias = "bullish" | "bearish" | "neutral";

/** The analyst's analysis, to draw on a chart. */
export interface AiChartMarks {
  venue: VenueId;
  market: string;
  interval: CandleInterval;
  bias: AiBias;
  summary: string;
  levels: { price: number; kind: AnalysisKind; label: string }[];
  /** Supply and demand zones (times in ms; `end` null runs to now). Absent in older chats. */
  zones?: {
    kind: "supply" | "demand";
    start: number;
    end: number | null;
    top: number;
    bottom: number;
    label: string;
  }[];
  /** Fibonacci retracements, each over a swing. */
  fibs?: AiSpan[];
  trendLines?: AiSpan[];
  /** What beyond the chart drives the view, with where it came from. Absent in older chats. */
  catalysts?: { source: AiCatalystSource; text: string }[];
}

export type AiCatalystSource = "x" | "news" | "calendar" | "data" | "web";

/** Two points on the chart (times in ms) and a label. */
export interface AiSpan {
  from: { time: number; price: number };
  to: { time: number; price: number };
  label: string;
}

export interface AiReply {
  /** The whole conversation, opaque here: handed back with the next question. */
  transcript: unknown;
  text: string;
  marks: AiChartMarks | null;
  /** The tools the analyst used, in order. */
  tools: string[];
  end: "done" | "refused" | "cutShort";
}

/** Who answers: Anthropic's Claude, Google's Gemini, or OpenAI's ChatGPT models. */
export type AiProvider = "claude" | "gemini" | "openai";

/** A model the trader can pick. */
export interface AiModel {
  provider: AiProvider;
  id: string;
  label: string;
  /** The provider's model when none is picked. */
  default: boolean;
  /** On the provider's free tier (Gemini's only; the others have none). */
  free: boolean;
}

/** Why the analyst couldn't answer, as Rust sorted it (`ai_providers::failure`). */
export interface AiFailure {
  kind: "key" | "rate" | "quota" | "unavailable" | "paidModel" | "noKey" | "other";
  provider: AiProvider;
  /** How long the provider asked to wait, where it said. */
  waitSecs: number | null;
  /** The provider's own words, bounded; text only. */
  detail: string | null;
}

const AI_FAILURE_KINDS = new Set<string>([
  "key",
  "rate",
  "quota",
  "unavailable",
  "paidModel",
  "noKey",
  "other",
]);

/** An analyst failure: its message for anywhere that shows one, and what Rust sorted it as. */
export class AiError extends Error {
  constructor(
    message: string,
    readonly failure: AiFailure,
  ) {
    super(message);
  }
}

/** The `ai:` failure in a rejection, if it is one. */
function aiFailureOf(error: VenueError | undefined): AiFailure | undefined {
  if (error?.kind !== "invalidRequest" || !error.detail.startsWith("ai:")) return undefined;
  try {
    const f = JSON.parse(error.detail.slice(3)) as Partial<AiFailure>;
    if (typeof f.kind !== "string" || !AI_FAILURE_KINDS.has(f.kind)) return undefined;
    if (f.provider !== "claude" && f.provider !== "gemini" && f.provider !== "openai") {
      return undefined;
    }
    return {
      kind: f.kind,
      provider: f.provider,
      waitSecs: typeof f.waitSecs === "number" ? f.waitSecs : null,
      detail: typeof f.detail === "string" ? f.detail : null,
    };
  } catch {
    return undefined;
  }
}

/** `call` for the analyst: an `ai:` failure rejects as an `AiError`. */
async function callAi<T>(command: string, args: Record<string, unknown>): Promise<T> {
  if (!isTauri()) throw new Error(t("error.noTauri"));
  try {
    return await invoke<T>(command, args);
  } catch (e) {
    const error = asVenueError(e);
    const failure = aiFailureOf(error);
    if (failure) throw new AiError(failure.detail ?? failure.kind, failure);
    throw new Error(describeVenueError(error));
  }
}

export const aiClient = {
  /**
   * Asks the analyst with `provider`'s `model`, in the conversation
   * `transcript` (null for a new one; a chat stays with its provider).
   */
  ask: (
    provider: AiProvider,
    model: string,
    transcript: unknown,
    question: string,
    context: AiContext,
  ) =>
    callAi<AiReply>("ai_ask", {
      provider,
      model,
      transcript: transcript ?? null,
      question,
      context,
    }),
  /** The models the trader can pick, by provider. */
  models: () => call<AiModel[]>("ai_models", {}),
  /** Which providers have a key stored (never the key). */
  keys: () => call<Record<AiProvider, boolean>>("ai_key_status", {}),
  setKey: (provider: AiProvider, key: string) => call<void>("set_ai_key", { provider, key }),
  clearKey: (provider: AiProvider) => call<void>("clear_ai_key", { provider }),
  /** Whether the analyst may read the trader's account (off by default; kept in Rust). */
  accountAccess: () => call<boolean>("ai_account_access", {}),
  setAccountAccess: (on: boolean) => call<void>("set_ai_account_access", { on }),
  /** Whether the Gemini key is on Google's paid plan (free by default; kept in Rust). */
  geminiPaid: () => call<boolean>("ai_gemini_paid", {}),
  setGeminiPaid: (paid: boolean) => call<void>("set_ai_gemini_paid", { paid }),
  /** The chats file as last saved, or null before the first save. */
  loadChats: () => call<string | null>("load_ai_chats", {}),
  /** Replaces the chats file with `store`. */
  saveChats: (store: unknown) => call<void>("save_ai_chats", { store }),
};
