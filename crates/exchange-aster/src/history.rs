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

use std::collections::{HashMap, HashSet};

use pewterdesk_core::{
    ClosedTrade, Decimal, Fill, FillEffect, FundingPayment, MarginMode, Order, OrderStatus,
    PositionSide, Side, TradeSettings, VenueId,
};
use rust_decimal::{prelude::ToPrimitive, Decimal as RawDecimal};
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
    opened_at: Option<u64>,
}

/// A market's position as the trades build it (one-way mode): its signed
/// size (long above zero), and its size times opening time, for the
/// size-weighted average of when it was opened.
#[derive(Default)]
struct Held {
    size: RawDecimal,
    timed: RawDecimal,
}

impl Held {
    /// When what's held was opened, on average; none with nothing held.
    fn opened_at(&self) -> Option<u64> {
        (!self.size.is_zero())
            .then(|| (self.timed / self.size.abs()).round())
            .and_then(|t| t.to_u64())
    }

    /// `qty` taken off what's held, its opening time kept for the rest.
    fn reduce(&mut self, qty: RawDecimal) {
        let held = self.size.abs();
        let left = held - qty.min(held);
        self.timed = if held.is_zero() {
            RawDecimal::ZERO
        } else {
            self.timed / held * left
        };
        self.size = if self.size.is_sign_negative() {
            -left
        } else {
            left
        };
    }

    /// `qty` more held on the side of `signed` (+1 long, -1 short), opened at `time`.
    fn add(&mut self, signed: RawDecimal, qty: RawDecimal, time: u64) {
        self.size += signed * qty;
        self.timed += RawDecimal::from(time) * qty;
    }
}

/// The account's closed positions, built from its trades: each order's
/// trades that realised P&L become one closed trade, at their average exit,
/// with that P&L less their fees, and the size-weighted time the closed
/// part had been opened, where the trades reach back to its opening (none
/// where they don't: it isn't guessed). Newest first.
pub fn closed_trades(mut trades: Vec<WireTrade>) -> Vec<ClosedTrade> {
    trades.sort_by_key(|t| (t.time, t.id));
    let mut by_order: Vec<Closing> = Vec::new();
    // Per market: what the trades seen so far have left open.
    let mut held: HashMap<String, Held> = HashMap::new();
    for t in trades {
        if t.qty.0 <= RawDecimal::ZERO {
            continue;
        }
        let signed = match t.side.as_str() {
            "BUY" => RawDecimal::ONE,
            "SELL" => -RawDecimal::ONE,
            _ => continue,
        };
        let position = held.entry(t.symbol.clone()).or_default();
        let against = !position.size.is_zero()
            && position.size.is_sign_negative() != signed.is_sign_negative();
        if t.realized_pnl.0.is_zero() {
            // Opening (or a close at exactly break-even): follow the position.
            if against {
                let closing = t.qty.0.min(position.size.abs());
                position.reduce(closing);
                if t.qty.0 > closing {
                    position.add(signed, t.qty.0 - closing, t.time);
                }
            } else {
                position.add(signed, t.qty.0, t.time);
            }
            continue;
        }
        // A closing trade. Opened when the position it closes was, if the
        // trades show it; anything past it opens the other way.
        let (opened_at, closing) = if against {
            let opened = position.opened_at();
            let closing = t.qty.0.min(position.size.abs());
            position.reduce(closing);
            if t.qty.0 > closing {
                position.add(signed, t.qty.0 - closing, t.time);
            }
            (opened, closing)
        } else {
            // Its opening is older than the trades: nothing to follow, and
            // all of it taken as closing, as before.
            *position = Held::default();
            (None, t.qty.0)
        };
        // A sell closes a long; a buy closes a short.
        let side = if signed.is_sign_negative() {
            PositionSide::Long
        } else {
            PositionSide::Short
        };
        // Only the closing part's share of the fee: the rest opened a position.
        let fee = t.commission.0.abs() * closing / t.qty.0;
        match by_order
            .iter_mut()
            .find(|c| c.order_id == t.order_id && c.market == t.symbol)
        {
            Some(c) => {
                c.size += closing;
                c.exit_value += t.price.0 * closing;
                c.gross += t.realized_pnl.0;
                c.fees += fee;
                c.time = t.time;
            }
            None => by_order.push(Closing {
                order_id: t.order_id,
                market: t.symbol,
                side,
                size: closing,
                exit_value: t.price.0 * closing,
                gross: t.realized_pnl.0,
                fees: fee,
                time: t.time,
                opened_at,
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
                opened_at: c.opened_at,
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
        // Opened by the first trade, at 1000.
        assert_eq!(c.opened_at, Some(1000));
    }

    fn trade(id: u64, order: u64, side: &str, qty: &str, pnl: &str, time: u64) -> WireTrade {
        serde_json::from_value(serde_json::json!({
            "symbol": "SOLUSDT", "id": id, "orderId": order, "side": side,
            "price": "100", "qty": qty, "realizedPnl": pnl, "time": time,
        }))
        .unwrap()
    }

    #[test]
    fn a_close_is_opened_when_its_position_was_on_average() {
        let closed = closed_trades(vec![
            trade(1, 1, "BUY", "1", "0", 1000),
            trade(2, 2, "BUY", "3", "0", 2000),
            // Closes all 4: opened at (1000 * 1 + 2000 * 3) / 4.
            trade(3, 3, "SELL", "4", "8", 5000),
        ]);
        assert_eq!(closed[0].opened_at, Some(1750));
    }

    #[test]
    fn a_flip_opens_the_rest_at_its_own_time() {
        let closed = closed_trades(vec![
            trade(1, 1, "BUY", "1", "0", 1000),
            // Closes the long and opens 2 short.
            trade(2, 2, "SELL", "3", "5", 2000),
            trade(3, 3, "BUY", "2", "-4", 4000),
        ]);
        let short = closed
            .iter()
            .find(|c| c.side == PositionSide::Short)
            .unwrap();
        let long = closed
            .iter()
            .find(|c| c.side == PositionSide::Long)
            .unwrap();
        // Only the 1 long it held closed; the other 2 opened the short.
        assert_eq!(long.size, d("1"));
        assert_eq!(short.size, d("2"));
        assert_eq!(long.opened_at, Some(1000));
        assert_eq!(short.opened_at, Some(2000));
    }

    #[test]
    fn a_close_whose_opening_is_older_than_the_trades_has_no_opening() {
        let closed = closed_trades(vec![trade(1, 1, "SELL", "2", "3", 5000)]);
        assert_eq!(closed[0].opened_at, None);
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
