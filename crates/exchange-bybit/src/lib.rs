//! Bybit adapter (a centralized exchange: an order book run by Bybit, with
//! accounts held there rather than on a chain). Read-only so far: public
//! market data for its USDT- and USDC-margined perpetuals ("linear" contracts)
//! over the V5 REST API and public WebSocket, none of which needs a key.
//!
//! Market ids are Bybit's symbols (`BTCUSDT`, `BTCPERP` for USDC). Each stream
//! is seeded or checked over REST before subscribing, since one unknown topic
//! fails a whole subscribe request. Dated futures share the "linear" category
//! and are left out: the terminal shows perpetuals only.
//!
//! Account data and orders aren't available yet: Bybit serves them only to
//! requests signed with an API key. Its trade-only key is an API key with
//! contract trading permissions only. [`auth`] signs requests (HMAC over the
//! request) and decides whether a key qualifies; onboarding uses
//! [`BybitAdapter::api_key_info`] to ask Bybit about a key before it's
//! stored - see docs/adr/0001-venues-in-rust.md.

mod account;
pub mod auth;
pub mod constants;
mod orders;
mod tape;
mod wire;
mod ws;

use std::collections::BTreeMap;
use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use async_trait::async_trait;
use pewterdesk_core::{
    AccountSnapshot, Announcement, Candle, CandleInterval, Capabilities, ClosedTrade, Decimal,
    ExchangeAdapter, Fill, FundingPayment, FundingRate, KeySource, MarginMode, Market,
    MarketHistory, MarketStats, MarketSummary, Order, OrderAmend, OrderBook, OrderRequest,
    OrderType, PositionProtection, Trade, TradeSettings, TradingAccount, VenueError, VenueId,
};
use serde::de::DeserializeOwned;
use tokio::sync::mpsc;

use constants::Endpoints;
use tape::Tape;
use wire::{Book, Meta, Page, Ticker};
use ws::Handled;

const REQUEST_TIMEOUT: Duration = Duration::from_secs(10);
/// Levels per side sent to the UI: the whole stream, so the book can be
/// grouped into coarser price steps and still fill its panel.
const BOOK_DEPTH: usize = 1000;
/// The stream depth the book is kept from (Bybit offers 1, 50, 200, 1000
/// for linear contracts; 1000 pushes about every 200ms).
const BOOK_STREAM_DEPTH: u32 = 1000;
/// Announcements read for the News page.
const ANNOUNCEMENTS: u32 = 100;
/// Trades the tape starts with.
const TRADE_HISTORY: u32 = 100;
/// Candles of history sent before live updates.
const CANDLE_HISTORY: u32 = 500;
/// The most candles Bybit returns per request.
const MAX_CANDLE_PAGE: u64 = 1000;
/// Summaries are re-polled this often: one request covers every market.
const SUMMARY_EVERY: Duration = Duration::from_secs(5);
/// Hourly candles fetched per market for screening: 7 days.
const HISTORY_HOURS: u32 = 7 * 24;
/// One market's history per this long, well inside Bybit's public limits.
const HISTORY_PACE: Duration = Duration::from_millis(300);
/// Bybit returns at most this many funding payments per request.
const FUNDING_PAGE: usize = 200;
/// Pages fetched per `funding_history` call at most.
const FUNDING_MAX_PAGES: usize = 10;
/// The account is re-read this often: five signed requests, well inside
/// Bybit's private limits.
const ACCOUNT_EVERY: Duration = Duration::from_secs(5);
/// How long a reading of Bybit's clock is trusted.
const CLOCK_EVERY: Duration = Duration::from_secs(60);
/// The instrument list is paged; this is Bybit's largest page.
const INSTRUMENT_PAGE: u32 = 1000;

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
    /// Bybit's clock minus ours (ms), and when that was measured: signed
    /// requests are stamped by Bybit's clock, re-read every `CLOCK_EVERY`.
    clock: Arc<std::sync::Mutex<Option<(i64, std::time::Instant)>>>,
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
            .query(&[("category", "linear")])
            .query(query)
            .send()
            .await
            .map_err(|e| VenueError::Network(e.without_url().to_string()))?;
        let status = response.status();
        // 403 is how Bybit answers a client over its IP rate limit.
        if matches!(status.as_u16(), 403 | 429) {
            return Err(VenueError::Network(format!("rate limited ({status})")));
        }
        if !status.is_success() {
            return Err(VenueError::Network(format!("Bybit API returned {status}")));
        }
        let reply: wire::Reply = response
            .json()
            .await
            .map_err(|e| VenueError::Network(format!("unexpected Bybit response: {e}")))?;
        wire::result(reply)
    }

    /// Bybit's clock minus ours, re-read every `CLOCK_EVERY`. Bybit refuses
    /// a request stamped outside its window, so signed requests are stamped
    /// by its clock; reading it also opens the connection, so the first
    /// signed request isn't held up by the handshake. Offline, the signed
    /// request would fail anyway; the local clock is the fallback.
    async fn clock_offset(&self) -> i64 {
        if let Some((offset, at)) = *self.clock.lock().unwrap() {
            if at.elapsed() < CLOCK_EVERY {
                return offset;
            }
        }
        match self.server_time().await {
            Ok(server) => {
                let offset = server as i64 - now_ms() as i64;
                *self.clock.lock().unwrap() = Some((offset, std::time::Instant::now()));
                offset
            }
            Err(_) => 0,
        }
    }

    /// A GET on a private endpoint, signed with `creds`. Crate-private, and
    /// the path and every query pair are `'static` - this crate's own
    /// constants - so nothing outside chooses what gets signed or where it
    /// goes. Values are plain ASCII words, so the query needs no encoding
    /// and the string signed is exactly the one sent.
    async fn signed_get<T: DeserializeOwned>(
        &self,
        path: &'static str,
        query: &[(&'static str, &'static str)],
        creds: &auth::ApiCredentials,
    ) -> Result<T, VenueError> {
        let query = query
            .iter()
            .map(|(k, v)| format!("{k}={v}"))
            .collect::<Vec<_>>()
            .join("&");
        let url = if query.is_empty() {
            format!("{}{path}", self.base)
        } else {
            format!("{}{path}?{query}", self.base)
        };
        self.signed(self.http.get(url), &query, creds, false).await
    }

    /// `signed_get` for a query with computed values (timestamps). Every
    /// value must be plain ASCII letters and digits, so it still needs no
    /// encoding and the string signed is exactly the one sent.
    async fn signed_get_values<T: DeserializeOwned>(
        &self,
        path: &'static str,
        query: &[(&'static str, String)],
        creds: &auth::ApiCredentials,
    ) -> Result<T, VenueError> {
        let plain = |v: &String| !v.is_empty() && v.bytes().all(|b| b.is_ascii_alphanumeric());
        if !query.iter().all(|(_, v)| plain(v)) {
            return Err(VenueError::InvalidRequest("unexpected query value".into()));
        }
        let query = query
            .iter()
            .map(|(k, v)| format!("{k}={v}"))
            .collect::<Vec<_>>()
            .join("&");
        let url = format!("{}{path}?{query}", self.base);
        self.signed(self.http.get(url), &query, creds, false).await
    }

    /// A POST to a private endpoint with `body`, signed with `creds`. The
    /// body is one of `orders`' structs, serialized once here: the bytes
    /// signed are the bytes sent. Never retried - a resend could place an
    /// order twice.
    async fn signed_post<T: DeserializeOwned, B: serde::Serialize>(
        &self,
        path: &'static str,
        body: &B,
        creds: &auth::ApiCredentials,
    ) -> Result<T, VenueError> {
        let json = serde_json::to_string(body)
            .map_err(|_| VenueError::InvalidRequest("the order couldn't be encoded".into()))?;
        let request = self
            .http
            .post(format!("{}{path}", self.base))
            .header("Content-Type", "application/json")
            .body(json.clone());
        self.signed(request, &json, creds, true).await
    }

    /// Stamps (by Bybit's clock), signs `payload` and sends `request`.
    /// `writes` marks a request that changes something, whose fate is
    /// unknown if the connection drops mid-way.
    async fn signed<T: DeserializeOwned>(
        &self,
        request: reqwest::RequestBuilder,
        payload: &str,
        creds: &auth::ApiCredentials,
        writes: bool,
    ) -> Result<T, VenueError> {
        let timestamp = (now_ms() as i64 + self.clock_offset().await) as u64;
        let signature = creds.sign(timestamp, auth::RECV_WINDOW, payload);
        let response = request
            .header("X-BAPI-API-KEY", creds.api_key())
            .header("X-BAPI-TIMESTAMP", timestamp.to_string())
            .header("X-BAPI-RECV-WINDOW", auth::RECV_WINDOW.to_string())
            .header("X-BAPI-SIGN", signature)
            .send()
            .await
            .map_err(|e| {
                if writes && !e.is_connect() {
                    VenueError::Network(
                        "the connection dropped after sending; check your open orders before trying again".into(),
                    )
                } else {
                    VenueError::Network(e.without_url().to_string())
                }
            })?;
        let status = response.status();
        if status.as_u16() == 429 {
            return Err(VenueError::Network(format!("rate limited ({status})")));
        }
        // Bybit answers auth failures with a 401, often with an empty body:
        // read the body for its code where there is one.
        let reply: wire::Reply = match response.json().await {
            Ok(reply) => reply,
            Err(_) if status.as_u16() == 401 => {
                return Err(VenueError::InvalidRequest(
                    "Bybit refused the key; check it was made for this account type (live or demo) and hasn't been deleted".into(),
                ));
            }
            Err(_) if !status.is_success() => {
                return Err(VenueError::Network(format!("Bybit API returned {status}")));
            }
            Err(e) => {
                return Err(VenueError::Network(format!(
                    "unexpected Bybit response: {e}"
                )));
            }
        };
        if reply.ret_code != 0 {
            return Err(auth::auth_error(reply.ret_code, reply.ret_msg));
        }
        wire::result(reply)
    }

    /// Bybit's clock, in ms.
    async fn server_time(&self) -> Result<u64, VenueError> {
        #[derive(serde::Deserialize)]
        #[serde(rename_all = "camelCase")]
        struct Time {
            time_nano: String,
        }
        let time: Time = self.get("/v5/market/time", &[]).await?;
        time.time_nano
            .parse::<u128>()
            .map(|ns| (ns / 1_000_000) as u64)
            .map_err(|_| VenueError::Network("unexpected Bybit server time".into()))
    }

    async fn instruments(&self) -> Result<Vec<wire::Instrument>, VenueError> {
        let mut all = Vec::new();
        let mut cursor = String::new();
        loop {
            let mut query = vec![("limit", INSTRUMENT_PAGE.to_string())];
            if !cursor.is_empty() {
                query.push(("cursor", cursor.clone()));
            }
            let page: Page<wire::Instrument> =
                self.get("/v5/market/instruments-info", &query).await?;
            all.extend(page.list);
            match page.next_page_cursor {
                Some(next) if !next.is_empty() && next != cursor => cursor = next,
                _ => return Ok(all),
            }
        }
    }

    /// Every market's ticker, or one market's.
    async fn tickers(&self, market: Option<&str>) -> Result<Vec<Ticker>, VenueError> {
        let query: Vec<(&str, String)> = market
            .map(|m| vec![("symbol", m.to_owned())])
            .unwrap_or_default();
        let page: Page<Ticker> = self.get("/v5/market/tickers", &query).await?;
        Ok(page.list)
    }

    /// Up to `limit` klines at Bybit's `code` opening at or before `end`,
    /// oldest first.
    async fn klines(
        &self,
        market: &str,
        code: &str,
        limit: u64,
        end: Option<u64>,
    ) -> Result<Vec<Candle>, VenueError> {
        let mut query = vec![
            ("symbol", market.to_owned()),
            ("interval", code.to_owned()),
            ("limit", limit.clamp(1, MAX_CANDLE_PAGE).to_string()),
        ];
        if let Some(end) = end {
            query.push(("end", end.to_string()));
        }
        #[derive(serde::Deserialize)]
        struct Rows {
            list: Vec<Vec<String>>,
        }
        let rows: Rows = self.get("/v5/market/kline", &query).await?;
        // Newest first on the wire.
        let mut candles: Vec<Candle> = rows
            .list
            .iter()
            .filter_map(|r| wire::rest_candle(r))
            .collect();
        candles.reverse();
        Ok(candles)
    }

    /// `count` candles at `interval` up to `end`, built from shorter ones
    /// where Bybit has no such width.
    async fn candles(
        &self,
        market: &str,
        interval: CandleInterval,
        count: u32,
        end: Option<u64>,
    ) -> Result<Vec<Candle>, VenueError> {
        let (code, ratio) = wire::interval_code(interval);
        let parts = self
            .klines(market, code, u64::from(count) * ratio, end)
            .await?;
        Ok(if ratio == 1 {
            parts
        } else {
            wire::aggregate(&parts, interval.millis())
        })
    }
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

pub struct BybitAdapter {
    rest: Rest,
    /// Demo Trading's host, for demo accounts' private requests; unset
    /// where the network has none.
    demo: Option<Rest>,
    endpoints: &'static Endpoints,
    /// Live perpetuals and their funding intervals, from the instrument
    /// list: fetched on first use and refreshed whenever `markets` runs.
    meta: tokio::sync::Mutex<Option<Arc<Meta>>>,
    /// Where account reads get the stored API key; see `with_keys`.
    keys: Option<Arc<dyn KeySource>>,
}

impl BybitAdapter {
    /// Talks only to `endpoints`, which are fixed in [`constants`] - never a
    /// URL supplied by a caller.
    pub fn new(endpoints: &'static Endpoints) -> Result<Self, VenueError> {
        // Gzip: the instrument list and all-market tickers are most of a
        // megabyte as plain JSON, a tenth of that compressed.
        let http = reqwest::Client::builder()
            .timeout(REQUEST_TIMEOUT)
            .gzip(true)
            .build()
            .map_err(|e| VenueError::Network(e.to_string()))?;
        Ok(Self {
            demo: endpoints.demo_rest.map(|base| Rest {
                http: http.clone(),
                base,
                clock: Arc::default(),
            }),
            rest: Rest {
                http,
                base: endpoints.rest,
                clock: Arc::default(),
            },
            endpoints,
            meta: tokio::sync::Mutex::new(None),
            keys: None,
        })
    }

    /// What Bybit says about the key `creds` holds: its account, its
    /// permissions and IP binding. Onboarding checks it with
    /// [`auth::check_trade_only`] before the key is stored.
    pub async fn api_key_info(
        &self,
        creds: &auth::ApiCredentials,
        demo: bool,
    ) -> Result<auth::ApiKeyInfo, VenueError> {
        self.private(demo)?
            .signed_get("/v5/user/query-api", &[], creds)
            .await
    }

    /// The host private requests go to: Demo Trading's for demo accounts.
    fn private(&self, demo: bool) -> Result<&Rest, VenueError> {
        if demo {
            self.demo
                .as_ref()
                .ok_or(VenueError::Unsupported("demo accounts on this network"))
        } else {
            Ok(&self.rest)
        }
    }

    /// The host for account `id` (`demo:` in front for a demo account).
    fn rest_for(&self, id: &str) -> Result<&Rest, VenueError> {
        self.private(auth::parse_account(id)?.0)
    }

    /// The host and stored key for reading account `id`'s own data.
    async fn reader(&self, id: &str) -> Result<(&Rest, auth::ApiCredentials), VenueError> {
        let rest = self.rest_for(id)?;
        let keys = self
            .keys
            .as_deref()
            .ok_or(VenueError::Unsupported(NO_ACCOUNT_DATA))?;
        let stored = keys
            .key(&auth::key_account(id)?)
            .await
            .map_err(VenueError::Key)?;
        Ok((rest, auth::ApiCredentials::from_stored(&stored)?))
    }

    /// The stored key for `account`, checking it's this account's Bybit key:
    /// a caller can't point an order at another venue's or account's key.
    async fn trading_creds(
        &self,
        account: &TradingAccount,
    ) -> Result<auth::ApiCredentials, VenueError> {
        if account.key != auth::key_account(&account.address)? {
            return Err(VenueError::InvalidRequest(
                "that key isn't this Bybit account's".into(),
            ));
        }
        let keys = self
            .keys
            .as_deref()
            .ok_or(VenueError::Unsupported(NO_ACCOUNT_DATA))?;
        let stored = keys.key(&account.key).await.map_err(VenueError::Key)?;
        auth::ApiCredentials::from_stored(&stored)
    }

    /// The touch and last trade for `market`, to price a market order's
    /// bound and orient a trigger. From the live host: demo trades on live
    /// prices.
    async fn quote(&self, market: &str) -> Result<orders::Quote, VenueError> {
        let ticker = self
            .rest
            .tickers(Some(market))
            .await?
            .into_iter()
            .next()
            .ok_or_else(|| VenueError::InvalidRequest(format!("no price for {market}")))?;
        let price = |s: &Option<String>| {
            s.as_deref()
                .and_then(|v| v.parse::<rust_decimal::Decimal>().ok())
                .map(pewterdesk_core::Decimal)
                .unwrap_or_default()
        };
        Ok(orders::Quote {
            bid: price(&ticker.bid1_price),
            ask: price(&ticker.ask1_price),
            last: price(&ticker.last_price),
        })
    }

    /// Adds the app's `KeySource`, which account reads take the stored API
    /// key from. Without one, account data is `Unsupported`.
    pub fn with_keys(mut self, keys: Arc<dyn KeySource>) -> Self {
        self.keys = Some(keys);
        self
    }

    async fn meta(&self) -> Result<Arc<Meta>, VenueError> {
        let mut meta = self.meta.lock().await;
        if let Some(meta) = meta.as_ref() {
            return Ok(Arc::clone(meta));
        }
        let fresh = Arc::new(Meta::new(&self.rest.instruments().await?));
        *meta = Some(Arc::clone(&fresh));
        Ok(fresh)
    }

    /// Checks `market` is a live perpetual before a stream subscribes to it.
    async fn live_market(&self, market: &str) -> Result<Arc<Meta>, VenueError> {
        wire::validate_market(market)?;
        let meta = self.meta().await?;
        if meta.is_live(market) {
            Ok(meta)
        } else {
            Err(VenueError::InvalidRequest(format!(
                "{market:?} isn't a live Bybit perpetual"
            )))
        }
    }
}

const NO_ACCOUNT_DATA: &str = "Bybit account data without a key store";

/// Reads account `uid`: its stored key from `keys`, held only while these
/// requests are signed, then the balance and, per settle coin, positions
/// and open orders. Read-only: nothing here places, moves or changes
/// anything.
async fn fetch_account(
    rest: &Rest,
    keys: &dyn KeySource,
    uid: &str,
) -> Result<AccountSnapshot, VenueError> {
    let stored = keys
        .key(&auth::key_account(uid)?)
        .await
        .map_err(VenueError::Key)?;
    let creds = auth::ApiCredentials::from_stored(&stored)?;
    drop(stored);
    let wallet: account::List<account::Wallet> = rest
        .signed_get(
            "/v5/account/wallet-balance",
            &[("accountType", "UNIFIED")],
            &creds,
        )
        .await?;
    let mut positions = Vec::new();
    let mut orders = Vec::new();
    for coin in account::SETTLE_COINS {
        let page: account::List<account::WirePosition> = rest
            .signed_get(
                "/v5/position/list",
                &[("category", "linear"), ("settleCoin", coin)],
                &creds,
            )
            .await?;
        positions.extend(page.list);
        let page: account::List<account::WireOrder> = rest
            .signed_get(
                "/v5/order/realtime",
                &[("category", "linear"), ("settleCoin", coin)],
                &creds,
            )
            .await?;
        orders.extend(page.list);
    }
    // Account-wide on a unified account, so it's the same for each position.
    // A failed read leaves it unsaid rather than failing the snapshot.
    let margin_mode = rest
        .signed_get::<account::AccountInfo>("/v5/account/info", &[], &creds)
        .await
        .ok()
        .map(|info| info.mode());
    Ok(account::snapshot(
        uid,
        wallet.list.into_iter().next(),
        positions,
        orders,
        margin_mode,
        now_ms(),
    ))
}

#[async_trait]
impl ExchangeAdapter for BybitAdapter {
    fn venue(&self) -> VenueId {
        VenueId::Bybit
    }

    fn capabilities(&self) -> Capabilities {
        Capabilities {
            order_book: true,
            order_types: vec![OrderType::Market, OrderType::Limit, OrderType::Trigger],
            isolated_collateral: false,
        }
    }

    async fn markets(&self) -> Result<Vec<Market>, VenueError> {
        let instruments = self.rest.instruments().await?;
        *self.meta.lock().await = Some(Arc::new(Meta::new(&instruments)));
        Ok(instruments
            .iter()
            .filter(|i| i.is_live())
            .map(wire::market)
            .collect())
    }

    async fn order_book(&self, market: &str) -> Result<OrderBook, VenueError> {
        wire::validate_market(market)?;
        #[derive(serde::Deserialize)]
        struct Rest {
            #[serde(flatten)]
            depth: wire::Depth,
            ts: u64,
        }
        let reply: Rest = self
            .rest
            .get(
                "/v5/market/orderbook",
                &[
                    ("symbol", market.to_owned()),
                    ("limit", BOOK_DEPTH.to_string()),
                ],
            )
            .await?;
        let mut book = Book::default();
        book.apply(&reply.depth, true);
        Ok(book.snapshot(market, BOOK_DEPTH, reply.ts))
    }

    /// The REST book, then the depth stream: a snapshot, then deltas kept
    /// in a local book, re-sent whole (the top levels) on each change.
    async fn subscribe_order_book(
        &self,
        market: &str,
    ) -> Result<mpsc::Receiver<OrderBook>, VenueError> {
        let first = self.order_book(market).await?;
        let id = market.to_owned();
        let mut book = Book::default();
        let live = ws::subscribe(
            self.endpoints.ws,
            vec![format!("orderbook.{BOOK_STREAM_DEPTH}.{market}")],
            move |push| {
                let snapshot = push.is_snapshot();
                let time = push.ts.unwrap_or_else(now_ms);
                match serde_json::from_value::<wire::Depth>(push.data) {
                    Ok(depth) => {
                        book.apply(&depth, snapshot);
                        Handled::Emit(book.snapshot(&id, BOOK_DEPTH, time))
                    }
                    Err(_) => Handled::Ignore,
                }
            },
        )
        .await?;
        Ok(with_first(first, live))
    }

    /// Recent trades over REST start the tape; the trade stream adds each
    /// print after that. Block trades aren't on the book, so they're left off.
    async fn subscribe_trades(
        &self,
        market: &str,
    ) -> Result<mpsc::Receiver<Vec<Trade>>, VenueError> {
        self.live_market(market).await?;
        let recent: Page<wire::RestTrade> = self
            .rest
            .get(
                "/v5/market/recent-trade",
                &[
                    ("symbol", market.to_owned()),
                    ("limit", TRADE_HISTORY.to_string()),
                ],
            )
            .await?;
        let mut tape = Tape::default();
        tape.record(
            recent
                .list
                .into_iter()
                .map(|t| {
                    let time = t.time.parse().unwrap_or(0);
                    wire::trade(market, t.exec_id, &t.price, &t.size, &t.side, time)
                })
                .collect(),
        );
        let first = tape.snapshot();

        let id = market.to_owned();
        let live = ws::subscribe(
            self.endpoints.ws,
            vec![format!("publicTrade.{market}")],
            move |push| {
                let Ok(prints) = serde_json::from_value::<Vec<wire::WsTrade>>(push.data) else {
                    return Handled::Ignore;
                };
                let trades: Vec<Trade> = prints
                    .into_iter()
                    .filter(|t| !t.block)
                    .map(|t| wire::trade(&id, t.id, &t.price, &t.size, &t.side, t.time))
                    .collect();
                if tape.record(trades) {
                    Handled::Emit(tape.snapshot())
                } else {
                    Handled::Ignore
                }
            },
        )
        .await?;
        Ok(with_first(first, live))
    }

    /// Seeded over REST, then the ticker stream: a snapshot, then deltas of
    /// just the fields that changed, merged into the last full ticker. It
    /// carries everything, open interest and the best bid and ask included.
    async fn subscribe_market_stats(
        &self,
        market: &str,
    ) -> Result<mpsc::Receiver<MarketStats>, VenueError> {
        let meta = self.live_market(market).await?;
        let funding = meta.funding(market);
        let mut ticker = self
            .rest
            .tickers(Some(market))
            .await?
            .into_iter()
            .next()
            .ok_or_else(|| VenueError::Network(format!("Bybit sent no ticker for {market:?}")))?;
        let first = wire::market_stats(&ticker, funding, now_ms());
        let live = ws::subscribe(
            self.endpoints.ws,
            vec![format!("tickers.{market}")],
            move |push| {
                let snapshot = push.is_snapshot();
                let Some(fresh) = wire::ticker(push.data) else {
                    return Handled::Ignore;
                };
                if snapshot {
                    ticker = fresh;
                } else {
                    ticker.merge(fresh);
                }
                Handled::Emit(wire::market_stats(&ticker, funding, now_ms()))
            },
        )
        .await?;
        Ok(with_first(first, live))
    }

    /// History over REST, then the kline stream, which re-sends the forming
    /// candle whole as it changes. 8-hour and 3-day candles are built from
    /// 4-hour and daily ones, kept here so each update re-emits its group.
    async fn subscribe_candles(
        &self,
        market: &str,
        interval: CandleInterval,
    ) -> Result<mpsc::Receiver<Vec<Candle>>, VenueError> {
        self.live_market(market).await?;
        let (code, ratio) = wire::interval_code(interval);
        let parts = self
            .rest
            .klines(market, code, u64::from(CANDLE_HISTORY) * ratio, None)
            .await?;
        let history = if ratio == 1 {
            parts.clone()
        } else {
            wire::aggregate(&parts, interval.millis())
        };
        let width = interval.millis();
        // The shorter candles the newest groups are built from.
        let mut recent: BTreeMap<u64, Candle> = parts
            .into_iter()
            .rev()
            .take(2 * ratio as usize)
            .map(|c| (c.open_time, c))
            .collect();
        let live = ws::subscribe(
            self.endpoints.ws,
            vec![format!("kline.{code}.{market}")],
            move |push| {
                let Ok(klines) = serde_json::from_value::<Vec<wire::WsKline>>(push.data) else {
                    return Handled::Ignore;
                };
                let mut out = Vec::new();
                for k in klines.iter().filter(|k| k.interval == code) {
                    let part = Candle::from(k);
                    if ratio == 1 {
                        out.push(part);
                        continue;
                    }
                    let at = part.open_time;
                    recent.insert(at, part);
                    while recent.len() > 2 * ratio as usize {
                        recent.pop_first();
                    }
                    if let Some(group) = wire::aggregate_at(&recent, width, at) {
                        out.push(group);
                    }
                }
                if out.is_empty() {
                    Handled::Ignore
                } else {
                    Handled::Emit(out)
                }
            },
        )
        .await?;
        Ok(with_first(history, live))
    }

    /// Every live market's summary: one REST request covers them all (open
    /// interest and funding included), re-polled every `SUMMARY_EVERY`.
    /// Markets listed after subscribing appear on the next subscribe.
    async fn subscribe_market_summaries(
        &self,
    ) -> Result<mpsc::Receiver<Vec<MarketSummary>>, VenueError> {
        let meta = self.meta().await?;
        let first = wire::market_summaries(self.rest.tickers(None).await?, &meta);
        let (tx, rx) = mpsc::channel(4);
        let rest = self.rest.clone();
        tokio::spawn(async move {
            if tx.send(first).await.is_err() {
                return;
            }
            loop {
                tokio::select! {
                    _ = tx.closed() => return,
                    _ = tokio::time::sleep(SUMMARY_EVERY) => {}
                }
                // A failed poll keeps the last summaries; the next one retries.
                let Ok(tickers) = rest.tickers(None).await else {
                    continue;
                };
                if tx
                    .send(wire::market_summaries(tickers, &meta))
                    .await
                    .is_err()
                {
                    return;
                }
            }
        });
        Ok(rx)
    }

    /// Walks the markets busiest first, one market's hourly candles every
    /// `HISTORY_PACE`, then starts over with a fresh volume ranking. A market
    /// whose fetch fails is skipped until the next pass.
    async fn subscribe_market_history(&self) -> Result<mpsc::Receiver<MarketHistory>, VenueError> {
        let meta = self.meta().await?;
        let rest = self.rest.clone();
        let mut order = wire::by_volume(&rest.tickers(None).await?, &meta);

        let (tx, rx) = mpsc::channel(8);
        tokio::spawn(async move {
            loop {
                for market in &order {
                    tokio::select! {
                        _ = tx.closed() => return,
                        _ = tokio::time::sleep(HISTORY_PACE) => {}
                    }
                    let Ok(candles) = rest
                        .candles(market, CandleInterval::OneHour, HISTORY_HOURS, None)
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
                if let Ok(tickers) = rest.tickers(None).await {
                    order = wire::by_volume(&tickers, &meta);
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
            .candles(market, interval, count, Some(before - 1))
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
        // Bybit pages backwards from `endTime`, newest first, so walk back
        // from now until a page reaches `start_time` or comes back short.
        let mut rates = Vec::new();
        let mut end = now_ms();
        for _ in 0..FUNDING_MAX_PAGES {
            let page: Page<wire::FundingEntry> = self
                .rest
                .get(
                    "/v5/market/funding/history",
                    &[
                        ("symbol", market.to_owned()),
                        ("endTime", end.to_string()),
                        ("limit", FUNDING_PAGE.to_string()),
                    ],
                )
                .await?;
            let full = page.list.len() >= FUNDING_PAGE;
            let batch: Vec<FundingRate> = page.list.iter().filter_map(wire::funding_rate).collect();
            let Some(oldest) = batch.iter().map(|r| r.time).min() else {
                break;
            };
            rates.extend(batch);
            if !full || oldest <= start_time {
                break;
            }
            end = oldest - 1;
        }
        rates.retain(|r| r.time >= start_time);
        rates.sort_by_key(|r| r.time);
        rates.dedup_by_key(|r| r.time);
        Ok(rates)
    }

    /// `address` is the Bybit account whose API key is stored: its UID, or
    /// `demo:` and the UID for a demo account (read from the demo host).
    async fn account(&self, address: &str) -> Result<AccountSnapshot, VenueError> {
        let keys = self
            .keys
            .as_deref()
            .ok_or(VenueError::Unsupported(NO_ACCOUNT_DATA))?;
        fetch_account(self.rest_for(address)?, keys, address).await
    }

    /// Polled: a snapshot every `ACCOUNT_EVERY`. A failed poll keeps the
    /// last snapshot rather than ending the stream.
    async fn subscribe_account(
        &self,
        address: &str,
    ) -> Result<mpsc::Receiver<AccountSnapshot>, VenueError> {
        let keys = self
            .keys
            .clone()
            .ok_or(VenueError::Unsupported(NO_ACCOUNT_DATA))?;
        let rest = self.rest_for(address)?.clone();
        let first = fetch_account(&rest, keys.as_ref(), address).await?;
        let (tx, rx) = mpsc::channel(4);
        let uid = address.to_owned();
        tokio::spawn(async move {
            loop {
                tokio::select! {
                    _ = tx.closed() => return,
                    _ = tokio::time::sleep(ACCOUNT_EVERY) => {}
                }
                if let Ok(next) = fetch_account(&rest, keys.as_ref(), &uid).await {
                    if tx.send(next).await.is_err() {
                        return;
                    }
                }
            }
        });
        Ok(with_first(first, rx))
    }

    /// The account's latest fills (up to 100, newest first), from the last
    /// seven days Bybit serves by default.
    async fn fills(&self, address: &str) -> Result<Vec<Fill>, VenueError> {
        let (rest, creds) = self.reader(address).await?;
        let page: account::List<account::WireExecution> = rest
            .signed_get(
                "/v5/execution/list",
                &[("category", "linear"), ("limit", "100")],
                &creds,
            )
            .await?;
        Ok(page.list.into_iter().filter_map(account::fill).collect())
    }

    /// Funding settled on the account's positions since `start_time`, newest
    /// first. Bybit's log serves at most seven days per request, so this
    /// walks back a week at a time (five weeks at most).
    async fn funding_payments(
        &self,
        address: &str,
        start_time: u64,
    ) -> Result<Vec<FundingPayment>, VenueError> {
        const WEEK: u64 = 7 * 24 * 3_600_000;
        let (rest, creds) = self.reader(address).await?;
        let mut paid = Vec::new();
        let mut end = now_ms();
        for _ in 0..5 {
            if end <= start_time {
                break;
            }
            let start = start_time.max(end.saturating_sub(WEEK - 1));
            let page: account::List<account::WireSettlement> = rest
                .signed_get_values(
                    "/v5/account/transaction-log",
                    &[
                        ("accountType", "UNIFIED".into()),
                        ("category", "linear".into()),
                        ("type", "SETTLEMENT".into()),
                        ("startTime", start.to_string()),
                        ("endTime", end.to_string()),
                        ("limit", "50".into()),
                    ],
                    &creds,
                )
                .await?;
            paid.extend(page.list.into_iter().filter_map(account::funding));
            end = start.saturating_sub(1);
        }
        paid.sort_by_key(|p| std::cmp::Reverse(p.time));
        Ok(paid)
    }

    /// The account's recently closed positions (up to 100, newest first),
    /// from the last seven days Bybit serves by default.
    async fn closed_trades(&self, address: &str) -> Result<Vec<ClosedTrade>, VenueError> {
        let (rest, creds) = self.reader(address).await?;
        let page: account::List<account::WireClosed> = rest
            .signed_get(
                "/v5/position/closed-pnl",
                &[("category", "linear"), ("limit", "100")],
                &creds,
            )
            .await?;
        Ok(page.list.into_iter().filter_map(account::closed).collect())
    }

    /// The account's recent orders in any state (up to 50 per settle coin,
    /// newest first), from the last seven days Bybit serves by default.
    async fn order_history(&self, address: &str) -> Result<Vec<Order>, VenueError> {
        let (rest, creds) = self.reader(address).await?;
        let mut orders = Vec::new();
        for coin in account::SETTLE_COINS {
            let page: account::List<account::WireOrder> = rest
                .signed_get(
                    "/v5/order/history",
                    &[
                        ("category", "linear"),
                        ("settleCoin", coin),
                        ("limit", "50"),
                    ],
                    &creds,
                )
                .await?;
            orders.extend(page.list.into_iter().filter_map(account::order));
        }
        orders.sort_by_key(|o| std::cmp::Reverse(o.created_at));
        Ok(orders)
    }

    /// Places `request` for `account` (its UID, or `demo:` and the UID).
    /// Checked against the live market list, its tick and step, and the
    /// current price before anything is signed; see `orders::create`.
    /// Resolves once Bybit has accepted it: `Pending` until the account
    /// stream shows it open or filled.
    async fn place_order(
        &self,
        account: &TradingAccount,
        request: &OrderRequest,
    ) -> Result<Order, VenueError> {
        let rest = self.rest_for(&account.address)?;
        let meta = self.live_market(&request.market).await?;
        let (tick, step) = meta.steps(&request.market).ok_or_else(|| {
            VenueError::InvalidRequest(format!("{:?} has no price tick", request.market))
        })?;
        let quote = self.quote(&request.market).await?;
        let body = orders::create(request, tick, step, quote)?;
        let creds = self.trading_creds(account).await?;
        #[derive(serde::Deserialize)]
        #[serde(rename_all = "camelCase")]
        struct Placed {
            order_id: String,
        }
        let placed: Placed = rest.signed_post("/v5/order/create", &body, &creds).await?;
        drop(creds);
        let price = body
            .price()
            .and_then(|p| p.parse::<rust_decimal::Decimal>().ok())
            .map(pewterdesk_core::Decimal);
        Ok(Order {
            venue: VenueId::Bybit,
            id: placed.order_id,
            client_id: request.client_id.clone(),
            market: request.market.clone(),
            side: request.side,
            order_type: request.kind.order_type(),
            size: request.size,
            filled_size: pewterdesk_core::Decimal::default(),
            price: match request.kind {
                pewterdesk_core::OrderKind::Market { .. } => None,
                _ => price,
            },
            trigger_price: match request.kind {
                pewterdesk_core::OrderKind::Trigger { trigger_price, .. } => Some(trigger_price),
                _ => None,
            },
            reduce_only: request.reduce_only,
            status: pewterdesk_core::OrderStatus::Pending,
            created_at: now_ms(),
            category: match request.kind {
                pewterdesk_core::OrderKind::Trigger { .. } => {
                    pewterdesk_core::OrderCategory::Conditional
                }
                _ => pewterdesk_core::OrderCategory::Regular,
            },
            trigger_by: match request.kind {
                pewterdesk_core::OrderKind::Trigger { .. } => {
                    Some(pewterdesk_core::PriceSource::Last)
                }
                _ => None,
            },
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
        let rest = self.rest_for(&account.address)?;
        wire::validate_market(market)?;
        let body = orders::cancel(market, order_id)?;
        let creds = self.trading_creds(account).await?;
        let _: serde_json::Value = rest.signed_post("/v5/order/cancel", &body, &creds).await?;
        Ok(())
    }

    /// Changes an open order on Bybit (`/v5/order/amend`): its price, size,
    /// or attached TP/SL, each checked against the market's tick and step.
    async fn amend_order(
        &self,
        account: &TradingAccount,
        market: &str,
        order_id: &str,
        amend: &OrderAmend,
    ) -> Result<(), VenueError> {
        let rest = self.rest_for(&account.address)?;
        let meta = self.live_market(market).await?;
        let (tick, step) = meta
            .steps(market)
            .ok_or_else(|| VenueError::InvalidRequest(format!("{market:?} has no price tick")))?;
        let body = orders::amend(market, order_id, amend, tick, step)?;
        let creds = self.trading_creds(account).await?;
        let _: serde_json::Value = rest.signed_post("/v5/order/amend", &body, &creds).await?;
        Ok(())
    }

    /// Sets the position's TP, SL and trailing stop on Bybit in one call
    /// (`/v5/position/trading-stop`, `Full` mode: each closes the whole
    /// position). Prices are checked against the market's tick first.
    async fn set_position_protection(
        &self,
        account: &TradingAccount,
        market: &str,
        protection: &PositionProtection,
    ) -> Result<(), VenueError> {
        let rest = self.rest_for(&account.address)?;
        let meta = self.live_market(market).await?;
        let (tick, _) = meta
            .steps(market)
            .ok_or_else(|| VenueError::InvalidRequest(format!("{market:?} has no price tick")))?;
        let body = orders::protection(market, protection, tick)?;
        let creds = self.trading_creds(account).await?;
        match rest
            .signed_post::<serde_json::Value, _>("/v5/position/trading-stop", &body, &creds)
            .await
        {
            // Bybit answers a request that changes nothing with an error.
            Err(VenueError::InvalidRequest(m)) if m.contains("not modified") => Ok(()),
            other => other.map(|_| ()),
        }
    }

    /// Bybit's latest announcements (listings, delistings, maintenance,
    /// news), newest first. Public: no key, and from Bybit's own API host.
    async fn announcements(&self) -> Result<Vec<Announcement>, VenueError> {
        let page: Page<wire::WireAnnouncement> = self
            .rest
            .get(
                "/v5/announcements/index",
                &[
                    ("locale", "en-US".to_owned()),
                    ("limit", ANNOUNCEMENTS.to_string()),
                ],
            )
            .await?;
        let mut out: Vec<Announcement> = page
            .list
            .into_iter()
            .filter_map(wire::announcement)
            .collect();
        out.sort_by_key(|a| std::cmp::Reverse(a.time));
        Ok(out)
    }

    /// The account's margin mode (account-wide on a unified account) and its
    /// leverage on `market`, which Bybit keeps per market even when flat.
    async fn trade_settings(
        &self,
        address: &str,
        market: &str,
    ) -> Result<TradeSettings, VenueError> {
        let meta = self.live_market(market).await?;
        let max_leverage = meta.max_leverage(market).ok_or_else(|| {
            VenueError::InvalidRequest(format!("{market:?} has no leverage limit"))
        })?;
        let (rest, creds) = self.reader(address).await?;
        let info: account::AccountInfo = rest.signed_get("/v5/account/info", &[], &creds).await?;
        let page: account::List<account::WireLeverage> = rest
            .signed_get_values(
                "/v5/position/list",
                &[("category", "linear".into()), ("symbol", market.to_owned())],
                &creds,
            )
            .await?;
        let leverage = page
            .list
            .first()
            .map(|p| wire::decimal(&p.leverage))
            .filter(|l| l.0 > rust_decimal::Decimal::ZERO)
            .ok_or_else(|| VenueError::InvalidRequest(format!("no leverage for {market}")))?;
        Ok(TradeSettings {
            margin_mode: info.mode(),
            margin_mode_account_wide: true,
            leverage,
            max_leverage,
        })
    }

    /// Checked against the live market's maximum before it's signed.
    async fn set_leverage(
        &self,
        account: &TradingAccount,
        market: &str,
        leverage: Decimal,
    ) -> Result<(), VenueError> {
        let rest = self.rest_for(&account.address)?;
        let meta = self.live_market(market).await?;
        let max = meta.max_leverage(market).ok_or_else(|| {
            VenueError::InvalidRequest(format!("{market:?} has no leverage limit"))
        })?;
        let body = orders::leverage(market, leverage, max)?;
        let creds = self.trading_creds(account).await?;
        match rest
            .signed_post::<serde_json::Value, _>("/v5/position/set-leverage", &body, &creds)
            .await
        {
            // Bybit answers a request that changes nothing with an error.
            Err(VenueError::InvalidRequest(m)) if m.contains("not modified") => Ok(()),
            other => other.map(|_| ()),
        }
    }

    /// Account-wide on a unified account: `market` is only checked, not sent.
    async fn set_margin_mode(
        &self,
        account: &TradingAccount,
        market: &str,
        mode: MarginMode,
    ) -> Result<(), VenueError> {
        let rest = self.rest_for(&account.address)?;
        self.live_market(market).await?;
        let body = orders::margin_mode(mode);
        let creds = self.trading_creds(account).await?;
        let result: account::MarginModeResult = rest
            .signed_post("/v5/account/set-margin-mode", &body, &creds)
            .await?;
        if result.reasons.is_empty() {
            Ok(())
        } else {
            let why = result
                .reasons
                .iter()
                .map(|r| r.reason_msg.as_str())
                .filter(|m| !m.is_empty())
                .collect::<Vec<_>>()
                .join("; ");
            Err(VenueError::InvalidRequest(if why.is_empty() {
                "Bybit didn't change the margin mode".into()
            } else {
                why
            }))
        }
    }
}
