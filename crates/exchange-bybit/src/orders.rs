//! Turning an [`OrderRequest`] into the body of Bybit's `POST /v5/order/create`,
//! and a cancel into `POST /v5/order/cancel`. Pure translation: no keys, no
//! network. The adapter signs exactly the JSON these structs serialize to.
//!
//! Security-relevant - review against `.claude/commands/security-review.md`.
//! What gets signed is decided here, so every field is either a constant or
//! checked: the market against the live list, size and prices against its
//! step and tick, the client id and order id against a strict alphabet. A
//! request Bybit can't express exactly is refused, not approximated, and a
//! market order is always sent as an IOC limit at the slippage bound, so
//! there's no unbounded market order.

use pewterdesk_core::{
    Decimal, ExitChange, OrderAmend, OrderKind, OrderRequest, PositionProtection, Side,
    TimeInForce, VenueError,
};
use rust_decimal::RoundingStrategy;
use serde::Serialize;

/// Linear contracts (USDT and USDC perpetuals): the only category traded.
const CATEGORY: &str = "linear";
/// One-way position mode: a single position per market.
const ONE_WAY: u8 = 0;
/// Bybit's longest `orderLinkId`.
const CLIENT_ID_MAX: usize = 36;
/// The widest slippage bound a market order may carry: 10%.
pub(crate) const MAX_SLIPPAGE_BPS: u32 = 1000;

/// The body of `POST /v5/order/create`.
#[derive(Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CreateOrder {
    category: &'static str,
    symbol: String,
    side: &'static str,
    order_type: &'static str,
    qty: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    price: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    time_in_force: Option<&'static str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    trigger_price: Option<String>,
    /// 1: triggers when the price rises to it; 2: when it falls to it.
    #[serde(skip_serializing_if = "Option::is_none")]
    trigger_direction: Option<u8>,
    #[serde(skip_serializing_if = "Option::is_none")]
    trigger_by: Option<&'static str>,
    reduce_only: bool,
    position_idx: u8,
    #[serde(skip_serializing_if = "Option::is_none")]
    order_link_id: Option<String>,
}

impl CreateOrder {
    /// The limit price sent, if any: the order's own, or a market order's bound.
    pub(crate) fn price(&self) -> Option<&str> {
        self.price.as_deref()
    }
}

/// The body of `POST /v5/position/trading-stop`, in `Full` mode (each exit
/// closes the whole position). A field left out is left as it is; "0"
/// removes one.
#[derive(Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TradingStop {
    category: &'static str,
    symbol: String,
    tpsl_mode: &'static str,
    position_idx: u8,
    #[serde(skip_serializing_if = "Option::is_none")]
    take_profit: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    stop_loss: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    trailing_stop: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    active_price: Option<String>,
}

/// The trading-stop body for `market`'s position: only the exits that
/// change, each price checked against the tick.
pub(crate) fn protection(
    market: &str,
    p: &PositionProtection,
    tick: Decimal,
) -> Result<TradingStop, VenueError> {
    let change = |c: ExitChange, what: &str| -> Result<Option<String>, VenueError> {
        match c {
            ExitChange::Keep => Ok(None),
            ExitChange::Remove => Ok(Some("0".into())),
            ExitChange::Set(v) => {
                positive_on(v, tick, what)?;
                Ok(Some(text(v)))
            }
        }
    };
    let active_price = match (p.trailing_activation, p.trailing_stop) {
        (None, _) => None,
        (Some(v), ExitChange::Set(_)) => {
            positive_on(v, tick, "activation price")?;
            Some(text(v))
        }
        (Some(_), _) => {
            return Err(invalid(
                "an activation price goes with a trailing stop being set",
            ))
        }
    };
    let body = TradingStop {
        category: CATEGORY,
        symbol: market.to_owned(),
        tpsl_mode: "Full",
        position_idx: ONE_WAY,
        take_profit: change(p.take_profit, "take-profit")?,
        stop_loss: change(p.stop_loss, "stop-loss")?,
        trailing_stop: change(p.trailing_stop, "trailing stop distance")?,
        active_price,
    };
    if body.take_profit.is_none() && body.stop_loss.is_none() && body.trailing_stop.is_none() {
        return Err(invalid("nothing to change"));
    }
    Ok(body)
}

/// The body of `POST /v5/order/amend`: only what changes.
#[derive(Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AmendOrder {
    category: &'static str,
    symbol: String,
    order_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    price: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    qty: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    take_profit: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    stop_loss: Option<String>,
}

/// The amend body for `order_id` on `market`: each change checked against
/// the tick and step, the id against Bybit's alphabet.
pub(crate) fn amend(
    market: &str,
    order_id: &str,
    a: &OrderAmend,
    tick: Decimal,
    step: Decimal,
) -> Result<AmendOrder, VenueError> {
    let CancelOrder { order_id, .. } = cancel(market, order_id)?;
    let exit = |c: ExitChange, what: &str| -> Result<Option<String>, VenueError> {
        match c {
            ExitChange::Keep => Ok(None),
            ExitChange::Remove => Ok(Some("0".into())),
            ExitChange::Set(v) => {
                positive_on(v, tick, what)?;
                Ok(Some(text(v)))
            }
        }
    };
    let price = match a.price {
        Some(p) => {
            positive_on(p, tick, "price")?;
            Some(text(p))
        }
        None => None,
    };
    let qty = match a.size {
        Some(s) => {
            positive_on(s, step, "size")?;
            Some(text(s))
        }
        None => None,
    };
    let body = AmendOrder {
        category: CATEGORY,
        symbol: market.to_owned(),
        order_id,
        price,
        qty,
        take_profit: exit(a.take_profit, "take-profit")?,
        stop_loss: exit(a.stop_loss, "stop-loss")?,
    };
    if body.price.is_none()
        && body.qty.is_none()
        && body.take_profit.is_none()
        && body.stop_loss.is_none()
    {
        return Err(invalid("nothing to change"));
    }
    Ok(body)
}

/// The body of `POST /v5/order/cancel`.
#[derive(Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CancelOrder {
    category: &'static str,
    symbol: String,
    order_id: String,
}

/// The touch and last trade, for pricing a market order's bound and telling
/// which way a trigger fires.
#[derive(Clone, Copy, Debug)]
pub(crate) struct Quote {
    pub bid: Decimal,
    pub ask: Decimal,
    pub last: Decimal,
}

fn invalid(msg: &str) -> VenueError {
    VenueError::InvalidRequest(msg.into())
}

/// A decimal Bybit reads: plain digits, no exponent, no trailing zeros.
fn text(d: Decimal) -> String {
    d.0.normalize().to_string()
}

fn on_grid(value: Decimal, step: Decimal) -> bool {
    !step.0.is_zero() && (value.0 % step.0).is_zero()
}

fn positive_on(value: Decimal, step: Decimal, what: &str) -> Result<(), VenueError> {
    if value.0 <= rust_decimal::Decimal::ZERO {
        return Err(invalid(&format!("the {what} must be above zero")));
    }
    if !on_grid(value, step) {
        return Err(invalid(&format!(
            "the {what} must be a multiple of {}",
            text(step)
        )));
    }
    Ok(())
}

/// `price` moved `bps` against the taker and snapped to `tick` on the inside,
/// so the bound is never looser than asked: down for a buy, up for a sell.
fn slipped(price: Decimal, bps: u32, side: Side, tick: Decimal) -> Decimal {
    let factor = rust_decimal::Decimal::from(bps) / rust_decimal::Decimal::from(10_000);
    let raw = match side {
        Side::Buy => price.0 * (rust_decimal::Decimal::ONE + factor),
        Side::Sell => price.0 * (rust_decimal::Decimal::ONE - factor),
    };
    let steps = raw / tick.0;
    let snapped = match side {
        Side::Buy => steps.round_dp_with_strategy(0, RoundingStrategy::ToNegativeInfinity),
        Side::Sell => steps.round_dp_with_strategy(0, RoundingStrategy::ToPositiveInfinity),
    };
    Decimal(snapped * tick.0)
}

/// Bybit's `orderLinkId`: up to 36 letters, digits, `-` and `_`.
fn client_id(id: &Option<String>) -> Result<Option<String>, VenueError> {
    match id {
        None => Ok(None),
        Some(id)
            if !id.is_empty()
                && id.len() <= CLIENT_ID_MAX
                && id
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_') =>
        {
            Ok(Some(id.clone()))
        }
        Some(_) => Err(invalid(
            "a client order id is up to 36 letters, digits, - and _",
        )),
    }
}

/// The create body for `request` on a market with this `tick` and `step`,
/// priced off `quote`.
pub(crate) fn create(
    request: &OrderRequest,
    tick: Decimal,
    step: Decimal,
    quote: Quote,
) -> Result<CreateOrder, VenueError> {
    if request.collateral.is_some() {
        return Err(invalid(
            "Bybit margins across the account; an order can't post its own collateral",
        ));
    }
    positive_on(request.size, step, "size")?;
    let side = match request.side {
        Side::Buy => "Buy",
        Side::Sell => "Sell",
    };
    let mut order = CreateOrder {
        category: CATEGORY,
        symbol: request.market.clone(),
        side,
        order_type: "Limit",
        qty: text(request.size),
        price: None,
        time_in_force: None,
        trigger_price: None,
        trigger_direction: None,
        trigger_by: None,
        reduce_only: request.reduce_only,
        position_idx: ONE_WAY,
        order_link_id: client_id(&request.client_id)?,
    };
    match &request.kind {
        OrderKind::Market { max_slippage_bps } => {
            if *max_slippage_bps == 0 || *max_slippage_bps > MAX_SLIPPAGE_BPS {
                return Err(invalid(
                    "a market order's slippage bound must be 0.01% to 10%",
                ));
            }
            let touch = match request.side {
                Side::Buy => quote.ask,
                Side::Sell => quote.bid,
            };
            if touch.0 <= rust_decimal::Decimal::ZERO {
                return Err(invalid("there's no price to bound a market order by"));
            }
            let bound = slipped(touch, *max_slippage_bps, request.side, tick);
            if bound.0 <= rust_decimal::Decimal::ZERO {
                return Err(invalid("the slippage bound leaves no valid price"));
            }
            order.price = Some(text(bound));
            order.time_in_force = Some("IOC");
        }
        OrderKind::Limit {
            price,
            time_in_force,
        } => {
            positive_on(*price, tick, "price")?;
            order.price = Some(text(*price));
            order.time_in_force = Some(match time_in_force.unwrap_or(TimeInForce::Gtc) {
                TimeInForce::Gtc => "GTC",
                TimeInForce::Ioc => "IOC",
                TimeInForce::PostOnly => "PostOnly",
            });
        }
        OrderKind::Trigger {
            trigger_price,
            limit_price,
        } => {
            positive_on(*trigger_price, tick, "trigger price")?;
            if quote.last.0 <= rust_decimal::Decimal::ZERO {
                return Err(invalid("there's no last price to place a trigger against"));
            }
            if *trigger_price == quote.last {
                return Err(invalid(
                    "the trigger price is the last price; it would fire at once",
                ));
            }
            order.trigger_price = Some(text(*trigger_price));
            order.trigger_direction = Some(if trigger_price.0 > quote.last.0 { 1 } else { 2 });
            order.trigger_by = Some("LastPrice");
            match limit_price {
                Some(limit) => {
                    positive_on(*limit, tick, "limit price")?;
                    order.price = Some(text(*limit));
                    order.time_in_force = Some("GTC");
                }
                None => order.order_type = "Market",
            }
        }
    }
    Ok(order)
}

/// The cancel body for order `order_id` on `market`.
pub(crate) fn cancel(market: &str, order_id: &str) -> Result<CancelOrder, VenueError> {
    let ok = !order_id.is_empty()
        && order_id.len() <= 64
        && order_id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-');
    if !ok {
        return Err(invalid("that isn't a Bybit order id"));
    }
    Ok(CancelOrder {
        category: CATEGORY,
        symbol: market.to_owned(),
        order_id: order_id.to_owned(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn d(s: &str) -> Decimal {
        Decimal(s.parse().unwrap())
    }

    const TICK: &str = "0.1";
    const STEP: &str = "0.001";

    fn quote() -> Quote {
        Quote {
            bid: d("83756.4"),
            ask: d("83756.5"),
            last: d("83756.4"),
        }
    }

    fn request(side: Side, size: &str, kind: OrderKind) -> OrderRequest {
        OrderRequest {
            market: "BTCUSDT".into(),
            side,
            size: d(size),
            reduce_only: false,
            collateral: None,
            client_id: None,
            kind,
        }
    }

    fn body(r: &OrderRequest) -> serde_json::Value {
        serde_json::to_value(create(r, d(TICK), d(STEP), quote()).unwrap()).unwrap()
    }

    #[test]
    fn a_market_buy_is_an_ioc_limit_at_the_bound() {
        let r = request(
            Side::Buy,
            "0.010",
            OrderKind::Market {
                max_slippage_bps: 500,
            },
        );
        // 83756.5 * 1.05 = 87944.325, snapped down to the tick.
        assert_eq!(
            body(&r),
            json!({
                "category": "linear", "symbol": "BTCUSDT", "side": "Buy",
                "orderType": "Limit", "qty": "0.01", "price": "87944.3",
                "timeInForce": "IOC", "reduceOnly": false, "positionIdx": 0
            })
        );
    }

    #[test]
    fn a_market_sell_bound_snaps_up() {
        let r = request(
            Side::Sell,
            "0.5",
            OrderKind::Market {
                max_slippage_bps: 800,
            },
        );
        // 83756.4 * 0.92 = 77055.888, snapped up to the tick.
        assert_eq!(body(&r)["price"], "77055.9");
    }

    #[test]
    fn market_orders_need_a_sane_bound_and_a_price() {
        for bps in [0, MAX_SLIPPAGE_BPS + 1] {
            let r = request(
                Side::Buy,
                "0.01",
                OrderKind::Market {
                    max_slippage_bps: bps,
                },
            );
            assert!(create(&r, d(TICK), d(STEP), quote()).is_err(), "{bps}");
        }
        let r = request(
            Side::Buy,
            "0.01",
            OrderKind::Market {
                max_slippage_bps: 100,
            },
        );
        let empty = Quote {
            bid: d("0"),
            ask: d("0"),
            last: d("0"),
        };
        assert!(create(&r, d(TICK), d(STEP), empty).is_err());
    }

    #[test]
    fn limit_orders_keep_their_price_and_time_in_force() {
        let mut r = request(
            Side::Sell,
            "1",
            OrderKind::Limit {
                price: d("90000.0"),
                time_in_force: Some(TimeInForce::PostOnly),
            },
        );
        r.reduce_only = true;
        r.client_id = Some("pd-1_A".into());
        assert_eq!(
            body(&r),
            json!({
                "category": "linear", "symbol": "BTCUSDT", "side": "Sell",
                "orderType": "Limit", "qty": "1", "price": "90000",
                "timeInForce": "PostOnly", "reduceOnly": true, "positionIdx": 0,
                "orderLinkId": "pd-1_A"
            })
        );
        let gtc = request(
            Side::Buy,
            "1",
            OrderKind::Limit {
                price: d("80000"),
                time_in_force: None,
            },
        );
        assert_eq!(body(&gtc)["timeInForce"], "GTC");
    }

    #[test]
    fn triggers_fire_in_the_right_direction() {
        // A sell stop below the last price fires as it falls.
        let stop = request(
            Side::Sell,
            "0.01",
            OrderKind::Trigger {
                trigger_price: d("80000"),
                limit_price: None,
            },
        );
        let b = body(&stop);
        assert_eq!(
            (b["orderType"].clone(), b["triggerDirection"].clone()),
            (json!("Market"), json!(2))
        );
        assert_eq!(b["triggerPrice"], "80000");
        assert!(b.get("price").is_none());
        // A buy stop-limit above it fires as it rises.
        let up = request(
            Side::Buy,
            "0.01",
            OrderKind::Trigger {
                trigger_price: d("85000"),
                limit_price: Some(d("85100")),
            },
        );
        let b = body(&up);
        assert_eq!(
            (b["orderType"].clone(), b["price"].clone()),
            (json!("Limit"), json!("85100"))
        );
        assert_eq!(b["triggerDirection"], 1);
        // At the last price it would fire at once.
        let now = request(
            Side::Buy,
            "0.01",
            OrderKind::Trigger {
                trigger_price: d("83756.4"),
                limit_price: None,
            },
        );
        assert!(create(&now, d(TICK), d(STEP), quote()).is_err());
    }

    #[test]
    fn refuses_what_bybit_cant_take_exactly() {
        let limit = |size: &str, price: &str| {
            request(
                Side::Buy,
                size,
                OrderKind::Limit {
                    price: d(price),
                    time_in_force: None,
                },
            )
        };
        for bad in [
            limit("0.0105", "80000"),  // off the size step
            limit("0", "80000"),       // no size
            limit("-1", "80000"),      // negative
            limit("0.01", "80000.05"), // off the tick
            limit("0.01", "0"),        // no price
        ] {
            assert!(create(&bad, d(TICK), d(STEP), quote()).is_err(), "{bad:?}");
        }
        let mut collateral = limit("0.01", "80000");
        collateral.collateral = Some(d("100"));
        assert!(create(&collateral, d(TICK), d(STEP), quote()).is_err());
        for id in ["", "has space", "x".repeat(37).as_str(), "semi;colon"] {
            let mut r = limit("0.01", "80000");
            r.client_id = Some(id.into());
            assert!(create(&r, d(TICK), d(STEP), quote()).is_err(), "{id:?}");
        }
    }

    #[test]
    fn protection_sends_only_what_changes() {
        let p = PositionProtection {
            take_profit: ExitChange::Set(d("90000")),
            stop_loss: ExitChange::Remove,
            trailing_stop: ExitChange::Keep,
            trailing_activation: None,
        };
        assert_eq!(
            serde_json::to_value(protection("BTCUSDT", &p, d(TICK)).unwrap()).unwrap(),
            json!({
                "category": "linear", "symbol": "BTCUSDT", "tpslMode": "Full", "positionIdx": 0,
                "takeProfit": "90000", "stopLoss": "0"
            })
        );
        let trail = PositionProtection {
            take_profit: ExitChange::Keep,
            stop_loss: ExitChange::Keep,
            trailing_stop: ExitChange::Set(d("250.5")),
            trailing_activation: Some(d("86000")),
        };
        assert_eq!(
            serde_json::to_value(protection("BTCUSDT", &trail, d(TICK)).unwrap()).unwrap(),
            json!({
                "category": "linear", "symbol": "BTCUSDT", "tpslMode": "Full", "positionIdx": 0,
                "trailingStop": "250.5", "activePrice": "86000"
            })
        );
    }

    #[test]
    fn protection_refuses_bad_or_empty_changes() {
        let keep = PositionProtection {
            take_profit: ExitChange::Keep,
            stop_loss: ExitChange::Keep,
            trailing_stop: ExitChange::Keep,
            trailing_activation: None,
        };
        assert!(protection("BTCUSDT", &keep, d(TICK)).is_err());
        let off_tick = PositionProtection {
            stop_loss: ExitChange::Set(d("80000.05")),
            ..keep.clone()
        };
        assert!(protection("BTCUSDT", &off_tick, d(TICK)).is_err());
        let zero = PositionProtection {
            take_profit: ExitChange::Set(d("0")),
            ..keep.clone()
        };
        assert!(protection("BTCUSDT", &zero, d(TICK)).is_err());
        // An activation price without a trailing stop being set.
        let stray = PositionProtection {
            take_profit: ExitChange::Set(d("90000")),
            trailing_activation: Some(d("86000")),
            ..keep
        };
        assert!(protection("BTCUSDT", &stray, d(TICK)).is_err());
    }

    #[test]
    fn amends_send_only_what_changes() {
        let a = OrderAmend {
            price: Some(d("116.5")),
            size: None,
            take_profit: ExitChange::Set(d("130")),
            stop_loss: ExitChange::Remove,
        };
        assert_eq!(
            serde_json::to_value(amend("SOLUSDT", "o-1", &a, d(TICK), d("0.1")).unwrap()).unwrap(),
            json!({
                "category": "linear", "symbol": "SOLUSDT", "orderId": "o-1",
                "price": "116.5", "takeProfit": "130", "stopLoss": "0"
            })
        );
        let qty = OrderAmend {
            price: None,
            size: Some(d("20")),
            take_profit: ExitChange::Keep,
            stop_loss: ExitChange::Keep,
        };
        assert_eq!(
            serde_json::to_value(amend("SOLUSDT", "o-1", &qty, d(TICK), d("0.1")).unwrap())
                .unwrap(),
            json!({ "category": "linear", "symbol": "SOLUSDT", "orderId": "o-1", "qty": "20" })
        );
        let nothing = OrderAmend {
            size: None,
            ..qty.clone()
        };
        assert!(amend("SOLUSDT", "o-1", &nothing, d(TICK), d("0.1")).is_err());
        let off = OrderAmend {
            size: Some(d("20.05")),
            ..qty.clone()
        };
        assert!(amend("SOLUSDT", "o-1", &off, d(TICK), d("0.1")).is_err());
        assert!(amend("SOLUSDT", "bad id", &qty, d(TICK), d("0.1")).is_err());
    }

    #[test]
    fn cancels_name_the_order_and_market() {
        let c = cancel("BTCUSDT", "1321052653536515584").unwrap();
        assert_eq!(
            serde_json::to_value(c).unwrap(),
            json!({ "category": "linear", "symbol": "BTCUSDT", "orderId": "1321052653536515584" })
        );
        let uuid = cancel("BTCUSDT", "3380b972-a334-4d74-8f9c-5a4e8b3e7a1d");
        assert!(uuid.is_ok());
        for bad in ["", "a b", "x\"}", &"9".repeat(65)] {
            assert!(cancel("BTCUSDT", bad).is_err(), "{bad:?}");
        }
    }
}
