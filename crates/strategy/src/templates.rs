//! The built-in strategies. Each asks only for what it needs and only when
//! it changes (a grid doesn't re-send a limit that's already resting), so
//! the bot host sends a venue no more than it must.

use std::collections::{BTreeSet, VecDeque};

use pewterdesk_core::{PositionSide, Side};

use crate::indicators::Line;
use crate::{
    Bar, Compare, Cond, CustomParams, DcaParams, Direction, EmaParams, Fill, Funnel, GridParams,
    Intent, MarginMode, Match, Reason, Rule, Sizing, Snapshot, Source, StopRule, Strategy,
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
                    liquidation: None,
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
                        reason: None,
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
                        reason: None,
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
                liquidation: None,
            });
        }
        out
    }
}

/// The maintenance margin a liquidation price is worked out with.
const MAINTENANCE: f64 = 0.005;
const HOUR: f64 = 3_600_000.0;
const DAY_MS: u64 = 86_400_000;

/// What one side of a rule reads: an indicator, or how long the trade has
/// been open (which only the strategy knows).
enum Side_ {
    Line(Line),
    Held,
}

fn side_for(source: &Source) -> Side_ {
    let framed = |line: Line, on: &Option<crate::CandleInterval>| match on {
        Some(i) => Line::framed(line, i.millis()),
        None => line,
    };
    Side_::Line(match source {
        Source::Price => Line::Price,
        Source::Value { value } => Line::Value(*value),
        Source::Ema { period, on } => framed(Line::ema(*period as usize), on),
        Source::Sma { period, on } => framed(Line::sma(*period as usize), on),
        Source::Rsi { period, on } => framed(Line::rsi(*period as usize), on),
        Source::Volume => Line::Volume,
        Source::VolumeAvg { period } => Line::volume_avg(*period as usize),
        Source::Funding => Line::Funding,
        Source::OpenInterest => Line::OpenInterest,
        Source::HeldHours => return Side_::Held,
    })
}

impl Side_ {
    fn push(&mut self, bar: &Bar, held: Option<f64>) -> Option<f64> {
        match self {
            Side_::Line(l) => l.push(bar),
            Side_::Held => held,
        }
    }
}

/// One rule's two sides, and their last two values.
struct RuleLines {
    op: Compare,
    left: Side_,
    right: Side_,
    /// The window of a rise or fall, ms.
    window: u64,
    /// The left side's values over the window, for a rise or fall.
    past: VecDeque<(u64, f64)>,
    now: (Option<f64>, Option<f64>),
    before: (Option<f64>, Option<f64>),
    change: Option<f64>,
}

impl RuleLines {
    fn new(rule: &Rule) -> Self {
        Self {
            op: rule.op,
            left: side_for(&rule.left),
            right: side_for(&rule.right),
            window: (rule.hours.unwrap_or(24.0).max(0.0) * HOUR) as u64,
            past: VecDeque::new(),
            now: (None, None),
            before: (None, None),
            change: None,
        }
    }

    fn push(&mut self, bar: &Bar, held: Option<f64>) {
        self.before = self.now;
        self.now = (self.left.push(bar, held), self.right.push(bar, held));
        if matches!(self.op, Compare::RisesMoreThan | Compare::FallsMoreThan) {
            self.change = None;
            if let Some(v) = self.now.0 {
                self.past.push_back((bar.time, v));
                let from = bar.time.saturating_sub(self.window);
                // Keep one value at or before the window's start.
                while self.past.len() > 1 && self.past.get(1).is_some_and(|(t, _)| *t <= from) {
                    self.past.pop_front();
                }
                if let Some(&(t, then)) = self.past.front() {
                    if t <= from && then != 0.0 {
                        self.change = Some(v / then - 1.0);
                    }
                }
            }
        }
    }

    fn holds(&self) -> bool {
        let (Some(l), Some(r)) = self.now else {
            return false;
        };
        match self.op {
            Compare::Above => l > r,
            Compare::Below => l < r,
            Compare::RisesMoreThan => self.change.is_some_and(|c| c > r),
            Compare::FallsMoreThan => self.change.is_some_and(|c| c < -r),
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

/// One condition's rules: a rule alone, or a group's.
struct CondLines {
    when: Match,
    rules: Vec<RuleLines>,
}

impl CondLines {
    fn new(cond: &Cond) -> Self {
        match cond {
            Cond::Rule(r) => Self {
                when: Match::All,
                rules: vec![RuleLines::new(r)],
            },
            Cond::Group(g) => Self {
                when: g.when,
                rules: g.conds.iter().map(RuleLines::new).collect(),
            },
        }
    }

    fn push(&mut self, bar: &Bar, held: Option<f64>) {
        for r in &mut self.rules {
            r.push(bar, held);
        }
    }

    fn holds(&self) -> bool {
        match self.when {
            Match::All => self.rules.iter().all(RuleLines::holds),
            Match::Any => self.rules.iter().any(RuleLines::holds),
        }
    }
}

/// The open trade, as the strategy keeps it.
struct Open {
    dir: f64,
    entry: f64,
    time: u64,
    /// Distance to the first stop, per unit (1R); 0 without one.
    risk: f64,
    stop: Option<f64>,
    target: Option<f64>,
    best: f64,
    size: f64,
    equity: f64,
}

/// The user's own rules: in, on `side`, when the entry conditions hold (all
/// or any); out when the exit ones do, at the stop - moved to the entry
/// and trailed as set - or at the targets, part by part. Sized as set, and
/// kept from opening by the trading hours and the guard rails.
pub struct Custom {
    p: CustomParams,
    entry: Vec<CondLines>,
    exit: Vec<CondLines>,
    atr: Line,
    atr_stop: Option<Line>,
    atr_now: Option<f64>,
    atr_stop_now: Option<f64>,
    swing: VecDeque<(f64, f64)>,
    index: u32,
    open: Option<Open>,
    // Guard rails' state.
    day: u64,
    day_equity: f64,
    trades_today: u32,
    peak: f64,
    streak: u32,
    cool_until: u64,
    halted: bool,
    // The run so far, for Kelly.
    wins: u32,
    losses: u32,
    win_r: f64,
    loss_r: f64,
    funnel: Funnel,
    studies: Vec<(String, bool, Line, Option<f64>)>,
}

/// The averages and RSIs the entry reads, to draw beside its signals.
fn studies_of(p: &CustomParams) -> Vec<(String, bool, Line, Option<f64>)> {
    let mut out: Vec<(String, bool, Line, Option<f64>)> = Vec::new();
    for r in p.entry.iter().flat_map(Cond::rules) {
        for src in [&r.left, &r.right] {
            let (name, pane) = match src {
                Source::Ema { period, on } => (format!("EMA {period}{}", on_label(on)), false),
                Source::Sma { period, on } => (format!("SMA {period}{}", on_label(on)), false),
                Source::Rsi { period, on } => (format!("RSI {period}{}", on_label(on)), true),
                _ => continue,
            };
            if out.len() < 4 && !out.iter().any(|(n, ..)| *n == name) {
                if let Side_::Line(line) = side_for(src) {
                    out.push((name, pane, line, None));
                }
            }
        }
    }
    out
}

fn on_label(on: &Option<crate::CandleInterval>) -> String {
    match on {
        Some(i) => {
            let m = i.millis() / 60_000;
            if m % 1440 == 0 {
                format!(" · {}d", m / 1440)
            } else if m % 60 == 0 {
                format!(" · {}h", m / 60)
            } else {
                format!(" · {m}m")
            }
        }
        None => String::new(),
    }
}

impl Custom {
    pub fn new(p: CustomParams) -> Self {
        let atr_stop = match &p.stop {
            Some(StopRule::Atr { period, .. }) => Some(Line::atr(*period as usize)),
            _ => None,
        };
        Self {
            entry: p.entry.iter().map(CondLines::new).collect(),
            exit: p.exit.iter().map(CondLines::new).collect(),
            atr: Line::atr(14),
            atr_stop,
            atr_now: None,
            atr_stop_now: None,
            swing: VecDeque::new(),
            index: 0,
            open: None,
            day: u64::MAX,
            day_equity: 0.0,
            trades_today: 0,
            peak: 0.0,
            streak: 0,
            cool_until: 0,
            halted: false,
            wins: 0,
            losses: 0,
            win_r: 0.0,
            loss_r: 0.0,
            funnel: Funnel {
                entry: vec![0; p.entry.len()],
                exits: vec![0; p.exit.len()],
                ..Funnel::default()
            },
            studies: studies_of(&p),
            p,
        }
    }

    fn read(&mut self, bar: &Bar, held: Option<f64>) {
        for c in self.entry.iter_mut().chain(self.exit.iter_mut()) {
            c.push(bar, held);
        }
        self.atr_now = self.atr.push(bar);
        if let Some(l) = &mut self.atr_stop {
            self.atr_stop_now = l.push(bar);
        }
        let keep = match &self.p.stop {
            Some(StopRule::Swing { lookback }) => *lookback as usize,
            _ => 0,
        };
        if keep > 0 {
            self.swing.push_back((bar.low, bar.high));
            while self.swing.len() > keep {
                self.swing.pop_front();
            }
        }
        for (_, _, line, value) in &mut self.studies {
            *value = line.push(bar);
        }
    }

    /// The stop for a trade opened at `price`, if it has one.
    fn stop_for(&self, price: f64, dir: f64) -> Option<f64> {
        let stop = match &self.p.stop {
            Some(StopRule::None) => None,
            Some(StopRule::Fixed { pct }) => Some(price * (1.0 - dir * pct)),
            Some(StopRule::Atr { mult, .. }) => {
                let atr = self.atr_stop_now.unwrap_or(price * 0.01);
                Some(price - dir * mult * atr)
            }
            Some(StopRule::Swing { .. }) => {
                if self.swing.is_empty() {
                    None
                } else if dir > 0.0 {
                    Some(
                        self.swing
                            .iter()
                            .map(|(l, _)| *l)
                            .fold(f64::INFINITY, f64::min),
                    )
                } else {
                    Some(
                        self.swing
                            .iter()
                            .map(|(_, h)| *h)
                            .fold(f64::NEG_INFINITY, f64::max),
                    )
                }
            }
            None => (self.p.stop_loss > 0.0).then_some(price * (1.0 - dir * self.p.stop_loss)),
        };
        // A stop on the wrong side of the price isn't one.
        stop.filter(|s| s.is_finite() && *s > 0.0 && (price - s) * dir > EPS)
    }

    /// The notional for a trade at `price` on `equity`, stopped at `stop`.
    fn notional(&self, price: f64, equity: f64, stop: Option<f64>) -> Option<f64> {
        let dist = stop.map(|s| (price - s).abs() / price);
        let by_risk = |risk: f64| dist.filter(|d| *d > EPS).map(|d| equity * risk / d);
        let n = match &self.p.sizing {
            None => Some(equity * self.p.size),
            Some(Sizing::Fixed { amount }) => Some(*amount),
            Some(Sizing::Equity { share }) => Some(equity * share),
            Some(Sizing::Risk { risk }) => by_risk(*risk),
            Some(Sizing::Volatility { target }) => {
                let swing = self.atr_now.map(|a| a / price).filter(|v| *v > EPS);
                swing.map(|v| equity * target / v)
            }
            Some(Sizing::Kelly { fraction, max_risk }) => {
                let n = self.wins + self.losses;
                let risk = if n < 10 || self.losses == 0 || self.wins == 0 {
                    max_risk / 2.0
                } else {
                    let w = f64::from(self.wins) / f64::from(n);
                    let payoff = (self.win_r / f64::from(self.wins))
                        / (self.loss_r / f64::from(self.losses)).max(EPS);
                    let kelly = w - (1.0 - w) / payoff.max(EPS);
                    (kelly * fraction).clamp(max_risk / 10.0, *max_risk)
                };
                by_risk(risk)
            }
        }?;
        let lev = self.p.max_leverage.unwrap_or(f64::INFINITY);
        let mut n = n.min(equity * lev);
        if let Some(share) = self.p.max_share {
            n = n.min(equity * share * self.p.max_leverage.unwrap_or(1.0));
        }
        (n.is_finite() && n > EPS).then_some(n)
    }

    /// Whether the hours and the guard rails let a trade open now.
    fn allowed(&self, bar: &Bar, equity: f64) -> bool {
        if let Some(h) = &self.p.hours {
            let minute = ((bar.time % DAY_MS) / 60_000) as u32;
            let inside = if h.from < h.to {
                minute >= h.from && minute < h.to
            } else {
                minute >= h.from || minute < h.to
            };
            // 1970-01-01 was a Thursday: day 0 is weekday 4 (Mon = 1).
            let weekday = (bar.time / DAY_MS + 4) % 7;
            if !inside || (h.weekdays && (weekday == 0 || weekday == 6)) {
                return false;
            }
        }
        let g = &self.p.guards;
        if g.daily_loss
            .is_some_and(|l| self.day_equity > 0.0 && equity <= self.day_equity * (1.0 - l))
        {
            return false;
        }
        if g.trades_per_day.is_some_and(|n| self.trades_today >= n) {
            return false;
        }
        bar.time >= self.cool_until
    }

    /// The trade just closed: what it came to, for Kelly and the cool-off.
    fn closed(&mut self, o: &Open, equity: f64, time: u64) {
        let pnl = equity - o.equity;
        let risk = (o.risk * o.size).max(o.entry * o.size * 0.01).max(EPS);
        if pnl > 0.0 {
            self.wins += 1;
            self.win_r += pnl / risk;
            self.streak = 0;
        } else {
            self.losses += 1;
            self.loss_r += -pnl / risk;
            self.streak += 1;
            if let Some(c) = &self.p.guards.cool_off {
                if self.streak >= c.losses {
                    self.cool_until = time + (c.hours * HOUR) as u64;
                    self.streak = 0;
                }
            }
        }
    }

    fn cancel_targets(&self, out: &mut Vec<Intent>) {
        for i in 0..self.p.targets.len() {
            out.push(Intent::Cancel {
                tag: format!("tp{i}"),
            });
        }
    }
}

impl Strategy for Custom {
    fn warm(&mut self, bars: &[Bar]) {
        for bar in bars {
            self.read(bar, None);
        }
    }

    fn on_bar(&mut self, s: &Snapshot<'_>) -> Vec<Intent> {
        let bar = last(s);
        let index = self.index;
        self.index += 1;
        let holding = s.position.abs() > EPS;
        let held = self
            .open
            .as_ref()
            .filter(|_| holding)
            .map(|o| bar.time.saturating_sub(o.time) as f64 / HOUR);
        self.read(&bar, held);
        let mut out = Vec::new();
        if self.halted {
            return out;
        }
        let today = bar.time / DAY_MS;
        if today != self.day {
            self.day = today;
            self.day_equity = s.equity;
            self.trades_today = 0;
        }
        self.peak = self.peak.max(s.equity);
        if let Some(dd) = self.p.guards.max_drawdown {
            if s.equity <= self.peak * (1.0 - dd) {
                self.halted = true;
                if holding {
                    out.push(Intent::Close {
                        reason: Reason::Guard,
                    });
                }
                out.push(Intent::Halt {
                    reason: Reason::Guard,
                });
                return out;
            }
        }
        // Closed since the last candle (a stop, a target, a rule).
        if !holding {
            if let Some(o) = self.open.take() {
                self.closed(&o, s.equity, bar.time);
                self.cancel_targets(&mut out);
            }
        }
        if holding {
            let Some(o) = self.open.as_mut() else {
                return out;
            };
            // The exit conditions.
            let hit: Vec<usize> = self
                .exit
                .iter()
                .enumerate()
                .filter(|(_, c)| c.holds())
                .map(|(i, _)| i)
                .collect();
            let out_now = match self.p.exit_match {
                Match::Any => !hit.is_empty(),
                Match::All => !self.exit.is_empty() && hit.len() == self.exit.len(),
            };
            if out_now {
                if let Some(slot) = hit.first().and_then(|i| self.funnel.exits.get_mut(*i)) {
                    *slot += 1;
                }
                out.push(Intent::Close {
                    reason: Reason::Rule,
                });
                return out;
            }
            // Moving the stop: to the entry, then along behind the best price.
            o.best = if o.dir > 0.0 {
                o.best.max(bar.high)
            } else {
                o.best.min(bar.low)
            };
            if o.risk > EPS {
                let up = (o.best - o.entry) * o.dir / o.risk;
                let mut stop = o.stop;
                let better = |a: Option<f64>, b: f64| match a {
                    Some(a) if (b - a) * o.dir <= 0.0 => a,
                    _ => b,
                };
                if self.p.breakeven_at.is_some_and(|r| up >= r) {
                    stop = Some(better(stop, o.entry));
                }
                if let (Some(t), Some(atr)) = (&self.p.trail, self.atr_now) {
                    if up >= t.from_r {
                        stop = Some(better(stop, o.best - o.dir * t.atr * atr));
                    }
                }
                if stop != o.stop {
                    o.stop = stop;
                    out.push(Intent::Exits {
                        stop,
                        target: o.target,
                        stop_reason: Reason::Stop,
                    });
                }
            }
            return out;
        }

        // Flat: the entry conditions, and how they filtered.
        let holds: Vec<bool> = self.entry.iter().map(CondLines::holds).collect();
        let pass = match self.p.entry_match {
            Match::All => {
                let mut all = true;
                for (i, h) in holds.iter().enumerate() {
                    all &= *h;
                    if all {
                        self.funnel.entry[i] += 1;
                    }
                }
                all && !holds.is_empty()
            }
            Match::Any => {
                for (i, h) in holds.iter().enumerate() {
                    if *h {
                        self.funnel.entry[i] += 1;
                    }
                }
                holds.iter().any(|h| *h)
            }
        };
        if !pass {
            if holds.first() == Some(&true) && self.funnel.filtered.len() < 5000 {
                self.funnel.filtered.push(index);
            }
            return out;
        }
        if self.funnel.passed.len() < 5000 {
            self.funnel.passed.push(index);
        }
        if !self.allowed(&bar, s.equity) {
            self.funnel.blocked += 1;
            return out;
        }
        let dir = if self.p.side == pewterdesk_core::PositionSide::Long {
            1.0
        } else {
            -1.0
        };
        let stop = self.stop_for(bar.close, dir);
        let needs_stop = matches!(
            self.p.sizing,
            Some(Sizing::Risk { .. } | Sizing::Kelly { .. })
        ) || self.p.breakeven_at.is_some()
            || self.p.trail.is_some()
            || !self.p.targets.is_empty();
        if needs_stop && stop.is_none() {
            self.funnel.blocked += 1;
            return out;
        }
        let Some(notional) = self.notional(bar.close, s.equity, stop) else {
            self.funnel.blocked += 1;
            return out;
        };
        let size = notional / bar.close;
        let liquidation = {
            let lev = self
                .p
                .max_leverage
                .unwrap_or_else(|| (notional / s.equity.max(EPS)).max(1.0));
            let at = match self.p.margin.unwrap_or(MarginMode::Isolated) {
                MarginMode::Isolated => bar.close * (1.0 - dir * (1.0 / lev - MAINTENANCE)),
                MarginMode::Cross => {
                    bar.close - dir * (s.equity - notional * MAINTENANCE).max(0.0) / size
                }
            };
            (at.is_finite() && at > 0.0).then_some(at)
        };
        let risk = stop.map_or(0.0, |st| (bar.close - st).abs());
        let target = (self.p.targets.is_empty() && self.p.take_profit > 0.0)
            .then_some(bar.close * (1.0 + dir * self.p.take_profit));
        out.push(Intent::Market {
            side: if dir > 0.0 { Side::Buy } else { Side::Sell },
            size,
            reduce_only: false,
            reason: Reason::Entry,
            stop,
            liquidation,
        });
        if stop.is_some() || target.is_some() {
            out.push(Intent::Exits {
                stop,
                target,
                stop_reason: Reason::Stop,
            });
        }
        for (i, t) in self.p.targets.iter().enumerate() {
            out.push(Intent::Limit {
                tag: format!("tp{i}"),
                side: if dir > 0.0 { Side::Sell } else { Side::Buy },
                price: bar.close + dir * t.at_r * risk,
                size: size * t.close,
                reduce_only: true,
                closes: None,
                stop: None,
                reason: Some(Reason::Target),
            });
        }
        self.trades_today += 1;
        self.open = Some(Open {
            dir,
            entry: bar.close,
            time: bar.time,
            risk,
            stop,
            target,
            best: bar.close,
            size,
            equity: s.equity,
        });
        out
    }

    fn lines(&self) -> Vec<(&'static str, Option<f64>)> {
        // The first two averages, as an EMA cross's are drawn.
        let mut avg = self.studies.iter().filter(|(_, pane, ..)| !pane);
        vec![
            ("fast", avg.next().and_then(|(.., v)| *v)),
            ("slow", avg.next().and_then(|(.., v)| *v)),
        ]
    }

    fn studies(&self) -> Vec<(String, bool, Option<f64>)> {
        self.studies
            .iter()
            .map(|(n, pane, _, v)| (n.clone(), *pane, *v))
            .collect()
    }

    fn funnel(&self) -> Option<Funnel> {
        Some(self.funnel.clone())
    }
}
