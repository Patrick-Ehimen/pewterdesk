//! `pewterdesk-strategy`: bots' strategies, and the backtester that runs
//! them (`docs/bots/bots.md`).
//!
//! A strategy is a function of what it's shown: each closed candle, with
//! its own position and resting orders, in; intents out - "buy this much at
//! market", "rest a limit here", "close everything". It never sees a key, a
//! venue or the network. The same strategy, fed the same candles, says the
//! same things whether a backtest, paper trading or the engine's bot host
//! runs it: only what fills its intents differs (the backtester's fill
//! model, or the venue through the router).
//!
//! Security-relevant (docs/bots/safety.md, rule 8): no I/O in this crate.

pub mod bot;
pub mod indicators;
pub mod lab;
pub mod sim;
pub mod templates;

use pewterdesk_core::Side;
use serde::{Deserialize, Serialize};
use ts_rs::TS;

/// Where ts-rs writes these types (`make rust-bindings`): exported one by
/// one in `tests/bindings.rs`, never with their dependencies.
const TS_FILE: &str = "strategy.ts";

/// One closed candle, in plain numbers. `time` is when it opened, in ms.
#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize, TS)]
#[ts(export_to = TS_FILE)]
pub struct Bar {
    #[ts(type = "number")]
    pub time: u64,
    pub open: f64,
    pub high: f64,
    pub low: f64,
    pub close: f64,
    /// Traded over the candle, in base units; 0 where unknown.
    #[serde(default)]
    #[ts(as = "Option<f64>", optional)]
    pub volume: f64,
    /// The funding rate in force at the candle's close, per 8 hours, as a
    /// fraction; where the venue's history has it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub funding: Option<f64>,
    /// Open interest at the candle's close, in base units; where known.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub oi: Option<f64>,
}

impl Bar {
    /// A venue's candle as numbers; `None` if one doesn't read as a number.
    pub fn from_candle(c: &pewterdesk_core::Candle) -> Option<Self> {
        let f = |d: &pewterdesk_core::Decimal| d.0.to_string().parse::<f64>().ok();
        Some(Self {
            time: c.open_time,
            open: f(&c.open)?,
            high: f(&c.high)?,
            low: f(&c.low)?,
            close: f(&c.close)?,
            volume: f(&c.volume).unwrap_or(0.0),
            funding: None,
            oi: None,
        })
    }

    /// A candle of prices only.
    pub fn ohlc(time: u64, open: f64, high: f64, low: f64, close: f64) -> Self {
        Self {
            time,
            open,
            high,
            low,
            close,
            volume: 0.0,
            funding: None,
            oi: None,
        }
    }
}

/// Why a position was opened or closed, as the trade list says it.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export_to = TS_FILE)]
pub enum Reason {
    /// The moving averages crossed.
    Cross,
    /// The protective stop.
    Stop,
    /// The run ended with it open.
    End,
    /// A grid level's own exit, one level up.
    Grid,
    /// The grid's range was left: flattened, and the bot stopped.
    StopOut,
    /// A custom rule said so.
    Rule,
    /// The take-profit.
    Target,
    /// A DCA buy, on its schedule.
    Schedule,
    /// A per-bot limit was hit.
    Limit,
    /// An entry.
    Entry,
    /// The position's margin ran out before its stop.
    Liquidation,
    /// The rule to stop at a drawdown (a guard rail).
    Guard,
}

/// What a strategy asks for. The bot host, or the backtester, carries it
/// out; nothing here sends anything.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, TS)]
#[serde(tag = "kind", rename_all = "camelCase")]
#[ts(export_to = TS_FILE, rename = "BotIntent")]
pub enum Intent {
    /// At market, now: at this candle's close in a backtest.
    #[serde(rename_all = "camelCase")]
    Market {
        side: Side,
        size: f64,
        reduce_only: bool,
        reason: Reason,
        /// The stop it's meant to have, for its risk (1R).
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        stop: Option<f64>,
        /// Where the position it opens would be liquidated, if the margin
        /// runs out before the stop (a backtest closes it there).
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        liquidation: Option<f64>,
    },
    /// A resting limit, known by `tag`: one with the same tag is replaced.
    #[serde(rename_all = "camelCase")]
    Limit {
        tag: String,
        side: Side,
        price: f64,
        size: f64,
        reduce_only: bool,
        /// The tag of the order whose position this one closes (a grid
        /// level's sell closes that level's buy); else the oldest.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        closes: Option<String>,
        /// The stop it's meant to have, for its risk (1R).
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        stop: Option<f64>,
        /// What its fill is called in the trade list (a take-profit's
        /// "target"); a reduce-only limit is a grid's level otherwise.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        reason: Option<Reason>,
    },
    /// Takes the resting limit `tag` off.
    Cancel { tag: String },
    /// The whole position's protective stop and take-profit; `None` takes
    /// one off. When either fires, the bot's resting orders are cancelled.
    #[serde(rename_all = "camelCase")]
    Exits {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        stop: Option<f64>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        target: Option<f64>,
        /// What the stop firing is called ("stop", or a grid's "stopOut").
        stop_reason: Reason,
    },
    /// Closes the whole position at market.
    Close { reason: Reason },
    /// Stops the bot: its resting orders are cancelled, and it asks for
    /// nothing more.
    Halt { reason: Reason },
}

/// A resting limit, as the strategy placed it.
#[derive(Clone, Debug, PartialEq)]
pub struct Resting {
    pub tag: String,
    pub side: Side,
    pub price: f64,
    pub size: f64,
}

/// What a strategy is shown with each candle.
#[derive(Clone, Copy, Debug)]
pub struct Snapshot<'a> {
    /// Every closed candle so far, the newest last.
    pub bars: &'a [Bar],
    /// Its position, in base units: above zero long, below short.
    pub position: f64,
    /// The position's average entry; 0 when flat.
    pub entry: f64,
    /// Equity at this candle's close, marked to market.
    pub equity: f64,
    pub resting: &'a [Resting],
}

/// A fill of one of its orders, as the strategy hears of it.
#[derive(Clone, Debug, PartialEq)]
pub struct Fill {
    /// The limit's tag; `None` for a market order or an exit.
    pub tag: Option<String>,
    pub side: Side,
    pub price: f64,
    pub size: f64,
    pub reason: Reason,
}

/// A strategy: candles in, intents out.
pub trait Strategy: Send + Sync {
    /// The candle just closed (the last in `snapshot.bars`): what to do now.
    fn on_bar(&mut self, snapshot: &Snapshot<'_>) -> Vec<Intent>;

    /// One of its orders filled (or an exit fired).
    fn on_fill(&mut self, _fill: &Fill) {}

    /// Its resting limit `tag` is gone without filling (the venue cancelled
    /// it): it may ask for it again.
    fn on_gone(&mut self, _tag: &str) {}

    /// History from before it started: candles to read (an average's
    /// warm-up), not to act on.
    fn warm(&mut self, _bars: &[Bar]) {}

    /// Lines to draw with its trades (an EMA cross's two), at the last candle.
    fn lines(&self) -> Vec<(&'static str, Option<f64>)> {
        Vec::new()
    }

    /// How its conditions filtered the run, for a rules strategy.
    fn funnel(&self) -> Option<Funnel> {
        None
    }

    /// Indicators it reads, to draw with its signals, at the last candle:
    /// a name, whether it goes in a pane of its own (an RSI), its value.
    fn studies(&self) -> Vec<(String, bool, Option<f64>)> {
        Vec::new()
    }
}

/// How a rules strategy's conditions filtered a run.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export_to = TS_FILE)]
pub struct Funnel {
    /// Per entry condition, in order: the candles (while flat) on which it
    /// and every condition before it held; with "any", on which it held.
    pub entry: Vec<u32>,
    /// Per exit condition: the trades it closed.
    pub exits: Vec<u32>,
    /// Candles (by index) on which every entry condition held while flat.
    pub passed: Vec<u32>,
    /// Candles on which the first entry condition held but the rest didn't.
    pub filtered: Vec<u32>,
    /// Signals the trading hours or a guard rail kept from opening.
    pub blocked: u32,
}

/// Which way an EMA cross trades.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export_to = TS_FILE)]
pub enum Direction {
    Both,
    Long,
    Short,
}

/// An EMA cross with an ATR stop, sized by risk.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export_to = TS_FILE)]
pub struct EmaParams {
    pub fast: u32,
    pub slow: u32,
    /// The stop, in ATR(14) multiples from the entry.
    pub stop_atr: f64,
    /// Equity put at risk by each trade, as a fraction (0.01 = 1%).
    pub risk: f64,
    pub max_leverage: f64,
    pub direction: Direction,
}

/// Buys at each level of a range and sells each one level up.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export_to = TS_FILE)]
pub struct GridParams {
    pub lower: f64,
    pub upper: f64,
    pub levels: u32,
    /// In base units, bought or sold at each level.
    pub size_per_level: f64,
    /// Below `stop_below` or above `stop_above` it flattens and stops.
    pub stop_below: f64,
    pub stop_above: f64,
}

/// Buys a fixed amount every so often, and takes profit on the whole.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export_to = TS_FILE)]
pub struct DcaParams {
    /// A buy every this many candles.
    pub every: u32,
    /// Each buy, in the quote asset.
    pub amount: f64,
    /// Sold when the price is this far above the average entry (0.05 = 5%).
    pub take_profit: f64,
    /// The most buys before a take-profit.
    pub max_buys: u32,
}

/// What a custom rule reads.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, TS)]
#[serde(tag = "kind", rename_all = "camelCase")]
#[ts(export_to = TS_FILE)]
pub enum Source {
    /// The close.
    Price,
    /// An average or RSI, on the run's own candles, or on longer ones
    /// (`on`: "1d" over 4h candles) built from them - only closed ones.
    Ema {
        period: u32,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        on: Option<CandleInterval>,
    },
    Sma {
        period: u32,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        on: Option<CandleInterval>,
    },
    Rsi {
        period: u32,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        on: Option<CandleInterval>,
    },
    Value {
        value: f64,
    },
    /// The candle's volume.
    Volume,
    /// The volume's simple average over `period` candles.
    VolumeAvg {
        period: u32,
    },
    /// The funding rate per 8 hours, a fraction (0.0003 = 0.03%).
    Funding,
    /// Open interest, in base units.
    OpenInterest,
    /// Hours the position has been open; nothing while flat.
    HeldHours,
}

pub use pewterdesk_core::CandleInterval;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export_to = TS_FILE)]
pub enum Compare {
    CrossesAbove,
    CrossesBelow,
    Above,
    Below,
    /// The left side rose by more than the right (a fraction) over `hours`.
    RisesMoreThan,
    /// The left side fell by more than the right (a fraction) over `hours`.
    FallsMoreThan,
}

/// "EMA 20 crosses above EMA 50", read on each candle's close.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export_to = TS_FILE)]
pub struct Rule {
    pub left: Source,
    pub op: Compare,
    pub right: Source,
    /// The window of a rise or fall, in hours (24 if unset).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub hours: Option<f64>,
}

impl Rule {
    pub fn new(left: Source, op: Compare, right: Source) -> Self {
        Self {
            left,
            op,
            right,
            hours: None,
        }
    }
}

/// Whether every condition must hold, or any one.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export_to = TS_FILE)]
pub enum Match {
    #[default]
    All,
    Any,
}

/// Conditions taken together, inside a strategy's own.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export_to = TS_FILE)]
pub struct Group {
    #[serde(rename = "match")]
    pub when: Match,
    pub conds: Vec<Rule>,
}

/// One condition: a rule, or a group of them.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, TS)]
#[serde(untagged)]
#[ts(export_to = TS_FILE)]
pub enum Cond {
    Rule(Rule),
    Group(Group),
}

impl From<Rule> for Cond {
    fn from(r: Rule) -> Self {
        Cond::Rule(r)
    }
}

impl Cond {
    pub fn rules(&self) -> Vec<&Rule> {
        match self {
            Cond::Rule(r) => vec![r],
            Cond::Group(g) => g.conds.iter().collect(),
        }
    }
}

/// How big each trade is.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, TS)]
#[serde(tag = "kind", rename_all = "camelCase")]
#[ts(export_to = TS_FILE)]
pub enum Sizing {
    /// The same notional, in the quote asset, every trade.
    Fixed { amount: f64 },
    /// A share of equity as notional (1 = 1x).
    Equity { share: f64 },
    /// Loses `risk` of equity (0.01 = 1%) at the stop.
    Risk { risk: f64 },
    /// Notional so the position swings `target` of equity on a typical
    /// candle (ATR 14): smaller when the market swings more.
    Volatility { target: f64 },
    /// Kelly's share of equity at the stop, from the run's own win rate and
    /// payoff so far, times `fraction` (¼), at most `max_risk`; `max_risk`
    /// halved until ten trades have closed.
    Kelly {
        fraction: f64,
        #[serde(rename = "maxRisk")]
        max_risk: f64,
    },
}

pub use pewterdesk_core::MarginMode;

/// Where the idea is wrong.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, TS)]
#[serde(tag = "kind", rename_all = "camelCase")]
#[ts(export_to = TS_FILE)]
pub enum StopRule {
    /// A fraction from the entry (0.03 = 3%).
    Fixed {
        pct: f64,
    },
    /// `mult` ATRs of `period` candles from the entry.
    Atr {
        mult: f64,
        period: u32,
    },
    /// Beyond the lowest low (highest high, short) of the last `lookback` candles.
    Swing {
        lookback: u32,
    },
    None,
}

/// The stop trails the best price by `atr` ATR(14)s, once the trade is
/// `from_r` in profit.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export_to = TS_FILE)]
pub struct Trail {
    pub atr: f64,
    pub from_r: f64,
}

/// Part of the position taken off at a profit, in R.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export_to = TS_FILE)]
pub struct Target {
    pub at_r: f64,
    /// The share of the opening size closed there (0.4 = 40%).
    pub close: f64,
}

/// After `losses` losing trades in a row, no new trade for `hours`.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export_to = TS_FILE)]
pub struct CoolOff {
    pub losses: u32,
    pub hours: f64,
}

/// The account's own limits, as the trading rules set them; each only
/// keeps a trade from opening, but the drawdown, which ends the test.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export_to = TS_FILE)]
pub struct Guards {
    /// No new trades until 00:00 UTC once the day has lost this share of
    /// its opening equity.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub daily_loss: Option<f64>,
    /// The test stops, flat, once equity is this far below its high.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub max_drawdown: Option<f64>,
    /// The most trades opened in a UTC day.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub trades_per_day: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub cool_off: Option<CoolOff>,
}

/// When a trade may open: between two times of the UTC day (minutes from
/// midnight; `from` after `to` wraps past midnight), weekdays only if set.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export_to = TS_FILE)]
pub struct Hours {
    pub from: u32,
    pub to: u32,
    pub weekdays: bool,
}

fn match_any() -> Match {
    Match::Any
}

/// In when the entry conditions hold, out when the exit ones do, or at the
/// stop or a target; sized, stopped and guarded as set.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export_to = TS_FILE)]
pub struct CustomParams {
    pub side: pewterdesk_core::PositionSide,
    pub entry: Vec<Cond>,
    /// All if unset.
    #[serde(default)]
    #[ts(as = "Option<Match>", optional)]
    pub entry_match: Match,
    pub exit: Vec<Cond>,
    /// Any if unset.
    #[serde(default = "match_any")]
    #[ts(as = "Option<Match>", optional)]
    pub exit_match: Match,
    /// From the entry, as fractions (0.03 = 3%); 0 for none. `stop` and
    /// `targets`, when set, take their place.
    pub stop_loss: f64,
    pub take_profit: f64,
    /// The position's notional as a fraction of equity (1 = 1x); `sizing`,
    /// when set, takes its place.
    pub size: f64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub sizing: Option<Sizing>,
    /// Notional at most this many times equity.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub max_leverage: Option<f64>,
    /// Isolated if unset.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub margin: Option<MarginMode>,
    /// Margin in one market at most this share of equity.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub max_share: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub stop: Option<StopRule>,
    /// The stop moves to the entry once the trade is this many R up.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub breakeven_at: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub trail: Option<Trail>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub targets: Vec<Target>,
    #[serde(default)]
    #[ts(as = "Option<Guards>", optional)]
    pub guards: Guards,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub hours: Option<Hours>,
}

impl CustomParams {
    /// Rules on `side`, sized `size` times equity, with nothing else set.
    pub fn simple(side: pewterdesk_core::PositionSide, entry: Vec<Cond>, exit: Vec<Cond>) -> Self {
        Self {
            side,
            entry,
            entry_match: Match::All,
            exit,
            exit_match: Match::Any,
            stop_loss: 0.0,
            take_profit: 0.0,
            size: 1.0,
            sizing: None,
            max_leverage: None,
            margin: None,
            max_share: None,
            stop: None,
            breakeven_at: None,
            trail: None,
            targets: Vec::new(),
            guards: Guards::default(),
            hours: None,
        }
    }

    /// Whether it reads funding, or open interest.
    pub fn reads(&self) -> (bool, bool) {
        let rules = self.entry.iter().chain(&self.exit).flat_map(Cond::rules);
        let mut funding = false;
        let mut oi = false;
        for r in rules {
            for s in [&r.left, &r.right] {
                funding |= matches!(s, Source::Funding);
                oi |= matches!(s, Source::OpenInterest);
            }
        }
        (funding, oi)
    }
}

/// A bot's strategy: a template and its settings.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, TS)]
#[serde(tag = "template", rename_all = "camelCase")]
#[ts(export_to = TS_FILE)]
// Rules are the biggest; a strategy is made once a run, so it isn't boxed.
#[allow(clippy::large_enum_variant)]
pub enum StrategyConfig {
    Ema(EmaParams),
    Grid(GridParams),
    Dca(DcaParams),
    Custom(CustomParams),
}

impl StrategyConfig {
    /// The strategy, ready for its first candle; or why the settings can't run.
    pub fn build(&self) -> Result<Box<dyn Strategy>, String> {
        self.check()?;
        Ok(match self {
            StrategyConfig::Ema(p) => Box::new(templates::Trend::new(p.clone())),
            StrategyConfig::Grid(p) => Box::new(templates::Grid::new(p.clone())),
            StrategyConfig::Dca(p) => Box::new(templates::Dca::new(p.clone())),
            StrategyConfig::Custom(p) => Box::new(templates::Custom::new(p.clone())),
        })
    }

    /// Whether the settings make sense.
    pub fn check(&self) -> Result<(), String> {
        let positive = |v: f64| v.is_finite() && v > 0.0;
        match self {
            StrategyConfig::Ema(p) => {
                if p.fast == 0 || p.slow <= p.fast {
                    return Err("the slow average must be longer than the fast".into());
                }
                if !positive(p.stop_atr) || !positive(p.risk) || p.risk > 0.1 {
                    return Err("risk is 0 to 10% of equity, with a stop".into());
                }
                if !positive(p.max_leverage) || p.max_leverage > 20.0 {
                    return Err("leverage is up to 20x".into());
                }
            }
            StrategyConfig::Grid(p) => {
                if p.levels < 2
                    || p.levels > 200
                    || !positive(p.lower)
                    || !p.upper.is_finite()
                    || p.upper <= p.lower
                {
                    return Err("a grid has 2 to 200 levels across a range".into());
                }
                if !positive(p.size_per_level) {
                    return Err("each level needs a size".into());
                }
                let stops_outside = p.stop_below.is_finite()
                    && p.stop_above.is_finite()
                    && p.stop_below < p.lower
                    && p.stop_above > p.upper;
                if !stops_outside {
                    return Err("the stops go outside the range".into());
                }
            }
            StrategyConfig::Dca(p) => {
                if p.every == 0 || !positive(p.amount) || p.max_buys == 0 {
                    return Err("a DCA buys an amount, every so often, a number of times".into());
                }
                if !positive(p.take_profit) {
                    return Err("a DCA needs a take-profit".into());
                }
            }
            StrategyConfig::Custom(p) => {
                if p.entry.is_empty() {
                    return Err("a custom bot needs an entry rule".into());
                }
                if p.entry.iter().chain(&p.exit).any(|c| match c {
                    Cond::Group(g) => g.conds.is_empty(),
                    Cond::Rule(_) => false,
                }) {
                    return Err("a group needs a condition in it".into());
                }
                if !positive(p.size) || p.size > 20.0 {
                    return Err("the size is up to 20x equity".into());
                }
                if p.stop_loss < 0.0 || p.take_profit < 0.0 {
                    return Err("stops and targets are fractions above zero".into());
                }
                match &p.sizing {
                    Some(Sizing::Fixed { amount }) if !positive(*amount) => {
                        return Err("a fixed size needs an amount".into())
                    }
                    Some(Sizing::Equity { share }) if !positive(*share) || *share > 20.0 => {
                        return Err("a share of equity is up to 20x".into())
                    }
                    Some(Sizing::Risk { risk }) if !positive(*risk) || *risk > 0.1 => {
                        return Err("risk is 0 to 10% of equity a trade".into())
                    }
                    Some(Sizing::Volatility { target }) if !positive(*target) || *target > 0.2 => {
                        return Err("a volatility target is 0 to 20% of equity".into())
                    }
                    Some(Sizing::Kelly { fraction, max_risk })
                        if !positive(*fraction)
                            || *fraction > 1.0
                            || !positive(*max_risk)
                            || *max_risk > 0.1 =>
                    {
                        return Err("Kelly takes a fraction up to 1, and risk up to 10%".into())
                    }
                    _ => {}
                }
                let stopped = match &p.stop {
                    Some(StopRule::None) => false,
                    Some(_) => true,
                    None => p.stop_loss > 0.0,
                };
                if matches!(p.sizing, Some(Sizing::Risk { .. } | Sizing::Kelly { .. })) && !stopped
                {
                    return Err("sizing by risk needs a stop".into());
                }
                match &p.stop {
                    Some(StopRule::Fixed { pct }) if !positive(*pct) || *pct >= 1.0 => {
                        return Err("a stop is above 0% and under 100%".into())
                    }
                    Some(StopRule::Atr { mult, period })
                        if !positive(*mult) || *period == 0 || *period > 200 =>
                    {
                        return Err("an ATR stop needs a multiple and a period".into())
                    }
                    Some(StopRule::Swing { lookback }) if *lookback < 2 || *lookback > 500 => {
                        return Err("a swing stop looks back 2 to 500 candles".into())
                    }
                    _ => {}
                }
                if p.max_leverage.is_some_and(|l| !positive(l) || l > 100.0)
                    || p.max_share.is_some_and(|s| !positive(s) || s > 1.0)
                {
                    return Err("leverage up to 100x, and a share of equity up to 100%".into());
                }
                if (p.breakeven_at.is_some() || p.trail.is_some() || !p.targets.is_empty())
                    && !stopped
                {
                    return Err("moving the stop, trailing and targets in R need a stop".into());
                }
                if p.breakeven_at.is_some_and(|r| !positive(r))
                    || p.trail
                        .as_ref()
                        .is_some_and(|t| !positive(t.atr) || t.from_r < 0.0)
                {
                    return Err("the stop moves once the trade is some R up".into());
                }
                let closed: f64 = p.targets.iter().map(|t| t.close).sum();
                if p.targets
                    .iter()
                    .any(|t| !positive(t.at_r) || !positive(t.close))
                    || closed > 1.0 + 1e-9
                {
                    return Err("targets are above 0R, and close at most the whole".into());
                }
                let g = &p.guards;
                if g.daily_loss.is_some_and(|v| !positive(v) || v >= 1.0)
                    || g.max_drawdown.is_some_and(|v| !positive(v) || v >= 1.0)
                    || g.trades_per_day == Some(0)
                    || g.cool_off
                        .as_ref()
                        .is_some_and(|c| c.losses == 0 || !positive(c.hours))
                {
                    return Err("each guard rail needs a value above zero".into());
                }
                if p.hours
                    .as_ref()
                    .is_some_and(|h| h.from >= 1440 || h.to > 1440 || h.from == h.to)
                {
                    return Err("trading hours are two different times of the day".into());
                }
            }
        }
        Ok(())
    }
}
