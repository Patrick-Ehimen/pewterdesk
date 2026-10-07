//! The contract every venue crate (`crates/exchange-<venue>`) implements.

use async_trait::async_trait;
use serde::Serialize;
use tokio::sync::mpsc;
use ts_rs::TS;

use crate::domain::{
    AccountSnapshot, Announcement, Candle, CandleInterval, Capabilities, ClosedTrade, Decimal,
    Fill, FundingPayment, FundingRate, Liquidation, MarginMode, Market, MarketHistory, MarketStats,
    MarketSummary, OpenInterestPoint, Order, OrderAmend, OrderBook, OrderRequest,
    PositionProtection, Trade, TradeSettings, TradingAccount, VenueId,
};
use crate::keys::KeyError;

/// Crosses IPC to the frontend, so details must never carry key material -
/// venue error messages are fine, anything from a key or signer is not.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, TS, thiserror::Error)]
#[serde(tag = "kind", content = "detail", rename_all = "camelCase")]
#[ts(export, export_to = "domain.ts")]
pub enum VenueError {
    /// The venue can't do this at all (e.g. an order book on a pool-based venue).
    #[error("not supported by this venue: {0}")]
    Unsupported(&'static str),
    /// The request is malformed or can't be expressed on this venue.
    #[error("invalid request: {0}")]
    InvalidRequest(String),
    /// The venue refused it; the detail is the venue's own message.
    #[error("rejected by venue: {0}")]
    Rejected(String),
    #[error("network error: {0}")]
    Network(String),
    #[error(transparent)]
    Key(#[from] KeyError),
}

/// One venue. Implementations take a [`KeySource`](crate::KeySource) in their
/// constructor and connect only to their own venue and RPC hosts.
///
/// The trait has no withdraw, transfer or key-approval method, and no way to
/// sign caller-supplied bytes: whatever can drive an adapter - including a
/// script injected into the webview - can place and cancel orders, and set a
/// position's protective exits, with the trade-only key, and nothing else. Adding such a method is a
/// security-sensitive change; see docs/adr/0001-venues-in-rust.md.
///
/// Read-only methods need no key, so market data and account views work before
/// a trade-only key has been set up.
#[async_trait]
pub trait ExchangeAdapter: Send + Sync {
    fn venue(&self) -> VenueId;

    fn capabilities(&self) -> Capabilities;

    async fn markets(&self) -> Result<Vec<Market>, VenueError>;

    /// Only on venues where `capabilities().order_book` is true.
    async fn order_book(&self, _market: &str) -> Result<OrderBook, VenueError> {
        Err(VenueError::Unsupported("order book"))
    }

    /// Updates until the receiver is dropped, which unsubscribes.
    async fn subscribe_order_book(
        &self,
        _market: &str,
    ) -> Result<mpsc::Receiver<OrderBook>, VenueError> {
        Err(VenueError::Unsupported("order book"))
    }

    /// The market's most recent trades, newest first, re-sent whole whenever
    /// one prints - a snapshot like the other streams, so a consumer that
    /// misses an update misses nothing. Until the receiver is dropped.
    async fn subscribe_trades(
        &self,
        _market: &str,
    ) -> Result<mpsc::Receiver<Vec<Trade>>, VenueError> {
        Err(VenueError::Unsupported("trades"))
    }

    /// The market's headline stats, re-sent whole on every change, until the
    /// receiver is dropped.
    async fn subscribe_market_stats(
        &self,
        _market: &str,
    ) -> Result<mpsc::Receiver<MarketStats>, VenueError> {
        Err(VenueError::Unsupported("market stats"))
    }

    /// The market's candles at `interval`: first the recent history, oldest
    /// first, then each candle again, whole, whenever it changes. Consumers
    /// merge by `open_time`; because every update carries the full candle, a
    /// dropped one only loses an intermediate state. Until the receiver is
    /// dropped.
    async fn subscribe_candles(
        &self,
        _market: &str,
        _interval: CandleInterval,
    ) -> Result<mpsc::Receiver<Vec<Candle>>, VenueError> {
        Err(VenueError::Unsupported("candles"))
    }

    /// Every listed market's summary, re-sent whole every few seconds, until
    /// the receiver is dropped.
    async fn subscribe_market_summaries(
        &self,
    ) -> Result<mpsc::Receiver<Vec<MarketSummary>>, VenueError> {
        Err(VenueError::Unsupported("market summaries"))
    }

    /// Every listed market's last 7 days of hourly candles, one market per
    /// message, busiest markets first, then cycling to keep them fresh. Paced
    /// to stay inside the venue's rate limits, so a full pass takes minutes.
    /// Until the receiver is dropped.
    async fn subscribe_market_history(&self) -> Result<mpsc::Receiver<MarketHistory>, VenueError> {
        Err(VenueError::Unsupported("market history"))
    }

    /// Every market's liquidations as the venue reports them, a batch per
    /// message as they happen (not snapshots: one dropped under load is
    /// lost). Public data, no account needed. Until the receiver is dropped.
    async fn subscribe_liquidations(&self) -> Result<mpsc::Receiver<Vec<Liquidation>>, VenueError> {
        Err(VenueError::Unsupported("liquidations"))
    }

    /// `market`'s open interest an hour apart, over the last `hours` hours
    /// (as far back as the venue serves), oldest first. Public data.
    async fn open_interest_history(
        &self,
        _market: &str,
        _hours: u32,
    ) -> Result<Vec<OpenInterestPoint>, VenueError> {
        Err(VenueError::Unsupported("open interest history"))
    }

    /// Up to `count` of `market`'s candles at `interval` that opened before
    /// `before` (milliseconds since the Unix epoch), oldest first: older
    /// history, a page at a time, for a chart scrolled back past what it has.
    /// Empty once the venue has nothing older.
    async fn candles(
        &self,
        _market: &str,
        _interval: CandleInterval,
        _before: u64,
        _count: u32,
    ) -> Result<Vec<Candle>, VenueError> {
        Err(VenueError::Unsupported("candle history"))
    }

    /// Funding payments on `market` since `start_time` (milliseconds since the
    /// Unix epoch), oldest first.
    async fn funding_history(
        &self,
        _market: &str,
        _start_time: u64,
    ) -> Result<Vec<FundingRate>, VenueError> {
        Err(VenueError::Unsupported("funding history"))
    }

    /// `market`'s logo as SVG markup, or `None` when the venue has none.
    /// Cosmetic, so a venue without logos just keeps the default.
    ///
    /// The markup comes from the venue, not from us: the UI must only render
    /// it as an image (an `<img>` with a `data:` URL, where SVG scripts and
    /// external loads don't run), never insert it into the page.
    async fn market_icon(&self, _market: &str) -> Result<Option<String>, VenueError> {
        Ok(None)
    }

    async fn account(&self, address: &str) -> Result<AccountSnapshot, VenueError>;

    /// The account's most recent fills, newest first, as many as the venue
    /// keeps. Read-only, like `account`: it needs an address, not a key.
    async fn fills(&self, _address: &str) -> Result<Vec<Fill>, VenueError> {
        Err(VenueError::Unsupported("fill history"))
    }

    /// Funding paid or received on the account's positions since
    /// `start_time` (milliseconds since the Unix epoch), newest first.
    async fn funding_payments(
        &self,
        _address: &str,
        _start_time: u64,
    ) -> Result<Vec<FundingPayment>, VenueError> {
        Err(VenueError::Unsupported("funding payments"))
    }

    /// The account's recently closed positions, newest first, with what each
    /// made. Read-only, like `fills`.
    async fn closed_trades(&self, _address: &str) -> Result<Vec<ClosedTrade>, VenueError> {
        Err(VenueError::Unsupported("closed trades"))
    }

    /// The account's recent orders in any state (filled, cancelled,
    /// rejected, still open), newest first, as many as the venue keeps.
    async fn order_history(&self, _address: &str) -> Result<Vec<Order>, VenueError> {
        Err(VenueError::Unsupported("order history"))
    }

    /// A fresh snapshot whenever positions, orders or balances change, until
    /// the receiver is dropped. Venues without an account stream are polled.
    async fn subscribe_account(
        &self,
        address: &str,
    ) -> Result<mpsc::Receiver<AccountSnapshot>, VenueError>;

    /// Resolves once the venue has accepted the order, which is not the same
    /// as it being live: on keeper- or auction-filled venues it comes back
    /// `Pending` and moves on via `subscribe_account`. Errors if the venue refuses it outright.
    async fn place_order(
        &self,
        account: &TradingAccount,
        request: &OrderRequest,
    ) -> Result<Order, VenueError>;

    async fn cancel_order(
        &self,
        account: &TradingAccount,
        market: &str,
        order_id: &str,
    ) -> Result<(), VenueError>;

    /// Changes an open order's price, size, or attached TP and SL. Order
    /// management, like `cancel_order`: it can't change the market, the side
    /// or the kind of order. Part of the signing surface with `place_order`,
    /// `cancel_order`, `set_position_protection`, `set_leverage` and
    /// `set_margin_mode`, and nothing beyond them.
    async fn amend_order(
        &self,
        _account: &TradingAccount,
        _market: &str,
        _order_id: &str,
        _amend: &OrderAmend,
    ) -> Result<(), VenueError> {
        Err(VenueError::Unsupported("changing an order"))
    }

    /// The venue's latest announcements, newest first. Public, read-only.
    async fn announcements(&self) -> Result<Vec<Announcement>, VenueError> {
        Err(VenueError::Unsupported("announcements"))
    }

    /// The account's margin mode and its leverage on `market`. Read-only.
    async fn trade_settings(
        &self,
        _address: &str,
        _market: &str,
    ) -> Result<TradeSettings, VenueError> {
        Err(VenueError::Unsupported("reading leverage and margin mode"))
    }

    /// Sets the leverage the account trades `market` with, between 1 and the
    /// market's maximum. A trading parameter: it moves no funds and opens
    /// nothing. Part of the signing surface, behind the same gate as orders.
    async fn set_leverage(
        &self,
        _account: &TradingAccount,
        _market: &str,
        _leverage: Decimal,
    ) -> Result<(), VenueError> {
        Err(VenueError::Unsupported("changing leverage"))
    }

    /// Switches between cross and isolated margin, for `market` or, where the
    /// venue sets it per account (`TradeSettings::margin_mode_account_wide`),
    /// for the whole account. A trading parameter, like `set_leverage`.
    async fn set_margin_mode(
        &self,
        _account: &TradingAccount,
        _market: &str,
        _mode: MarginMode,
    ) -> Result<(), VenueError> {
        Err(VenueError::Unsupported("changing the margin mode"))
    }

    /// Changes an open position's take-profit, stop-loss and trailing stop:
    /// each kept, removed or set (`ExitChange`). Protective only: each exit is
    /// reduce-only and closes the position; it can't open, add to or move
    /// funds. Part of the signing surface with the order methods and
    /// `set_leverage`/`set_margin_mode`, and nothing beyond them.
    async fn set_position_protection(
        &self,
        _account: &TradingAccount,
        _market: &str,
        _protection: &PositionProtection,
    ) -> Result<(), VenueError> {
        Err(VenueError::Unsupported(
            "take-profit and stop-loss on positions",
        ))
    }
}
