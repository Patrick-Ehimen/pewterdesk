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
    Aster,
}

impl VenueId {
    pub const ALL: [VenueId; 2] = [Self::Hyperliquid, Self::Aster];
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
    /// on Hyperliquid, "BTCUSDT" on Aster. Opaque outside the adapter.
    pub id: String,
    /// Display symbol, e.g. "BTC-USDC".
    pub symbol: String,
    pub base: String,
    pub quote: String,
    pub tick_size: Decimal,
    /// Smallest size increment, in base units.
    pub size_step: Decimal,
    pub min_size: Decimal,
    pub max_leverage: u32,
    /// Who listed the market, when that isn't the venue itself: on
    /// Hyperliquid, the builder-deployed perp exchange (HIP-3), e.g. "xyz".
    /// `None` for the venue's own markets.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub listed_by: Option<String>,
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

/// A market's headline numbers: prices, the day's range and volume, open
/// interest and funding. Re-sent whole on every update.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = TS_FILE, optional_fields)]
pub struct MarketStats {
    /// `Market::id`.
    pub market: String,
    /// The venue's mark price, used for margin and PnL.
    pub mark_price: Decimal,
    /// Midpoint of the best bid and ask; absent when a side is empty.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mid_price: Option<Decimal>,
    /// The index (oracle) price the mark tracks.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub index_price: Option<Decimal>,
    /// The price 24 hours ago, for the day's change.
    pub prev_day_price: Decimal,
    /// Highest and lowest trade over the last 24 hours, where the venue can say.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub day_high: Option<Decimal>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub day_low: Option<Decimal>,
    /// Traded value over the last 24 hours, in the quote asset.
    pub day_volume: Decimal,
    /// In base units.
    pub open_interest: Decimal,
    /// The rate for the current funding interval, as a fraction (0.0001 = 0.01%).
    pub funding_rate: Decimal,
    /// Length of one funding interval, in seconds (3600 on Hyperliquid).
    pub funding_interval_secs: u32,
    /// When the current interval's funding is paid; milliseconds since the Unix epoch.
    #[ts(type = "number")]
    pub next_funding_time: u64,
    /// Milliseconds since the Unix epoch.
    #[ts(type = "number")]
    pub time: u64,
}

/// Candle widths the terminal offers.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, TS)]
#[ts(export, export_to = TS_FILE)]
pub enum CandleInterval {
    #[serde(rename = "1m")]
    OneMinute,
    #[serde(rename = "5m")]
    FiveMinutes,
    #[serde(rename = "15m")]
    FifteenMinutes,
    #[serde(rename = "1h")]
    OneHour,
    #[serde(rename = "4h")]
    FourHours,
    #[serde(rename = "1d")]
    OneDay,
    #[serde(rename = "1w")]
    OneWeek,
}

impl CandleInterval {
    /// The interval's length in milliseconds.
    pub fn millis(self) -> u64 {
        const MINUTE: u64 = 60_000;
        match self {
            Self::OneMinute => MINUTE,
            Self::FiveMinutes => 5 * MINUTE,
            Self::FifteenMinutes => 15 * MINUTE,
            Self::OneHour => 60 * MINUTE,
            Self::FourHours => 240 * MINUTE,
            Self::OneDay => 1440 * MINUTE,
            Self::OneWeek => 7 * 1440 * MINUTE,
        }
    }
}

/// One price candle.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = TS_FILE)]
pub struct Candle {
    /// When the candle opened; milliseconds since the Unix epoch.
    #[ts(type = "number")]
    pub open_time: u64,
    pub open: Decimal,
    pub high: Decimal,
    pub low: Decimal,
    pub close: Decimal,
    /// Traded size over the candle, in base units.
    pub volume: Decimal,
}

/// One market's line in a screener: enough to rank and compare markets.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = TS_FILE)]
pub struct MarketSummary {
    /// `Market::id`.
    pub market: String,
    pub mark_price: Decimal,
    /// The price 24 hours ago, for the day's change.
    pub prev_day_price: Decimal,
    /// Traded value over the last 24 hours, in the quote asset.
    pub day_volume: Decimal,
    /// In base units.
    pub open_interest: Decimal,
    /// The rate for the current funding interval, as a fraction.
    pub funding_rate: Decimal,
    /// Length of one funding interval, in seconds, for annualising the rate.
    pub funding_interval_secs: u32,
}

/// A market's recent candles, for screening: trends, sparklines, RSI.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = TS_FILE)]
pub struct MarketHistory {
    /// `Market::id`.
    pub market: String,
    pub interval: CandleInterval,
    /// Oldest first; the last one may still be forming.
    pub candles: Vec<Candle>,
}

/// One funding payment on a market.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = TS_FILE)]
pub struct FundingRate {
    /// `Market::id`.
    pub market: String,
    /// The rate paid for the interval, as a fraction.
    pub rate: Decimal,
    /// When it was paid; milliseconds since the Unix epoch.
    #[ts(type = "number")]
    pub time: u64,
}

/// What a fill did to the account's position in its market.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = TS_FILE)]
pub enum FillEffect {
    OpenLong,
    CloseLong,
    OpenShort,
    CloseShort,
    /// Closed a long and opened a short in one fill.
    LongToShort,
    ShortToLong,
    /// Anything else the venue reports (a liquidation, a settlement, ...).
    Other,
}

/// One of an account's own fills: part or all of an order that traded.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = TS_FILE)]
pub struct Fill {
    pub venue: VenueId,
    /// The venue's id for this fill.
    pub id: String,
    /// `Order::id` of the order it filled.
    pub order_id: String,
    pub market: String,
    pub side: Side,
    pub effect: FillEffect,
    pub price: Decimal,
    /// In base units.
    pub size: Decimal,
    /// PnL realised by the part that closed a position, in the quote asset.
    pub closed_pnl: Decimal,
    /// What the fill cost; negative for a rebate.
    pub fee: Decimal,
    /// The asset `fee` is in, e.g. "USDC".
    pub fee_asset: String,
    /// Took liquidity (crossed the spread) rather than resting on the book.
    pub taker: bool,
    /// Milliseconds since the Unix epoch.
    #[ts(type = "number")]
    pub time: u64,
}

/// One funding payment on an account's position.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = TS_FILE)]
pub struct FundingPayment {
    pub venue: VenueId,
    pub market: String,
    /// In the quote asset: positive if the account received it, negative if it paid.
    pub amount: Decimal,
    /// The position's size when paid, negative for a short.
    pub position_size: Decimal,
    /// The rate applied, as a fraction.
    pub rate: Decimal,
    /// Milliseconds since the Unix epoch.
    #[ts(type = "number")]
    pub time: u64,
}

/// One print on a market's public trade tape.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = TS_FILE)]
pub struct Trade {
    /// `Market::id`.
    pub market: String,
    /// The venue's trade id, unique within the market.
    pub id: String,
    /// The aggressor's side: `buy` means a taker lifted an ask.
    pub side: Side,
    pub price: Decimal,
    /// In base units.
    pub size: Decimal,
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
        /// Adapters send market orders as IOC limits at this bound, so there's
        /// no unbounded market order.
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

/// Venue-agnostic order intent. Adapters translate it - into two steps where
/// a venue needs them - and reject what the venue can't express rather than
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
    /// Required by venues that margin each position separately;
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

/// `Pending` means accepted but not yet live - waiting on a keeper, an
/// auction or block inclusion - and may still end as `Rejected`.
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
    /// The venue's order id.
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
    /// The main account address - not the trade-only key's address.
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
    /// False on venues that fill against pools at oracle prices.
    pub order_book: bool,
    pub order_types: Vec<OrderType>,
    /// Whether orders take a `collateral` amount (isolated per-position margin).
    pub isolated_collateral: bool,
}
