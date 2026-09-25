//! Exchange-agnostic domain types. Every venue crate maps its own wire format
//! into these; nothing above the adapters sees a venue's native shapes.
//!
//! These are also the TypeScript types: `cargo test` exports them via ts-rs to
//! `packages/core/src/generated/`. Serde attributes here define the IPC wire
//! format, so a rename is a breaking change for the frontend.
//!
//! All markets are perpetuals. Adding spot or dated futures is a deliberate
//! change to these types, not something an adapter should smuggle in.

use serde::{Deserialize, Serialize};
use ts_rs::TS;

const TS_FILE: &str = "domain.ts";

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, TS)]
#[serde(rename_all = "lowercase")]
#[ts(export, export_to = TS_FILE)]
pub enum VenueId {
    Hyperliquid,
    Gmx,
    Dydx,
    Drift,
}

impl VenueId {
    pub const ALL: [VenueId; 4] = [Self::Hyperliquid, Self::Gmx, Self::Dydx, Self::Drift];
}

/// A base-10 number, carried over IPC as a string (`"0.0015"`). Prices, sizes
/// and balances are never floats: deserializing rejects JSON numbers, so a
/// value that went through a JS `number` can't silently reach a signed order.
#[derive(
    Clone, Copy, Debug, Default, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize, TS,
)]
#[ts(export, export_to = TS_FILE, type = "string")]
pub struct Decimal(#[serde(with = "rust_decimal::serde::str")] pub rust_decimal::Decimal);

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "lowercase")]
#[ts(export, export_to = TS_FILE)]
pub enum Side {
    Buy,
    Sell,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "lowercase")]
#[ts(export, export_to = TS_FILE)]
pub enum PositionSide {
    Long,
    Short,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = TS_FILE)]
pub struct Market {
    pub venue: VenueId,
    /// The venue's own identifier, passed back to the adapter unchanged: "BTC"
    /// on Hyperliquid, "BTC-USD" on dYdX, a market token address on GMX,
    /// "BTC-PERP" on Drift. Opaque outside the adapter.
    pub id: String,
    /// Display symbol, e.g. "BTC-USD".
    pub symbol: String,
    pub base: String,
    pub quote: String,
    pub tick_size: Decimal,
    /// Smallest size increment, in base units.
    pub size_step: Decimal,
    pub min_size: Decimal,
    pub max_leverage: u32,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, TS)]
#[ts(export, export_to = TS_FILE)]
pub struct BookLevel {
    pub price: Decimal,
    pub size: Decimal,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, TS)]
#[ts(export, export_to = TS_FILE)]
pub struct OrderBook {
    pub market: String,
    /// Best (highest) first.
    pub bids: Vec<BookLevel>,
    /// Best (lowest) first.
    pub asks: Vec<BookLevel>,
    /// Milliseconds since the Unix epoch.
    #[ts(type = "number")]
    pub time: u64,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = TS_FILE)]
pub enum TimeInForce {
    Gtc,
    Ioc,
    PostOnly,
}

/// The order-type-specific half of an [`OrderRequest`].
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, TS)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
#[ts(export, export_to = TS_FILE)]
pub enum OrderKind {
    Market {
        /// Worst acceptable fill, in basis points from the current price.
        /// Every launch venue needs a bound for market orders (Hyperliquid's
        /// IOC limit, GMX's acceptable price, Drift's auction end price), so
        /// there's no unbounded market order.
        max_slippage_bps: u32,
    },
    Limit {
        price: Decimal,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        time_in_force: Option<TimeInForce>,
    },
    /// Stop-loss or take-profit, depending on side and trigger.
    Trigger {
        trigger_price: Decimal,
        /// Omit for a market order once triggered.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        limit_price: Option<Decimal>,
    },
}

/// Venue-agnostic order intent. Adapters translate it — into two steps where
/// a venue needs them — and reject what the venue can't express rather than
/// approximating it.
///
/// No `deny_unknown_fields`: serde can't combine it with `flatten`, and it
/// would reject every valid request. `OrderKind`'s tag still refuses anything
/// that isn't a known order type.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = TS_FILE, optional_fields)]
pub struct OrderRequest {
    /// `Market::id`.
    pub market: String,
    pub side: Side,
    /// In base units, a multiple of `Market::size_step`.
    pub size: Decimal,
    pub reduce_only: bool,
    /// Isolated collateral to post with the order, in the quote asset.
    /// Required by venues that margin each position separately (GMX);
    /// adapters for cross-margined venues reject a request that sets it
    /// rather than ignoring it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub collateral: Option<Decimal>,
    /// Caller-chosen id for matching the order up later.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub client_id: Option<String>,
    #[serde(flatten)]
    #[ts(flatten)]
    pub kind: OrderKind,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = TS_FILE)]
pub enum OrderType {
    Market,
    Limit,
    Trigger,
}

impl OrderKind {
    pub fn order_type(&self) -> OrderType {
        match self {
            Self::Market { .. } => OrderType::Market,
            Self::Limit { .. } => OrderType::Limit,
            Self::Trigger { .. } => OrderType::Trigger,
        }
    }
}

/// `Pending` means accepted but not yet live — waiting on a GMX keeper, a
/// Drift auction, or block inclusion — and may still end as `Rejected`.
/// `Open` means resting on the venue; `filled_size` may be non-zero.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = TS_FILE)]
pub enum OrderStatus {
    Pending,
    Open,
    Filled,
    Cancelled,
    Rejected,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = TS_FILE, optional_fields)]
pub struct Order {
    pub venue: VenueId,
    /// The venue's order id. For GMX this is the order key.
    pub id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub client_id: Option<String>,
    pub market: String,
    pub side: Side,
    #[serde(rename = "type")]
    pub order_type: OrderType,
    pub size: Decimal,
    pub filled_size: Decimal,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub price: Option<Decimal>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub trigger_price: Option<Decimal>,
    pub reduce_only: bool,
    pub status: OrderStatus,
    /// Milliseconds since the Unix epoch.
    #[ts(type = "number")]
    pub created_at: u64,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = TS_FILE, optional_fields)]
pub struct Position {
    pub venue: VenueId,
    pub market: String,
    pub side: PositionSide,
    /// In base units, always positive; direction is `side`.
    pub size: Decimal,
    pub entry_price: Decimal,
    pub mark_price: Decimal,
    /// Absent where the venue can't estimate one.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub liquidation_price: Option<Decimal>,
    pub unrealized_pnl: Decimal,
    /// Collateral backing this position, in the quote asset.
    pub margin: Decimal,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = TS_FILE)]
pub struct AccountSnapshot {
    pub venue: VenueId,
    /// The main account address — not the trade-only key's address.
    pub address: String,
    /// Total account value in the quote asset, including unrealized PnL.
    pub equity: Decimal,
    /// Collateral free to open new positions.
    pub available_margin: Decimal,
    pub positions: Vec<Position>,
    pub open_orders: Vec<Order>,
    /// Milliseconds since the Unix epoch.
    #[ts(type = "number")]
    pub time: u64,
}

/// Who is trading, for calls that need a signature.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(export, export_to = TS_FILE)]
pub struct TradingAccount {
    /// The main account address positions are held under.
    pub address: String,
    /// Keychain account holding this venue's trade-only key for it.
    pub key: String,
}

/// What a venue supports, so the UI can offer only what will work.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = TS_FILE)]
pub struct Capabilities {
    /// False on GMX, which fills against pools at oracle prices.
    pub order_book: bool,
    pub order_types: Vec<OrderType>,
    /// Whether orders take a `collateral` amount (isolated per-position margin).
    pub isolated_collateral: bool,
}
