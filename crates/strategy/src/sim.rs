//! The backtester, a candle at a time: a strategy, its account, and the
//! fill model that carries out its intents. A backtest feeds it history;
//! paper trading feeds it each live candle as it closes. Same strategy,
//! same candles, same intents and the same fills either way.
//!
//! # The fill model
//!
//! Conservative, and the same as the Bots page's preview:
//!
//! - A market order a strategy asks for at a candle's close fills at that
//!   close, worse by the slippage (`slippage_bps`), paying the taker fee.
//! - A resting limit fills on a later candle that reaches its price: a buy
//!   when the low is at or below it, a sell when the high is at or above
//!   it, at its price - or at the open, if the candle opened past it. It
//!   pays the maker fee, with no slippage. It never fills on the candle it
//!   was placed on.
//! - A position's stop fills, worse by the slippage, when a candle reaches
//!   it (at the open if it opened past it); its take-profit fills at its
//!   price like a limit. When a candle reaches both, the stop is taken to
//!   have come first. Either cancels the strategy's resting orders.
//! - Within a candle: the position's exits first, then resting limits in
//!   the order they were placed, then the strategy's turn at the close.
//! - Funding: a long pays (a short receives) `funding_8h` of its entry
//!   notional every 8 hours it's held, accrued each candle.
//! - Whatever is open at the end is closed at the last close ("end").
//!
//! Not modelled: queues (a limit at a price that's touched is taken to
//! fill), partial fills, the order book's depth, funding that changes.

use pewterdesk_core::Side;
use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::{Bar, Fill, Intent, Reason, Resting, Snapshot, Strategy, StrategyConfig, TS_FILE};

const HOUR_MS: f64 = 3_600_000.0;
const EPS: f64 = 1e-12;

/// How a run is costed.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export_to = TS_FILE)]
pub struct Costs {
    pub capital: f64,
    /// Taker fee per side, as a fraction.
    pub fee: f64,
    /// Maker fee per side, as a fraction; the taker's if unset.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub maker_fee: Option<f64>,
    /// Slippage on a market order or a stop, in basis points.
    pub slippage_bps: f64,
    /// Funding a long pays per 8 hours, as a fraction of its notional.
    #[serde(default = "default_funding")]
    pub funding_8h: f64,
}

fn default_funding() -> f64 {
    0.00005
}

/// One round trip: a position (or part of one) opened and closed.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export_to = TS_FILE, rename = "BotTrade")]
pub struct Trade {
    /// 1 is the oldest.
    pub n: u32,
    pub side: pewterdesk_core::PositionSide,
    #[ts(type = "number")]
    pub open_time: u64,
    #[ts(type = "number")]
    pub close_time: u64,
    pub entry: f64,
    pub exit: f64,
    pub size: f64,
    /// After fees and funding.
    pub pnl: f64,
    /// The P&L in multiples of what was risked.
    pub r: f64,
    /// Amount at risk at entry (1R).
    pub risk: f64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub initial_stop: Option<f64>,
    /// Paid, so at or below zero.
    pub fees: f64,
    pub funding: f64,
    pub slippage: f64,
    pub exit_reason: Reason,
    /// Opened in the held-out period.
    pub out_of_sample: bool,
    /// Best and worst P&L while open.
    pub mfe: f64,
    pub mae: f64,
}

/// What a strategy asked for, and when: the record a backtest and paper
/// trading compare.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export_to = TS_FILE)]
pub struct Asked {
    /// The candle it was asked at (its open time).
    #[ts(type = "number")]
    pub time: u64,
    pub intent: Intent,
}

#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export_to = TS_FILE)]
pub struct StoppedOut {
    pub index: u32,
    pub price: f64,
}

/// A whole run, as the Bots page shows it.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export_to = TS_FILE)]
pub struct RunResult {
    pub bars: Vec<Bar>,
    pub trades: Vec<Trade>,
    /// Equity at each candle's close, marked to market.
    pub equity: Vec<f64>,
    /// Holding the market with the whole capital, no leverage.
    pub buy_hold: Vec<f64>,
    /// The first held-out candle's index.
    pub hold_out_from: u32,
    /// Candles with a position open.
    pub bars_in_market: u32,
    /// An EMA cross's two lines, for the trades chart.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub fast_line: Option<Vec<Option<f64>>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub slow_line: Option<Vec<Option<f64>>>,
    /// A grid's stop-out: the candle it was hit on and the price.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub stopped_out: Option<StoppedOut>,
    /// Everything the strategy asked for.
    pub asked: Vec<Asked>,
}

/// One open lot of the position.
#[derive(Clone, Debug)]
struct Lot {
    tag: Option<String>,
    long: bool,
    size: f64,
    entry: f64,
    open_index: usize,
    /// Fees paid opening it, per unit of size.
    fee_per_unit: f64,
    slip_per_unit: f64,
    funding: f64,
    stop: Option<f64>,
    mfe: f64,
    mae: f64,
}

#[derive(Clone, Debug)]
struct Order {
    tag: String,
    side: Side,
    price: f64,
    size: f64,
    reduce_only: bool,
    closes: Option<String>,
    stop: Option<f64>,
}

/// The account a strategy trades in a run.
pub struct Session {
    strategy: Box<dyn Strategy>,
    costs: Costs,
    interval_ms: u64,
    /// Lots opened at or after this time are out of sample.
    hold_out_at: u64,
    cash: f64,
    lots: Vec<Lot>,
    orders: Vec<Order>,
    stop: Option<f64>,
    target: Option<f64>,
    stop_reason: Reason,
    halted: bool,
    bars: Vec<Bar>,
    trades: Vec<Trade>,
    equity: Vec<f64>,
    bars_in_market: u32,
    lines: Vec<(&'static str, Vec<Option<f64>>)>,
    stopped_out: Option<StoppedOut>,
    asked: Vec<Asked>,
}

/// Whether an intent opens (or adds to) a position, rather than reducing,
/// cancelling or protecting one.
pub fn opens(intent: &Intent) -> bool {
    matches!(
        intent,
        Intent::Market {
            reduce_only: false,
            ..
        } | Intent::Limit {
            reduce_only: false,
            ..
        }
    )
}

impl Session {
    /// A run of `config`, costed by `costs`, on candles `interval_ms` apart;
    /// lots opened from `hold_out_at` on count as out of sample.
    pub fn new(
        config: &StrategyConfig,
        costs: Costs,
        interval_ms: u64,
        hold_out_at: u64,
    ) -> Result<Self, String> {
        if !(costs.capital.is_finite() && costs.capital > 0.0) {
            return Err("a run needs capital".into());
        }
        Ok(Self {
            strategy: config.build()?,
            cash: costs.capital,
            costs,
            interval_ms,
            hold_out_at,
            lots: Vec::new(),
            orders: Vec::new(),
            stop: None,
            target: None,
            stop_reason: Reason::Stop,
            halted: false,
            bars: Vec::new(),
            trades: Vec::new(),
            equity: Vec::new(),
            bars_in_market: 0,
            lines: Vec::new(),
            stopped_out: None,
            asked: Vec::new(),
        })
    }

    fn slip(&self) -> f64 {
        self.costs.slippage_bps / 10_000.0
    }

    fn maker(&self) -> f64 {
        self.costs.maker_fee.unwrap_or(self.costs.fee)
    }

    /// The position in base units: above zero long.
    pub fn position(&self) -> f64 {
        self.lots
            .iter()
            .map(|l| if l.long { l.size } else { -l.size })
            .sum()
    }

    fn average_entry(&self) -> f64 {
        let size: f64 = self.lots.iter().map(|l| l.size).sum();
        if size <= EPS {
            return 0.0;
        }
        self.lots.iter().map(|l| l.entry * l.size).sum::<f64>() / size
    }

    fn marked(&self, price: f64) -> f64 {
        self.cash
            + self
                .lots
                .iter()
                .map(|l| (price - l.entry) * l.size * if l.long { 1.0 } else { -1.0 })
                .sum::<f64>()
    }

    pub fn halted(&self) -> bool {
        self.halted
    }

    /// History from before the run: the strategy reads it, nothing trades,
    /// and it isn't part of the run's own candles.
    pub fn warm(&mut self, bars: &[Bar]) {
        self.strategy.warm(bars);
    }

    /// Closes the position at the last close (a limit hit), and stops.
    pub fn flatten_and_halt(&mut self, reason: Reason) {
        if let Some(bar) = self.bars.last().copied() {
            let slip = self.slip();
            let fee = self.costs.fee;
            self.close_all(
                bar.close * (1.0 - slip),
                bar.close * (1.0 + slip),
                fee,
                bar.close * slip,
                reason,
            );
            if let Some(last) = self.equity.last_mut() {
                *last = self.cash;
            }
        }
        self.halted = true;
        self.orders.clear();
    }

    /// Stops asking the strategy, its position left as it is.
    pub fn halt(&mut self) {
        self.halted = true;
        self.orders.clear();
    }

    /// The average entry of the position; 0 when flat.
    pub fn entry(&self) -> f64 {
        self.average_entry()
    }

    pub fn trade_count(&self) -> usize {
        self.trades.len()
    }

    pub fn candles(&self) -> usize {
        self.bars.len()
    }

    /// The last thing the strategy asked for.
    pub fn last_asked(&self) -> Option<&Asked> {
        self.asked.last()
    }

    /// Equity at the close of the candle that opened at or before `time`:
    /// where today began, for the day's P&L.
    pub fn equity_at(&self, time: u64) -> Option<f64> {
        let i = self.bars.iter().rposition(|b| b.time <= time)?;
        self.equity.get(i).copied()
    }

    pub fn capital(&self) -> f64 {
        self.costs.capital
    }

    pub fn equity_now(&self) -> f64 {
        self.equity.last().copied().unwrap_or(self.costs.capital)
    }

    /// Opens a lot.
    #[allow(clippy::too_many_arguments)]
    fn open(
        &mut self,
        tag: Option<String>,
        long: bool,
        size: f64,
        price: f64,
        fee: f64,
        slip: f64,
        stop: Option<f64>,
    ) {
        self.cash -= price * size * fee;
        self.lots.push(Lot {
            tag,
            long,
            size,
            entry: price,
            open_index: self.bars.len() - 1,
            fee_per_unit: price * fee,
            slip_per_unit: slip,
            funding: 0.0,
            stop,
            mfe: 0.0,
            mae: 0.0,
        });
    }

    /// Closes up to `size` of the lots on the other side: the one tagged
    /// `closes` first, then the oldest. Returns what was left over.
    #[allow(clippy::too_many_arguments)]
    fn reduce(
        &mut self,
        long_side: bool,
        size: f64,
        price: f64,
        fee: f64,
        slip: f64,
        closes: Option<&str>,
        reason: Reason,
    ) -> f64 {
        let mut left = size;
        let bar_time = self.bars.last().map_or(0, |b| b.time);
        while left > EPS {
            let pick = closes
                .and_then(|tag| {
                    self.lots
                        .iter()
                        .position(|l| l.long == long_side && l.tag.as_deref() == Some(tag))
                })
                .or_else(|| self.lots.iter().position(|l| l.long == long_side));
            let Some(at) = pick else { break };
            let lot = &mut self.lots[at];
            let take = left.min(lot.size);
            let dir = if lot.long { 1.0 } else { -1.0 };
            let share = take / lot.size;
            let gross = (price - lot.entry) * take * dir;
            let exit_fee = price * take * fee;
            let entry_fee = lot.fee_per_unit * take;
            let funding = lot.funding * share;
            self.cash += gross - exit_fee + funding;
            let risk = match lot.stop {
                Some(stop) => ((lot.entry - stop).abs() * take).max(EPS),
                None => (lot.entry * take * 0.01).max(EPS),
            };
            let pnl = gross - entry_fee - exit_fee + funding;
            let open_time = self.bars.get(lot.open_index).map_or(0, |b| b.time);
            self.trades.push(Trade {
                n: self.trades.len() as u32 + 1,
                side: if lot.long {
                    pewterdesk_core::PositionSide::Long
                } else {
                    pewterdesk_core::PositionSide::Short
                },
                open_time,
                close_time: bar_time,
                entry: lot.entry,
                exit: price,
                size: take,
                pnl,
                r: pnl / risk,
                risk,
                initial_stop: lot.stop,
                fees: -(entry_fee + exit_fee),
                funding,
                slippage: (lot.slip_per_unit + slip) * take,
                exit_reason: reason,
                out_of_sample: open_time >= self.hold_out_at,
                mfe: lot.mfe * share,
                mae: lot.mae * share,
            });
            lot.size -= take;
            lot.funding -= funding;
            left -= take;
            if lot.size <= EPS {
                self.lots.remove(at);
            }
        }
        left
    }

    /// An order of `side` and `size` at `price`: closing what it closes,
    /// opening the rest unless it's reduce-only.
    #[allow(clippy::too_many_arguments)]
    fn trade(
        &mut self,
        tag: Option<String>,
        side: Side,
        size: f64,
        price: f64,
        fee: f64,
        slip: f64,
        reduce_only: bool,
        closes: Option<&str>,
        stop: Option<f64>,
        reason: Reason,
    ) {
        let buying = side == Side::Buy;
        // A buy closes shorts first, a sell longs.
        let left = self.reduce(!buying, size, price, fee, slip, closes, reason);
        if left > EPS && !reduce_only {
            self.open(tag.clone(), buying, left, price, fee, slip, stop);
        }
        self.strategy.on_fill(&Fill {
            tag,
            side,
            price,
            size,
            reason,
        });
    }

    fn close_all(
        &mut self,
        price_for_long: f64,
        price_for_short: f64,
        fee: f64,
        slip: f64,
        reason: Reason,
    ) {
        let pos = self.position();
        if pos > EPS {
            self.trade(
                None,
                Side::Sell,
                pos,
                price_for_long,
                fee,
                slip,
                true,
                None,
                None,
                reason,
            );
        } else if pos < -EPS {
            self.trade(
                None,
                Side::Buy,
                -pos,
                price_for_short,
                fee,
                slip,
                true,
                None,
                None,
                reason,
            );
        }
    }

    /// The position's stop and target, against this candle.
    fn exits(&mut self, bar: &Bar, index: usize) {
        let pos = self.position();
        if pos.abs() <= EPS {
            return;
        }
        let long = pos > 0.0;
        let slip = self.slip();
        let stop_hit = self
            .stop
            .filter(|s| if long { bar.low <= *s } else { bar.high >= *s });
        let target_hit = self
            .target
            .filter(|t| if long { bar.high >= *t } else { bar.low <= *t });
        if let Some(stop) = stop_hit {
            let at = if long {
                stop.min(bar.open)
            } else {
                stop.max(bar.open)
            };
            let filled = if long {
                at * (1.0 - slip)
            } else {
                at * (1.0 + slip)
            };
            let reason = self.stop_reason;
            self.close_all(filled, filled, self.costs.fee, at * slip, reason);
            if reason == Reason::StopOut {
                self.stopped_out = Some(StoppedOut {
                    index: index as u32,
                    price: stop,
                });
            }
        } else if let Some(target) = target_hit {
            let at = if long {
                target.max(bar.open)
            } else {
                target.min(bar.open)
            };
            let maker = self.maker();
            self.close_all(at, at, maker, 0.0, Reason::Target);
        } else {
            return;
        }
        self.orders.clear();
        self.stop = None;
        self.target = None;
    }

    /// Resting limits, against this candle, in the order they were placed.
    fn limits(&mut self, bar: &Bar) {
        let mut i = 0;
        while i < self.orders.len() {
            let o = &self.orders[i];
            let reached = match o.side {
                Side::Buy => bar.low <= o.price,
                Side::Sell => bar.high >= o.price,
            };
            if !reached {
                i += 1;
                continue;
            }
            let o = self.orders.remove(i);
            let price = match o.side {
                Side::Buy => o.price.min(bar.open),
                Side::Sell => o.price.max(bar.open),
            };
            let pos = self.position();
            // Reduce-only with nothing on the other side: nothing to do.
            let reduces = match o.side {
                Side::Buy => pos < -EPS,
                Side::Sell => pos > EPS,
            };
            if o.reduce_only && !reduces {
                continue;
            }
            let reason = if o.reduce_only {
                Reason::Grid
            } else {
                Reason::Entry
            };
            let maker = self.maker();
            self.trade(
                Some(o.tag),
                o.side,
                o.size,
                price,
                maker,
                0.0,
                o.reduce_only,
                o.closes.as_deref(),
                o.stop,
                reason,
            );
        }
    }

    fn apply(&mut self, intent: Intent, bar: &Bar) {
        let slip = self.slip();
        let fee = self.costs.fee;
        match intent {
            Intent::Market {
                side,
                size,
                reduce_only,
                reason,
                stop,
            } => {
                if !(size.is_finite() && size > EPS) {
                    return;
                }
                let price = match side {
                    Side::Buy => bar.close * (1.0 + slip),
                    Side::Sell => bar.close * (1.0 - slip),
                };
                self.trade(
                    None,
                    side,
                    size,
                    price,
                    fee,
                    bar.close * slip,
                    reduce_only,
                    None,
                    stop,
                    reason,
                );
            }
            Intent::Limit {
                tag,
                side,
                price,
                size,
                reduce_only,
                closes,
                stop,
            } => {
                self.orders.retain(|o| o.tag != tag);
                if price.is_finite() && price > 0.0 && size.is_finite() && size > EPS {
                    self.orders.push(Order {
                        tag,
                        side,
                        price,
                        size,
                        reduce_only,
                        closes,
                        stop,
                    });
                }
            }
            Intent::Cancel { tag } => self.orders.retain(|o| o.tag != tag),
            Intent::Exits {
                stop,
                target,
                stop_reason,
            } => {
                self.stop = stop;
                self.target = target;
                self.stop_reason = stop_reason;
            }
            Intent::Close { reason } => {
                self.close_all(
                    bar.close * (1.0 - slip),
                    bar.close * (1.0 + slip),
                    fee,
                    bar.close * slip,
                    reason,
                );
            }
            Intent::Halt { .. } => {
                self.halted = true;
                self.orders.clear();
            }
        }
    }

    /// Takes the next closed candle: fills against it, then the strategy's
    /// turn at its close. Returns what the strategy asked for.
    pub fn step(&mut self, bar: Bar) -> Vec<Intent> {
        self.step_allowing(bar, &|_| true)
    }

    /// `step`, carrying out only the intents `allow` lets through (a bot
    /// outside its hours opens nothing); everything asked is still recorded.
    pub fn step_allowing(&mut self, bar: Bar, allow: &dyn Fn(&Intent) -> bool) -> Vec<Intent> {
        self.bars.push(bar);
        let index = self.bars.len() - 1;
        if index > 0 {
            self.exits(&bar, index);
            self.limits(&bar);
        }
        // Funding, and how far each lot ran either way.
        let hours = self.interval_ms as f64 / HOUR_MS;
        for lot in &mut self.lots {
            let dir = if lot.long { 1.0 } else { -1.0 };
            lot.funding -= dir * lot.entry * lot.size * self.costs.funding_8h * (hours / 8.0);
            let best = ((if lot.long { bar.high } else { bar.low }) - lot.entry) * lot.size * dir;
            let worst = ((if lot.long { bar.low } else { bar.high }) - lot.entry) * lot.size * dir;
            lot.mfe = lot.mfe.max(best);
            lot.mae = lot.mae.min(worst);
        }
        let mut asked = Vec::new();
        if !self.halted {
            let resting: Vec<Resting> = self
                .orders
                .iter()
                .map(|o| Resting {
                    tag: o.tag.clone(),
                    side: o.side,
                    price: o.price,
                    size: o.size,
                })
                .collect();
            let snapshot = Snapshot {
                bars: &self.bars,
                position: self.position(),
                entry: self.average_entry(),
                equity: self.marked(bar.close),
                resting: &resting,
            };
            asked = self.strategy.on_bar(&snapshot);
            for intent in &asked {
                self.asked.push(Asked {
                    time: bar.time,
                    intent: intent.clone(),
                });
                if allow(intent) {
                    self.apply(intent.clone(), &bar);
                }
            }
        }
        for (name, value) in self.strategy.lines() {
            match self.lines.iter_mut().find(|(n, _)| *n == name) {
                Some((_, values)) => values.push(value),
                None => {
                    let mut values = vec![None; index];
                    values.push(value);
                    self.lines.push((name, values));
                }
            }
        }
        if self.position().abs() > EPS {
            self.bars_in_market += 1;
        }
        self.equity.push(self.marked(bar.close));
        asked
    }

    /// Closes what's open at the last close, and hands the run over.
    pub fn finish(mut self) -> RunResult {
        if let Some(bar) = self.bars.last().copied() {
            if self.position().abs() > EPS {
                self.close_all(bar.close, bar.close, self.costs.fee, 0.0, Reason::End);
                if let Some(last) = self.equity.last_mut() {
                    *last = self.cash;
                }
            }
        }
        let first = self.bars.first().map_or(1.0, |b| b.close);
        let capital = self.costs.capital;
        let line = |name: &str, lines: &[(&'static str, Vec<Option<f64>>)]| {
            lines
                .iter()
                .find(|(n, _)| *n == name)
                .map(|(_, v)| v.clone())
        };
        RunResult {
            buy_hold: self
                .bars
                .iter()
                .map(|b| capital * b.close / first)
                .collect(),
            hold_out_from: self
                .bars
                .iter()
                .position(|b| b.time >= self.hold_out_at)
                .unwrap_or(self.bars.len()) as u32,
            fast_line: line("fast", &self.lines),
            slow_line: line("slow", &self.lines),
            bars: self.bars,
            trades: self.trades,
            equity: self.equity,
            bars_in_market: self.bars_in_market,
            stopped_out: self.stopped_out,
            asked: self.asked,
        }
    }
}

/// A whole backtest: `config` over `bars` (oldest first), the last
/// `hold_out_days` held out.
pub fn backtest(
    config: &StrategyConfig,
    costs: Costs,
    bars: &[Bar],
    hold_out_days: f64,
) -> Result<RunResult, String> {
    let interval_ms = match bars {
        [a, b, ..] => b.time.saturating_sub(a.time).max(1),
        _ => return Err("a backtest needs at least two candles".into()),
    };
    let end = bars.last().map_or(0, |b| b.time);
    let hold_out_at =
        end.saturating_sub((hold_out_days.max(0.0) * 86_400_000.0) as u64) + interval_ms;
    let mut session = Session::new(config, costs, interval_ms, hold_out_at)?;
    for bar in bars {
        session.step(*bar);
    }
    Ok(session.finish())
}
