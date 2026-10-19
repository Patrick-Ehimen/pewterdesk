//! Bots: strategies (`pewterdesk_strategy`) the engine runs, each on one
//! account and market, from paper to live (`docs/bots/bots.md`).
//!
//! A bot paper trades first: its strategy's intents filled by the
//! backtester's own fill model, on each live candle as it closes - the
//! same strategy and fill model as a backtest, so the same candles ask the
//! same things. After `PAPER_DAYS` of that it may go live: the same
//! strategy, its intents sent through the router (`Origin::Bot`), the gate
//! and the log, like any order. A bot's own limits (daily loss, position,
//! orders a minute, hours) sit on top of the account's rules; hitting one
//! stops it (and flattens it, if set), and it doesn't try again.
//!
//! Security-relevant (docs/bots/safety.md): a bot reaches a venue only
//! through the router - no other way, no bypass. An account whose rules
//! bar bots (`no_bots`) can't run one live.

mod feed;
pub mod history;
mod live;
mod paper;

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, OnceLock};

use pewterdesk_core::{Origin, VenueError};
use pewterdesk_strategy::bot::{BotMode, BotSpec, BotStatus, BotView};
use pewterdesk_strategy::Bar;
use tokio::sync::{mpsc, watch};

pub use feed::{closed as closed_candles, recorded, Recording};

use crate::algo::Host;
use crate::router::trading_account;
use crate::rules::now_ms;
use crate::By;

/// How a running bot is steered.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Control {
    Run,
    Pause,
    Stop { flatten: bool },
}

/// One bot: its state, and the handle that steers it while it runs.
pub(crate) struct Entry {
    pub(crate) view: Mutex<BotView>,
    pub(crate) control: Mutex<Option<watch::Sender<Control>>>,
}

/// Every bot this engine has.
#[derive(Default)]
pub struct Bots {
    host: OnceLock<Arc<dyn Host>>,
    entries: Mutex<Vec<(String, Arc<Entry>)>>,
    seq: AtomicU64,
}

fn invalid(why: impl Into<String>) -> VenueError {
    VenueError::InvalidRequest(why.into())
}

/// Where a bot's commands are logged from: the bot, with its id.
pub(crate) fn by(tag: &str) -> By<'_> {
    By {
        origin: Origin::Bot,
        algo: Some(tag),
    }
}

/// A bot's tag in the log: `bot:<id>`.
pub(crate) fn tag(id: &str) -> String {
    format!("bot:{id}")
}

/// Records what a bot's strategy asked for, at the candle `time`, in the
/// event log (an `intent`, under the bot's tag): paper and live alike.
pub(crate) fn log_asked(
    host: &Arc<dyn Host>,
    spec: &BotSpec,
    id: &str,
    time: u64,
    asked: &[pewterdesk_strategy::Intent],
) {
    let Some(log) = host.engine().log() else {
        return;
    };
    let venue = serde_json::to_value(spec.venue).unwrap_or_default();
    let t = tag(id);
    for intent in asked {
        let _ = log.append(&pewterdesk_store::NewEvent {
            at: now_ms(),
            kind: "intent",
            origin: Some("bot"),
            venue: venue.as_str(),
            account: Some(&spec.account),
            algo: Some(&t),
            detail: serde_json::json!({ "time": time, "intent": intent }),
            ..pewterdesk_store::NewEvent::default()
        });
    }
}

/// Keeps a bot's state in the log, and hands it to the page.
pub(crate) fn publish(host: &Arc<dyn Host>, view: &BotView, over: bool) {
    if let Some(log) = host.engine().log() {
        if let Ok(json) = serde_json::to_value(view) {
            let _ = log.save_bot(&view.id, view.created_at, now_ms(), over, &json);
        }
    }
    host.publish_bot(view);
}

impl Bots {
    /// A backtest of `spec`'s strategy on its market's candles from `since`
    /// (recorded, and the venue's older ones), costed as its paper account
    /// would be, the last `hold_out_days` held out.
    pub async fn backtest(
        &self,
        spec: &BotSpec,
        since: u64,
        hold_out_days: f64,
    ) -> Result<pewterdesk_strategy::sim::RunResult, VenueError> {
        spec.strategy.check().map_err(invalid)?;
        let host = self.host()?;
        let bars = history::candles(&host, spec.venue, &spec.market, spec.interval, since).await?;
        let costs = pewterdesk_strategy::bot::paper_costs(spec.venue, spec.paper_capital);
        pewterdesk_strategy::sim::backtest(&spec.strategy, costs, &bars, hold_out_days)
            .map_err(invalid)
    }

    /// Connects the engine's bots to their host, and reads the ones it kept.
    pub fn attach(&self, host: Arc<dyn Host>) {
        let kept: Vec<BotView> = host
            .engine()
            .log()
            .and_then(|log| log.bots(false).ok())
            .unwrap_or_default()
            .into_iter()
            .filter_map(|json| serde_json::from_value(json).ok())
            .collect();
        let _ = self.host.set(host);
        let mut entries = self.entries.lock().unwrap();
        for view in kept {
            if entries.iter().any(|(id, _)| *id == view.id) {
                continue;
            }
            entries.push((
                view.id.clone(),
                Arc::new(Entry {
                    view: Mutex::new(view),
                    control: Mutex::new(None),
                }),
            ));
        }
    }

    fn host(&self) -> Result<Arc<dyn Host>, VenueError> {
        self.host
            .get()
            .cloned()
            .ok_or(VenueError::Unsupported("bots (the engine isn't attached)"))
    }

    fn entry(&self, id: &str) -> Result<Arc<Entry>, VenueError> {
        self.entries
            .lock()
            .unwrap()
            .iter()
            .find(|(i, _)| i == id)
            .map(|(_, e)| Arc::clone(e))
            .ok_or_else(|| invalid("no such bot"))
    }

    /// Every bot, oldest first.
    pub fn list(&self) -> Vec<BotView> {
        self.entries
            .lock()
            .unwrap()
            .iter()
            .map(|(_, e)| e.view.lock().unwrap().clone())
            .collect()
    }

    pub fn get(&self, id: &str) -> Result<BotView, VenueError> {
        Ok(self.entry(id)?.view.lock().unwrap().clone())
    }

    /// A new bot, in paper and not yet running: checked first (its
    /// strategy's settings, the market).
    pub async fn create(&self, spec: BotSpec) -> Result<BotView, VenueError> {
        spec.strategy.check().map_err(invalid)?;
        if !(spec.paper_capital.is_finite() && spec.paper_capital > 0.0) {
            return Err(invalid("paper trading needs a balance"));
        }
        if spec.max_slippage_bps == 0 || spec.max_slippage_bps > 5_000 {
            return Err(invalid("the slippage bound is out of range"));
        }
        if spec.limits.orders_per_minute == 0 {
            return Err(invalid("a bot needs to be able to send an order"));
        }
        let host = self.host()?;
        let markets = host.venues().adapter(spec.venue)?.markets().await?;
        if !markets.iter().any(|m| m.id == spec.market) {
            return Err(invalid("not a market on this venue"));
        }
        let now = now_ms();
        let id = format!("{:x}{:x}", now, self.seq.fetch_add(1, Ordering::SeqCst));
        let view = BotView {
            id: id.clone(),
            spec,
            mode: BotMode::Paper,
            status: BotStatus::Stopped,
            reason: None,
            created_at: now,
            paper_since: None,
            live_since: None,
            position: 0.0,
            entry: 0.0,
            pnl_today: 0.0,
            pnl_total: 0.0,
            equity: 0.0,
            trades: 0,
            candles: 0,
            last: None,
        };
        self.entries.lock().unwrap().push((
            id,
            Arc::new(Entry {
                view: Mutex::new(view.clone()),
                control: Mutex::new(None),
            }),
        ));
        publish(&host, &view, false);
        Ok(view)
    }

    /// Starts (or picks up) a bot in its mode, on the venue's candles.
    pub async fn start(&self, id: &str) -> Result<BotView, VenueError> {
        self.start_on(id, None).await
    }

    /// `start` on candles the caller hands it (`warm` history, then each
    /// candle as it closes) instead of the venue's: for tests, and for a
    /// host with a feed of its own.
    pub async fn start_with_feed(
        &self,
        id: &str,
        warm: Vec<Bar>,
        feed: mpsc::Receiver<Bar>,
    ) -> Result<BotView, VenueError> {
        self.start_on(id, Some((warm, feed))).await
    }

    async fn start_on(
        &self,
        id: &str,
        given: Option<(Vec<Bar>, mpsc::Receiver<Bar>)>,
    ) -> Result<BotView, VenueError> {
        let host = self.host()?;
        let entry = self.entry(id)?;
        if entry.control.lock().unwrap().is_some() {
            return Err(invalid("it's already running"));
        }
        let (mode, spec) = {
            let view = entry.view.lock().unwrap();
            (view.mode, view.spec.clone())
        };
        if mode == BotMode::Live {
            self.may_go_live(&host, &spec)?;
            host.engine().owners().claim(spec.venue, &spec.account)?;
        }
        let (tx, rx) = watch::channel(Control::Run);
        *entry.control.lock().unwrap() = Some(tx);
        {
            let mut view = entry.view.lock().unwrap();
            view.status = BotStatus::Running;
            view.reason = None;
            if mode == BotMode::Paper && view.paper_since.is_none() {
                view.paper_since = Some(now_ms());
            }
        }
        let job = Job {
            host: Arc::clone(&host),
            entry: Arc::clone(&entry),
            control: rx,
            given,
        };
        match mode {
            BotMode::Paper => tokio::spawn(paper::run(job)),
            BotMode::Live => tokio::spawn(live::run(job)),
        };
        let view = entry.view.lock().unwrap().clone();
        publish(&host, &view, false);
        Ok(view)
    }

    /// Whether `spec` may trade live: the account's switch is on, its rules
    /// don't bar bots.
    fn may_go_live(&self, host: &Arc<dyn Host>, spec: &BotSpec) -> Result<(), VenueError> {
        let engine = host.engine();
        trading_account(spec.venue, &spec.account, engine.live())?;
        if engine.rules().bots_barred(spec.venue, &spec.account) {
            return Err(VenueError::Blocked("noBots".into()));
        }
        Ok(())
    }

    /// Takes a bot from paper to live - only after `PAPER_DAYS` of paper -
    /// and starts it.
    pub async fn go_live(&self, id: &str) -> Result<BotView, VenueError> {
        let host = self.host()?;
        let entry = self.entry(id)?;
        let view = entry.view.lock().unwrap().clone();
        if view.mode == BotMode::Live {
            return Err(invalid("it's live already"));
        }
        if !view.ready_for_live(now_ms()) {
            return Err(VenueError::Blocked("paperFirst".into()));
        }
        self.may_go_live(&host, &view.spec)?;
        self.stop(id, false)?;
        // Its paper run's task sees the stop and ends; then it goes live.
        for _ in 0..50 {
            if entry.control.lock().unwrap().is_none() {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(20)).await;
        }
        {
            let mut v = entry.view.lock().unwrap();
            v.mode = BotMode::Live;
            v.live_since = Some(now_ms());
            v.pnl_today = 0.0;
            v.pnl_total = 0.0;
            v.trades = 0;
            v.candles = 0;
        }
        self.start(id).await
    }

    fn steer(&self, id: &str, control: Control) -> Result<(), VenueError> {
        let entry = self.entry(id)?;
        let sender = entry.control.lock().unwrap();
        match sender.as_ref() {
            Some(tx) => {
                let _ = tx.send(control);
                Ok(())
            }
            None => Err(invalid("it isn't running")),
        }
    }

    pub fn pause(&self, id: &str) -> Result<(), VenueError> {
        self.steer(id, Control::Pause)
    }

    pub fn resume(&self, id: &str) -> Result<(), VenueError> {
        self.steer(id, Control::Run)
    }

    /// Stops a bot: its resting orders cancelled, and with `flatten` its
    /// position closed at market.
    pub fn stop(&self, id: &str, flatten: bool) -> Result<(), VenueError> {
        self.steer(id, Control::Stop { flatten })
    }

    /// Deletes a stopped bot (kept in the log as over).
    pub fn delete(&self, id: &str) -> Result<(), VenueError> {
        let host = self.host()?;
        let entry = self.entry(id)?;
        if entry.control.lock().unwrap().is_some() {
            return Err(invalid("stop it first"));
        }
        let view = entry.view.lock().unwrap().clone();
        publish(&host, &view, true);
        self.entries.lock().unwrap().retain(|(i, _)| i != id);
        Ok(())
    }

    /// Stops every running bot and cancels its orders; how many it stopped.
    pub fn halt(&self) -> usize {
        let entries = self.entries.lock().unwrap();
        let mut stopped = 0;
        for (_, entry) in entries.iter() {
            if let Some(tx) = entry.control.lock().unwrap().as_ref() {
                let _ = tx.send(Control::Stop { flatten: false });
                stopped += 1;
            }
        }
        stopped
    }

    /// After a restart: paper bots that were running carry on (their state
    /// rebuilt from the candles recorded since); live ones are stopped and
    /// whatever of theirs still rests is cancelled - never resumed blind.
    pub async fn reconcile(&self) {
        let Ok(host) = self.host() else { return };
        let views = self.list();
        for view in views.into_iter().filter(|v| v.status.running()) {
            match view.mode {
                BotMode::Paper => {
                    if let Ok(entry) = self.entry(&view.id) {
                        entry.view.lock().unwrap().status = BotStatus::Stopped;
                    }
                    let _ = self.start(&view.id).await;
                }
                BotMode::Live => {
                    // Another engine running it keeps it.
                    if host
                        .engine()
                        .owners()
                        .claim(view.spec.venue, &view.spec.account)
                        .is_err()
                    {
                        continue;
                    }
                    live::cancel_left_over(&host, &view).await;
                    if let Ok(entry) = self.entry(&view.id) {
                        let mut v = entry.view.lock().unwrap();
                        v.status = BotStatus::Stopped;
                        v.reason = Some("appClosed".into());
                        publish(&host, &v, false);
                    }
                }
            }
        }
    }
}

/// What a bot's task runs with.
pub(crate) struct Job {
    pub(crate) host: Arc<dyn Host>,
    pub(crate) entry: Arc<Entry>,
    pub(crate) control: watch::Receiver<Control>,
    /// Candles from the caller; else the venue's.
    pub(crate) given: Option<(Vec<Bar>, mpsc::Receiver<Bar>)>,
}

impl Job {
    /// The bot's history and its candles from now on: the caller's, or the
    /// venue's (recorded as they come).
    pub(crate) async fn candles(
        &mut self,
        spec: &BotSpec,
    ) -> Result<(Vec<Bar>, mpsc::Receiver<Bar>), VenueError> {
        if let Some(given) = self.given.take() {
            return Ok(given);
        }
        let adapter = self.host.venues().adapter(spec.venue)?;
        feed::closed(adapter, &spec.market, spec.interval, self.recording(spec)).await
    }

    pub(crate) fn recording(&self, spec: &BotSpec) -> Option<Recording> {
        self.host.recorder().map(|recorder| Recording {
            recorder,
            venue: spec.venue,
            market: spec.market.clone(),
            interval: spec.interval,
        })
    }

    /// Ends the task: the bot is no longer running.
    pub(crate) fn finish(&self, status: BotStatus, reason: Option<String>) {
        *self.entry.control.lock().unwrap() = None;
        let view = {
            let mut v = self.entry.view.lock().unwrap();
            v.status = status;
            v.reason = reason;
            v.clone()
        };
        publish(&self.host, &view, false);
    }

    pub(crate) fn update(&self, change: impl FnOnce(&mut BotView)) {
        let view = {
            let mut v = self.entry.view.lock().unwrap();
            change(&mut v);
            v.clone()
        };
        publish(&self.host, &view, false);
    }
}

/// The start of the UTC day `time` (ms) falls in.
pub(crate) fn day_start(time: u64) -> u64 {
    time - time % pewterdesk_strategy::bot::DAY_MS
}

/// Whether `time` (ms) is inside `hours` (UTC, from and to, to excluded;
/// wrapping past midnight when from is after to).
pub(crate) fn in_hours(hours: Option<(u8, u8)>, time: u64) -> bool {
    let Some((from, to)) = hours else {
        return true;
    };
    let hour = ((time / 3_600_000) % 24) as u8;
    if from <= to {
        (from..to).contains(&hour)
    } else {
        hour >= from || hour < to
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hours_wrap_past_midnight() {
        let at = |h: u64| h * 3_600_000;
        assert!(in_hours(None, at(3)));
        assert!(in_hours(Some((8, 16)), at(8)));
        assert!(!in_hours(Some((8, 16)), at(16)));
        assert!(in_hours(Some((22, 6)), at(23)));
        assert!(in_hours(Some((22, 6)), at(2)));
        assert!(!in_hours(Some((22, 6)), at(12)));
        assert_eq!(day_start(86_400_000 + 5), 86_400_000);
    }
}
