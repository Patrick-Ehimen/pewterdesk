//! Aster adapter (Aster Chain, an order-book perp L1; deposits bridge in from
//! BNB Chain, Ethereum, Arbitrum and Solana). Read-only so far: public market
//! data over the Futures REST API and combined-stream WebSocket, none of which
//! needs a key.
//!
//! Aster is Binance-style: market ids are its symbols (`BTCUSDT`), and each
//! stream is seeded over REST before going live, which also turns an unknown
//! market into an error (the streams ignore one silently).
//!
//! Account data isn't available yet. Unlike Hyperliquid, Aster serves even an
//! account's balances only to a request signed by an API wallet, so the
//! account methods wait for the `KeySource`. That API wallet is the trade-only
//! key only when created without withdraw permission: onboarding must check
//! before storing it, and the adapter before signing - see
//! docs/adr/0002-launch-venues.md.

pub mod constants;
mod icons;
mod tape;
mod wire;
mod ws;

use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use async_trait::async_trait;
use pewterdesk_core::{
    AccountSnapshot, Candle, CandleInterval, Capabilities, Decimal, ExchangeAdapter, FundingRate,
    Market, MarketHistory, MarketStats, MarketSummary, Order, OrderBook, OrderRequest, OrderType,
    Trade, TradingAccount, VenueError, VenueId,
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
            let body = response.text().await.unwrap_or_default();
            let msg = serde_json::from_str::<wire::ApiError>(&body).map_or(body, |e| e.msg);
            return Err(VenueError::InvalidRequest(msg));
        }
        if !status.is_success() {
            return Err(VenueError::Network(format!("Aster API returned {status}")));
        }
        response
            .json()
            .await
            .map_err(|e| VenueError::Network(format!("unexpected Aster response: {e}")))
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
        })
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

const NO_ACCOUNT_DATA: &str =
    "Aster account data (it needs a request signed by an API wallet, not set up yet)";

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
    /// `icons`). `None` for an asset without one.
    async fn market_icon(&self, market: &str) -> Result<Option<String>, VenueError> {
        wire::validate_market(market)?;
        if let Some(cached) = self.icons.lock().unwrap().get(market) {
            return Ok(cached.clone());
        }
        let meta = self.meta().await?;
        let url = match meta.bases.get(market) {
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

    async fn account(&self, _address: &str) -> Result<AccountSnapshot, VenueError> {
        Err(VenueError::Unsupported(NO_ACCOUNT_DATA))
    }

    async fn subscribe_account(
        &self,
        _address: &str,
    ) -> Result<mpsc::Receiver<AccountSnapshot>, VenueError> {
        Err(VenueError::Unsupported(NO_ACCOUNT_DATA))
    }

    async fn place_order(
        &self,
        _account: &TradingAccount,
        _request: &OrderRequest,
    ) -> Result<Order, VenueError> {
        Err(VenueError::Unsupported(
            "order placement (not implemented yet)",
        ))
    }

    async fn cancel_order(
        &self,
        _account: &TradingAccount,
        _market: &str,
        _order_id: &str,
    ) -> Result<(), VenueError> {
        Err(VenueError::Unsupported(
            "order cancellation (not implemented yet)",
        ))
    }
}
