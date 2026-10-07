//! A Bybit account's balances, positions and open orders, from the private
//! V5 endpoints (signed, read-only), mapped into the domain types.
//!
//! Only Unified Trading Accounts: their balance is one figure in USD across
//! every coin, which is what the account panels show. Linear contracts settle
//! in USDT or USDC, so positions and orders are read for both.

use pewterdesk_core::{
    AccountSnapshot, ClosedTrade, Decimal, Fill, FillEffect, FundingPayment, MarginMode, Order,
    OrderCategory, OrderStatus, OrderType, Position, PositionSide, PriceSource, Side, VenueId,
};
use serde::Deserialize;

use crate::wire::{decimal, opt_decimal};

/// The coins linear contracts settle in; positions and orders are listed per coin.
pub(crate) const SETTLE_COINS: [&str; 2] = ["USDT", "USDC"];

#[derive(Deserialize)]
pub(crate) struct List<T> {
    pub list: Vec<T>,
}

/// `GET /v5/account/info`: only the margin mode is read.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AccountInfo {
    #[serde(default)]
    pub margin_mode: String,
}

impl AccountInfo {
    /// Portfolio margin pools collateral like cross does, so it reads as cross.
    pub(crate) fn mode(&self) -> MarginMode {
        if self.margin_mode == "ISOLATED_MARGIN" {
            MarginMode::Isolated
        } else {
            MarginMode::Cross
        }
    }
}

/// A row of `GET /v5/position/list` for one market: its leverage, which
/// Bybit lists even with no position open.
#[derive(Deserialize)]
pub(crate) struct WireLeverage {
    #[serde(default)]
    pub leverage: String,
}

/// The result of `POST /v5/account/set-margin-mode`: why not, if refused.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct MarginModeResult {
    #[serde(default)]
    pub reasons: Vec<MarginModeReason>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct MarginModeReason {
    #[serde(default)]
    pub reason_msg: String,
}

/// One account's row of `GET /v5/account/wallet-balance`.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Wallet {
    /// In USD, across every coin, including unrealized PnL.
    #[serde(default)]
    total_equity: String,
    /// In USD: what can still back new positions. Empty when the account
    /// is in isolated margin mode, where Bybit has no account-wide figure.
    #[serde(default)]
    total_available_balance: String,
    #[serde(default)]
    coin: Vec<WalletCoin>,
}

/// One coin of the wallet: enough to work out what's free in it.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct WalletCoin {
    #[serde(default)]
    coin: String,
    #[serde(default)]
    wallet_balance: String,
    /// Margin held by open positions and by resting orders.
    #[serde(default, rename = "totalPositionIM")]
    total_position_im: String,
    #[serde(default, rename = "totalOrderIM")]
    total_order_im: String,
    #[serde(default)]
    locked: String,
    /// Realised PnL over the account's life, in this coin.
    #[serde(default)]
    cum_realised_pnl: String,
}

impl Wallet {
    /// Realised PnL over the account's life, in USD: the settle coins' running
    /// totals, which is where linear contracts realise. None if Bybit sent none.
    fn realized_pnl(&self) -> Option<Decimal> {
        let totals: Vec<rust_decimal::Decimal> = self
            .coin
            .iter()
            .filter(|c| SETTLE_COINS.contains(&c.coin.as_str()))
            .filter_map(|c| opt_decimal(&c.cum_realised_pnl).map(|d| d.0))
            .collect();
        (!totals.is_empty()).then(|| Decimal(totals.into_iter().sum()))
    }

    /// What can still back new positions. The account-wide figure where
    /// Bybit gives one; otherwise (isolated margin mode) what's free in the
    /// settle coins, which are what linear contracts margin in there.
    fn available(&self) -> Decimal {
        if let Some(total) = opt_decimal(&self.total_available_balance) {
            return total;
        }
        let free: rust_decimal::Decimal = self
            .coin
            .iter()
            .filter(|c| SETTLE_COINS.contains(&c.coin.as_str()))
            .map(|c| {
                decimal(&c.wallet_balance).0
                    - decimal(&c.total_position_im).0
                    - decimal(&c.total_order_im).0
                    - decimal(&c.locked).0
            })
            .sum();
        Decimal(free.max(rust_decimal::Decimal::ZERO))
    }
}

/// A row of `GET /v5/position/list`. Closed positions can still be listed,
/// with a zero size and an empty side.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct WirePosition {
    symbol: String,
    side: String,
    size: String,
    #[serde(default)]
    avg_price: String,
    #[serde(default)]
    mark_price: String,
    #[serde(default)]
    liq_price: String,
    #[serde(default)]
    unrealised_pnl: String,
    /// Initial margin; on some account modes only `position_balance` is set.
    #[serde(default, rename = "positionIM")]
    position_im: String,
    #[serde(default)]
    position_balance: String,
    /// Realized on the position as it stands (closed parts, fees, funding).
    #[serde(default)]
    cur_realised_pnl: String,
    #[serde(default)]
    leverage: String,
    /// The position's TP/SL and trailing distance; "0" or "" when unset.
    #[serde(default)]
    take_profit: String,
    #[serde(default)]
    stop_loss: String,
    #[serde(default)]
    trailing_stop: String,
}

/// A row of `GET /v5/order/realtime`: an open (or untriggered) order.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct WireOrder {
    order_id: String,
    #[serde(default)]
    order_link_id: String,
    symbol: String,
    side: String,
    order_type: String,
    qty: String,
    #[serde(default)]
    cum_exec_qty: String,
    #[serde(default)]
    price: String,
    #[serde(default)]
    trigger_price: String,
    #[serde(default)]
    reduce_only: bool,
    #[serde(default)]
    order_status: String,
    #[serde(default)]
    created_time: String,
    /// What a triggered order is for: "TakeProfit", "StopLoss",
    /// "TrailingStop", "Stop", "MmRateClose", ...; "" for a plain order.
    #[serde(default)]
    stop_order_type: String,
    /// "LastPrice", "MarkPrice" or "IndexPrice".
    #[serde(default)]
    trigger_by: String,
    /// TP and SL attached to the order; "" or "0" when none.
    #[serde(default)]
    take_profit: String,
    #[serde(default)]
    stop_loss: String,
}

/// A price Bybit sends as "0" (or "") when it isn't set.
fn set(s: &str) -> Option<Decimal> {
    opt_decimal(s).filter(|d| !d.0.is_zero())
}

fn position(p: WirePosition) -> Option<Position> {
    let size = decimal(&p.size);
    let side = match p.side.as_str() {
        "Buy" => PositionSide::Long,
        "Sell" => PositionSide::Short,
        _ => return None,
    };
    if size.0.is_zero() {
        return None;
    }
    let margin = opt_decimal(&p.position_im)
        .filter(|m| !m.0.is_zero())
        .unwrap_or_else(|| decimal(&p.position_balance));
    Some(Position {
        venue: VenueId::Bybit,
        market: p.symbol,
        side,
        size,
        entry_price: decimal(&p.avg_price),
        mark_price: decimal(&p.mark_price),
        liquidation_price: opt_decimal(&p.liq_price).filter(|l| !l.0.is_zero()),
        unrealized_pnl: decimal(&p.unrealised_pnl),
        margin,
        realized_pnl: opt_decimal(&p.cur_realised_pnl),
        take_profit: set(&p.take_profit),
        stop_loss: set(&p.stop_loss),
        trailing_stop: set(&p.trailing_stop),
        leverage: set(&p.leverage),
        // Account-wide on a unified account; `snapshot` fills it in.
        margin_mode: None,
    })
}

pub(crate) fn order(o: WireOrder) -> Option<Order> {
    let side = match o.side.as_str() {
        "Buy" => Side::Buy,
        "Sell" => Side::Sell,
        _ => return None,
    };
    let trigger_price = opt_decimal(&o.trigger_price).filter(|t| !t.0.is_zero());
    let order_type = if trigger_price.is_some() {
        OrderType::Trigger
    } else if o.order_type == "Market" {
        OrderType::Market
    } else {
        OrderType::Limit
    };
    let status = match o.order_status.as_str() {
        "Filled" => OrderStatus::Filled,
        "Cancelled" | "PartiallyFilledCanceled" | "Deactivated" => OrderStatus::Cancelled,
        "Rejected" => OrderStatus::Rejected,
        // New, PartiallyFilled, Untriggered, Triggered: still working.
        _ => OrderStatus::Open,
    };
    Some(Order {
        venue: VenueId::Bybit,
        id: o.order_id,
        client_id: (!o.order_link_id.is_empty()).then_some(o.order_link_id),
        market: o.symbol,
        side,
        order_type,
        size: decimal(&o.qty),
        filled_size: decimal(&o.cum_exec_qty),
        price: opt_decimal(&o.price).filter(|p| !p.0.is_zero()),
        trigger_price,
        reduce_only: o.reduce_only,
        status,
        created_at: o.created_time.parse().unwrap_or(0),
        category: match o.stop_order_type.as_str() {
            "TakeProfit" | "PartialTakeProfit" => OrderCategory::TakeProfit,
            "StopLoss" | "PartialStopLoss" => OrderCategory::StopLoss,
            "TrailingStop" => OrderCategory::TrailingStop,
            "MmRateClose" => OrderCategory::MmrClose,
            "" if trigger_price.is_none() => OrderCategory::Regular,
            _ => OrderCategory::Conditional,
        },
        trigger_by: match o.trigger_by.as_str() {
            "LastPrice" => Some(PriceSource::Last),
            "MarkPrice" => Some(PriceSource::Mark),
            "IndexPrice" => Some(PriceSource::Index),
            _ => None,
        },
        take_profit: set(&o.take_profit),
        stop_loss: set(&o.stop_loss),
    })
}

/// A row of `GET /v5/execution/list`: one of the account's fills.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct WireExecution {
    symbol: String,
    #[serde(default)]
    order_id: String,
    #[serde(default)]
    exec_id: String,
    side: String,
    #[serde(default)]
    exec_price: String,
    #[serde(default)]
    exec_qty: String,
    #[serde(default)]
    exec_fee: String,
    #[serde(default)]
    fee_currency: String,
    #[serde(default)]
    is_maker: bool,
    #[serde(default)]
    exec_time: String,
    /// How much of the fill closed an existing position.
    #[serde(default)]
    closed_size: String,
    /// PnL the closing part realised; on newer accounts only.
    #[serde(default)]
    exec_pnl: String,
    /// "Trade" for a fill; liquidations, settlements and the like otherwise.
    #[serde(default)]
    exec_type: String,
}

/// The coin a linear market settles in, from its symbol.
fn settle_coin(symbol: &str) -> &'static str {
    if symbol.ends_with("USDT") {
        "USDT"
    } else {
        "USDC"
    }
}

/// What a fill did to the position: opened, closed, or closed and flipped.
fn effect(side: Side, qty: Decimal, closed: Decimal, exec_type: &str) -> FillEffect {
    if exec_type != "Trade" {
        return FillEffect::Other;
    }
    let none = closed.0.is_zero();
    let all = closed.0 >= qty.0;
    match (side, none, all) {
        (Side::Buy, true, _) => FillEffect::OpenLong,
        (Side::Sell, true, _) => FillEffect::OpenShort,
        (Side::Buy, false, true) => FillEffect::CloseShort,
        (Side::Sell, false, true) => FillEffect::CloseLong,
        (Side::Buy, false, false) => FillEffect::ShortToLong,
        (Side::Sell, false, false) => FillEffect::LongToShort,
    }
}

pub(crate) fn fill(e: WireExecution) -> Option<Fill> {
    let side = match e.side.as_str() {
        "Buy" => Side::Buy,
        "Sell" => Side::Sell,
        _ => return None,
    };
    let size = decimal(&e.exec_qty);
    let fee_asset = if e.fee_currency.is_empty() {
        settle_coin(&e.symbol).to_owned()
    } else {
        e.fee_currency
    };
    Some(Fill {
        venue: VenueId::Bybit,
        id: e.exec_id,
        order_id: e.order_id,
        effect: effect(side, size, decimal(&e.closed_size), &e.exec_type),
        market: e.symbol,
        side,
        price: decimal(&e.exec_price),
        size,
        closed_pnl: decimal(&e.exec_pnl),
        fee: decimal(&e.exec_fee),
        fee_asset,
        taker: !e.is_maker,
        time: e.exec_time.parse().unwrap_or(0),
    })
}

/// A row of `GET /v5/position/closed-pnl`: a position closed, in full or part.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct WireClosed {
    symbol: String,
    /// The side of the order that closed it: "Sell" closed a long.
    side: String,
    #[serde(default)]
    closed_size: String,
    #[serde(default)]
    avg_entry_price: String,
    #[serde(default)]
    avg_exit_price: String,
    #[serde(default)]
    closed_pnl: String,
    #[serde(default)]
    cum_entry_value: String,
    #[serde(default)]
    leverage: String,
    #[serde(default)]
    updated_time: String,
}

pub(crate) fn closed(c: WireClosed) -> Option<ClosedTrade> {
    let side = match c.side.as_str() {
        "Sell" => PositionSide::Long,
        "Buy" => PositionSide::Short,
        _ => return None,
    };
    Some(ClosedTrade {
        venue: VenueId::Bybit,
        market: c.symbol,
        side,
        size: decimal(&c.closed_size),
        entry_price: decimal(&c.avg_entry_price),
        exit_price: decimal(&c.avg_exit_price),
        closed_pnl: decimal(&c.closed_pnl),
        entry_value: decimal(&c.cum_entry_value),
        leverage: set(&c.leverage),
        time: c.updated_time.parse().unwrap_or(0),
    })
}

/// A `SETTLEMENT` row of `GET /v5/account/transaction-log`: a funding payment.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct WireSettlement {
    #[serde(default)]
    symbol: String,
    #[serde(default)]
    side: String,
    /// The position's size when it settled.
    #[serde(default)]
    size: String,
    /// What the wallet gained (positive) or paid (negative).
    #[serde(default)]
    change: String,
    /// The funding rate applied.
    #[serde(default)]
    fee_rate: String,
    #[serde(default)]
    transaction_time: String,
}

pub(crate) fn funding(s: WireSettlement) -> Option<FundingPayment> {
    if s.symbol.is_empty() {
        return None;
    }
    let size = decimal(&s.size);
    let position_size = if s.side == "Sell" {
        Decimal(-size.0)
    } else {
        size
    };
    Some(FundingPayment {
        venue: VenueId::Bybit,
        market: s.symbol,
        amount: decimal(&s.change),
        position_size,
        rate: decimal(&s.fee_rate),
        time: s.transaction_time.parse().unwrap_or(0),
    })
}

/// The snapshot for account `uid` from Bybit's three replies.
pub(crate) fn snapshot(
    uid: &str,
    wallet: Option<Wallet>,
    positions: Vec<WirePosition>,
    orders: Vec<WireOrder>,
    margin_mode: Option<MarginMode>,
    time: u64,
) -> AccountSnapshot {
    let (equity, available, realized_pnl) = wallet
        .map(|w| (decimal(&w.total_equity), w.available(), w.realized_pnl()))
        .unwrap_or((Decimal::default(), Decimal::default(), None));
    AccountSnapshot {
        venue: VenueId::Bybit,
        address: uid.to_owned(),
        equity,
        available_margin: available,
        realized_pnl,
        positions: positions
            .into_iter()
            .filter_map(position)
            .map(|p| Position { margin_mode, ..p })
            .collect(),
        open_orders: orders.into_iter().filter_map(order).collect(),
        time,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn d(s: &str) -> Decimal {
        Decimal(s.parse().unwrap())
    }

    #[test]
    fn maps_a_unified_account() {
        let wallet: List<Wallet> = serde_json::from_value(json!({ "list": [{
            "accountType": "UNIFIED", "totalEquity": "1520.37", "totalWalletBalance": "1500",
            "totalAvailableBalance": "1201.5", "totalPerpUPL": "20.37", "coin": []
        }]}))
        .unwrap();
        let positions: List<WirePosition> = serde_json::from_value(json!({ "list": [
            { "symbol": "BTCUSDT", "side": "Buy", "size": "0.010", "avgPrice": "83000",
              "markPrice": "83756.4", "liqPrice": "41000.5", "unrealisedPnl": "7.564",
              "positionIM": "83.1", "positionBalance": "84", "curRealisedPnl": "-0.46",
              "takeProfit": "90000", "stopLoss": "80000", "trailingStop": "0" },
            { "symbol": "ETHUSDT", "side": "Sell", "size": "0.5", "avgPrice": "2700",
              "markPrice": "2694.77", "liqPrice": "", "unrealisedPnl": "2.615",
              "positionIM": "", "positionBalance": "135" },
            // A closed position Bybit still lists.
            { "symbol": "SOLUSDT", "side": "", "size": "0", "avgPrice": "0",
              "markPrice": "117.6", "liqPrice": "", "unrealisedPnl": "0" }
        ]}))
        .unwrap();
        let orders: List<WireOrder> = serde_json::from_value(json!({ "list": [
            { "orderId": "a1", "orderLinkId": "", "symbol": "BTCUSDT", "side": "Buy",
              "orderType": "Limit", "qty": "0.002", "cumExecQty": "0", "price": "80000",
              "triggerPrice": "", "reduceOnly": false, "orderStatus": "New",
              "createdTime": "1790880000000" },
            { "orderId": "a2", "orderLinkId": "pd-1", "symbol": "BTCUSDT", "side": "Sell",
              "orderType": "Market", "qty": "0.010", "cumExecQty": "0", "price": "0",
              "triggerPrice": "79000", "reduceOnly": true, "orderStatus": "Untriggered",
              "createdTime": "1790880001000" },
            { "orderId": "a3", "symbol": "BTCUSDT", "side": "Sell", "orderType": "Market",
              "qty": "0", "price": "0", "triggerPrice": "90000", "reduceOnly": true,
              "orderStatus": "Untriggered", "createdTime": "1790880002000",
              "stopOrderType": "TakeProfit", "triggerBy": "LastPrice" }
        ]}))
        .unwrap();

        let s = snapshot(
            "24617703",
            wallet.list.into_iter().next(),
            positions.list,
            orders.list,
            Some(MarginMode::Isolated),
            5,
        );
        assert!(s
            .positions
            .iter()
            .all(|p| p.margin_mode == Some(MarginMode::Isolated)));
        assert_eq!(s.address, "24617703");
        assert_eq!((s.equity, s.available_margin), (d("1520.37"), d("1201.5")));

        assert_eq!(s.positions.len(), 2);
        let btc = &s.positions[0];
        assert_eq!(
            (btc.side, btc.size, btc.margin),
            (PositionSide::Long, d("0.010"), d("83.1"))
        );
        assert_eq!(btc.liquidation_price, Some(d("41000.5")));
        assert_eq!(btc.realized_pnl, Some(d("-0.46")));
        assert_eq!(
            (btc.take_profit, btc.stop_loss, btc.trailing_stop),
            (Some(d("90000")), Some(d("80000")), None)
        );
        let eth = &s.positions[1];
        assert_eq!(
            (eth.side, eth.margin, eth.liquidation_price),
            (PositionSide::Short, d("135"), None)
        );

        let [limit, stop, tp] = &s.open_orders[..] else {
            panic!("{:?}", s.open_orders)
        };
        assert_eq!(limit.category, OrderCategory::Regular);
        // A trigger order with no stop type is a conditional order.
        assert_eq!(stop.category, OrderCategory::Conditional);
        assert_eq!(
            (tp.category, tp.trigger_by),
            (OrderCategory::TakeProfit, Some(PriceSource::Last))
        );
        assert_eq!(
            (limit.order_type, limit.price, limit.client_id.as_deref()),
            (OrderType::Limit, Some(d("80000")), None)
        );
        assert_eq!(
            (stop.order_type, stop.price, stop.trigger_price),
            (OrderType::Trigger, None, Some(d("79000")))
        );
        assert!(stop.reduce_only && stop.status == OrderStatus::Open);
        assert_eq!(stop.created_at, 1790880001000);
    }

    #[test]
    fn maps_fills_with_what_they_did() {
        let rows: List<WireExecution> = serde_json::from_value(json!({ "list": [
            { "symbol": "BTCUSDT", "orderId": "o1", "execId": "e1", "side": "Buy",
              "execPrice": "83000", "execQty": "0.010", "execFee": "0.4565",
              "feeCurrency": "USDT", "isMaker": false, "execTime": "1790880000000",
              "closedSize": "0", "execType": "Trade" },
            { "symbol": "BTCUSDT", "orderId": "o2", "execId": "e2", "side": "Sell",
              "execPrice": "84000", "execQty": "0.010", "execFee": "0.168",
              "isMaker": true, "execTime": "1790880100000", "closedSize": "0.010",
              "execPnl": "10", "execType": "Trade" },
            { "symbol": "ETHPERP", "orderId": "o3", "execId": "e3", "side": "Sell",
              "execPrice": "2700", "execQty": "1", "closedSize": "0.4", "execType": "Trade" },
            { "symbol": "BTCUSDT", "orderId": "o4", "execId": "e4", "side": "Sell",
              "execPrice": "70000", "execQty": "0.01", "closedSize": "0.01", "execType": "BustTrade" }
        ]}))
        .unwrap();
        let fills: Vec<Fill> = rows.list.into_iter().filter_map(fill).collect();
        let effects: Vec<FillEffect> = fills.iter().map(|f| f.effect).collect();
        assert_eq!(
            effects,
            [
                FillEffect::OpenLong,
                FillEffect::CloseLong,
                FillEffect::LongToShort,
                FillEffect::Other
            ]
        );
        assert!(fills[0].taker && !fills[1].taker);
        assert_eq!(
            (fills[1].closed_pnl, fills[1].time),
            (d("10"), 1790880100000)
        );
        // Without a fee currency, the market's settle coin.
        assert_eq!(
            (fills[1].fee_asset.as_str(), fills[2].fee_asset.as_str()),
            ("USDT", "USDC")
        );
    }

    #[test]
    fn maps_closed_positions() {
        let rows: List<WireClosed> = serde_json::from_value(json!({ "list": [
            { "symbol": "BTCUSDT", "side": "Buy", "closedSize": "0.02",
              "avgEntryPrice": "86463.9", "avgExitPrice": "85218.5", "closedPnl": "24.66",
              "cumEntryValue": "1729.278", "leverage": "10", "updatedTime": "1790880000000" }
        ]}))
        .unwrap();
        let [c] = &rows.list.into_iter().filter_map(closed).collect::<Vec<_>>()[..] else {
            panic!()
        };
        // Bought back: a short was closed.
        assert_eq!(
            (c.side, c.size, c.leverage),
            (PositionSide::Short, d("0.02"), Some(d("10")))
        );
        assert_eq!(
            (c.entry_price, c.exit_price, c.closed_pnl),
            (d("86463.9"), d("85218.5"), d("24.66"))
        );
    }

    #[test]
    fn maps_funding_settlements() {
        let rows: List<WireSettlement> = serde_json::from_value(json!({ "list": [
            { "symbol": "BTCUSDT", "side": "Sell", "size": "0.5", "change": "-0.42",
              "feeRate": "0.0001", "transactionTime": "1790870400000", "type": "SETTLEMENT" },
            { "symbol": "", "change": "1" }
        ]}))
        .unwrap();
        let paid: Vec<FundingPayment> = rows.list.into_iter().filter_map(funding).collect();
        assert_eq!(paid.len(), 1);
        assert_eq!(
            (paid[0].amount, paid[0].position_size),
            (d("-0.42"), d("-0.5"))
        );
        assert_eq!((paid[0].rate, paid[0].time), (d("0.0001"), 1790870400000));
    }

    #[test]
    fn realized_pnl_sums_the_settle_coins() {
        let wallet: Wallet = serde_json::from_value(json!({
            "totalEquity": "5000",
            "coin": [
                { "coin": "USDT", "cumRealisedPnl": "-120.5" },
                { "coin": "USDC", "cumRealisedPnl": "20" },
                { "coin": "BTC", "cumRealisedPnl": "0.3" }
            ]
        }))
        .unwrap();
        assert_eq!(wallet.realized_pnl(), Some(d("-100.5")));
        let none: Wallet = serde_json::from_value(json!({ "coin": [{ "coin": "USDT" }] })).unwrap();
        assert_eq!(none.realized_pnl(), None);
    }

    #[test]
    fn an_empty_account_is_zero() {
        let s = snapshot("1", None, vec![], vec![], None, 0);
        assert!(s.equity.0.is_zero() && s.positions.is_empty() && s.open_orders.is_empty());
    }

    #[test]
    fn isolated_margin_reads_available_from_the_settle_coins() {
        // In isolated margin mode the account-wide figure comes back empty.
        let wallet: Wallet = serde_json::from_value(json!({
            "totalEquity": "5000", "totalAvailableBalance": "",
            "coin": [
                { "coin": "USDT", "walletBalance": "3000", "totalPositionIM": "650.5",
                  "totalOrderIM": "49.5", "locked": "0" },
                { "coin": "USDC", "walletBalance": "100", "totalPositionIM": "",
                  "totalOrderIM": "", "locked": "" },
                { "coin": "BTC", "walletBalance": "1", "totalPositionIM": "0",
                  "totalOrderIM": "0", "locked": "0" }
            ]
        }))
        .unwrap();
        assert_eq!(wallet.available(), d("2400"));

        let cross: Wallet = serde_json::from_value(json!({
            "totalEquity": "5000", "totalAvailableBalance": "1201.5", "coin": []
        }))
        .unwrap();
        assert_eq!(cross.available(), d("1201.5"));
    }
}
