//! The contract every venue crate (`crates/exchange-<venue>`) implements.

use async_trait::async_trait;
use serde::Serialize;
use tokio::sync::mpsc;
use ts_rs::TS;

use crate::domain::{
    AccountSnapshot, Capabilities, Market, MarketStats, Order, OrderBook, OrderRequest, Trade,
    TradingAccount, VenueId,
};
use crate::keys::KeyError;

/// Crosses IPC to the frontend, so details must never carry key material —
/// venue error messages are fine, anything from a key or signer is not.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, TS, thiserror::Error)]
#[serde(tag = "kind", content = "detail", rename_all = "camelCase")]
#[ts(export, export_to = "domain.ts")]
pub enum VenueError {
    /// The venue can't do this at all (e.g. an order book on GMX).
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
/// sign caller-supplied bytes: whatever can drive an adapter — including a
/// script injected into the webview — can place and cancel orders with the
/// trade-only key, and nothing else. Adding such a method is a
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
    /// one prints — a snapshot like the other streams, so a consumer that
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

    async fn account(&self, address: &str) -> Result<AccountSnapshot, VenueError>;

    /// A fresh snapshot whenever positions, orders or balances change, until
    /// the receiver is dropped. Venues without an account stream are polled.
    async fn subscribe_account(
        &self,
        address: &str,
    ) -> Result<mpsc::Receiver<AccountSnapshot>, VenueError>;

    /// Resolves once the venue has accepted the order, which is not the same
    /// as it being live: on GMX and Drift it comes back `Pending` and moves on
    /// via `subscribe_account`. Errors if the venue refuses it outright.
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
}
