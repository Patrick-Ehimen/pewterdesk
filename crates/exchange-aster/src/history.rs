//! An account's history on Aster, from its signed read-only endpoints: fills
//! (`/fapi/v3/userTrades`), the orders it placed (`/fapi/v3/allOrders`), the
//! income it booked - funding, fees, realised P&L - (`/fapi/v3/income`), and
//! its settings on a market (`/fapi/v3/positionRisk`). Read-only, like
//! `account.rs`: nothing here places or changes anything.
//!
//! Aster's trades don't say whether they opened or closed a position, only
//! what they realised: a trade that realised P&L closed some of one, and one
//! that realised nothing is read as opening. Its docs show a trade's fee
//! with a sign that isn't explained, so the fee is taken as its size.

use std::collections::HashSet;

use pewterdesk_core::{
    ClosedTrade, Decimal, Fill, FillEffect, FundingPayment, MarginMode, Order, OrderStatus,
    PositionSide, Side, TradeSettings, VenueId,
};
use rust_decimal::Decimal as RawDecimal;
use serde::Deserialize;

use crate::account::{self, WireOrder, WirePosition};

/// A row of `GET /fapi/v3/userTrades`.
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WireTrade {
    pub symbol: String,
    pub id: u64,
    pub order_id: u64,
    /// "BUY" or "SELL".
    pub side: String,
    pub price: Decimal,
    pub qty: Decimal,
    #[serde(default)]
    pub realized_pnl: Decimal,
    #[serde(default)]
    pub commission: Decimal,
    #[serde(default)]
    pub commission_asset: String,
    #[serde(default)]
    pub maker: bool,
    pub time: u64,
}

/// A row of `GET /fapi/v3/income`.
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WireIncome {
    #[serde(default)]
    pub symbol: String,
    /// "FUNDING_FEE", "COMMISSION", "REALIZED_PNL", "TRANSFER", ...
    pub income_type: String,
    pub income: Decimal,
    pub time: u64,
}

/// A row of `GET /fapi/v3/allOrders`: an order as `openOrders` lists it,
/// with how it ended.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WireHistoricalOrder {
    #[serde(flatten)]
    pub order: WireOrder,
    /// "NEW", "PARTIALLY_FILLED", "FILLED", "CANCELED", "EXPIRED", "REJECTED".
    pub status: String,
}

fn side(side: &str) -> Option<Side> {
    match side {
        "BUY" => Some(Side::Buy),
        "SELL" => Some(Side::Sell),
        _ => None,
    }
}

/// One of the account's fills, or `None` for a side that isn't recognised.
pub fn fill(t: WireTrade) -> Option<Fill> {
    let side = side(&t.side)?;
    let closed = !t.realized_pnl.0.is_zero();
    Some(Fill {
        venue: VenueId::Aster,
        id: t.id.to_string(),
        order_id: t.order_id.to_string(),
        market: t.symbol,
        side,
        effect: match (closed, side) {
            (true, Side::Sell) => FillEffect::CloseLong,
            (true, Side::Buy) => FillEffect::CloseShort,
            (false, Side::Buy) => FillEffect::OpenLong,
            (false, Side::Sell) => FillEffect::OpenShort,
        },
        price: t.price,
        size: t.qty,
        closed_pnl: t.realized_pnl,
        fee: Decimal(t.commission.0.abs()),
        fee_asset: t.commission_asset,
        taker: !t.maker,
        time: t.time,
    })
}

/// The markets the account traded, from its fee records: every trade pays
/// one. At most `limit`, in the order they were last traded.
pub fn traded_markets(incomes: &[WireIncome], limit: usize) -> Vec<String> {
    let mut sorted: Vec<&WireIncome> = incomes
        .iter()
        .filter(|i| !i.symbol.is_empty())
        .filter(|i| matches!(i.income_type.as_str(), "COMMISSION" | "REALIZED_PNL"))
        .collect();
    sorted.sort_by_key(|i| std::cmp::Reverse(i.time));
    let mut seen = HashSet::new();
    sorted
        .into_iter()
        .filter(|i| seen.insert(i.symbol.clone()))
        .map(|i| i.symbol.clone())
        .take(limit)
        .collect()
}

/// A funding payment, or `None` for any other kind of income. Aster's
/// income record doesn't carry the position's size or the rate.
pub fn funding_payment(i: WireIncome) -> Option<FundingPayment> {
    (i.income_type == "FUNDING_FEE" && !i.symbol.is_empty()).then(|| FundingPayment {
        venue: VenueId::Aster,
        market: i.symbol,
        amount: i.income,
        position_size: Decimal::default(),
        rate: Decimal::default(),
        time: i.time,
    })
}

/// An order as it stands or ended, or `None` if it can't be read.
pub fn historical_order(row: WireHistoricalOrder) -> Option<Order> {
    let status = match row.status.as_str() {
        "NEW" | "PARTIALLY_FILLED" => OrderStatus::Open,
        "FILLED" => OrderStatus::Filled,
        "REJECTED" => OrderStatus::Rejected,
        // Cancelled, expired, or anything else that ended it unfilled.
        _ => OrderStatus::Cancelled,
    };
    let mut order = account::order(row.order)?;
    order.status = status;
    Some(order)
}

/// A closing order's trades, summed up.
struct Closing {
    order_id: u64,
    market: String,
    side: PositionSide,
    size: RawDecimal,
    exit_value: RawDecimal,
    gross: RawDecimal,
    fees: RawDecimal,
    time: u64,
}

/// The account's closed positions, built from its trades: each order's
/// trades that realised P&L become one closed trade, at their average exit,
/// with that P&L less their fees. Newest first.
pub fn closed_trades(mut trades: Vec<WireTrade>) -> Vec<ClosedTrade> {
    trades.sort_by_key(|t| (t.time, t.id));
    let mut by_order: Vec<Closing> = Vec::new();
    for t in trades {
        if t.realized_pnl.0.is_zero() || t.qty.0 <= RawDecimal::ZERO {
            continue;
        }
        // A sell closes a long; a buy closes a short.
        let side = match t.side.as_str() {
            "SELL" => PositionSide::Long,
            "BUY" => PositionSide::Short,
            _ => continue,
        };
        let fee = t.commission.0.abs();
        match by_order
            .iter_mut()
            .find(|c| c.order_id == t.order_id && c.market == t.symbol)
        {
            Some(c) => {
                c.size += t.qty.0;
                c.exit_value += t.price.0 * t.qty.0;
                c.gross += t.realized_pnl.0;
                c.fees += fee;
                c.time = t.time;
            }
            None => by_order.push(Closing {
                order_id: t.order_id,
                market: t.symbol,
                side,
                size: t.qty.0,
                exit_value: t.price.0 * t.qty.0,
                gross: t.realized_pnl.0,
                fees: fee,
                time: t.time,
            }),
        }
    }
    let mut out: Vec<ClosedTrade> = by_order
        .into_iter()
        .map(|c| {
            let exit = c.exit_value / c.size;
            // Long: gross = (exit - entry) * size; short: (entry - exit) * size.
            let entry = match c.side {
                PositionSide::Long => exit - c.gross / c.size,
                PositionSide::Short => exit + c.gross / c.size,
            };
            ClosedTrade {
                venue: VenueId::Aster,
                market: c.market,
                side: c.side,
                size: Decimal(c.size.normalize()),
                entry_price: Decimal(entry.round_dp(8).normalize()),
                exit_price: Decimal(exit.round_dp(8).normalize()),
                closed_pnl: Decimal((c.gross - c.fees).round_dp(8).normalize()),
                entry_value: Decimal((entry * c.size).round_dp(8).normalize()),
                leverage: None,
                time: c.time,
                opened_at: None,
            }
        })
        .collect();
    out.sort_by_key(|c| std::cmp::Reverse(c.time));
    out
}

/// The account's leverage and margin mode on a market, from its
/// `positionRisk` row there. Aster sets the margin mode per market.
pub fn trade_settings(row: &WirePosition, max_leverage: u32) -> TradeSettings {
    TradeSettings {
        margin_mode: if row.margin_type.eq_ignore_ascii_case("isolated") {
            MarginMode::Isolated
        } else {
            MarginMode::Cross
        },
        margin_mode_account_wide: false,
        leverage: row
            .leverage
            .filter(|l| l.0 > RawDecimal::ZERO)
            .unwrap_or(Decimal(RawDecimal::ONE)),
        max_leverage: Decimal(RawDecimal::from(max_leverage)),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn d(s: &str) -> Decimal {
        Decimal(s.parse().unwrap())
    }

    /// Rows shaped as Aster's docs give them.
    fn trades() -> Vec<WireTrade> {
        serde_json::from_str(
            r#"[
              {"buyer":true,"commission":"-0.05","commissionAsset":"USDT","id":1,"maker":false,"orderId":10,"price":"100","qty":"2","quoteQty":"200","realizedPnl":"0","side":"BUY","positionSide":"BOTH","symbol":"SOLUSDT","time":1000},
              {"buyer":false,"commission":"-0.03","commissionAsset":"USDT","id":2,"maker":true,"orderId":11,"price":"110","qty":"1.5","quoteQty":"165","realizedPnl":"15","side":"SELL","positionSide":"BOTH","symbol":"SOLUSDT","time":2000},
              {"buyer":false,"commission":"-0.01","commissionAsset":"USDT","id":3,"maker":false,"orderId":11,"price":"112","qty":"0.5","quoteQty":"56","realizedPnl":"6","side":"SELL","positionSide":"BOTH","symbol":"SOLUSDT","time":2001}
            ]"#,
        )
        .unwrap()
    }

    #[test]
    fn reads_fills_and_whether_they_closed() {
        let fills: Vec<Fill> = trades().into_iter().filter_map(fill).collect();
        assert_eq!(fills[0].effect, FillEffect::OpenLong);
        assert_eq!(fills[0].fee, d("0.05"));
        assert!(fills[0].taker);
        assert_eq!(fills[1].effect, FillEffect::CloseLong);
        assert!(!fills[1].taker);
        assert_eq!(fills[1].closed_pnl, d("15"));
    }

    #[test]
    fn one_order_closing_in_two_trades_is_one_closed_trade() {
        let closed = closed_trades(trades());
        assert_eq!(closed.len(), 1);
        let c = &closed[0];
        assert_eq!(c.side, PositionSide::Long);
        assert_eq!(c.size, d("2"));
        assert_eq!(c.exit_price, d("110.5"));
        assert_eq!(c.entry_price, d("100"));
        assert_eq!(c.closed_pnl, d("20.96"));
        assert_eq!(c.time, 2001);
    }

    #[test]
    fn finds_the_markets_traded_newest_first() {
        let incomes: Vec<WireIncome> = serde_json::from_str(
            r#"[
              {"symbol":"","incomeType":"TRANSFER","income":"100","asset":"USDT","info":"","time":1,"tranId":"1","tradeId":""},
              {"symbol":"BTCUSDT","incomeType":"COMMISSION","income":"-0.1","asset":"USDT","info":"","time":2,"tranId":"2","tradeId":"7"},
              {"symbol":"ETHUSDT","incomeType":"FUNDING_FEE","income":"-0.2","asset":"USDT","info":"","time":3,"tranId":"3","tradeId":""},
              {"symbol":"SOLUSDT","incomeType":"REALIZED_PNL","income":"5","asset":"USDT","info":"","time":4,"tranId":"4","tradeId":"8"},
              {"symbol":"BTCUSDT","incomeType":"COMMISSION","income":"-0.1","asset":"USDT","info":"","time":5,"tranId":"5","tradeId":"9"}
            ]"#,
        )
        .unwrap();
        assert_eq!(traded_markets(&incomes, 10), vec!["BTCUSDT", "SOLUSDT"]);
        assert_eq!(traded_markets(&incomes, 1), vec!["BTCUSDT"]);
        let funding: Vec<FundingPayment> =
            incomes.into_iter().filter_map(funding_payment).collect();
        assert_eq!(funding.len(), 1);
        assert_eq!(
            (funding[0].market.as_str(), funding[0].amount),
            ("ETHUSDT", d("-0.2"))
        );
    }

    #[test]
    fn reads_how_an_order_ended() {
        let rows: Vec<WireHistoricalOrder> = serde_json::from_str(
            r#"[
              {"avgPrice":"0","clientOrderId":"abc","cumQuote":"0","executedQty":"0.4","orderId":1,"origQty":"0.40","origType":"LIMIT","price":"9000","reduceOnly":false,"side":"BUY","positionSide":"BOTH","status":"FILLED","stopPrice":"0","closePosition":false,"symbol":"BTCUSDT","time":5,"timeInForce":"GTC","type":"LIMIT","updateTime":6},
              {"executedQty":"0","orderId":2,"origQty":"1","price":"8000","side":"SELL","status":"EXPIRED","stopPrice":"0","symbol":"BTCUSDT","time":7,"type":"LIMIT"}
            ]"#,
        )
        .unwrap();
        let orders: Vec<Order> = rows.into_iter().filter_map(historical_order).collect();
        assert_eq!(orders[0].status, OrderStatus::Filled);
        assert_eq!(orders[0].filled_size, d("0.4"));
        assert_eq!(orders[1].status, OrderStatus::Cancelled);
    }
}
