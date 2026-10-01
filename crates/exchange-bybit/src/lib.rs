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
//! requests signed with an API key. Its trade-only key is an API key created
//! with order permissions and without withdrawal; onboarding and signing
//! (HMAC over the request) get their own reviewed task - see
//! docs/adr/0001-venues-in-rust.md.

pub mod constants;
mod tape;
mod wire;
mod ws;

use std::collections::BTreeMap;
use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use async_trait::async_trait;
use pewterdesk_core::{
    AccountSnapshot, Candle, CandleInterval, Capabilities, ExchangeAdapter, FundingRate, Market,
    MarketHistory, MarketStats, MarketSummary, Order, OrderBook, OrderRequest, OrderType, Trade,
    TradingAccount, VenueError, VenueId,
};
use serde::de::DeserializeOwned;
use tokio::sync::mpsc;

use constants::Endpoints;
use tape::Tape;
use wire::{Book, Meta, Page, Ticker};
use ws::Handled;

const REQUEST_TIMEOUT: Duration = Duration::from_secs(10);
/// Levels per side sent to the UI.
const BOOK_DEPTH: usize = 20;
/// The stream depth the book is kept from (Bybit offers 1, 50, 200, 500).
const BOOK_STREAM_DEPTH: u32 = 50;
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
    endpoints: &'static Endpoints,
    /// Live perpetuals and their funding intervals, from the instrument
    /// list: fetched on first use and refreshed whenever `markets` runs.
    meta: tokio::sync::Mutex<Option<Arc<Meta>>>,
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
            rest: Rest {
                http,
                base: endpoints.rest,
            },
            endpoints,
            meta: tokio::sync::Mutex::new(None),
        })
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

const NO_ACCOUNT_DATA: &str =
    "Bybit account data (it needs requests signed with an API key, not set up yet)";

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
