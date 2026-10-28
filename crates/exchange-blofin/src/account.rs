//! An account's state and history as BloFin reports them, signed reads all
//! of them, and their translation into the domain's types. Sizes come in
//! contracts and leave in base units (`wire::Spec`); a row on a market
//! the adapter has no spec for (delisted since) is left out rather than
//! shown at the wrong size.

use pewterdesk_core::{
    AccountSnapshot, ClosedTrade, Decimal, Fill, FillEffect, FundingPayment, MarginMode, Order,
    OrderCategory, OrderStatus, OrderType, Position, PositionSide, PriceSource, Side,
    TradeSettings, VenueId,
};
use rust_decimal::Decimal as Raw;
use serde::Deserialize;

use crate::orders::{client_id_back, ALGO_PREFIX, TPSL_PREFIX, TRAIL_PREFIX};
use crate::wire::{ms, opt_num, text, zero_num, Specs};

fn side(s: &str) -> Side {
    if s == "sell" {
        Side::Sell
    } else {
        Side::Buy
    }
}

fn mode(s: &str) -> Option<MarginMode> {
    match s {
        "cross" => Some(MarginMode::Cross),
        "isolated" => Some(MarginMode::Isolated),
        _ => None,
    }
}

fn price_source(s: &str) -> Option<PriceSource> {
    match s {
        "last" => Some(PriceSource::Last),
        "mark" => Some(PriceSource::Mark),
        "index" => Some(PriceSource::Index),
        _ => None,
    }
}

/// A price where BloFin means "none" by empty, null, zero or `-1` (market).
fn price(p: Option<Decimal>) -> Option<Decimal> {
    p.filter(|p| p.0 > Raw::ZERO)
}

/// `GET /api/v1/account/balance`.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WireBalance {
    #[serde(default, deserialize_with = "zero_num")]
    pub total_equity: Decimal,
    #[serde(default)]
    pub details: Vec<WireAsset>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WireAsset {
    #[serde(default)]
    pub currency: String,
    /// The asset's equity, unrealized PnL included, in the asset itself.
    #[serde(default, deserialize_with = "opt_num")]
    pub equity: Option<Decimal>,
    #[serde(default, deserialize_with = "zero_num")]
    pub available: Decimal,
}

/// `GET /api/v1/account/positions`.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WirePosition {
    pub inst_id: String,
    #[serde(default)]
    pub margin_mode: String,
    #[serde(default)]
    pub position_side: String,
    /// Contracts; negative for a short in One-way Mode.
    #[serde(default, deserialize_with = "zero_num")]
    pub positions: Decimal,
    #[serde(default, deserialize_with = "zero_num")]
    pub average_price: Decimal,
    #[serde(default, deserialize_with = "zero_num")]
    pub mark_price: Decimal,
    #[serde(default, deserialize_with = "opt_num")]
    pub liquidation_price: Option<Decimal>,
    #[serde(default, deserialize_with = "zero_num")]
    pub unrealized_pnl: Decimal,
    /// An isolated position's margin.
    #[serde(default, deserialize_with = "opt_num")]
    pub margin: Option<Decimal>,
    /// A cross position's initial margin.
    #[serde(default, deserialize_with = "opt_num")]
    pub initial_margin: Option<Decimal>,
    #[serde(default, deserialize_with = "opt_num")]
    pub realized_pnl: Option<Decimal>,
    #[serde(default, deserialize_with = "opt_num")]
    pub leverage: Option<Decimal>,
}

impl WirePosition {
    pub fn long(&self) -> bool {
        match self.position_side.as_str() {
            "short" => false,
            "long" => true,
            _ => self.positions.0 > Raw::ZERO,
        }
    }
}

/// `GET /api/v1/trade/orders-pending` and `orders-history`.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WireOrder {
    #[serde(deserialize_with = "text")]
    pub order_id: String,
    #[serde(default, deserialize_with = "text")]
    pub client_order_id: String,
    pub inst_id: String,
    #[serde(default)]
    pub side: String,
    #[serde(default)]
    pub order_type: String,
    #[serde(default, deserialize_with = "opt_num")]
    pub price: Option<Decimal>,
    #[serde(default, deserialize_with = "zero_num")]
    pub size: Decimal,
    #[serde(default, deserialize_with = "text")]
    pub reduce_only: String,
    #[serde(default)]
    pub state: String,
    #[serde(default, deserialize_with = "zero_num")]
    pub filled_size: Decimal,
    #[serde(default, deserialize_with = "ms")]
    pub create_time: u64,
    #[serde(default, deserialize_with = "text")]
    pub order_category: String,
    #[serde(default, deserialize_with = "opt_num")]
    pub tp_trigger_price: Option<Decimal>,
    #[serde(default, deserialize_with = "opt_num")]
    pub sl_trigger_price: Option<Decimal>,
}

/// `GET /api/v1/trade/orders-tpsl-pending`.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WireTpsl {
    #[serde(deserialize_with = "text")]
    pub tpsl_id: String,
    #[serde(default, deserialize_with = "text")]
    pub client_order_id: String,
    pub inst_id: String,
    #[serde(default)]
    pub side: String,
    #[serde(default, deserialize_with = "opt_num")]
    pub tp_trigger_price: Option<Decimal>,
    #[serde(default, deserialize_with = "text")]
    pub tp_trigger_price_type: String,
    #[serde(default, deserialize_with = "opt_num")]
    pub sl_trigger_price: Option<Decimal>,
    #[serde(default, deserialize_with = "text")]
    pub sl_trigger_price_type: String,
    /// Contracts; `-1` for the whole position.
    #[serde(default, deserialize_with = "zero_num")]
    pub size: Decimal,
    #[serde(default, deserialize_with = "ms")]
    pub create_time: u64,
}

impl WireTpsl {
    /// Closes the whole position, whatever its size then.
    pub fn whole(&self) -> bool {
        self.size.0 < Raw::ZERO
    }
}

/// `GET /api/v1/trade/orders-algo-pending`, trigger or trailing stop.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WireAlgo {
    #[serde(deserialize_with = "text")]
    pub algo_id: String,
    #[serde(default, deserialize_with = "text")]
    pub client_order_id: String,
    pub inst_id: String,
    #[serde(default)]
    pub side: String,
    #[serde(default)]
    pub order_type: String,
    #[serde(default, deserialize_with = "zero_num")]
    pub size: Decimal,
    #[serde(default, deserialize_with = "text")]
    pub reduce_only: String,
    #[serde(default, deserialize_with = "opt_num")]
    pub trigger_price: Option<Decimal>,
    #[serde(default, deserialize_with = "text")]
    pub trigger_price_type: String,
    #[serde(default, deserialize_with = "opt_num")]
    pub order_price: Option<Decimal>,
    #[serde(default, deserialize_with = "opt_num")]
    pub callback_spread: Option<Decimal>,
    #[serde(default, deserialize_with = "opt_num")]
    pub move_trigger_price: Option<Decimal>,
    #[serde(default, deserialize_with = "ms")]
    pub create_time: u64,
}

/// `GET /api/v1/account/margin-mode`.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WireMarginMode {
    #[serde(default)]
    pub margin_mode: String,
}

impl WireMarginMode {
    pub fn mode(&self) -> MarginMode {
        mode(&self.margin_mode).unwrap_or(MarginMode::Cross)
    }
}

/// `GET /api/v1/account/position-mode`.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WirePositionMode {
    #[serde(default)]
    pub position_mode: String,
}

impl WirePositionMode {
    /// Hedge Mode, where BloFin ignores `reduceOnly`: this adapter won't
    /// trade it.
    pub fn hedge(&self) -> bool {
        self.position_mode != "net_mode"
    }
}

/// `GET /api/v1/account/batch-leverage-info`.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WireLeverage {
    pub inst_id: String,
    #[serde(default, deserialize_with = "zero_num")]
    pub leverage: Decimal,
}

/// The positions' exits, from the whole-position TP/SL and trailing orders.
fn exits(
    market: &str,
    long: bool,
    tpsl: &[WireTpsl],
    algos: &[WireAlgo],
) -> (Option<Decimal>, Option<Decimal>, Option<Decimal>) {
    let closing = if long { "sell" } else { "buy" };
    let mine = tpsl
        .iter()
        .filter(|o| o.inst_id == market && o.whole() && o.side == closing);
    let tp = mine.clone().find_map(|o| price(o.tp_trigger_price));
    let sl = mine.clone().find_map(|o| price(o.sl_trigger_price));
    let trailing = algos
        .iter()
        .filter(|a| a.inst_id == market && a.order_type == "trailing_stop" && a.side == closing)
        .find_map(|a| price(a.callback_spread));
    (tp, sl, trailing)
}

fn position(
    p: &WirePosition,
    specs: &Specs,
    tpsl: &[WireTpsl],
    algos: &[WireAlgo],
) -> Option<Position> {
    let spec = specs.get(&p.inst_id)?;
    if p.positions.0.is_zero() {
        return None;
    }
    let long = p.long();
    let (take_profit, stop_loss, trailing_stop) = exits(&p.inst_id, long, tpsl, algos);
    let margin_mode = mode(&p.margin_mode);
    let margin = match margin_mode {
        Some(MarginMode::Isolated) => p.margin.or(p.initial_margin),
        _ => p.initial_margin.or(p.margin),
    };
    Some(Position {
        venue: VenueId::Blofin,
        market: p.inst_id.clone(),
        side: if long {
            PositionSide::Long
        } else {
            PositionSide::Short
        },
        size: spec.base(Decimal(p.positions.0.abs())),
        entry_price: p.average_price,
        mark_price: p.mark_price,
        liquidation_price: price(p.liquidation_price),
        unrealized_pnl: p.unrealized_pnl,
        margin: margin.unwrap_or_default(),
        realized_pnl: p.realized_pnl,
        take_profit,
        stop_loss,
        trailing_stop,
        leverage: p.leverage,
        margin_mode,
    })
}

fn category(c: &str) -> OrderCategory {
    match c {
        "tp" => OrderCategory::TakeProfit,
        "sl" => OrderCategory::StopLoss,
        _ => OrderCategory::Regular,
    }
}

/// An ordinary order, open or past.
pub fn order(o: WireOrder, specs: &Specs, status: OrderStatus) -> Option<Order> {
    let spec = specs.get(&o.inst_id)?;
    Some(Order {
        venue: VenueId::Blofin,
        client_id: client_id_back(&o.client_order_id),
        market: o.inst_id,
        side: side(&o.side),
        order_type: if o.order_type == "market" {
            OrderType::Market
        } else {
            OrderType::Limit
        },
        size: spec.base(o.size),
        filled_size: spec.base(o.filled_size),
        price: price(o.price),
        trigger_price: None,
        reduce_only: o.reduce_only == "true",
        status,
        created_at: o.create_time,
        category: category(&o.order_category),
        trigger_by: None,
        take_profit: price(o.tp_trigger_price),
        stop_loss: price(o.sl_trigger_price),
        id: o.order_id,
    })
}

/// A TP/SL order: a whole-position one is sized as the position is now.
fn tpsl_order(o: &WireTpsl, specs: &Specs, positions: &[Position]) -> Option<Order> {
    let spec = specs.get(&o.inst_id)?;
    let size = if o.whole() {
        positions
            .iter()
            .find(|p| p.market == o.inst_id)
            .map(|p| p.size)
            .unwrap_or_default()
    } else {
        spec.base(o.size)
    };
    let sl = price(o.sl_trigger_price);
    let tp = price(o.tp_trigger_price);
    let (category, trigger, by) = match (sl, tp) {
        (Some(sl), _) => (OrderCategory::StopLoss, sl, &o.sl_trigger_price_type),
        (None, Some(tp)) => (OrderCategory::TakeProfit, tp, &o.tp_trigger_price_type),
        (None, None) => return None,
    };
    Some(Order {
        venue: VenueId::Blofin,
        id: format!("{TPSL_PREFIX}{}", o.tpsl_id),
        client_id: client_id_back(&o.client_order_id),
        market: o.inst_id.clone(),
        side: side(&o.side),
        order_type: OrderType::Trigger,
        size,
        filled_size: Decimal::default(),
        price: None,
        trigger_price: Some(trigger),
        reduce_only: true,
        status: OrderStatus::Open,
        created_at: o.create_time,
        category,
        trigger_by: price_source(by),
        take_profit: tp,
        stop_loss: sl,
    })
}

/// A trigger order or a trailing stop.
fn algo_order(a: &WireAlgo, specs: &Specs, positions: &[Position]) -> Option<Order> {
    let spec = specs.get(&a.inst_id)?;
    let trailing = a.order_type == "trailing_stop";
    let size = if a.size.0 < Raw::ZERO {
        positions
            .iter()
            .find(|p| p.market == a.inst_id)
            .map(|p| p.size)
            .unwrap_or_default()
    } else {
        spec.base(a.size)
    };
    Some(Order {
        venue: VenueId::Blofin,
        id: format!(
            "{}{}",
            if trailing { TRAIL_PREFIX } else { ALGO_PREFIX },
            a.algo_id
        ),
        client_id: client_id_back(&a.client_order_id),
        market: a.inst_id.clone(),
        side: side(&a.side),
        order_type: OrderType::Trigger,
        size,
        filled_size: Decimal::default(),
        price: if trailing { None } else { price(a.order_price) },
        trigger_price: if trailing {
            price(a.move_trigger_price)
        } else {
            price(a.trigger_price)
        },
        reduce_only: a.reduce_only == "true",
        status: OrderStatus::Open,
        created_at: a.create_time,
        category: if trailing {
            OrderCategory::TrailingStop
        } else {
            OrderCategory::Conditional
        },
        trigger_by: if trailing {
            Some(PriceSource::Last)
        } else {
            price_source(&a.trigger_price_type).or(Some(PriceSource::Last))
        },
        take_profit: None,
        stop_loss: None,
    })
}

/// The quote assets a BloFin futures account margins in.
const MARGIN_ASSETS: [&str; 2] = ["USDT", "USDC"];

#[allow(clippy::too_many_arguments)]
pub fn snapshot(
    id: &str,
    balance: WireBalance,
    positions: Vec<WirePosition>,
    orders: Vec<WireOrder>,
    tpsl: Vec<WireTpsl>,
    algos: Vec<WireAlgo>,
    specs: &Specs,
    time: u64,
) -> AccountSnapshot {
    let positions: Vec<Position> = positions
        .iter()
        .filter_map(|p| position(p, specs, &tpsl, &algos))
        .collect();
    let mut open_orders: Vec<Order> = orders
        .into_iter()
        .filter_map(|o| order(o, specs, OrderStatus::Open))
        .collect();
    open_orders.extend(tpsl.iter().filter_map(|o| tpsl_order(o, specs, &positions)));
    open_orders.extend(
        algos
            .iter()
            .filter_map(|a| algo_order(a, specs, &positions)),
    );
    open_orders.sort_by_key(|o| std::cmp::Reverse(o.created_at));
    let margin: Vec<&WireAsset> = balance
        .details
        .iter()
        .filter(|a| MARGIN_ASSETS.contains(&a.currency.as_str()))
        .collect();
    let available = margin.iter().map(|a| a.available.0).sum();
    // In the quote asset, as the positions are: `totalEquity` is a USD
    // valuation (1,000 USDT reads 998.69), kept only where no asset says.
    let equity = if margin.iter().any(|a| a.equity.is_some()) {
        Decimal(margin.iter().filter_map(|a| a.equity).map(|e| e.0).sum())
    } else {
        balance.total_equity
    };
    AccountSnapshot {
        venue: VenueId::Blofin,
        address: id.to_owned(),
        equity,
        available_margin: Decimal(available),
        realized_pnl: None,
        positions,
        open_orders,
        time,
    }
}

/// `GET /api/v1/trade/fills-history`.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WireFill {
    pub inst_id: String,
    #[serde(deserialize_with = "text")]
    pub trade_id: String,
    #[serde(default, deserialize_with = "text")]
    pub order_id: String,
    #[serde(default, deserialize_with = "zero_num")]
    pub fill_price: Decimal,
    #[serde(default, deserialize_with = "zero_num")]
    pub fill_size: Decimal,
    #[serde(default, deserialize_with = "zero_num")]
    pub fill_pnl: Decimal,
    #[serde(default)]
    pub position_side: String,
    #[serde(default)]
    pub side: String,
    #[serde(default, deserialize_with = "zero_num")]
    pub fee: Decimal,
    #[serde(default, deserialize_with = "ms")]
    pub ts: u64,
}

/// What a fill did. BloFin doesn't say in One-way Mode, so a fill that
/// realised P&L is taken to have closed, and one that didn't to have
/// opened; in Hedge Mode the position side says which.
fn effect(f: &WireFill) -> FillEffect {
    let buy = f.side == "buy";
    let closed = !f.fill_pnl.0.is_zero();
    match (f.position_side.as_str(), buy, closed) {
        ("long", true, _) => FillEffect::OpenLong,
        ("long", false, _) => FillEffect::CloseLong,
        ("short", false, _) => FillEffect::OpenShort,
        ("short", true, _) => FillEffect::CloseShort,
        (_, true, false) => FillEffect::OpenLong,
        (_, true, true) => FillEffect::CloseShort,
        (_, false, false) => FillEffect::OpenShort,
        (_, false, true) => FillEffect::CloseLong,
    }
}

pub fn fill(f: WireFill, specs: &Specs) -> Option<Fill> {
    let spec = specs.get(&f.inst_id)?;
    let quote = f
        .inst_id
        .split_once('-')
        .map_or("USDT", |(_, q)| q)
        .to_owned();
    Some(Fill {
        venue: VenueId::Blofin,
        effect: effect(&f),
        id: f.trade_id,
        order_id: f.order_id,
        market: f.inst_id,
        side: side(&f.side),
        price: f.fill_price,
        size: spec.base(f.fill_size),
        closed_pnl: f.fill_pnl,
        fee: f.fee,
        fee_asset: quote,
        // BloFin's fills don't say which side of the book they took.
        taker: false,
        time: f.ts,
    })
}

/// `GET /api/v1/account/positions-history`.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WireClosed {
    pub inst_id: String,
    #[serde(default)]
    pub side: String,
    #[serde(default)]
    pub position_side: String,
    #[serde(default, deserialize_with = "zero_num")]
    pub close_positions: Decimal,
    #[serde(default, deserialize_with = "zero_num")]
    pub open_average_price: Decimal,
    #[serde(default, deserialize_with = "zero_num")]
    pub close_average_price: Decimal,
    #[serde(default, deserialize_with = "ms")]
    pub create_time: u64,
    #[serde(default, deserialize_with = "ms")]
    pub update_time: u64,
    #[serde(default, deserialize_with = "opt_num")]
    pub leverage: Option<Decimal>,
    #[serde(default, deserialize_with = "zero_num")]
    pub realized_pnl: Decimal,
}

pub fn closed_trade(c: WireClosed, specs: &Specs) -> Option<ClosedTrade> {
    let spec = specs.get(&c.inst_id)?;
    let long = match c.position_side.as_str() {
        "long" => true,
        "short" => false,
        _ => c.side != "sell",
    };
    let size = spec.base(Decimal(c.close_positions.0.abs()));
    if size.0.is_zero() {
        return None;
    }
    Some(ClosedTrade {
        venue: VenueId::Blofin,
        market: c.inst_id,
        side: if long {
            PositionSide::Long
        } else {
            PositionSide::Short
        },
        entry_value: Decimal(size.0 * c.open_average_price.0),
        size,
        entry_price: c.open_average_price,
        exit_price: c.close_average_price,
        closed_pnl: c.realized_pnl,
        leverage: c.leverage,
        time: c.update_time,
        opened_at: (c.create_time > 0).then_some(c.create_time),
    })
}

/// A past order's state.
pub fn history_status(o: &WireOrder) -> OrderStatus {
    match o.state.as_str() {
        "filled" => OrderStatus::Filled,
        "live" | "partially_filled" => OrderStatus::Open,
        _ if o.filled_size.0 > Raw::ZERO => OrderStatus::Filled,
        _ => OrderStatus::Cancelled,
    }
}

/// `GET /api/v1/account/funding-fees`.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WireFundingFee {
    pub inst_id: String,
    #[serde(default, deserialize_with = "zero_num")]
    pub funding_fee: Decimal,
    #[serde(default, deserialize_with = "ms")]
    pub funding_time: u64,
    #[serde(default, deserialize_with = "zero_num")]
    pub position_size: Decimal,
}

/// BloFin's funding bill names no rate; it reads zero.
pub fn funding_payment(f: WireFundingFee, specs: &Specs) -> Option<FundingPayment> {
    let spec = specs.get(&f.inst_id)?;
    Some(FundingPayment {
        venue: VenueId::Blofin,
        market: f.inst_id,
        amount: f.funding_fee,
        position_size: spec.base(f.position_size),
        rate: Decimal::default(),
        time: f.funding_time,
    })
}

pub fn trade_settings(mode: MarginMode, leverage: Decimal, max: u32) -> TradeSettings {
    TradeSettings {
        margin_mode: mode,
        margin_mode_account_wide: true,
        leverage,
        max_leverage: Decimal(Raw::from(max)),
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;
    use crate::wire::Spec;

    fn d(s: &str) -> Decimal {
        Decimal(s.parse().unwrap())
    }

    fn specs() -> Specs {
        let mut s = Specs::new();
        for (id, cv) in [
            ("ETH-USDT", "0.01"),
            ("BCH-USDT", "0.01"),
            ("BTC-USDT", "0.001"),
        ] {
            s.insert(
                id.into(),
                Spec {
                    contract_value: d(cv),
                    tick: d("0.01"),
                    lot: d("1"),
                    min_contracts: d("1"),
                    max_leverage: 100,
                },
            );
        }
        s
    }

    fn from<T: for<'de> Deserialize<'de>>(v: serde_json::Value) -> T {
        serde_json::from_value(v).unwrap()
    }

    /// The docs' examples ("GET Futures Account Balance", "GET Positions",
    /// "GET Active Orders", "GET Active TPSL Orders", "GET Active Algo Orders").
    #[test]
    fn builds_a_snapshot_from_the_docs_examples() {
        let balance: WireBalance = from(json!({
            "ts":"1697021343571","totalEquity":"10011254.077985990315787910","isolatedEquity":"861.76",
            "details":[{"currency":"USDT","equity":"10014042.98","balance":"10013119.88","ts":"1697021343571",
                        "isolatedEquity":"862.0032","available":"9996399.4708691159703362725",
                        "availableEquity":"9996399.47","frozen":"15805.14","orderFrozen":"14920.99",
                        "equityUsd":"10011254.07","isolatedUnrealizedPnl":"-22.15","bonus":"0"}]
        }));
        let positions: Vec<WirePosition> = from(json!([
            {"positionId":"7982","instId":"ETH-USDT","instType":"SWAP","marginMode":"isolated","positionSide":"net",
             "adl":"5","positions":"1","availablePositions":"1","averagePrice":"1591.800000000000000000",
             "margin":"53.060000000000000000","markPrice":"1591.69","marginRatio":"72.45",
             "liquidationPrice":"1066.104078762306610407","unrealizedPnl":"-0.011","unrealizedPnlRatio":"-0.0002",
             "maintenanceMargin":"0.636676","createTime":"1695352782370","updateTime":"1695352782372","leverage":"3"},
            {"positionId":"5483","instId":"BCH-USDT","instType":"SWAP","marginMode":"cross","positionSide":"net",
             "adl":"5","positions":"-290","availablePositions":"-290","averagePrice":"1890.000000000000000000",
             "markPrice":"1889","marginRatio":"172426.85","liquidationPrice":"3418227.599542259480103079",
             "unrealizedPnl":"2.9","unrealizedPnlRatio":"0.0015","initialMargin":"1826.033333333333333333",
             "maintenanceMargin":"54.781","createTime":"1695090016933","updateTime":"1695090016931","leverage":"3"}
        ]));
        let orders: Vec<WireOrder> = from(json!([
            {"orderId":"29531103","clientOrderId":"00000000000000010000000000000002","instId":"ETH-USDT",
             "marginMode":"isolated","positionSide":"net","side":"buy","orderType":"limit",
             "price":"1514.150000000000000000","size":"1.000000000000000000","reduceOnly":"false","leverage":"3",
             "state":"live","filledSize":"0.000000000000000000","averagePrice":"0","fee":"0","pnl":"0",
             "createTime":"1697031292762","updateTime":"1697031292788","orderCategory":"normal",
             "tpTriggerPrice":"1688.000000000000000000","tpTriggerPriceType":"last",
             "slTriggerPrice":"1299.000000000000000000","slOrderPrice":null,"slTriggerPriceType":"last",
             "tpOrderPrice":null,"algoClientOrderId":"","algoId":"","brokerId":""}
        ]));
        let tpsl: Vec<WireTpsl> = from(json!([
            {"tpslId":"2411","instId":"ETH-USDT","marginMode":"cross","positionSide":"net","side":"sell",
             "tpTriggerPrice":"1666.000000000000000000","tpOrderPrice":null,"tpTriggerPriceType":"last",
             "slTriggerPrice":"1222.000000000000000000","slOrderPrice":null,"slTriggerPriceType":"mark",
             "size":"-1","state":"live","leverage":"3","reduceOnly":"true","actualSize":null,
             "clientOrderId":"aabbc","createTime":"1697016700775","brokerId":""}
        ]));
        let algos: Vec<WireAlgo> = from(json!([
            {"algoId":"2101000000001234","clientOrderId":"trail001","instId":"BCH-USDT","marginMode":"cross",
             "positionSide":"net","side":"buy","orderType":"trailing_stop","size":"-1","state":"live",
             "callbackRatio":"","callbackSpread":"25","activePrice":"","moveTriggerPrice":"1914",
             "reduceOnly":"true","positionId":"","brokerId":"","createTime":"1784800000000","updateTime":"1784800012345"}
        ]));
        let s = snapshot(
            "demo:1",
            balance,
            positions,
            orders,
            tpsl,
            algos,
            &specs(),
            9,
        );
        // The USDT equity, not `totalEquity`'s USD valuation.
        assert_eq!(s.equity, d("10014042.98"));
        assert_eq!(s.available_margin, d("9996399.4708691159703362725"));
        let eth = &s.positions[0];
        assert_eq!(
            (eth.side, eth.size, eth.margin),
            (PositionSide::Long, d("0.01"), d("53.06"))
        );
        assert_eq!(
            (eth.take_profit, eth.stop_loss),
            (Some(d("1666")), Some(d("1222")))
        );
        assert_eq!(eth.margin_mode, Some(MarginMode::Isolated));
        let bch = &s.positions[1];
        assert_eq!(
            (bch.side, bch.size, bch.margin),
            (PositionSide::Short, d("2.90"), d("1826.033333333333333333"))
        );
        assert_eq!(bch.trailing_stop, Some(d("25")));
        let ids: Vec<&str> = s.open_orders.iter().map(|o| o.id.as_str()).collect();
        assert_eq!(ids, ["trail:2101000000001234", "29531103", "tpsl:2411"]);
        let limit = &s.open_orders[1];
        assert_eq!(
            limit.client_id.as_deref(),
            Some("0x00000000000000010000000000000002")
        );
        assert_eq!(
            (limit.size, limit.take_profit),
            (d("0.01"), Some(d("1688")))
        );
        let exit = &s.open_orders[2];
        assert_eq!(
            (exit.category, exit.size, exit.trigger_by),
            (OrderCategory::StopLoss, d("0.01"), Some(PriceSource::Mark))
        );
        assert_eq!(s.open_orders[0].category, OrderCategory::TrailingStop);
    }

    /// What Demo Trading answered for a fresh account (2026-10): 1,000 USDT,
    /// which `totalEquity` values at 998.685 USD.
    #[test]
    fn equity_is_in_usdt_not_its_usd_value() {
        let balance: WireBalance = from(json!({
            "details":[{"available":"1000.00","availableEquity":"1000.00","balance":"1000",
                        "currency":"USDT","equity":"1000","frozen":"0"}],
            "totalEquity":"998.685000000000000000"
        }));
        let s = snapshot(
            "demo:1",
            balance,
            vec![],
            vec![],
            vec![],
            vec![],
            &specs(),
            0,
        );
        assert_eq!((s.equity, s.available_margin), (d("1000"), d("1000.00")));
    }

    #[test]
    fn a_row_on_an_unknown_market_is_left_out() {
        let positions: Vec<WirePosition> = from(
            json!([{"instId":"GONE-USDT","positions":"5","averagePrice":"1","markPrice":"1"}]),
        );
        let s = snapshot(
            "demo:1",
            from(json!({"totalEquity":"1","details":[]})),
            positions,
            vec![],
            vec![],
            vec![],
            &specs(),
            0,
        );
        assert!(s.positions.is_empty());
    }

    #[test]
    fn fills_read_whether_they_opened_or_closed() {
        let f = |side: &str, pnl: &str| -> WireFill {
            from(
                json!({"instId":"ETH-USDT","tradeId":"7772187","orderId":"28697026","fillPrice":"1587.8",
                        "fillSize":"2","fillPnl":pnl,"positionSide":"net","side":side,"fee":"0.19","ts":"1696853354238"}),
            )
        };
        let open = fill(f("buy", "0"), &specs()).unwrap();
        assert_eq!(
            (open.effect, open.size, open.fee_asset.as_str()),
            (FillEffect::OpenLong, d("0.02"), "USDT")
        );
        assert_eq!(
            fill(f("sell", "1.2"), &specs()).unwrap().effect,
            FillEffect::CloseLong
        );
        assert_eq!(
            fill(f("buy", "-1"), &specs()).unwrap().effect,
            FillEffect::CloseShort
        );
    }

    #[test]
    fn closed_positions_come_from_the_position_history() {
        let c: WireClosed = from(json!({
            "historyId":"1234567891","positionId":"5483","instId":"BCH-USDT","instType":"SWAP","side":"sell",
            "marginMode":"cross","positionSide":"net","closePositions":"290","maxPositions":"290",
            "liquidationPositions":"0","openAveragePrice":"1890","closeAveragePrice":"1887",
            "createTime":"1695090016933","updateTime":"1695090016931","leverage":"3","realizedPnl":"-8.7",
            "realizedPnlRatio":"-0.0046","fee":"0.5472"
        }));
        let t = closed_trade(c, &specs()).unwrap();
        assert_eq!(
            (t.side, t.size, t.exit_price),
            (PositionSide::Short, d("2.90"), d("1887"))
        );
        assert_eq!(t.entry_value, d("5481.00"));
        assert_eq!(t.opened_at, Some(1695090016933));
    }

    #[test]
    fn hedge_mode_is_read() {
        assert!(!from::<WirePositionMode>(
            json!({"positionMode":"net_mode","multiPosition":"false"})
        )
        .hedge());
        assert!(from::<WirePositionMode>(json!({"positionMode":"long_short_mode"})).hedge());
        assert_eq!(
            from::<WireMarginMode>(json!({"marginMode":"isolated"})).mode(),
            MarginMode::Isolated
        );
    }
}
