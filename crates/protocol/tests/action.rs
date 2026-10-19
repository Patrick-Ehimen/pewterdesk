//! What lines come to, against the app's own expectations
//! (`apps/desktop/tests/commands.test.ts`, `cli.test.ts`).

use pewterdesk_core::{
    AlgoKind, Decimal, ExitChange, Market, OrderKind, PositionSide, Side, SliceStyle, VenueId,
};
use pewterdesk_protocol::action::{action_for, default_slices, Action, For};
use pewterdesk_protocol::command::{parse_command, CommandContext, OpenOrder, OpenPosition};

fn d(s: &str) -> Decimal {
    Decimal(s.parse().unwrap())
}

fn market(base: &str, step: &str) -> Market {
    Market {
        venue: VenueId::Bybit,
        id: format!("{base}USDT"),
        symbol: format!("{base}-USDT"),
        base: base.into(),
        quote: "USDT".into(),
        tick_size: d("0.1"),
        size_step: d(step),
        min_size: d(step),
        max_leverage: 50,
        listed_by: None,
        category: None,
        listed_at: None,
    }
}

fn ctx() -> CommandContext {
    CommandContext {
        markets: vec![
            market("BTC", "0.001"),
            market("ETH", "0.001"),
            market("HYPE", "0.01"),
        ],
        current: Some("BTCUSDT".into()),
        positions: vec![OpenPosition {
            market: "ETHUSDT".into(),
            side: PositionSide::Long,
            size: Some(d("2")),
        }],
        orders: vec![OpenOrder {
            id: "o1".into(),
            market: "BTCUSDT".into(),
        }],
    }
}

fn who() -> For {
    For {
        venue: VenueId::Bybit,
        account: "demo:1".into(),
        max_slippage_bps: 50,
    }
}

fn act(line: &str) -> Action {
    let ctx = ctx();
    let intent = parse_command(line, &ctx).unwrap_or_else(|| panic!("{line} parses"));
    action_for(&intent, &ctx, &who()).unwrap()
}

fn orders(action: Action) -> Vec<pewterdesk_core::OrderRequest> {
    match action {
        Action::Orders(orders) => orders,
        other => panic!("not orders: {other:?}"),
    }
}

#[test]
fn an_order_is_a_limit_with_a_price_and_a_bounded_market_without() {
    let [market] = orders(act("buy 0.01 btc")).try_into().unwrap();
    assert_eq!(
        market.kind,
        OrderKind::Market {
            max_slippage_bps: 50
        }
    );
    assert_eq!((market.side, market.reduce_only), (Side::Buy, false));
    let [limit] = orders(act("sell 0.01 btc at 82000")).try_into().unwrap();
    assert!(matches!(limit.kind, OrderKind::Limit { price, .. } if price == d("82000")));
}

#[test]
fn taking_part_off_and_closing_only_reduce() {
    let [part] = orders(act("sell 50% eth")).try_into().unwrap();
    assert_eq!(part.size, d("1.000"));
    assert!(part.reduce_only);
    assert_eq!(part.side, Side::Sell);
    let [close] = orders(act("close eth")).try_into().unwrap();
    assert_eq!(
        (close.size, close.reduce_only, close.side),
        (d("2"), true, Side::Sell)
    );
}

#[test]
fn a_ladder_spreads_evenly_on_the_tick_in_equal_parts() {
    let ladder = orders(act("buy 100 hype at 38.2 to 37.8"));
    let prices: Vec<String> = ladder
        .iter()
        .map(|o| match &o.kind {
            OrderKind::Limit { price, .. } => price.0.to_string(),
            _ => panic!(),
        })
        .collect();
    assert_eq!(prices, ["38.2", "38.1", "38.0", "37.9", "37.8"]);
    assert!(ladder
        .iter()
        .all(|o| o.size == d("20.00") && !o.reduce_only));
}

#[test]
fn exits_ride_on_the_order() {
    let [order] = orders(act("buy 0.01 btc sl 70000 tp 90000"))
        .try_into()
        .unwrap();
    assert_eq!(order.stop_loss, Some(d("70000")));
    assert_eq!(order.take_profit, Some(d("90000")));
}

#[test]
fn a_tp_sets_that_exit_and_keeps_the_rest() {
    let Action::Protect { market, protection } = act("tp eth 2600") else {
        panic!()
    };
    assert_eq!(market, "ETHUSDT");
    assert_eq!(protection.take_profit, ExitChange::Set(d("2600")));
    assert_eq!(protection.stop_loss, ExitChange::Keep);
    let Action::Protect { protection, .. } = act("sl eth off") else {
        panic!()
    };
    assert_eq!(protection.stop_loss, ExitChange::Remove);
}

#[test]
fn cancel_names_each_order_with_its_market() {
    assert_eq!(
        act("cancel all"),
        Action::Cancel(vec![OpenOrder {
            id: "o1".into(),
            market: "BTCUSDT".into()
        }])
    );
}

#[test]
fn algos_become_specs_for_the_account() {
    let Action::Algo(chase) = act("chase sell 1 eth to 0.5% then market") else {
        panic!()
    };
    assert_eq!(chase.account, "demo:1");
    assert_eq!(
        chase.kind,
        AlgoKind::Chaser {
            post_only: true,
            give_up_bps: Some(50),
            finish_at_market: true
        }
    );
    let Action::Algo(twap) = act("twap buy 1 btc over 30m chase") else {
        panic!()
    };
    assert!(matches!(
        twap.kind,
        AlgoKind::Twap {
            slices: 30,
            style: SliceStyle::Chaser,
            duration_ms: 1_800_000,
            ..
        }
    ));
    assert_eq!(act("halt"), Action::Halt);
    assert_eq!(default_slices(20_000), 2);
    assert_eq!(default_slices(7 * 24 * 3_600_000), 60);
}
