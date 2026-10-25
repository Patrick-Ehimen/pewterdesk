//! Turning an [`OrderRequest`] into the parameters of Binance's
//! `POST /fapi/v1/order` (limit and market orders) or, for a trigger order,
//! `POST /fapi/v1/algoOrder` (since 2025-12-09 Binance takes conditional
//! orders only there); a cancel into `DELETE /fapi/v1/order` or
//! `/fapi/v1/algoOrder`; a change to a limit order into `PUT /fapi/v1/order`;
//! leverage and margin mode into `POST /fapi/v1/leverage` and
//! `/fapi/v1/marginType`; the dead-man's switch into
//! `/fapi/v1/countdownCancelAll`; and a position's take-profit and stop-loss
//! into close-position conditional orders. Pure translation: no keys, no
//! network. The adapter signs exactly the parameters these give and sends
//! that string.
//!
//! Security-relevant - review against `.claude/commands/security-review.md`.
//! What gets signed is decided here, so every value is either a constant or
//! checked: the market against the live list, size and prices against its
//! step and tick, the client id and order id against a strict alphabet. A
//! request Binance can't express exactly is refused, not approximated, and a
//! market order is always sent as an IOC limit at the slippage bound (pulled
//! inside the market's price band, so never looser than asked), so there's
//! no unbounded market order.
//!
//! Parameter names and values are Binance's USDⓈ-M docs' ("New Order", "New
//! Algo Order", "Cancel Order", "Cancel Algo Order", "Modify Order", "Change
//! Initial Leverage", "Change Margin Type", "Auto-Cancel All Open Orders").
//! One-way position mode is assumed: no `positionSide` is sent, which
//! Binance reads as `BOTH`, and refuses (-4061) on a Hedge Mode account.

use pewterdesk_core::{
    Decimal, MarginMode, OrderKind, OrderRequest, Side, TimeInForce, VenueError,
};
use rust_decimal::RoundingStrategy;
use serde::Deserialize;

use crate::account::ALGO_PREFIX;
use crate::wire::Grid;

/// The widest slippage bound a market order may carry: 10%.
pub(crate) const MAX_SLIPPAGE_BPS: u32 = 1000;
/// Binance's longest `newClientOrderId` and `clientAlgoId`.
const CLIENT_ID_MAX: usize = 36;

/// A request's parameters, in the order they're signed and sent.
pub(crate) type Params = Vec<(&'static str, String)>;

/// Where a new order goes: the order endpoint, or the Algo Service.
#[derive(Debug, PartialEq)]
pub(crate) enum NewOrder {
    Order(Params),
    Algo(Params),
}

/// The touch, for pricing a market order's bound and telling which way a
/// trigger fires, and the mark, which the price band is around.
#[derive(Clone, Copy, Debug)]
pub(crate) struct Quote {
    pub bid: Decimal,
    pub ask: Decimal,
    pub mark: Option<Decimal>,
}

fn invalid(msg: &str) -> VenueError {
    VenueError::InvalidRequest(msg.into())
}

fn zero() -> rust_decimal::Decimal {
    rust_decimal::Decimal::ZERO
}

/// A decimal Binance reads: plain digits, no exponent, no trailing zeros.
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

fn side(side: Side) -> String {
    match side {
        Side::Buy => "BUY",
        Side::Sell => "SELL",
    }
    .into()
}

/// `raw` snapped to `tick` on the inside for `side`: down for a buy, up for
/// a sell, so a bound is never looser than asked.
fn snap(raw: rust_decimal::Decimal, side: Side, tick: Decimal) -> rust_decimal::Decimal {
    let steps = raw / tick.0;
    let snapped = match side {
        Side::Buy => steps.round_dp_with_strategy(0, RoundingStrategy::ToNegativeInfinity),
        Side::Sell => steps.round_dp_with_strategy(0, RoundingStrategy::ToPositiveInfinity),
    };
    snapped * tick.0
}

/// `price` moved `bps` against the taker and snapped to `tick`, then pulled
/// inside the market's band around the mark where it would be outside it
/// (Binance refuses a limit price outside the band). Only ever tighter.
fn bound(price: Decimal, bps: u32, side: Side, grid: Grid, mark: Option<Decimal>) -> Decimal {
    let factor = rust_decimal::Decimal::from(bps) / rust_decimal::Decimal::from(10_000);
    let slipped = match side {
        Side::Buy => price.0 * (rust_decimal::Decimal::ONE + factor),
        Side::Sell => price.0 * (rust_decimal::Decimal::ONE - factor),
    };
    let mut bound = snap(slipped, side, grid.tick);
    if let (Some((down, up)), Some(mark)) = (grid.band, mark.filter(|m| m.0 > zero())) {
        let edge = match side {
            Side::Buy => snap(mark.0 * up.0, Side::Buy, grid.tick),
            Side::Sell => snap(mark.0 * down.0, Side::Sell, grid.tick),
        };
        bound = match side {
            Side::Buy => bound.min(edge),
            Side::Sell => bound.max(edge),
        };
    }
    Decimal(bound)
}

/// Letters, digits, `-` and `_`: a subset of what Binance takes
/// (`^[\.A-Z\:/a-z0-9_-]{1,36}$`), and all of it signs and sends as it is.
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

fn check_size(size: Decimal, grid: Grid) -> Result<(), VenueError> {
    positive_on(size, grid.step, "size")?;
    if size.0 < grid.min_size.0 {
        return Err(invalid(&format!(
            "the smallest order on this market is {}",
            text(grid.min_size)
        )));
    }
    Ok(())
}

/// The new-order parameters for `request` on a market with this `grid`,
/// priced off `quote`. `request.market` must already be a live market's id.
pub(crate) fn create(
    request: &OrderRequest,
    grid: Grid,
    quote: Quote,
) -> Result<NewOrder, VenueError> {
    if request.collateral.is_some() {
        return Err(invalid(
            "Binance takes margin from the account; an order can't post its own collateral",
        ));
    }
    if request.take_profit.is_some() || request.stop_loss.is_some() {
        return Err(invalid(
            "Binance doesn't take a take-profit or stop-loss with an order; set it on the position once it's open",
        ));
    }
    check_size(request.size, grid)?;
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
        ("side", side(request.side)),
    ];
    let algo = match &request.kind {
        // A venue-run TWAP is Hyperliquid's alone.
        OrderKind::Twap { .. } => return Err(VenueError::Unsupported("a venue-run TWAP")),
        OrderKind::Market { max_slippage_bps } => {
            if *max_slippage_bps == 0 || *max_slippage_bps > MAX_SLIPPAGE_BPS {
                return Err(invalid(
                    "a market order's slippage bound must be 0.01% to 10%",
                ));
            }
            touch("bound a market order by")?;
            let from = if buying { quote.ask } else { quote.bid };
            let bound = bound(from, *max_slippage_bps, request.side, grid, quote.mark);
            if bound.0 <= zero() {
                return Err(invalid("the slippage bound leaves no valid price"));
            }
            params.push(("type", "LIMIT".into()));
            params.push(("timeInForce", "IOC".into()));
            params.push(("quantity", text(request.size)));
            params.push(("price", text(bound)));
            false
        }
        OrderKind::Limit {
            price,
            time_in_force,
        } => {
            positive_on(*price, grid.tick, "price")?;
            let tif = match time_in_force.unwrap_or(TimeInForce::Gtc) {
                TimeInForce::Gtc => "GTC",
                TimeInForce::Ioc => "IOC",
                // Binance's name for post-only: good till crossing.
                TimeInForce::PostOnly => "GTX",
            };
            params.push(("type", "LIMIT".into()));
            params.push(("timeInForce", tif.into()));
            params.push(("quantity", text(request.size)));
            params.push(("price", text(*price)));
            false
        }
        OrderKind::Trigger {
            trigger_price,
            limit_price,
        } => {
            positive_on(*trigger_price, grid.tick, "trigger price")?;
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
            params.insert(0, ("algoType", "CONDITIONAL".into()));
            match limit_price {
                Some(limit) => {
                    positive_on(*limit, grid.tick, "limit price")?;
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
            params.push(("triggerPrice", text(*trigger_price)));
            // On the last price, as the touch it was checked against.
            params.push(("workingType", "CONTRACT_PRICE".into()));
            true
        }
    };
    if request.reduce_only {
        params.push(("reduceOnly", "true".into()));
    }
    if let Some(id) = id {
        params.push((
            if algo {
                "clientAlgoId"
            } else {
                "newClientOrderId"
            },
            id,
        ));
    }
    if algo {
        Ok(NewOrder::Algo(params))
    } else {
        // The outcome in the reply, so an IOC order that didn't fill says so.
        params.push(("newOrderRespType", "RESULT".into()));
        Ok(NewOrder::Order(params))
    }
}

/// Digits only: a Binance order or algo id.
fn digits(id: &str) -> Result<String, VenueError> {
    let ok = !id.is_empty() && id.len() <= 20 && id.bytes().all(|b| b.is_ascii_digit());
    if ok {
        Ok(id.to_owned())
    } else {
        Err(invalid("that isn't a Binance order id"))
    }
}

/// An order id as the adapter hands them out: digits for an ordinary order,
/// `algo:` and digits for a conditional one.
#[derive(Debug, PartialEq, Eq)]
pub(crate) enum OrderId {
    Order(String),
    Algo(String),
}

pub(crate) fn order_id(id: &str) -> Result<OrderId, VenueError> {
    match id.strip_prefix(ALGO_PREFIX) {
        Some(algo) => Ok(OrderId::Algo(digits(algo)?)),
        None => Ok(OrderId::Order(digits(id)?)),
    }
}

/// The cancel parameters for order `id` on `market`, and whether it goes to
/// the Algo Service.
pub(crate) fn cancel(market: &str, id: &str) -> Result<(bool, Params), VenueError> {
    Ok(match order_id(id)? {
        OrderId::Order(id) => (false, vec![("symbol", market.to_owned()), ("orderId", id)]),
        OrderId::Algo(id) => (true, vec![("algoId", id)]),
    })
}

/// The parameters to read one open ordinary order (`GET /fapi/v1/openOrder`).
pub(crate) fn open_order(market: &str, id: &str) -> Result<Params, VenueError> {
    match order_id(id)? {
        OrderId::Order(id) => Ok(vec![("symbol", market.to_owned()), ("orderId", id)]),
        OrderId::Algo(_) => Err(invalid(
            "Binance can't change a conditional order that hasn't triggered; cancel it and place another",
        )),
    }
}

/// The parameters of `PUT /fapi/v1/order`: limit order `order_id` changed to
/// `size` (its whole size) at `price`. Binance changes only limit orders and
/// wants both values; the side is sent so Binance checks it against the
/// order's.
pub(crate) fn amend(
    market: &str,
    order_id: &str,
    side: Side,
    size: Decimal,
    price: Decimal,
    grid: Grid,
) -> Result<Params, VenueError> {
    let id = match self::order_id(order_id)? {
        OrderId::Order(id) => id,
        OrderId::Algo(_) => {
            return Err(invalid(
                "Binance can't change a conditional order that hasn't triggered; cancel it and place another",
            ))
        }
    };
    check_size(size, grid)?;
    positive_on(price, grid.tick, "price")?;
    Ok(vec![
        ("symbol", market.to_owned()),
        ("orderId", id),
        ("side", self::side(side)),
        ("quantity", text(size)),
        ("price", text(price)),
    ])
}

/// The parameters of `POST /fapi/v1/leverage`: a whole number from 1 to
/// the market's highest for this account.
pub(crate) fn leverage(market: &str, leverage: Decimal, max: u32) -> Result<Params, VenueError> {
    let plain = leverage.0.normalize();
    let value = (plain.scale() == 0)
        .then(|| u32::try_from(plain.mantissa()).ok())
        .flatten()
        .filter(|v| (1..=max).contains(v))
        .ok_or_else(|| {
            invalid(&format!(
                "the leverage must be a whole number from 1 to {max} on this market"
            ))
        })?;
    Ok(vec![
        ("symbol", market.to_owned()),
        ("leverage", value.to_string()),
    ])
}

/// The longest countdown the dead-man's switch takes here: an hour.
const COUNTDOWN_MAX_MS: u64 = 3_600_000;

/// The parameters of `POST /fapi/v1/countdownCancelAll`, Binance's
/// dead-man's switch: cancel every open order on `market` unless it's
/// called again within `after_ms` (at least 10 seconds); `None` stops it
/// (`0`). It can only cancel.
pub(crate) fn countdown(market: &str, after_ms: Option<u64>) -> Result<Params, VenueError> {
    let ms = match after_ms {
        None => 0,
        Some(ms) if (10_000..=COUNTDOWN_MAX_MS).contains(&ms) => ms,
        Some(_) => {
            return Err(invalid(
                "the switch's countdown must be 10 seconds to an hour",
            ))
        }
    };
    Ok(vec![
        ("symbol", market.to_owned()),
        ("countdownTime", ms.to_string()),
    ])
}

/// The parameters of `POST /fapi/v1/marginType`.
pub(crate) fn margin_type(market: &str, mode: MarginMode) -> Params {
    vec![
        ("symbol", market.to_owned()),
        (
            "marginType",
            match mode {
                MarginMode::Isolated => "ISOLATED",
                MarginMode::Cross => "CROSSED",
            }
            .into(),
        ),
    ]
}

/// Which of a position's exits.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Exit {
    TakeProfit,
    StopLoss,
}

impl Exit {
    /// Its conditional order's type, as `openAlgoOrders` lists it.
    pub(crate) fn order_type(self) -> &'static str {
        match self {
            Exit::TakeProfit => "TAKE_PROFIT_MARKET",
            Exit::StopLoss => "STOP_MARKET",
        }
    }
}

/// The new algo order parameters for a position's exit: at market once the
/// mark reaches `price`, closing the whole position (`closePosition`, which
/// can only reduce it). It must be on its own side of the touch now, or it
/// would fire at once.
pub(crate) fn exit(
    market: &str,
    long: bool,
    exit: Exit,
    price: Decimal,
    grid: Grid,
    quote: Quote,
) -> Result<Params, VenueError> {
    positive_on(price, grid.tick, "exit price")?;
    if quote.bid.0 <= zero() || quote.ask.0 <= zero() {
        return Err(invalid("there's no price for this market right now"));
    }
    let wrong_side = match (exit, long) {
        (Exit::TakeProfit, true) => price.0 <= quote.ask.0,
        (Exit::TakeProfit, false) => price.0 >= quote.bid.0,
        (Exit::StopLoss, true) => price.0 >= quote.bid.0,
        (Exit::StopLoss, false) => price.0 <= quote.ask.0,
    };
    if wrong_side {
        return Err(invalid(match exit {
            Exit::TakeProfit => "the take-profit must be on the profitable side of the price now",
            Exit::StopLoss => "the stop-loss must be on the losing side of the price now",
        }));
    }
    Ok(vec![
        ("algoType", "CONDITIONAL".into()),
        ("symbol", market.to_owned()),
        ("side", if long { "SELL" } else { "BUY" }.into()),
        ("type", exit.order_type().into()),
        ("triggerPrice", text(price)),
        ("closePosition", "true".into()),
        ("workingType", "MARK_PRICE".into()),
    ])
}

/// Binance's reply to a new order, as far as it's read.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Placed {
    pub order_id: u64,
    pub status: String,
    #[serde(default)]
    pub executed_qty: Decimal,
}

/// Binance's reply to a new algo order, as far as it's read.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AlgoPlaced {
    pub algo_id: u64,
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
            "EXPIRED" | "CANCELED" | "EXPIRED_IN_MATCH" if filled => {
                Ok(Outcome::Filled(self.executed_qty))
            }
            "EXPIRED" | "CANCELED" | "EXPIRED_IN_MATCH" => Err(VenueError::Rejected(
                "nothing filled: the price moved past the order's bound, or a post-only order would have crossed".into(),
            )),
            "REJECTED" => Err(VenueError::Rejected("Binance rejected the order".into())),
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

    fn grid() -> Grid {
        Grid {
            tick: d("0.1"),
            step: d("0.001"),
            min_size: d("0.001"),
            band: None,
        }
    }

    fn quote() -> Quote {
        Quote {
            bid: d("83023.3"),
            ask: d("83023.4"),
            mark: Some(d("83023.35")),
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

    fn joined(params: &Params) -> String {
        params
            .iter()
            .map(|(k, v)| format!("{k}={v}"))
            .collect::<Vec<_>>()
            .join("&")
    }

    fn sent(r: &OrderRequest) -> (bool, String) {
        match create(r, grid(), quote()).unwrap() {
            NewOrder::Order(p) => (false, joined(&p)),
            NewOrder::Algo(p) => (true, joined(&p)),
        }
    }

    fn limit_at(price: &str) -> OrderKind {
        OrderKind::Limit {
            price: d(price),
            time_in_force: None,
        }
    }

    #[test]
    fn a_limit_order_is_what_the_docs_example_sends() {
        assert_eq!(
            sent(&request(Side::Buy, "1", limit_at("9000"))),
            (
                false,
                "symbol=BTCUSDT&side=BUY&type=LIMIT&timeInForce=GTC&quantity=1&price=9000&newOrderRespType=RESULT".into()
            )
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
            assert!(sent(&r)
                .1
                .contains(&format!("side=SELL&type=LIMIT&timeInForce={name}&")));
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
            sent(&market(Side::Buy)).1,
            "symbol=BTCUSDT&side=BUY&type=LIMIT&timeInForce=IOC&quantity=0.5&price=83853.6&newOrderRespType=RESULT"
        );
        // 83023.3 * 0.99 = 82193.067, snapped up: never looser than asked.
        assert!(sent(&market(Side::Sell)).1.contains("price=82193.1&"));
    }

    #[test]
    fn the_bound_stays_inside_the_price_band() {
        let banded = Grid {
            band: Some((d("0.97"), d("1.03"))),
            ..grid()
        };
        let market = |side| {
            request(
                side,
                "0.5",
                OrderKind::Market {
                    max_slippage_bps: 500,
                },
            )
        };
        let price = |side| match create(&market(side), banded, quote()).unwrap() {
            NewOrder::Order(p) => p.into_iter().find(|(k, _)| *k == "price").unwrap().1,
            NewOrder::Algo(_) => unreachable!(),
        };
        // 5% would be 87174.5; the band's edge is 83023.35 * 1.03 = 85514.0505.
        assert_eq!(price(Side::Buy), "85514");
        // 78872.1 asked; the band's floor is 80532.6495, snapped up.
        assert_eq!(price(Side::Sell), "80532.7");
        // A bound already inside the band is kept as asked.
        let tight = request(
            Side::Buy,
            "0.5",
            OrderKind::Market {
                max_slippage_bps: 100,
            },
        );
        let NewOrder::Order(p) = create(&tight, banded, quote()).unwrap() else {
            unreachable!()
        };
        assert!(joined(&p).contains("price=83853.6&"));
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
            assert!(create(&r, grid(), quote()).is_err(), "{bps}");
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
                mark: None,
            };
            assert!(create(&r, grid(), empty).is_err(), "{bid}/{ask}");
        }
    }

    #[test]
    fn triggers_go_to_the_algo_service_and_fire_the_right_way() {
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
            let (algo, sent) = sent(&trigger(side, price, None));
            assert!(algo);
            assert!(
                sent.starts_with("algoType=CONDITIONAL&symbol=BTCUSDT&"),
                "{sent}"
            );
            assert!(
                sent.contains(&format!(
                    "&type={kind}&quantity=1&triggerPrice={price}&workingType=CONTRACT_PRICE"
                )),
                "{side:?} {price}: {sent}"
            );
            // No price or time in force on a market trigger, and no order
            // endpoint parameters.
            assert!(!sent.contains("&price=") && !sent.contains("timeInForce"));
            assert!(!sent.contains("stopPrice") && !sent.contains("newOrderRespType"));
        }
        let mut limit = trigger(Side::Buy, "84000", Some("84010"));
        limit.client_id = Some("0x00000000000000010000000000000002".into());
        limit.reduce_only = true;
        assert_eq!(
            sent(&limit).1,
            "algoType=CONDITIONAL&symbol=BTCUSDT&side=BUY&type=STOP&timeInForce=GTC&quantity=1&price=84010&triggerPrice=84000&workingType=CONTRACT_PRICE&reduceOnly=true&clientAlgoId=0x00000000000000010000000000000002"
        );
        assert!(sent(&trigger(Side::Sell, "84000", Some("84010")))
            .1
            .contains("type=TAKE_PROFIT&"));
        // At or inside the touch it would fire at once.
        for at in ["83023.3", "83023.4"] {
            assert!(create(&trigger(Side::Buy, at, None), grid(), quote()).is_err());
        }
    }

    #[test]
    fn refuses_what_binance_cant_take_exactly() {
        let bad = [
            request(Side::Buy, "0", limit_at("80000")),
            request(Side::Buy, "-1", limit_at("80000")),
            // Off the size step, off the tick.
            request(Side::Buy, "0.0005", limit_at("80000")),
            request(Side::Buy, "1", limit_at("80000.05")),
            request(Side::Buy, "1", limit_at("0")),
            request(
                Side::Buy,
                "1",
                OrderKind::Twap {
                    minutes: 30,
                    randomize: false,
                },
            ),
        ];
        for r in &bad {
            assert!(create(r, grid(), quote()).is_err(), "{r:?}");
        }
        let small = Grid {
            min_size: d("0.01"),
            ..grid()
        };
        assert!(create(
            &request(Side::Buy, "0.005", limit_at("80000")),
            small,
            quote()
        )
        .is_err());
        let mut own_margin = request(Side::Buy, "1", limit_at("80000"));
        own_margin.collateral = Some(d("50"));
        assert!(create(&own_margin, grid(), quote()).is_err());
        let mut with_exit = request(Side::Buy, "1", limit_at("80000"));
        with_exit.stop_loss = Some(d("79000"));
        assert!(create(&with_exit, grid(), quote()).is_err());
        for id in ["", "has space", "a&b=c", "a/b", &"x".repeat(37)] {
            let mut r = request(Side::Buy, "1", limit_at("80000"));
            r.client_id = Some(id.into());
            assert!(create(&r, grid(), quote()).is_err(), "{id}");
        }
    }

    #[test]
    fn reduce_only_and_a_client_id_go_along() {
        let mut r = request(Side::Sell, "1", limit_at("90000"));
        r.reduce_only = true;
        r.client_id = Some("0x00000000000000010000000000000002".into());
        assert!(sent(&r).1.ends_with(
            "&price=90000&reduceOnly=true&newClientOrderId=0x00000000000000010000000000000002&newOrderRespType=RESULT"
        ));
        // Left out when it isn't set, as hedge mode refuses the parameter.
        assert!(!sent(&request(Side::Sell, "1", limit_at("90000")))
            .1
            .contains("reduceOnly"));
    }

    #[test]
    fn everything_but_the_symbol_is_plain_ascii() {
        // The signer encodes what needs it; every value built here but the
        // market's own symbol needs nothing.
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
        let NewOrder::Algo(params) = create(&r, grid(), quote()).unwrap() else {
            unreachable!()
        };
        for (name, value) in params.iter().filter(|(k, _)| *k != "symbol") {
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
    fn cancels_go_where_the_order_lives() {
        assert_eq!(
            cancel("BTCUSDT", "283194212").unwrap(),
            (
                false,
                vec![
                    ("symbol", "BTCUSDT".to_owned()),
                    ("orderId", "283194212".to_owned())
                ]
            )
        );
        assert_eq!(
            cancel("BTCUSDT", "algo:2146760").unwrap(),
            (true, vec![("algoId", "2146760".to_owned())])
        );
        for bad in [
            "",
            "abc",
            "-1",
            "1.5",
            "1&symbol=ETHUSDT",
            &"9".repeat(21),
            "algo:",
            "algo:x",
            "algo:algo:1",
        ] {
            assert!(cancel("BTCUSDT", bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn a_change_sends_both_values_on_the_grid() {
        assert_eq!(
            amend("BTCUSDT", "42", Side::Sell, d("0.25"), d("90000.5"), grid()).unwrap(),
            vec![
                ("symbol", "BTCUSDT".into()),
                ("orderId", "42".into()),
                ("side", "SELL".into()),
                ("quantity", "0.25".into()),
                ("price", "90000.5".into()),
            ]
        );
        assert!(amend("BTCUSDT", "42", Side::Buy, d("0.0005"), d("90000"), grid()).is_err());
        assert!(amend("BTCUSDT", "42", Side::Buy, d("1"), d("90000.05"), grid()).is_err());
        // A conditional order can't be changed before it triggers.
        assert!(amend("BTCUSDT", "algo:42", Side::Buy, d("1"), d("90000"), grid()).is_err());
        assert!(open_order("BTCUSDT", "algo:42").is_err());
    }

    #[test]
    fn leverage_is_whole_and_within_the_market() {
        assert_eq!(
            leverage("BTCUSDT", d("20"), 125).unwrap(),
            vec![("symbol", "BTCUSDT".into()), ("leverage", "20".into())]
        );
        assert_eq!(leverage("BTCUSDT", d("20.0"), 125).unwrap()[1].1, "20");
        assert!(leverage("BTCUSDT", d("2.5"), 125).is_err());
        assert!(leverage("BTCUSDT", d("0"), 125).is_err());
        assert!(leverage("BTCUSDT", d("126"), 125).is_err());
        assert_eq!(margin_type("BTCUSDT", MarginMode::Cross)[1].1, "CROSSED");
        assert_eq!(
            margin_type("BTCUSDT", MarginMode::Isolated)[1].1,
            "ISOLATED"
        );
    }

    #[test]
    fn a_positions_exit_closes_it_on_the_mark() {
        assert_eq!(
            exit("BTCUSDT", true, Exit::StopLoss, d("80000"), grid(), quote()).unwrap(),
            vec![
                ("algoType", "CONDITIONAL".into()),
                ("symbol", "BTCUSDT".into()),
                ("side", "SELL".into()),
                ("type", "STOP_MARKET".into()),
                ("triggerPrice", "80000".into()),
                ("closePosition", "true".into()),
                ("workingType", "MARK_PRICE".into()),
            ]
        );
        let tp = exit(
            "BTCUSDT",
            false,
            Exit::TakeProfit,
            d("80000"),
            grid(),
            quote(),
        )
        .unwrap();
        assert_eq!(
            (tp[2].1.as_str(), tp[3].1.as_str()),
            ("BUY", "TAKE_PROFIT_MARKET")
        );
        for (long, which, price) in [
            (true, Exit::TakeProfit, "83000"),
            (true, Exit::StopLoss, "83100"),
            (false, Exit::TakeProfit, "83100"),
            (false, Exit::StopLoss, "83000"),
            (true, Exit::StopLoss, "80000.05"),
        ] {
            assert!(
                exit("BTCUSDT", long, which, d(price), grid(), quote()).is_err(),
                "{long} {which:?} {price}"
            );
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
        assert_eq!(
            placed("EXPIRED", "0.2").outcome().unwrap(),
            Outcome::Filled(d("0.2"))
        );
        assert!(matches!(
            placed("EXPIRED", "0").outcome().unwrap_err(),
            VenueError::Rejected(_)
        ));
        assert!(placed("EXPIRED_IN_MATCH", "0").outcome().is_err());
        assert!(placed("REJECTED", "0").outcome().is_err());
        let algo: AlgoPlaced = serde_json::from_value(serde_json::json!({
            "algoId": 2146760, "clientAlgoId": "x", "algoStatus": "NEW"
        }))
        .unwrap();
        assert_eq!(algo.algo_id, 2146760);
    }

    #[test]
    fn the_switch_counts_down_in_ms_and_stops_at_zero() {
        assert_eq!(
            countdown("BTCUSDT", Some(120_000)).unwrap(),
            vec![
                ("symbol", "BTCUSDT".into()),
                ("countdownTime", "120000".into())
            ]
        );
        assert_eq!(countdown("BTCUSDT", None).unwrap()[1].1, "0");
        assert!(countdown("BTCUSDT", Some(1_000)).is_err());
        assert!(countdown("BTCUSDT", Some(7_200_000)).is_err());
    }
}
