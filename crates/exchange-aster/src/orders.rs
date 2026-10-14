//! Turning an [`OrderRequest`] into the parameters of Aster's
//! `POST /fapi/v3/order`, and a cancel into `DELETE /fapi/v3/order`'s. Pure
//! translation: no keys, no network. The adapter signs exactly the
//! parameters these give (`agent::sign_request`) and sends that string.
//!
//! Security-relevant - review against `.claude/commands/security-review.md`.
//! What gets signed is decided here, so every value is either a constant or
//! checked: the market against the live list, size and prices against its
//! step and tick, the client id and order id against a strict alphabet. A
//! request Aster can't express exactly is refused, not approximated, and a
//! market order is always sent as an IOC limit at the slippage bound, so
//! there's no unbounded market order.
//!
//! Parameter names and values are Aster's V3 futures docs' ("New Order",
//! "Cancel Order"). One-way position mode is assumed: no `positionSide` is
//! sent, which Aster reads as `BOTH`.

use pewterdesk_core::{Decimal, OrderKind, OrderRequest, Side, TimeInForce, VenueError};
use rust_decimal::RoundingStrategy;
use serde::Deserialize;

/// The widest slippage bound a market order may carry: 10%.
pub(crate) const MAX_SLIPPAGE_BPS: u32 = 1000;
/// Aster's longest `newClientOrderId`.
const CLIENT_ID_MAX: usize = 36;

/// A request's parameters, in the order they're signed and sent.
pub(crate) type Params = Vec<(&'static str, String)>;

/// A market's grid, from the venue's own list.
#[derive(Clone, Copy, Debug, PartialEq)]
pub(crate) struct Steps {
    pub tick: Decimal,
    pub step: Decimal,
    pub min_size: Decimal,
}

/// The touch, for pricing a market order's bound and telling which way a
/// trigger fires.
#[derive(Clone, Copy, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Quote {
    #[serde(rename = "bidPrice")]
    pub bid: Decimal,
    #[serde(rename = "askPrice")]
    pub ask: Decimal,
}

fn invalid(msg: &str) -> VenueError {
    VenueError::InvalidRequest(msg.into())
}

fn zero() -> rust_decimal::Decimal {
    rust_decimal::Decimal::ZERO
}

/// A decimal Aster reads: plain digits, no exponent, no trailing zeros.
fn text(d: Decimal) -> String {
    d.0.normalize().to_string()
}

fn on_grid(value: Decimal, step: Decimal) -> bool {
    !step.0.is_zero() && (value.0 % step.0).is_zero()
}

fn positive_on(value: Decimal, step: Decimal, what: &str) -> Result<(), VenueError> {
    if value.0 <= zero() {
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

/// Letters, digits, `-` and `_`: a subset of what Aster takes, and all of
/// it signs and sends as it is.
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

/// The new-order parameters for `request` on a market with these `steps`,
/// priced off `quote`. `request.market` must already be a live market's id.
pub(crate) fn create(
    request: &OrderRequest,
    steps: Steps,
    quote: Quote,
) -> Result<Params, VenueError> {
    if request.collateral.is_some() {
        return Err(invalid(
            "Aster takes margin from the account; an order can't post its own collateral",
        ));
    }
    if request.take_profit.is_some() || request.stop_loss.is_some() {
        return Err(invalid(
            "Aster doesn't take a take-profit or stop-loss with an order; place it as a trigger order once the position is open",
        ));
    }
    positive_on(request.size, steps.step, "size")?;
    if request.size.0 < steps.min_size.0 {
        return Err(invalid(&format!(
            "the smallest order on this market is {}",
            text(steps.min_size)
        )));
    }
    let id = client_id(&request.client_id)?;
    let buying = request.side == Side::Buy;
    let touch = |what: &str| {
        if quote.bid.0 <= zero() || quote.ask.0 <= zero() || quote.bid.0 > quote.ask.0 {
            Err(invalid(&format!("there's no price to {what}")))
        } else {
            Ok(())
        }
    };

    let mut params: Params = vec![
        ("symbol", request.market.clone()),
        ("side", if buying { "BUY" } else { "SELL" }.into()),
    ];
    match &request.kind {
        OrderKind::Market { max_slippage_bps } => {
            if *max_slippage_bps == 0 || *max_slippage_bps > MAX_SLIPPAGE_BPS {
                return Err(invalid(
                    "a market order's slippage bound must be 0.01% to 10%",
                ));
            }
            touch("bound a market order by")?;
            let from = if buying { quote.ask } else { quote.bid };
            let bound = slipped(from, *max_slippage_bps, request.side, steps.tick);
            if bound.0 <= zero() {
                return Err(invalid("the slippage bound leaves no valid price"));
            }
            params.push(("type", "LIMIT".into()));
            params.push(("timeInForce", "IOC".into()));
            params.push(("quantity", text(request.size)));
            params.push(("price", text(bound)));
        }
        OrderKind::Limit {
            price,
            time_in_force,
        } => {
            positive_on(*price, steps.tick, "price")?;
            let tif = match time_in_force.unwrap_or(TimeInForce::Gtc) {
                TimeInForce::Gtc => "GTC",
                TimeInForce::Ioc => "IOC",
                // Aster's name for post-only: good till crossing.
                TimeInForce::PostOnly => "GTX",
            };
            params.push(("type", "LIMIT".into()));
            params.push(("timeInForce", tif.into()));
            params.push(("quantity", text(request.size)));
            params.push(("price", text(*price)));
        }
        OrderKind::Trigger {
            trigger_price,
            limit_price,
        } => {
            positive_on(*trigger_price, steps.tick, "trigger price")?;
            touch("place a trigger against")?;
            // A buy above the price, or a sell below it, is a stop; the
            // other way round it waits for a better price (a take-profit).
            let above = if trigger_price.0 > quote.ask.0 {
                true
            } else if trigger_price.0 < quote.bid.0 {
                false
            } else {
                return Err(invalid(
                    "the trigger price is at the current price; it would fire at once",
                ));
            };
            let stop = above == buying;
            match limit_price {
                Some(limit) => {
                    positive_on(*limit, steps.tick, "limit price")?;
                    params.push(("type", if stop { "STOP" } else { "TAKE_PROFIT" }.into()));
                    params.push(("timeInForce", "GTC".into()));
                    params.push(("quantity", text(request.size)));
                    params.push(("price", text(*limit)));
                }
                None => {
                    let kind = if stop {
                        "STOP_MARKET"
                    } else {
                        "TAKE_PROFIT_MARKET"
                    };
                    params.push(("type", kind.into()));
                    params.push(("quantity", text(request.size)));
                }
            }
            params.push(("stopPrice", text(*trigger_price)));
        }
    }
    if request.reduce_only {
        params.push(("reduceOnly", "true".into()));
    }
    if let Some(id) = id {
        params.push(("newClientOrderId", id));
    }
    // The outcome in the reply, so an IOC order that didn't fill says so.
    params.push(("newOrderRespType", "RESULT".into()));
    Ok(params)
}

/// The cancel parameters for order `order_id` on `market`.
pub(crate) fn cancel(market: &str, order_id: &str) -> Result<Params, VenueError> {
    let ok = !order_id.is_empty()
        && order_id.len() <= 20
        && order_id.bytes().all(|b| b.is_ascii_digit());
    if !ok {
        return Err(invalid("that isn't an Aster order id"));
    }
    Ok(vec![
        ("symbol", market.to_owned()),
        ("orderId", order_id.to_owned()),
    ])
}

/// Aster's reply to a new order, as far as it's read.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Placed {
    pub order_id: u64,
    pub status: String,
    #[serde(default)]
    pub executed_qty: Decimal,
}

/// How a new order ended up, from its reply.
#[derive(Clone, Copy, Debug, PartialEq)]
pub(crate) enum Outcome {
    /// Waiting on the book, or on its trigger.
    Open,
    /// Filled, all of it or (an IOC order) this much.
    Filled(Decimal),
}

impl Placed {
    /// An order that ended without filling anything is a refusal: nothing
    /// was done, and saying "placed" would be wrong.
    pub(crate) fn outcome(&self) -> Result<Outcome, VenueError> {
        let filled = self.executed_qty.0 > zero();
        match self.status.as_str() {
            "FILLED" => Ok(Outcome::Filled(self.executed_qty)),
            "NEW" | "PARTIALLY_FILLED" => Ok(Outcome::Open),
            "EXPIRED" | "CANCELED" if filled => Ok(Outcome::Filled(self.executed_qty)),
            "EXPIRED" | "CANCELED" => Err(VenueError::Rejected(
                "nothing filled: the price moved past the order's bound, or the order couldn't rest".into(),
            )),
            "REJECTED" => Err(VenueError::Rejected("Aster rejected the order".into())),
            _ => Ok(Outcome::Open),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn d(s: &str) -> Decimal {
        Decimal(s.parse().unwrap())
    }

    fn steps() -> Steps {
        Steps {
            tick: d("0.1"),
            step: d("0.001"),
            min_size: d("0.001"),
        }
    }

    fn quote() -> Quote {
        Quote {
            bid: d("83023.3"),
            ask: d("83023.4"),
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
            take_profit: None,
            stop_loss: None,
            kind,
        }
    }

    fn limit_at(price: &str) -> OrderKind {
        OrderKind::Limit {
            price: d(price),
            time_in_force: None,
        }
    }

    fn joined(r: &OrderRequest) -> String {
        create(r, steps(), quote())
            .unwrap()
            .iter()
            .map(|(k, v)| format!("{k}={v}"))
            .collect::<Vec<_>>()
            .join("&")
    }

    #[test]
    fn a_limit_order_is_what_the_docs_example_sends() {
        assert_eq!(
            joined(&request(Side::Buy, "0.020", limit_at("80000.0"))),
            "symbol=BTCUSDT&side=BUY&type=LIMIT&timeInForce=GTC&quantity=0.02&price=80000&newOrderRespType=RESULT"
        );
        for (tif, name) in [
            (TimeInForce::Gtc, "GTC"),
            (TimeInForce::Ioc, "IOC"),
            (TimeInForce::PostOnly, "GTX"),
        ] {
            let r = request(
                Side::Sell,
                "1",
                OrderKind::Limit {
                    price: d("90000"),
                    time_in_force: Some(tif),
                },
            );
            assert!(joined(&r).contains(&format!("side=SELL&type=LIMIT&timeInForce={name}&")));
        }
    }

    #[test]
    fn a_market_order_is_an_ioc_limit_at_the_bound() {
        let market = |side| {
            request(
                side,
                "0.5",
                OrderKind::Market {
                    max_slippage_bps: 100,
                },
            )
        };
        // 83023.4 * 1.01 = 83853.634, snapped down to the tick.
        assert_eq!(
            joined(&market(Side::Buy)),
            "symbol=BTCUSDT&side=BUY&type=LIMIT&timeInForce=IOC&quantity=0.5&price=83853.6&newOrderRespType=RESULT"
        );
        // 83023.3 * 0.99 = 82193.067, snapped up: never looser than asked.
        assert!(joined(&market(Side::Sell)).contains("price=82193.1&"));
    }

    #[test]
    fn market_orders_need_a_sane_bound_and_a_price() {
        for bps in [0, 1001] {
            let r = request(
                Side::Buy,
                "1",
                OrderKind::Market {
                    max_slippage_bps: bps,
                },
            );
            assert!(create(&r, steps(), quote()).is_err(), "{bps}");
        }
        let r = request(
            Side::Buy,
            "1",
            OrderKind::Market {
                max_slippage_bps: 50,
            },
        );
        for (bid, ask) in [("0", "0"), ("0", "10"), ("11", "10")] {
            let empty = Quote {
                bid: d(bid),
                ask: d(ask),
            };
            assert!(create(&r, steps(), empty).is_err(), "{bid}/{ask}");
        }
    }

    #[test]
    fn triggers_fire_in_the_right_direction() {
        let trigger = |side, price: &str, limit: Option<&str>| {
            request(
                side,
                "1",
                OrderKind::Trigger {
                    trigger_price: d(price),
                    limit_price: limit.map(d),
                },
            )
        };
        for (side, price, kind) in [
            (Side::Buy, "84000", "STOP_MARKET"),
            (Side::Sell, "82000", "STOP_MARKET"),
            (Side::Buy, "82000", "TAKE_PROFIT_MARKET"),
            (Side::Sell, "84000", "TAKE_PROFIT_MARKET"),
        ] {
            let sent = joined(&trigger(side, price, None));
            assert!(
                sent.contains(&format!("&type={kind}&quantity=1&stopPrice={price}&")),
                "{side:?} {price}: {sent}"
            );
            // No price or time in force on a market trigger: Aster refuses them.
            assert!(!sent.contains("&price=") && !sent.contains("timeInForce"));
        }
        assert_eq!(
            joined(&trigger(Side::Buy, "84000", Some("84010"))),
            "symbol=BTCUSDT&side=BUY&type=STOP&timeInForce=GTC&quantity=1&price=84010&stopPrice=84000&newOrderRespType=RESULT"
        );
        assert!(joined(&trigger(Side::Sell, "84000", Some("84010"))).contains("type=TAKE_PROFIT&"));
        // At or inside the touch it would fire at once.
        for at in ["83023.3", "83023.4"] {
            assert!(create(&trigger(Side::Buy, at, None), steps(), quote()).is_err());
        }
    }

    #[test]
    fn refuses_what_aster_cant_take_exactly() {
        let bad = [
            request(Side::Buy, "0", limit_at("80000")),
            request(Side::Buy, "-1", limit_at("80000")),
            // Off the size step, off the tick.
            request(Side::Buy, "0.0005", limit_at("80000")),
            request(Side::Buy, "1", limit_at("80000.05")),
            request(Side::Buy, "1", limit_at("0")),
        ];
        for r in &bad {
            assert!(create(r, steps(), quote()).is_err(), "{r:?}");
        }
        let small = Steps {
            min_size: d("0.01"),
            ..steps()
        };
        assert!(create(
            &request(Side::Buy, "0.005", limit_at("80000")),
            small,
            quote()
        )
        .is_err());
        let mut own_margin = request(Side::Buy, "1", limit_at("80000"));
        own_margin.collateral = Some(d("50"));
        assert!(create(&own_margin, steps(), quote()).is_err());
        let mut with_exit = request(Side::Buy, "1", limit_at("80000"));
        with_exit.stop_loss = Some(d("79000"));
        assert!(create(&with_exit, steps(), quote()).is_err());
        for id in ["", "has space", "a&b=c", &"x".repeat(37)] {
            let mut r = request(Side::Buy, "1", limit_at("80000"));
            r.client_id = Some(id.into());
            assert!(create(&r, steps(), quote()).is_err(), "{id}");
        }
    }

    #[test]
    fn reduce_only_and_a_client_id_go_along() {
        let mut r = request(Side::Sell, "1", limit_at("90000"));
        r.reduce_only = true;
        r.client_id = Some("pd-1_a".into());
        assert!(joined(&r).ends_with(
            "&price=90000&reduceOnly=true&newClientOrderId=pd-1_a&newOrderRespType=RESULT"
        ));
        // Left out when it isn't set, as Aster's hedge mode refuses the parameter.
        assert!(!joined(&request(Side::Sell, "1", limit_at("90000"))).contains("reduceOnly"));
    }

    #[test]
    fn everything_sent_signs_as_it_is() {
        // The signer refuses anything that URL encoding would change; an
        // order must never trip it.
        let mut r = request(
            Side::Buy,
            "0.001",
            OrderKind::Trigger {
                trigger_price: d("84000.5"),
                limit_price: Some(d("84001")),
            },
        );
        r.reduce_only = true;
        r.client_id = Some("pd-1_a".into());
        for (name, value) in create(&r, steps(), quote()).unwrap() {
            assert!(
                !value.is_empty()
                    && value
                        .bytes()
                        .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b'-')),
                "{name}={value}"
            );
        }
    }

    #[test]
    fn cancels_name_the_market_and_the_order() {
        assert_eq!(
            cancel("BTCUSDT", "283194212").unwrap(),
            vec![
                ("symbol", "BTCUSDT".to_owned()),
                ("orderId", "283194212".to_owned())
            ]
        );
        for bad in ["", "abc", "-1", "1.5", "1&symbol=ETHUSDT", &"9".repeat(21)] {
            assert!(cancel("BTCUSDT", bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn reads_how_an_order_ended_up() {
        let placed = |status: &str, executed: &str| -> Placed {
            serde_json::from_value(serde_json::json!({
                "orderId": 22542179, "status": status, "executedQty": executed,
                "symbol": "BTCUSDT", "side": "BUY",
            }))
            .unwrap()
        };
        assert_eq!(placed("NEW", "0").outcome().unwrap(), Outcome::Open);
        assert_eq!(
            placed("FILLED", "0.5").outcome().unwrap(),
            Outcome::Filled(d("0.5"))
        );
        // An IOC order that filled part and dropped the rest.
        assert_eq!(
            placed("EXPIRED", "0.2").outcome().unwrap(),
            Outcome::Filled(d("0.2"))
        );
        // One that filled nothing did nothing.
        assert!(matches!(
            placed("EXPIRED", "0").outcome().unwrap_err(),
            VenueError::Rejected(_)
        ));
        assert!(placed("REJECTED", "0").outcome().is_err());
    }
}
