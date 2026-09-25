//! The serde shapes here are the IPC contract with the frontend, so these
//! tests pin the JSON rather than just round-tripping.

use pewterdesk_core::{Decimal, OrderKind, OrderRequest, Side, TimeInForce, VenueId};
use serde_json::{from_value, json, to_value};
use std::str::FromStr;

fn dec(s: &str) -> Decimal {
    Decimal(rust_decimal::Decimal::from_str(s).unwrap())
}

#[test]
fn decimal_is_a_string_on_the_wire() {
    assert_eq!(to_value(dec("0.0015")).unwrap(), json!("0.0015"));
    assert_eq!(
        from_value::<Decimal>(json!("65000.5")).unwrap(),
        dec("65000.5")
    );
}

#[test]
fn decimal_rejects_json_numbers() {
    // A float that went through JS `number` must not become a price.
    assert!(from_value::<Decimal>(json!(0.1)).is_err());
    assert!(from_value::<Decimal>(json!(1)).is_err());
}

#[test]
fn venue_ids_are_lowercase() {
    let ids: Vec<_> = VenueId::ALL.iter().map(|v| to_value(v).unwrap()).collect();
    assert_eq!(
        ids,
        [
            json!("hyperliquid"),
            json!("gmx"),
            json!("dydx"),
            json!("drift")
        ]
    );
}

#[test]
fn limit_order_request_parses_from_frontend_json() {
    let req: OrderRequest = from_value(json!({
        "market": "BTC",
        "side": "buy",
        "size": "0.01",
        "reduceOnly": false,
        "type": "limit",
        "price": "65000",
        "timeInForce": "postOnly",
    }))
    .unwrap();

    assert_eq!(
        req,
        OrderRequest {
            market: "BTC".into(),
            side: Side::Buy,
            size: dec("0.01"),
            reduce_only: false,
            collateral: None,
            client_id: None,
            kind: OrderKind::Limit {
                price: dec("65000"),
                time_in_force: Some(TimeInForce::PostOnly),
            },
        }
    );
}

#[test]
fn market_order_round_trips() {
    let wire = json!({
        "market": "ETH-USD",
        "side": "sell",
        "size": "1.5",
        "reduceOnly": true,
        "clientId": "abc",
        "type": "market",
        "maxSlippageBps": 50,
    });
    let req: OrderRequest = from_value(wire.clone()).unwrap();
    assert_eq!(
        req.kind,
        OrderKind::Market {
            max_slippage_bps: 50
        }
    );
    assert_eq!(to_value(&req).unwrap(), wire);
}

#[test]
fn market_order_without_slippage_bound_is_rejected() {
    let res = from_value::<OrderRequest>(json!({
        "market": "BTC", "side": "buy", "size": "1", "reduceOnly": false, "type": "market",
    }));
    assert!(res.is_err());
}

#[test]
fn unknown_order_type_is_rejected() {
    let res = from_value::<OrderRequest>(json!({
        "market": "BTC", "side": "buy", "size": "1", "reduceOnly": false,
        "type": "withdraw", "to": "0xabc",
    }));
    assert!(res.is_err());
}
