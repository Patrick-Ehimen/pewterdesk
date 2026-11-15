//! The built-in strategies. Each asks only for what it needs and only when
//! it changes (a grid doesn't re-send a limit that's already resting), so
//! the bot host sends a venue no more than it must.

use std::collections::BTreeSet;

use pewterdesk_core::{PositionSide, Side};

use crate::indicators::Line;
use crate::{
    Bar, Compare, CustomParams, DcaParams, Direction, EmaParams, Fill, GridParams, Intent, Reason,
    Rule, Snapshot, Source, Strategy,
};

const EPS: f64 = 1e-12;

fn last(s: &Snapshot<'_>) -> Bar {
    *s.bars
        .last()
        .expect("a strategy is shown at least one candle")
}

/// An EMA cross: long when the fast crosses above the slow, short when it
/// crosses below (as `direction` allows), out on the opposite cross or the
/// stop - an ATR multiple from the entry - sized so the stop costs `risk`
/// of equity, at most `max_leverage`.
pub struct Trend {
    p: EmaParams,
    fast: Line,
    slow: Line,
    atr: Line,
    now: (Option<f64>, Option<f64>),
    before: (Option<f64>, Option<f64>),
    atr_now: Option<f64>,
}

impl Trend {
    pub fn new(p: EmaParams) -> Self {
        Self {
            fast: Line::ema(p.fast as usize),
            slow: Line::ema(p.slow as usize),
            atr: Line::atr(14),
            now: (None, None),
            before: (None, None),
            atr_now: None,
            p,
        }
    }
}

impl Strategy for Trend {
    fn on_bar(&mut self, s: &Snapshot<'_>) -> Vec<Intent> {
        let bar = last(s);
        self.before = self.now;
        self.now = (self.fast.push(&bar), self.slow.push(&bar));
        self.atr_now = self.atr.push(&bar);
        let ((Some(f), Some(sl)), (Some(pf), Some(ps))) = (self.now, self.before) else {
            return Vec::new();
        };
        let want = if pf <= ps && f > sl {
            PositionSide::Long
        } else if pf >= ps && f < sl {
            PositionSide::Short
        } else {
            return Vec::new();
        };
        let mut out = Vec::new();
        let holding = if s.position > EPS {
            Some(PositionSide::Long)
        } else if s.position < -EPS {
            Some(PositionSide::Short)
        } else {
            None
        };
        if holding.is_some_and(|h| h != want) {
            out.push(Intent::Close {
                reason: Reason::Cross,
            });
        }
        let allowed = match self.p.direction {
            Direction::Both => true,
            Direction::Long => want == PositionSide::Long,
            Direction::Short => want == PositionSide::Short,
        };
        if holding != Some(want) && allowed {
            let dir = if want == PositionSide::Long {
                1.0
            } else {
                -1.0
            };
            let atr = self.atr_now.unwrap_or(bar.close * 0.01);
            let stop = bar.close - dir * self.p.stop_atr * atr;
            let by_risk = s.equity * self.p.risk / (bar.close - stop).abs().max(EPS);
            let by_leverage = s.equity * self.p.max_leverage / bar.close;
            let size = by_risk.min(by_leverage);
            if size > EPS {
                out.push(Intent::Market {
                    side: if dir > 0.0 { Side::Buy } else { Side::Sell },
                    size,
                    reduce_only: false,
                    reason: Reason::Entry,
                    stop: Some(stop),
                });
                out.push(Intent::Exits {
                    stop: Some(stop),
                    target: None,
                    stop_reason: Reason::Stop,
                });
            }
        }
        out
    }

    fn lines(&self) -> Vec<(&'static str, Option<f64>)> {
        vec![("fast", self.now.0), ("slow", self.now.1)]
    }

    fn warm(&mut self, bars: &[Bar]) {
        for bar in bars {
            self.before = self.now;
            self.now = (self.fast.push(bar), self.slow.push(bar));
            self.atr_now = self.atr.push(bar);
        }
    }
}

/// Grid levels from the lower price to the upper, evenly spaced.
pub fn grid_levels(p: &GridParams) -> Vec<f64> {
    if p.levels < 2 || p.upper <= p.lower {
        return Vec::new();
    }
    let step = (p.upper - p.lower) / f64::from(p.levels - 1);
    (0..p.levels)
        .map(|i| p.lower + f64::from(i) * step)
        .collect()
}

/// A long grid: a buy resting at each level below the price, and for each
/// level bought, a sell one level up that closes it. Leaving the range
/// (`stop_below`, `stop_above`) flattens it and stops the bot.
pub struct Grid {
    p: GridParams,
    levels: Vec<f64>,
    held: Vec<bool>,
    /// Tags resting now, as asked for.
    resting: BTreeSet<String>,
    started: bool,
    stopped: bool,
}

impl Grid {
    pub fn new(p: GridParams) -> Self {
        let levels = grid_levels(&p);
        Self {
            held: vec![false; levels.len()],
            levels,
            resting: BTreeSet::new(),
            started: false,
            stopped: false,
            p,
        }
    }

    fn buy_tag(level: usize) -> String {
        format!("b{level}")
    }

    fn sell_tag(level: usize) -> String {
        format!("s{level}")
    }
}

impl Strategy for Grid {
    fn on_gone(&mut self, tag: &str) {
        self.resting.remove(tag);
    }

    fn on_bar(&mut self, s: &Snapshot<'_>) -> Vec<Intent> {
        let bar = last(s);
        let mut out = Vec::new();
        if self.stopped {
            return out;
        }
        if !self.started {
            self.started = true;
            out.push(Intent::Exits {
                stop: Some(self.p.stop_below),
                target: Some(self.p.stop_above),
                stop_reason: Reason::StopOut,
            });
        }
        let gap = self
            .levels
            .get(1)
            .zip(self.levels.first())
            .map_or(0.0, |(b, a)| b - a);
        // The top level has no level above it to sell at.
        for l in 0..self.levels.len().saturating_sub(1) {
            let level = self.levels[l];
            let (buy, sell) = (Self::buy_tag(l), Self::sell_tag(l));
            if self.held[l] {
                if self.resting.insert(sell.clone()) {
                    out.push(Intent::Limit {
                        tag: sell,
                        side: Side::Sell,
                        price: level + gap,
                        size: self.p.size_per_level,
                        reduce_only: true,
                        closes: Some(buy),
                        stop: None,
                    });
                }
            } else if level < bar.close {
                if self.resting.insert(buy.clone()) {
                    out.push(Intent::Limit {
                        tag: buy,
                        side: Side::Buy,
                        price: level,
                        size: self.p.size_per_level,
                        reduce_only: false,
                        closes: None,
                        stop: Some(self.p.stop_below),
                    });
                }
            } else if self.resting.remove(&buy) {
                // At or above the price: a buy there would fill at once.
                out.push(Intent::Cancel { tag: buy });
            }
        }
        out
    }

    fn on_fill(&mut self, fill: &Fill) {
        match (&fill.tag, fill.reason) {
            (_, Reason::StopOut | Reason::Target) => {
                // The range was left: everything off, and no more.
                self.stopped = true;
                self.resting.clear();
                self.held.iter_mut().for_each(|h| *h = false);
            }
            (Some(tag), _) => {
                self.resting.remove(tag);
                // A buy filled holds its level; its sell filled frees it.
                let level = tag[1..].parse::<usize>().ok();
                if let Some(held) = level.and_then(|l| self.held.get_mut(l)) {
                    *held = tag.starts_with('b');
                }
            }
            _ => {}
        }
    }
}

/// Buys `amount` at market every `every` candles, up to `max_buys`, and
/// sells the whole once the price is `take_profit` above the average entry;
/// then starts again.
pub struct Dca {
    p: DcaParams,
    count: u32,
    buys: u32,
}

impl Dca {
    pub fn new(p: DcaParams) -> Self {
        Self {
            p,
            count: 0,
            buys: 0,
        }
    }
}

impl Strategy for Dca {
    fn on_bar(&mut self, s: &Snapshot<'_>) -> Vec<Intent> {
        let bar = last(s);
        let mut out = Vec::new();
        if s.position <= EPS && self.buys > 0 {
            // Sold: a new cycle.
            self.buys = 0;
        }
        if s.position > EPS {
            out.push(Intent::Exits {
                stop: None,
                target: Some(s.entry * (1.0 + self.p.take_profit)),
                stop_reason: Reason::Stop,
            });
        }
        let due = self.count.is_multiple_of(self.p.every);
        self.count += 1;
        if due && self.buys < self.p.max_buys && bar.close > 0.0 {
            self.buys += 1;
            out.push(Intent::Market {
                side: Side::Buy,
                size: self.p.amount / bar.close,
                reduce_only: false,
                reason: Reason::Schedule,
                stop: None,
            });
        }
        out
    }
}

/// One rule's two lines, and their last two values.
struct RuleLines {
    op: Compare,
    left: Line,
    right: Line,
    now: (Option<f64>, Option<f64>),
    before: (Option<f64>, Option<f64>),
}

fn line_for(source: &Source) -> Line {
    match source {
        Source::Price => Line::Price,
        Source::Value { value } => Line::Value(*value),
        Source::Ema { period } => Line::ema(*period as usize),
        Source::Sma { period } => Line::sma(*period as usize),
        Source::Rsi { period } => Line::rsi(*period as usize),
    }
}

impl RuleLines {
    fn new(rule: &Rule) -> Self {
        Self {
            op: rule.op,
            left: line_for(&rule.left),
            right: line_for(&rule.right),
            now: (None, None),
            before: (None, None),
        }
    }

    fn push(&mut self, bar: &Bar) {
        self.before = self.now;
        self.now = (self.left.push(bar), self.right.push(bar));
    }

    fn holds(&self) -> bool {
        let (Some(l), Some(r)) = self.now else {
            return false;
        };
        match self.op {
            Compare::Above => l > r,
            Compare::Below => l < r,
            Compare::CrossesAbove | Compare::CrossesBelow => {
                let (Some(pl), Some(pr)) = self.before else {
                    return false;
                };
                if self.op == Compare::CrossesAbove {
                    pl <= pr && l > r
                } else {
                    pl >= pr && l < r
                }
            }
        }
    }
}

/// The user's own rules: in, on `side`, when every entry rule holds; out
/// when any exit rule does, or at the stop or target.
pub struct Custom {
    p: CustomParams,
    entry: Vec<RuleLines>,
    exit: Vec<RuleLines>,
}

impl Custom {
    pub fn new(p: CustomParams) -> Self {
        Self {
            entry: p.entry.iter().map(RuleLines::new).collect(),
            exit: p.exit.iter().map(RuleLines::new).collect(),
            p,
        }
    }
}

impl Strategy for Custom {
    fn warm(&mut self, bars: &[Bar]) {
        for bar in bars {
            for rule in self.entry.iter_mut().chain(self.exit.iter_mut()) {
                rule.push(bar);
            }
        }
    }

    fn on_bar(&mut self, s: &Snapshot<'_>) -> Vec<Intent> {
        let bar = last(s);
        for rule in self.entry.iter_mut().chain(self.exit.iter_mut()) {
            rule.push(&bar);
        }
        let dir = if self.p.side == PositionSide::Long {
            1.0
        } else {
            -1.0
        };
        if s.position.abs() > EPS {
            if self.exit.iter().any(RuleLines::holds) {
                return vec![Intent::Close {
                    reason: Reason::Rule,
                }];
            }
            return Vec::new();
        }
        if !self.entry.iter().all(RuleLines::holds) {
            return Vec::new();
        }
        let size = s.equity * self.p.size / bar.close;
        let stop = (self.p.stop_loss > 0.0).then_some(bar.close * (1.0 - dir * self.p.stop_loss));
        let target =
            (self.p.take_profit > 0.0).then_some(bar.close * (1.0 + dir * self.p.take_profit));
        vec![
            Intent::Market {
                side: if dir > 0.0 { Side::Buy } else { Side::Sell },
                size,
                reduce_only: false,
                reason: Reason::Entry,
                stop,
            },
            Intent::Exits {
                stop,
                target,
                stop_reason: Reason::Stop,
            },
        ]
    }
}
