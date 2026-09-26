//! Tauri commands exposing the venue adapters — the only way the UI reaches a
//! venue. Read-only so far: markets, order books and account state.
//!
//! Security invariants — review any change here against
//! `.claude/commands/security-review.md`:
//! - These commands and `ExchangeAdapter` together are the whole signing
//!   surface. When orders land, they add place and cancel, nothing else.
//! - No command takes a URL or host. Adapters connect only to the endpoints
//!   fixed in their own crate.

use std::collections::HashMap;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Arc, Mutex};

use pewterdesk_core::{AccountSnapshot, ExchangeAdapter, Market, OrderBook, VenueError, VenueId};
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
    subscriptions: Arc<Mutex<HashMap<u32, JoinHandle<()>>>>,
    next_id: AtomicU32,
}

impl Venues {
    pub fn new() -> Result<Self, VenueError> {
        Ok(Self {
            hyperliquid: HyperliquidAdapter::new(&MAINNET)?,
            subscriptions: Arc::default(),
            next_id: AtomicU32::new(1),
        })
    }

    fn adapter(&self, venue: VenueId) -> Result<&dyn ExchangeAdapter, VenueError> {
        match venue {
            VenueId::Hyperliquid => Ok(&self.hyperliquid),
            VenueId::Gmx | VenueId::Dydx | VenueId::Drift => {
                Err(VenueError::Unsupported("this venue isn't available yet"))
            }
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
