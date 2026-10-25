//! An account's state, from Binance's signed endpoints: its margin summary
//! (`/fapi/v3/account`), positions (`/fapi/v3/positionRisk`), open orders
//! (`/fapi/v1/openOrders`) and open conditional orders, which since the
//! 2025-12 migration live in the Algo Service (`/fapi/v1/openAlgoOrders`).
//! As the domain's `AccountSnapshot`. Read-only.
//!
//! A conditional order's id is its `algoId` with `algo:` in front, so it
//! can't be mistaken for an ordinary order's: the two are numbered apart,
//! and cancelled at different endpoints.

use pewterdesk_core::{
    AccountSnapshot, Decimal, MarginMode, Order, OrderCategory, OrderStatus, OrderType, Position,
    PositionSide, PriceSource, Side, VenueId,
};
use rust_decimal::Decimal as RawDecimal;
use serde::Deserialize;

/// What a conditional order's id starts with.
pub const ALGO_PREFIX: &str = "algo:";

/// The stablecoins a single-asset account's margin is counted in: each
/// market settles in its own (USDT, USDC, ...), and Binance's top-level
/// totals count only USDT then.
const SETTLE_ASSETS: &[&str] = &["USDT", "USDC", "USD1", "U", "BNFCR"];

/// `GET /fapi/v3/account`, as far as it's read.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WireAccount {
    /// Wallet balance plus unrealized PnL: USDT only in single-asset mode,
    /// USD in multi-assets mode.
    pub total_margin_balance: Decimal,
    pub available_balance: Decimal,
    #[serde(default)]
    pub assets: Vec<WireAsset>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WireAsset {
    pub asset: String,
    pub margin_balance: Decimal,
    pub available_balance: Decimal,
}

/// `GET /fapi/v1/accountConfig`, as far as it's read.
#[derive(Clone, Copy, Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AccountConfig {
    /// Every asset backs every position, valued in USD.
    #[serde(default)]
    pub multi_assets_margin: bool,
    /// Hedge Mode: separate long and short positions per market.
    #[serde(default)]
    pub dual_side_position: bool,
}

/// A row of `GET /fapi/v3/positionRisk`. The v3 rows carry no leverage or
/// margin type (those moved to `symbolConfig`); both are worked out from
/// the margin the position holds.
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
    pub notional: Option<Decimal>,
    /// The margin posted to an isolated position; zero for a cross one.
    #[serde(default)]
    pub isolated_wallet: Option<Decimal>,
    /// The margin the position itself ties up.
    #[serde(default)]
    pub position_initial_margin: Option<Decimal>,
    #[serde(default)]
    pub initial_margin: Option<Decimal>,
    /// "BOTH" in one-way mode; "LONG" or "SHORT" in hedge mode.
    #[serde(default)]
    pub position_side: String,
}

/// A row of `GET /fapi/v1/symbolConfig`: the account's settings on a market.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SymbolConfig {
    pub symbol: String,
    /// "CROSSED" or "ISOLATED".
    #[serde(default)]
    pub margin_type: String,
    #[serde(deserialize_with = "whole")]
    pub leverage: u32,
}

/// A row of `GET /fapi/v2/positionRisk?symbol=`, as far as it's read: the
/// older list, which still carries each position's leverage - asked only
/// where `symbolConfig` gave none.
#[derive(Deserialize)]
pub struct WireLeverage {
    pub symbol: String,
    #[serde(deserialize_with = "whole")]
    pub leverage: u32,
}

/// A whole number Binance sends as a number on one host and a string on
/// another (`20` or `"20"`).
fn whole<'de, D: serde::Deserializer<'de>>(d: D) -> Result<u32, D::Error> {
    #[derive(Deserialize)]
    #[serde(untagged)]
    enum Either {
        Number(u32),
        Text(String),
    }
    match Either::deserialize(d)? {
        Either::Number(n) => Ok(n),
        Either::Text(t) => t.trim().parse().map_err(serde::de::Error::custom),
    }
}

/// A row of `GET /fapi/v1/openOrders`.
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
    pub working_type: String,
    #[serde(default)]
    pub time: u64,
}

/// An open conditional order, from `GET /fapi/v1/openAlgoOrders`.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WireAlgoOrder {
    pub algo_id: u64,
    #[serde(default)]
    pub client_algo_id: Option<String>,
    pub symbol: String,
    pub side: String,
    /// `STOP_MARKET`, `TAKE_PROFIT_MARKET`, `STOP`, `TAKE_PROFIT`,
    /// `TRAILING_STOP_MARKET`.
    pub order_type: String,
    #[serde(default, deserialize_with = "loose")]
    pub quantity: Option<Decimal>,
    #[serde(default, deserialize_with = "loose")]
    pub trigger_price: Option<Decimal>,
    #[serde(default, deserialize_with = "loose")]
    pub price: Option<Decimal>,
    #[serde(default)]
    pub close_position: bool,
    #[serde(default)]
    pub reduce_only: bool,
    #[serde(default)]
    pub working_type: String,
    #[serde(default)]
    pub create_time: u64,
}

/// `openAlgoOrders` answers with the list itself, or the list under
/// `orders`; either is read.
#[derive(Deserialize)]
#[serde(untagged)]
pub enum AlgoOrders {
    List(Vec<WireAlgoOrder>),
    Wrapped { orders: Vec<WireAlgoOrder> },
}

impl AlgoOrders {
    pub fn into_vec(self) -> Vec<WireAlgoOrder> {
        match self {
            Self::List(list) | Self::Wrapped { orders: list } => list,
        }
    }
}

/// An algo order's price or quantity: a decimal string, where an unset one
/// comes as `""`, `"null"` or `null` - read as absent, not as a bad reply.
fn loose<'de, D: serde::Deserializer<'de>>(d: D) -> Result<Option<Decimal>, D::Error> {
    let raw: Option<String> = Option::deserialize(d)?;
    match raw.as_deref().map(str::trim) {
        None | Some("") | Some("null") => Ok(None),
        Some(text) => text
            .parse::<RawDecimal>()
            .map(|v| Some(Decimal(v)))
            .map_err(serde::de::Error::custom),
    }
}

pub(crate) fn positive(value: Decimal) -> Option<Decimal> {
    (value.0 > RawDecimal::ZERO).then_some(value)
}

/// Java's largest long over 10^8: what Binance sends for an amount it has no
/// figure for. Demo Trading has been seen to send it as a cross position's
/// initial margin. Anything this large is read as absent, never as money.
const NO_FIGURE: RawDecimal = RawDecimal::from_parts(4_294_967_295, 2_147_483_647, 0, false, 8);

/// A margin figure that's really one: above zero and short of `NO_FIGURE`.
fn real(value: Decimal) -> Option<Decimal> {
    positive(value).filter(|v| v.0 < NO_FIGURE)
}

/// Whether `row` is an open cross position Binance gave no usable initial
/// margin for: its leverage (`symbolConfig`) is needed to work it out.
pub fn needs_leverage(row: &WirePosition) -> bool {
    !row.position_amt.0.is_zero()
        && row.isolated_wallet.and_then(real).is_none()
        && row
            .position_initial_margin
            .or(row.initial_margin)
            .and_then(real)
            .is_none()
}

fn side(side: &str) -> Option<Side> {
    match side {
        "BUY" => Some(Side::Buy),
        "SELL" => Some(Side::Sell),
        _ => None,
    }
}

fn trigger_by(working_type: &str) -> Option<PriceSource> {
    match working_type {
        "MARK_PRICE" => Some(PriceSource::Mark),
        "CONTRACT_PRICE" => Some(PriceSource::Last),
        _ => None,
    }
}

/// An open position, or `None` for a market the account holds nothing in.
/// `leverage` is the account's on the market, where it was read
/// (`needs_leverage`); otherwise it's worked out from the margin.
pub fn position(row: WirePosition, leverage: Option<u32>) -> Option<Position> {
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
    let isolated_wallet = row.isolated_wallet.and_then(real);
    let given = leverage
        .filter(|&l| l > 0)
        .map(|l| Decimal(RawDecimal::from(l)));
    // Its value: Binance's own figure, or the size at the mark without one.
    let value = row
        .notional
        .and_then(|n| positive(Decimal(n.0.abs())))
        .map(|n| n.0)
        .or_else(|| positive(Decimal(amount.abs() * row.mark_price.0)).map(|v| v.0));
    let initial = row
        .position_initial_margin
        .or(row.initial_margin)
        .and_then(real)
        // Without a figure from Binance: the value over the leverage.
        .or_else(|| match (value, given) {
            (Some(value), Some(l)) => positive(Decimal((value / l.0).round_dp(8))),
            _ => None,
        });
    // Isolated: what was posted to it. Cross: what its value ties up.
    let margin = isolated_wallet.or(initial).unwrap_or_default();
    // Binance's leverage is a whole number: the value over the margin it
    // ties up at that leverage.
    let leverage = given.or_else(|| match (value, initial) {
        (Some(value), Some(initial)) => positive(Decimal((value / initial.0).round())),
        _ => None,
    });
    Some(Position {
        venue: VenueId::Binance,
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
        margin_mode: Some(if isolated_wallet.is_some() {
            MarginMode::Isolated
        } else {
            MarginMode::Cross
        }),
    })
}

/// An open ordinary order, or `None` for a side or type that isn't
/// recognised.
pub fn order(row: WireOrder) -> Option<Order> {
    let side = side(&row.side)?;
    let kind = row.order_type.as_str();
    let (order_type, category) = match kind {
        "LIMIT" => (OrderType::Limit, OrderCategory::Regular),
        "MARKET" => (OrderType::Market, OrderCategory::Regular),
        // A triggered conditional order lands here as its child.
        "TRAILING_STOP_MARKET" => (OrderType::Trigger, OrderCategory::TrailingStop),
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
    let trigger = order_type == OrderType::Trigger;
    Some(Order {
        venue: VenueId::Binance,
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
        trigger_by: if trigger {
            trigger_by(&row.working_type)
        } else {
            None
        },
        take_profit: None,
        stop_loss: None,
    })
}

/// An open conditional order, or `None` for a side or type that isn't
/// recognised. One that closes the whole position is that position's exit.
pub fn algo_order(row: WireAlgoOrder) -> Option<Order> {
    let side = side(&row.side)?;
    let category = match row.order_type.as_str() {
        "TRAILING_STOP_MARKET" => OrderCategory::TrailingStop,
        "TAKE_PROFIT" | "TAKE_PROFIT_MARKET" if row.close_position => OrderCategory::TakeProfit,
        "STOP" | "STOP_MARKET" if row.close_position => OrderCategory::StopLoss,
        "STOP" | "STOP_MARKET" | "TAKE_PROFIT" | "TAKE_PROFIT_MARKET" => OrderCategory::Conditional,
        _ => return None,
    };
    Some(Order {
        venue: VenueId::Binance,
        id: format!("{ALGO_PREFIX}{}", row.algo_id),
        client_id: row.client_algo_id.filter(|id| !id.is_empty()),
        market: row.symbol,
        side,
        order_type: OrderType::Trigger,
        size: row.quantity.unwrap_or_default(),
        filled_size: Decimal::default(),
        price: row.price.and_then(positive),
        trigger_price: row.trigger_price.and_then(positive),
        reduce_only: row.reduce_only || row.close_position,
        status: OrderStatus::Open,
        created_at: row.create_time,
        category,
        trigger_by: trigger_by(&row.working_type),
        take_profit: None,
        stop_loss: None,
    })
}

/// Equity and free margin: Binance's own totals in multi-assets mode (every
/// asset counted, in USD); in single-asset mode those count USDT alone, so
/// the settle assets' own balances are added up instead.
fn totals(account: &WireAccount, config: AccountConfig) -> (Decimal, Decimal) {
    if config.multi_assets_margin || account.assets.is_empty() {
        return (account.total_margin_balance, account.available_balance);
    }
    let (equity, available) = account
        .assets
        .iter()
        .filter(|a| SETTLE_ASSETS.contains(&a.asset.as_str()))
        .fold((RawDecimal::ZERO, RawDecimal::ZERO), |(e, f), a| {
            (e + a.margin_balance.0, f + a.available_balance.0)
        });
    (Decimal(equity), Decimal(available))
}

pub fn snapshot(
    address: &str,
    account: WireAccount,
    config: AccountConfig,
    positions: Vec<(WirePosition, Option<u32>)>,
    orders: Vec<WireOrder>,
    algo_orders: Vec<WireAlgoOrder>,
    time: u64,
) -> AccountSnapshot {
    let (equity, available_margin) = totals(&account, config);
    let mut open_orders: Vec<Order> = orders.into_iter().filter_map(order).collect();
    open_orders.extend(algo_orders.into_iter().filter_map(algo_order));
    AccountSnapshot {
        venue: VenueId::Binance,
        address: address.to_owned(),
        equity,
        available_margin,
        realized_pnl: None,
        positions: positions
            .into_iter()
            .filter_map(|(row, leverage)| position(row, leverage))
            .collect(),
        open_orders,
        time,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn dec(s: &str) -> Decimal {
        Decimal(s.parse().unwrap())
    }

    fn account() -> WireAccount {
        serde_json::from_str(
            r#"{"totalInitialMargin":"0.0","totalMaintMargin":"0.0","totalWalletBalance":"103.12","totalUnrealizedProfit":"0.88","totalMarginBalance":"104.00","totalPositionInitialMargin":"0.0","totalOpenOrderInitialMargin":"0.0","totalCrossWalletBalance":"103.12","totalCrossUnPnl":"0.0","availableBalance":"100.00","maxWithdrawAmount":"100.00",
               "assets":[
                 {"asset":"USDT","walletBalance":"103.12","unrealizedProfit":"0.88","marginBalance":"104.00","maintMargin":"0","initialMargin":"0","positionInitialMargin":"0","openOrderInitialMargin":"0","crossWalletBalance":"103.12","crossUnPnl":"0","availableBalance":"100.00","maxWithdrawAmount":"100.00","updateTime":1},
                 {"asset":"USDC","walletBalance":"50","unrealizedProfit":"0","marginBalance":"50.00","maintMargin":"0","initialMargin":"0","positionInitialMargin":"0","openOrderInitialMargin":"0","crossWalletBalance":"50","crossUnPnl":"0","availableBalance":"45.00","maxWithdrawAmount":"45","updateTime":1},
                 {"asset":"BNB","walletBalance":"1","unrealizedProfit":"0","marginBalance":"1","maintMargin":"0","initialMargin":"0","positionInitialMargin":"0","openOrderInitialMargin":"0","crossWalletBalance":"1","crossUnPnl":"0","availableBalance":"1","maxWithdrawAmount":"1","updateTime":1}
               ],
               "positions":[]}"#,
        )
        .unwrap()
    }

    #[test]
    fn single_asset_equity_adds_up_the_settle_coins() {
        let single = AccountConfig::default();
        let snap = snapshot("1", account(), single, vec![], vec![], vec![], 9);
        // USDT and USDC; BNB isn't a settle asset.
        assert_eq!(snap.equity, dec("154.00"));
        assert_eq!(snap.available_margin, dec("145.00"));
        let multi = AccountConfig {
            multi_assets_margin: true,
            dual_side_position: false,
        };
        let snap = snapshot("1", account(), multi, vec![], vec![], vec![], 9);
        assert_eq!(snap.equity, dec("104.00"));
        assert_eq!(snap.venue, VenueId::Binance);
    }

    #[test]
    fn reads_positions_with_their_mode_and_leverage() {
        let rows: Vec<WirePosition> = serde_json::from_str(
            r#"[
              {"symbol":"BTCUSDT","positionSide":"BOTH","positionAmt":"0.010","entryPrice":"80000.0","breakEvenPrice":"80032.0","markPrice":"80100.00","unRealizedProfit":"1.00","liquidationPrice":"72000.5","isolatedMargin":"81.10","notional":"801.00","marginAsset":"USDT","isolatedWallet":"80.10","initialMargin":"80.10","maintMargin":"3.2","positionInitialMargin":"80.10","openOrderInitialMargin":"0","adl":2,"bidNotional":"0","askNotional":"0","updateTime":1},
              {"symbol":"ETHUSDT","positionSide":"BOTH","positionAmt":"-2","entryPrice":"2500","markPrice":"2400","unRealizedProfit":"200","liquidationPrice":"0","isolatedMargin":"0","notional":"-4800","isolatedWallet":"0","initialMargin":"240","positionInitialMargin":"240","openOrderInitialMargin":"0","updateTime":1},
              {"symbol":"SOLUSDT","positionSide":"BOTH","positionAmt":"0","entryPrice":"0","markPrice":"100","unRealizedProfit":"0","liquidationPrice":"0","notional":"0","isolatedWallet":"0","positionInitialMargin":"0","updateTime":1}
            ]"#,
        )
        .unwrap();
        let positions: Vec<Position> = rows.into_iter().filter_map(|r| position(r, None)).collect();
        assert_eq!(positions.len(), 2);
        let long = &positions[0];
        assert_eq!((long.side, long.size), (PositionSide::Long, dec("0.010")));
        assert_eq!(long.margin_mode, Some(MarginMode::Isolated));
        assert_eq!(long.margin, dec("80.10"));
        assert_eq!(long.leverage, Some(dec("10")));
        assert_eq!(long.liquidation_price, Some(dec("72000.5")));
        let short = &positions[1];
        assert_eq!((short.side, short.size), (PositionSide::Short, dec("2")));
        assert_eq!(short.margin_mode, Some(MarginMode::Cross));
        assert_eq!(short.margin, dec("240"));
        assert_eq!(short.leverage, Some(dec("20")));
        assert_eq!(short.liquidation_price, None);
    }

    #[test]
    fn leverage_reads_as_a_number_or_a_string() {
        for raw in [
            r#"[{"symbol":"BTCUSDT","marginType":"CROSSED","isAutoAddMargin":"false","leverage":20,"maxNotionalValue":"1000000"}]"#,
            r#"[{"symbol":"BTCUSDT","marginType":"CROSSED","leverage":"20"}]"#,
            r#"[{"symbol":"BTCUSDT","leverage":"20"}]"#,
        ] {
            let rows: Vec<SymbolConfig> = serde_json::from_str(raw).unwrap();
            assert_eq!(rows[0].leverage, 20, "{raw}");
        }
        let v2: Vec<WireLeverage> = serde_json::from_str(
            r#"[{"symbol":"BTCUSDT","positionAmt":"0.002","leverage":"10","marginType":"cross","notional":"99.88"}]"#,
        )
        .unwrap();
        assert_eq!(v2[0].leverage, 10);
    }

    #[test]
    fn a_position_without_a_notional_is_valued_at_the_mark() {
        let row: WirePosition = serde_json::from_str(
            r#"{"symbol":"BTCUSDT","positionSide":"BOTH","positionAmt":"-0.002","entryPrice":"50000","markPrice":"50000","unRealizedProfit":"0","initialMargin":"92233720368.54775807"}"#,
        )
        .unwrap();
        let p = position(row, Some(10)).unwrap();
        assert_eq!(p.margin, dec("10"));
        assert_eq!(p.leverage, Some(dec("10")));
    }

    /// As Demo Trading answered for a small cross BTC long: no initial
    /// margin, only Java's largest long where it would be.
    #[test]
    fn a_placeholder_margin_is_worked_out_from_the_leverage() {
        let row = || -> WirePosition {
            serde_json::from_str(
                r#"{"symbol":"BTCUSDT","positionSide":"BOTH","positionAmt":"0.002","entryPrice":"50000","markPrice":"49940","unRealizedProfit":"-0.12","liquidationPrice":"0","isolatedMargin":"0","notional":"99.88","isolatedWallet":"0","initialMargin":"92233720368.54775807","positionInitialMargin":"92233720368.54775807","openOrderInitialMargin":"0","maintMargin":"0.39952","updateTime":1}"#,
            )
            .unwrap()
        };
        assert_eq!(NO_FIGURE.to_string(), "92233720368.54775807");
        assert!(needs_leverage(&row()));
        let with = position(row(), Some(20)).unwrap();
        assert_eq!(with.margin, dec("4.994"));
        assert_eq!(with.leverage, Some(dec("20")));
        assert_eq!(with.margin_mode, Some(MarginMode::Cross));
        // Unread, it's left out rather than counted as billions.
        let without = position(row(), None).unwrap();
        assert_eq!(without.margin, Decimal::default());
        assert_eq!(without.leverage, None);
        // An isolated wallet as large is no figure either.
        let mut isolated = row();
        isolated.isolated_wallet = Some(dec("92233720368.54775807"));
        assert!(needs_leverage(&isolated));
        // A position with a real figure needs nothing more.
        let mut fine = row();
        fine.position_initial_margin = Some(dec("4.994"));
        assert!(!needs_leverage(&fine));
    }

    #[test]
    fn lists_ordinary_and_conditional_orders_apart() {
        let orders: Vec<WireOrder> = serde_json::from_str(
            r#"[{"avgPrice":"0.00000","clientOrderId":"0xabc","cumQuote":"0","executedQty":"0","orderId":1917641,"origQty":"0.40","origType":"LIMIT","price":"9000","reduceOnly":false,"side":"BUY","positionSide":"BOTH","status":"NEW","stopPrice":"0","closePosition":false,"symbol":"BTCUSDT","time":1579276756075,"timeInForce":"GTC","type":"LIMIT","updateTime":1579276756075,"workingType":"CONTRACT_PRICE","priceProtect":false}]"#,
        )
        .unwrap();
        let algos: AlgoOrders = serde_json::from_str(
            r#"[
              {"algoId":2146760,"clientAlgoId":"6B2I9XVcJpCjqPAJ4YoFX7","algoType":"CONDITIONAL","orderType":"STOP_MARKET","symbol":"BTCUSDT","side":"SELL","positionSide":"BOTH","timeInForce":"GTC","quantity":"","algoStatus":"NEW","triggerPrice":"75000.0","price":"0","icebergQuantity":null,"selfTradePreventionMode":"EXPIRE_MAKER","workingType":"MARK_PRICE","priceMatch":"NONE","closePosition":true,"priceProtect":false,"reduceOnly":false,"activatePrice":"","callbackRate":"","createTime":1750485492076,"updateTime":1750485492076,"triggerTime":0,"goodTillDate":0},
              {"algoId":2146761,"clientAlgoId":"","algoType":"CONDITIONAL","orderType":"TAKE_PROFIT","symbol":"BTCUSDT","side":"BUY","quantity":"0.01","activatePrice":"","algoStatus":"NEW","triggerPrice":"70000","price":"69990","workingType":"CONTRACT_PRICE","closePosition":false,"reduceOnly":false,"createTime":5}
            ]"#,
        )
        .unwrap();
        let snap = snapshot(
            "1",
            account(),
            AccountConfig::default(),
            vec![],
            orders,
            algos.into_vec(),
            9,
        );
        assert_eq!(snap.open_orders.len(), 3);
        let limit = &snap.open_orders[0];
        assert_eq!(limit.id, "1917641");
        assert_eq!(limit.trigger_by, None);
        let stop = &snap.open_orders[1];
        assert_eq!(stop.id, "algo:2146760");
        assert_eq!(stop.category, OrderCategory::StopLoss);
        assert_eq!(stop.trigger_price, Some(dec("75000.0")));
        assert_eq!(stop.trigger_by, Some(PriceSource::Mark));
        assert!(stop.reduce_only);
        let tp = &snap.open_orders[2];
        assert_eq!(tp.category, OrderCategory::Conditional);
        assert_eq!(tp.price, Some(dec("69990")));
        assert_eq!(tp.client_id, None);
        // Wrapped, as some answers come.
        let wrapped: AlgoOrders = serde_json::from_str(r#"{"orders":[]}"#).unwrap();
        assert!(wrapped.into_vec().is_empty());
    }
}
