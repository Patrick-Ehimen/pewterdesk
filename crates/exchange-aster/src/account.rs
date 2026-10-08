//! An account's state, from Aster's signed endpoints: its margin summary
//! (`/fapi/v3/account`), positions (`/fapi/v3/positionRisk`) and open orders
//! (`/fapi/v3/openOrders`), as the domain's `AccountSnapshot`. Read-only.

use pewterdesk_core::{
    AccountSnapshot, Decimal, MarginMode, Order, OrderCategory, OrderStatus, OrderType, Position,
    PositionSide, Side, VenueId,
};
use rust_decimal::Decimal as RawDecimal;
use serde::Deserialize;

/// `GET /fapi/v3/account`, as far as it's read.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WireAccount {
    /// Wallet balance plus unrealized PnL.
    pub total_margin_balance: Decimal,
    pub available_balance: Decimal,
}

/// A row of `GET /fapi/v3/positionRisk`.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WirePosition {
    pub symbol: String,
    pub position_amt: Decimal,
    pub entry_price: Decimal,
    pub mark_price: Decimal,
    #[serde(default)]
    pub liquidation_price: Option<Decimal>,
    #[serde(rename = "unRealizedProfit")]
    pub unrealized_profit: Decimal,
    #[serde(default)]
    pub leverage: Option<Decimal>,
    /// "isolated" or "cross".
    #[serde(default)]
    pub margin_type: String,
    #[serde(default)]
    pub isolated_margin: Option<Decimal>,
    #[serde(default)]
    pub notional: Option<Decimal>,
    /// "BOTH" in one-way mode; "LONG" or "SHORT" in hedge mode.
    #[serde(default)]
    pub position_side: String,
}

/// A row of `GET /fapi/v3/openOrders`.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WireOrder {
    pub order_id: u64,
    #[serde(default)]
    pub client_order_id: Option<String>,
    pub symbol: String,
    pub side: String,
    #[serde(rename = "type")]
    pub order_type: String,
    pub orig_qty: Decimal,
    #[serde(default)]
    pub executed_qty: Decimal,
    #[serde(default)]
    pub price: Decimal,
    #[serde(default)]
    pub stop_price: Decimal,
    #[serde(default)]
    pub reduce_only: bool,
    #[serde(default)]
    pub close_position: bool,
    #[serde(default)]
    pub time: u64,
}

fn positive(value: Decimal) -> Option<Decimal> {
    (value.0 > RawDecimal::ZERO).then_some(value)
}

/// An open position, or `None` for a market the account holds nothing in
/// (Aster lists every market, most of them at zero).
pub fn position(row: WirePosition) -> Option<Position> {
    let amount = row.position_amt.0;
    if amount.is_zero() {
        return None;
    }
    // Hedge mode says the side outright; one-way mode by the amount's sign.
    let side = match row.position_side.as_str() {
        "LONG" => PositionSide::Long,
        "SHORT" => PositionSide::Short,
        _ if amount > RawDecimal::ZERO => PositionSide::Long,
        _ => PositionSide::Short,
    };
    let isolated = row.margin_type.eq_ignore_ascii_case("isolated");
    let leverage = row.leverage.and_then(positive);
    // Isolated: its own wallet. Cross: what the position's value ties up at
    // its leverage.
    let margin = match (isolated, row.isolated_margin, row.notional, leverage) {
        (true, Some(margin), _, _) => margin,
        (_, _, Some(notional), Some(leverage)) => Decimal(notional.0.abs() / leverage.0),
        _ => Decimal::default(),
    };
    Some(Position {
        venue: VenueId::Aster,
        market: row.symbol,
        side,
        size: Decimal(amount.abs()),
        entry_price: row.entry_price,
        mark_price: row.mark_price,
        liquidation_price: row.liquidation_price.and_then(positive),
        unrealized_pnl: row.unrealized_profit,
        margin,
        realized_pnl: None,
        take_profit: None,
        stop_loss: None,
        trailing_stop: None,
        leverage,
        margin_mode: Some(if isolated {
            MarginMode::Isolated
        } else {
            MarginMode::Cross
        }),
    })
}

/// An open order, or `None` for a side or type that isn't recognised.
pub fn order(row: WireOrder) -> Option<Order> {
    let side = match row.side.as_str() {
        "BUY" => Side::Buy,
        "SELL" => Side::Sell,
        _ => return None,
    };
    let kind = row.order_type.as_str();
    let (order_type, category) = match kind {
        "LIMIT" => (OrderType::Limit, OrderCategory::Regular),
        "MARKET" => (OrderType::Market, OrderCategory::Regular),
        "TRAILING_STOP_MARKET" => (OrderType::Trigger, OrderCategory::TrailingStop),
        // One that closes the whole position is that position's exit.
        "TAKE_PROFIT" | "TAKE_PROFIT_MARKET" if row.close_position => {
            (OrderType::Trigger, OrderCategory::TakeProfit)
        }
        "STOP" | "STOP_MARKET" if row.close_position => {
            (OrderType::Trigger, OrderCategory::StopLoss)
        }
        "STOP" | "STOP_MARKET" | "TAKE_PROFIT" | "TAKE_PROFIT_MARKET" => {
            (OrderType::Trigger, OrderCategory::Conditional)
        }
        _ => return None,
    };
    Some(Order {
        venue: VenueId::Aster,
        id: row.order_id.to_string(),
        client_id: row.client_order_id.filter(|id| !id.is_empty()),
        market: row.symbol,
        side,
        order_type,
        size: row.orig_qty,
        filled_size: row.executed_qty,
        price: positive(row.price),
        trigger_price: positive(row.stop_price),
        reduce_only: row.reduce_only || row.close_position,
        // Only resting orders are listed.
        status: OrderStatus::Open,
        created_at: row.time,
        category,
        trigger_by: None,
        take_profit: None,
        stop_loss: None,
    })
}

pub fn snapshot(
    address: &str,
    account: WireAccount,
    positions: Vec<WirePosition>,
    orders: Vec<WireOrder>,
    time: u64,
) -> AccountSnapshot {
    AccountSnapshot {
        venue: VenueId::Aster,
        address: address.to_owned(),
        equity: account.total_margin_balance,
        available_margin: account.available_balance,
        realized_pnl: None,
        positions: positions.into_iter().filter_map(position).collect(),
        open_orders: orders.into_iter().filter_map(order).collect(),
        time,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn dec(s: &str) -> Decimal {
        Decimal(s.parse().unwrap())
    }

    /// Rows shaped as Aster's docs give them.
    #[test]
    fn reads_an_account_as_the_docs_shape_it() {
        let account: WireAccount = serde_json::from_str(
            r#"{"feeTier":0,"canTrade":true,"totalWalletBalance":"23.72469206","totalUnrealizedProfit":"1.5","totalMarginBalance":"25.22469206","availableBalance":"20.1","assets":[],"positions":[]}"#,
        )
        .unwrap();
        let positions: Vec<WirePosition> = serde_json::from_str(
            r#"[
              {"entryPrice":"6563.66500","marginType":"isolated","isAutoAddMargin":"false","isolatedMargin":"15517.54150468","leverage":"10","liquidationPrice":"5930.78","markPrice":"6679.50671178","maxNotionalValue":"20000000","positionAmt":"20.000","symbol":"BTCUSDT","unRealizedProfit":"2316.83423560","positionSide":"BOTH","notional":"133590.13423560","isolatedWallet":"15517.54150468","updateTime":1625474304765},
              {"entryPrice":"2500","marginType":"cross","isolatedMargin":"0","leverage":"5","liquidationPrice":"0","markPrice":"2400","positionAmt":"-2","symbol":"ETHUSDT","unRealizedProfit":"200","positionSide":"BOTH","notional":"-4800","updateTime":0},
              {"entryPrice":"0.0","marginType":"cross","leverage":"20","liquidationPrice":"0","markPrice":"100","positionAmt":"0","symbol":"SOLUSDT","unRealizedProfit":"0","positionSide":"BOTH","notional":"0","updateTime":0}
            ]"#,
        )
        .unwrap();
        let orders: Vec<WireOrder> = serde_json::from_str(
            r#"[
              {"avgPrice":"0.00000","clientOrderId":"abc","cumQuote":"0","executedQty":"0","orderId":1917641,"origQty":"0.40","origType":"LIMIT","price":"9000","reduceOnly":false,"side":"BUY","positionSide":"BOTH","status":"NEW","stopPrice":"0","closePosition":false,"symbol":"BTCUSDT","time":1579276756075,"timeInForce":"GTC","type":"LIMIT","updateTime":1579276756075,"workingType":"CONTRACT_PRICE","priceProtect":false},
              {"clientOrderId":"","executedQty":"0","orderId":7,"origQty":"0","price":"0","reduceOnly":true,"side":"SELL","status":"NEW","stopPrice":"6000","closePosition":true,"symbol":"BTCUSDT","time":5,"type":"STOP_MARKET"},
              {"executedQty":"0","orderId":8,"origQty":"1","price":"0","side":"SIDEWAYS","stopPrice":"0","symbol":"BTCUSDT","time":5,"type":"LIMIT"}
            ]"#,
        )
        .unwrap();
        let snap = snapshot("0xabc", account, positions, orders, 99);
        assert_eq!(snap.equity, dec("25.22469206"));
        assert_eq!(snap.available_margin, dec("20.1"));
        // The empty market is left out.
        assert_eq!(snap.positions.len(), 2);
        let long = &snap.positions[0];
        assert_eq!((long.side, long.size), (PositionSide::Long, dec("20.000")));
        assert_eq!(long.liquidation_price, Some(dec("5930.78")));
        assert_eq!(long.margin, dec("15517.54150468"));
        assert_eq!(long.margin_mode, Some(MarginMode::Isolated));
        let short = &snap.positions[1];
        assert_eq!((short.side, short.size), (PositionSide::Short, dec("2")));
        // No liquidation price given; cross margin is the value over the leverage.
        assert_eq!(short.liquidation_price, None);
        assert_eq!(short.margin, dec("960"));
        assert_eq!(short.margin_mode, Some(MarginMode::Cross));
        // The unreadable order is dropped, not the lot.
        assert_eq!(snap.open_orders.len(), 2);
        let limit = &snap.open_orders[0];
        assert_eq!(limit.id, "1917641");
        assert_eq!(limit.client_id.as_deref(), Some("abc"));
        assert_eq!(
            (limit.order_type, limit.price),
            (OrderType::Limit, Some(dec("9000")))
        );
        assert_eq!(limit.trigger_price, None);
        let stop = &snap.open_orders[1];
        assert_eq!(stop.category, OrderCategory::StopLoss);
        assert_eq!(stop.trigger_price, Some(dec("6000")));
        assert!(stop.reduce_only && stop.client_id.is_none());
    }
}
