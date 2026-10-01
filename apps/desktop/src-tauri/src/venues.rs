//! Tauri commands exposing the venue adapters - the only way the UI reaches a
//! venue. Read-only so far: markets, order books, trades, candles, market
//! stats, summaries and history, funding history, and account state, from
//! Hyperliquid, Aster and Bybit.
//!
//! Security invariants - review any change here against
//! `.claude/commands/security-review.md`:
//! - These commands and `ExchangeAdapter` together are the whole signing
//!   surface. When orders land, they add place and cancel, nothing else.
//! - No command takes a URL or host. Adapters connect only to the endpoints
//!   fixed in their own crate.

use std::collections::HashMap;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Arc, Mutex};

use pewterdesk_core::{
    AccountSnapshot, Candle, CandleInterval, ExchangeAdapter, Fill, FundingPayment, FundingRate,
    Market, MarketHistory, MarketStats, MarketSummary, Order, OrderBook, Trade, VenueError,
    VenueId,
};
use pewterdesk_exchange_aster::{constants::MAINNET as ASTER_MAINNET, AsterAdapter};
use pewterdesk_exchange_bybit::{constants::MAINNET as BYBIT_MAINNET, BybitAdapter};
use pewterdesk_exchange_hyperliquid::{constants::MAINNET, HyperliquidAdapter};
use serde::Serialize;
use tauri::async_runtime::{self, JoinHandle};
use tauri::ipc::Channel;
use tauri::State;
use tokio::sync::mpsc;

/// One message on a subscription's channel. `closed` is final: the venue ended
/// the stream (e.g. it rejected the market), and nothing more will arrive.
#[derive(Clone, Serialize)]
#[serde(tag = "event", content = "data", rename_all = "camelCase")]
pub enum StreamEvent<T> {
    Update(T),
    Closed,
}

pub struct Venues {
    hyperliquid: HyperliquidAdapter,
    aster: AsterAdapter,
    bybit: BybitAdapter,
    subscriptions: Arc<Mutex<HashMap<u32, JoinHandle<()>>>>,
    next_id: AtomicU32,
}

impl Venues {
    pub fn new() -> Result<Self, VenueError> {
        Ok(Self {
            hyperliquid: HyperliquidAdapter::new(&MAINNET)?,
            aster: AsterAdapter::new(&ASTER_MAINNET)?,
            bybit: BybitAdapter::new(&BYBIT_MAINNET)?,
            subscriptions: Arc::default(),
            next_id: AtomicU32::new(1),
        })
    }

    /// Hyperliquid's own methods beyond `ExchangeAdapter`, for onboarding.
    pub fn hyperliquid(&self) -> &HyperliquidAdapter {
        &self.hyperliquid
    }

    fn adapter(&self, venue: VenueId) -> Result<&dyn ExchangeAdapter, VenueError> {
        match venue {
            VenueId::Hyperliquid => Ok(&self.hyperliquid),
            VenueId::Aster => Ok(&self.aster),
            VenueId::Bybit => Ok(&self.bybit),
        }
    }

    /// Forwards `rx` to the webview until it ends or `unsubscribe` is called.
    fn forward<T>(&self, mut rx: mpsc::Receiver<T>, channel: Channel<StreamEvent<T>>) -> u32
    where
        T: Clone + Serialize + Send + 'static,
    {
        let id = self.next_id.fetch_add(1, Ordering::Relaxed);
        let subscriptions = Arc::clone(&self.subscriptions);
        // Held until the task is registered, so its own removal can't run first.
        let mut registry = self.subscriptions.lock().unwrap();
        let task = async_runtime::spawn(async move {
            while let Some(item) = rx.recv().await {
                if channel.send(StreamEvent::Update(item)).is_err() {
                    break;
                }
            }
            let _ = channel.send(StreamEvent::Closed);
            subscriptions.lock().unwrap().remove(&id);
        });
        registry.insert(id, task);
        id
    }
}

#[tauri::command]
pub async fn markets(venues: State<'_, Venues>, venue: VenueId) -> Result<Vec<Market>, VenueError> {
    venues.adapter(venue)?.markets().await
}

#[tauri::command]
pub async fn order_book(
    venues: State<'_, Venues>,
    venue: VenueId,
    market: String,
) -> Result<OrderBook, VenueError> {
    venues.adapter(venue)?.order_book(&market).await
}

#[tauri::command]
pub async fn account(
    venues: State<'_, Venues>,
    venue: VenueId,
    address: String,
) -> Result<AccountSnapshot, VenueError> {
    venues.adapter(venue)?.account(&address).await
}

#[tauri::command]
pub async fn fills(
    venues: State<'_, Venues>,
    venue: VenueId,
    address: String,
) -> Result<Vec<Fill>, VenueError> {
    venues.adapter(venue)?.fills(&address).await
}

#[tauri::command]
pub async fn funding_payments(
    venues: State<'_, Venues>,
    venue: VenueId,
    address: String,
    start_time: u64,
) -> Result<Vec<FundingPayment>, VenueError> {
    venues
        .adapter(venue)?
        .funding_payments(&address, start_time)
        .await
}

#[tauri::command]
pub async fn order_history(
    venues: State<'_, Venues>,
    venue: VenueId,
    address: String,
) -> Result<Vec<Order>, VenueError> {
    venues.adapter(venue)?.order_history(&address).await
}

/// Returns the id to pass to `unsubscribe`.
#[tauri::command]
pub async fn subscribe_order_book(
    venues: State<'_, Venues>,
    venue: VenueId,
    market: String,
    on_event: Channel<StreamEvent<OrderBook>>,
) -> Result<u32, VenueError> {
    let rx = venues.adapter(venue)?.subscribe_order_book(&market).await?;
    Ok(venues.forward(rx, on_event))
}

/// Returns the id to pass to `unsubscribe`.
#[tauri::command]
pub async fn subscribe_trades(
    venues: State<'_, Venues>,
    venue: VenueId,
    market: String,
    on_event: Channel<StreamEvent<Vec<Trade>>>,
) -> Result<u32, VenueError> {
    let rx = venues.adapter(venue)?.subscribe_trades(&market).await?;
    Ok(venues.forward(rx, on_event))
}

/// Returns the id to pass to `unsubscribe`.
#[tauri::command]
pub async fn subscribe_market_stats(
    venues: State<'_, Venues>,
    venue: VenueId,
    market: String,
    on_event: Channel<StreamEvent<MarketStats>>,
) -> Result<u32, VenueError> {
    let rx = venues
        .adapter(venue)?
        .subscribe_market_stats(&market)
        .await?;
    Ok(venues.forward(rx, on_event))
}

/// Returns the id to pass to `unsubscribe`.
#[tauri::command]
pub async fn subscribe_candles(
    venues: State<'_, Venues>,
    venue: VenueId,
    market: String,
    interval: CandleInterval,
    on_event: Channel<StreamEvent<Vec<Candle>>>,
) -> Result<u32, VenueError> {
    let rx = venues
        .adapter(venue)?
        .subscribe_candles(&market, interval)
        .await?;
    Ok(venues.forward(rx, on_event))
}

/// Returns the id to pass to `unsubscribe`.
#[tauri::command]
pub async fn subscribe_market_summaries(
    venues: State<'_, Venues>,
    venue: VenueId,
    on_event: Channel<StreamEvent<Vec<MarketSummary>>>,
) -> Result<u32, VenueError> {
    let rx = venues.adapter(venue)?.subscribe_market_summaries().await?;
    Ok(venues.forward(rx, on_event))
}

/// Returns the id to pass to `unsubscribe`.
#[tauri::command]
pub async fn subscribe_market_history(
    venues: State<'_, Venues>,
    venue: VenueId,
    on_event: Channel<StreamEvent<MarketHistory>>,
) -> Result<u32, VenueError> {
    let rx = venues.adapter(venue)?.subscribe_market_history().await?;
    Ok(venues.forward(rx, on_event))
}

/// Older candles for a chart scrolled back past what it has.
#[tauri::command]
pub async fn candles(
    venues: State<'_, Venues>,
    venue: VenueId,
    market: String,
    interval: CandleInterval,
    before: u64,
    count: u32,
) -> Result<Vec<Candle>, VenueError> {
    venues
        .adapter(venue)?
        .candles(&market, interval, before, count)
        .await
}

#[tauri::command]
pub async fn funding_history(
    venues: State<'_, Venues>,
    venue: VenueId,
    market: String,
    start_time: u64,
) -> Result<Vec<FundingRate>, VenueError> {
    venues
        .adapter(venue)?
        .funding_history(&market, start_time)
        .await
}

/// A market's logo as SVG markup, or `None`. The frontend renders it only as
/// an `<img>` with a `data:` URL.
#[tauri::command]
pub async fn market_icon(
    venues: State<'_, Venues>,
    venue: VenueId,
    market: String,
) -> Result<Option<String>, VenueError> {
    venues.adapter(venue)?.market_icon(&market).await
}

/// Returns the id to pass to `unsubscribe`.
#[tauri::command]
pub async fn subscribe_account(
    venues: State<'_, Venues>,
    venue: VenueId,
    address: String,
    on_event: Channel<StreamEvent<AccountSnapshot>>,
) -> Result<u32, VenueError> {
    let rx = venues.adapter(venue)?.subscribe_account(&address).await?;
    Ok(venues.forward(rx, on_event))
}

/// Idempotent: an unknown or already-ended id is fine. Dropping the forwarding
/// task drops the adapter's receiver, which closes the venue connection.
#[tauri::command]
pub fn unsubscribe(venues: State<'_, Venues>, id: u32) {
    if let Some(task) = venues.subscriptions.lock().unwrap().remove(&id) {
        task.abort();
    }
}
