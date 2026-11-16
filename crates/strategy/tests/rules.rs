//! The rules strategy's newer settings: matching, groups, sources, sizing,
//! stops that move, targets in parts, liquidation and the guard rails.

use pewterdesk_core::PositionSide;
use pewterdesk_strategy::sim::{backtest, Costs};
use pewterdesk_strategy::{
    Bar, Compare, Cond, CustomParams, Group, Guards, Hours, MarginMode, Match, Reason, Rule,
    Sizing, Source, StopRule, StrategyConfig, Target, Trail,
};

const H: u64 = 3_600_000;

fn free() -> Costs {
    Costs {
        capital: 10_000.0,
        fee: 0.0,
        maker_fee: None,
        slippage_bps: 0.0,
        funding_8h: 0.0,
    }
}

/// Hourly candles through these closes, each opening at the one before's
/// close and reaching 1 beyond either end.
fn path(closes: &[f64]) -> Vec<Bar> {
    let mut open = closes.first().copied().unwrap_or(0.0);
    closes
        .iter()
        .enumerate()
        .map(|(i, c)| {
            let b = Bar::ohlc(
                i as u64 * H,
                open,
                open.max(*c) + 1.0,
                open.min(*c) - 1.0,
                *c,
            );
            open = *c;
            b
        })
        .collect()
}

fn price_above(v: f64) -> Cond {
    Rule::new(Source::Price, Compare::Above, Source::Value { value: v }).into()
}

fn price_below(v: f64) -> Cond {
    Rule::new(Source::Price, Compare::Below, Source::Value { value: v }).into()
}

fn long(entry: Vec<Cond>, exit: Vec<Cond>) -> CustomParams {
    CustomParams::simple(PositionSide::Long, entry, exit)
}

fn run(p: CustomParams, bars: &[Bar]) -> pewterdesk_strategy::sim::RunResult {
    backtest(&StrategyConfig::Custom(p), free(), bars, 0.0).unwrap()
}

#[test]
fn old_saved_rules_still_read() {
    let json = r#"{"template":"custom","side":"long",
        "entry":[{"left":{"kind":"price"},"op":"above","right":{"kind":"value","value":1}}],
        "exit":[],"stopLoss":0.02,"takeProfit":0,"size":1}"#;
    let c: StrategyConfig = serde_json::from_str(json).unwrap();
    let StrategyConfig::Custom(p) = c else {
        panic!("not custom")
    };
    assert_eq!(p.entry_match, Match::All);
    assert_eq!(p.exit_match, Match::Any);
    assert!(matches!(p.entry[0], Cond::Rule(_)));
    // A group reads back as one.
    let g = r#"{"match":"any","conds":[{"left":{"kind":"price"},"op":"above","right":{"kind":"value","value":1}}]}"#;
    assert!(matches!(
        serde_json::from_str::<Cond>(g).unwrap(),
        Cond::Group(_)
    ));
}

#[test]
fn any_and_groups_decide_the_entry() {
    let bars = path(&[100.0, 100.0, 120.0, 120.0]);
    // All of "above 110" and "below 90" never holds; any does at 120.
    let mut p = long(vec![price_above(110.0), price_below(90.0)], vec![]);
    assert!(run(p.clone(), &bars).trades.is_empty());
    p.entry_match = Match::Any;
    assert_eq!(run(p, &bars).trades.len(), 1);
    // A group of "any" inside an "all".
    let grouped = long(
        vec![
            price_above(110.0),
            Cond::Group(Group {
                when: Match::Any,
                conds: vec![
                    Rule::new(Source::Price, Compare::Below, Source::Value { value: 90.0 }),
                    Rule::new(
                        Source::Price,
                        Compare::Above,
                        Source::Value { value: 115.0 },
                    ),
                ],
            }),
        ],
        vec![],
    );
    assert_eq!(run(grouped, &bars).trades.len(), 1);
}

#[test]
fn the_funnel_counts_what_each_condition_let_through() {
    let bars = path(&[100.0, 105.0, 120.0, 130.0, 100.0]);
    let p = long(vec![price_above(102.0), price_above(125.0)], vec![]);
    let r = run(p, &bars);
    let f = r.funnel.unwrap();
    // Above 102 at 105, 120 and 130 (flat each time but the last, at 130 it
    // entered); and above 125 too only at 130.
    assert_eq!(f.entry, vec![3, 1]);
    assert_eq!(f.passed, vec![3]);
    assert_eq!(f.filtered, vec![1, 2]);
}

#[test]
fn time_in_trade_closes_it() {
    let bars = path(&[100.0; 10]);
    let p = long(
        vec![price_above(0.0)],
        vec![Rule::new(
            Source::HeldHours,
            Compare::Above,
            Source::Value { value: 3.0 },
        )
        .into()],
    );
    let r = run(p, &bars);
    assert_eq!(r.trades[0].exit_reason, Reason::Rule);
    assert_eq!(r.trades[0].close_time - r.trades[0].open_time, 4 * H);
    assert_eq!(
        r.funnel.unwrap().exits,
        vec![r
            .trades
            .iter()
            .filter(|t| t.exit_reason == Reason::Rule)
            .count() as u32]
    );
}

#[test]
fn a_fall_over_a_window_is_read() {
    let mut bars = path(&[100.0; 30]);
    for (i, b) in bars.iter_mut().enumerate() {
        b.oi = Some(if i < 20 { 1000.0 } else { 800.0 });
    }
    let p = long(
        vec![price_above(0.0)],
        vec![Rule {
            hours: Some(6.0),
            ..Rule::new(
                Source::OpenInterest,
                Compare::FallsMoreThan,
                Source::Value { value: 0.1 },
            )
        }
        .into()],
    );
    let r = run(p, &bars);
    // Open interest fell 20% at candle 20: out there.
    assert_eq!(r.trades[0].exit_reason, Reason::Rule);
    assert_eq!(r.trades[0].close_time, 20 * H);
}

#[test]
fn risk_sizing_loses_its_share_at_the_stop() {
    let bars = path(&[100.0, 100.0, 80.0]);
    let p = CustomParams {
        sizing: Some(Sizing::Risk { risk: 0.01 }),
        stop: Some(StopRule::Fixed { pct: 0.05 }),
        max_leverage: Some(10.0),
        ..long(vec![price_above(0.0)], vec![])
    };
    let r = run(p, &bars);
    let t = &r.trades[0];
    assert_eq!(t.exit_reason, Reason::Stop);
    // 1% of 10,000 at a 5% stop: 2,000 of notional, losing 100.
    assert!((t.size * t.entry - 2_000.0).abs() < 1e-6);
    assert!((t.pnl + 100.0).abs() < 1e-6);
}

#[test]
fn fixed_and_capped_sizes() {
    let bars = path(&[100.0, 100.0, 100.0]);
    let fixed = CustomParams {
        sizing: Some(Sizing::Fixed { amount: 500.0 }),
        ..long(vec![price_above(0.0)], vec![])
    };
    assert!((run(fixed, &bars).trades[0].size - 5.0).abs() < 1e-9);
    let capped = CustomParams {
        sizing: Some(Sizing::Equity { share: 5.0 }),
        max_leverage: Some(2.0),
        ..long(vec![price_above(0.0)], vec![])
    };
    assert!((run(capped, &bars).trades[0].size - 200.0).abs() < 1e-9);
}

#[test]
fn targets_take_parts_off_and_the_stop_moves_to_the_entry() {
    // In at 100, stop 95 (1R = 5): 1R at 105 takes 40% off; then back down
    // through 100, where the stop now is.
    let bars = path(&[100.0, 100.0, 106.0, 103.0, 98.0, 90.0]);
    let p = CustomParams {
        stop: Some(StopRule::Fixed { pct: 0.05 }),
        breakeven_at: Some(1.0),
        targets: vec![Target {
            at_r: 1.0,
            close: 0.4,
        }],
        ..long(vec![price_above(0.0)], vec![])
    };
    let r = run(p, &bars);
    let first = &r.trades[0];
    assert_eq!(first.exit_reason, Reason::Target);
    assert!((first.exit - 105.0).abs() < 1e-9);
    let second = &r.trades[1];
    assert_eq!(second.exit_reason, Reason::Stop);
    assert!((second.exit - 100.0).abs() < 1e-9);
    assert!((first.size / (first.size + second.size) - 0.4).abs() < 1e-9);
}

#[test]
fn a_trailing_stop_follows_the_best_price() {
    let mut closes = vec![100.0; 16];
    closes.extend([110.0, 120.0, 130.0, 100.0]);
    let p = CustomParams {
        stop: Some(StopRule::Fixed { pct: 0.05 }),
        trail: Some(Trail {
            atr: 2.0,
            from_r: 1.0,
        }),
        ..long(vec![price_above(0.0)], vec![])
    };
    let r = run(p, &path(&closes));
    let last = r.trades.iter().find(|t| t.close_time >= 19 * H).unwrap();
    assert_eq!(last.exit_reason, Reason::Stop);
    // Well above the entry: it trailed up behind 131.
    assert!(last.exit > 110.0);
}

#[test]
fn liquidation_comes_first_when_the_margin_is_thin() {
    let bars = path(&[100.0, 100.0, 80.0]);
    let p = CustomParams {
        sizing: Some(Sizing::Equity { share: 20.0 }),
        max_leverage: Some(20.0),
        margin: Some(MarginMode::Isolated),
        stop: Some(StopRule::Fixed { pct: 0.10 }),
        ..long(vec![price_above(0.0)], vec![])
    };
    let r = run(p, &bars);
    assert_eq!(r.trades[0].exit_reason, Reason::Liquidation);
    // 20x isolated: about 4.5% below the entry, before the 10% stop.
    assert!((r.trades[0].exit - 95.5).abs() < 0.01);
}

#[test]
fn a_drawdown_guard_ends_the_test() {
    let bars = path(&[100.0, 100.0, 80.0, 60.0, 100.0, 100.0]);
    let p = CustomParams {
        guards: Guards {
            max_drawdown: Some(0.1),
            ..Guards::default()
        },
        ..long(vec![price_above(0.0)], vec![])
    };
    let r = run(p, &bars);
    assert_eq!(r.trades.len(), 1);
    assert_eq!(r.trades[0].exit_reason, Reason::Guard);
}

#[test]
fn trading_hours_keep_signals_from_opening() {
    let bars = path(&[100.0; 24]);
    let p = CustomParams {
        hours: Some(Hours {
            from: 7 * 60,
            to: 8 * 60,
            weekdays: false,
        }),
        ..long(
            vec![price_above(0.0)],
            vec![Rule::new(
                Source::HeldHours,
                Compare::Above,
                Source::Value { value: 0.0 },
            )
            .into()],
        )
    };
    let r = run(p, &bars);
    // Only the 07:00 candle opens one.
    assert_eq!(r.trades.len(), 1);
    assert_eq!(r.trades[0].open_time, 7 * H);
    assert!(r.funnel.unwrap().blocked > 0);
}

#[test]
fn funding_comes_from_the_candles_where_they_carry_it() {
    let mut bars = path(&[100.0; 9]);
    for b in &mut bars {
        b.funding = Some(0.001);
    }
    let r = run(long(vec![price_above(0.0)], vec![]), &bars);
    // 1x of 10,000 for 8 hours at 0.1% per 8 hours: 10 paid.
    assert!((r.trades[0].funding + 10.0).abs() < 1e-6);
}

#[test]
fn settings_that_cant_work_are_refused() {
    let bad = [
        CustomParams {
            sizing: Some(Sizing::Risk { risk: 0.01 }),
            ..long(vec![price_above(0.0)], vec![])
        },
        CustomParams {
            stop: Some(StopRule::Fixed { pct: 0.05 }),
            targets: vec![
                Target {
                    at_r: 1.0,
                    close: 0.7,
                },
                Target {
                    at_r: 2.0,
                    close: 0.7,
                },
            ],
            ..long(vec![price_above(0.0)], vec![])
        },
        CustomParams {
            entry: vec![Cond::Group(Group {
                when: Match::All,
                conds: vec![],
            })],
            ..long(vec![], vec![])
        },
    ];
    for p in bad {
        assert!(StrategyConfig::Custom(p).check().is_err());
    }
}
