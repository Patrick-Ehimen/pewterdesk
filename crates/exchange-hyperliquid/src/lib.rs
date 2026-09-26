//! Hyperliquid adapter. Read-only so far: markets, order books and account
//! state over the public info API and WebSocket feed, none of which need a key.
//!
//! Order placement lands next with its signer (EIP-712 over the msgpack action
//! hash, with an API/agent wallet as the trade-only key) and the `KeySource`
//! the adapter takes in its constructor. The signer is security-sensitive —
//! see docs/adr/0001-venues-in-rust.md.

pub mod constants;
mod wire;
mod ws;

use std::time::Duration;

use async_trait::async_trait;
use pewterdesk_core::{
    AccountSnapshot, Capabilities, ExchangeAdapter, Market, Order, OrderBook, OrderRequest,
    OrderType, TradingAccount, VenueError, VenueId,
};
use serde::de::DeserializeOwned;
use serde_json::{json, Value};
use tokio::sync::mpsc;

use constants::Endpoints;
use wire::{ClearinghouseState, OpenOrder, WsClearinghouseState, WsOpenOrders};
use ws::Handled;

const REQUEST_TIMEOUT: Duration = Duration::from_secs(10);

pub struct HyperliquidAdapter {
    http: reqwest::Client,
    endpoints: &'static Endpoints,
}

impl HyperliquidAdapter {
    /// Talks only to `endpoints`, which are fixed in [`constants`] — never a
    /// URL supplied by a caller.
    pub fn new(endpoints: &'static Endpoints) -> Result<Self, VenueError> {
        let http = reqwest::Client::builder()
            .timeout(REQUEST_TIMEOUT)
            .build()
            .map_err(|e| VenueError::Network(e.to_string()))?;
        Ok(Self { http, endpoints })
    }

    async fn info<T: DeserializeOwned>(&self, request: Value) -> Result<T, VenueError> {
        let response = self
            .http
            .post(format!("{}/info", self.endpoints.rest))
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
        Ok(wire::markets(self.info(json!({ "type": "meta" })).await?))
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

    async fn account(&self, address: &str) -> Result<AccountSnapshot, VenueError> {
        validate_address(address)?;
        let state = self.info(json!({ "type": "clearinghouseState", "user": address }));
        let (state, orders) = tokio::try_join!(state, self.open_orders(address))?;
        wire::account(address, state, orders)
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
