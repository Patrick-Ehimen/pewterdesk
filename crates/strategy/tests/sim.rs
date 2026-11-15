//! The backtester's fill model and the templates, on candles made to order.

use pewterdesk_core::{PositionSide, Side};
use pewterdesk_strategy::sim::{backtest, Costs, Session};
use pewterdesk_strategy::{
    Bar, Compare, CustomParams, DcaParams, Direction, EmaParams, GridParams, Intent, Reason, Rule,
    Source, StrategyConfig,
};

const H: u64 = 3_600_000;

fn bar(i: u64, open: f64, high: f64, low: f64, close: f64) -> Bar {
    Bar {
        time: i * H,
        open,
        high,
        low,
        close,
    }
}

/// Flat candles at each close, one an hour.
fn flat(closes: &[f64]) -> Vec<Bar> {
    closes
        .iter()
        .enumerate()
        .map(|(i, c)| bar(i as u64, *c, *c, *c, *c))
        .collect()
}

fn free() -> Costs {
    Costs {
        capital: 10_000.0,
        fee: 0.0,
        maker_fee: None,
        slippage_bps: 0.0,
        funding_8h: 0.0,
    }
}

fn grid() -> StrategyConfig {
    StrategyConfig::Grid(GridParams {
        lower: 90.0,
        upper: 110.0,
        levels: 5,
        size_per_level: 1.0,
        stop_below: 80.0,
        stop_above: 120.0,
    })
}

#[test]
fn a_grid_buys_each_level_and_sells_it_one_up() {
    // 100, down through 95 (buy), back up through 100 (sell).
    let bars = vec![
        bar(0, 100.0, 100.0, 100.0, 100.0),
        bar(1, 100.0, 100.0, 94.0, 96.0),
        bar(2, 96.0, 101.0, 96.0, 100.0),
    ];
    let run = backtest(&grid(), free(), &bars, 0.0).unwrap();
    let grid_trades: Vec<_> = run
        .trades
        .iter()
        .filter(|t| t.exit_reason == Reason::Grid)
        .collect();
    assert_eq!(grid_trades.len(), 1, "{:#?}", run.trades);
    let t = grid_trades[0];
    assert_eq!((t.entry, t.exit, t.size), (95.0, 100.0, 1.0));
    assert!((t.pnl - 5.0).abs() < 1e-9);
    // The 90 level was resting but never reached.
    assert!(run.trades.iter().all(|t| t.entry != 90.0));
}

#[test]
fn leaving_the_range_flattens_the_grid_and_stops_it() {
    let bars = vec![
        bar(0, 100.0, 100.0, 100.0, 100.0),
        bar(1, 100.0, 100.0, 89.0, 92.0),
        // Gaps down through the stop: filled at the open, not the stop.
        bar(2, 78.0, 79.0, 70.0, 75.0),
        bar(3, 75.0, 100.0, 75.0, 99.0),
    ];
    let run = backtest(&grid(), free(), &bars, 0.0).unwrap();
    let out: Vec<_> = run
        .trades
        .iter()
        .filter(|t| t.exit_reason == Reason::StopOut)
        .collect();
    assert_eq!(out.len(), 2, "both levels bought, both stopped out");
    assert!(out.iter().all(|t| t.exit == 78.0));
    assert_eq!(run.stopped_out.map(|s| s.index), Some(2));
    // Nothing after: the bounce isn't traded.
    assert!(run.trades.iter().all(|t| t.close_time <= 2 * H));
}

#[test]
fn a_stop_and_a_target_in_one_candle_count_as_the_stop() {
    let config = StrategyConfig::Custom(CustomParams {
        side: PositionSide::Long,
        entry: vec![Rule {
            left: Source::Price,
            op: Compare::Above,
            right: Source::Value { value: 0.0 },
        }],
        exit: vec![],
        stop_loss: 0.05,
        take_profit: 0.05,
        size: 1.0,
    });
    let bars = vec![
        bar(0, 100.0, 100.0, 100.0, 100.0),
        bar(1, 100.0, 110.0, 90.0, 100.0),
    ];
    let run = backtest(&config, free(), &bars, 0.0).unwrap();
    assert_eq!(run.trades[0].exit_reason, Reason::Stop);
    assert!((run.trades[0].exit - 95.0).abs() < 1e-9);
}

#[test]
fn market_orders_pay_slippage_and_fees_and_longs_pay_funding() {
    let config = StrategyConfig::Custom(CustomParams {
        side: PositionSide::Long,
        entry: vec![Rule {
            left: Source::Price,
            op: Compare::Above,
            right: Source::Value { value: 0.0 },
        }],
        exit: vec![],
        stop_loss: 0.0,
        take_profit: 0.0,
        size: 1.0,
    });
    let costs = Costs {
        capital: 10_000.0,
        fee: 0.001,
        maker_fee: None,
        slippage_bps: 10.0,
        funding_8h: 0.0001,
    };
    // 9 hourly candles held after the entry.
    let run = backtest(&config, costs, &flat(&[100.0; 10]), 0.0).unwrap();
    let t = &run.trades[0];
    assert!((t.entry - 100.1).abs() < 1e-9, "{}", t.entry);
    assert_eq!(t.exit_reason, Reason::End);
    assert!(t.fees < 0.0);
    // 9 hours long: 9/8 of 0.01% of the notional.
    let notional = t.entry * t.size;
    assert!(
        (t.funding + notional * 0.0001 * 9.0 / 8.0).abs() < 1e-6,
        "{}",
        t.funding
    );
    assert!(t.pnl < 0.0, "flat prices lose the costs");
}

#[test]
fn an_ema_cross_goes_long_with_a_stop_sized_by_risk() {
    let config = StrategyConfig::Ema(EmaParams {
        fast: 2,
        slow: 4,
        stop_atr: 2.0,
        risk: 0.01,
        max_leverage: 3.0,
        direction: Direction::Long,
    });
    let mut closes = vec![100.0, 99.0, 98.0, 97.0, 96.0];
    closes.extend([98.0, 101.0, 104.0, 107.0, 110.0]);
    let run = backtest(&config, free(), &flat(&closes), 0.0).unwrap();
    let entry = run
        .asked
        .iter()
        .find_map(|a| match &a.intent {
            Intent::Market {
                side: Side::Buy,
                size,
                stop,
                ..
            } => Some((*size, *stop)),
            _ => None,
        })
        .expect("it went long");
    assert!(entry.1.is_some(), "with its stop");
    assert!(run.fast_line.is_some() && run.slow_line.is_some());
    assert_eq!(run.trades.len(), 1);
    assert!(run.trades[0].pnl > 0.0);
}

#[test]
fn a_dca_buys_on_its_schedule_and_takes_profit_on_the_whole() {
    let config = StrategyConfig::Dca(DcaParams {
        every: 2,
        amount: 100.0,
        take_profit: 0.05,
        max_buys: 3,
    });
    let run = backtest(
        &config,
        free(),
        &flat(&[100.0, 100.0, 90.0, 90.0, 80.0, 80.0, 95.0, 100.0]),
        0.0,
    )
    .unwrap();
    let sold = run
        .trades
        .iter()
        .find(|t| t.exit_reason == Reason::Target)
        .expect("the take-profit fired")
        .close_time;
    let buys = run
        .asked
        .iter()
        .filter(|a| {
            a.time < sold
                && matches!(
                    a.intent,
                    Intent::Market {
                        reason: Reason::Schedule,
                        ..
                    }
                )
        })
        .count();
    assert_eq!(buys, 3, "no more than max_buys before the take-profit");
    // Then a new cycle starts.
    assert!(run
        .asked
        .iter()
        .any(|a| a.time >= sold && matches!(a.intent, Intent::Market { .. })));
}

#[test]
fn the_same_candles_ask_the_same_things_fed_at_once_or_one_by_one() {
    let bars: Vec<Bar> = (0..300)
        .map(|i| {
            let c = 100.0 + 8.0 * ((i as f64) / 9.0).sin() + (i as f64) * 0.01;
            bar(i, c - 0.3, c + 1.5, c - 1.5, c)
        })
        .collect();
    let at_once = backtest(&grid(), free(), &bars, 0.0).unwrap();
    // Paper trading: a session fed each candle as it closes.
    let mut live = Session::new(&grid(), free(), H, u64::MAX).unwrap();
    let mut asked = Vec::new();
    for b in &bars {
        asked.extend(live.step(*b).into_iter().map(|i| (b.time, i)));
    }
    let backtested: Vec<_> = at_once
        .asked
        .iter()
        .map(|a| (a.time, a.intent.clone()))
        .collect();
    assert_eq!(asked, backtested);
    assert!(!asked.is_empty());
}

#[test]
fn settings_that_cant_run_are_refused() {
    let bad = StrategyConfig::Grid(GridParams {
        lower: 110.0,
        upper: 90.0,
        levels: 5,
        size_per_level: 1.0,
        stop_below: 80.0,
        stop_above: 120.0,
    });
    assert!(bad.check().is_err());
    assert!(backtest(&grid(), free(), &flat(&[100.0]), 0.0).is_err());
}
