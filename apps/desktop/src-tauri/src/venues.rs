//! Tauri commands exposing the venue adapters - the only way the UI reaches a
//! venue. Read-only so far: markets, order books, trades, candles, market
//! stats, summaries and history, funding history, and account state, from
//! Hyperliquid, Aster and Bybit.
//!
//! Security invariants - review any change here against
//! `.claude/commands/security-review.md`:
//! - These commands and `ExchangeAdapter` together are the whole signing
//!   surface: `place_order`, `cancel_order`, `amend_order` (an open order's
//!   price, size or attached TP/SL), `set_position_protection`
//!   (a position's TP, SL and trailing stop: protective, reduce-only), and
//!   the trading parameters `set_leverage` and `set_margin_mode` (they move
//!   no funds and open nothing), nothing else. They build the
//!   account's key reference themselves and refuse everything but Bybit
//!   accounts: demo ones, and live ones with live trading turned on
//!   (`trading_account`, `live_trading`).
//! - No command takes a URL or host. Adapters connect only to the endpoints
//!   fixed in their own crate.
//! - Bybit's account reads are signed with its stored API key: the adapter
//!   gets the keychain as a `KeySource` and signs only its own fixed,
//!   read-only requests (balance, positions, open orders, leverage and
//!   margin mode).

use std::collections::HashMap;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Arc, Mutex};

use pewterdesk_core::{
    AccountSnapshot, Announcement, Candle, CandleInterval, ClosedTrade, Decimal, ExchangeAdapter,
    Fill, FundingPayment, FundingRate, Liquidation, MarginMode, Market, MarketHistory, MarketStats,
    MarketSummary, OpenInterestPoint, Order, OrderAmend, OrderBook, OrderRequest,
    PositionProtection, Trade, TradeSettings, TradingAccount, VenueError, VenueId,
};
use pewterdesk_exchange_aster::{constants::MAINNET as ASTER_MAINNET, AsterAdapter};
use pewterdesk_exchange_bybit::{
    auth as bybit_auth, constants::MAINNET as BYBIT_MAINNET, BybitAdapter,
};
use pewterdesk_exchange_hyperliquid::{constants::MAINNET, HyperliquidAdapter};
use serde::Serialize;
use tauri::async_runtime::{self, JoinHandle};
use tauri::ipc::Channel;
use tauri::{State, Webview};
use tokio::sync::mpsc;

use crate::keychain::KeychainKeySource;
use crate::live_trading::LiveTrading;

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
    /// Each live stream's forwarding task, and the webview it streams to.
    subscriptions: Arc<Mutex<HashMap<u32, Subscription>>>,
    next_id: AtomicU32,
}

impl Venues {
    pub fn new() -> Result<Self, VenueError> {
        Ok(Self {
            hyperliquid: HyperliquidAdapter::new(&MAINNET)?,
            aster: AsterAdapter::new(&ASTER_MAINNET)?,
            // Account reads take the stored API key from the keychain.
            bybit: BybitAdapter::new(&BYBIT_MAINNET)?.with_keys(Arc::new(KeychainKeySource)),
            subscriptions: Arc::default(),
            next_id: AtomicU32::new(1),
        })
    }

    /// Hyperliquid's own methods beyond `ExchangeAdapter`, for onboarding.
    pub fn hyperliquid(&self) -> &HyperliquidAdapter {
        &self.hyperliquid
    }

    pub fn bybit(&self) -> &BybitAdapter {
        &self.bybit
    }

    fn adapter(&self, venue: VenueId) -> Result<&dyn ExchangeAdapter, VenueError> {
        match venue {
            VenueId::Hyperliquid => Ok(&self.hyperliquid),
            VenueId::Aster => Ok(&self.aster),
            VenueId::Bybit => Ok(&self.bybit),
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
    fn forward<T>(
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
    on_event: Channel<StreamEvent<Vec<MarketSummary>>>,
) -> Result<u32, VenueError> {
    let rx = venues.adapter(venue)?.subscribe_market_summaries().await?;
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

/// Who an order is for, and which keychain entry holds its key - built
/// here from the account id, never taken from the UI, so a call can't pair
/// an account with another's key.
///
/// Orders are on for Bybit accounts: a demo account (demo funds, on
/// Bybit's demo host) as soon as it's connected, a live one only once live
/// trading has been turned on for it (`live_trading`). Other venues are
/// refused here until they have signing code; lifting that is this match.
fn trading_account(
    venue: VenueId,
    account: &str,
    live: &LiveTrading,
) -> Result<TradingAccount, VenueError> {
    match venue {
        VenueId::Bybit => {
            let (demo, uid) = bybit_auth::parse_account(account)?;
            if !demo && !live.is_on(uid) {
                return Err(VenueError::Rejected(
                    "live trading is off for this account; turn it on under Accounts".into(),
                ));
            }
            Ok(TradingAccount {
                address: account.to_owned(),
                key: bybit_auth::key_account(account)?,
            })
        }
        VenueId::Hyperliquid | VenueId::Aster => {
            Err(VenueError::Unsupported("orders on this venue (not yet)"))
        }
    }
}

/// Places an order for `account`. With `cancel_order`, the only commands
/// that sign a venue action: see the module's invariants.
#[tauri::command]
pub async fn place_order(
    venues: State<'_, Venues>,
    live: State<'_, LiveTrading>,
    venue: VenueId,
    account: String,
    request: OrderRequest,
) -> Result<Order, VenueError> {
    let trading = trading_account(venue, &account, &live)?;
    venues.adapter(venue)?.place_order(&trading, &request).await
}

#[tauri::command]
pub async fn cancel_order(
    venues: State<'_, Venues>,
    live: State<'_, LiveTrading>,
    venue: VenueId,
    account: String,
    market: String,
    order_id: String,
) -> Result<(), VenueError> {
    let trading = trading_account(venue, &account, &live)?;
    venues
        .adapter(venue)?
        .cancel_order(&trading, &market, &order_id)
        .await
}

/// Changes `account`'s open order `order_id`: price, size, or attached TP/SL.
/// Behind the same gate as orders (`trading_account`).
#[tauri::command]
pub async fn amend_order(
    venues: State<'_, Venues>,
    live: State<'_, LiveTrading>,
    venue: VenueId,
    account: String,
    market: String,
    order_id: String,
    amend: OrderAmend,
) -> Result<(), VenueError> {
    let trading = trading_account(venue, &account, &live)?;
    venues
        .adapter(venue)?
        .amend_order(&trading, &market, &order_id, &amend)
        .await
}

/// Sets the take-profit, stop-loss and trailing stop on `account`'s
/// position in `market`, all at once (`None` removes one). Protective only;
/// behind the same gate as orders (`trading_account`).
#[tauri::command]
pub async fn set_position_protection(
    venues: State<'_, Venues>,
    live: State<'_, LiveTrading>,
    venue: VenueId,
    account: String,
    market: String,
    protection: PositionProtection,
) -> Result<(), VenueError> {
    let trading = trading_account(venue, &account, &live)?;
    venues
        .adapter(venue)?
        .set_position_protection(&trading, &market, &protection)
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
/// maximum by the adapter). Behind the same gate as orders.
#[tauri::command]
pub async fn set_leverage(
    venues: State<'_, Venues>,
    live: State<'_, LiveTrading>,
    venue: VenueId,
    account: String,
    market: String,
    leverage: Decimal,
) -> Result<(), VenueError> {
    let trading = trading_account(venue, &account, &live)?;
    venues
        .adapter(venue)?
        .set_leverage(&trading, &market, leverage)
        .await
}

/// Switches `account` between cross and isolated margin (account-wide on
/// Bybit). Behind the same gate as orders.
#[tauri::command]
pub async fn set_margin_mode(
    venues: State<'_, Venues>,
    live: State<'_, LiveTrading>,
    venue: VenueId,
    account: String,
    market: String,
    mode: MarginMode,
) -> Result<(), VenueError> {
    let trading = trading_account(venue, &account, &live)?;
    venues
        .adapter(venue)?
        .set_margin_mode(&trading, &market, mode)
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

    #[test]
    fn a_live_account_trades_only_once_its_turned_on() {
        let path = std::env::temp_dir()
            .join(format!("pewterdesk-gate-{}", std::process::id()))
            .join(crate::live_trading::FILE);
        let live = LiveTrading::load(Some(path.clone()));
        // Demo accounts need no switch.
        let demo = trading_account(VenueId::Bybit, "demo:24617703", &live).unwrap();
        assert_eq!(demo.address, "demo:24617703");
        assert_eq!(demo.key, "bybit:demo:24617703");
        assert!(trading_account(VenueId::Bybit, "demo:x", &live).is_err());
        // A live one is refused until it's on, and only that account is let through.
        assert!(matches!(
            trading_account(VenueId::Bybit, "24617703", &live),
            Err(VenueError::Rejected(_))
        ));
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(&path, br#"["24617703"]"#).unwrap();
        let on = LiveTrading::load(Some(path.clone()));
        let account = trading_account(VenueId::Bybit, "24617703", &on).unwrap();
        assert_eq!(account.address, "24617703");
        assert_eq!(account.key, "bybit:24617703");
        assert!(matches!(
            trading_account(VenueId::Bybit, "24617704", &on),
            Err(VenueError::Rejected(_))
        ));
        let _ = std::fs::remove_dir_all(path.parent().unwrap());
        // No other venue can trade yet, whatever is switched on.
        let hl = format!("0x{}", "a".repeat(40));
        for venue in [VenueId::Hyperliquid, VenueId::Aster] {
            assert!(matches!(
                trading_account(venue, &hl, &on),
                Err(VenueError::Unsupported(_))
            ));
        }
    }
}
