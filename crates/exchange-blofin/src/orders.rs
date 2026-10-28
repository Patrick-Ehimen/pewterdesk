//! Turning an [`OrderRequest`] into the body of BloFin's
//! `POST /api/v1/trade/order` (limit and market orders, with a take-profit
//! and stop-loss attached) or, for a trigger order, `/api/v1/trade/order-algo`;
//! a cancel into `cancel-order`, `cancel-tpsl` or `cancel-algo`; a change to
//! a limit order into `amend-order`; leverage and margin mode into
//! `/api/v1/account/set-leverage` and `set-margin-mode`; and a position's
//! exits into whole-position TP/SL orders (`order-tpsl`, changed with
//! `amend-tpsl`) and a whole-position trailing stop (`order-algo`,
//! `trailing_stop`). Pure translation: no keys, no network. The adapter
//! signs exactly the JSON these give and sends that string.
//!
//! Security-relevant - review against `.claude/commands/security-review.md`.
//! What gets signed is decided here, so every value is either a constant or
//! checked: the market against the live list, the size as a whole number of
//! the market's lots, prices against its tick, the client id and order id
//! against a strict alphabet. A request BloFin can't express exactly is
//! refused, not approximated, and a market order is always sent as an IOC
//! limit at the slippage bound (pulled inside BloFin's price limits, so
//! never looser than asked), so there's no unbounded market order. Every
//! exit is reduce-only and closes the whole position (`size: -1`).
//!
//! Field names and values are BloFin's docs' ("Place Order", "Place TPSL
//! Order", "Place Algo Order", "Cancel ...", "Amend Order", "Amend TP/SL
//! Order", "Set Leverage", "Set Margin Mode"). One-way position mode is
//! assumed (`positionSide: net`); the adapter refuses to trade an account in
//! Hedge Mode, where BloFin ignores `reduceOnly`.

use pewterdesk_core::{
    Decimal, ExitChange, MarginMode, OrderKind, OrderRequest, Side, TimeInForce, VenueError,
};
use rust_decimal::RoundingStrategy;
use serde::Deserialize;
use serde_json::{json, Map, Value};

use crate::wire::{self, Spec};

/// The widest slippage bound a market order may carry: 10%.
pub(crate) const MAX_SLIPPAGE_BPS: u32 = 1000;
/// BloFin's longest `clientOrderId`.
const CLIENT_ID_MAX: usize = 32;

/// How the adapter hands out ids that aren't ordinary orders'.
pub(crate) const TPSL_PREFIX: &str = "tpsl:";
pub(crate) const ALGO_PREFIX: &str = "algo:";
pub(crate) const TRAIL_PREFIX: &str = "trail:";

/// Where a new order goes: the order endpoint, or the algo endpoint.
#[derive(Debug, PartialEq)]
pub(crate) enum NewOrder {
    Order(Value),
    Algo(Value),
}

/// The touch, for pricing a market order's bound and telling which way a
/// trigger fires, and BloFin's price limits for the order's side, where
/// they were read.
#[derive(Clone, Copy, Debug)]
pub(crate) struct Quote {
    pub bid: Decimal,
    pub ask: Decimal,
    /// The lowest and highest price BloFin takes now (`order/price-range`).
    pub range: Option<(Decimal, Decimal)>,
}

fn invalid(msg: &str) -> VenueError {
    VenueError::InvalidRequest(msg.into())
}

fn zero() -> rust_decimal::Decimal {
    rust_decimal::Decimal::ZERO
}

/// A decimal BloFin reads: plain digits, no exponent, no trailing zeros.
fn text(d: Decimal) -> String {
    d.0.normalize().to_string()
}

fn on_tick(value: Decimal, tick: Decimal, what: &str) -> Result<(), VenueError> {
    if value.0 <= zero() {
        return Err(invalid(&format!("the {what} must be above zero")));
    }
    if tick.0.is_zero() || !(value.0 % tick.0).is_zero() {
        return Err(invalid(&format!(
            "the {what} must be a multiple of {}",
            text(tick)
        )));
    }
    Ok(())
}

fn side(side: Side) -> &'static str {
    match side {
        Side::Buy => "buy",
        Side::Sell => "sell",
    }
}

fn margin(mode: MarginMode) -> &'static str {
    match mode {
        MarginMode::Cross => "cross",
        MarginMode::Isolated => "isolated",
    }
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
/// inside BloFin's price limits where it would be outside them. Only ever
/// tighter.
fn bound(price: Decimal, bps: u32, side: Side, spec: &Spec, quote: &Quote) -> Decimal {
    let factor = rust_decimal::Decimal::from(bps) / rust_decimal::Decimal::from(10_000);
    let slipped = match side {
        Side::Buy => price.0 * (rust_decimal::Decimal::ONE + factor),
        Side::Sell => price.0 * (rust_decimal::Decimal::ONE - factor),
    };
    let mut bound = snap(slipped, side, spec.tick);
    if let Some((low, high)) = quote.range.filter(|(l, h)| l.0 > zero() && h.0 >= l.0) {
        bound = match side {
            Side::Buy => bound.min(snap(high.0, Side::Buy, spec.tick)),
            Side::Sell => bound.max(snap(low.0, Side::Sell, spec.tick)),
        };
    }
    Decimal(bound)
}

/// The id BloFin is sent for `id`: the router's `0x` + 32 hex goes without
/// its `0x` (BloFin takes 32 letters and digits at most); any other id must
/// be up to 32 letters and digits already. [`client_id_back`] undoes it.
pub(crate) fn client_id(id: &Option<String>) -> Result<Option<String>, VenueError> {
    let Some(id) = id else { return Ok(None) };
    let sent = match id.strip_prefix("0x") {
        Some(hex) if hex.len() == CLIENT_ID_MAX && hex.bytes().all(|b| b.is_ascii_hexdigit()) => {
            hex
        }
        _ => id.as_str(),
    };
    if !sent.is_empty()
        && sent.len() <= CLIENT_ID_MAX
        && sent.bytes().all(|b| b.is_ascii_alphanumeric())
    {
        Ok(Some(sent.to_owned()))
    } else {
        Err(invalid("a client order id is up to 32 letters and digits"))
    }
}

/// A client id as BloFin lists it, as the caller gave it: 32 lowercase hex
/// is the router's, sent without its `0x`.
pub(crate) fn client_id_back(sent: &str) -> Option<String> {
    let sent = sent.trim();
    if sent.is_empty() {
        None
    } else if sent.len() == CLIENT_ID_MAX
        && sent
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
    {
        Some(format!("0x{sent}"))
    } else {
        Some(sent.to_owned())
    }
}

fn touch(quote: &Quote, what: &str) -> Result<(), VenueError> {
    if quote.bid.0 <= zero() || quote.ask.0 <= zero() || quote.bid.0 > quote.ask.0 {
        Err(invalid(&format!("there's no price to {what}")))
    } else {
        Ok(())
    }
}

/// The attached take-profit and stop-loss, checked against `reference`
/// (where the order would fill): each on its own side of it, on the tick.
fn attached(
    request: &OrderRequest,
    reference: Decimal,
    spec: &Spec,
) -> Result<Vec<(&'static str, String)>, VenueError> {
    let (tp, sl) = (request.take_profit, request.stop_loss);
    if tp.is_none() && sl.is_none() {
        return Ok(Vec::new());
    }
    if request.reduce_only {
        return Err(invalid(
            "a take-profit or stop-loss goes with an order that opens a position, not a reduce-only one",
        ));
    }
    let buying = request.side == Side::Buy;
    let mut fields = Vec::new();
    if let Some(tp) = tp {
        on_tick(tp, spec.tick, "take-profit")?;
        if (buying && tp.0 <= reference.0) || (!buying && tp.0 >= reference.0) {
            return Err(invalid(
                "the take-profit must be on the profitable side of the order's price",
            ));
        }
        fields.push(("tpTriggerPrice", text(tp)));
        fields.push(("tpOrderPrice", "-1".into()));
        fields.push(("tpTriggerPriceType", "mark".into()));
    }
    if let Some(sl) = sl {
        on_tick(sl, spec.tick, "stop-loss")?;
        if (buying && sl.0 >= reference.0) || (!buying && sl.0 <= reference.0) {
            return Err(invalid(
                "the stop-loss must be on the losing side of the order's price",
            ));
        }
        fields.push(("slTriggerPrice", text(sl)));
        fields.push(("slOrderPrice", "-1".into()));
        fields.push(("slTriggerPriceType", "mark".into()));
    }
    Ok(fields)
}

fn object(fields: Vec<(&'static str, String)>) -> Value {
    Value::Object(
        fields
            .into_iter()
            .map(|(k, v)| (k.to_owned(), Value::String(v)))
            .collect::<Map<_, _>>(),
    )
}

/// The new-order body for `request` on a market with this `spec`, priced off
/// `quote`, in the account's `mode`. `request.market` must already be a live
/// market's id.
pub(crate) fn create(
    request: &OrderRequest,
    spec: &Spec,
    quote: &Quote,
    mode: MarginMode,
) -> Result<NewOrder, VenueError> {
    wire::validate_market(&request.market)?;
    if request.collateral.is_some() {
        return Err(invalid(
            "BloFin takes margin from the account; an order can't post its own collateral",
        ));
    }
    let contracts = spec.contracts(request.size)?;
    let id = client_id(&request.client_id)?;
    let buying = request.side == Side::Buy;

    let mut fields: Vec<(&'static str, String)> = vec![
        ("instId", request.market.clone()),
        ("marginMode", margin(mode).into()),
        ("positionSide", "net".into()),
        ("side", side(request.side).into()),
    ];
    let algo = match &request.kind {
        OrderKind::Twap { .. } => return Err(VenueError::Unsupported("a venue-run TWAP")),
        OrderKind::Market { max_slippage_bps } => {
            if *max_slippage_bps == 0 || *max_slippage_bps > MAX_SLIPPAGE_BPS {
                return Err(invalid(
                    "a market order's slippage bound must be 0.01% to 10%",
                ));
            }
            touch(quote, "bound a market order by")?;
            let from = if buying { quote.ask } else { quote.bid };
            let bound = bound(from, *max_slippage_bps, request.side, spec, quote);
            if bound.0 <= zero() {
                return Err(invalid("the slippage bound leaves no valid price"));
            }
            fields.push(("orderType", "ioc".into()));
            fields.push(("price", text(bound)));
            fields.push(("size", text(contracts)));
            fields.extend(attached(request, from, spec)?);
            false
        }
        OrderKind::Limit {
            price,
            time_in_force,
        } => {
            on_tick(*price, spec.tick, "price")?;
            let kind = match time_in_force.unwrap_or(TimeInForce::Gtc) {
                TimeInForce::Gtc => "limit",
                TimeInForce::Ioc => "ioc",
                TimeInForce::PostOnly => "post_only",
            };
            fields.push(("orderType", kind.into()));
            fields.push(("price", text(*price)));
            fields.push(("size", text(contracts)));
            fields.extend(attached(request, *price, spec)?);
            false
        }
        OrderKind::Trigger {
            trigger_price,
            limit_price,
        } => {
            if request.take_profit.is_some() || request.stop_loss.is_some() {
                return Err(invalid(
                    "BloFin doesn't take a take-profit or stop-loss with a trigger order here; set it on the position once it's open",
                ));
            }
            on_tick(*trigger_price, spec.tick, "trigger price")?;
            touch(quote, "place a trigger against")?;
            if trigger_price.0 >= quote.bid.0 && trigger_price.0 <= quote.ask.0 {
                return Err(invalid(
                    "the trigger price is at the current price; it would fire at once",
                ));
            }
            let order_price = match limit_price {
                Some(limit) => {
                    on_tick(*limit, spec.tick, "limit price")?;
                    text(*limit)
                }
                None => "-1".into(),
            };
            fields.push(("orderType", "trigger".into()));
            fields.push(("size", text(contracts)));
            fields.push(("triggerPrice", text(*trigger_price)));
            fields.push(("triggerPriceType", "last".into()));
            fields.push(("orderPrice", order_price));
            true
        }
    };
    if request.reduce_only {
        fields.push(("reduceOnly", "true".into()));
    }
    if let Some(id) = id {
        fields.push(("clientOrderId", id));
    }
    let body = object(fields);
    Ok(if algo {
        NewOrder::Algo(body)
    } else {
        NewOrder::Order(body)
    })
}

/// Digits only: a BloFin order, TP/SL or algo id.
fn digits(id: &str) -> Result<String, VenueError> {
    let ok = !id.is_empty() && id.len() <= 24 && id.bytes().all(|b| b.is_ascii_digit());
    if ok {
        Ok(id.to_owned())
    } else {
        Err(invalid("that isn't a BloFin order id"))
    }
}

/// An order id as the adapter hands them out.
#[derive(Debug, PartialEq, Eq)]
pub(crate) enum OrderId {
    Order(String),
    Tpsl(String),
    Algo(String),
    Trailing(String),
}

pub(crate) fn order_id(id: &str) -> Result<OrderId, VenueError> {
    if let Some(rest) = id.strip_prefix(TPSL_PREFIX) {
        Ok(OrderId::Tpsl(digits(rest)?))
    } else if let Some(rest) = id.strip_prefix(ALGO_PREFIX) {
        Ok(OrderId::Algo(digits(rest)?))
    } else if let Some(rest) = id.strip_prefix(TRAIL_PREFIX) {
        Ok(OrderId::Trailing(digits(rest)?))
    } else {
        Ok(OrderId::Order(digits(id)?))
    }
}

/// The path and body that cancel order `id` on `market`, wherever it lives.
pub(crate) fn cancel(market: &str, id: &str) -> Result<(&'static str, Value), VenueError> {
    wire::validate_market(market)?;
    Ok(match order_id(id)? {
        OrderId::Order(id) => (
            "/api/v1/trade/cancel-order",
            json!({"instId": market, "orderId": id}),
        ),
        // BloFin takes TP/SL cancels as a list.
        OrderId::Tpsl(id) => (
            "/api/v1/trade/cancel-tpsl",
            json!([{"instId": market, "tpslId": id}]),
        ),
        OrderId::Algo(id) => (
            "/api/v1/trade/cancel-algo",
            json!({"instId": market, "algoId": id, "orderType": "trigger"}),
        ),
        OrderId::Trailing(id) => (
            "/api/v1/trade/cancel-algo",
            json!({"instId": market, "algoId": id, "orderType": "trailing_stop"}),
        ),
    })
}

/// A TP or SL change as `amend-order` and `amend-tpsl` take it: a new
/// trigger at market, or `0` to remove it.
fn exit_fields(
    leg: &'static str,
    change: &ExitChange,
    spec: &Spec,
    fields: &mut Vec<(&'static str, String)>,
) -> Result<(), VenueError> {
    let (trigger, order, kind) = match leg {
        "tp" => (
            "newTpTriggerPrice",
            "newTpOrderPrice",
            "newTpTriggerPriceType",
        ),
        _ => (
            "newSlTriggerPrice",
            "newSlOrderPrice",
            "newSlTriggerPriceType",
        ),
    };
    match change {
        ExitChange::Keep => {}
        ExitChange::Remove => fields.push((trigger, "0".into())),
        ExitChange::Set(price) => {
            on_tick(
                *price,
                spec.tick,
                if leg == "tp" {
                    "take-profit"
                } else {
                    "stop-loss"
                },
            )?;
            fields.push((trigger, text(*price)));
            fields.push((order, "-1".into()));
            fields.push((kind, "mark".into()));
        }
    }
    Ok(())
}

/// The body of `amend-order`: a limit order's size (all of it, in base
/// units), price, and attached TP and SL. What's left out is kept.
pub(crate) fn amend(
    market: &str,
    order_id: &str,
    size: Option<Decimal>,
    price: Option<Decimal>,
    take_profit: &ExitChange,
    stop_loss: &ExitChange,
    spec: &Spec,
) -> Result<Value, VenueError> {
    wire::validate_market(market)?;
    let OrderId::Order(id) = self::order_id(order_id)? else {
        return Err(invalid(
            "only a limit order can be changed on BloFin; cancel this one and place another",
        ));
    };
    let mut fields: Vec<(&'static str, String)> =
        vec![("instId", market.to_owned()), ("orderId", id)];
    if let Some(price) = price {
        on_tick(price, spec.tick, "price")?;
        fields.push(("newPrice", text(price)));
    }
    if let Some(size) = size {
        fields.push(("newSize", text(spec.contracts(size)?)));
    }
    exit_fields("tp", take_profit, spec, &mut fields)?;
    exit_fields("sl", stop_loss, spec, &mut fields)?;
    if fields.len() == 2 {
        return Err(invalid("there's nothing to change"));
    }
    Ok(object(fields))
}

/// The body of `set-leverage`: a whole number from 1 to the market's
/// highest, in the account's margin mode.
pub(crate) fn leverage(
    market: &str,
    leverage: Decimal,
    max: u32,
    mode: MarginMode,
) -> Result<Value, VenueError> {
    wire::validate_market(market)?;
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
    Ok(object(vec![
        ("instId", market.to_owned()),
        ("leverage", value.to_string()),
        ("marginMode", margin(mode).into()),
    ]))
}

/// The body of `set-margin-mode`, which is account-wide on BloFin.
pub(crate) fn margin_mode(mode: MarginMode) -> Value {
    object(vec![("marginMode", margin(mode).into())])
}

/// Checks a position's exit against the touch now: a take-profit on the
/// profitable side, a stop-loss on the losing side, or it would fire at once.
fn exit_side(long: bool, tp: bool, price: Decimal, quote: &Quote) -> Result<(), VenueError> {
    touch(quote, "check an exit against")?;
    let wrong = match (tp, long) {
        (true, true) => price.0 <= quote.ask.0,
        (true, false) => price.0 >= quote.bid.0,
        (false, true) => price.0 >= quote.bid.0,
        (false, false) => price.0 <= quote.ask.0,
    };
    if wrong {
        Err(invalid(if tp {
            "the take-profit must be on the profitable side of the price now"
        } else {
            "the stop-loss must be on the losing side of the price now"
        }))
    } else {
        Ok(())
    }
}

/// The body of `order-tpsl` for a position's exits: reduce-only, closing the
/// whole position (`size: -1`) at market once the mark reaches the trigger.
/// At least one of `take_profit` and `stop_loss`.
pub(crate) fn position_tpsl(
    market: &str,
    mode: MarginMode,
    long: bool,
    take_profit: Option<Decimal>,
    stop_loss: Option<Decimal>,
    spec: &Spec,
    quote: &Quote,
) -> Result<Value, VenueError> {
    wire::validate_market(market)?;
    if take_profit.is_none() && stop_loss.is_none() {
        return Err(invalid("there's no exit to set"));
    }
    let mut fields: Vec<(&'static str, String)> = vec![
        ("instId", market.to_owned()),
        ("marginMode", margin(mode).into()),
        ("positionSide", "net".into()),
        ("side", if long { "sell" } else { "buy" }.into()),
    ];
    if let Some(tp) = take_profit {
        on_tick(tp, spec.tick, "take-profit")?;
        exit_side(long, true, tp, quote)?;
        fields.push(("tpTriggerPrice", text(tp)));
        fields.push(("tpOrderPrice", "-1".into()));
        fields.push(("tpTriggerPriceType", "mark".into()));
    }
    if let Some(sl) = stop_loss {
        on_tick(sl, spec.tick, "stop-loss")?;
        exit_side(long, false, sl, quote)?;
        fields.push(("slTriggerPrice", text(sl)));
        fields.push(("slOrderPrice", "-1".into()));
        fields.push(("slTriggerPriceType", "mark".into()));
    }
    fields.push(("size", "-1".into()));
    fields.push(("reduceOnly", "true".into()));
    Ok(object(fields))
}

/// The body of `amend-tpsl`: one whole-position TP/SL order's legs, each
/// kept, removed (`0`) or moved, checked against the touch now.
pub(crate) fn amend_position_tpsl(
    market: &str,
    tpsl_id: &str,
    long: bool,
    take_profit: &ExitChange,
    stop_loss: &ExitChange,
    spec: &Spec,
    quote: &Quote,
) -> Result<Value, VenueError> {
    wire::validate_market(market)?;
    let mut fields: Vec<(&'static str, String)> =
        vec![("instId", market.to_owned()), ("tpslId", digits(tpsl_id)?)];
    if let ExitChange::Set(tp) = take_profit {
        exit_side(long, true, *tp, quote)?;
    }
    if let ExitChange::Set(sl) = stop_loss {
        exit_side(long, false, *sl, quote)?;
    }
    exit_fields("tp", take_profit, spec, &mut fields)?;
    exit_fields("sl", stop_loss, spec, &mut fields)?;
    if fields.len() == 2 {
        return Err(invalid("there's nothing to change"));
    }
    Ok(object(fields))
}

/// The body of `order-algo` for a position's trailing stop: reduce-only,
/// the whole position (`size: -1`), following the best price at `distance`
/// (BloFin's `callbackSpread`, an absolute price distance, 0.1% to 100% of
/// the last price), from `activation` if given.
pub(crate) fn trailing_stop(
    market: &str,
    mode: MarginMode,
    long: bool,
    distance: Decimal,
    activation: Option<Decimal>,
    spec: &Spec,
    last: Decimal,
) -> Result<Value, VenueError> {
    wire::validate_market(market)?;
    on_tick(distance, spec.tick, "trailing distance")?;
    if last.0 <= zero() {
        return Err(invalid("there's no price for this market right now"));
    }
    let thousandth = last.0 / rust_decimal::Decimal::from(1000);
    if distance.0 < thousandth || distance.0 > last.0 {
        return Err(invalid(
            "the trailing distance must be between 0.1% and 100% of the price",
        ));
    }
    let mut fields: Vec<(&'static str, String)> = vec![
        ("instId", market.to_owned()),
        ("marginMode", margin(mode).into()),
        ("positionSide", "net".into()),
        ("side", if long { "sell" } else { "buy" }.into()),
        ("orderType", "trailing_stop".into()),
        ("size", "-1".into()),
        ("callbackSpread", text(distance)),
    ];
    if let Some(at) = activation {
        on_tick(at, spec.tick, "activation price")?;
        fields.push(("activePrice", text(at)));
    }
    fields.push(("reduceOnly", "true".into()));
    Ok(object(fields))
}

/// One item of BloFin's answer to a write: its own `code` and `msg`, and the
/// id it names.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Ack {
    #[serde(default, deserialize_with = "wire::text")]
    pub code: String,
    #[serde(default, deserialize_with = "wire::text")]
    pub msg: String,
    #[serde(default, deserialize_with = "wire::text")]
    pub order_id: String,
    #[serde(default, deserialize_with = "wire::text")]
    pub algo_id: String,
}

/// The acknowledgements in a write's `data` (an object or a list), each
/// checked: BloFin can answer `code: 0` on the envelope and refuse inside.
pub(crate) fn acks(data: Value) -> Result<Vec<Ack>, VenueError> {
    let items = match data {
        Value::Array(items) => items,
        Value::Null => Vec::new(),
        other => vec![other],
    };
    let mut out = Vec::with_capacity(items.len());
    for item in items {
        let ack: Ack = serde_json::from_value(item)
            .map_err(|e| VenueError::Network(format!("unexpected BloFin response: {e}")))?;
        if !ack.code.is_empty() && ack.code != "0" {
            return Err(crate::auth::api_error(&ack.code, ack.msg));
        }
        out.push(ack);
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn d(s: &str) -> Decimal {
        Decimal(s.parse().unwrap())
    }

    /// BTC-USDT's: 0.001 BTC a contract, lots of 0.1 contracts, tick 0.1.
    fn spec() -> Spec {
        Spec {
            contract_value: d("0.001"),
            tick: d("0.1"),
            lot: d("0.1"),
            min_contracts: d("0.1"),
            max_leverage: 150,
        }
    }

    fn quote() -> Quote {
        Quote {
            bid: d("80239.8"),
            ask: d("80240.1"),
            range: None,
        }
    }

    fn request(side: Side, size: &str, kind: OrderKind) -> OrderRequest {
        OrderRequest {
            market: "BTC-USDT".into(),
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

    fn sent(r: &OrderRequest) -> (bool, Value) {
        match create(r, &spec(), &quote(), MarginMode::Cross).unwrap() {
            NewOrder::Order(b) => (false, b),
            NewOrder::Algo(b) => (true, b),
        }
    }

    #[test]
    fn a_limit_order_is_what_the_docs_example_sends() {
        let (algo, body) = sent(&request(Side::Buy, "0.0001", limit_at("35000")));
        assert!(!algo);
        assert_eq!(
            body,
            json!({"instId":"BTC-USDT","marginMode":"cross","positionSide":"net","side":"buy","orderType":"limit","price":"35000","size":"0.1"})
        );
        for (tif, name) in [
            (TimeInForce::Gtc, "limit"),
            (TimeInForce::Ioc, "ioc"),
            (TimeInForce::PostOnly, "post_only"),
        ] {
            let r = request(
                Side::Sell,
                "1",
                OrderKind::Limit {
                    price: d("90000"),
                    time_in_force: Some(tif),
                },
            );
            let body = sent(&r).1;
            assert_eq!(body["orderType"], name);
            assert_eq!(body["size"], "1000");
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
        // 80240.1 * 1.01 = 81042.501, snapped down to the tick.
        let buy = sent(&market(Side::Buy)).1;
        assert_eq!(
            (buy["orderType"].as_str(), buy["price"].as_str()),
            (Some("ioc"), Some("81042.5"))
        );
        assert_eq!(buy["size"], "500");
        // 80239.8 * 0.99 = 79437.402, snapped up: never looser than asked.
        assert_eq!(sent(&market(Side::Sell)).1["price"], "79437.5");
    }

    #[test]
    fn the_bound_stays_inside_blofins_limits() {
        let limited = Quote {
            range: Some((d("79000.05"), d("80500.07"))),
            ..quote()
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
        let price =
            |side| match create(&market(side), &spec(), &limited, MarginMode::Cross).unwrap() {
                NewOrder::Order(b) => b["price"].as_str().unwrap().to_owned(),
                NewOrder::Algo(_) => unreachable!(),
            };
        assert_eq!(price(Side::Buy), "80500");
        assert_eq!(price(Side::Sell), "79000.1");
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
            assert!(
                create(&r, &spec(), &quote(), MarginMode::Cross).is_err(),
                "{bps}"
            );
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
                range: None,
            };
            assert!(
                create(&r, &spec(), &empty, MarginMode::Cross).is_err(),
                "{bid}/{ask}"
            );
        }
    }

    #[test]
    fn an_attached_tp_and_sl_go_at_market_on_the_mark() {
        let mut r = request(Side::Buy, "0.01", limit_at("80000"));
        r.take_profit = Some(d("90000"));
        r.stop_loss = Some(d("75000"));
        let body = sent(&r).1;
        assert_eq!(body["tpTriggerPrice"], "90000");
        assert_eq!(body["tpOrderPrice"], "-1");
        assert_eq!(body["slTriggerPrice"], "75000");
        assert_eq!(body["slTriggerPriceType"], "mark");
        // On the wrong side of the order's price, or off the tick.
        for (tp, sl) in [
            (Some("79000"), None),
            (None, Some("81000")),
            (Some("90000.05"), None),
        ] {
            let mut r = request(Side::Buy, "0.01", limit_at("80000"));
            r.take_profit = tp.map(d);
            r.stop_loss = sl.map(d);
            assert!(
                create(&r, &spec(), &quote(), MarginMode::Cross).is_err(),
                "{tp:?} {sl:?}"
            );
        }
        let mut reducing = request(Side::Sell, "0.01", limit_at("80000"));
        reducing.reduce_only = true;
        reducing.stop_loss = Some(d("85000"));
        assert!(create(&reducing, &spec(), &quote(), MarginMode::Cross).is_err());
    }

    #[test]
    fn triggers_go_to_the_algo_endpoint() {
        let mut r = request(
            Side::Buy,
            "0.01",
            OrderKind::Trigger {
                trigger_price: d("84000"),
                limit_price: None,
            },
        );
        r.reduce_only = true;
        r.client_id = Some("0x00000000000000010000000000000002".into());
        let (algo, body) = sent(&r);
        assert!(algo);
        assert_eq!(
            body,
            json!({"instId":"BTC-USDT","marginMode":"cross","positionSide":"net","side":"buy",
                   "orderType":"trigger","size":"10","triggerPrice":"84000","triggerPriceType":"last",
                   "orderPrice":"-1","reduceOnly":"true","clientOrderId":"00000000000000010000000000000002"})
        );
        let limit = request(
            Side::Sell,
            "0.01",
            OrderKind::Trigger {
                trigger_price: d("75000"),
                limit_price: Some(d("74990")),
            },
        );
        assert_eq!(sent(&limit).1["orderPrice"], "74990");
        for at in ["80239.8", "80240", "80240.1"] {
            let r = request(
                Side::Buy,
                "1",
                OrderKind::Trigger {
                    trigger_price: d(at),
                    limit_price: None,
                },
            );
            assert!(
                create(&r, &spec(), &quote(), MarginMode::Cross).is_err(),
                "{at}"
            );
        }
    }

    #[test]
    fn refuses_what_blofin_cant_take_exactly() {
        let bad = [
            request(Side::Buy, "0", limit_at("80000")),
            request(Side::Buy, "-1", limit_at("80000")),
            // Not a whole lot, off the tick, no price.
            request(Side::Buy, "0.00015", limit_at("80000")),
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
            assert!(
                create(r, &spec(), &quote(), MarginMode::Cross).is_err(),
                "{r:?}"
            );
        }
        let mut own_margin = request(Side::Buy, "1", limit_at("80000"));
        own_margin.collateral = Some(d("50"));
        assert!(create(&own_margin, &spec(), &quote(), MarginMode::Cross).is_err());
        for id in [
            "",
            "has space",
            "a-b",
            "a_b",
            "a&b=c",
            &"x".repeat(33),
            // Too long to be the router's `0x` + 32 hex, and too long as it is.
            &format!("0x{}", "a".repeat(33)),
        ] {
            let mut r = request(Side::Buy, "1", limit_at("80000"));
            r.client_id = Some(id.into());
            assert!(
                create(&r, &spec(), &quote(), MarginMode::Cross).is_err(),
                "{id}"
            );
        }
        let mut other_market = request(Side::Buy, "1", limit_at("80000"));
        other_market.market = "BTC-USDT\",\"x\":\"1".into();
        assert!(create(&other_market, &spec(), &quote(), MarginMode::Cross).is_err());
    }

    #[test]
    fn the_routers_client_ids_round_trip() {
        let id = "0x00000000000000010000000000000002".to_owned();
        let sent = client_id(&Some(id.clone())).unwrap().unwrap();
        assert_eq!(sent.len(), 32);
        assert_eq!(client_id_back(&sent), Some(id));
        assert_eq!(
            client_id(&Some("mine1".into())).unwrap(),
            Some("mine1".into())
        );
        assert_eq!(client_id_back("mine1"), Some("mine1".into()));
        assert_eq!(client_id_back(""), None);
    }

    #[test]
    fn isolated_accounts_say_so() {
        let r = request(Side::Buy, "1", limit_at("80000"));
        let NewOrder::Order(body) = create(&r, &spec(), &quote(), MarginMode::Isolated).unwrap()
        else {
            unreachable!()
        };
        assert_eq!(body["marginMode"], "isolated");
    }

    #[test]
    fn cancels_go_where_the_order_lives() {
        assert_eq!(
            cancel("BTC-USDT", "1000019027199").unwrap(),
            (
                "/api/v1/trade/cancel-order",
                json!({"instId":"BTC-USDT","orderId":"1000019027199"})
            )
        );
        assert_eq!(
            cancel("BTC-USDT", "tpsl:2411").unwrap(),
            (
                "/api/v1/trade/cancel-tpsl",
                json!([{"instId":"BTC-USDT","tpslId":"2411"}])
            )
        );
        assert_eq!(
            cancel("BTC-USDT", "algo:2101").unwrap().1["orderType"],
            "trigger"
        );
        assert_eq!(
            cancel("BTC-USDT", "trail:2101").unwrap().1["orderType"],
            "trailing_stop"
        );
        for bad in [
            "",
            "abc",
            "-1",
            "1.5",
            "1&x=2",
            &"9".repeat(25),
            "algo:",
            "tpsl:x",
            "algo:algo:1",
        ] {
            assert!(cancel("BTC-USDT", bad).is_err(), "{bad}");
        }
        assert!(cancel("btc", "1").is_err());
    }

    #[test]
    fn a_change_sends_only_what_changes() {
        let body = amend(
            "BTC-USDT",
            "42",
            Some(d("0.25")),
            Some(d("90000.5")),
            &ExitChange::Set(d("95000")),
            &ExitChange::Remove,
            &spec(),
        )
        .unwrap();
        assert_eq!(
            body,
            json!({"instId":"BTC-USDT","orderId":"42","newPrice":"90000.5","newSize":"250",
                   "newTpTriggerPrice":"95000","newTpOrderPrice":"-1","newTpTriggerPriceType":"mark",
                   "newSlTriggerPrice":"0"})
        );
        let keep = ExitChange::Keep;
        assert!(amend("BTC-USDT", "42", None, None, &keep, &keep, &spec()).is_err());
        assert!(amend(
            "BTC-USDT",
            "42",
            Some(d("0.00015")),
            None,
            &keep,
            &keep,
            &spec()
        )
        .is_err());
        assert!(amend(
            "BTC-USDT",
            "42",
            None,
            Some(d("1.05")),
            &keep,
            &keep,
            &spec()
        )
        .is_err());
        assert!(amend(
            "BTC-USDT",
            "algo:42",
            None,
            Some(d("1")),
            &keep,
            &keep,
            &spec()
        )
        .is_err());
    }

    #[test]
    fn leverage_is_whole_and_within_the_market() {
        assert_eq!(
            leverage("BTC-USDT", d("20"), 150, MarginMode::Cross).unwrap(),
            json!({"instId":"BTC-USDT","leverage":"20","marginMode":"cross"})
        );
        assert_eq!(
            leverage("BTC-USDT", d("20.0"), 150, MarginMode::Cross).unwrap()["leverage"],
            "20"
        );
        for bad in ["2.5", "0", "151"] {
            assert!(
                leverage("BTC-USDT", d(bad), 150, MarginMode::Cross).is_err(),
                "{bad}"
            );
        }
        assert_eq!(
            margin_mode(MarginMode::Isolated),
            json!({"marginMode":"isolated"})
        );
    }

    #[test]
    fn a_positions_exits_close_all_of_it() {
        assert_eq!(
            position_tpsl(
                "BTC-USDT",
                MarginMode::Cross,
                true,
                Some(d("90000")),
                Some(d("75000")),
                &spec(),
                &quote()
            )
            .unwrap(),
            json!({"instId":"BTC-USDT","marginMode":"cross","positionSide":"net","side":"sell",
                   "tpTriggerPrice":"90000","tpOrderPrice":"-1","tpTriggerPriceType":"mark",
                   "slTriggerPrice":"75000","slOrderPrice":"-1","slTriggerPriceType":"mark",
                   "size":"-1","reduceOnly":"true"})
        );
        let short = position_tpsl(
            "BTC-USDT",
            MarginMode::Cross,
            false,
            None,
            Some(d("85000")),
            &spec(),
            &quote(),
        )
        .unwrap();
        assert_eq!(
            (short["side"].as_str(), short.get("tpTriggerPrice")),
            (Some("buy"), None)
        );
        for (long, tp, sl) in [
            (true, Some("80000"), None),
            (true, None, Some("80300")),
            (false, Some("80300"), None),
            (false, None, Some("80000")),
            (true, None, None),
        ] {
            assert!(
                position_tpsl(
                    "BTC-USDT",
                    MarginMode::Cross,
                    long,
                    tp.map(d),
                    sl.map(d),
                    &spec(),
                    &quote()
                )
                .is_err(),
                "{long} {tp:?} {sl:?}"
            );
        }
    }

    #[test]
    fn a_positions_exits_are_amended_leg_by_leg() {
        let body = amend_position_tpsl(
            "BTC-USDT",
            "2411",
            true,
            &ExitChange::Keep,
            &ExitChange::Set(d("76000")),
            &spec(),
            &quote(),
        )
        .unwrap();
        assert_eq!(
            body,
            json!({"instId":"BTC-USDT","tpslId":"2411","newSlTriggerPrice":"76000",
                   "newSlOrderPrice":"-1","newSlTriggerPriceType":"mark"})
        );
        let removed = amend_position_tpsl(
            "BTC-USDT",
            "2411",
            true,
            &ExitChange::Remove,
            &ExitChange::Keep,
            &spec(),
            &quote(),
        )
        .unwrap();
        assert_eq!(removed["newTpTriggerPrice"], "0");
        assert!(amend_position_tpsl(
            "BTC-USDT",
            "2411",
            true,
            &ExitChange::Set(d("80000")),
            &ExitChange::Keep,
            &spec(),
            &quote()
        )
        .is_err());
        assert!(amend_position_tpsl(
            "BTC-USDT",
            "x",
            true,
            &ExitChange::Remove,
            &ExitChange::Keep,
            &spec(),
            &quote()
        )
        .is_err());
    }

    #[test]
    fn a_trailing_stop_follows_by_distance() {
        assert_eq!(
            trailing_stop(
                "BTC-USDT",
                MarginMode::Cross,
                true,
                d("500"),
                Some(d("82000")),
                &spec(),
                d("80240")
            )
            .unwrap(),
            json!({"instId":"BTC-USDT","marginMode":"cross","positionSide":"net","side":"sell",
                   "orderType":"trailing_stop","size":"-1","callbackSpread":"500","activePrice":"82000",
                   "reduceOnly":"true"})
        );
        // Under 0.1% of the price, over all of it, off the tick.
        for bad in ["50", "90000", "500.05"] {
            assert!(
                trailing_stop(
                    "BTC-USDT",
                    MarginMode::Cross,
                    true,
                    d(bad),
                    None,
                    &spec(),
                    d("80240")
                )
                .is_err(),
                "{bad}"
            );
        }
    }

    #[test]
    fn every_ack_is_checked() {
        let ok = acks(
            json!([{"orderId":"1000019027199","clientOrderId":"","msg":"Order placed","code":"0"}]),
        )
        .unwrap();
        assert_eq!(ok[0].order_id, "1000019027199");
        let tpsl =
            acks(json!({"tpslId":"1012","clientOrderId":null,"code":"0","msg":null})).unwrap();
        assert_eq!(tpsl.len(), 1);
        let refused = acks(
            json!([{"tpslId":"1009","code":"500","msg":"Cancel failed as the order has been filled, triggered, canceled or does not exist."}]),
        );
        assert!(refused.is_err());
        assert!(matches!(
            acks(json!({"code":"103003","msg":"x"})),
            Err(VenueError::Rejected(_))
        ));
    }
}
