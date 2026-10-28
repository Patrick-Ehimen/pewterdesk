//! BloFin adapter: USDT-M (and USDC-M) perpetuals on a centralized exchange
//! (an order book run by BloFin, accounts held there rather than on a
//! chain). Public market data over REST and the public WebSocket, none of
//! which needs a key; an account's state, history and orders, which do.
//!
//! Market ids are BloFin's (`BTC-USDT`); the coin-margined (inverse)
//! perpetuals are left out. BloFin counts sizes in contracts, a market's
//! `contractValue` of the base asset each: [`wire`] turns them into base
//! units on the way in, and an order's size back into a whole number of lots
//! on the way out. Open interest comes from an endpoint BloFin serves but
//! doesn't document (`/api/v1/market/open-interest`), read as a bonus: where
//! it fails, it reads zero. BloFin publishes no open-interest history, long /
//! short ratio or liquidation feed.
//!
//! Only Demo Trading accounts trade. BloFin's API keys can be given READ,
//! TRADE and TRANSFER, and the one request that describes a key says only
//! whether it's read-only, so a live key can't be shown to be trade-only:
//! [`auth::check_live`] refuses it before it's sent anywhere, and the
//! engine's router refuses a live BloFin account. A Demo Trading key reaches
//! demo funds on Demo Trading's own hosts - an exchange of its own, with its
//! own (shorter) list of markets and its own book - so a demo account's
//! orders are checked against, and priced from, Demo Trading's markets. The
//! market data on screen follows the account: Demo Trading's while a demo
//! account is active ([`BlofinAdapter::set_demo_market_data`]).
//! [`BlofinAdapter::check_key`] asks BloFin about a key before onboarding
//! stores it - see docs/adr/0001-venues-in-rust.md.
//!
//! Orders come back `Open` or `Filled`: a market order is an IOC limit at
//! the slippage bound, read back once placed to say whether it filled. A
//! trigger order is a BloFin algo order (`algo:<id>`); a position's
//! take-profit and stop-loss are one whole-position TP/SL order
//! (`tpsl:<id>`), changed leg by leg; its trailing stop a whole-position
//! trailing algo order (`trail:<id>`), following by an absolute distance.
//! The account must be in One-way Mode: BloFin ignores `reduceOnly` in Hedge
//! Mode, so nothing is placed there. `orders.rs` builds every request's body,
//! this module signs exactly that and sends it as signed. Both are
//! security-sensitive. Nothing here can withdraw or transfer: the adapter has
//! no such request, and BloFin has no dead-man's switch for it to arm.

mod account;
pub mod auth;
mod book;
pub mod constants;
mod orders;
mod tape;
mod wire;
mod ws;

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use async_trait::async_trait;
use pewterdesk_core::{
    AccountSnapshot, Candle, CandleInterval, Capabilities, ClosedTrade, Decimal, ExchangeAdapter,
    ExitChange, Fill, FundingPayment, FundingRate, KeySource, MarginMode, Market, MarketHistory,
    MarketStats, MarketSummary, Order, OrderAmend, OrderBook, OrderCategory, OrderKind,
    OrderRequest, OrderStatus, OrderType, PositionProtection, PriceSource, Side, Trade,
    TradeSettings, TradingAccount, VenueError, VenueId,
};
use reqwest::Method;
use serde::de::DeserializeOwned;
use serde_json::Value;
use tokio::sync::mpsc;
use tokio::sync::mpsc::error::TrySendError;

use constants::Endpoints;
use tape::Tape;
use wire::{Spec, Specs};
use ws::{Channel, Handled};

const REQUEST_TIMEOUT: Duration = Duration::from_secs(10);
/// Levels per side of a REST book (BloFin's most).
const BOOK_REST_DEPTH: u32 = 100;
/// Levels per side sent to the UI (the channel keeps 200).
const BOOK_DEPTH: usize = 200;
/// The book goes out at most this often; its channel pushes every 100ms.
const BOOK_EVERY: Duration = Duration::from_millis(200);
/// Trades the tape starts with (BloFin's most).
const TRADE_HISTORY: u32 = 100;
/// Candles of history sent before live updates.
const CANDLE_HISTORY: u32 = 500;
/// The most candles BloFin returns per request.
const MAX_CANDLE_PAGE: u32 = 1440;
/// Every market's summary is re-read this often: four requests.
const SUMMARY_EVERY: Duration = Duration::from_secs(5);
/// A single market's stats refresh its open interest this often (it has no
/// channel).
const STATS_OI_POLL: Duration = Duration::from_secs(30);
/// Hourly candles fetched per market for screening: 7 days.
const HISTORY_HOURS: u32 = 7 * 24;
/// One market's history per this long: 40 requests a minute, inside the
/// 500 a minute BloFin allows an IP with room for everything else.
const HISTORY_PACE: Duration = Duration::from_millis(1500);
/// BloFin returns at most this many funding rates per request.
const FUNDING_PAGE: usize = 100;
/// Pages fetched per `funding_history` call at most.
const FUNDING_MAX_PAGES: usize = 10;
/// The market list (and each market's contract size) is re-read this often.
const SPECS_EVERY: Duration = Duration::from_secs(600);

/// The account is re-read this often while it's on screen: six signed
/// requests.
const ACCOUNT_EVERY: Duration = Duration::from_secs(10);
const WEEK_MS: u64 = 7 * 24 * 3_600_000;
/// How far back a history reaches at most, a week at a time where BloFin
/// asks for that: 35 days.
const HISTORY_WEEKS: u64 = 5;
/// Rows BloFin returns per history request at most.
const HISTORY_PAGE: usize = 100;
/// Pages read per history call at most.
const HISTORY_PAGES: usize = 5;

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| d.as_millis() as u64)
}

/// A query value as it's sent: letters, digits and `-_.~` as they are,
/// every other byte percent-encoded. The path is signed after this, so the
/// string signed is the one sent.
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

fn query_string(query: &[(&str, String)]) -> String {
    query
        .iter()
        .map(|(k, v)| format!("{k}={}", encode(v)))
        .collect::<Vec<_>>()
        .join("&")
}

/// What a request that may have reached BloFin says when its answer was lost.
const UNKNOWN_FATE: &str =
    "the connection dropped after sending; check your open orders before trying again";

fn parse_error(e: serde_json::Error) -> VenueError {
    VenueError::Network(format!("unexpected BloFin response: {e}"))
}

fn parse<T: DeserializeOwned>(data: Value) -> Result<T, VenueError> {
    serde_json::from_value(data).map_err(parse_error)
}

/// Reads BloFin's answer: its `data` on success, its refusal said plainly
/// otherwise. BloFin answers most refusals with HTTP 200 and a code.
async fn answer(response: reqwest::Response) -> Result<Value, VenueError> {
    let status = response.status();
    if status.as_u16() == 429 {
        return Err(VenueError::Network("rate limited (429)".into()));
    }
    if status.as_u16() == 403 {
        return Err(VenueError::Network(
            "BloFin's firewall turned the request away (403); wait a few minutes".into(),
        ));
    }
    let body = response
        .text()
        .await
        .map_err(|e| VenueError::Network(e.without_url().to_string()))?;
    let envelope: wire::Envelope = serde_json::from_str(&body)
        .map_err(|_| VenueError::Network(format!("BloFin API returned {status}")))?;
    if envelope.code != "0" {
        return Err(auth::api_error(&envelope.code, envelope.msg));
    }
    Ok(envelope.data)
}

/// The REST API on one host. Cheap to clone, so background tasks carry
/// their own.
#[derive(Clone)]
struct Rest {
    http: reqwest::Client,
    base: &'static str,
}

impl Rest {
    async fn get(&self, path: &'static str, query: &[(&str, String)]) -> Result<Value, VenueError> {
        let url = if query.is_empty() {
            format!("{}{path}", self.base)
        } else {
            format!("{}{path}?{}", self.base, query_string(query))
        };
        let response = self
            .http
            .get(url)
            .send()
            .await
            .map_err(|e| VenueError::Network(e.without_url().to_string()))?;
        answer(response).await
    }

    /// A request signed with `creds`. Crate-private, and the path is
    /// `'static` - this crate's own - as is every query name, so nothing
    /// outside chooses where it goes or what it asks; the query values and
    /// the body come from `orders.rs` or this crate. The signature covers
    /// the path with its query string and the body, exactly as sent. Never
    /// retried - a resend could place an order twice.
    async fn signed(
        &self,
        method: Method,
        path: &'static str,
        query: &[(&'static str, String)],
        body: Option<&Value>,
        creds: &auth::ApiCredentials,
    ) -> Result<Value, VenueError> {
        let writes = method != Method::GET;
        let request_path = if query.is_empty() {
            path.to_owned()
        } else {
            format!("{path}?{}", query_string(query))
        };
        let body = body.map(Value::to_string).unwrap_or_default();
        let timestamp = now_ms().to_string();
        let nonce = auth::nonce()?;
        let sign = creds.sign(&request_path, method.as_str(), &timestamp, &nonce, &body);
        let mut request = self
            .http
            .request(method, format!("{}{request_path}", self.base))
            .header("ACCESS-KEY", creds.api_key())
            .header("ACCESS-SIGN", sign)
            .header("ACCESS-TIMESTAMP", timestamp)
            .header("ACCESS-NONCE", nonce);
        // A key made without a passphrase sends none.
        if let Some(passphrase) = creds.passphrase() {
            request = request.header("ACCESS-PASSPHRASE", passphrase);
        }
        if writes {
            request = request
                .header("Content-Type", "application/json")
                .body(body);
        }
        let response = request.send().await.map_err(|e| {
            if writes && !e.is_connect() {
                VenueError::Network(UNKNOWN_FATE.into())
            } else {
                VenueError::Network(e.without_url().to_string())
            }
        })?;
        answer(response).await
    }

    async fn signed_get<T: DeserializeOwned>(
        &self,
        path: &'static str,
        query: &[(&'static str, String)],
        creds: &auth::ApiCredentials,
    ) -> Result<T, VenueError> {
        parse(self.signed(Method::GET, path, query, None, creds).await?)
    }

    async fn post(
        &self,
        path: &'static str,
        body: &Value,
        creds: &auth::ApiCredentials,
    ) -> Result<Vec<orders::Ack>, VenueError> {
        orders::acks(
            self.signed(Method::POST, path, &[], Some(body), creds)
                .await?,
        )
    }

    async fn instruments(&self) -> Result<Vec<wire::Instrument>, VenueError> {
        parse(self.get("/api/v1/market/instruments", &[]).await?)
    }

    async fn tickers(&self, market: Option<&str>) -> Result<Vec<wire::Ticker>, VenueError> {
        parse(self.get("/api/v1/market/tickers", &inst(market)).await?)
    }

    async fn marks(&self, market: Option<&str>) -> Result<Vec<wire::Mark>, VenueError> {
        parse(self.get("/api/v1/market/mark-price", &inst(market)).await?)
    }

    async fn funding(&self, market: Option<&str>) -> Result<Vec<wire::Funding>, VenueError> {
        parse(
            self.get("/api/v1/market/funding-rate", &inst(market))
                .await?,
        )
    }

    /// Open interest, every market's or one's, in base units. BloFin doesn't
    /// document this endpoint, so a caller treats a failure as "unknown"
    /// (zero) rather than failing its own stream.
    async fn open_interest(
        &self,
        market: Option<&str>,
    ) -> Result<HashMap<String, Decimal>, VenueError> {
        let rows: Vec<wire::OpenInterest> = parse(
            self.get("/api/v1/market/open-interest", &inst(market))
                .await?,
        )?;
        Ok(wire::open_interest(rows))
    }

    async fn book(&self, market: &str) -> Result<Value, VenueError> {
        self.get(
            "/api/v1/market/books",
            &[
                ("instId", market.to_owned()),
                ("size", BOOK_REST_DEPTH.to_string()),
            ],
        )
        .await
    }

    /// Up to `limit` candles, oldest first, that opened before `before`
    /// when it's given.
    async fn candles(
        &self,
        market: &str,
        interval: CandleInterval,
        limit: u32,
        before: Option<u64>,
    ) -> Result<Vec<Candle>, VenueError> {
        let mut query = vec![
            ("instId", market.to_owned()),
            ("bar", wire::interval_code(interval).to_owned()),
            ("limit", limit.to_string()),
        ];
        if let Some(before) = before {
            query.push(("after", before.to_string()));
        }
        Ok(wire::candles(
            &self.get("/api/v1/market/candles", &query).await?,
        ))
    }

    /// `market`'s touch, and its last price, now. Public.
    async fn quote(&self, market: &str) -> Result<(orders::Quote, Decimal), VenueError> {
        let (tickers, marks) =
            tokio::try_join!(self.tickers(Some(market)), self.marks(Some(market)))?;
        let ticker = tickers
            .into_iter()
            .find(|t| t.inst_id == market)
            .ok_or_else(|| VenueError::Network(format!("BloFin sent no price for {market:?}")))?;
        // The last price, for a trailing stop's distance; the mark where
        // there's been no trade.
        let last = match marks.into_iter().find(|m| m.inst_id == market) {
            Some(m) if ticker.last.0.is_zero() => m.mark_price,
            _ => ticker.last,
        };
        Ok((
            orders::Quote {
                bid: ticker.bid_price,
                ask: ticker.ask_price,
                range: None,
            },
            last,
        ))
    }

    /// The live markets, busiest (by the day's traded value) first.
    async fn markets_by_volume(&self) -> Result<Vec<String>, VenueError> {
        let (instruments, tickers) = tokio::try_join!(self.instruments(), self.tickers(None))?;
        let live = wire::specs(&instruments);
        Ok(by_volume(&live, &tickers))
    }

    /// BloFin's lowest and highest price for a `side` order on `market` now.
    async fn price_range(
        &self,
        creds: &auth::ApiCredentials,
        market: &str,
        side: Side,
    ) -> Result<(Decimal, Decimal), VenueError> {
        #[derive(serde::Deserialize)]
        #[serde(rename_all = "camelCase")]
        struct Range {
            #[serde(deserialize_with = "wire::zero_num")]
            min_price: Decimal,
            #[serde(deserialize_with = "wire::zero_num")]
            max_price: Decimal,
        }
        let side = match side {
            Side::Buy => "buy",
            Side::Sell => "sell",
        };
        let range: Range = self
            .signed_get(
                "/api/v1/trade/order/price-range",
                &[("instId", market.to_owned()), ("side", side.to_owned())],
                creds,
            )
            .await?;
        Ok((range.min_price, range.max_price))
    }

    /// The account's margin mode, and whether it's in Hedge Mode.
    async fn modes(&self, creds: &auth::ApiCredentials) -> Result<(MarginMode, bool), VenueError> {
        let (margin, position) = tokio::try_join!(
            self.signed_get::<account::WireMarginMode>("/api/v1/account/margin-mode", &[], creds),
            self.signed_get::<account::WirePositionMode>(
                "/api/v1/account/position-mode",
                &[],
                creds
            ),
        )?;
        Ok((margin.mode(), position.hedge()))
    }

    /// The pending trigger and trailing orders, on `market` or every market.
    async fn algos(
        &self,
        creds: &auth::ApiCredentials,
        market: Option<&str>,
    ) -> Result<Vec<account::WireAlgo>, VenueError> {
        let with = |kind: &str| {
            let mut q = vec![
                ("orderType", kind.to_owned()),
                ("limit", HISTORY_PAGE.to_string()),
            ];
            if let Some(m) = market {
                q.push(("instId", m.to_owned()));
            }
            q
        };
        let (trigger, trailing) = (with("trigger"), with("trailing_stop"));
        let (mut a, b) = tokio::try_join!(
            self.signed_get::<Vec<account::WireAlgo>>(
                "/api/v1/trade/orders-algo-pending",
                &trigger,
                creds
            ),
            self.signed_get::<Vec<account::WireAlgo>>(
                "/api/v1/trade/orders-algo-pending",
                &trailing,
                creds
            ),
        )?;
        a.extend(b);
        Ok(a)
    }

    /// The account's balance, positions and every kind of open order.
    async fn account(
        &self,
        creds: &auth::ApiCredentials,
        id: &str,
        specs: &Specs,
    ) -> Result<AccountSnapshot, VenueError> {
        let page = [("limit", HISTORY_PAGE.to_string())];
        let (balance, positions, orders, tpsl, algos) = tokio::try_join!(
            self.signed_get::<account::WireBalance>("/api/v1/account/balance", &[], creds),
            self.signed_get::<Vec<account::WirePosition>>("/api/v1/account/positions", &[], creds),
            self.signed_get::<Vec<account::WireOrder>>(
                "/api/v1/trade/orders-pending",
                &page,
                creds
            ),
            self.signed_get::<Vec<account::WireTpsl>>(
                "/api/v1/trade/orders-tpsl-pending",
                &page,
                creds
            ),
            self.algos(creds, None),
        )?;
        Ok(account::snapshot(
            id,
            balance,
            positions,
            orders,
            tpsl,
            algos,
            specs,
            now_ms(),
        ))
    }

    /// Pages of a history list, newest first, each the `HISTORY_PAGE` rows
    /// before the last one's `cursor` field, up to `HISTORY_PAGES` pages.
    async fn history(
        &self,
        creds: &auth::ApiCredentials,
        path: &'static str,
        query: Vec<(&'static str, String)>,
        cursor: &str,
    ) -> Result<Vec<Value>, VenueError> {
        let mut rows = Vec::new();
        let mut after: Option<String> = None;
        for _ in 0..HISTORY_PAGES {
            let mut q = query.clone();
            q.push(("limit", HISTORY_PAGE.to_string()));
            if let Some(after) = &after {
                q.push(("after", after.clone()));
            }
            let page: Vec<Value> = self.signed_get(path, &q, creds).await?;
            let full = page.len() >= HISTORY_PAGE;
            after = page.last().and_then(|r| match &r[cursor] {
                Value::String(s) if !s.is_empty() => Some(s.clone()),
                Value::Number(n) => Some(n.to_string()),
                _ => None,
            });
            rows.extend(page);
            if !full || after.is_none() {
                break;
            }
        }
        Ok(rows)
    }
}

fn inst(market: Option<&str>) -> Vec<(&'static str, String)> {
    market
        .map(|m| vec![("instId", m.to_owned())])
        .unwrap_or_default()
}

/// `live` markets ordered by their tickers' traded value, highest first.
fn by_volume(live: &Specs, tickers: &[wire::Ticker]) -> Vec<String> {
    let mut ranked: Vec<&wire::Ticker> = tickers
        .iter()
        .filter(|t| live.contains_key(&t.inst_id))
        .collect();
    ranked.sort_by_key(|t| std::cmp::Reverse(t.quote_volume()));
    ranked.into_iter().map(|t| t.inst_id.clone()).collect()
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

/// A push's data as a list: BloFin sends one row or object, or a list.
fn rows(data: Value) -> Vec<Value> {
    match data {
        Value::Array(items) if items.first().is_some_and(|f| f.is_array() || f.is_object()) => {
            items
        }
        Value::Null => Vec::new(),
        other => vec![other],
    }
}

/// One update on a market's stats connection.
enum StatsUpdate {
    Ticker(wire::Ticker),
    Funding(wire::Funding),
    Mark(Decimal),
}

/// What BloFin says about a key, after it's been checked.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct KeyCheck {
    pub key: auth::DemoKey,
    /// The account trades in Hedge Mode, where this adapter places nothing
    /// (BloFin would ignore `reduceOnly`) until it's switched to One-way.
    pub hedge_mode: bool,
}

/// A host's market list and when it was read.
type SpecCache = tokio::sync::Mutex<Option<(Instant, Arc<Specs>)>>;

pub struct BlofinAdapter {
    rest: Rest,
    /// Demo Trading's host, for demo accounts; unset where the network has
    /// none.
    demo: Option<Rest>,
    endpoints: &'static Endpoints,
    /// Whether market data (markets, books, trades, candles, stats,
    /// summaries) comes from Demo Trading's host rather than mainnet's: set
    /// while a Demo Trading account is the one on screen, whose exchange
    /// lists markets of its own (87 to mainnet's 527) at its own prices.
    /// Accounts and orders always go to their own host (`rest_for`),
    /// whatever this says.
    demo_data: AtomicBool,
    /// Each host's markets and contract sizes, read on first use and again
    /// every `SPECS_EVERY` (and whenever `markets` runs, for mainnet's).
    specs: SpecCache,
    demo_specs: SpecCache,
    /// Where account reads take the stored API key from; unset, account
    /// data is `Unsupported`.
    keys: Option<Arc<dyn KeySource>>,
}

const NO_ACCOUNT_DATA: &str = "BloFin account data (no key store is set up)";
const NO_DEMO: &str = "Demo Trading on this network";

impl BlofinAdapter {
    /// Talks only to `endpoints`, which are fixed in [`constants`] - never a
    /// URL supplied by a caller.
    pub fn new(endpoints: &'static Endpoints) -> Result<Self, VenueError> {
        // No redirects: a request stays on its host.
        let http = reqwest::Client::builder()
            .timeout(REQUEST_TIMEOUT)
            .gzip(true)
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .map_err(|e| VenueError::Network(e.to_string()))?;
        Ok(Self {
            rest: Rest {
                http: http.clone(),
                base: endpoints.rest,
            },
            demo: endpoints.demo_rest.map(|base| Rest {
                http: http.clone(),
                base,
            }),
            endpoints,
            demo_data: AtomicBool::new(false),
            specs: tokio::sync::Mutex::new(None),
            demo_specs: tokio::sync::Mutex::new(None),
            keys: None,
        })
    }

    /// Adds the app's `KeySource`, which account reads take the stored API
    /// key from. Without one, account data is `Unsupported`.
    pub fn with_keys(mut self, keys: Arc<dyn KeySource>) -> Self {
        self.keys = Some(keys);
        self
    }

    /// Asks BloFin about the key `creds` holds, signed with it: whose it is
    /// (its UID), that it can trade, and whether the account is in Hedge
    /// Mode. Onboarding stores a key only after this passes. A live key is
    /// refused before anything is sent ([`auth::check_live`]). Read-only
    /// requests, all of them, on Demo Trading's host.
    pub async fn check_key(
        &self,
        creds: &auth::ApiCredentials,
        demo: bool,
    ) -> Result<KeyCheck, VenueError> {
        if !demo {
            auth::check_live()?;
        }
        let rest = self.demo.as_ref().ok_or(VenueError::Unsupported(NO_DEMO))?;
        let info: auth::ApiKeyInfo = rest
            .signed_get("/api/v1/user/query-apikey", &[], creds)
            .await?;
        let key = auth::check_demo(&info)?;
        let (_, hedge_mode) = rest.modes(creds).await?;
        Ok(KeyCheck { key, hedge_mode })
    }

    /// Reads market data from Demo Trading's host (`true`) or mainnet's. A
    /// network without Demo Trading stays on mainnet. Returns whether it
    /// changed: streams opened before keep their host until reopened.
    pub fn set_demo_market_data(&self, demo: bool) -> bool {
        let demo = demo && self.demo.is_some() && self.endpoints.demo_ws_public.is_some();
        self.demo_data.swap(demo, Ordering::Relaxed) != demo
    }

    fn demo_data(&self) -> bool {
        self.demo_data.load(Ordering::Relaxed)
    }

    /// The host market data comes from (see `demo_data`).
    fn data(&self) -> &Rest {
        match (&self.demo, self.demo_data()) {
            (Some(demo), true) => demo,
            _ => &self.rest,
        }
    }

    fn ws_public(&self) -> &'static str {
        match self.endpoints.demo_ws_public {
            Some(demo) if self.demo_data() => demo,
            _ => self.endpoints.ws_public,
        }
    }

    /// Every live market's summary on mainnet, whatever the market data on
    /// screen is from: for a comparison across venues (the status bar's
    /// Market movement), where Demo Trading's volume would mean nothing.
    pub async fn subscribe_mainnet_summaries(
        &self,
    ) -> Result<mpsc::Receiver<Vec<MarketSummary>>, VenueError> {
        self.summaries_on(false).await
    }

    /// Every live market's summary on mainnet or Demo Trading (see
    /// `subscribe_market_summaries`).
    async fn summaries_on(
        &self,
        demo: bool,
    ) -> Result<mpsc::Receiver<Vec<MarketSummary>>, VenueError> {
        let rest = if demo {
            self.demo.as_ref().ok_or(VenueError::Unsupported(NO_DEMO))?
        } else {
            &self.rest
        }
        .clone();
        let read = |rest: Rest, live: Arc<Specs>| async move {
            let (tickers, marks, funding, open_interest) = tokio::join!(
                rest.tickers(None),
                rest.marks(None),
                rest.funding(None),
                rest.open_interest(None),
            );
            let (tickers, marks, funding) = (tickers?, marks?, funding?);
            // Undocumented: without it, open interest reads zero.
            let open_interest = open_interest.unwrap_or_default();
            let order = by_volume(&live, &tickers);
            let tickers: HashMap<String, wire::Ticker> = tickers
                .into_iter()
                .map(|t| (t.inst_id.clone(), t))
                .collect();
            let marks: HashMap<String, wire::Mark> =
                marks.into_iter().map(|m| (m.inst_id.clone(), m)).collect();
            let funding: HashMap<String, wire::Funding> = funding
                .into_iter()
                .map(|f| (f.inst_id.clone(), f))
                .collect();
            Ok::<_, VenueError>(wire::market_summaries(
                &order,
                &tickers,
                &marks,
                &funding,
                &open_interest,
            ))
        };
        let live = self.specs(demo).await?;
        let first = read(rest.clone(), Arc::clone(&live)).await?;
        let (tx, rx) = mpsc::channel(4);
        tokio::spawn(async move {
            loop {
                tokio::select! {
                    _ = tx.closed() => return,
                    _ = tokio::time::sleep(SUMMARY_EVERY) => {}
                }
                if let Ok(next) = read(rest.clone(), Arc::clone(&live)).await {
                    if tx.send(next).await.is_err() {
                        return;
                    }
                }
            }
        });
        Ok(with_first(first, rx))
    }

    /// The host for account `id`: Demo Trading's for a demo account.
    fn rest_for(&self, id: &str) -> Result<(&Rest, bool), VenueError> {
        if auth::parse_account(id)?.0 {
            Ok((
                self.demo.as_ref().ok_or(VenueError::Unsupported(NO_DEMO))?,
                true,
            ))
        } else {
            Ok((&self.rest, false))
        }
    }

    /// The markets and contract sizes of mainnet, or of Demo Trading.
    async fn specs(&self, demo: bool) -> Result<Arc<Specs>, VenueError> {
        let (cache, rest) = if demo {
            (
                &self.demo_specs,
                self.demo.as_ref().ok_or(VenueError::Unsupported(NO_DEMO))?,
            )
        } else {
            (&self.specs, &self.rest)
        };
        let mut cache = cache.lock().await;
        if let Some((at, specs)) = cache.as_ref() {
            if at.elapsed() < SPECS_EVERY {
                return Ok(Arc::clone(specs));
            }
        }
        let fresh = Arc::new(wire::specs(&rest.instruments().await?));
        *cache = Some((Instant::now(), Arc::clone(&fresh)));
        Ok(fresh)
    }

    /// `market`'s spec on mainnet or Demo Trading, or a plain refusal.
    async fn spec(&self, demo: bool, market: &str) -> Result<Spec, VenueError> {
        wire::validate_market(market)?;
        self.specs(demo).await?.get(market).copied().ok_or_else(|| {
            VenueError::InvalidRequest(if demo {
                format!("{market} isn't a live market on BloFin's Demo Trading")
            } else {
                format!("{market} isn't a live BloFin perpetual")
            })
        })
    }

    /// The host, whether it's demo, and the stored key for reading account
    /// `id`'s own data.
    async fn reader(&self, id: &str) -> Result<(&Rest, bool, auth::ApiCredentials), VenueError> {
        let (rest, demo) = self.rest_for(id)?;
        let keys = self
            .keys
            .as_deref()
            .ok_or(VenueError::Unsupported(NO_ACCOUNT_DATA))?;
        let stored = keys.key(&auth::key_account(id)?).await?;
        Ok((rest, demo, auth::ApiCredentials::from_stored(&stored)?))
    }

    /// The host and stored key for `account`, checking it's this account's
    /// BloFin key and that it may trade: a caller can't point an order at
    /// another venue's or account's key, and a live account trades nowhere.
    async fn trader(
        &self,
        account: &TradingAccount,
    ) -> Result<(&Rest, auth::ApiCredentials), VenueError> {
        if account.key != auth::key_account(&account.address)? {
            return Err(VenueError::InvalidRequest(
                "that key isn't this BloFin account's".into(),
            ));
        }
        let (rest, demo) = self.rest_for(&account.address)?;
        if !demo {
            return Err(VenueError::Rejected(auth::LIVE_REFUSED.into()));
        }
        let keys = self
            .keys
            .as_deref()
            .ok_or(VenueError::Unsupported("orders (no key store is set up)"))?;
        let stored = keys.key(&account.key).await?;
        Ok((rest, auth::ApiCredentials::from_stored(&stored)?))
    }

    /// The account's margin mode, refusing an account in Hedge Mode.
    async fn one_way(rest: &Rest, creds: &auth::ApiCredentials) -> Result<MarginMode, VenueError> {
        let (mode, hedge) = rest.modes(creds).await?;
        if hedge {
            return Err(auth::api_error("102089", String::new()));
        }
        Ok(mode)
    }

    /// `market`'s book on mainnet or Demo Trading: the `books` channel's
    /// snapshot, then its updates, kept locally and sent whole at most every
    /// `BOOK_EVERY`.
    async fn book_stream(
        &self,
        demo: bool,
        market: &str,
    ) -> Result<mpsc::Receiver<OrderBook>, VenueError> {
        let spec = self.spec(demo, market).await?;
        let (rest, ws) = match (&self.demo, self.endpoints.demo_ws_public) {
            (Some(rest), Some(ws)) if demo => (rest, ws),
            _ if demo => return Err(VenueError::Unsupported(NO_DEMO)),
            _ => (&self.rest, self.endpoints.ws_public),
        };
        let first = wire::order_book(market, &rest.book(market).await?, &spec, now_ms());
        let id = market.to_owned();
        let mut book = book::Book::default();
        let mut last_sent: Option<Instant> = None;
        let live = ws::subscribe(ws, vec![Channel::new("books", market)], move |push| {
            if push.arg.channel != "books" {
                return Handled::Ignore;
            }
            match book.apply(push.action.as_deref(), &push.data) {
                book::Applied::Gap => return Handled::Resync,
                book::Applied::Changed => {}
            }
            if last_sent.is_some_and(|at| at.elapsed() < BOOK_EVERY) {
                return Handled::Ignore;
            }
            last_sent = Some(Instant::now());
            Handled::Emit(book.snapshot(&id, BOOK_DEPTH, &spec))
        })
        .await?;
        Ok(with_first(first, live))
    }

    /// Cancels order `id` on `market`, wherever it lives.
    async fn cancel_on(
        rest: &Rest,
        creds: &auth::ApiCredentials,
        market: &str,
        id: &str,
    ) -> Result<(), VenueError> {
        let (path, body) = orders::cancel(market, id)?;
        rest.post(path, &body, creds).await?;
        Ok(())
    }
}

/// The id BloFin gave a new order, from its acknowledgement.
fn placed_id(acks: &[orders::Ack], pick: fn(&orders::Ack) -> &str) -> Result<String, VenueError> {
    acks.iter()
        .map(pick)
        .find(|id| !id.is_empty())
        .map(str::to_owned)
        .ok_or_else(|| VenueError::Network("BloFin accepted the order but sent no id".into()))
}

#[async_trait]
impl ExchangeAdapter for BlofinAdapter {
    fn venue(&self) -> VenueId {
        VenueId::Blofin
    }

    fn capabilities(&self) -> Capabilities {
        Capabilities {
            order_book: true,
            order_types: vec![OrderType::Market, OrderType::Limit, OrderType::Trigger],
            isolated_collateral: false,
        }
    }

    async fn markets(&self) -> Result<Vec<Market>, VenueError> {
        let instruments = self.data().instruments().await?;
        let cache = if self.demo_data() {
            &self.demo_specs
        } else {
            &self.specs
        };
        *cache.lock().await = Some((Instant::now(), Arc::new(wire::specs(&instruments))));
        Ok(wire::markets(instruments))
    }

    async fn order_book(&self, market: &str) -> Result<OrderBook, VenueError> {
        let spec = self.spec(self.demo_data(), market).await?;
        Ok(wire::order_book(
            market,
            &self.data().book(market).await?,
            &spec,
            now_ms(),
        ))
    }

    async fn subscribe_order_book(
        &self,
        market: &str,
    ) -> Result<mpsc::Receiver<OrderBook>, VenueError> {
        self.book_stream(self.demo_data(), market).await
    }

    /// The book on the exchange `account` trades on - Demo Trading's for a
    /// demo account - for an algo, whose orders are priced off it.
    async fn subscribe_account_order_book(
        &self,
        account: &str,
        market: &str,
    ) -> Result<mpsc::Receiver<OrderBook>, VenueError> {
        let (demo, _) = auth::parse_account(account)?;
        self.book_stream(demo, market).await
    }

    /// Recent trades over REST start the tape; the `trades` channel adds
    /// each print after that. Both carry BloFin's trade id, so a print the
    /// two share is kept once.
    async fn subscribe_trades(
        &self,
        market: &str,
    ) -> Result<mpsc::Receiver<Vec<Trade>>, VenueError> {
        let spec = self.spec(self.demo_data(), market).await?;
        let recent: Vec<wire::WireTrade> = parse(
            self.data()
                .get(
                    "/api/v1/market/trades",
                    &[
                        ("instId", market.to_owned()),
                        ("limit", TRADE_HISTORY.to_string()),
                    ],
                )
                .await?,
        )?;
        let mut tape = Tape::default();
        tape.record(
            recent
                .into_iter()
                .map(|t| wire::trade(market, t, &spec))
                .collect(),
        );
        let first = tape.snapshot();
        let id = market.to_owned();
        let live = ws::subscribe(
            self.ws_public(),
            vec![Channel::new("trades", market)],
            move |push| {
                let trades: Vec<Trade> = rows(push.data)
                    .into_iter()
                    .filter_map(|r| serde_json::from_value::<wire::WireTrade>(r).ok())
                    .map(|t| wire::trade(&id, t, &spec))
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

    /// Seeded over REST, then the `tickers` channel (prices and the day),
    /// `funding-rate` (the rate and the next payment) and the minute
    /// mark-price candle, whose close is the mark.
    async fn subscribe_market_stats(
        &self,
        market: &str,
    ) -> Result<mpsc::Receiver<MarketStats>, VenueError> {
        self.spec(self.demo_data(), market).await?;
        let (tickers, marks, funding) = tokio::try_join!(
            self.data().tickers(Some(market)),
            self.data().marks(Some(market)),
            self.data().funding(Some(market)),
        )?;
        let missing = || VenueError::Network(format!("BloFin sent no data for {market:?}"));
        let mut ticker = tickers
            .into_iter()
            .find(|t| t.inst_id == market)
            .ok_or_else(missing)?;
        let first_mark = marks.into_iter().find(|m| m.inst_id == market);
        let mut mark = first_mark
            .as_ref()
            .map(|m| m.mark_price)
            .unwrap_or_default();
        let index = first_mark.and_then(|m| m.index_price);
        let mut funding = funding.into_iter().find(|f| f.inst_id == market);
        let oi_of = |all: HashMap<String, Decimal>| all.get(market).copied().unwrap_or_default();
        let mut oi = self
            .rest
            .open_interest(Some(market))
            .await
            .map(oi_of)
            .unwrap_or_default();
        let first =
            wire::market_stats(market, &ticker, mark, index, funding.as_ref(), oi, now_ms());

        let mut updates = ws::subscribe(
            self.ws_public(),
            vec![
                Channel::new("tickers", market),
                Channel::new("funding-rate", market),
                Channel::new("mark-price-candle1m", market),
            ],
            |push| {
                let channel = push.arg.channel.clone();
                let Some(row) = rows(push.data).into_iter().next() else {
                    return Handled::Ignore;
                };
                match channel.as_str() {
                    "tickers" => match serde_json::from_value(row) {
                        Ok(t) => Handled::Emit(StatsUpdate::Ticker(t)),
                        Err(_) => Handled::Ignore,
                    },
                    "funding-rate" => match serde_json::from_value(row) {
                        Ok(f) => Handled::Emit(StatsUpdate::Funding(f)),
                        Err(_) => Handled::Ignore,
                    },
                    _ => match wire::candle(&row) {
                        Some(c) => Handled::Emit(StatsUpdate::Mark(c.close)),
                        None => Handled::Ignore,
                    },
                }
            },
        )
        .await?;

        let (tx, rx) = mpsc::channel(16);
        let market = market.to_owned();
        let rest = self.data().clone();
        tokio::spawn(async move {
            let mut poll = tokio::time::interval(STATS_OI_POLL);
            poll.tick().await;
            loop {
                tokio::select! {
                    _ = tx.closed() => return,
                    _ = poll.tick() => {
                        if let Ok(all) = rest.open_interest(Some(&market)).await {
                            oi = all.get(&market).copied().unwrap_or(oi);
                        }
                        continue;
                    }
                    update = updates.recv() => match update {
                        Some(StatsUpdate::Ticker(t)) => ticker = t,
                        Some(StatsUpdate::Funding(f)) => {
                            // The channel leaves out the interval; keep the one REST gave.
                            let keep = funding.take();
                            funding = Some(match keep {
                                Some(old) if f.funding_interval.is_empty() => wire::Funding {
                                    funding_interval: old.funding_interval,
                                    funding_interval_unit: old.funding_interval_unit,
                                    ..f
                                },
                                _ => f,
                            });
                        }
                        Some(StatsUpdate::Mark(m)) => mark = m,
                        None => return,
                    },
                }
                let stats = wire::market_stats(
                    &market,
                    &ticker,
                    mark,
                    index,
                    funding.as_ref(),
                    oi,
                    now_ms(),
                );
                match tx.try_send(stats) {
                    Ok(()) | Err(TrySendError::Full(_)) => {}
                    Err(TrySendError::Closed(_)) => return,
                }
            }
        });
        Ok(with_first(first, rx))
    }

    /// History over REST, then the candle channel, which re-sends the
    /// forming candle whole as it changes.
    async fn subscribe_candles(
        &self,
        market: &str,
        interval: CandleInterval,
    ) -> Result<mpsc::Receiver<Vec<Candle>>, VenueError> {
        self.spec(self.demo_data(), market).await?;
        let history = self
            .rest
            .candles(market, interval, CANDLE_HISTORY, None)
            .await?;
        let channel = format!("candle{}", wire::interval_code(interval));
        let want = channel.clone();
        let live = ws::subscribe(
            self.ws_public(),
            vec![Channel::new(channel, market)],
            move |push| {
                if push.arg.channel != want {
                    return Handled::Ignore;
                }
                let candles: Vec<Candle> =
                    rows(push.data).iter().filter_map(wire::candle).collect();
                if candles.is_empty() {
                    Handled::Ignore
                } else {
                    Handled::Emit(candles)
                }
            },
        )
        .await?;
        Ok(with_first(history, live))
    }

    /// Every live market's summary, re-read every `SUMMARY_EVERY` (four
    /// requests: tickers, marks, funding and open interest for all markets
    /// at once). Open interest reads zero where its read fails.
    async fn subscribe_market_summaries(
        &self,
    ) -> Result<mpsc::Receiver<Vec<MarketSummary>>, VenueError> {
        self.summaries_on(self.demo_data()).await
    }

    /// Walks the markets busiest first, one market's hourly candles every
    /// `HISTORY_PACE`, then starts over with a fresh ranking. A market whose
    /// fetch fails is skipped until the next pass.
    async fn subscribe_market_history(&self) -> Result<mpsc::Receiver<MarketHistory>, VenueError> {
        let rest = self.data().clone();
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
            .candles(
                market,
                interval,
                count.clamp(1, MAX_CANDLE_PAGE),
                Some(before),
            )
            .await?;
        Ok(candles
            .into_iter()
            .filter(|c| c.open_time < before)
            .collect())
    }

    /// Pages back from now, 100 at a time, until `start_time`.
    async fn funding_history(
        &self,
        market: &str,
        start_time: u64,
    ) -> Result<Vec<FundingRate>, VenueError> {
        wire::validate_market(market)?;
        let mut rates = Vec::new();
        let mut after: Option<u64> = None;
        for _ in 0..FUNDING_MAX_PAGES {
            let mut query = vec![
                ("instId", market.to_owned()),
                ("limit", FUNDING_PAGE.to_string()),
            ];
            if let Some(after) = after {
                query.push(("after", after.to_string()));
            }
            let page: Vec<wire::FundingEntry> = parse(
                self.data()
                    .get("/api/v1/market/funding-rate-history", &query)
                    .await?,
            )?;
            let full = page.len() >= FUNDING_PAGE;
            let oldest = page.iter().map(|e| e.funding_time).min();
            rates.extend(
                page.into_iter()
                    .filter(|e| e.funding_time >= start_time)
                    .map(wire::funding_rate),
            );
            match oldest {
                Some(oldest) if full && oldest > start_time => after = Some(oldest),
                _ => break,
            }
        }
        rates.sort_by_key(|r| r.time);
        rates.dedup_by_key(|r| r.time);
        Ok(rates)
    }

    /// `address` is the BloFin account whose API key is stored: `demo:` and
    /// its UID (read from Demo Trading's host).
    async fn account(&self, address: &str) -> Result<AccountSnapshot, VenueError> {
        let (rest, demo, creds) = self.reader(address).await?;
        let specs = self.specs(demo).await?;
        rest.account(&creds, address, &specs).await
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
        let (rest, demo) = self.rest_for(address)?;
        let rest = rest.clone();
        let entry = auth::key_account(address)?;
        let first = self.account(address).await?;
        let specs = self.specs(demo).await?;
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
                    rest.account(&creds, &id, &specs).await
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

    /// The last week's fills, newest first.
    async fn fills(&self, address: &str) -> Result<Vec<Fill>, VenueError> {
        let (rest, demo, creds) = self.reader(address).await?;
        let specs = self.specs(demo).await?;
        let begin = now_ms().saturating_sub(WEEK_MS);
        let rows = rest
            .history(
                &creds,
                "/api/v1/trade/fills-history",
                vec![("begin", begin.to_string())],
                "tradeId",
            )
            .await?;
        let mut fills: Vec<Fill> = rows
            .into_iter()
            .filter_map(|r| serde_json::from_value::<account::WireFill>(r).ok())
            .filter_map(|f| account::fill(f, &specs))
            .collect();
        fills.sort_by_key(|f| std::cmp::Reverse(f.time));
        Ok(fills)
    }

    async fn closed_trades(&self, address: &str) -> Result<Vec<ClosedTrade>, VenueError> {
        self.closed_trades_since(address, now_ms().saturating_sub(WEEK_MS))
            .await
    }

    /// From BloFin's position history, as far back as `HISTORY_WEEKS`.
    async fn closed_trades_since(
        &self,
        address: &str,
        start_time: u64,
    ) -> Result<Vec<ClosedTrade>, VenueError> {
        let (rest, demo, creds) = self.reader(address).await?;
        let specs = self.specs(demo).await?;
        let now = now_ms();
        let begin = start_time.max(now.saturating_sub(HISTORY_WEEKS * WEEK_MS));
        let rows = rest
            .history(
                &creds,
                "/api/v1/account/positions-history",
                vec![("begin", begin.to_string()), ("end", now.to_string())],
                "historyId",
            )
            .await?;
        let mut trades: Vec<ClosedTrade> = rows
            .into_iter()
            .filter_map(|r| serde_json::from_value::<account::WireClosed>(r).ok())
            .filter_map(|c| account::closed_trade(c, &specs))
            .collect();
        trades.sort_by_key(|t| std::cmp::Reverse(t.time));
        Ok(trades)
    }

    /// The last week's finished ordinary orders, newest first. Trigger and
    /// TP/SL orders that never fired aren't among them.
    async fn order_history(&self, address: &str) -> Result<Vec<Order>, VenueError> {
        let (rest, demo, creds) = self.reader(address).await?;
        let specs = self.specs(demo).await?;
        let begin = now_ms().saturating_sub(WEEK_MS);
        let rows = rest
            .history(
                &creds,
                "/api/v1/trade/orders-history",
                vec![("begin", begin.to_string())],
                "orderId",
            )
            .await?;
        let mut orders: Vec<Order> = rows
            .into_iter()
            .filter_map(|r| serde_json::from_value::<account::WireOrder>(r).ok())
            .filter_map(|o| {
                let status = account::history_status(&o);
                account::order(o, &specs, status)
            })
            .collect();
        orders.sort_by_key(|o| std::cmp::Reverse(o.created_at));
        Ok(orders)
    }

    /// A week at a time (BloFin's widest window), from `start_time` or
    /// `HISTORY_WEEKS` ago, whichever is later; newest first.
    async fn funding_payments(
        &self,
        address: &str,
        start_time: u64,
    ) -> Result<Vec<FundingPayment>, VenueError> {
        let (rest, demo, creds) = self.reader(address).await?;
        let specs = self.specs(demo).await?;
        let now = now_ms();
        let mut from = start_time.max(now.saturating_sub(HISTORY_WEEKS * WEEK_MS));
        let mut payments = Vec::new();
        while from < now {
            let to = (from + WEEK_MS - 1).min(now);
            let page: Vec<account::WireFundingFee> = rest
                .signed_get(
                    "/api/v1/account/funding-fees",
                    &[
                        ("begin", from.to_string()),
                        ("end", to.to_string()),
                        ("limit", "1000".to_owned()),
                    ],
                    &creds,
                )
                .await?;
            payments.extend(
                page.into_iter()
                    .filter_map(|f| account::funding_payment(f, &specs)),
            );
            from = to + 1;
        }
        payments.sort_by_key(|p| std::cmp::Reverse(p.time));
        Ok(payments)
    }

    /// The account's margin mode (account-wide on BloFin) and its leverage
    /// on `market`.
    async fn trade_settings(
        &self,
        address: &str,
        market: &str,
    ) -> Result<TradeSettings, VenueError> {
        let (rest, demo, creds) = self.reader(address).await?;
        let spec = self.spec(demo, market).await?;
        let (mode, _) = rest.modes(&creds).await?;
        let mode_name = match mode {
            MarginMode::Cross => "cross",
            MarginMode::Isolated => "isolated",
        };
        let rows: Vec<account::WireLeverage> = rest
            .signed_get(
                "/api/v1/account/batch-leverage-info",
                &[
                    ("instId", market.to_owned()),
                    ("marginMode", mode_name.to_owned()),
                ],
                &creds,
            )
            .await?;
        let leverage = rows
            .iter()
            .find(|r| r.inst_id == market)
            .map(|r| r.leverage)
            .ok_or_else(|| VenueError::Network("BloFin sent no leverage for this market".into()))?;
        Ok(account::trade_settings(mode, leverage, spec.max_leverage))
    }

    /// Places `request` for a Demo Trading `account`. Checked against the
    /// market's grid and priced off its touch (and BloFin's price limits,
    /// for a market order) on Demo Trading's host before anything is
    /// signed; see `orders::create`. An IOC order is read back once placed,
    /// to say whether it filled.
    async fn place_order(
        &self,
        account: &TradingAccount,
        request: &OrderRequest,
    ) -> Result<Order, VenueError> {
        wire::validate_market(&request.market)?;
        let (rest, creds) = self.trader(account).await?;
        let (spec, (mut quote, _)) = tokio::try_join!(
            self.spec(true, &request.market),
            rest.quote(&request.market)
        )?;
        let mode = Self::one_way(rest, &creds).await?;
        if matches!(request.kind, OrderKind::Market { .. }) {
            // Only ever tightens the bound; without it BloFin refuses an
            // order outside its limits itself.
            quote.range = rest
                .price_range(&creds, &request.market, request.side)
                .await
                .ok();
        }
        let new = orders::create(request, &spec, &quote, mode)?;
        let ioc = match &new {
            orders::NewOrder::Order(body) => body["orderType"] == "ioc",
            orders::NewOrder::Algo(_) => false,
        };
        let (id, algo) = match &new {
            orders::NewOrder::Order(body) => {
                let acks = rest.post("/api/v1/trade/order", body, &creds).await?;
                (placed_id(&acks, |a| &a.order_id)?, false)
            }
            orders::NewOrder::Algo(body) => {
                let acks = rest.post("/api/v1/trade/order-algo", body, &creds).await?;
                (
                    format!(
                        "{}{}",
                        orders::ALGO_PREFIX,
                        placed_id(&acks, |a| &a.algo_id)?
                    ),
                    true,
                )
            }
        };
        let (mut status, mut filled_size) = (OrderStatus::Open, Decimal::default());
        if ioc {
            let detail: Result<account::WireOrder, VenueError> = rest
                .signed_get(
                    "/api/v1/trade/order-detail",
                    &[("instId", request.market.clone()), ("orderId", id.clone())],
                    &creds,
                )
                .await;
            match detail {
                Ok(o) if o.filled_size.0 > rust_decimal::Decimal::ZERO => {
                    filled_size = spec.base(o.filled_size);
                    status = if o.state == "live" || o.state == "partially_filled" {
                        OrderStatus::Open
                    } else {
                        OrderStatus::Filled
                    };
                }
                Ok(o) if o.state == "live" => {}
                Ok(_) => {
                    return Err(VenueError::Rejected(
                        "nothing filled: the price moved past the order's bound".into(),
                    ))
                }
                // Placed, but how it went is unknown until the account shows it.
                Err(_) => status = OrderStatus::Pending,
            }
        }
        drop(creds);
        Ok(Order {
            venue: VenueId::Blofin,
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
                OrderKind::Market { .. } | OrderKind::Twap { .. } => None,
            },
            trigger_price: match request.kind {
                OrderKind::Trigger { trigger_price, .. } => Some(trigger_price),
                _ => None,
            },
            reduce_only: request.reduce_only,
            status,
            created_at: now_ms(),
            category: if algo {
                OrderCategory::Conditional
            } else {
                OrderCategory::Regular
            },
            trigger_by: algo.then_some(PriceSource::Last),
            take_profit: request.take_profit,
            stop_loss: request.stop_loss,
        })
    }

    /// An ordinary order at `cancel-order`, a TP/SL at `cancel-tpsl`, a
    /// trigger or trailing stop at `cancel-algo`.
    async fn cancel_order(
        &self,
        account: &TradingAccount,
        market: &str,
        order_id: &str,
    ) -> Result<(), VenueError> {
        orders::cancel(market, order_id)?;
        let (rest, creds) = self.trader(account).await?;
        Self::cancel_on(rest, &creds, market, order_id).await
    }

    /// A limit order's price, size and attached TP and SL (BloFin changes
    /// nothing else). What isn't given is kept.
    async fn amend_order(
        &self,
        account: &TradingAccount,
        market: &str,
        order_id: &str,
        amend: &OrderAmend,
    ) -> Result<(), VenueError> {
        let (rest, creds) = self.trader(account).await?;
        let spec = self.spec(true, market).await?;
        let body = orders::amend(
            market,
            order_id,
            amend.size,
            amend.price,
            &amend.take_profit,
            &amend.stop_loss,
            &spec,
        )?;
        rest.post("/api/v1/trade/amend-order", &body, &creds)
            .await?;
        Ok(())
    }

    /// A whole number from 1 to the market's highest, in the account's
    /// margin mode.
    async fn set_leverage(
        &self,
        account: &TradingAccount,
        market: &str,
        leverage: Decimal,
    ) -> Result<(), VenueError> {
        let (rest, creds) = self.trader(account).await?;
        let spec = self.spec(true, market).await?;
        let (mode, _) = rest.modes(&creds).await?;
        let body = orders::leverage(market, leverage, spec.max_leverage, mode)?;
        rest.post("/api/v1/account/set-leverage", &body, &creds)
            .await?;
        Ok(())
    }

    /// Cross or isolated, for the whole account (BloFin sets it per account,
    /// `TradeSettings::margin_mode_account_wide`).
    async fn set_margin_mode(
        &self,
        account: &TradingAccount,
        market: &str,
        mode: MarginMode,
    ) -> Result<(), VenueError> {
        wire::validate_market(market)?;
        let (rest, creds) = self.trader(account).await?;
        let (current, _) = rest.modes(&creds).await?;
        if current == mode {
            return Ok(());
        }
        rest.post(
            "/api/v1/account/set-margin-mode",
            &orders::margin_mode(mode),
            &creds,
        )
        .await?;
        Ok(())
    }

    /// The position's take-profit and stop-loss, as one whole-position TP/SL
    /// order: changed leg by leg in place (`amend-tpsl`) where there's one,
    /// placed where there's none, cancelled once neither leg is left - so the
    /// position keeps its exits in between. Its trailing stop, a
    /// whole-position trailing algo order: BloFin holds one per position, so
    /// a new one replaces the old (placed first, or after cancelling it if
    /// BloFin won't hold two).
    async fn set_position_protection(
        &self,
        account: &TradingAccount,
        market: &str,
        protection: &PositionProtection,
    ) -> Result<(), VenueError> {
        if protection.trailing_activation.is_some()
            && !matches!(protection.trailing_stop, ExitChange::Set(_))
        {
            return Err(VenueError::InvalidRequest(
                "an activation price goes with a trailing stop being set".into(),
            ));
        }
        let (rest, creds) = self.trader(account).await?;
        let spec = self.spec(true, market).await?;
        let mode = Self::one_way(rest, &creds).await?;
        let on_market = [("instId", market.to_owned())];
        let (positions, tpsl, algos, (quote, last)) = tokio::try_join!(
            rest.signed_get::<Vec<account::WirePosition>>(
                "/api/v1/account/positions",
                &on_market,
                &creds
            ),
            rest.signed_get::<Vec<account::WireTpsl>>(
                "/api/v1/trade/orders-tpsl-pending",
                &on_market,
                &creds
            ),
            rest.algos(&creds, Some(market)),
            rest.quote(market),
        )?;
        let long = positions
            .iter()
            .find(|p| p.inst_id == market && !p.positions.0.is_zero())
            .map(account::WirePosition::long)
            .ok_or_else(|| {
                VenueError::InvalidRequest("there's no open position on this market".into())
            })?;
        let closing = if long { "sell" } else { "buy" };

        // The take-profit and stop-loss.
        let (tp, sl) = (&protection.take_profit, &protection.stop_loss);
        if *tp != ExitChange::Keep || *sl != ExitChange::Keep {
            let existing: Vec<&account::WireTpsl> = tpsl
                .iter()
                .filter(|o| o.inst_id == market && o.whole() && o.side == closing)
                .collect();
            let current = |pick: fn(&account::WireTpsl) -> Option<Decimal>| {
                existing
                    .iter()
                    .find_map(|o| pick(o).filter(|p| p.0 > rust_decimal::Decimal::ZERO))
            };
            let after = |change: &ExitChange, now: Option<Decimal>| match change {
                ExitChange::Keep => now,
                ExitChange::Remove => None,
                ExitChange::Set(p) => Some(*p),
            };
            let tp_after = after(tp, current(|o| o.tp_trigger_price));
            let sl_after = after(sl, current(|o| o.sl_trigger_price));
            let cancel_all = |ids: Vec<String>| {
                let creds = &creds;
                async move {
                    for id in ids {
                        Self::cancel_on(rest, creds, market, &id).await?;
                    }
                    Ok::<(), VenueError>(())
                }
            };
            let ids = |orders: &[&account::WireTpsl]| -> Vec<String> {
                orders
                    .iter()
                    .map(|o| format!("{}{}", orders::TPSL_PREFIX, o.tpsl_id))
                    .collect()
            };
            match existing.as_slice() {
                _ if tp_after.is_none() && sl_after.is_none() => cancel_all(ids(&existing)).await?,
                [] => {
                    let body = orders::position_tpsl(
                        market, mode, long, tp_after, sl_after, &spec, &quote,
                    )?;
                    rest.post("/api/v1/trade/order-tpsl", &body, &creds).await?;
                }
                [one] => {
                    let body = orders::amend_position_tpsl(
                        market,
                        &one.tpsl_id,
                        long,
                        tp,
                        sl,
                        &spec,
                        &quote,
                    )?;
                    rest.post("/api/v1/trade/amend-tpsl", &body, &creds).await?;
                }
                // Several (set elsewhere): one new order with what they come
                // to, then the old ones go.
                several => {
                    let body = orders::position_tpsl(
                        market, mode, long, tp_after, sl_after, &spec, &quote,
                    )?;
                    rest.post("/api/v1/trade/order-tpsl", &body, &creds).await?;
                    cancel_all(ids(several)).await.map_err(|e| {
                        VenueError::Rejected(format!(
                            "the new exits are set, but older ones couldn't be cancelled ({e}); cancel them in Open orders"
                        ))
                    })?;
                }
            }
        }

        // The trailing stop.
        let trailing: Vec<String> = algos
            .iter()
            .filter(|a| a.inst_id == market && a.order_type == "trailing_stop" && a.side == closing)
            .map(|a| format!("{}{}", orders::TRAIL_PREFIX, a.algo_id))
            .collect();
        match protection.trailing_stop {
            ExitChange::Keep => {}
            ExitChange::Remove => {
                for id in trailing {
                    Self::cancel_on(rest, &creds, market, &id).await?;
                }
            }
            ExitChange::Set(distance) => {
                let body = orders::trailing_stop(
                    market,
                    mode,
                    long,
                    distance,
                    protection.trailing_activation,
                    &spec,
                    last,
                )?;
                match rest.post("/api/v1/trade/order-algo", &body, &creds).await {
                    Ok(_) => {
                        for id in trailing {
                            Self::cancel_on(rest, &creds, market, &id).await.map_err(|e| {
                                VenueError::Rejected(format!(
                                    "the new trailing stop is set, but the one it replaces couldn't be cancelled ({e}); cancel it in Open orders"
                                ))
                            })?;
                        }
                    }
                    // Refused with an old one still there: take that off,
                    // then try again.
                    Err(_) if !trailing.is_empty() => {
                        for id in trailing {
                            Self::cancel_on(rest, &creds, market, &id).await?;
                        }
                        rest.post("/api/v1/trade/order-algo", &body, &creds).await?;
                    }
                    Err(e) => return Err(e),
                }
            }
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn query_values_are_encoded_before_signing() {
        assert_eq!(encode("BTC-USDT"), "BTC-USDT");
        assert_eq!(encode("0.001"), "0.001");
        assert_eq!(encode("BTC-USDT,ETH-USDT"), "BTC-USDT%2CETH-USDT");
        assert_eq!(encode("1&instId=ETH-USDT"), "1%26instId%3DETH-USDT");
        assert_eq!(
            query_string(&[("instId", "BTC-USDT".into()), ("side", "buy".into())]),
            "instId=BTC-USDT&side=buy"
        );
    }

    #[test]
    fn pushes_read_as_lists_of_rows() {
        use serde_json::json;
        assert_eq!(rows(json!([{"a":1},{"a":2}])).len(), 2);
        assert_eq!(rows(json!([["1", "2"]])).len(), 1);
        // A single candle row, not a list of them.
        assert_eq!(
            rows(json!(["1696636800000", "27491.5"])),
            vec![json!(["1696636800000", "27491.5"])]
        );
        assert_eq!(rows(json!({"a":1})).len(), 1);
        assert!(rows(Value::Null).is_empty());
    }

    #[test]
    fn a_live_account_never_reaches_a_key() {
        let adapter = BlofinAdapter::new(&constants::MAINNET).unwrap();
        let rt = tokio::runtime::Builder::new_current_thread()
            .build()
            .unwrap();
        let live = TradingAccount {
            address: "20923487".into(),
            key: "blofin:20923487".into(),
        };
        assert!(matches!(
            rt.block_on(adapter.trader(&live)),
            Err(VenueError::Rejected(_))
        ));
        let other = TradingAccount {
            address: "demo:20923487".into(),
            key: "binance:demo:20923487".into(),
        };
        assert!(matches!(
            rt.block_on(adapter.trader(&other)),
            Err(VenueError::InvalidRequest(_))
        ));
    }
}
