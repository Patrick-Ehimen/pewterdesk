//! Tauri commands exposing the venue adapters - the only way the UI reaches a
//! venue: markets, order books, trades, candles, market stats, summaries and
//! history, funding history and account state from Hyperliquid, Aster,
//! Bybit and Binance, and the trading commands.
//!
//! Security invariants - review any change here against
//! `.claude/commands/security-review.md`:
//! - These commands and `ExchangeAdapter` together are the whole signing
//!   surface: `place_order`, `cancel_order`, `amend_order` (an open order's
//!   price, size or attached TP/SL), `set_position_protection`
//!   (a position's TP, SL and trailing stop: protective, reduce-only), and
//!   the trading parameters `set_leverage` and `set_margin_mode` (they move
//!   no funds and open nothing), nothing else. Each is a thin wrapper
//!   around the engine's router (`pewterdesk_engine::Engine`), which builds
//!   the account's key reference itself and signs only for a Bybit demo or
//!   Binance Demo Trading account, or a live account (Bybit, Binance,
//!   Hyperliquid, Aster) with live trading turned on, once the trader's
//!   rules pass. Every venue implements all six, except a trailing stop on
//!   Hyperliquid, Aster and Binance.
//! - With "always on" (`daemon.rs`) the same six go to the daemon's engine
//!   instead - the same router and gate, in `pdd` - and are refused, not
//!   sent from here, while it can't be reached (cancels excepted).
//! - No command takes a URL or host. Adapters connect only to the endpoints
//!   fixed in their own crate.
//! - Bybit's and Binance's account reads are signed with the stored API
//!   key: the adapter gets the keychain as a `KeySource` and signs only its
//!   own fixed, read-only requests (balance, positions, open orders, history,
//!   leverage and margin mode).

use std::collections::HashMap;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Arc, Mutex};

use pewterdesk_core::{
    AccountSnapshot, Announcement, Candle, CandleInterval, ClosedTrade, Decimal, ExchangeAdapter,
    Fill, FundingPayment, FundingRate, Liquidation, LongShortPoint, MarginMode, Market,
    MarketHistory, MarketStats, MarketSummary, OpenInterestPoint, Order, OrderAmend, OrderBook,
    OrderRequest, Origin, PositionProtection, Trade, TradeSettings, VenueError, VenueId,
};
use pewterdesk_engine::{Adapters, Engine};
use pewterdesk_exchange_aster::{constants::MAINNET as ASTER_MAINNET, AsterAdapter};
use pewterdesk_exchange_binance::{constants::MAINNET as BINANCE_MAINNET, BinanceAdapter};
use pewterdesk_exchange_blofin::{constants::MAINNET as BLOFIN_MAINNET, BlofinAdapter};
use pewterdesk_exchange_bybit::{constants::MAINNET as BYBIT_MAINNET, BybitAdapter};
use pewterdesk_exchange_hyperliquid::{constants::MAINNET, HyperliquidAdapter};
use serde::Serialize;
use tauri::async_runtime::{self, JoinHandle};
use tauri::ipc::Channel;
use tauri::{State, Webview};
use tokio::sync::mpsc;

use crate::daemon::{self, DaemonLink};
use crate::econ_calendar::CalendarState;
use crate::keychain::KeychainKeySource;
use pewterdesk_protocol::rpc::{Call, Target};

/// One message on a subscription's channel. `closed` is final: the venue ended
/// the stream (e.g. it rejected the market), and nothing more will arrive.
#[derive(Clone, Serialize)]
#[serde(tag = "event", content = "data", rename_all = "camelCase")]
pub enum StreamEvent<T> {
    Update(T),
    Closed,
}

/// A stream to one webview (the main window or the tray panel).
struct Subscription {
    webview: String,
    task: JoinHandle<()>,
}

pub struct Venues {
    hyperliquid: HyperliquidAdapter,
    aster: AsterAdapter,
    bybit: BybitAdapter,
    binance: BinanceAdapter,
    blofin: BlofinAdapter,
    /// Each live stream's forwarding task, and the webview it streams to.
    subscriptions: Arc<Mutex<HashMap<u32, Subscription>>>,
    next_id: AtomicU32,
}

impl Venues {
    pub fn new() -> Result<Self, VenueError> {
        Ok(Self {
            // Orders take the stored API wallet's key from the keychain.
            hyperliquid: HyperliquidAdapter::new(&MAINNET)?.with_keys(Arc::new(KeychainKeySource)),
            // Account reads take the stored API wallet's key from the keychain.
            aster: AsterAdapter::new(&ASTER_MAINNET)?.with_keys(Arc::new(KeychainKeySource)),
            // Account reads take the stored API key from the keychain.
            bybit: BybitAdapter::new(&BYBIT_MAINNET)?.with_keys(Arc::new(KeychainKeySource)),
            // Account reads and orders take the stored API key from the keychain.
            binance: BinanceAdapter::new(&BINANCE_MAINNET)?.with_keys(Arc::new(KeychainKeySource)),
            // Account reads and orders (Demo Trading only) take the stored API key from the keychain.
            blofin: BlofinAdapter::new(&BLOFIN_MAINNET)?.with_keys(Arc::new(KeychainKeySource)),
            subscriptions: Arc::default(),
            next_id: AtomicU32::new(1),
        })
    }

    /// Hyperliquid's own methods beyond `ExchangeAdapter`, for onboarding.
    pub fn hyperliquid(&self) -> &HyperliquidAdapter {
        &self.hyperliquid
    }

    /// Aster's own methods beyond `ExchangeAdapter`, for onboarding.
    pub fn aster(&self) -> &AsterAdapter {
        &self.aster
    }

    pub fn bybit(&self) -> &BybitAdapter {
        &self.bybit
    }

    /// Binance's own methods beyond `ExchangeAdapter`, for onboarding.
    pub fn binance(&self) -> &BinanceAdapter {
        &self.binance
    }

    /// BloFin's own methods beyond `ExchangeAdapter`, for onboarding.
    pub fn blofin(&self) -> &BlofinAdapter {
        &self.blofin
    }

    pub(crate) fn adapter(&self, venue: VenueId) -> Result<&dyn ExchangeAdapter, VenueError> {
        match venue {
            VenueId::Hyperliquid => Ok(&self.hyperliquid),
            VenueId::Aster => Ok(&self.aster),
            VenueId::Bybit => Ok(&self.bybit),
            VenueId::Binance => Ok(&self.binance),
            VenueId::Blofin => Ok(&self.blofin),
        }
    }

    /// Ends every stream to `webview`. Called when it starts loading a page:
    /// a reload (or a language switch) drops the old page without it
    /// unsubscribing, and a send to a page that's gone doesn't fail, so its
    /// streams would otherwise run - and poll venues - for good.
    pub fn end_streams_for(&self, webview: &str) {
        let mut subscriptions = self.subscriptions.lock().unwrap();
        subscriptions.retain(|_, sub| {
            let keep = sub.webview != webview;
            if !keep {
                sub.task.abort();
            }
            keep
        });
    }

    /// Forwards `rx` to `webview`'s channel until it ends, `unsubscribe` is
    /// called, or that webview loads a new page.
    pub(crate) fn forward<T>(
        &self,
        mut rx: mpsc::Receiver<T>,
        channel: Channel<StreamEvent<T>>,
        webview: &Webview,
    ) -> u32
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
        registry.insert(
            id,
            Subscription {
                webview: webview.label().to_owned(),
                task,
            },
        );
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

/// The account's closed positions: the venue's recent ones, or with `since`
/// (ms since the epoch) those from then on, no further back than
/// `CLOSED_HISTORY_MS`.
#[tauri::command]
pub async fn closed_trades(
    venues: State<'_, Venues>,
    venue: VenueId,
    address: String,
    since: Option<u64>,
) -> Result<Vec<ClosedTrade>, VenueError> {
    /// How far back a caller may ask: half a year.
    const CLOSED_HISTORY_MS: u64 = 183 * 24 * 3_600_000;
    let adapter = venues.adapter(venue)?;
    match since {
        None => adapter.closed_trades(&address).await,
        Some(since) => {
            let now = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map_or(0, |d| d.as_millis() as u64);
            let floor = now.saturating_sub(CLOSED_HISTORY_MS);
            adapter
                .closed_trades_since(&address, since.max(floor))
                .await
        }
    }
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
    webview: Webview,
    venue: VenueId,
    market: String,
    on_event: Channel<StreamEvent<OrderBook>>,
) -> Result<u32, VenueError> {
    let rx = venues.adapter(venue)?.subscribe_order_book(&market).await?;
    Ok(venues.forward(rx, on_event, &webview))
}

/// Returns the id to pass to `unsubscribe`.
#[tauri::command]
pub async fn subscribe_trades(
    venues: State<'_, Venues>,
    webview: Webview,
    venue: VenueId,
    market: String,
    on_event: Channel<StreamEvent<Vec<Trade>>>,
) -> Result<u32, VenueError> {
    let rx = venues.adapter(venue)?.subscribe_trades(&market).await?;
    Ok(venues.forward(rx, on_event, &webview))
}

/// Returns the id to pass to `unsubscribe`.
#[tauri::command]
pub async fn subscribe_market_stats(
    venues: State<'_, Venues>,
    webview: Webview,
    venue: VenueId,
    market: String,
    on_event: Channel<StreamEvent<MarketStats>>,
) -> Result<u32, VenueError> {
    let rx = venues
        .adapter(venue)?
        .subscribe_market_stats(&market)
        .await?;
    Ok(venues.forward(rx, on_event, &webview))
}

/// Returns the id to pass to `unsubscribe`.
#[tauri::command]
pub async fn subscribe_candles(
    venues: State<'_, Venues>,
    webview: Webview,
    venue: VenueId,
    market: String,
    interval: CandleInterval,
    on_event: Channel<StreamEvent<Vec<Candle>>>,
) -> Result<u32, VenueError> {
    let rx = venues
        .adapter(venue)?
        .subscribe_candles(&market, interval)
        .await?;
    Ok(venues.forward(rx, on_event, &webview))
}

/// Returns the id to pass to `unsubscribe`.
#[tauri::command]
pub async fn subscribe_market_summaries(
    venues: State<'_, Venues>,
    webview: Webview,
    venue: VenueId,
    mainnet: Option<bool>,
    on_event: Channel<StreamEvent<Vec<MarketSummary>>>,
) -> Result<u32, VenueError> {
    // Binance's or BloFin's mainnet figures, while its market data is Demo Trading's.
    let rx = if venue == VenueId::Binance && mainnet == Some(true) {
        venues.binance().subscribe_mainnet_summaries().await?
    } else if venue == VenueId::Blofin && mainnet == Some(true) {
        venues.blofin().subscribe_mainnet_summaries().await?
    } else {
        venues.adapter(venue)?.subscribe_market_summaries().await?
    };
    Ok(venues.forward(rx, on_event, &webview))
}

/// Returns the id to pass to `unsubscribe`.
#[tauri::command]
pub async fn subscribe_market_history(
    venues: State<'_, Venues>,
    webview: Webview,
    venue: VenueId,
    on_event: Channel<StreamEvent<MarketHistory>>,
) -> Result<u32, VenueError> {
    let rx = venues.adapter(venue)?.subscribe_market_history().await?;
    Ok(venues.forward(rx, on_event, &webview))
}

/// Every market's liquidations as they happen. Returns the id to pass to `unsubscribe`.
#[tauri::command]
pub async fn subscribe_liquidations(
    venues: State<'_, Venues>,
    webview: Webview,
    venue: VenueId,
    on_event: Channel<StreamEvent<Vec<Liquidation>>>,
) -> Result<u32, VenueError> {
    let rx = venues.adapter(venue)?.subscribe_liquidations().await?;
    Ok(venues.forward(rx, on_event, &webview))
}

/// Whether Binance's market data comes from Demo Trading's exchange (its own
/// markets and prices) or mainnet's: the page sets it from the Binance
/// account on screen. Both are fixed hosts of the adapter's own; accounts
/// and orders go to their own host whatever this says. Returns whether it
/// changed.
#[tauri::command]
pub fn set_binance_demo_data(venues: State<'_, Venues>, demo: bool) -> bool {
    venues.binance().set_demo_market_data(demo)
}

/// The same for BloFin: Demo Trading's market data (87 markets of its own)
/// while the BloFin account on screen is a Demo Trading one.
#[tauri::command]
pub fn set_blofin_demo_data(venues: State<'_, Venues>, demo: bool) -> bool {
    venues.blofin().set_demo_market_data(demo)
}

/// A market's hourly open interest over the last `hours` hours, oldest first.
#[tauri::command]
pub async fn open_interest_history(
    venues: State<'_, Venues>,
    venue: VenueId,
    market: String,
    hours: u32,
) -> Result<Vec<OpenInterestPoint>, VenueError> {
    venues
        .adapter(venue)?
        .open_interest_history(&market, hours)
        .await
}

/// The share of a market's accounts long and short, hourly over the last
/// `hours` hours, oldest first (Bybit only).
#[tauri::command]
pub async fn long_short_ratio(
    venues: State<'_, Venues>,
    venue: VenueId,
    market: String,
    hours: u32,
) -> Result<Vec<LongShortPoint>, VenueError> {
    venues
        .adapter(venue)?
        .long_short_ratio(&market, hours)
        .await
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
    webview: Webview,
    venue: VenueId,
    address: String,
    on_event: Channel<StreamEvent<AccountSnapshot>>,
) -> Result<u32, VenueError> {
    let rx = venues.adapter(venue)?.subscribe_account(&address).await?;
    Ok(venues.forward(rx, on_event, &webview))
}

impl Adapters for Venues {
    fn adapter(&self, venue: VenueId) -> Result<&dyn ExchangeAdapter, VenueError> {
        Venues::adapter(self, venue)
    }
}

// The trading commands: thin wrappers around the engine's router, which
// builds the account's key reference, checks the live-trading switch and
// the trader's rules, logs each step, and only then calls the adapter. See
// the module's invariants and `pewterdesk_engine`. `origin` says where in
// the app the command came from, for the event log only: it grants nothing.

/// Places an order for `account`.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn place_order(
    venues: State<'_, Venues>,
    engine: State<'_, Engine>,
    calendar: State<'_, CalendarState>,
    daemon: State<'_, DaemonLink>,
    venue: VenueId,
    account: String,
    request: OrderRequest,
    origin: Option<Origin>,
) -> Result<Order, VenueError> {
    let origin = origin.unwrap_or(Origin::App);
    if let Some(link) = daemon.route().await? {
        let target = Target {
            venue,
            account: account.clone(),
            origin: Some(origin),
        };
        return daemon::forward(&link, Call::PlaceOrder { target, request }).await;
    }
    engine
        .place_order(&*venues, &*calendar, origin, venue, &account, &request)
        .await
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn cancel_order(
    venues: State<'_, Venues>,
    engine: State<'_, Engine>,
    daemon: State<'_, DaemonLink>,
    venue: VenueId,
    account: String,
    market: String,
    order_id: String,
    origin: Option<Origin>,
) -> Result<(), VenueError> {
    let origin = origin.unwrap_or(Origin::App);
    // An order is always allowed off: through pdd if it's there, else here.
    if let Some(link) = daemon.route_cancel().await {
        let target = Target {
            venue,
            account: account.clone(),
            origin: Some(origin),
        };
        let call = Call::CancelOrder {
            target,
            market,
            order_id,
        };
        return daemon::forward(&link, call).await;
    }
    engine
        .cancel_order(&*venues, origin, venue, &account, &market, &order_id)
        .await
}

/// Changes `account`'s open order `order_id`: price, size, or attached TP/SL.
#[tauri::command]
// Tauri hands each piece of state and each argument in separately.
#[allow(clippy::too_many_arguments)]
pub async fn amend_order(
    venues: State<'_, Venues>,
    engine: State<'_, Engine>,
    daemon: State<'_, DaemonLink>,
    venue: VenueId,
    account: String,
    market: String,
    order_id: String,
    amend: OrderAmend,
    origin: Option<Origin>,
) -> Result<(), VenueError> {
    let origin = origin.unwrap_or(Origin::App);
    if let Some(link) = daemon.route().await? {
        let target = Target {
            venue,
            account: account.clone(),
            origin: Some(origin),
        };
        let call = Call::AmendOrder {
            target,
            market,
            order_id,
            amend,
        };
        return daemon::forward(&link, call).await;
    }
    engine
        .amend_order(
            &*venues, origin, venue, &account, &market, &order_id, &amend,
        )
        .await
}

/// Sets the take-profit, stop-loss and trailing stop on `account`'s
/// position in `market`, all at once (`None` removes one). Protective only.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn set_position_protection(
    venues: State<'_, Venues>,
    engine: State<'_, Engine>,
    daemon: State<'_, DaemonLink>,
    venue: VenueId,
    account: String,
    market: String,
    protection: PositionProtection,
    origin: Option<Origin>,
) -> Result<(), VenueError> {
    let origin = origin.unwrap_or(Origin::App);
    if let Some(link) = daemon.route().await? {
        let target = Target {
            venue,
            account: account.clone(),
            origin: Some(origin),
        };
        let call = Call::Protect {
            target,
            market,
            protection,
        };
        return daemon::forward(&link, call).await;
    }
    engine
        .set_position_protection(&*venues, origin, venue, &account, &market, &protection)
        .await
}

/// The venue's latest announcements, for the News page. Public, read-only;
/// text only (no links come back to the UI).
#[tauri::command]
pub async fn announcements(
    venues: State<'_, Venues>,
    venue: VenueId,
) -> Result<Vec<Announcement>, VenueError> {
    venues.adapter(venue)?.announcements().await
}

/// `address`'s margin mode and leverage on `market`. Read-only.
#[tauri::command]
pub async fn trade_settings(
    venues: State<'_, Venues>,
    venue: VenueId,
    address: String,
    market: String,
) -> Result<TradeSettings, VenueError> {
    venues
        .adapter(venue)?
        .trade_settings(&address, &market)
        .await
}

/// Sets `account`'s leverage on `market` (checked against the market's
/// maximum by the adapter).
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn set_leverage(
    venues: State<'_, Venues>,
    engine: State<'_, Engine>,
    daemon: State<'_, DaemonLink>,
    venue: VenueId,
    account: String,
    market: String,
    leverage: Decimal,
    origin: Option<Origin>,
) -> Result<(), VenueError> {
    let origin = origin.unwrap_or(Origin::App);
    if let Some(link) = daemon.route().await? {
        let target = Target {
            venue,
            account: account.clone(),
            origin: Some(origin),
        };
        let call = Call::SetLeverage {
            target,
            market,
            leverage,
        };
        return daemon::forward(&link, call).await;
    }
    engine
        .set_leverage(&*venues, origin, venue, &account, &market, leverage)
        .await
}

/// Switches `account` between cross and isolated margin (account-wide on
/// Bybit).
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn set_margin_mode(
    venues: State<'_, Venues>,
    engine: State<'_, Engine>,
    daemon: State<'_, DaemonLink>,
    venue: VenueId,
    account: String,
    market: String,
    mode: MarginMode,
    origin: Option<Origin>,
) -> Result<(), VenueError> {
    let origin = origin.unwrap_or(Origin::App);
    if let Some(link) = daemon.route().await? {
        let target = Target {
            venue,
            account: account.clone(),
            origin: Some(origin),
        };
        let call = Call::SetMarginMode {
            target,
            market,
            mode,
        };
        return daemon::forward(&link, call).await;
    }
    engine
        .set_margin_mode(&*venues, origin, venue, &account, &market, mode)
        .await
}

/// Idempotent: an unknown or already-ended id is fine. Dropping the forwarding
/// task drops the adapter's receiver, which closes the venue connection.
#[tauri::command]
pub fn unsubscribe(venues: State<'_, Venues>, id: u32) {
    if let Some(sub) = venues.subscriptions.lock().unwrap().remove(&id) {
        sub.task.abort();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_reload_ends_only_that_webviews_streams() {
        let venues = Venues::new().unwrap();
        let stream = |webview: &str| Subscription {
            webview: webview.into(),
            task: async_runtime::spawn(std::future::pending::<()>()),
        };
        {
            let mut subs = venues.subscriptions.lock().unwrap();
            subs.insert(1, stream("main"));
            subs.insert(2, stream("main"));
            subs.insert(3, stream("tray"));
        }
        venues.end_streams_for("main");
        let mut subs = venues.subscriptions.lock().unwrap();
        assert_eq!(subs.keys().copied().collect::<Vec<_>>(), [3]);
        // The tray's stream is still running; the main window's were aborted.
        let tray = subs.remove(&3).unwrap();
        assert!(!tray.task.inner().is_finished());
        tray.task.abort();
    }
}
