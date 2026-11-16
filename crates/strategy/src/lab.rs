//! The Backtest page's lab: one run between two dates, a run's figures in
//! brief, and an optimizer that runs a strategy over a grid of its settings.
//!
//! Pure functions of candles, like the rest of this crate: the engine reads
//! the candles and hands them in.

use pewterdesk_core::{CandleInterval, VenueId};
use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::sim::{backtest, Costs, RunResult};
use crate::{Bar, StrategyConfig, TS_FILE};

/// The most runs one optimization makes.
pub const MAX_CELLS: usize = 400;

/// A backtest the page asks for: a strategy on one market, between two
/// times, the last `hold_out_days` held out.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export_to = TS_FILE)]
pub struct LabRun {
    pub venue: VenueId,
    pub market: String,
    pub interval: CandleInterval,
    /// Open time of the first candle wanted, ms.
    #[ts(type = "number")]
    pub since: u64,
    /// Open time of the last candle wanted, ms.
    #[ts(type = "number")]
    pub until: u64,
    pub hold_out_days: f64,
    pub capital: f64,
    /// Slippage on market orders and stops, in basis points; the venue's
    /// paper default if unset.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub slippage_bps: Option<f64>,
    pub strategy: StrategyConfig,
}

/// One setting varied by the optimizer, over the values given.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export_to = TS_FILE)]
pub struct Axis {
    /// A setting's name, as `set_param` reads it ("fast", "stopAtr", ...).
    pub param: String,
    pub values: Vec<f64>,
}

/// One setting across, and optionally a second down.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export_to = TS_FILE)]
pub struct Sweep {
    pub x: Axis,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub y: Option<Axis>,
}

/// A run's figures in brief. Returns are fractions (0.1 = +10%).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export_to = TS_FILE)]
pub struct Summary {
    /// The whole run.
    pub ret: f64,
    /// Up to the held-out period, and over it.
    pub ret_in: f64,
    pub ret_out: f64,
    /// The deepest fall from a high, a fraction at or below zero.
    pub max_drawdown: f64,
    pub trades: u32,
    pub trades_out: u32,
    pub win_rate: f64,
    /// Won over lost; `None` with nothing lost.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub profit_factor: Option<f64>,
    pub avg_r: f64,
    /// Holding the market over the same candles.
    pub buy_hold: f64,
}

/// One run of an optimization: its settings and figures, or why it couldn't run.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export_to = TS_FILE)]
pub struct Cell {
    pub x: f64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub y: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub summary: Option<Summary>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub error: Option<String>,
}

fn ratio(a: f64, b: f64) -> f64 {
    if b > 0.0 {
        a / b - 1.0
    } else {
        0.0
    }
}

/// `run`'s figures in brief.
pub fn summarize(run: &RunResult) -> Summary {
    let eq = &run.equity;
    let first = eq.first().copied().unwrap_or(0.0);
    let last = eq.last().copied().unwrap_or(first);
    let split = (run.hold_out_from as usize).min(eq.len());
    // The equity the held-out period starts from: the candle before it.
    let at_split = if split == 0 {
        first
    } else {
        eq.get(split - 1).copied().unwrap_or(last)
    };
    let mut peak = first;
    let mut max_drawdown: f64 = 0.0;
    for &v in eq {
        peak = peak.max(v);
        if peak > 0.0 {
            max_drawdown = max_drawdown.min(v / peak - 1.0);
        }
    }
    let won: f64 = run
        .trades
        .iter()
        .filter(|t| t.pnl > 0.0)
        .map(|t| t.pnl)
        .sum();
    let lost: f64 = -run
        .trades
        .iter()
        .filter(|t| t.pnl <= 0.0)
        .map(|t| t.pnl)
        .sum::<f64>();
    let n = run.trades.len();
    let wins = run.trades.iter().filter(|t| t.pnl > 0.0).count();
    Summary {
        ret: ratio(last, first),
        ret_in: ratio(at_split, first),
        ret_out: if split < eq.len() {
            ratio(last, at_split)
        } else {
            0.0
        },
        max_drawdown,
        trades: n as u32,
        trades_out: run.trades.iter().filter(|t| t.out_of_sample).count() as u32,
        win_rate: if n > 0 { wins as f64 / n as f64 } else { 0.0 },
        profit_factor: (lost > 0.0).then(|| won / lost),
        avg_r: if n > 0 {
            run.trades.iter().map(|t| t.r).sum::<f64>() / n as f64
        } else {
            0.0
        },
        buy_hold: ratio(
            run.buy_hold.last().copied().unwrap_or(0.0),
            run.buy_hold.first().copied().unwrap_or(0.0),
        ),
    }
}

/// The settings each template lets the optimizer vary.
pub fn params(config: &StrategyConfig) -> &'static [&'static str] {
    match config {
        StrategyConfig::Ema(_) => &["fast", "slow", "stopAtr", "risk", "maxLeverage"],
        StrategyConfig::Grid(_) => &["lower", "upper", "levels", "sizePerLevel"],
        StrategyConfig::Dca(_) => &["every", "amount", "takeProfit", "maxBuys"],
        StrategyConfig::Custom(_) => &["stopLoss", "takeProfit", "size"],
    }
}

/// `config` with one setting changed; an unknown name is refused. Counts are
/// rounded to whole numbers. The result isn't checked: running it does that.
pub fn set_param(config: &StrategyConfig, param: &str, v: f64) -> Result<StrategyConfig, String> {
    if !v.is_finite() {
        return Err("not a number".into());
    }
    let whole = |v: f64| v.round().max(0.0) as u32;
    let mut c = config.clone();
    // The field the name points at, as a number or a whole count.
    let (num, count): (Option<&mut f64>, Option<&mut u32>) = match &mut c {
        StrategyConfig::Ema(p) => match param {
            "fast" => (None, Some(&mut p.fast)),
            "slow" => (None, Some(&mut p.slow)),
            "stopAtr" => (Some(&mut p.stop_atr), None),
            "risk" => (Some(&mut p.risk), None),
            "maxLeverage" => (Some(&mut p.max_leverage), None),
            _ => (None, None),
        },
        StrategyConfig::Grid(p) => match param {
            "lower" => (Some(&mut p.lower), None),
            "upper" => (Some(&mut p.upper), None),
            "levels" => (None, Some(&mut p.levels)),
            "sizePerLevel" => (Some(&mut p.size_per_level), None),
            _ => (None, None),
        },
        StrategyConfig::Dca(p) => match param {
            "every" => (None, Some(&mut p.every)),
            "amount" => (Some(&mut p.amount), None),
            "takeProfit" => (Some(&mut p.take_profit), None),
            "maxBuys" => (None, Some(&mut p.max_buys)),
            _ => (None, None),
        },
        StrategyConfig::Custom(p) => match param {
            "stopLoss" => (Some(&mut p.stop_loss), None),
            "takeProfit" => (Some(&mut p.take_profit), None),
            "size" => (Some(&mut p.size), None),
            _ => (None, None),
        },
    };
    match (num, count) {
        (Some(field), _) => *field = v,
        (None, Some(field)) => *field = whole(v),
        (None, None) => return Err(format!("{param} isn't a setting of this strategy")),
    }
    Ok(c)
}

/// Runs `config` once for every point of `sweep` over the same candles.
/// A point whose settings don't make a strategy (a slow average shorter than
/// the fast) comes back with its reason, not a result.
pub fn optimize(
    config: &StrategyConfig,
    costs: &Costs,
    bars: &[Bar],
    hold_out_days: f64,
    sweep: &Sweep,
) -> Result<Vec<Cell>, String> {
    let ys: Vec<Option<f64>> = match &sweep.y {
        Some(axis) => axis.values.iter().map(|v| Some(*v)).collect(),
        None => vec![None],
    };
    let count = sweep.x.values.len() * ys.len();
    if sweep.x.values.is_empty() || ys.is_empty() {
        return Err("give each setting at least one value".into());
    }
    if count > MAX_CELLS {
        return Err(format!("{count} runs; at most {MAX_CELLS} at a time"));
    }
    let mut cells = Vec::with_capacity(count);
    for y in &ys {
        for &x in &sweep.x.values {
            let mut c = set_param(config, &sweep.x.param, x)?;
            if let (Some(axis), Some(y)) = (&sweep.y, y) {
                c = set_param(&c, &axis.param, *y)?;
            }
            let (summary, error) = match c
                .check()
                .and_then(|()| backtest(&c, costs.clone(), bars, hold_out_days))
            {
                Ok(run) => (Some(summarize(&run)), None),
                Err(e) => (None, Some(e)),
            };
            cells.push(Cell {
                x,
                y: *y,
                summary,
                error,
            });
        }
    }
    Ok(cells)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{Direction, EmaParams};

    fn bars(n: usize) -> Vec<Bar> {
        (0..n)
            .map(|i| {
                let c = 100.0 + (i as f64 / 7.0).sin() * 10.0 + i as f64 * 0.05;
                Bar::ohlc(i as u64 * 3_600_000, c - 0.3, c + 1.0, c - 1.0, c)
            })
            .collect()
    }

    fn ema() -> StrategyConfig {
        StrategyConfig::Ema(EmaParams {
            fast: 5,
            slow: 20,
            stop_atr: 2.0,
            risk: 0.01,
            max_leverage: 3.0,
            direction: Direction::Long,
        })
    }

    fn costs() -> Costs {
        Costs {
            capital: 10_000.0,
            fee: 0.0005,
            maker_fee: None,
            slippage_bps: 2.0,
            funding_8h: 0.0,
        }
    }

    #[test]
    fn a_summary_agrees_with_its_run() {
        let run = backtest(&ema(), costs(), &bars(400), 5.0).unwrap();
        let s = summarize(&run);
        let last = *run.equity.last().unwrap();
        assert!((s.ret - (last / 10_000.0 - 1.0)).abs() < 1e-9);
        assert_eq!(s.trades as usize, run.trades.len());
        assert!(s.max_drawdown <= 0.0);
        // In and out compound to the whole.
        assert!(((1.0 + s.ret_in) * (1.0 + s.ret_out) - (1.0 + s.ret)).abs() < 1e-9);
    }

    #[test]
    fn set_param_changes_one_setting_and_refuses_others() {
        let c = set_param(&ema(), "fast", 9.4).unwrap();
        assert!(matches!(c, StrategyConfig::Ema(ref p) if p.fast == 9 && p.slow == 20));
        assert!(set_param(&ema(), "levels", 3.0).is_err());
        assert!(set_param(&ema(), "fast", f64::NAN).is_err());
    }

    #[test]
    fn an_optimization_runs_every_point_and_keeps_bad_ones_apart() {
        let sweep = Sweep {
            x: Axis {
                param: "fast".into(),
                values: vec![5.0, 10.0, 25.0],
            },
            y: Some(Axis {
                param: "slow".into(),
                values: vec![20.0, 30.0],
            }),
        };
        let cells = optimize(&ema(), &costs(), &bars(400), 5.0, &sweep).unwrap();
        assert_eq!(cells.len(), 6);
        // fast 25 with slow 20 isn't a strategy: a reason, not a result.
        let bad = cells
            .iter()
            .find(|c| c.x == 25.0 && c.y == Some(20.0))
            .unwrap();
        assert!(bad.summary.is_none() && bad.error.is_some());
        assert!(cells.iter().filter(|c| c.summary.is_some()).count() >= 4);
    }

    #[test]
    fn an_optimization_is_capped() {
        let sweep = Sweep {
            x: Axis {
                param: "fast".into(),
                values: (1..=30).map(f64::from).collect(),
            },
            y: Some(Axis {
                param: "slow".into(),
                values: (31..=50).map(f64::from).collect(),
            }),
        };
        assert!(optimize(&ema(), &costs(), &bars(100), 0.0, &sweep).is_err());
    }
}
