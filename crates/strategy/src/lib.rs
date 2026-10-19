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
        })
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
    Price,
    Ema { period: u32 },
    Sma { period: u32 },
    Rsi { period: u32 },
    Value { value: f64 },
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export_to = TS_FILE)]
pub enum Compare {
    CrossesAbove,
    CrossesBelow,
    Above,
    Below,
}

/// "EMA 20 crosses above EMA 50", read on each candle's close.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export_to = TS_FILE)]
pub struct Rule {
    pub left: Source,
    pub op: Compare,
    pub right: Source,
}

/// In when every entry rule holds, out when any exit rule does.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export_to = TS_FILE)]
pub struct CustomParams {
    pub side: pewterdesk_core::PositionSide,
    pub entry: Vec<Rule>,
    pub exit: Vec<Rule>,
    /// From the entry, as fractions (0.03 = 3%); 0 for none.
    pub stop_loss: f64,
    pub take_profit: f64,
    /// The position's notional as a fraction of equity (1 = 1x).
    pub size: f64,
}

/// A bot's strategy: a template and its settings.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, TS)]
#[serde(tag = "template", rename_all = "camelCase")]
#[ts(export_to = TS_FILE)]
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
                if !positive(p.size) || p.size > 20.0 {
                    return Err("the size is up to 20x equity".into());
                }
                if p.stop_loss < 0.0 || p.take_profit < 0.0 {
                    return Err("stops and targets are fractions above zero".into());
                }
            }
        }
        Ok(())
    }
}
