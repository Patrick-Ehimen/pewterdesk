//! Turning an [`OrderRequest`] into Hyperliquid's `order` action, and a
//! cancel into its `cancel` action. Pure translation: no keys, no network.
//! The adapter signs exactly the bytes [`Wire::packed`] gives (`agent.rs`)
//! and sends the same value as JSON.
//!
//! Security-relevant - review against `.claude/commands/security-review.md`.
//! What gets signed is decided here, so every field is either a constant or
//! checked: the market against the live list (its asset number comes from
//! there, never from a caller), size against its step, prices against
//! Hyperliquid's rule (five significant figures, `6 - szDecimals` decimals).
//! A request Hyperliquid can't express exactly is refused, not
//! approximated, and a market order is always sent as an IOC limit at the
//! slippage bound, so there's no unbounded market order.
//!
//! The actions are laid out as the official Python SDK's
//! `order_request_to_order_wire`, `order_wires_to_order_action` and
//! `bulk_cancel`: field order matters, because the signature is over the
//! action's MessagePack encoding.

use pewterdesk_core::{Decimal, OrderKind, OrderRequest, Side, TimeInForce, VenueError};
use rust_decimal::RoundingStrategy;
use serde_json::Value;

/// The widest slippage bound a market order may carry: 10%.
pub(crate) const MAX_SLIPPAGE_BPS: u32 = 1000;
/// A perp price has at most this many decimals, less the size's.
const MAX_PRICE_DECIMALS: u32 = 6;
/// And at most this many significant figures, unless it's a whole number.
const MAX_SIG_FIGS: u32 = 5;

/// A value in an action: just what the order and cancel actions need. Maps
/// keep their fields in the order given, which is the order they're signed
/// in.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum Wire {
    Map(Vec<(&'static str, Wire)>),
    List(Vec<Wire>),
    Str(String),
    Bool(bool),
    Uint(u64),
}

impl Wire {
    fn str(s: &str) -> Self {
        Self::Str(s.to_owned())
    }

    /// The MessagePack encoding, as `msgpack.packb` makes it: the smallest
    /// form for each value.
    pub(crate) fn packed(&self) -> Vec<u8> {
        let mut out = Vec::new();
        self.pack(&mut out);
        out
    }

    fn pack(&self, out: &mut Vec<u8>) {
        match self {
            Self::Map(fields) => {
                match fields.len() {
                    n @ 0..=15 => out.push(0x80 | n as u8),
                    n => {
                        out.push(0xde);
                        out.extend((n as u16).to_be_bytes());
                    }
                }
                for (name, value) in fields {
                    Self::pack_str(name, out);
                    value.pack(out);
                }
            }
            Self::List(items) => {
                match items.len() {
                    n @ 0..=15 => out.push(0x90 | n as u8),
                    n => {
                        out.push(0xdc);
                        out.extend((n as u16).to_be_bytes());
                    }
                }
                for item in items {
                    item.pack(out);
                }
            }
            Self::Str(s) => Self::pack_str(s, out),
            Self::Bool(b) => out.push(if *b { 0xc3 } else { 0xc2 }),
            Self::Uint(n) => match *n {
                0..=0x7f => out.push(*n as u8),
                0x80..=0xff => {
                    out.push(0xcc);
                    out.push(*n as u8);
                }
                0x100..=0xffff => {
                    out.push(0xcd);
                    out.extend((*n as u16).to_be_bytes());
                }
                0x1_0000..=0xffff_ffff => {
                    out.push(0xce);
                    out.extend((*n as u32).to_be_bytes());
                }
                _ => {
                    out.push(0xcf);
                    out.extend(n.to_be_bytes());
                }
            },
        }
    }

    fn pack_str(s: &str, out: &mut Vec<u8>) {
        match s.len() {
            n @ 0..=31 => out.push(0xa0 | n as u8),
            n @ 32..=255 => {
                out.push(0xd9);
                out.push(n as u8);
            }
            n => {
                out.push(0xda);
                out.extend((n as u16).to_be_bytes());
            }
        }
        out.extend(s.as_bytes());
    }

    /// The same value as JSON, for the request body.
    pub(crate) fn json(&self) -> Value {
        match self {
            Self::Map(fields) => Value::Object(
                fields
                    .iter()
                    .map(|(name, value)| ((*name).to_owned(), value.json()))
                    .collect(),
            ),
            Self::List(items) => Value::Array(items.iter().map(Self::json).collect()),
            Self::Str(s) => Value::String(s.clone()),
            Self::Bool(b) => Value::Bool(*b),
            Self::Uint(n) => Value::from(*n),
        }
    }
}

/// A market as orders need it: the number Hyperliquid knows it by, and its
/// size decimals. Read from the venue's own list by the adapter.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct Asset {
    pub id: u32,
    pub sz_decimals: u32,
}

/// An order action, and the price its first order goes in at.
#[derive(Debug, PartialEq)]
pub(crate) struct Built {
    pub action: Wire,
    /// The limit price sent: the bound, for a market order.
    pub price: Decimal,
}

fn invalid(msg: &str) -> VenueError {
    VenueError::InvalidRequest(msg.into())
}

/// A decimal as Hyperliquid reads it (and as the SDK's `float_to_wire`
/// writes it): plain digits, no exponent, no trailing zeros.
fn text(d: Decimal) -> String {
    d.0.normalize().to_string()
}

fn zero() -> rust_decimal::Decimal {
    rust_decimal::Decimal::ZERO
}

fn price_decimals(asset: Asset) -> u32 {
    MAX_PRICE_DECIMALS.saturating_sub(asset.sz_decimals)
}

/// A size above zero with no more decimals than the market's.
fn check_size(size: Decimal, asset: Asset) -> Result<(), VenueError> {
    if size.0 <= zero() {
        return Err(invalid("the size must be above zero"));
    }
    if size.0.normalize().scale() > asset.sz_decimals {
        return Err(invalid(&format!(
            "the size has at most {} decimals on this market",
            asset.sz_decimals
        )));
    }
    Ok(())
}

/// A price Hyperliquid takes as it is: above zero, within the market's
/// decimals, and five significant figures at most unless it's whole.
fn check_price(price: Decimal, asset: Asset, what: &str) -> Result<(), VenueError> {
    if price.0 <= zero() {
        return Err(invalid(&format!("the {what} must be above zero")));
    }
    let plain = price.0.normalize();
    if plain.scale() > price_decimals(asset) {
        return Err(invalid(&format!(
            "the {what} has at most {} decimals on this market",
            price_decimals(asset)
        )));
    }
    let figures = plain.mantissa().unsigned_abs().to_string().len() as u32;
    if plain.scale() > 0 && figures > MAX_SIG_FIGS {
        return Err(invalid(&format!(
            "the {what} has at most 5 significant figures on Hyperliquid"
        )));
    }
    Ok(())
}

/// `price` moved `bps` against the taker, then cut to what Hyperliquid
/// takes (five significant figures, the market's decimals) on the inside,
/// so the bound is never looser than asked: down for a buy, up for a sell.
fn slipped(price: Decimal, bps: u32, side: Side, asset: Asset) -> Decimal {
    let one = rust_decimal::Decimal::ONE;
    let ten = rust_decimal::Decimal::TEN;
    let factor = rust_decimal::Decimal::from(bps) / rust_decimal::Decimal::from(10_000);
    let raw = match side {
        Side::Buy => price.0 * (one + factor),
        Side::Sell => price.0 * (one - factor),
    };
    if raw <= zero() {
        return Decimal(zero());
    }
    // Digits before the decimal point (0 or less for a price under 1).
    let mut whole_digits: i64 = 0;
    let mut scaled = raw;
    while scaled >= one {
        scaled /= ten;
        whole_digits += 1;
    }
    while scaled < one / ten {
        scaled *= ten;
        whole_digits -= 1;
    }
    let by_figures = (i64::from(MAX_SIG_FIGS) - whole_digits).max(0);
    let decimals = by_figures.min(i64::from(price_decimals(asset))) as u32;
    let strategy = match side {
        Side::Buy => RoundingStrategy::ToNegativeInfinity,
        Side::Sell => RoundingStrategy::ToPositiveInfinity,
    };
    Decimal(raw.round_dp_with_strategy(decimals, strategy))
}

/// Hyperliquid's client order id: 16 bytes as `0x` hex.
fn client_id(id: &Option<String>) -> Result<Option<String>, VenueError> {
    match id {
        None => Ok(None),
        Some(id)
            if id.len() == 34
                && id.starts_with("0x")
                && id[2..]
                    .bytes()
                    .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)) =>
        {
            Ok(Some(id.clone()))
        }
        Some(_) => Err(invalid(
            "a client order id on Hyperliquid is 0x and 32 lowercase hex characters",
        )),
    }
}

/// One order, as `order_request_to_order_wire` lays it out.
fn order(
    asset: Asset,
    buy: bool,
    price: Decimal,
    size: Decimal,
    reduce_only: bool,
    kind: Wire,
    client_id: Option<String>,
) -> Wire {
    let mut fields = vec![
        ("a", Wire::Uint(u64::from(asset.id))),
        ("b", Wire::Bool(buy)),
        ("p", Wire::Str(text(price))),
        ("s", Wire::Str(text(size))),
        ("r", Wire::Bool(reduce_only)),
        ("t", kind),
    ];
    if let Some(id) = client_id {
        fields.push(("c", Wire::Str(id)));
    }
    Wire::Map(fields)
}

fn limit(tif: &str) -> Wire {
    Wire::Map(vec![("limit", Wire::Map(vec![("tif", Wire::str(tif))]))])
}

/// A trigger: `tpsl` is "tp" or "sl", which is how Hyperliquid tells which
/// way it fires.
fn trigger(market: bool, price: Decimal, tpsl: &str) -> Wire {
    Wire::Map(vec![(
        "trigger",
        Wire::Map(vec![
            ("isMarket", Wire::Bool(market)),
            ("triggerPx", Wire::Str(text(price))),
            ("tpsl", Wire::str(tpsl)),
        ]),
    )])
}

/// The order action for `request` on `asset`, priced off `mid`, the
/// market's mid price now.
pub(crate) fn create(
    request: &OrderRequest,
    asset: Asset,
    mid: Decimal,
) -> Result<Built, VenueError> {
    if request.collateral.is_some() {
        return Err(invalid(
            "Hyperliquid takes margin from the account; an order can't post its own collateral",
        ));
    }
    check_size(request.size, asset)?;
    let buying = request.side == Side::Buy;
    let cloid = client_id(&request.client_id)?;
    let needs_mid = || {
        if mid.0 <= zero() {
            Err(invalid("there's no price for this market right now"))
        } else {
            Ok(())
        }
    };

    let (price, kind) = match &request.kind {
        OrderKind::Market { max_slippage_bps } => {
            if *max_slippage_bps == 0 || *max_slippage_bps > MAX_SLIPPAGE_BPS {
                return Err(invalid(
                    "a market order's slippage bound must be 0.01% to 10%",
                ));
            }
            needs_mid()?;
            let bound = slipped(mid, *max_slippage_bps, request.side, asset);
            if bound.0 <= zero() {
                return Err(invalid("the slippage bound leaves no valid price"));
            }
            (bound, limit("Ioc"))
        }
        OrderKind::Limit {
            price,
            time_in_force,
        } => {
            check_price(*price, asset, "price")?;
            let tif = match time_in_force.unwrap_or(TimeInForce::Gtc) {
                TimeInForce::Gtc => "Gtc",
                TimeInForce::Ioc => "Ioc",
                TimeInForce::PostOnly => "Alo",
            };
            (*price, limit(tif))
        }
        OrderKind::Trigger {
            trigger_price,
            limit_price,
        } => {
            check_price(*trigger_price, asset, "trigger price")?;
            needs_mid()?;
            if *trigger_price == mid {
                return Err(invalid(
                    "the trigger price is the current price; it would fire at once",
                ));
            }
            // A buy above the price, or a sell below it, is a stop; the
            // other way round it waits for a better price, like a take-profit.
            let above = trigger_price.0 > mid.0;
            let tpsl = if above == buying { "sl" } else { "tp" };
            match limit_price {
                Some(limit) => {
                    check_price(*limit, asset, "limit price")?;
                    (*limit, trigger(false, *trigger_price, tpsl))
                }
                // Hyperliquid wants a price on a market trigger too, and
                // bounds the fill itself; the SDK sends the trigger price.
                None => (*trigger_price, trigger(true, *trigger_price, tpsl)),
            }
        }
    };

    let mut orders = vec![order(
        asset,
        buying,
        price,
        request.size,
        request.reduce_only,
        kind,
        cloid,
    )];
    let exits = exits(request, asset, price)?;
    let grouping = if exits.is_empty() { "na" } else { "normalTpsl" };
    orders.extend(exits);
    Ok(Built {
        action: Wire::Map(vec![
            ("type", Wire::str("order")),
            ("orders", Wire::List(orders)),
            ("grouping", Wire::str(grouping)),
        ]),
        price,
    })
}

/// The request's take-profit and stop-loss as orders of their own, grouped
/// with the entry ("normalTpsl"): each on the other side, reduce-only, the
/// entry's size, at market once its price is reached. Each must be on its
/// own side of the price the order goes in at - a take-profit beyond it, a
/// stop-loss behind - or it would fire the moment the order filled.
fn exits(request: &OrderRequest, asset: Asset, entry: Decimal) -> Result<Vec<Wire>, VenueError> {
    if request.take_profit.is_none() && request.stop_loss.is_none() {
        return Ok(Vec::new());
    }
    if request.reduce_only {
        return Err(invalid(
            "a reduce-only order can't carry a take-profit or stop-loss",
        ));
    }
    let buying = request.side == Side::Buy;
    let mut out = Vec::new();
    let exit = |price: Decimal, tpsl: &str| {
        order(
            asset,
            !buying,
            price,
            request.size,
            true,
            trigger(true, price, tpsl),
            None,
        )
    };
    if let Some(tp) = request.take_profit {
        check_price(tp, asset, "take-profit")?;
        if (buying && tp.0 <= entry.0) || (!buying && tp.0 >= entry.0) {
            return Err(invalid(
                "the take-profit must be on the profitable side of the order's price",
            ));
        }
        out.push(exit(tp, "tp"));
    }
    if let Some(sl) = request.stop_loss {
        check_price(sl, asset, "stop-loss")?;
        if (buying && sl.0 >= entry.0) || (!buying && sl.0 <= entry.0) {
            return Err(invalid(
                "the stop-loss must be on the losing side of the order's price",
            ));
        }
        out.push(exit(sl, "sl"));
    }
    Ok(out)
}

/// The cancel action for order `order_id` on `asset`.
pub(crate) fn cancel(asset: Asset, order_id: &str) -> Result<Wire, VenueError> {
    let digits = !order_id.is_empty() && order_id.bytes().all(|b| b.is_ascii_digit());
    let id = digits
        .then(|| order_id.parse::<u64>().ok())
        .flatten()
        .ok_or_else(|| invalid("that isn't a Hyperliquid order id"))?;
    Ok(Wire::Map(vec![
        ("type", Wire::str("cancel")),
        (
            "cancels",
            Wire::List(vec![Wire::Map(vec![
                ("a", Wire::Uint(u64::from(asset.id))),
                ("o", Wire::Uint(id)),
            ])]),
        ),
    ]))
}

/// What the exchange endpoint said about an order action: the new order's
/// id and whether it's resting or already filled, or the venue's refusal.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum Placed {
    Resting(String),
    Filled(String),
    /// Accepted, with no id yet (a trigger waiting on its price).
    Waiting,
}

fn refusal(body: &Value) -> VenueError {
    VenueError::Rejected(
        body["response"]
            .as_str()
            .unwrap_or("the order was refused")
            .to_owned(),
    )
}

fn statuses(body: &Value) -> Result<&Vec<Value>, VenueError> {
    match body["status"].as_str() {
        Some("ok") => body["response"]["data"]["statuses"]
            .as_array()
            .filter(|s| !s.is_empty())
            .ok_or_else(|| VenueError::Network("unexpected exchange response".into())),
        Some("err") => Err(refusal(body)),
        _ => Err(VenueError::Network("unexpected exchange response".into())),
    }
}

/// The first order's outcome. Any order in the action being refused is a
/// refusal: an entry without its exits isn't what was asked for.
pub(crate) fn placed(body: &Value) -> Result<Placed, VenueError> {
    let statuses = statuses(body)?;
    if let Some(error) = statuses.iter().find_map(|s| s["error"].as_str()) {
        return Err(VenueError::Rejected(error.to_owned()));
    }
    let first = &statuses[0];
    let id = |v: &Value| v["oid"].as_u64().map(|n| n.to_string());
    if let Some(id) = id(&first["resting"]) {
        return Ok(Placed::Resting(id));
    }
    if let Some(id) = id(&first["filled"]) {
        return Ok(Placed::Filled(id));
    }
    match first.as_str() {
        Some("waitingForFill" | "waitingForTrigger") => Ok(Placed::Waiting),
        _ => Err(VenueError::Network("unexpected exchange response".into())),
    }
}

/// Whether a cancel went through.
pub(crate) fn cancelled(body: &Value) -> Result<(), VenueError> {
    let statuses = statuses(body)?;
    match statuses.iter().find_map(|s| s["error"].as_str()) {
        Some(error) => Err(VenueError::Rejected(error.to_owned())),
        None => Ok(()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn d(s: &str) -> Decimal {
        Decimal(s.parse().unwrap())
    }

    /// ETH as the SDK's tests number it; four size decimals as on mainnet.
    const ETH: Asset = Asset {
        id: 1,
        sz_decimals: 4,
    };

    fn request(side: Side, size: &str, kind: OrderKind) -> OrderRequest {
        OrderRequest {
            market: "ETH".into(),
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

    fn action(r: &OrderRequest, mid: &str) -> Value {
        create(r, ETH, d(mid)).unwrap().action.json()
    }

    fn hex(bytes: &[u8]) -> String {
        bytes.iter().map(|b| format!("{b:02x}")).collect()
    }

    #[test]
    fn packs_as_msgpack_does() {
        // {"type": "dummy", "num": 100000000000}: the SDK's own dummy action.
        let dummy = Wire::Map(vec![
            ("type", Wire::str("dummy")),
            ("num", Wire::Uint(100_000_000_000)),
        ]);
        assert_eq!(
            hex(&dummy.packed()),
            "82a474797065a564756d6d79a36e756dcf000000174876e800"
        );
        // Each width of integer, a long string and a long list.
        assert_eq!(hex(&Wire::Uint(127).packed()), "7f");
        assert_eq!(hex(&Wire::Uint(128).packed()), "cc80");
        assert_eq!(hex(&Wire::Uint(110_000).packed()), "ce0001adb0");
        assert_eq!(hex(&Wire::Uint(65_535).packed()), "cdffff");
        assert_eq!(hex(&Wire::Bool(true).packed()), "c3");
        assert_eq!(hex(&Wire::str(&"a".repeat(32)).packed()[..2]), "d920");
        assert_eq!(
            hex(&Wire::List(vec![Wire::Bool(false); 16]).packed()[..3]),
            "dc0010"
        );
    }

    #[test]
    fn a_limit_order_is_laid_out_as_the_sdk_lays_it() {
        let built = action(&request(Side::Buy, "100", limit_at("100")), "100");
        assert_eq!(
            built,
            json!({
                "type": "order",
                "orders": [{
                    "a": 1, "b": true, "p": "100", "s": "100", "r": false,
                    "t": { "limit": { "tif": "Gtc" } },
                }],
                "grouping": "na",
            })
        );
        // The field order is the SDK's: a, b, p, s, r, t.
        let Wire::Map(fields) = create(&request(Side::Buy, "100", limit_at("100")), ETH, d("1"))
            .unwrap()
            .action
        else {
            panic!("an action is a map");
        };
        assert_eq!(
            fields.iter().map(|f| f.0).collect::<Vec<_>>(),
            ["type", "orders", "grouping"]
        );
        let Wire::List(orders) = &fields[1].1 else {
            panic!("orders is a list");
        };
        let Wire::Map(order) = &orders[0] else {
            panic!("an order is a map");
        };
        assert_eq!(
            order.iter().map(|f| f.0).collect::<Vec<_>>(),
            ["a", "b", "p", "s", "r", "t"]
        );
    }

    #[test]
    fn a_market_order_is_an_ioc_limit_at_the_bound() {
        let buy = request(
            Side::Buy,
            "0.5",
            OrderKind::Market {
                max_slippage_bps: 100,
            },
        );
        let built = action(&buy, "2345.67");
        // 2345.67 * 1.01 = 2369.1267, cut down to five figures.
        assert_eq!(built["orders"][0]["p"], "2369.1");
        assert_eq!(
            built["orders"][0]["t"],
            json!({ "limit": { "tif": "Ioc" } })
        );
        let sell = request(
            Side::Sell,
            "0.5",
            OrderKind::Market {
                max_slippage_bps: 100,
            },
        );
        // 2322.2133, cut up: never looser than asked.
        assert_eq!(action(&sell, "2345.67")["orders"][0]["p"], "2322.3");
    }

    #[test]
    fn the_bound_keeps_to_the_markets_decimals_and_five_figures() {
        let coarse = Asset {
            id: 7,
            sz_decimals: 0,
        };
        // 0.0123456 * 1.05 = 0.01296288: five figures would be 0.012962,
        // and six decimals allow it.
        assert_eq!(
            slipped(d("0.0123456"), 500, Side::Buy, coarse),
            d("0.012962")
        );
        assert_eq!(
            slipped(d("0.0123456"), 500, Side::Sell, coarse),
            d("0.011729")
        );
        // Two decimals at most on a market with four size decimals.
        assert_eq!(slipped(d("1.23456"), 100, Side::Buy, ETH), d("1.24"));
        // Above 100,000 the price is whole.
        assert_eq!(slipped(d("123456.7"), 100, Side::Buy, ETH), d("124691"));
        assert_eq!(slipped(d("123456.7"), 100, Side::Sell, ETH), d("122223"));
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
            assert!(create(&r, ETH, d("100")).is_err(), "{bps}");
        }
        let r = request(
            Side::Buy,
            "1",
            OrderKind::Market {
                max_slippage_bps: 50,
            },
        );
        assert!(create(&r, ETH, d("0")).is_err());
    }

    #[test]
    fn refuses_what_hyperliquid_cant_take_exactly() {
        let bad = [
            request(Side::Buy, "0", limit_at("100")),
            request(Side::Buy, "-1", limit_at("100")),
            // Five size decimals on a market with four.
            request(Side::Buy, "0.00001", limit_at("100")),
            request(Side::Buy, "1", limit_at("0")),
            // Three price decimals where two are allowed.
            request(Side::Buy, "1", limit_at("1.234")),
            // Six significant figures.
            request(Side::Buy, "1", limit_at("1234.56")),
        ];
        for r in &bad {
            assert!(create(r, ETH, d("100")).is_err(), "{r:?}");
        }
        // A whole number may have more than five figures.
        assert!(create(&request(Side::Buy, "1", limit_at("123456")), ETH, d("1")).is_ok());
        let mut own_margin = request(Side::Buy, "1", limit_at("100"));
        own_margin.collateral = Some(d("50"));
        assert!(create(&own_margin, ETH, d("100")).is_err());
        let mut odd_id = request(Side::Buy, "1", limit_at("100"));
        odd_id.client_id = Some("my-order".into());
        assert!(create(&odd_id, ETH, d("100")).is_err());
    }

    #[test]
    fn time_in_force_maps_to_hyperliquids_names() {
        for (tif, name) in [
            (TimeInForce::Gtc, "Gtc"),
            (TimeInForce::Ioc, "Ioc"),
            (TimeInForce::PostOnly, "Alo"),
        ] {
            let r = request(
                Side::Sell,
                "1",
                OrderKind::Limit {
                    price: d("100"),
                    time_in_force: Some(tif),
                },
            );
            assert_eq!(action(&r, "100")["orders"][0]["t"]["limit"]["tif"], name);
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
        // Price is 100. A buy above it and a sell below it are stops.
        for (side, price, tpsl) in [
            (Side::Buy, "110", "sl"),
            (Side::Sell, "90", "sl"),
            (Side::Buy, "90", "tp"),
            (Side::Sell, "110", "tp"),
        ] {
            let built = action(&trigger(side, price, None), "100");
            assert_eq!(
                built["orders"][0]["t"],
                json!({ "trigger": { "isMarket": true, "triggerPx": price, "tpsl": tpsl } }),
                "{side:?} {price}"
            );
            assert_eq!(built["orders"][0]["p"], price);
        }
        let with_limit = action(&trigger(Side::Buy, "110", Some("111")), "100");
        assert_eq!(with_limit["orders"][0]["p"], "111");
        assert_eq!(with_limit["orders"][0]["t"]["trigger"]["isMarket"], false);
        // At the price, it would fire at once; with no price, it can't be told.
        assert!(create(&trigger(Side::Buy, "100", None), ETH, d("100")).is_err());
        assert!(create(&trigger(Side::Buy, "110", None), ETH, d("0")).is_err());
    }

    #[test]
    fn exits_go_with_the_order_as_reduce_only_orders_the_other_way() {
        let mut r = request(Side::Buy, "2", limit_at("100"));
        r.take_profit = Some(d("120"));
        r.stop_loss = Some(d("90"));
        let built = action(&r, "101");
        assert_eq!(built["grouping"], "normalTpsl");
        assert_eq!(
            built["orders"][1],
            json!({
                "a": 1, "b": false, "p": "120", "s": "2", "r": true,
                "t": { "trigger": { "isMarket": true, "triggerPx": "120", "tpsl": "tp" } },
            })
        );
        assert_eq!(
            built["orders"][2],
            json!({
                "a": 1, "b": false, "p": "90", "s": "2", "r": true,
                "t": { "trigger": { "isMarket": true, "triggerPx": "90", "tpsl": "sl" } },
            })
        );
        // On the wrong side of the entry, or on a reduce-only order: refused.
        let mut wrong = request(Side::Buy, "2", limit_at("100"));
        wrong.take_profit = Some(d("99"));
        assert!(create(&wrong, ETH, d("101")).is_err());
        let mut wrong = request(Side::Sell, "2", limit_at("100"));
        wrong.stop_loss = Some(d("99"));
        assert!(create(&wrong, ETH, d("101")).is_err());
        let mut closing = request(Side::Sell, "2", limit_at("100"));
        closing.reduce_only = true;
        closing.stop_loss = Some(d("110"));
        assert!(create(&closing, ETH, d("101")).is_err());
    }

    #[test]
    fn cancels_name_the_asset_and_the_order() {
        assert_eq!(
            cancel(ETH, "91490942").unwrap().json(),
            json!({ "type": "cancel", "cancels": [{ "a": 1, "o": 91_490_942 }] })
        );
        for bad in ["", "abc", "-1", "1.5", "0x10", "99999999999999999999999"] {
            assert!(cancel(ETH, bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn reads_what_the_exchange_says() {
        let ok = |statuses: Value| json!({ "status": "ok", "response": { "type": "order", "data": { "statuses": statuses } } });
        assert_eq!(
            placed(&ok(json!([{ "resting": { "oid": 77738308 } }]))).unwrap(),
            Placed::Resting("77738308".into())
        );
        assert_eq!(
            placed(&ok(
                json!([{ "filled": { "totalSz": "0.02", "avgPx": "1891.4", "oid": 77747314 } }])
            ))
            .unwrap(),
            Placed::Filled("77747314".into())
        );
        assert_eq!(
            placed(&ok(json!(["waitingForTrigger"]))).unwrap(),
            Placed::Waiting
        );
        // The venue's own words for a refusal, wherever it puts them.
        assert_eq!(
            placed(&ok(
                json!([{ "error": "Order must have minimum value of $10." }])
            ))
            .unwrap_err(),
            VenueError::Rejected("Order must have minimum value of $10.".into())
        );
        assert_eq!(
            placed(&ok(
                json!([{ "resting": { "oid": 1 } }, { "error": "bad exit" }])
            ))
            .unwrap_err(),
            VenueError::Rejected("bad exit".into())
        );
        assert_eq!(
            placed(
                &json!({ "status": "err", "response": "User or API Wallet 0x1 does not exist." })
            )
            .unwrap_err(),
            VenueError::Rejected("User or API Wallet 0x1 does not exist.".into())
        );
        assert!(matches!(
            placed(&json!({ "nope": 1 })).unwrap_err(),
            VenueError::Network(_)
        ));
        assert!(matches!(
            placed(&ok(json!([]))).unwrap_err(),
            VenueError::Network(_)
        ));
        assert!(cancelled(&ok(json!(["success"]))).is_ok());
        assert_eq!(
            cancelled(&ok(
                json!([{ "error": "Order was never placed, already canceled, or filled." }])
            ))
            .unwrap_err(),
            VenueError::Rejected("Order was never placed, already canceled, or filled.".into())
        );
    }
}
