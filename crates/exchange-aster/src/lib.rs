//! Aster adapter (Aster Chain, an order-book perp L1; deposits bridge in from
//! BNB Chain, Ethereum, Arbitrum and Solana): public market data over the
//! Futures REST API and combined-stream WebSocket, none of which needs a
//! key, and an account's state and orders, which do.
//!
//! Aster is Binance-style: market ids are its symbols (`BTCUSDT`), and each
//! stream is seeded over REST before going live, which also turns an unknown
//! market into an error (the streams ignore one silently).
//!
//! Account data is read with requests signed by the account's API wallet
//! (agent), taken from the app's `KeySource` for the one call that signs:
//! Aster serves even balances only to a signed request. That API wallet is
//! the trade-only key because pewterdesk approves it without withdraw or
//! spot permission, and reads its permissions back before keeping it - see
//! `agent.rs` and docs/adr/0002-launch-venues.md.
//!
//! Orders are placed and cancelled the same way: `orders.rs` builds the
//! request's parameters, `agent.rs` signs exactly those, and they're sent as
//! signed. Both are security-sensitive. Nothing here can withdraw or
//! transfer: the adapter has no such request, and the API wallet no such
//! permission.

mod account;
pub mod agent;
pub mod constants;
mod history;
mod icons;
mod orders;
mod tape;
mod wire;
mod ws;

use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use async_trait::async_trait;
use pewterdesk_core::{
    AccountSnapshot, Candle, CandleInterval, Capabilities, ClosedTrade, Decimal, ExchangeAdapter,
    ExitChange, Fill, FundingPayment, FundingRate, KeySource, MarginMode, Market, MarketHistory,
    MarketStats, MarketSummary, Order, OrderAmend, OrderBook, OrderCategory, OrderKind,
    OrderRequest, OrderStatus, OrderType, PositionProtection, PriceSource, Side, Trade,
    TradeSettings, TradingAccount, VenueError, VenueId,
};
use serde::de::DeserializeOwned;
use serde_json::Value;
use tokio::sync::{mpsc, Semaphore};

use constants::Endpoints;
use tape::Tape;
use wire::{Mark, Ticker};
use ws::Handled;

const REQUEST_TIMEOUT: Duration = Duration::from_secs(10);
/// Levels per side, over REST and the partial-book stream.
const BOOK_DEPTH: u32 = 20;
/// Trades the tape starts with.
const TRADE_HISTORY: u32 = 100;
/// Candles of history sent before live updates.
const CANDLE_HISTORY: u32 = 500;
/// The most candles Aster returns per request.
const MAX_CANDLE_PAGE: u32 = 1500;
/// Summaries go out at most this often; the streams feeding them push every
/// second, far more than a screener needs.
const SUMMARY_EVERY: Duration = Duration::from_secs(5);
/// Open interest has no all-markets endpoint or stream, so the summaries
/// fetch it one market at a time, busiest first: quickly on the first pass
/// (about a minute for 600 markets), then slower to keep it fresh.
const OI_PACE_FIRST: Duration = Duration::from_millis(100);
const OI_PACE: Duration = Duration::from_millis(500);
/// A single market's stats refresh its open interest this often.
const STATS_OI_POLL: Duration = Duration::from_secs(30);
/// Hourly candles fetched per market for screening: 7 days.
const HISTORY_HOURS: u32 = 7 * 24;
/// One market's history per this long; with the summaries' open interest
/// this stays well inside Aster's 2,400-weight-a-minute budget.
const HISTORY_PACE: Duration = Duration::from_secs(1);
/// Aster returns at most this many funding payments per request.
const FUNDING_PAGE: usize = 1000;
/// Pages fetched per `funding_history` call at most.
const FUNDING_MAX_PAGES: usize = 10;
/// Logo downloads in flight at once; the screener asks for every market's.
const ICON_FETCHES: usize = 6;
/// The web API's list of every asset's logo.
const LOGO_LIST_PATH: &str = "/bapi/futures/v1/public/future/asset/ae/all-asset-logo";

/// A snapshot of the account is read this often while it's on screen.
const ACCOUNT_EVERY: Duration = Duration::from_secs(5);
/// Aster serves an account's trades a week at a time at most.
const WEEK_MS: u64 = 7 * 24 * 3_600_000;
/// How far back a closed-trade history reaches at most: 30 days, a week at
/// a time, so one call makes a bounded number of requests.
const HISTORY_WEEKS: u64 = 5;
/// Markets read for fills at once at most, the most recently traded first.
const TRADED_MARKETS: usize = 20;
/// Rows Aster returns per history request at most.
const HISTORY_PAGE: &str = "1000";

/// A nonce for a signed request: the time in microseconds, as Aster wants,
/// and never one already handed out (two requests can share a microsecond).
fn next_nonce() -> u64 {
    use std::sync::atomic::{AtomicU64, Ordering};
    static LAST: AtomicU64 = AtomicU64::new(0);
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| d.as_micros() as u64);
    let mut last = LAST.load(Ordering::Relaxed);
    loop {
        let next = now.max(last + 1);
        match LAST.compare_exchange_weak(last, next, Ordering::Relaxed, Ordering::Relaxed) {
            Ok(_) => return next,
            Err(seen) => last = seen,
        }
    }
}

/// What a refusal says when the margin type asked for is already set.
const SAME_MARGIN_TYPE: &str = "the margin mode is already that";

/// Aster's own words for a refusal, except the ones worth saying plainly.
fn refusal(body: &str) -> VenueError {
    match serde_json::from_str::<wire::ApiError>(body) {
        // Signed endpoints open once the main wallet has deposited.
        Ok(e) if e.code == -5050 => VenueError::InvalidRequest(
            "this account hasn't deposited on Aster yet; deposit first, then its balances and positions show".into(),
        ),
        // Asked for the margin type the market already has: nothing to do.
        Ok(e) if e.code == -4046 => VenueError::InvalidRequest(SAME_MARGIN_TYPE.into()),
        Ok(e) if e.msg == "No agent found" => VenueError::InvalidRequest(
            "this API wallet is no longer approved on Aster; connect the wallet again".into(),
        ),
        Ok(e) => VenueError::InvalidRequest(e.msg),
        Err(_) => VenueError::InvalidRequest(body.chars().take(200).collect()),
    }
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| d.as_millis() as u64)
}

/// The REST API. Cheap to clone, so background tasks carry their own.
#[derive(Clone)]
struct Rest {
    http: reqwest::Client,
    base: &'static str,
}

impl Rest {
    async fn get<T: DeserializeOwned>(
        &self,
        path: &str,
        query: &[(&str, String)],
    ) -> Result<T, VenueError> {
        let response = self
            .http
            .get(format!("{}{path}", self.base))
            .query(query)
            .send()
            .await
            .map_err(|e| VenueError::Network(e.without_url().to_string()))?;

        let status = response.status();
        // 429 is a rate limit; 418 is Aster's ban for ignoring one.
        if matches!(status.as_u16(), 418 | 429) {
            return Err(VenueError::Network(format!("rate limited ({status})")));
        }
        if status.is_client_error() {
            return Err(refusal(&response.text().await.unwrap_or_default()));
        }
        if !status.is_success() {
            return Err(VenueError::Network(format!("Aster API returned {status}")));
        }
        response
            .json()
            .await
            .map_err(|e| VenueError::Network(format!("unexpected Aster response: {e}")))
    }

    /// A GET signed by the account's API wallet. `key` is held only to make
    /// the signature; `path` and `params` are this adapter's own.
    async fn signed_get<T: DeserializeOwned>(
        &self,
        path: &str,
        params: &[(&str, String)],
        key: &str,
    ) -> Result<T, VenueError> {
        self.signed(reqwest::Method::GET, path, params, key).await
    }

    /// A request signed by the account's API wallet: the parameters go in
    /// the URL exactly as they were signed (Aster's docs, "send by url"),
    /// with no body. If signing fails nothing is sent.
    async fn signed<T: DeserializeOwned>(
        &self,
        method: reqwest::Method,
        path: &str,
        params: &[(&str, String)],
        key: &str,
    ) -> Result<T, VenueError> {
        let query = agent::sign_request(key, params, next_nonce())?;
        let response = self
            .http
            .request(method, format!("{}{path}?{query}", self.base))
            .send()
            .await
            .map_err(|e| VenueError::Network(e.without_url().to_string()))?;
        let status = response.status();
        if matches!(status.as_u16(), 418 | 429) {
            return Err(VenueError::Network(format!("rate limited ({status})")));
        }
        if status.is_client_error() {
            return Err(refusal(&response.text().await.unwrap_or_default()));
        }
        if !status.is_success() {
            return Err(VenueError::Network(format!("Aster API returned {status}")));
        }
        response
            .json()
            .await
            .map_err(|e| VenueError::Network(format!("unexpected Aster response: {e}")))
    }

    /// `market`'s best bid and ask now. Public.
    async fn quote(&self, market: &str) -> Result<orders::Quote, VenueError> {
        self.get("/fapi/v3/ticker/bookTicker", &symbol_query(Some(market)))
            .await
    }

    /// The account's margin summary, positions and open orders, signed with
    /// the key at `keys`'s entry for `address`.
    async fn account(
        &self,
        keys: &dyn KeySource,
        address: &str,
    ) -> Result<AccountSnapshot, VenueError> {
        let key = keys.key(&agent::key_account(address)?).await?;
        let summary: account::WireAccount = self.signed_get("/fapi/v3/account", &[], &key).await?;
        let positions: Vec<account::WirePosition> =
            self.signed_get("/fapi/v3/positionRisk", &[], &key).await?;
        let orders: Vec<account::WireOrder> =
            self.signed_get("/fapi/v3/openOrders", &[], &key).await?;
        Ok(account::snapshot(
            address,
            summary,
            positions,
            orders,
            now_ms(),
        ))
    }

    /// The markets the account traded between `from` and `to`, from its fee
    /// records, most recently traded first.
    async fn traded_markets(
        &self,
        key: &str,
        from: u64,
        to: u64,
    ) -> Result<Vec<String>, VenueError> {
        let incomes: Vec<history::WireIncome> = self
            .signed_get(
                "/fapi/v3/income",
                &[
                    ("incomeType", "COMMISSION".to_owned()),
                    ("startTime", from.to_string()),
                    ("endTime", to.to_string()),
                    ("limit", HISTORY_PAGE.to_owned()),
                ],
                key,
            )
            .await?;
        Ok(history::traded_markets(&incomes, TRADED_MARKETS))
    }

    /// The account's trades on `markets` between `from` and `to`, a week at
    /// a time (Aster's widest window), up to a page per market and week.
    async fn trades(
        &self,
        key: &str,
        markets: &[String],
        from: u64,
        to: u64,
    ) -> Result<Vec<history::WireTrade>, VenueError> {
        let mut trades = Vec::new();
        let mut start = from;
        while start < to {
            let end = (start + WEEK_MS - 1).min(to);
            for market in markets {
                let page: Vec<history::WireTrade> = self
                    .signed_get(
                        "/fapi/v3/userTrades",
                        &[
                            ("symbol", market.clone()),
                            ("startTime", start.to_string()),
                            ("endTime", end.to_string()),
                            ("limit", HISTORY_PAGE.to_owned()),
                        ],
                        key,
                    )
                    .await?;
                trades.extend(page);
            }
            start = end + 1;
        }
        Ok(trades)
    }

    async fn exchange_info(&self) -> Result<wire::ExchangeInfo, VenueError> {
        self.get("/fapi/v1/exchangeInfo", &[]).await
    }

    /// Every market's 24h ticker, or one market's.
    async fn tickers(&self, market: Option<&str>) -> Result<Vec<Ticker>, VenueError> {
        let query = symbol_query(market);
        let value: Value = self.get("/fapi/v1/ticker/24hr", &query).await?;
        Ticker::from_rest(value).map_err(parse_error)
    }

    /// Every market's mark and funding, or one market's.
    async fn marks(&self, market: Option<&str>) -> Result<Vec<Mark>, VenueError> {
        let query = symbol_query(market);
        let value: Value = self.get("/fapi/v1/premiumIndex", &query).await?;
        Mark::from_rest(value).map_err(parse_error)
    }

    async fn funding_intervals(&self) -> Result<HashMap<String, u32>, VenueError> {
        let info: Vec<wire::FundingInfo> = self.get("/fapi/v1/fundingInfo", &[]).await?;
        Ok(wire::funding_intervals(info))
    }

    async fn open_interest(&self, market: &str) -> Result<Decimal, VenueError> {
        let oi: wire::OpenInterest = self
            .get("/fapi/v1/openInterest", &[("symbol", market.to_owned())])
            .await?;
        Ok(oi.open_interest)
    }

    async fn klines(
        &self,
        market: &str,
        interval: CandleInterval,
        limit: u32,
        end_time: Option<u64>,
    ) -> Result<Vec<Candle>, VenueError> {
        let mut query = vec![
            ("symbol", market.to_owned()),
            ("interval", wire::interval_code(interval).to_owned()),
            ("limit", limit.to_string()),
        ];
        if let Some(end) = end_time {
            query.push(("endTime", end.to_string()));
        }
        let klines: Vec<wire::Kline> = self.get("/fapi/v1/klines", &query).await?;
        Ok(klines.into_iter().map(|k| k.0).collect())
    }

    /// The live markets, busiest (by 24h quote volume) first.
    async fn markets_by_volume(&self) -> Result<Vec<String>, VenueError> {
        let (info, tickers) = tokio::try_join!(self.exchange_info(), self.tickers(None))?;
        Ok(by_volume(&live_markets(&info), &tickers))
    }
}

fn symbol_query(market: Option<&str>) -> Vec<(&'static str, String)> {
    market
        .map(|m| vec![("symbol", m.to_owned())])
        .unwrap_or_default()
}

fn parse_error(e: serde_json::Error) -> VenueError {
    VenueError::Network(format!("unexpected Aster response: {e}"))
}

fn live_markets(info: &wire::ExchangeInfo) -> HashSet<String> {
    info.symbols
        .iter()
        .filter(|s| s.is_live())
        .map(|s| s.symbol.clone())
        .collect()
}

/// `live` markets ordered by their tickers' volume, highest first.
fn by_volume(live: &HashSet<String>, tickers: &[Ticker]) -> Vec<String> {
    let mut ranked: Vec<&Ticker> = tickers
        .iter()
        .filter(|t| live.contains(&t.symbol))
        .collect();
    ranked.sort_by_key(|t| std::cmp::Reverse(t.quote_volume));
    ranked.into_iter().map(|t| t.symbol.clone()).collect()
}

/// Sends `first`, then everything from `live`, so a consumer sees the REST
/// seed before any stream update.
fn with_first<T: Send + 'static>(first: T, mut live: mpsc::Receiver<T>) -> mpsc::Receiver<T> {
    let (tx, rx) = mpsc::channel(16);
    tokio::spawn(async move {
        if tx.send(first).await.is_err() {
            return;
        }
        loop {
            tokio::select! {
                _ = tx.closed() => return,
                next = live.recv() => match next {
                    Some(item) => {
                        if tx.send(item).await.is_err() {
                            return;
                        }
                    }
                    None => return,
                },
            }
        }
    });
    rx
}

pub struct AsterAdapter {
    rest: Rest,
    endpoints: &'static Endpoints,
    /// Base assets and price decimals, from `exchangeInfo`: fetched on first
    /// use and refreshed whenever `markets` runs.
    meta: tokio::sync::Mutex<Option<Arc<wire::Meta>>>,
    /// For logos only (the web API's list and the image host). Never follows
    /// a redirect, so it can't be sent anywhere else.
    assets: reqwest::Client,
    /// Logo URL by base asset, fetched once.
    logo_urls: tokio::sync::Mutex<Option<Arc<HashMap<String, String>>>>,
    /// Logos by market id, `None` for markets without one. Kept for the
    /// session; failed downloads aren't cached, so they're retried.
    icons: Mutex<HashMap<String, Option<String>>>,
    icon_fetches: Semaphore,
    /// Where account reads take the API wallet's key from; unset, account
    /// data is `Unsupported`.
    keys: Option<Arc<dyn KeySource>>,
}

impl AsterAdapter {
    /// Talks only to `endpoints`, which are fixed in [`constants`] - never a
    /// URL supplied by a caller.
    pub fn new(endpoints: &'static Endpoints) -> Result<Self, VenueError> {
        let http = reqwest::Client::builder()
            .timeout(REQUEST_TIMEOUT)
            .build()
            .map_err(|e| VenueError::Network(e.to_string()))?;
        let assets = reqwest::Client::builder()
            .timeout(REQUEST_TIMEOUT)
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .map_err(|e| VenueError::Network(e.to_string()))?;
        Ok(Self {
            rest: Rest {
                http,
                base: endpoints.rest,
            },
            endpoints,
            meta: tokio::sync::Mutex::new(None),
            assets,
            logo_urls: tokio::sync::Mutex::new(None),
            icons: Mutex::new(HashMap::new()),
            icon_fetches: Semaphore::new(ICON_FETCHES),
            keys: None,
        })
    }

    /// Adds the app's `KeySource`, which account reads take the stored API
    /// wallet's key from. Without one, account data is `Unsupported`.
    pub fn with_keys(mut self, keys: Arc<dyn KeySource>) -> Self {
        self.keys = Some(keys);
        self
    }

    /// Posts an agent approval the main wallet signed. The caller has
    /// checked the signature is that wallet's (`agent::WalletSignature`).
    pub async fn approve_agent(
        &self,
        approval: &agent::ApproveAgent,
        signature: &agent::WalletSignature,
    ) -> Result<(), VenueError> {
        let response = self
            .rest
            .http
            .post(format!(
                "{}/fapi/v3/registerAndApproveAgent",
                self.rest.base
            ))
            .form(&approval.form(signature))
            .send()
            .await
            .map_err(|e| VenueError::Network(e.without_url().to_string()))?;
        let status = response.status();
        let body = response.text().await.unwrap_or_default();
        if status.is_client_error() {
            return Err(match refusal(&body) {
                VenueError::InvalidRequest(why) => VenueError::Rejected(why),
                other => other,
            });
        }
        if !status.is_success() {
            return Err(VenueError::Network(format!("Aster API returned {status}")));
        }
        // 200 with `{"code": 200, "msg": "success"}`; anything else is Aster's refusal.
        match serde_json::from_str::<wire::ApiError>(&body) {
            Ok(reply) if reply.code == 200 => Ok(()),
            Ok(reply) => Err(VenueError::Rejected(reply.msg)),
            Err(_) => Err(VenueError::Network("unexpected Aster response".into())),
        }
    }

    /// The agents approved for the account `key`'s API wallet acts for, as
    /// Aster lists them, permissions included. Signed with `key`; works
    /// before the account has deposited.
    pub async fn approved_agents(
        &self,
        key: &str,
    ) -> Result<Vec<agent::ApprovedAgent>, VenueError> {
        self.rest.signed_get("/fapi/v3/agent", &[], key).await
    }

    /// `market`'s grid as the venue has it now.
    async fn steps(&self, market: &str) -> Result<orders::Steps, VenueError> {
        let info = self.rest.exchange_info().await?;
        let (tick, step, min_size) = wire::steps(&info, market).ok_or_else(|| {
            VenueError::InvalidRequest(format!("{market:?} isn't a live Aster market"))
        })?;
        Ok(orders::Steps {
            tick,
            step,
            min_size,
        })
    }

    /// The API wallet's key for `address`, which Aster wants on every
    /// account read; held only for the reads of one call.
    async fn read_key(&self, address: &str) -> Result<zeroize::Zeroizing<String>, VenueError> {
        let keys = self
            .keys
            .as_ref()
            .ok_or(VenueError::Unsupported(NO_ACCOUNT_DATA))?;
        Ok(keys.key(&agent::key_account(address)?).await?)
    }

    async fn meta(&self) -> Result<Arc<wire::Meta>, VenueError> {
        let mut meta = self.meta.lock().await;
        if let Some(meta) = meta.as_ref() {
            return Ok(Arc::clone(meta));
        }
        let fresh = Arc::new(wire::meta(&self.rest.exchange_info().await?));
        *meta = Some(Arc::clone(&fresh));
        Ok(fresh)
    }

    /// Logo URL by base asset, keeping only those on the logo host.
    async fn logo_urls(&self) -> Result<Arc<HashMap<String, String>>, VenueError> {
        let mut urls = self.logo_urls.lock().await;
        if let Some(urls) = urls.as_ref() {
            return Ok(Arc::clone(urls));
        }
        let response = self
            .assets
            .post(format!("{}{LOGO_LIST_PATH}", self.endpoints.web))
            .json(&serde_json::json!({}))
            .send()
            .await
            .map_err(|e| VenueError::Network(e.without_url().to_string()))?;
        if !response.status().is_success() {
            return Err(VenueError::Network(format!(
                "logo list returned {}",
                response.status()
            )));
        }
        let list: wire::LogoList = response
            .json()
            .await
            .map_err(|e| VenueError::Network(format!("unexpected logo list: {e}")))?;
        let fresh = Arc::new(wire::logo_urls(list, self.endpoints.logos));
        *urls = Some(Arc::clone(&fresh));
        Ok(fresh)
    }

    async fn fetch_icon(&self, url: &str) -> Result<Option<String>, VenueError> {
        let _permit = self
            .icon_fetches
            .acquire()
            .await
            .map_err(|_| VenueError::Network("icon fetches closed".into()))?;
        let response = self
            .assets
            .get(url)
            .send()
            .await
            .map_err(|e| VenueError::Network(e.without_url().to_string()))?;
        let status = response.status();
        if status.is_server_error() || status.as_u16() == 429 {
            return Err(VenueError::Network(format!(
                "logo request returned {status}"
            )));
        }
        if !status.is_success()
            || response
                .content_length()
                .is_some_and(|n| n > icons::MAX_ICON_BYTES as u64)
        {
            return Ok(None);
        }
        let body = response
            .bytes()
            .await
            .map_err(|e| VenueError::Network(e.without_url().to_string()))?;
        Ok(icons::as_svg(&body))
    }
}

const NO_ACCOUNT_DATA: &str = "Aster account data (no key store is set up)";

#[async_trait]
impl ExchangeAdapter for AsterAdapter {
    fn venue(&self) -> VenueId {
        VenueId::Aster
    }

    fn capabilities(&self) -> Capabilities {
        Capabilities {
            order_book: true,
            order_types: vec![OrderType::Market, OrderType::Limit, OrderType::Trigger],
            isolated_collateral: false,
        }
    }

    async fn markets(&self) -> Result<Vec<Market>, VenueError> {
        let info = self.rest.exchange_info().await?;
        *self.meta.lock().await = Some(Arc::new(wire::meta(&info)));
        Ok(wire::markets(info))
    }

    async fn order_book(&self, market: &str) -> Result<OrderBook, VenueError> {
        wire::validate_market(market)?;
        let depth: wire::Depth = self
            .rest
            .get(
                "/fapi/v1/depth",
                &[
                    ("symbol", market.to_owned()),
                    ("limit", BOOK_DEPTH.to_string()),
                ],
            )
            .await?;
        Ok(wire::order_book(market, depth))
    }

    /// The REST book, then the partial-book stream: the top levels, whole,
    /// every 250ms.
    async fn subscribe_order_book(
        &self,
        market: &str,
    ) -> Result<mpsc::Receiver<OrderBook>, VenueError> {
        let first = self.order_book(market).await?;
        let id = market.to_owned();
        let live = ws::subscribe(
            self.endpoints.ws,
            vec![format!("{}@depth{BOOK_DEPTH}", wire::stream_name(market))],
            move |push| match serde_json::from_value::<wire::Depth>(push.data) {
                Ok(depth) => Handled::Emit(wire::order_book(&id, depth)),
                Err(_) => Handled::Ignore,
            },
        )
        .await?;
        Ok(with_first(first, live))
    }

    /// Recent trades over REST start the tape; the `@trade` stream adds each
    /// print after that. Liquidation and ADL prints aren't on the book, so
    /// they're left off the tape.
    async fn subscribe_trades(
        &self,
        market: &str,
    ) -> Result<mpsc::Receiver<Vec<Trade>>, VenueError> {
        wire::validate_market(market)?;
        let recent: Vec<wire::RestTrade> = self
            .rest
            .get(
                "/fapi/v1/trades",
                &[
                    ("symbol", market.to_owned()),
                    ("limit", TRADE_HISTORY.to_string()),
                ],
            )
            .await?;
        let mut tape = Tape::default();
        tape.record(
            recent
                .into_iter()
                .map(|t| wire::trade(market, t.id, t.price, t.qty, t.time, t.is_buyer_maker))
                .collect(),
        );
        let first = tape.snapshot();

        let id = market.to_owned();
        let live = ws::subscribe(
            self.endpoints.ws,
            vec![format!("{}@trade", wire::stream_name(market))],
            move |push| {
                let Ok(t) = serde_json::from_value::<wire::WsTrade>(push.data) else {
                    return Handled::Ignore;
                };
                if !t.on_book() {
                    return Handled::Ignore;
                }
                let trade = wire::trade(&id, t.id, t.price, t.qty, t.time, t.is_buyer_maker);
                if tape.record(vec![trade]) {
                    Handled::Emit(tape.snapshot())
                } else {
                    Handled::Ignore
                }
            },
        )
        .await?;
        Ok(with_first(first, live))
    }

    /// Seeded over REST, then three streams on one connection: the 24h
    /// ticker and the mark (each emits), and the best bid and ask (kept for
    /// the mid). Open interest has no stream, so it's refetched every
    /// `STATS_OI_POLL`.
    async fn subscribe_market_stats(
        &self,
        market: &str,
    ) -> Result<mpsc::Receiver<MarketStats>, VenueError> {
        wire::validate_market(market)?;
        let rest = &self.rest;
        let book_query = [("symbol", market.to_owned())];
        let book = rest.get::<wire::RestBookTicker>("/fapi/v1/ticker/bookTicker", &book_query);
        let (tickers, marks, oi, intervals, book, meta) = tokio::try_join!(
            rest.tickers(Some(market)),
            rest.marks(Some(market)),
            rest.open_interest(market),
            rest.funding_intervals(),
            book,
            self.meta(),
        )?;
        let scale = meta.scales.get(market).copied();
        let missing = || VenueError::Network(format!("Aster sent no data for {market:?}"));
        let mut ticker = tickers.into_iter().next().ok_or_else(missing)?;
        let mut mark = marks.into_iter().next().ok_or_else(missing)?;
        let mut mid = wire::BookTicker::from(book).mid();
        let interval = wire::funding_interval_secs(&intervals, market);
        let open_interest = Arc::new(Mutex::new(oi));
        let first = wire::market_stats(&ticker, &mark, mid, oi, interval, scale, now_ms());

        // Refetches open interest until the stream below is dropped, which
        // drops the handler's reference.
        {
            let weak = Arc::downgrade(&open_interest);
            let rest = self.rest.clone();
            let market = market.to_owned();
            tokio::spawn(async move {
                loop {
                    tokio::time::sleep(STATS_OI_POLL).await;
                    let Some(shared) = weak.upgrade() else { return };
                    drop(shared);
                    if let Ok(fresh) = rest.open_interest(&market).await {
                        let Some(shared) = weak.upgrade() else { return };
                        *shared.lock().unwrap() = fresh;
                    }
                }
            });
        }

        let name = wire::stream_name(market);
        let streams = vec![
            format!("{name}@ticker"),
            format!("{name}@markPrice@1s"),
            format!("{name}@bookTicker"),
        ];
        let live = ws::subscribe(self.endpoints.ws, streams, move |push| {
            if push.stream.ends_with("@bookTicker") {
                if let Ok(book) = serde_json::from_value::<wire::BookTicker>(push.data) {
                    mid = book.mid();
                }
                return Handled::Ignore;
            } else if push.stream.ends_with("@ticker") {
                match wire::tickers_from_stream(push.data).map(|t| t.into_iter().next()) {
                    Ok(Some(fresh)) => ticker = fresh,
                    _ => return Handled::Ignore,
                }
            } else if push.stream.ends_with("@markPrice@1s") {
                match Mark::from_stream(push.data).map(|m| m.into_iter().next()) {
                    Ok(Some(fresh)) => mark = fresh,
                    _ => return Handled::Ignore,
                }
            } else {
                return Handled::Ignore;
            }
            let oi = *open_interest.lock().unwrap();
            Handled::Emit(wire::market_stats(
                &ticker,
                &mark,
                mid,
                oi,
                interval,
                scale,
                now_ms(),
            ))
        })
        .await?;
        Ok(with_first(first, live))
    }

    /// History over REST, then the kline stream, which re-sends the forming
    /// candle whole as it changes.
    async fn subscribe_candles(
        &self,
        market: &str,
        interval: CandleInterval,
    ) -> Result<mpsc::Receiver<Vec<Candle>>, VenueError> {
        wire::validate_market(market)?;
        let history = self
            .rest
            .klines(market, interval, CANDLE_HISTORY, None)
            .await?;
        let code = wire::interval_code(interval);
        let live = ws::subscribe(
            self.endpoints.ws,
            vec![format!("{}@kline_{code}", wire::stream_name(market))],
            move |push| match serde_json::from_value::<wire::WsKline>(push.data) {
                Ok(k) if k.k.i == code => Handled::Emit(vec![Candle::from(k.k)]),
                _ => Handled::Ignore,
            },
        )
        .await?;
        Ok(with_first(history, live))
    }

    /// Every live market's summary, first from REST, then kept current from
    /// the all-markets ticker and mark streams (no cost to the request
    /// budget) and sent every `SUMMARY_EVERY`. Open interest fills in market
    /// by market (see `OI_PACE_FIRST`); until a market's arrives it reads
    /// zero. Markets listed after subscribing appear on the next subscribe.
    async fn subscribe_market_summaries(
        &self,
    ) -> Result<mpsc::Receiver<Vec<MarketSummary>>, VenueError> {
        let rest = &self.rest;
        let (info, tickers, marks, intervals) = tokio::try_join!(
            rest.exchange_info(),
            rest.tickers(None),
            rest.marks(None),
            rest.funding_intervals(),
        )?;
        let live = live_markets(&info);
        let meta = Arc::new(wire::meta(&info));
        *self.meta.lock().await = Some(Arc::clone(&meta));
        let order = by_volume(&live, &tickers);
        let mut tickers: HashMap<String, Ticker> = tickers
            .into_iter()
            .filter(|t| live.contains(&t.symbol))
            .map(|t| (t.symbol.clone(), t))
            .collect();
        let mut marks: HashMap<String, Mark> = marks
            .into_iter()
            .filter(|m| live.contains(&m.symbol))
            .map(|m| (m.symbol.clone(), m))
            .collect();
        let open_interest: Arc<Mutex<HashMap<String, Decimal>>> = Arc::default();
        let first = wire::market_summaries(
            &order,
            &tickers,
            &marks,
            &open_interest.lock().unwrap(),
            &intervals,
            &meta.scales,
        );

        // Walks the markets for open interest until the stream is dropped.
        {
            let weak = Arc::downgrade(&open_interest);
            let rest = self.rest.clone();
            let order = order.clone();
            tokio::spawn(async move {
                let mut pace = OI_PACE_FIRST;
                loop {
                    for market in &order {
                        tokio::time::sleep(pace).await;
                        if weak.strong_count() == 0 {
                            return;
                        }
                        let Ok(oi) = rest.open_interest(market).await else {
                            continue;
                        };
                        let Some(shared) = weak.upgrade() else { return };
                        shared.lock().unwrap().insert(market.clone(), oi);
                    }
                    pace = OI_PACE;
                }
            });
        }

        let mut last_sent = Instant::now();
        let streams = vec!["!ticker@arr".to_owned(), "!markPrice@arr@1s".to_owned()];
        let live_rx = ws::subscribe(self.endpoints.ws, streams, move |push| {
            if push.stream == "!ticker@arr" {
                for t in wire::tickers_from_stream(push.data).unwrap_or_default() {
                    if live.contains(&t.symbol) {
                        tickers.insert(t.symbol.clone(), t);
                    }
                }
                return Handled::Ignore;
            }
            if !push.stream.starts_with("!markPrice@arr") {
                return Handled::Ignore;
            }
            for m in Mark::from_stream(push.data).unwrap_or_default() {
                if live.contains(&m.symbol) {
                    marks.insert(m.symbol.clone(), m);
                }
            }
            if last_sent.elapsed() < SUMMARY_EVERY {
                return Handled::Ignore;
            }
            last_sent = Instant::now();
            Handled::Emit(wire::market_summaries(
                &order,
                &tickers,
                &marks,
                &open_interest.lock().unwrap(),
                &intervals,
                &meta.scales,
            ))
        })
        .await?;
        Ok(with_first(first, live_rx))
    }

    /// Walks the markets busiest first, one market's hourly candles every
    /// `HISTORY_PACE`, then starts over with a fresh volume ranking. A market
    /// whose fetch fails is skipped until the next pass.
    async fn subscribe_market_history(&self) -> Result<mpsc::Receiver<MarketHistory>, VenueError> {
        let rest = self.rest.clone();
        let mut order = rest.markets_by_volume().await?;

        let (tx, rx) = mpsc::channel(8);
        tokio::spawn(async move {
            loop {
                for market in &order {
                    tokio::select! {
                        _ = tx.closed() => return,
                        _ = tokio::time::sleep(HISTORY_PACE) => {}
                    }
                    let Ok(candles) = rest
                        .klines(market, CandleInterval::OneHour, HISTORY_HOURS, None)
                        .await
                    else {
                        continue;
                    };
                    let history = MarketHistory {
                        market: market.clone(),
                        interval: CandleInterval::OneHour,
                        candles,
                    };
                    if tx.send(history).await.is_err() {
                        return;
                    }
                }
                if let Ok(fresh) = rest.markets_by_volume().await {
                    order = fresh;
                }
            }
        });
        Ok(rx)
    }

    async fn candles(
        &self,
        market: &str,
        interval: CandleInterval,
        before: u64,
        count: u32,
    ) -> Result<Vec<Candle>, VenueError> {
        wire::validate_market(market)?;
        if before == 0 {
            return Ok(Vec::new());
        }
        let candles = self
            .rest
            .klines(
                market,
                interval,
                count.clamp(1, MAX_CANDLE_PAGE),
                Some(before - 1),
            )
            .await?;
        // Only candles that opened before `before`, whatever the venue rounds.
        Ok(candles
            .into_iter()
            .filter(|c| c.open_time < before)
            .collect())
    }

    async fn funding_history(
        &self,
        market: &str,
        start_time: u64,
    ) -> Result<Vec<FundingRate>, VenueError> {
        wire::validate_market(market)?;
        // A request returns the oldest 1,000 from `startTime`, so page forward
        // from just after the last one until a short page says we're caught up.
        // Aster reads `startTime=0` as absent and returns the latest page.
        let mut rates = Vec::new();
        let mut from = start_time.max(1);
        for _ in 0..FUNDING_MAX_PAGES {
            let page: Vec<wire::FundingEntry> = self
                .rest
                .get(
                    "/fapi/v1/fundingRate",
                    &[
                        ("symbol", market.to_owned()),
                        ("startTime", from.to_string()),
                        ("limit", FUNDING_PAGE.to_string()),
                    ],
                )
                .await?;
            let full = page.len() >= FUNDING_PAGE;
            let Some(last) = page.last().map(|e| e.funding_time) else {
                break;
            };
            rates.extend(page.into_iter().map(wire::funding_rate));
            if !full {
                break;
            }
            from = last + 1;
        }
        Ok(rates)
    }

    /// The market's base asset's logo, from Aster's logo list, as SVG (see
    /// `icons`). `None` for an asset without one. The market needn't be one
    /// Aster lists: its logo list is by asset.
    async fn market_icon(&self, market: &str) -> Result<Option<String>, VenueError> {
        wire::validate_market(market)?;
        if let Some(cached) = self.icons.lock().unwrap().get(market) {
            return Ok(cached.clone());
        }
        let meta = self.meta().await?;
        // Aster's logo list covers more assets than it has markets for. A
        // market it doesn't list (another venue's, borrowing the logo) is
        // looked up by the coin its name starts with.
        let base = meta
            .bases
            .get(market)
            .map(String::as_str)
            .or_else(|| icons::base_of(market));
        let url = match base {
            Some(base) => self.logo_urls().await?.get(base).cloned(),
            None => None,
        };
        let icon = match url {
            Some(url) => self.fetch_icon(&url).await?,
            None => None,
        };
        self.icons
            .lock()
            .unwrap()
            .insert(market.to_owned(), icon.clone());
        Ok(icon)
    }

    async fn account(&self, address: &str) -> Result<AccountSnapshot, VenueError> {
        let keys = self
            .keys
            .as_ref()
            .ok_or(VenueError::Unsupported(NO_ACCOUNT_DATA))?;
        self.rest.account(keys.as_ref(), address).await
    }

    /// Polled: a snapshot every `ACCOUNT_EVERY`. A failed poll keeps the
    /// last one on screen and tries again.
    async fn subscribe_account(
        &self,
        address: &str,
    ) -> Result<mpsc::Receiver<AccountSnapshot>, VenueError> {
        let keys = self
            .keys
            .clone()
            .ok_or(VenueError::Unsupported(NO_ACCOUNT_DATA))?;
        let rest = self.rest.clone();
        let first = rest.account(keys.as_ref(), address).await?;
        let (tx, rx) = mpsc::channel(4);
        let address = address.to_owned();
        tokio::spawn(async move {
            if tx.send(first).await.is_err() {
                return;
            }
            loop {
                tokio::select! {
                    _ = tx.closed() => return,
                    _ = tokio::time::sleep(ACCOUNT_EVERY) => {}
                }
                if let Ok(next) = rest.account(keys.as_ref(), &address).await {
                    if tx.send(next).await.is_err() {
                        return;
                    }
                }
            }
        });
        Ok(rx)
    }

    async fn fills(&self, address: &str) -> Result<Vec<Fill>, VenueError> {
        let key = self.read_key(address).await?;
        let to = now_ms();
        let from = to.saturating_sub(WEEK_MS);
        let markets = self.rest.traded_markets(&key, from, to).await?;
        let mut trades = self.rest.trades(&key, &markets, from, to).await?;
        trades.sort_by_key(|t| std::cmp::Reverse((t.time, t.id)));
        Ok(trades.into_iter().filter_map(history::fill).collect())
    }

    async fn closed_trades(&self, address: &str) -> Result<Vec<ClosedTrade>, VenueError> {
        self.closed_trades_since(address, now_ms().saturating_sub(WEEK_MS))
            .await
    }

    async fn closed_trades_since(
        &self,
        address: &str,
        start_time: u64,
    ) -> Result<Vec<ClosedTrade>, VenueError> {
        let key = self.read_key(address).await?;
        let to = now_ms();
        let from = start_time.max(to.saturating_sub(HISTORY_WEEKS * WEEK_MS));
        let markets = self.rest.traded_markets(&key, from, to).await?;
        let trades = self.rest.trades(&key, &markets, from, to).await?;
        Ok(history::closed_trades(trades))
    }

    async fn order_history(&self, address: &str) -> Result<Vec<Order>, VenueError> {
        let key = self.read_key(address).await?;
        let rows: Vec<history::WireHistoricalOrder> = self
            .rest
            .signed_get(
                "/fapi/v3/allOrders",
                &[("limit", HISTORY_PAGE.to_owned())],
                &key,
            )
            .await?;
        let mut orders: Vec<Order> = rows
            .into_iter()
            .filter_map(history::historical_order)
            .collect();
        orders.sort_by_key(|o| std::cmp::Reverse(o.created_at));
        Ok(orders)
    }

    async fn funding_payments(
        &self,
        address: &str,
        start_time: u64,
    ) -> Result<Vec<FundingPayment>, VenueError> {
        let key = self.read_key(address).await?;
        let incomes: Vec<history::WireIncome> = self
            .rest
            .signed_get(
                "/fapi/v3/income",
                &[
                    ("incomeType", "FUNDING_FEE".to_owned()),
                    ("startTime", start_time.to_string()),
                    ("limit", HISTORY_PAGE.to_owned()),
                ],
                &key,
            )
            .await?;
        let mut payments: Vec<FundingPayment> = incomes
            .into_iter()
            .filter_map(history::funding_payment)
            .collect();
        payments.sort_by_key(|p| std::cmp::Reverse(p.time));
        Ok(payments)
    }

    async fn trade_settings(
        &self,
        address: &str,
        market: &str,
    ) -> Result<TradeSettings, VenueError> {
        wire::validate_market(market)?;
        let info = self.rest.exchange_info().await?;
        let max = wire::max_leverage_of(&info, market).ok_or_else(|| {
            VenueError::InvalidRequest(format!("{market:?} isn't a live Aster market"))
        })?;
        let key = self.read_key(address).await?;
        let rows: Vec<account::WirePosition> = self
            .rest
            .signed_get(
                "/fapi/v3/positionRisk",
                &[("symbol", market.to_owned())],
                &key,
            )
            .await?;
        let row = rows
            .iter()
            .find(|r| r.symbol == market)
            .ok_or_else(|| VenueError::Network("Aster sent no settings for this market".into()))?;
        Ok(history::trade_settings(row, max))
    }

    async fn place_order(
        &self,
        account: &TradingAccount,
        request: &OrderRequest,
    ) -> Result<Order, VenueError> {
        let keys = self
            .keys
            .as_ref()
            .ok_or(VenueError::Unsupported("orders (no key store is set up)"))?;
        wire::validate_market(&request.market)?;
        // The market's grid as the venue has it now, not as last cached.
        let info = self.rest.exchange_info().await?;
        let (tick, step, min_size) = wire::steps(&info, &request.market).ok_or_else(|| {
            VenueError::InvalidRequest(format!("{:?} isn't a live Aster market", request.market))
        })?;
        let quote = self.rest.quote(&request.market).await?;
        let params = orders::create(
            request,
            orders::Steps {
                tick,
                step,
                min_size,
            },
            quote,
        )?;
        let placed: orders::Placed = {
            let key = keys.key(&account.key).await?;
            self.rest
                .signed(reqwest::Method::POST, "/fapi/v3/order", &params, &key)
                .await?
        };
        let (status, filled_size) = match placed.outcome()? {
            orders::Outcome::Open => (OrderStatus::Open, Decimal::default()),
            orders::Outcome::Filled(size) => (OrderStatus::Filled, size),
        };
        let trigger = matches!(request.kind, OrderKind::Trigger { .. });
        Ok(Order {
            venue: VenueId::Aster,
            id: placed.order_id.to_string(),
            client_id: request.client_id.clone(),
            market: request.market.clone(),
            side: request.side,
            order_type: request.kind.order_type(),
            size: request.size,
            filled_size,
            price: match request.kind {
                OrderKind::Limit { price, .. } => Some(price),
                OrderKind::Trigger { limit_price, .. } => limit_price,
                OrderKind::Market { .. } => None,
            },
            trigger_price: match request.kind {
                OrderKind::Trigger { trigger_price, .. } => Some(trigger_price),
                _ => None,
            },
            reduce_only: request.reduce_only,
            status,
            created_at: now_ms(),
            category: if trigger {
                OrderCategory::Conditional
            } else {
                OrderCategory::Regular
            },
            trigger_by: trigger.then_some(PriceSource::Last),
            take_profit: None,
            stop_loss: None,
        })
    }

    async fn cancel_order(
        &self,
        account: &TradingAccount,
        market: &str,
        order_id: &str,
    ) -> Result<(), VenueError> {
        let keys = self
            .keys
            .as_ref()
            .ok_or(VenueError::Unsupported("orders (no key store is set up)"))?;
        wire::validate_market(market)?;
        let params = orders::cancel(market, order_id)?;
        let key = keys.key(&account.key).await?;
        let _: Value = self
            .rest
            .signed(reqwest::Method::DELETE, "/fapi/v3/order", &params, &key)
            .await?;
        Ok(())
    }

    /// A limit order's price and size (Aster changes nothing else, and no
    /// other kind of order). What isn't given is kept, read from the order
    /// as Aster has it.
    async fn amend_order(
        &self,
        account: &TradingAccount,
        market: &str,
        order_id: &str,
        amend: &OrderAmend,
    ) -> Result<(), VenueError> {
        if amend.take_profit != ExitChange::Keep || amend.stop_loss != ExitChange::Keep {
            return Err(VenueError::Unsupported(
                "a take-profit or stop-loss on an Aster order",
            ));
        }
        if amend.price.is_none() && amend.size.is_none() {
            return Err(VenueError::InvalidRequest(
                "there's nothing to change".into(),
            ));
        }
        let keys = self
            .keys
            .as_ref()
            .ok_or(VenueError::Unsupported("orders (no key store is set up)"))?;
        wire::validate_market(market)?;
        let steps = self.steps(market).await?;
        let key = keys.key(&account.key).await?;
        let current: account::WireOrder = self
            .rest
            .signed_get(
                "/fapi/v3/openOrder",
                &orders::open_order(market, order_id)?,
                &key,
            )
            .await?;
        if current.order_type != "LIMIT" || current.symbol != market {
            return Err(VenueError::InvalidRequest(
                "only a limit order's price and size can be changed on Aster".into(),
            ));
        }
        let side = match current.side.as_str() {
            "BUY" => Side::Buy,
            "SELL" => Side::Sell,
            _ => {
                return Err(VenueError::Network(
                    "Aster sent an order with no side".into(),
                ))
            }
        };
        let params = orders::amend(
            market,
            order_id,
            side,
            amend.size.unwrap_or(current.orig_qty),
            amend.price.unwrap_or(current.price),
            steps,
        )?;
        let _: Value = self
            .rest
            .signed(reqwest::Method::PUT, "/fapi/v3/order", &params, &key)
            .await?;
        Ok(())
    }

    /// A whole number from 1 to the market's highest.
    async fn set_leverage(
        &self,
        account: &TradingAccount,
        market: &str,
        leverage: Decimal,
    ) -> Result<(), VenueError> {
        let keys = self
            .keys
            .as_ref()
            .ok_or(VenueError::Unsupported("orders (no key store is set up)"))?;
        wire::validate_market(market)?;
        let info = self.rest.exchange_info().await?;
        let max = wire::max_leverage_of(&info, market).ok_or_else(|| {
            VenueError::InvalidRequest(format!("{market:?} isn't a live Aster market"))
        })?;
        let params = orders::leverage(market, leverage, max)?;
        let key = keys.key(&account.key).await?;
        let _: Value = self
            .rest
            .signed(reqwest::Method::POST, "/fapi/v3/leverage", &params, &key)
            .await?;
        Ok(())
    }

    /// Cross or isolated on `market`; asking for the one it has is done.
    async fn set_margin_mode(
        &self,
        account: &TradingAccount,
        market: &str,
        mode: MarginMode,
    ) -> Result<(), VenueError> {
        let keys = self
            .keys
            .as_ref()
            .ok_or(VenueError::Unsupported("orders (no key store is set up)"))?;
        wire::validate_market(market)?;
        let params = orders::margin_type(market, mode);
        let key = keys.key(&account.key).await?;
        let sent: Result<Value, VenueError> = self
            .rest
            .signed(reqwest::Method::POST, "/fapi/v3/marginType", &params, &key)
            .await;
        match sent {
            Ok(_) => Ok(()),
            Err(VenueError::InvalidRequest(m)) if m == SAME_MARGIN_TYPE => Ok(()),
            Err(e) => Err(e),
        }
    }

    /// The position's take-profit and stop-loss, as orders that close it
    /// whole at market once the mark reaches them. A new one is placed
    /// before the one it replaces is cancelled, so the position keeps an
    /// exit in between; if Aster won't hold two of a kind, the old one is
    /// cancelled first. Aster's trailing stop moves by a percentage, not the
    /// distance the page gives, so it isn't offered.
    async fn set_position_protection(
        &self,
        account: &TradingAccount,
        market: &str,
        protection: &PositionProtection,
    ) -> Result<(), VenueError> {
        if matches!(protection.trailing_stop, ExitChange::Set(_)) {
            return Err(VenueError::Unsupported("trailing stops on Aster"));
        }
        let keys = self
            .keys
            .as_ref()
            .ok_or(VenueError::Unsupported("orders (no key store is set up)"))?;
        wire::validate_market(market)?;
        let steps = self.steps(market).await?;
        let quote = self.rest.quote(market).await?;
        let key = keys.key(&account.key).await?;
        let symbol = [("symbol", market.to_owned())];
        let positions: Vec<account::WirePosition> = self
            .rest
            .signed_get("/fapi/v3/positionRisk", &symbol, &key)
            .await?;
        let amount = positions
            .iter()
            .find(|p| p.symbol == market && !p.position_amt.0.is_zero())
            .map(|p| p.position_amt.0)
            .ok_or_else(|| {
                VenueError::InvalidRequest("there's no open position on this market".into())
            })?;
        let long = amount > rust_decimal::Decimal::ZERO;
        let open: Vec<account::WireOrder> = self
            .rest
            .signed_get("/fapi/v3/openOrders", &symbol, &key)
            .await?;
        let old = |kind: &str| -> Vec<String> {
            open.iter()
                .filter(|o| o.symbol == market && o.close_position && o.order_type == kind)
                .map(|o| o.order_id.to_string())
                .collect()
        };
        let cancel = |ids: Vec<String>| {
            let key = &key;
            async move {
                for id in ids {
                    let params = orders::cancel(market, &id)?;
                    let _: Value = self
                        .rest
                        .signed(reqwest::Method::DELETE, "/fapi/v3/order", &params, key)
                        .await?;
                }
                Ok::<(), VenueError>(())
            }
        };
        for (change, exit, kind) in [
            (
                &protection.take_profit,
                orders::Exit::TakeProfit,
                "TAKE_PROFIT_MARKET",
            ),
            (&protection.stop_loss, orders::Exit::StopLoss, "STOP_MARKET"),
        ] {
            let replaced = old(kind);
            match change {
                ExitChange::Keep => {}
                ExitChange::Remove => cancel(replaced).await?,
                ExitChange::Set(price) => {
                    let params = orders::exit(market, long, exit, *price, steps, quote)?;
                    let placed: Result<Value, VenueError> = self
                        .rest
                        .signed(reqwest::Method::POST, "/fapi/v3/order", &params, &key)
                        .await;
                    match placed {
                        Ok(_) => cancel(replaced).await.map_err(|e| {
                            VenueError::Rejected(format!(
                                "the new exit is set, but the one it replaces couldn't be cancelled ({e}); cancel it in Open orders"
                            ))
                        })?,
                        // Refused with an old one still there: take that off, then try again.
                        Err(_) if !replaced.is_empty() => {
                            cancel(replaced).await?;
                            let _: Value = self
                                .rest
                                .signed(reqwest::Method::POST, "/fapi/v3/order", &params, &key)
                                .await?;
                        }
                        Err(e) => return Err(e),
                    }
                }
            }
        }
        // A trailing stop being removed: Aster's own, if one was set there.
        if protection.trailing_stop == ExitChange::Remove {
            let trailing: Vec<String> = open
                .iter()
                .filter(|o| o.symbol == market && o.order_type == "TRAILING_STOP_MARKET")
                .map(|o| o.order_id.to_string())
                .collect();
            cancel(trailing).await?;
        }
        Ok(())
    }
}
