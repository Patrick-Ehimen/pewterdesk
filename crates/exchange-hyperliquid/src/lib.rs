//! Hyperliquid adapter. Read-only so far: markets, order books, the trade tape,
//! market stats and account state over the public info API and WebSocket feed,
//! none of which need a key.
//!
//! Markets include the builder-deployed perp exchanges (HIP-3). Their ids
//! carry the exchange ("xyz:TSLA"), which every info request and channel
//! takes as-is, so only the market list and the summaries treat them apart.
//!
//! Order placement lands next with its signer (EIP-712 over the msgpack action
//! hash, with an API/agent wallet as the trade-only key) and the `KeySource`
//! the adapter takes in its constructor. The signer is security-sensitive -
//! see docs/adr/0001-venues-in-rust.md.

pub mod agent;
pub mod constants;
mod icons;
mod stats;
mod tape;
mod wire;
mod ws;

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use async_trait::async_trait;
use pewterdesk_core::{
    AccountSnapshot, Candle, CandleInterval, Capabilities, ExchangeAdapter, Fill, FundingPayment,
    FundingRate, Market, MarketHistory, MarketStats, MarketSummary, Order, OrderBook, OrderRequest,
    OrderType, Trade, TradingAccount, VenueError, VenueId,
};
use serde::de::DeserializeOwned;
use serde_json::{json, Value};
use tokio::sync::{mpsc, Semaphore};
use tokio::time::MissedTickBehavior;

use constants::Endpoints;
use stats::{DayRange, HOUR_MS};
use tape::Tape;
use wire::{
    ClearinghouseState, Meta, OpenOrder, PerpAssetCtx, WsActiveAssetCtx, WsClearinghouseState,
    WsOpenOrders, WsTrade,
};
use ws::Handled;

const REQUEST_TIMEOUT: Duration = Duration::from_secs(10);
/// Candles of history sent before live updates.
const CANDLE_HISTORY: u64 = 500;
/// There's no channel with every market's context, so the screener polls.
const SUMMARY_POLL: Duration = Duration::from_secs(5);
/// Hourly candles fetched per market for screening: 7 days.
const HISTORY_HOURS: u64 = 7 * 24;
/// One market's history per this long. Candle snapshots are among the heavier
/// info calls; at this pace the history loop and the summary poll together
/// stay well under Hyperliquid's per-IP request budget.
const HISTORY_PACE: Duration = Duration::from_secs(2);
/// Logo downloads in flight at once; the screener asks for every market's.
const ICON_FETCHES: usize = 6;
/// The most candles one `candles` call asks for: all the venue keeps (it has
/// only about the latest 5,000 per interval), in one request.
const MAX_CANDLE_PAGE: u32 = 5000;
/// Hyperliquid returns at most this many funding payments per request.
const FUNDING_PAGE: usize = 500;
/// Pages fetched per `funding_history` call at most: 5,000 hourly payments,
/// about seven months. Bounds the requests one call can make.
const FUNDING_MAX_PAGES: usize = 10;
/// Least time between refetches of every exchange's market list, when the
/// all-exchanges feed shows a listing the adapter doesn't know yet.
const META_REFRESH: Duration = Duration::from_secs(60);

/// Listed markets, busiest (by 24h notional volume) first.
/// Every perp exchange's markets, main first: one entry per exchange.
async fn all_perp_metas(
    http: &reqwest::Client,
    endpoints: &Endpoints,
) -> Result<Vec<Meta>, VenueError> {
    post_info(http, endpoints, json!({ "type": "allPerpMetas" })).await
}

/// Every live market on every exchange, busiest first. One request for the
/// exchange list, then one per exchange that has live markets.
async fn markets_by_volume(
    http: &reqwest::Client,
    endpoints: &Endpoints,
) -> Result<Vec<String>, VenueError> {
    let metas = all_perp_metas(http, endpoints).await?;
    let (meta, ctxs): (Meta, Vec<PerpAssetCtx>) =
        post_info(http, endpoints, json!({ "type": "metaAndAssetCtxs" })).await?;
    let mut summaries = wire::market_summaries(meta, ctxs);
    for dex in metas
        .iter()
        .filter(|m| m.has_live_markets())
        .filter_map(Meta::dex)
    {
        // One exchange failing shouldn't cost the rest their history.
        let Ok((meta, ctxs)) = post_info::<(Meta, Vec<PerpAssetCtx>)>(
            http,
            endpoints,
            json!({ "type": "metaAndAssetCtxs", "dex": dex }),
        )
        .await
        else {
            continue;
        };
        summaries.extend(wire::market_summaries(meta, ctxs));
    }
    summaries.sort_by_key(|s| std::cmp::Reverse(s.day_volume));
    Ok(summaries.into_iter().map(|s| s.market).collect())
}

/// The main exchange's summaries, polled.
async fn main_summaries(
    http: &reqwest::Client,
    endpoints: &Endpoints,
) -> Result<Vec<MarketSummary>, VenueError> {
    let (meta, ctxs): (Meta, Vec<PerpAssetCtx>) =
        post_info(http, endpoints, json!({ "type": "metaAndAssetCtxs" })).await?;
    Ok(wire::market_summaries(meta, ctxs))
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| d.as_millis() as u64)
}

pub struct HyperliquidAdapter {
    http: reqwest::Client,
    endpoints: &'static Endpoints,
    /// For logos only. Never follows a redirect, so it can't be sent off
    /// Hyperliquid's own host.
    assets: reqwest::Client,
    /// Logos by market id, `None` for markets without one. Kept for the
    /// session; failed downloads aren't cached, so they're retried.
    icons: Mutex<HashMap<String, Option<String>>>,
    icon_fetches: Semaphore,
}

/// POSTs to the info API. A free function so background tasks (the screener
/// poller) can use it without borrowing the adapter.
async fn post_info<T: DeserializeOwned>(
    http: &reqwest::Client,
    endpoints: &Endpoints,
    request: Value,
) -> Result<T, VenueError> {
    let response = http
        .post(format!("{}/info", endpoints.rest))
        .json(&request)
        .send()
        .await
        .map_err(|e| VenueError::Network(e.without_url().to_string()))?;

    let status = response.status();
    if status.is_client_error() && status.as_u16() != 429 {
        let body = response.text().await.unwrap_or_default();
        return Err(VenueError::InvalidRequest(body));
    }
    if !status.is_success() {
        return Err(VenueError::Network(format!("info API returned {status}")));
    }
    response
        .json()
        .await
        .map_err(|e| VenueError::Network(format!("unexpected info response: {e}")))
}

impl HyperliquidAdapter {
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
            http,
            endpoints,
            assets,
            icons: Mutex::new(HashMap::new()),
            icon_fetches: Semaphore::new(ICON_FETCHES),
        })
    }

    async fn fetch_icon(&self, name: &str) -> Result<Option<String>, VenueError> {
        let _permit = self
            .icon_fetches
            .acquire()
            .await
            .map_err(|_| VenueError::Network("icon fetches closed".into()))?;
        let response = self
            .assets
            .get(format!("{}/coins/{name}.svg", self.endpoints.assets))
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
        let content_type = response
            .headers()
            .get(reqwest::header::CONTENT_TYPE)
            .and_then(|v| v.to_str().ok())
            .map(str::to_owned);
        let body = response
            .bytes()
            .await
            .map_err(|e| VenueError::Network(e.without_url().to_string()))?;
        Ok(icons::as_svg(content_type.as_deref(), &body))
    }

    async fn info<T: DeserializeOwned>(&self, request: Value) -> Result<T, VenueError> {
        post_info(&self.http, self.endpoints, request).await
    }

    /// The API (agent) wallets `user` has approved. Read-only and keyless:
    /// onboarding checks a pasted key's address against this before storing it.
    pub async fn approved_agents(
        &self,
        user: &str,
    ) -> Result<Vec<agent::ApprovedAgent>, VenueError> {
        validate_address(user)?;
        self.info(json!({ "type": "extraAgents", "user": user }))
            .await
    }

    async fn open_orders(&self, address: &str) -> Result<Vec<OpenOrder>, VenueError> {
        self.info(json!({ "type": "frontendOpenOrders", "user": address }))
            .await
    }
}

/// Hyperliquid addresses are 20-byte hex. Checked here so a typo is a clear
/// error rather than the venue's generic 422.
fn validate_address(address: &str) -> Result<(), VenueError> {
    let hex = address.strip_prefix("0x").unwrap_or("");
    if hex.len() == 40 && hex.bytes().all(|b| b.is_ascii_hexdigit()) {
        Ok(())
    } else {
        Err(VenueError::InvalidRequest(
            "address must be 0x followed by 40 hex characters".into(),
        ))
    }
}

#[async_trait]
impl ExchangeAdapter for HyperliquidAdapter {
    fn venue(&self) -> VenueId {
        VenueId::Hyperliquid
    }

    fn capabilities(&self) -> Capabilities {
        Capabilities {
            order_book: true,
            order_types: vec![OrderType::Market, OrderType::Limit, OrderType::Trigger],
            isolated_collateral: false,
        }
    }

    async fn markets(&self) -> Result<Vec<Market>, VenueError> {
        let metas = all_perp_metas(&self.http, self.endpoints).await?;
        // Only a live exchange settling in something other than USDC needs
        // the spot token list to name its quote.
        let other_collateral = metas
            .iter()
            .any(|m| m.collateral_token != wire::USDC_TOKEN && m.has_live_markets());
        let spot: Option<wire::SpotMeta> = if other_collateral {
            self.info(json!({ "type": "spotMeta" })).await.ok()
        } else {
            None
        };
        Ok(wire::markets(metas, spot.as_ref()))
    }

    async fn order_book(&self, market: &str) -> Result<OrderBook, VenueError> {
        // An unknown coin comes back as `null`, not an error.
        let book: Option<wire::L2Book> = self
            .info(json!({ "type": "l2Book", "coin": market }))
            .await?;
        book.map(wire::order_book)
            .ok_or_else(|| VenueError::InvalidRequest(format!("unknown market {market:?}")))
    }

    async fn subscribe_order_book(
        &self,
        market: &str,
    ) -> Result<mpsc::Receiver<OrderBook>, VenueError> {
        let subscription = json!({ "type": "l2Book", "coin": market });
        ws::subscribe(
            self.endpoints.ws,
            vec![subscription],
            |message| match message.channel.as_str() {
                "l2Book" => match serde_json::from_value(message.data) {
                    Ok(book) => Handled::Emit(wire::order_book(book)),
                    Err(_) => Handled::Ignore,
                },
                "error" => Handled::Stop,
                _ => Handled::Ignore,
            },
        )
        .await
    }

    /// The channel pushes recent trades on subscribing, then each new batch;
    /// the tape turns that into snapshots.
    async fn subscribe_trades(
        &self,
        market: &str,
    ) -> Result<mpsc::Receiver<Vec<Trade>>, VenueError> {
        let subscription = json!({ "type": "trades", "coin": market });
        let mut tape = Tape::default();
        ws::subscribe(
            self.endpoints.ws,
            vec![subscription],
            move |message| match message.channel.as_str() {
                "trades" => {
                    let Ok(pushed) = serde_json::from_value::<Vec<WsTrade>>(message.data) else {
                        return Handled::Ignore;
                    };
                    // A print with an unknown side is skipped, not fatal.
                    let trades = pushed
                        .into_iter()
                        .filter_map(|t| wire::trade(t).ok())
                        .collect();
                    if tape.record(trades) {
                        Handled::Emit(tape.snapshot())
                    } else {
                        Handled::Ignore
                    }
                }
                "error" => Handled::Stop,
                _ => Handled::Ignore,
            },
        )
        .await
    }

    /// Live context over `activeAssetCtx`, plus the day's high/low from hourly
    /// candles: the last 25 fetched once, then the current one kept up to date
    /// over the `candle` channel on the same connection. Emits whenever either
    /// changes, once the context has arrived.
    async fn subscribe_market_stats(
        &self,
        market: &str,
    ) -> Result<mpsc::Receiver<MarketStats>, VenueError> {
        let now = now_ms();
        let history: Vec<wire::Candle> = self
            .info(json!({
                "type": "candleSnapshot",
                "req": {
                    "coin": market,
                    "interval": "1h",
                    "startTime": now.saturating_sub(25 * HOUR_MS),
                    "endTime": now,
                },
            }))
            .await?;
        let mut range = DayRange::default();
        for candle in history {
            range.record(candle.t, candle.h, candle.l);
        }

        let coin = market.to_owned();
        let subscriptions = vec![
            json!({ "type": "activeAssetCtx", "coin": market }),
            json!({ "type": "candle", "coin": market, "interval": "1h" }),
        ];
        let mut ctx: Option<PerpAssetCtx> = None;
        ws::subscribe(self.endpoints.ws, subscriptions, move |message| {
            match message.channel.as_str() {
                "activeAssetCtx" => {
                    match serde_json::from_value::<WsActiveAssetCtx>(message.data) {
                        Ok(pushed) if pushed.coin == coin => ctx = Some(pushed.ctx),
                        _ => return Handled::Ignore,
                    }
                }
                "candle" => match serde_json::from_value::<wire::Candle>(message.data) {
                    Ok(candle) => range.record(candle.t, candle.h, candle.l),
                    Err(_) => return Handled::Ignore,
                },
                "error" => return Handled::Stop,
                _ => return Handled::Ignore,
            }
            let Some(ctx) = &ctx else {
                return Handled::Ignore;
            };
            let now = now_ms();
            Handled::Emit(wire::market_stats(coin.clone(), ctx, range.range(now), now))
        })
        .await
    }

    /// History over REST, then the live `candle` channel. A forwarding task
    /// sends the history first so a consumer can't see a live candle before
    /// the series it belongs to.
    async fn subscribe_candles(
        &self,
        market: &str,
        interval: CandleInterval,
    ) -> Result<mpsc::Receiver<Vec<Candle>>, VenueError> {
        let code = wire::interval_code(interval);
        let now = now_ms();
        let history: Vec<wire::Candle> = self
            .info(json!({
                "type": "candleSnapshot",
                "req": {
                    "coin": market,
                    "interval": code,
                    "startTime": now.saturating_sub(CANDLE_HISTORY * interval.millis()),
                    "endTime": now,
                },
            }))
            .await?;
        let history: Vec<Candle> = history.into_iter().map(wire::candle).collect();

        let coin = market.to_owned();
        let mut live = ws::subscribe(
            self.endpoints.ws,
            vec![json!({ "type": "candle", "coin": market, "interval": code })],
            move |message| match message.channel.as_str() {
                "candle" => match serde_json::from_value::<wire::Candle>(message.data) {
                    Ok(c) if c.s == coin && c.i == code => Handled::Emit(wire::candle(c)),
                    _ => Handled::Ignore,
                },
                "error" => Handled::Stop,
                _ => Handled::Ignore,
            },
        )
        .await?;

        let (tx, rx) = mpsc::channel(16);
        tokio::spawn(async move {
            if tx.send(history).await.is_err() {
                return;
            }
            loop {
                tokio::select! {
                    _ = tx.closed() => return,
                    next = live.recv() => match next {
                        Some(candle) => {
                            if tx.send(vec![candle]).await.is_err() {
                                return;
                            }
                        }
                        None => return,
                    },
                }
            }
        });
        Ok(rx)
    }

    /// Polls `metaAndAssetCtxs`, which carries every perp's context in one
    /// call, until the receiver is dropped. The first poll happens before
    /// returning so an unreachable venue is an error here; a later failed
    /// poll is skipped and the next one retries.
    /// The main exchange is polled every `SUMMARY_POLL`. The builder-deployed
    /// exchanges come from the `allDexsAssetCtxs` channel, which covers all of
    /// them in one push (about every 15s) at no cost to the request budget.
    /// Every message carries both, merged. If that channel can't connect, the
    /// main exchange carries on alone.
    async fn subscribe_market_summaries(
        &self,
    ) -> Result<mpsc::Receiver<Vec<MarketSummary>>, VenueError> {
        let http = self.http.clone();
        let endpoints = self.endpoints;
        let mut main = main_summaries(&http, endpoints).await?;

        // Shared with the channel handler, which can only flag them as stale;
        // the task below refetches them.
        let metas = Arc::new(Mutex::new(
            all_perp_metas(&http, endpoints).await.unwrap_or_default(),
        ));
        let stale = Arc::new(AtomicBool::new(false));
        let mut builders = {
            let metas = Arc::clone(&metas);
            let stale = Arc::clone(&stale);
            ws::subscribe(
                endpoints.ws,
                vec![json!({ "type": "allDexsAssetCtxs" })],
                move |message| match message.channel.as_str() {
                    "allDexsAssetCtxs" => {
                        let Ok(pushed) = serde_json::from_value(message.data) else {
                            return Handled::Ignore;
                        };
                        let (summaries, outdated) =
                            wire::builder_summaries(&metas.lock().unwrap(), pushed);
                        if outdated {
                            stale.store(true, Ordering::Relaxed);
                        }
                        Handled::Emit(summaries)
                    }
                    "error" => Handled::Stop,
                    _ => Handled::Ignore,
                },
            )
            .await
            .ok()
        };

        let (tx, rx) = mpsc::channel(4);
        tokio::spawn(async move {
            let mut builder = Vec::new();
            let mut poll = tokio::time::interval(SUMMARY_POLL);
            poll.set_missed_tick_behavior(MissedTickBehavior::Delay);
            poll.tick().await; // The first tick is immediate; `main` is fresh.
            let mut refreshed_at: Option<Instant> = None;
            loop {
                let merged: Vec<MarketSummary> = main.iter().chain(&builder).cloned().collect();
                if tx.send(merged).await.is_err() {
                    return;
                }
                tokio::select! {
                    _ = tx.closed() => return,
                    _ = poll.tick() => {
                        if let Ok(fresh) = main_summaries(&http, endpoints).await {
                            main = fresh;
                        }
                    }
                    pushed = async {
                        match builders.as_mut() {
                            Some(rx) => rx.recv().await,
                            None => std::future::pending().await,
                        }
                    } => match pushed {
                        Some(fresh) => builder = fresh,
                        // The channel gave up; keep the main exchange going.
                        None => builders = None,
                    },
                }
                // A listing the metas don't know yet: refetch, but not often.
                let due = refreshed_at.is_none_or(|at| at.elapsed() >= META_REFRESH);
                if due && stale.swap(false, Ordering::Relaxed) {
                    refreshed_at = Some(Instant::now());
                    if let Ok(fresh) = all_perp_metas(&http, endpoints).await {
                        *metas.lock().unwrap() = fresh;
                    }
                }
            }
        });
        Ok(rx)
    }

    /// Walks the markets busiest first, one candle snapshot every
    /// `HISTORY_PACE`, then starts over with a fresh volume ranking. A market
    /// whose fetch fails is skipped until the next pass.
    async fn subscribe_market_history(&self) -> Result<mpsc::Receiver<MarketHistory>, VenueError> {
        let http = self.http.clone();
        let endpoints = self.endpoints;
        let mut order = markets_by_volume(&http, endpoints).await?;

        let (tx, rx) = mpsc::channel(8);
        tokio::spawn(async move {
            loop {
                for coin in &order {
                    tokio::select! {
                        _ = tx.closed() => return,
                        _ = tokio::time::sleep(HISTORY_PACE) => {}
                    }
                    let now = now_ms();
                    let candles: Result<Vec<wire::Candle>, _> = post_info(
                        &http,
                        endpoints,
                        json!({
                            "type": "candleSnapshot",
                            "req": {
                                "coin": coin,
                                "interval": "1h",
                                "startTime": now.saturating_sub(HISTORY_HOURS * HOUR_MS),
                                "endTime": now,
                            },
                        }),
                    )
                    .await;
                    let Ok(candles) = candles else { continue };
                    let history = MarketHistory {
                        market: coin.clone(),
                        interval: CandleInterval::OneHour,
                        candles: candles.into_iter().map(wire::candle).collect(),
                    };
                    if tx.send(history).await.is_err() {
                        return;
                    }
                }
                if let Ok(fresh) = markets_by_volume(&http, endpoints).await {
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
        let count = u64::from(count.clamp(1, MAX_CANDLE_PAGE));
        let candles: Vec<wire::Candle> = self
            .info(json!({
                "type": "candleSnapshot",
                "req": {
                    "coin": market,
                    "interval": wire::interval_code(interval),
                    "startTime": before.saturating_sub(count * interval.millis()),
                    "endTime": before.saturating_sub(1),
                },
            }))
            .await?;
        // Only candles that opened before `before`, whatever the venue rounds.
        Ok(candles
            .into_iter()
            .map(wire::candle)
            .filter(|c| c.open_time < before)
            .collect())
    }

    async fn funding_history(
        &self,
        market: &str,
        start_time: u64,
    ) -> Result<Vec<FundingRate>, VenueError> {
        // A request returns the oldest 500 from `startTime`, so page forward
        // from just after the last one until a short page says we're caught up.
        let mut rates = Vec::new();
        let mut from = start_time;
        for _ in 0..FUNDING_MAX_PAGES {
            let page: Vec<wire::FundingEntry> = self
                .info(json!({ "type": "fundingHistory", "coin": market, "startTime": from }))
                .await?;
            let full = page.len() >= FUNDING_PAGE;
            let Some(last) = page.last().map(|e| e.time) else {
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

    async fn market_icon(&self, market: &str) -> Result<Option<String>, VenueError> {
        let Some(name) = icons::icon_name(market) else {
            return Ok(None);
        };
        if let Some(cached) = self.icons.lock().unwrap().get(market) {
            return Ok(cached.clone());
        }
        let icon = self.fetch_icon(name).await?;
        self.icons
            .lock()
            .unwrap()
            .insert(market.to_owned(), icon.clone());
        Ok(icon)
    }

    async fn account(&self, address: &str) -> Result<AccountSnapshot, VenueError> {
        validate_address(address)?;
        let state = self.info(json!({ "type": "clearinghouseState", "user": address }));
        let (state, orders) = tokio::try_join!(state, self.open_orders(address))?;
        wire::account(address, state, orders)
    }

    async fn fills(&self, address: &str) -> Result<Vec<Fill>, VenueError> {
        validate_address(address)?;
        // Newest first, up to the venue's 2,000.
        let fills: Vec<wire::UserFill> = self
            .info(json!({ "type": "userFills", "user": address }))
            .await?;
        fills.into_iter().map(wire::fill).collect()
    }

    async fn funding_payments(
        &self,
        address: &str,
        start_time: u64,
    ) -> Result<Vec<FundingPayment>, VenueError> {
        validate_address(address)?;
        // Oldest first, 500 a page, like market funding: page forward, then
        // turn it round to newest first.
        let mut payments = Vec::new();
        let mut from = start_time;
        for _ in 0..FUNDING_MAX_PAGES {
            let page: Vec<wire::UserFunding> = self
                .info(json!({ "type": "userFunding", "user": address, "startTime": from }))
                .await?;
            let full = page.len() >= FUNDING_PAGE;
            let Some(last) = page.last().map(|p| p.time) else {
                break;
            };
            payments.extend(page.into_iter().map(wire::funding_payment));
            if !full {
                break;
            }
            from = last + 1;
        }
        payments.reverse();
        Ok(payments)
    }

    async fn order_history(&self, address: &str) -> Result<Vec<Order>, VenueError> {
        validate_address(address)?;
        // Up to the venue's 2,000, which it orders by when their status last
        // changed; sorted here by when they were placed, newest first.
        let orders: Vec<wire::HistoricalOrder> = self
            .info(json!({ "type": "historicalOrders", "user": address }))
            .await?;
        let mut orders = orders
            .into_iter()
            .map(wire::historical_order)
            .collect::<Result<Vec<_>, _>>()?;
        orders.sort_by_key(|o| std::cmp::Reverse(o.created_at));
        Ok(orders)
    }

    /// Two channels on one connection: a snapshot goes out once both have
    /// reported, then again whenever either changes.
    async fn subscribe_account(
        &self,
        address: &str,
    ) -> Result<mpsc::Receiver<AccountSnapshot>, VenueError> {
        validate_address(address)?;
        let address = address.to_owned();
        let subscriptions = vec![
            json!({ "type": "clearinghouseState", "user": address }),
            json!({ "type": "openOrders", "user": address }),
        ];

        let mut state: Option<ClearinghouseState> = None;
        let mut orders: Option<Vec<OpenOrder>> = None;
        ws::subscribe(self.endpoints.ws, subscriptions, move |message| {
            match message.channel.as_str() {
                "clearinghouseState" => {
                    match serde_json::from_value::<WsClearinghouseState>(message.data) {
                        Ok(pushed) => state = Some(pushed.clearinghouse_state),
                        Err(_) => return Handled::Ignore,
                    }
                }
                "openOrders" => match serde_json::from_value::<WsOpenOrders>(message.data) {
                    Ok(pushed) => orders = Some(pushed.orders),
                    Err(_) => return Handled::Ignore,
                },
                "error" => return Handled::Stop,
                _ => return Handled::Ignore,
            }
            let (Some(state), Some(orders)) = (&state, &orders) else {
                return Handled::Ignore;
            };
            match wire::account(&address, state.clone(), orders.clone()) {
                Ok(snapshot) => Handled::Emit(snapshot),
                Err(_) => Handled::Ignore,
            }
        })
        .await
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
