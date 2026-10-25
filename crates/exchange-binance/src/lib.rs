//! Binance adapter: USDⓈ-M futures (a centralized exchange: an order book
//! run by Binance, accounts held there rather than on a chain). Public
//! market data over the futures REST API and its split stream routes
//! (`/public` for the book, `/market` for the rest), none of which needs a
//! key; an account's state, history and orders, which do.
//!
//! Market ids are Binance's symbols (`BTCUSDT`, `BTCUSDC`, and the TradFi
//! perpetuals - stocks, metals, FX - such as `TSLAUSDT`). Dated futures are
//! left out: the terminal shows perpetuals only. Each stream is seeded over
//! REST before going live, which also turns an unknown market into an error
//! (the streams ignore one silently).
//!
//! The trade-only key is an API key with futures trading on and nothing
//! that moves funds or trades anything else: [`auth`] signs requests (HMAC
//! over the query string exactly as sent) and decides whether a key
//! qualifies; onboarding uses [`BinanceAdapter::check_key`] to ask Binance
//! about a key before it's stored - see docs/adr/0001-venues-in-rust.md.
//! Demo Trading keys (Binance's testnet, renamed) reach only demo funds on
//! the demo host, whose book is its own: a demo account's orders are priced
//! from there, not from mainnet's prices.
//!
//! Orders come back `Open` or `Filled` (a market order is an IOC limit, so
//! it has filled or it's refused): Binance answers once the matching engine
//! has the order. Trigger orders, and a position's take-profit and
//! stop-loss, are Binance "algo" (conditional) orders since 2025-12-09: a
//! service of their own, whose ids this adapter hands out as `algo:<id>`.
//! `orders.rs` builds every request's parameters, this module signs exactly
//! those and sends them as signed. Both are security-sensitive. Nothing here
//! can withdraw or transfer: the adapter has no such request.

mod account;
pub mod auth;
mod book;
pub mod constants;
mod history;
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
    ExitChange, Fill, FundingPayment, FundingRate, KeySource, Liquidation, LongShortPoint,
    MarginMode, Market, MarketHistory, MarketStats, MarketSummary, OpenInterestPoint, Order,
    OrderAmend, OrderBook, OrderCategory, OrderKind, OrderRequest, OrderStatus, OrderType,
    PositionProtection, PriceSource, Side, Trade, TradeSettings, TradingAccount, VenueError,
    VenueId,
};
use reqwest::Method;
use serde::de::DeserializeOwned;
use serde_json::Value;
use tokio::sync::mpsc;
use tokio::sync::mpsc::error::TrySendError;

use constants::Endpoints;
use tape::Tape;
use wire::{Mark, Ticker};
use ws::Handled;

const REQUEST_TIMEOUT: Duration = Duration::from_secs(10);
/// Levels per side kept from the REST snapshot the local book starts from
/// (Binance's most; 20 weight).
const BOOK_SNAPSHOT: u32 = 1000;
/// Levels per side sent to the UI: enough to group into coarser steps.
const BOOK_DEPTH: usize = 500;
/// The book goes out at most this often; its stream pushes every 100ms.
const BOOK_EVERY: Duration = Duration::from_millis(200);
/// A book that lost its place waits this long between fresh snapshots.
const BOOK_RESYNC: Duration = Duration::from_secs(3);
/// Trades the tape starts with.
const TRADE_HISTORY: u32 = 100;
/// Candles of history sent before live updates.
const CANDLE_HISTORY: u32 = 500;
/// The most candles Binance returns per request.
const MAX_CANDLE_PAGE: u32 = 1500;
/// Summaries go out at most this often; the streams feeding them push every
/// second, far more than a screener needs.
const SUMMARY_EVERY: Duration = Duration::from_secs(5);
/// Open interest has no all-markets endpoint or stream, so the summaries
/// fetch it one market at a time, busiest first: quickly on the first pass,
/// then slower to keep it fresh. One weight each.
const OI_PACE_FIRST: Duration = Duration::from_millis(150);
const OI_PACE: Duration = Duration::from_millis(750);
/// A single market's stats refresh its open interest this often.
const STATS_OI_POLL: Duration = Duration::from_secs(30);
/// Hourly candles fetched per market for screening: 7 days.
const HISTORY_HOURS: u32 = 7 * 24;
/// One market's history per this long: two weight a second with the open
/// interest walk, well inside Binance's 2,400 a minute.
const HISTORY_PACE: Duration = Duration::from_secs(1);
/// Binance returns at most this many funding payments per request.
const FUNDING_PAGE: usize = 1000;
/// Pages fetched per `funding_history` call at most.
const FUNDING_MAX_PAGES: usize = 10;
/// The most rows Binance's positioning history (`/futures/data/`) serves.
const POSITIONING_PAGE: u32 = 500;

/// The account is re-read this often while it's on screen: about 95 weight
/// (the two all-market order lists are 40 each), under a quarter of
/// Binance's per-IP budget.
const ACCOUNT_EVERY: Duration = Duration::from_secs(10);
/// Binance serves an account's trades a week at a time at most.
const WEEK_MS: u64 = 7 * 24 * 3_600_000;
/// How far back a closed-trade history reaches at most: 30 days, a week at
/// a time, so one call makes a bounded number of requests.
const HISTORY_WEEKS: u64 = 5;
/// Markets read for fills and orders at once at most, the most recently
/// traded first.
const TRADED_MARKETS: usize = 20;
/// Rows Binance returns per history request at most.
const HISTORY_PAGE: &str = "1000";
/// How long a reading of Binance's clock is trusted.
const CLOCK_EVERY: Duration = Duration::from_secs(60);

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| d.as_millis() as u64)
}

/// A query value as it's sent: letters, digits and `-_.~` as they are,
/// every other byte percent-encoded (a market's symbol can be Chinese).
/// The query is signed after this, so the string signed is the one sent.
fn encode(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    for byte in value.bytes() {
        if byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.' | b'~') {
            out.push(byte as char);
        } else {
            out.push_str(&format!("%{byte:02X}"));
        }
    }
    out
}

/// What a request that may have reached Binance says when its answer was lost.
const UNKNOWN_FATE: &str =
    "the connection dropped after sending; check your open orders before trying again";

/// Reads Binance's answer: the body on success, its refusal said plainly
/// otherwise. `writes` marks a request that changes something, whose fate
/// is unknown if Binance timed out behind the scenes (-1007).
async fn answer<T: DeserializeOwned>(
    response: reqwest::Response,
    writes: bool,
) -> Result<T, VenueError> {
    let status = response.status();
    // 429 is a rate limit; 418 is Binance's ban for ignoring one.
    if matches!(status.as_u16(), 418 | 429) {
        return Err(VenueError::Network(format!("rate limited ({status})")));
    }
    let body = response
        .text()
        .await
        .map_err(|e| VenueError::Network(e.without_url().to_string()))?;
    if !status.is_success() {
        if let Ok(e) = serde_json::from_str::<auth::ApiError>(&body) {
            if e.code == -1007 {
                return Err(VenueError::Network(if writes {
                    UNKNOWN_FATE.into()
                } else {
                    "Binance timed out; try again".into()
                }));
            }
            return Err(auth::api_error(e.code, e.msg));
        }
        return Err(VenueError::Network(format!(
            "Binance API returned {status}"
        )));
    }
    serde_json::from_str(&body)
        .map_err(|e| VenueError::Network(format!("unexpected Binance response: {e}")))
}

/// The REST API on one host. Cheap to clone, so background tasks carry
/// their own.
#[derive(Clone)]
struct Rest {
    http: reqwest::Client,
    base: &'static str,
    /// Where the host's clock is read: futures and spot differ.
    time_path: &'static str,
    /// Binance's clock minus ours (ms), and when that was measured: signed
    /// requests are stamped by Binance's clock, re-read every `CLOCK_EVERY`.
    clock: Arc<Mutex<Option<(i64, Instant)>>>,
}

impl Rest {
    fn new(http: &reqwest::Client, base: &'static str, time_path: &'static str) -> Self {
        Self {
            http: http.clone(),
            base,
            time_path,
            clock: Arc::default(),
        }
    }

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
        answer(response, false).await
    }

    /// Binance's clock minus ours, re-read every `CLOCK_EVERY`. Binance
    /// refuses a request stamped outside its window, so signed requests are
    /// stamped by its clock; reading it also opens the connection. Offline,
    /// the signed request would fail anyway; the local clock is the fallback.
    async fn clock_offset(&self) -> i64 {
        if let Some((offset, at)) = *self.clock.lock().unwrap() {
            if at.elapsed() < CLOCK_EVERY {
                return offset;
            }
        }
        #[derive(serde::Deserialize)]
        #[serde(rename_all = "camelCase")]
        struct Time {
            server_time: u64,
        }
        match self.get::<Time>(self.time_path, &[]).await {
            Ok(time) => {
                let offset = time.server_time as i64 - now_ms() as i64;
                *self.clock.lock().unwrap() = Some((offset, Instant::now()));
                offset
            }
            Err(_) => 0,
        }
    }

    /// A request signed with `creds`. Crate-private, and the path is
    /// `'static` - this crate's own - as is every parameter name, so nothing
    /// outside chooses where it goes or what it asks; the values come from
    /// `orders.rs` or this crate. They go in the query string, encoded, then
    /// `recvWindow`, `timestamp` (by Binance's clock) and last the signature
    /// over exactly that string. Never retried - a resend could place an
    /// order twice.
    async fn signed<T: DeserializeOwned>(
        &self,
        method: Method,
        path: &'static str,
        params: &[(&'static str, String)],
        creds: &auth::ApiCredentials,
    ) -> Result<T, VenueError> {
        let writes = method != Method::GET;
        let timestamp = (now_ms() as i64 + self.clock_offset().await) as u64;
        let mut query: Vec<String> = params
            .iter()
            .map(|(k, v)| format!("{k}={}", encode(v)))
            .collect();
        query.push(format!("recvWindow={}", auth::RECV_WINDOW));
        query.push(format!("timestamp={timestamp}"));
        let query = query.join("&");
        let signature = creds.sign(&query);
        let response = self
            .http
            .request(
                method,
                format!("{}{path}?{query}&signature={signature}", self.base),
            )
            .header("X-MBX-APIKEY", creds.api_key())
            .send()
            .await
            .map_err(|e| {
                if writes && !e.is_connect() {
                    VenueError::Network(UNKNOWN_FATE.into())
                } else {
                    VenueError::Network(e.without_url().to_string())
                }
            })?;
        answer(response, writes).await
    }

    async fn signed_get<T: DeserializeOwned>(
        &self,
        path: &'static str,
        params: &[(&'static str, String)],
        creds: &auth::ApiCredentials,
    ) -> Result<T, VenueError> {
        self.signed(Method::GET, path, params, creds).await
    }

    async fn exchange_info(&self) -> Result<wire::ExchangeInfo, VenueError> {
        self.get("/fapi/v1/exchangeInfo", &[]).await
    }

    /// Live market `market`'s grid as this host has it now.
    async fn grid(&self, market: &str) -> Result<wire::Grid, VenueError> {
        let info = self.exchange_info().await?;
        wire::grid(&info, market).ok_or_else(|| {
            VenueError::InvalidRequest(format!("{market:?} isn't a live Binance perpetual"))
        })
    }

    /// `market`'s touch and mark on this host now. Public.
    async fn quote(&self, market: &str) -> Result<orders::Quote, VenueError> {
        let query = symbol_query(Some(market));
        let (book, marks) = tokio::try_join!(
            self.get::<wire::RestBookTicker>("/fapi/v1/ticker/bookTicker", &query),
            self.marks(Some(market)),
        )?;
        Ok(orders::Quote {
            bid: book.bid_price,
            ask: book.ask_price,
            mark: marks.into_iter().next().map(|m| m.mark_price),
        })
    }

    async fn depth(&self, market: &str, limit: u32) -> Result<wire::Depth, VenueError> {
        self.get(
            "/fapi/v1/depth",
            &[("symbol", market.to_owned()), ("limit", limit.to_string())],
        )
        .await
    }

    /// Every market's 24h ticker, or one market's.
    async fn tickers(&self, market: Option<&str>) -> Result<Vec<Ticker>, VenueError> {
        let value: Value = self
            .get("/fapi/v1/ticker/24hr", &symbol_query(market))
            .await?;
        Ticker::from_rest(value).map_err(parse_error)
    }

    /// Every market's mark and funding, or one market's.
    async fn marks(&self, market: Option<&str>) -> Result<Vec<Mark>, VenueError> {
        let value: Value = self
            .get("/fapi/v1/premiumIndex", &symbol_query(market))
            .await?;
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

    /// The account's margin summary, positions and open orders - ordinary
    /// and conditional - signed with `creds`. Read-only.
    async fn account(
        &self,
        creds: &auth::ApiCredentials,
        id: &str,
    ) -> Result<AccountSnapshot, VenueError> {
        let none: &[(&str, String)] = &[];
        let (summary, config, positions, orders, algos) = tokio::try_join!(
            self.signed_get::<account::WireAccount>("/fapi/v3/account", none, creds),
            self.signed_get::<account::AccountConfig>("/fapi/v1/accountConfig", none, creds),
            self.signed_get::<Vec<account::WirePosition>>("/fapi/v3/positionRisk", none, creds),
            self.signed_get::<Vec<account::WireOrder>>("/fapi/v1/openOrders", none, creds),
            self.signed_get::<account::AlgoOrders>("/fapi/v1/openAlgoOrders", none, creds),
        )?;
        Ok(account::snapshot(
            id,
            summary,
            config,
            positions,
            orders,
            algos.into_vec(),
            now_ms(),
        ))
    }

    /// The markets the account traded between `from` and `to`, from its fee
    /// records, most recently traded first.
    async fn traded_markets(
        &self,
        creds: &auth::ApiCredentials,
        from: u64,
        to: u64,
    ) -> Result<Vec<String>, VenueError> {
        let incomes: Vec<history::WireIncome> = self
            .signed_get(
                "/fapi/v1/income",
                &[
                    ("incomeType", "COMMISSION".to_owned()),
                    ("startTime", from.to_string()),
                    ("endTime", to.to_string()),
                    ("limit", HISTORY_PAGE.to_owned()),
                ],
                creds,
            )
            .await?;
        Ok(history::traded_markets(&incomes, TRADED_MARKETS))
    }

    /// The account's trades on `markets` between `from` and `to`, a week at
    /// a time (Binance's widest window), up to a page per market and week.
    async fn trades(
        &self,
        creds: &auth::ApiCredentials,
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
                        "/fapi/v1/userTrades",
                        &[
                            ("symbol", market.clone()),
                            ("startTime", start.to_string()),
                            ("endTime", end.to_string()),
                            ("limit", HISTORY_PAGE.to_owned()),
                        ],
                        creds,
                    )
                    .await?;
                trades.extend(page);
            }
            start = end + 1;
        }
        Ok(trades)
    }

    /// The account's highest leverage on `market`, from its own brackets.
    async fn max_leverage(
        &self,
        creds: &auth::ApiCredentials,
        market: &str,
    ) -> Result<u32, VenueError> {
        let brackets: Vec<wire::Brackets> = self
            .signed_get(
                "/fapi/v1/leverageBracket",
                &[("symbol", market.to_owned())],
                creds,
            )
            .await?;
        brackets
            .iter()
            .find(|b| b.symbol == market)
            .and_then(wire::Brackets::max_leverage)
            .ok_or_else(|| VenueError::InvalidRequest(format!("{market:?} has no leverage limit")))
    }
}

fn symbol_query(market: Option<&str>) -> Vec<(&'static str, String)> {
    market
        .map(|m| vec![("symbol", m.to_owned())])
        .unwrap_or_default()
}

fn parse_error(e: serde_json::Error) -> VenueError {
    VenueError::Network(format!("unexpected Binance response: {e}"))
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

/// Keeps `market`'s book from its diff stream, starting again from a fresh
/// snapshot whenever a diff is missed, and sends it at most every
/// `BOOK_EVERY`. Until `tx` is dropped.
async fn keep_book(
    rest: Rest,
    market: String,
    mut book: book::Book,
    mut diffs: mpsc::Receiver<wire::DepthDiff>,
    tx: mpsc::Sender<OrderBook>,
) {
    let mut synced = true;
    let mut dirty = false;
    let mut last_sent = Instant::now();
    let mut last_resync = Instant::now();
    loop {
        let diff = tokio::select! {
            _ = tx.closed() => return,
            diff = diffs.recv() => match diff {
                Some(diff) => diff,
                None => return,
            },
        };
        if synced {
            match book.apply(&diff) {
                book::Applied::Changed => dirty = true,
                book::Applied::Stale => {}
                book::Applied::Gap => synced = false,
            }
        }
        if !synced && last_resync.elapsed() >= BOOK_RESYNC {
            last_resync = Instant::now();
            // The diffs that came in meanwhile are still queued, and apply
            // on top of this (the older ones are stale).
            if let Ok(depth) = rest.depth(&market, BOOK_SNAPSHOT).await {
                book.reset(&depth);
                synced = true;
                dirty = true;
            }
        }
        if dirty && last_sent.elapsed() >= BOOK_EVERY {
            match tx.try_send(book.snapshot(&market, BOOK_DEPTH)) {
                Ok(()) | Err(TrySendError::Full(_)) => {}
                Err(TrySendError::Closed(_)) => return,
            }
            dirty = false;
            last_sent = Instant::now();
        }
    }
}

/// One update on a market's stats connection.
enum StatsUpdate {
    Ticker(Ticker),
    Mark(Mark),
}

/// What Binance says about a key, after it's been checked.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct KeyCheck {
    pub key: auth::TradeOnlyKey,
    /// The futures account trades in Hedge Mode, which this adapter's
    /// orders don't (they'd be refused until it's switched to One-way).
    pub hedge_mode: bool,
}

pub struct BinanceAdapter {
    rest: Rest,
    /// Demo Trading's futures host, for demo accounts; unset where the
    /// network has none.
    demo: Option<Rest>,
    /// The spot hosts, for a key's UID and restrictions only.
    spot: Rest,
    demo_spot: Option<Rest>,
    endpoints: &'static Endpoints,
    /// Price decimals, from `exchangeInfo`: fetched on first use and
    /// refreshed whenever `markets` runs.
    meta: tokio::sync::Mutex<Option<Arc<wire::Meta>>>,
    /// Where account reads take the stored API key from; unset, account
    /// data is `Unsupported`.
    keys: Option<Arc<dyn KeySource>>,
}

const NO_ACCOUNT_DATA: &str = "Binance account data (no key store is set up)";

impl BinanceAdapter {
    /// Talks only to `endpoints`, which are fixed in [`constants`] - never a
    /// URL supplied by a caller.
    pub fn new(endpoints: &'static Endpoints) -> Result<Self, VenueError> {
        // Gzip: `exchangeInfo` and the all-market tickers are most of a
        // megabyte as plain JSON. No redirects: a request stays on its host.
        let http = reqwest::Client::builder()
            .timeout(REQUEST_TIMEOUT)
            .gzip(true)
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .map_err(|e| VenueError::Network(e.to_string()))?;
        const FUTURES_TIME: &str = "/fapi/v1/time";
        const SPOT_TIME: &str = "/api/v3/time";
        Ok(Self {
            rest: Rest::new(&http, endpoints.rest, FUTURES_TIME),
            demo: endpoints
                .demo_rest
                .map(|base| Rest::new(&http, base, FUTURES_TIME)),
            spot: Rest::new(&http, endpoints.spot_rest, SPOT_TIME),
            demo_spot: endpoints
                .demo_spot_rest
                .map(|base| Rest::new(&http, base, SPOT_TIME)),
            endpoints,
            meta: tokio::sync::Mutex::new(None),
            keys: None,
        })
    }

    /// Adds the app's `KeySource`, which account reads take the stored API
    /// key from. Without one, account data is `Unsupported`.
    pub fn with_keys(mut self, keys: Arc<dyn KeySource>) -> Self {
        self.keys = Some(keys);
        self
    }

    /// Asks Binance about the key `creds` holds, signed with it: whose it is
    /// (its UID), that it reaches the futures account, and - for a live key -
    /// that it's trade-only ([`auth::check_trade_only`]). Onboarding stores a
    /// key only after this passes. Read-only requests, all of them.
    pub async fn check_key(
        &self,
        creds: &auth::ApiCredentials,
        demo: bool,
    ) -> Result<KeyCheck, VenueError> {
        let (futures, spot) = if demo {
            let none = || VenueError::Unsupported("Demo Trading on this network");
            (
                self.demo.as_ref().ok_or_else(none)?,
                self.demo_spot.as_ref().ok_or_else(none)?,
            )
        } else {
            (&self.rest, &self.spot)
        };
        let none: &[(&str, String)] = &[];
        let uid: auth::AccountUid = spot
            .signed_get(
                "/api/v3/account",
                &[("omitZeroBalances", "true".to_owned())],
                creds,
            )
            .await?;
        let key = if demo {
            auth::demo_key(uid.uid)
        } else {
            let restrictions: auth::ApiRestrictions = spot
                .signed_get("/sapi/v1/account/apiRestrictions", none, creds)
                .await?;
            auth::check_trade_only(&restrictions, uid.uid)?
        };
        let config: account::AccountConfig = futures
            .signed_get("/fapi/v1/accountConfig", none, creds)
            .await?;
        Ok(KeyCheck {
            key,
            hedge_mode: config.dual_side_position,
        })
    }

    /// The futures host for account `id`: Demo Trading's for a demo account.
    fn rest_for(&self, id: &str) -> Result<&Rest, VenueError> {
        if auth::parse_account(id)?.0 {
            self.demo
                .as_ref()
                .ok_or(VenueError::Unsupported("Demo Trading on this network"))
        } else {
            Ok(&self.rest)
        }
    }

    /// The host and stored key for reading account `id`'s own data.
    async fn reader(&self, id: &str) -> Result<(&Rest, auth::ApiCredentials), VenueError> {
        let rest = self.rest_for(id)?;
        let keys = self
            .keys
            .as_deref()
            .ok_or(VenueError::Unsupported(NO_ACCOUNT_DATA))?;
        let stored = keys.key(&auth::key_account(id)?).await?;
        Ok((rest, auth::ApiCredentials::from_stored(&stored)?))
    }

    /// The host and stored key for `account`, checking it's this account's
    /// Binance key: a caller can't point an order at another venue's or
    /// account's key.
    async fn trader(
        &self,
        account: &TradingAccount,
    ) -> Result<(&Rest, auth::ApiCredentials), VenueError> {
        if account.key != auth::key_account(&account.address)? {
            return Err(VenueError::InvalidRequest(
                "that key isn't this Binance account's".into(),
            ));
        }
        let rest = self.rest_for(&account.address)?;
        let keys = self
            .keys
            .as_deref()
            .ok_or(VenueError::Unsupported("orders (no key store is set up)"))?;
        let stored = keys.key(&account.key).await?;
        Ok((rest, auth::ApiCredentials::from_stored(&stored)?))
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

    /// Cancels order `id` on `market`, wherever it lives.
    async fn cancel_on(
        rest: &Rest,
        creds: &auth::ApiCredentials,
        market: &str,
        id: &str,
    ) -> Result<(), VenueError> {
        let (algo, params) = orders::cancel(market, id)?;
        let path = if algo {
            "/fapi/v1/algoOrder"
        } else {
            "/fapi/v1/order"
        };
        let _: Value = rest.signed(Method::DELETE, path, &params, creds).await?;
        Ok(())
    }
}

#[async_trait]
impl ExchangeAdapter for BinanceAdapter {
    fn venue(&self) -> VenueId {
        VenueId::Binance
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
        let depth = self.rest.depth(market, BOOK_SNAPSHOT).await?;
        let mut book = book::Book::default();
        book.reset(&depth);
        Ok(book.snapshot(market, BOOK_DEPTH))
    }

    /// The diff stream, then a REST snapshot to apply it to (the diffs that
    /// came in meanwhile are queued), kept locally and sent whole - the top
    /// levels - at most every `BOOK_EVERY`.
    async fn subscribe_order_book(
        &self,
        market: &str,
    ) -> Result<mpsc::Receiver<OrderBook>, VenueError> {
        wire::validate_market(market)?;
        let diffs = ws::subscribe(
            self.endpoints.ws_public,
            vec![format!("{}@depth@100ms", wire::stream_name(market))],
            |push| match serde_json::from_value::<wire::DepthDiff>(push.data) {
                Ok(diff) => Handled::Emit(diff),
                Err(_) => Handled::Ignore,
            },
        )
        .await?;
        let depth = self.rest.depth(market, BOOK_SNAPSHOT).await?;
        let mut book = book::Book::default();
        book.reset(&depth);
        let first = book.snapshot(market, BOOK_DEPTH);
        let (tx, rx) = mpsc::channel(4);
        tokio::spawn(keep_book(
            self.rest.clone(),
            market.to_owned(),
            book,
            diffs,
            tx,
        ));
        Ok(with_first(first, rx))
    }

    /// Recent aggregate trades over REST start the tape; the `@aggTrade`
    /// stream adds each print after that. Both number them alike, so a
    /// print the two share is kept once.
    async fn subscribe_trades(
        &self,
        market: &str,
    ) -> Result<mpsc::Receiver<Vec<Trade>>, VenueError> {
        wire::validate_market(market)?;
        let recent: Vec<wire::AggTrade> = self
            .rest
            .get(
                "/fapi/v1/aggTrades",
                &[
                    ("symbol", market.to_owned()),
                    ("limit", TRADE_HISTORY.to_string()),
                ],
            )
            .await?;
        let mut tape = Tape::default();
        tape.record(recent.into_iter().map(|t| wire::trade(market, t)).collect());
        let first = tape.snapshot();

        let id = market.to_owned();
        let live = ws::subscribe(
            self.endpoints.ws_market,
            vec![format!("{}@aggTrade", wire::stream_name(market))],
            move |push| {
                let Ok(t) = serde_json::from_value::<wire::AggTrade>(push.data) else {
                    return Handled::Ignore;
                };
                if tape.record(vec![wire::trade(&id, t)]) {
                    Handled::Emit(tape.snapshot())
                } else {
                    Handled::Ignore
                }
            },
        )
        .await?;
        Ok(with_first(first, live))
    }

    /// Seeded over REST, then the 24h ticker and the mark (each emits) on
    /// the `/market` route and the best bid and ask (kept for the mid) on
    /// `/public`. Open interest has no stream, so it's refetched every
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
        let missing = || VenueError::Network(format!("Binance sent no data for {market:?}"));
        let mut ticker = tickers.into_iter().next().ok_or_else(missing)?;
        let mut mark = marks.into_iter().next().ok_or_else(missing)?;
        let mut mid = wire::BookTicker::from(book).mid();
        let mut oi = oi;
        let interval = wire::funding_interval_secs(&intervals, market);
        let first = wire::market_stats(&ticker, &mark, mid, oi, interval, scale, now_ms());

        let name = wire::stream_name(market);
        let mut updates = ws::subscribe(
            self.endpoints.ws_market,
            vec![format!("{name}@ticker"), format!("{name}@markPrice@1s")],
            |push| {
                if push.stream.ends_with("@ticker") {
                    match wire::tickers_from_stream(push.data).map(|t| t.into_iter().next()) {
                        Ok(Some(t)) => Handled::Emit(StatsUpdate::Ticker(t)),
                        _ => Handled::Ignore,
                    }
                } else if push.stream.ends_with("@markPrice@1s") {
                    match Mark::from_stream(push.data).map(|m| m.into_iter().next()) {
                        Ok(Some(m)) => Handled::Emit(StatsUpdate::Mark(m)),
                        _ => Handled::Ignore,
                    }
                } else {
                    Handled::Ignore
                }
            },
        )
        .await?;
        let mut mids = ws::subscribe(
            self.endpoints.ws_public,
            vec![format!("{name}@bookTicker")],
            |push| match serde_json::from_value::<wire::BookTicker>(push.data) {
                Ok(book) => Handled::Emit(book.mid()),
                Err(_) => Handled::Ignore,
            },
        )
        .await?;

        let (tx, rx) = mpsc::channel(16);
        let rest = self.rest.clone();
        let market = market.to_owned();
        tokio::spawn(async move {
            let mut poll = tokio::time::interval(STATS_OI_POLL);
            poll.tick().await;
            loop {
                tokio::select! {
                    _ = tx.closed() => return,
                    update = updates.recv() => match update {
                        Some(StatsUpdate::Ticker(t)) => ticker = t,
                        Some(StatsUpdate::Mark(m)) => mark = m,
                        None => return,
                    },
                    fresh = mids.recv() => match fresh {
                        Some(fresh) => {
                            mid = fresh;
                            continue;
                        }
                        None => return,
                    },
                    _ = poll.tick() => {
                        if let Ok(fresh) = rest.open_interest(&market).await {
                            oi = fresh;
                        }
                        continue;
                    }
                }
                let stats = wire::market_stats(&ticker, &mark, mid, oi, interval, scale, now_ms());
                match tx.try_send(stats) {
                    Ok(()) | Err(TrySendError::Full(_)) => {}
                    Err(TrySendError::Closed(_)) => return,
                }
            }
        });
        Ok(with_first(first, rx))
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
            self.endpoints.ws_market,
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
        let live_rx = ws::subscribe(self.endpoints.ws_market, streams, move |push| {
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

    /// The `!forceOrder@arr` stream: each market's latest liquidation, at
    /// most one a second per market (Binance's own throttle).
    async fn subscribe_liquidations(&self) -> Result<mpsc::Receiver<Vec<Liquidation>>, VenueError> {
        ws::subscribe(
            self.endpoints.ws_market,
            vec!["!forceOrder@arr".to_owned()],
            |push| match serde_json::from_value::<wire::ForceOrder>(push.data)
                .ok()
                .and_then(wire::liquidation)
            {
                Some(l) => Handled::Emit(vec![l]),
                None => Handled::Ignore,
            },
        )
        .await
    }

    /// Hourly, as far back as Binance serves (30 days), oldest first.
    async fn open_interest_history(
        &self,
        market: &str,
        hours: u32,
    ) -> Result<Vec<OpenInterestPoint>, VenueError> {
        wire::validate_market(market)?;
        let rows: Vec<wire::OpenInterestRow> = self
            .rest
            .get(
                "/futures/data/openInterestHist",
                &[
                    ("symbol", market.to_owned()),
                    ("period", "1h".to_owned()),
                    ("limit", hours.clamp(1, POSITIONING_PAGE).to_string()),
                ],
            )
            .await?;
        let mut points: Vec<OpenInterestPoint> =
            rows.into_iter().map(wire::open_interest_point).collect();
        points.sort_by_key(|p| p.time);
        Ok(points)
    }

    async fn long_short_ratio(
        &self,
        market: &str,
        hours: u32,
    ) -> Result<Vec<LongShortPoint>, VenueError> {
        wire::validate_market(market)?;
        let rows: Vec<wire::LongShortRow> = self
            .rest
            .get(
                "/futures/data/globalLongShortAccountRatio",
                &[
                    ("symbol", market.to_owned()),
                    ("period", "1h".to_owned()),
                    ("limit", hours.clamp(1, POSITIONING_PAGE).to_string()),
                ],
            )
            .await?;
        let mut points: Vec<LongShortPoint> =
            rows.into_iter().map(wire::long_short_point).collect();
        points.sort_by_key(|p| p.time);
        Ok(points)
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

    /// `address` is the Binance account whose API key is stored: its UID,
    /// or `demo:` and the UID for a Demo Trading account (read from the
    /// demo host).
    async fn account(&self, address: &str) -> Result<AccountSnapshot, VenueError> {
        let (rest, creds) = self.reader(address).await?;
        rest.account(&creds, address).await
    }

    /// Polled: a snapshot every `ACCOUNT_EVERY`, the key read from the store
    /// for each and held only while its requests are signed. A failed poll
    /// keeps the last one on screen and tries again.
    async fn subscribe_account(
        &self,
        address: &str,
    ) -> Result<mpsc::Receiver<AccountSnapshot>, VenueError> {
        let keys = self
            .keys
            .clone()
            .ok_or(VenueError::Unsupported(NO_ACCOUNT_DATA))?;
        let rest = self.rest_for(address)?.clone();
        let entry = auth::key_account(address)?;
        let first = self.account(address).await?;
        let (tx, rx) = mpsc::channel(4);
        let id = address.to_owned();
        tokio::spawn(async move {
            loop {
                tokio::select! {
                    _ = tx.closed() => return,
                    _ = tokio::time::sleep(ACCOUNT_EVERY) => {}
                }
                let next = async {
                    let stored = keys.key(&entry).await?;
                    let creds = auth::ApiCredentials::from_stored(&stored)?;
                    drop(stored);
                    rest.account(&creds, &id).await
                };
                if let Ok(next) = next.await {
                    if tx.send(next).await.is_err() {
                        return;
                    }
                }
            }
        });
        Ok(with_first(first, rx))
    }

    /// The last week's fills, on the markets the account's fee records name.
    async fn fills(&self, address: &str) -> Result<Vec<Fill>, VenueError> {
        let (rest, creds) = self.reader(address).await?;
        let to = now_ms();
        let from = to.saturating_sub(WEEK_MS);
        let markets = rest.traded_markets(&creds, from, to).await?;
        let mut trades = rest.trades(&creds, &markets, from, to).await?;
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
        let (rest, creds) = self.reader(address).await?;
        let to = now_ms();
        let from = start_time.max(to.saturating_sub(HISTORY_WEEKS * WEEK_MS));
        let markets = rest.traded_markets(&creds, from, to).await?;
        let trades = rest.trades(&creds, &markets, from, to).await?;
        Ok(history::closed_trades(trades))
    }

    /// The last week's orders, on the markets the account traded (Binance
    /// lists orders a market at a time). Conditional orders that never
    /// triggered aren't among them.
    async fn order_history(&self, address: &str) -> Result<Vec<Order>, VenueError> {
        let (rest, creds) = self.reader(address).await?;
        let to = now_ms();
        let from = to.saturating_sub(WEEK_MS);
        let markets = rest.traded_markets(&creds, from, to).await?;
        let mut orders = Vec::new();
        for market in &markets {
            let rows: Vec<history::WireHistoricalOrder> = rest
                .signed_get(
                    "/fapi/v1/allOrders",
                    &[
                        ("symbol", market.clone()),
                        ("startTime", from.to_string()),
                        ("limit", HISTORY_PAGE.to_owned()),
                    ],
                    &creds,
                )
                .await?;
            orders.extend(rows.into_iter().filter_map(history::historical_order));
        }
        orders.sort_by_key(|o| std::cmp::Reverse(o.created_at));
        Ok(orders)
    }

    async fn funding_payments(
        &self,
        address: &str,
        start_time: u64,
    ) -> Result<Vec<FundingPayment>, VenueError> {
        let (rest, creds) = self.reader(address).await?;
        let incomes: Vec<history::WireIncome> = rest
            .signed_get(
                "/fapi/v1/income",
                &[
                    ("incomeType", "FUNDING_FEE".to_owned()),
                    ("startTime", start_time.to_string()),
                    ("limit", HISTORY_PAGE.to_owned()),
                ],
                &creds,
            )
            .await?;
        let mut payments: Vec<FundingPayment> = incomes
            .into_iter()
            .filter_map(history::funding_payment)
            .collect();
        payments.sort_by_key(|p| std::cmp::Reverse(p.time));
        Ok(payments)
    }

    /// The account's margin mode and leverage on `market`, and its own
    /// highest leverage there (from its brackets, not the public figure).
    async fn trade_settings(
        &self,
        address: &str,
        market: &str,
    ) -> Result<TradeSettings, VenueError> {
        wire::validate_market(market)?;
        let (rest, creds) = self.reader(address).await?;
        let symbol = [("symbol", market.to_owned())];
        let (rows, max) = tokio::try_join!(
            rest.signed_get::<Vec<account::SymbolConfig>>("/fapi/v1/symbolConfig", &symbol, &creds),
            rest.max_leverage(&creds, market),
        )?;
        let row = rows.iter().find(|r| r.symbol == market).ok_or_else(|| {
            VenueError::Network("Binance sent no settings for this market".into())
        })?;
        Ok(history::trade_settings(row, max))
    }

    /// Places `request` for `account` (its UID, or `demo:` and the UID).
    /// Checked against the market's grid and priced off its touch on the
    /// account's own host before anything is signed; see `orders::create`.
    async fn place_order(
        &self,
        account: &TradingAccount,
        request: &OrderRequest,
    ) -> Result<Order, VenueError> {
        wire::validate_market(&request.market)?;
        let rest = self.rest_for(&account.address)?;
        // The market's grid and price where the order trades, now.
        let (grid, quote) =
            tokio::try_join!(rest.grid(&request.market), rest.quote(&request.market))?;
        let new = orders::create(request, grid, quote)?;
        let (rest, creds) = self.trader(account).await?;
        let (id, status, filled_size) = match &new {
            orders::NewOrder::Order(params) => {
                let placed: orders::Placed = rest
                    .signed(Method::POST, "/fapi/v1/order", params, &creds)
                    .await?;
                let (status, filled) = match placed.outcome()? {
                    orders::Outcome::Open => (OrderStatus::Open, Decimal::default()),
                    orders::Outcome::Filled(size) => (OrderStatus::Filled, size),
                };
                (placed.order_id.to_string(), status, filled)
            }
            orders::NewOrder::Algo(params) => {
                let placed: orders::AlgoPlaced = rest
                    .signed(Method::POST, "/fapi/v1/algoOrder", params, &creds)
                    .await?;
                (
                    format!("{}{}", account::ALGO_PREFIX, placed.algo_id),
                    OrderStatus::Open,
                    Decimal::default(),
                )
            }
        };
        drop(creds);
        let trigger = matches!(request.kind, OrderKind::Trigger { .. });
        Ok(Order {
            venue: VenueId::Binance,
            id,
            client_id: request.client_id.clone(),
            market: request.market.clone(),
            side: request.side,
            order_type: request.kind.order_type(),
            size: request.size,
            filled_size,
            price: match request.kind {
                OrderKind::Limit { price, .. } => Some(price),
                OrderKind::Trigger { limit_price, .. } => limit_price,
                // A TWAP was refused before anything was sent.
                OrderKind::Market { .. } | OrderKind::Twap { .. } => None,
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

    /// An ordinary order at the order endpoint, a conditional one
    /// (`algo:<id>`) at the Algo Service's.
    async fn cancel_order(
        &self,
        account: &TradingAccount,
        market: &str,
        order_id: &str,
    ) -> Result<(), VenueError> {
        wire::validate_market(market)?;
        orders::cancel(market, order_id)?;
        let (rest, creds) = self.trader(account).await?;
        Self::cancel_on(rest, &creds, market, order_id).await
    }

    /// A limit order's price and size (Binance changes nothing else, and no
    /// conditional order before it triggers). What isn't given is kept, read
    /// from the order as Binance has it.
    async fn amend_order(
        &self,
        account: &TradingAccount,
        market: &str,
        order_id: &str,
        amend: &OrderAmend,
    ) -> Result<(), VenueError> {
        if amend.take_profit != ExitChange::Keep || amend.stop_loss != ExitChange::Keep {
            return Err(VenueError::Unsupported(
                "a take-profit or stop-loss on a Binance order",
            ));
        }
        if amend.price.is_none() && amend.size.is_none() {
            return Err(VenueError::InvalidRequest(
                "there's nothing to change".into(),
            ));
        }
        wire::validate_market(market)?;
        let lookup = orders::open_order(market, order_id)?;
        let (rest, creds) = self.trader(account).await?;
        let grid = rest.grid(market).await?;
        let current: account::WireOrder = rest
            .signed_get("/fapi/v1/openOrder", &lookup, &creds)
            .await?;
        if current.order_type != "LIMIT" || current.symbol != market {
            return Err(VenueError::InvalidRequest(
                "only a limit order's price and size can be changed on Binance".into(),
            ));
        }
        let side = match current.side.as_str() {
            "BUY" => Side::Buy,
            "SELL" => Side::Sell,
            _ => {
                return Err(VenueError::Network(
                    "Binance sent an order with no side".into(),
                ))
            }
        };
        let params = orders::amend(
            market,
            order_id,
            side,
            amend.size.unwrap_or(current.orig_qty),
            amend.price.unwrap_or(current.price),
            grid,
        )?;
        let _: Value = rest
            .signed(Method::PUT, "/fapi/v1/order", &params, &creds)
            .await?;
        Ok(())
    }

    /// A whole number from 1 to the account's highest on the market.
    async fn set_leverage(
        &self,
        account: &TradingAccount,
        market: &str,
        leverage: Decimal,
    ) -> Result<(), VenueError> {
        wire::validate_market(market)?;
        let (rest, creds) = self.trader(account).await?;
        let max = rest.max_leverage(&creds, market).await?;
        let params = orders::leverage(market, leverage, max)?;
        let _: Value = rest
            .signed(Method::POST, "/fapi/v1/leverage", &params, &creds)
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
        wire::validate_market(market)?;
        let params = orders::margin_type(market, mode);
        let (rest, creds) = self.trader(account).await?;
        let sent: Result<Value, VenueError> = rest
            .signed(Method::POST, "/fapi/v1/marginType", &params, &creds)
            .await;
        match sent {
            Ok(_) => Ok(()),
            Err(VenueError::InvalidRequest(m)) if m == auth::SAME_MARGIN_TYPE => Ok(()),
            Err(e) => Err(e),
        }
    }

    /// Binance's dead-man's switch (`countdownCancelAll`), per market.
    async fn schedule_cancel(
        &self,
        account: &TradingAccount,
        market: &str,
        after_ms: Option<u64>,
    ) -> Result<(), VenueError> {
        wire::validate_market(market)?;
        let params = orders::countdown(market, after_ms)?;
        let (rest, creds) = self.trader(account).await?;
        let _: Value = rest
            .signed(Method::POST, "/fapi/v1/countdownCancelAll", &params, &creds)
            .await?;
        Ok(())
    }

    /// The position's take-profit and stop-loss, as conditional orders that
    /// close it whole at market once the mark reaches them. A new one is
    /// placed before the one it replaces is cancelled, so the position keeps
    /// an exit in between; if Binance won't hold two of a kind, the old one
    /// is cancelled first. Binance's trailing stop moves by a percentage,
    /// not the distance the page gives, so it isn't offered.
    async fn set_position_protection(
        &self,
        account: &TradingAccount,
        market: &str,
        protection: &PositionProtection,
    ) -> Result<(), VenueError> {
        if matches!(protection.trailing_stop, ExitChange::Set(_)) {
            return Err(VenueError::Unsupported("trailing stops on Binance"));
        }
        wire::validate_market(market)?;
        let (rest, creds) = self.trader(account).await?;
        let (grid, quote) = tokio::try_join!(rest.grid(market), rest.quote(market))?;
        let symbol = [("symbol", market.to_owned())];
        let (positions, open) = tokio::try_join!(
            rest.signed_get::<Vec<account::WirePosition>>("/fapi/v3/positionRisk", &symbol, &creds),
            rest.signed_get::<account::AlgoOrders>("/fapi/v1/openAlgoOrders", &symbol, &creds),
        )?;
        let open = open.into_vec();
        let amount = positions
            .iter()
            .find(|p| p.symbol == market && !p.position_amt.0.is_zero())
            .map(|p| p.position_amt.0)
            .ok_or_else(|| {
                VenueError::InvalidRequest("there's no open position on this market".into())
            })?;
        let long = amount > rust_decimal::Decimal::ZERO;
        let old = |kind: &str| -> Vec<String> {
            open.iter()
                .filter(|o| o.symbol == market && o.close_position && o.order_type == kind)
                .map(|o| format!("{}{}", account::ALGO_PREFIX, o.algo_id))
                .collect()
        };
        let cancel = |ids: Vec<String>| {
            let creds = &creds;
            async move {
                for id in ids {
                    Self::cancel_on(rest, creds, market, &id).await?;
                }
                Ok::<(), VenueError>(())
            }
        };
        for (change, exit) in [
            (&protection.take_profit, orders::Exit::TakeProfit),
            (&protection.stop_loss, orders::Exit::StopLoss),
        ] {
            let replaced = old(exit.order_type());
            match change {
                ExitChange::Keep => {}
                ExitChange::Remove => cancel(replaced).await?,
                ExitChange::Set(price) => {
                    let params = orders::exit(market, long, exit, *price, grid, quote)?;
                    let placed: Result<Value, VenueError> = rest
                        .signed(Method::POST, "/fapi/v1/algoOrder", &params, &creds)
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
                            let _: Value = rest
                                .signed(Method::POST, "/fapi/v1/algoOrder", &params, &creds)
                                .await?;
                        }
                        Err(e) => return Err(e),
                    }
                }
            }
        }
        // A trailing stop being removed: Binance's own, if one was set there.
        if protection.trailing_stop == ExitChange::Remove {
            let trailing: Vec<String> = open
                .iter()
                .filter(|o| o.symbol == market && o.order_type == "TRAILING_STOP_MARKET")
                .map(|o| format!("{}{}", account::ALGO_PREFIX, o.algo_id))
                .collect();
            cancel(trailing).await?;
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn query_values_are_encoded_before_signing() {
        assert_eq!(encode("BTCUSDT"), "BTCUSDT");
        assert_eq!(encode("0.001"), "0.001");
        assert_eq!(encode("0x00ab-_~"), "0x00ab-_~");
        assert_eq!(
            encode("币安人生USDT"),
            "%E5%B8%81%E5%AE%89%E4%BA%BA%E7%94%9FUSDT"
        );
        // Anything that would change the query's shape is encoded away.
        assert_eq!(encode("1&symbol=ETHUSDT"), "1%26symbol%3DETHUSDT");
    }
}
