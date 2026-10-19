//! Algo orders: a chaser, a TWAP, a scaled ladder, run by the engine over
//! time. Each is an executor (`exec.rs`) run by a task (`run.rs`) that
//! sends every order through the router - the gate, the event log and a
//! client order id, like any other order - as `Origin::Algo`.
//!
//! Security-relevant - review any change against
//! `.claude/commands/security-review.md` and `docs/bots/safety.md`:
//! - No new way to reach a venue: an algo places, amends and cancels through
//!   the router, and the gate (live-trading switch, trading rules) checks
//!   each order as it would the ticket's. A refusal pauses the algo; it
//!   never retries around it.
//! - No blind retries: an order whose answer was lost is looked up by its
//!   client order id, never sent again.
//! - Fail closed: stale market data, a lost account feed or a refusal pauses
//!   an algo; after a reconnect it re-reads its orders before acting.
//! - Session only: an algo run on this machine stops when the app does. On
//!   the next start the reconciler marks it stopped and cancels whatever of
//!   it is still resting. Only a venue-run algo (`RunsOn::Venue`) carries on.
//! - `halt` stops every algo and cancels everything they placed.
//! - While an algo runs on this machine, the venue's dead-man's switch is
//!   kept armed (`heartbeat.rs`), so a machine that sleeps or an app that
//!   dies leaves nothing resting unmanaged for long.

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, OnceLock};

use pewterdesk_core::{
    AlgoKind, AlgoSpec, AlgoStatus, AlgoView, Decimal, Origin, RunsOn, StopMode, VenueError,
};
use rust_decimal::Decimal as D;
use serde::{Deserialize, Serialize};
use tokio::sync::watch;

use crate::router::trading_account;
use crate::rules::now_ms;
use crate::{Adapters, By, Calendar, Engine};

pub mod budget;
pub mod exec;
pub mod feeds;
mod heartbeat;
pub mod math;
mod native;
mod run;

use exec::{Chaser, Executor, Scaled, Twap};
use math::Rules;

/// The longest TWAP, and the most slices or ladder levels.
const MAX_DURATION_MS: u64 = 7 * 24 * 60 * 60 * 1000;
const MIN_DURATION_MS: u64 = 10_000;
const MAX_SLICES: u32 = 500;
const MAX_LEVELS: u32 = 50;
/// The widest give-up distance and market-order bound, in basis points.
const MAX_BPS: u32 = 5_000;
/// How many finished algos the session list keeps.
const KEEP_OVER: usize = 50;

/// What the engine needs from the app that runs it.
pub trait Host: Send + Sync + 'static {
    fn engine(&self) -> &Engine;
    fn venues(&self) -> &dyn Adapters;
    fn calendar(&self) -> &dyn Calendar;
    /// Hands the page an algo's latest state.
    fn publish(&self, view: &AlgoView);
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Control {
    Run,
    Pause,
    /// With the reason it's kept under (`user`, `halted`).
    Stop(StopMode, &'static str),
}

/// One algo this session: its state, and the handle that steers it.
pub(crate) struct Entry {
    pub(crate) view: Mutex<AlgoView>,
    pub(crate) control: watch::Sender<Control>,
}

/// An algo as the store keeps it: its view, and what a venue-run one needs
/// to be followed again after a restart.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Saved {
    pub(crate) view: AlgoView,
    /// The venue's id for a venue-run algo (a native TWAP).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) native_order: Option<String>,
}

/// Every algo in this engine.
#[derive(Default)]
pub struct Algos {
    host: OnceLock<Arc<dyn Host>>,
    entries: Mutex<Vec<(String, Arc<Entry>)>>,
    pub(crate) feeds: feeds::Feeds,
    pub(crate) budget: budget::Budget,
    seq: AtomicU64,
    /// The dead-man's switch heartbeat, started with the first algo.
    heartbeat: OnceLock<()>,
}

fn invalid(why: &str) -> VenueError {
    VenueError::InvalidRequest(why.into())
}

/// Whether `spec` asks for something an algo can run.
fn validate(spec: &AlgoSpec) -> Result<(), VenueError> {
    if spec.size.0 <= D::ZERO {
        return Err(invalid("an algo needs a size"));
    }
    if spec.max_slippage_bps == 0 || spec.max_slippage_bps > MAX_BPS {
        return Err(invalid("the slippage bound is out of range"));
    }
    match &spec.kind {
        AlgoKind::Chaser { give_up_bps, .. } => {
            if give_up_bps.is_some_and(|bps| bps == 0 || bps > MAX_BPS) {
                return Err(invalid("the give-up distance is out of range"));
            }
        }
        AlgoKind::Twap {
            duration_ms,
            slices,
            ..
        } => {
            if !(MIN_DURATION_MS..=MAX_DURATION_MS).contains(duration_ms) {
                return Err(invalid("a TWAP runs from 10 seconds to 7 days"));
            }
            if *slices == 0 || *slices > MAX_SLICES {
                return Err(invalid("a TWAP has 1 to 500 slices"));
            }
        }
        AlgoKind::Scaled {
            from, to, count, ..
        } => {
            if from.0 <= D::ZERO || to.0 <= D::ZERO {
                return Err(invalid("a ladder's prices must be above zero"));
            }
            if *count < 2 || *count > MAX_LEVELS {
                return Err(invalid("a ladder has 2 to 50 orders"));
            }
        }
    }
    Ok(())
}

impl Algos {
    /// Connects the engine to the app that runs it. Once.
    pub fn attach(&self, host: Arc<dyn Host>) {
        let _ = self.host.set(host);
    }

    fn host(&self) -> Result<Arc<dyn Host>, VenueError> {
        self.host
            .get()
            .cloned()
            .ok_or(VenueError::Unsupported("algos (the engine isn't attached)"))
    }

    fn entry(&self, id: &str) -> Result<Arc<Entry>, VenueError> {
        self.entries
            .lock()
            .unwrap()
            .iter()
            .find(|(key, _)| key == id)
            .map(|(_, entry)| Arc::clone(entry))
            .ok_or_else(|| invalid("no such algo"))
    }

    fn remember(&self, id: String, entry: Arc<Entry>) {
        let mut entries = self.entries.lock().unwrap();
        entries.push((id, entry));
        // Keep every running one, and the latest of those that are over.
        let over: Vec<usize> = entries
            .iter()
            .enumerate()
            .filter(|(_, (_, e))| e.view.lock().unwrap().status.is_over())
            .map(|(i, _)| i)
            .collect();
        if over.len() > KEEP_OVER {
            let drop: Vec<usize> = over[..over.len() - KEEP_OVER].to_vec();
            let mut i = 0;
            entries.retain(|_| {
                let keep = !drop.contains(&i);
                i += 1;
                keep
            });
        }
    }

    fn new_id(&self) -> String {
        let n = self.seq.fetch_add(1, Ordering::Relaxed);
        format!("{:x}-{n:x}", now_ms())
    }

    /// Starts an algo, checked first: the account must be able to trade,
    /// the market must exist, and the size must be one it can place.
    pub async fn start(&self, spec: AlgoSpec, origin: Origin) -> Result<AlgoView, VenueError> {
        validate(&spec)?;
        let host = self.host()?;
        let engine = host.engine();
        // The switch now, so a live account with trading off is told at
        // once; the gate still checks every order.
        trading_account(spec.venue, &spec.account, engine.live())?;
        let markets = host.venues().adapter(spec.venue)?.markets().await?;
        let market = markets
            .into_iter()
            .find(|m| m.id == spec.market)
            .ok_or_else(|| invalid("not a market on this venue"))?;
        let rules = Rules::from(&market);
        let size = math::floor_to(spec.size.0, rules.step);
        if size < rules.min || size <= D::ZERO {
            return Err(invalid("the size is below the market's minimum"));
        }
        let spec = AlgoSpec {
            size: Decimal(size),
            ..spec
        };
        let id = self.new_id();
        let (exec, runs_on): (Box<dyn Executor>, RunsOn) = match &spec.kind {
            AlgoKind::Chaser {
                post_only,
                give_up_bps,
                finish_at_market,
            } => (
                Box::new(Chaser::new(
                    0,
                    size,
                    *post_only,
                    *give_up_bps,
                    *finish_at_market,
                )),
                RunsOn::Local,
            ),
            AlgoKind::Twap {
                duration_ms,
                slices,
                randomize,
                style,
                unfilled,
            } => match native::twap(&spec) {
                Some(native) => (Box::new(native), RunsOn::Venue),
                None => {
                    let sizes = math::slices(size, *slices, &rules);
                    if sizes.is_empty() {
                        return Err(invalid("too small to slice that many ways"));
                    }
                    let seed = now_ms() ^ self.seq.load(Ordering::Relaxed);
                    let times = math::schedule(sizes.len(), *duration_ms, *randomize, seed);
                    (
                        Box::new(Twap::new(sizes, times, *duration_ms, *style, *unfilled)),
                        RunsOn::Local,
                    )
                }
            },
            AlgoKind::Scaled {
                from,
                to,
                count,
                distribution,
                post_only,
            } => {
                let levels =
                    math::ladder(size, from.0, to.0, *count, *distribution, spec.side, &rules);
                if levels.is_empty() {
                    return Err(invalid("too small to spread over that many orders"));
                }
                (Box::new(Scaled::new(levels, *post_only)), RunsOn::Local)
            }
        };
        let now = now_ms();
        let view = AlgoView {
            id: id.clone(),
            spec: spec.clone(),
            origin,
            status: AlgoStatus::Running,
            reason: None,
            detail: None,
            runs_on,
            filled: Decimal(D::ZERO),
            avg_price: None,
            fees: None,
            start_price: None,
            open_orders: 0,
            started_at: now,
            ends_at: exec.ends_at().map(|ms| now + ms),
            next_at: exec.next_at().map(|ms| now + ms),
            updated_at: now,
        };
        let (control, rx) = watch::channel(Control::Run);
        let entry = Arc::new(Entry {
            view: Mutex::new(view.clone()),
            control,
        });
        self.remember(id.clone(), Arc::clone(&entry));
        run::save(&*host, &entry, None);
        host.publish(&view);
        if self.heartbeat.set(()).is_ok() {
            tokio::spawn(heartbeat::run(Arc::clone(&host)));
        }
        tokio::spawn(run::run(run::Job {
            host,
            entry,
            control: rx,
            exec,
            rules,
            spec,
            id,
            native_order: None,
            started_at: now,
        }));
        Ok(view)
    }

    fn steer(&self, id: &str, control: Control) -> Result<(), VenueError> {
        let entry = self.entry(id)?;
        if entry.view.lock().unwrap().status.is_over() {
            return Err(invalid("that algo is over"));
        }
        entry.control.send_replace(control);
        Ok(())
    }

    /// Pauses an algo: it sends nothing more until it's resumed. What it has
    /// resting stays.
    pub fn pause(&self, id: &str) -> Result<(), VenueError> {
        self.steer(id, Control::Pause)
    }

    /// Resumes a paused algo, including one a refusal or errors paused.
    pub fn resume(&self, id: &str) -> Result<(), VenueError> {
        self.steer(id, Control::Run)
    }

    /// Stops an algo: cancels what it has open, then (with
    /// `FinishAtMarket`) sends the rest at market.
    pub fn stop(&self, id: &str, mode: StopMode) -> Result<(), VenueError> {
        self.steer(id, Control::Stop(mode, "user"))
    }

    /// Stops every algo and cancels everything they placed. How many it stopped.
    pub fn halt(&self) -> usize {
        let entries: Vec<Arc<Entry>> = self
            .entries
            .lock()
            .unwrap()
            .iter()
            .map(|(_, e)| Arc::clone(e))
            .collect();
        let mut stopped = 0;
        for entry in entries {
            if !entry.view.lock().unwrap().status.is_over() {
                entry
                    .control
                    .send_replace(Control::Stop(StopMode::Cancel, "halted"));
                stopped += 1;
            }
        }
        stopped
    }

    /// This session's algos, newest first: every running one, and the
    /// latest that are over.
    pub fn list(&self) -> Vec<AlgoView> {
        let mut views: Vec<AlgoView> = self
            .entries
            .lock()
            .unwrap()
            .iter()
            .map(|(_, e)| e.view.lock().unwrap().clone())
            .collect();
        views.sort_by_key(|v| std::cmp::Reverse(v.started_at));
        views
    }

    /// The latest `limit` algos that are over, from the log, newest first.
    pub fn history(&self, limit: usize) -> Vec<AlgoView> {
        let Some(host) = self.host.get() else {
            return Vec::new();
        };
        let Some(log) = host.engine().log() else {
            return Vec::new();
        };
        log.past_algos(limit)
            .unwrap_or_default()
            .into_iter()
            .filter_map(|json| serde_json::from_value::<Saved>(json).ok())
            .map(|saved| saved.view)
            .collect()
    }

    /// After a start: the algos the app closed on. One run on this machine
    /// is marked stopped, and whatever of it still rests is cancelled - it
    /// is never resumed or sent again. One the venue runs is followed again.
    pub async fn reconcile(&self) {
        let Ok(host) = self.host() else { return };
        let Some(log) = host.engine().log() else {
            return;
        };
        let open: Vec<Saved> = log
            .open_algos()
            .unwrap_or_default()
            .into_iter()
            .filter_map(|json| serde_json::from_value(json).ok())
            .collect();
        for saved in open {
            if self.entry(&saved.view.id).is_ok() {
                continue;
            }
            match (saved.view.runs_on, &saved.native_order) {
                (RunsOn::Venue, Some(order)) => self.follow(&host, saved.clone(), order.clone()),
                _ => self.close_after_restart(&host, saved).await,
            }
        }
    }

    /// Follows a venue-run algo again after a restart.
    fn follow(&self, host: &Arc<dyn Host>, saved: Saved, order: String) {
        let Some(exec) = native::resume(&saved.view) else {
            return;
        };
        let view = saved.view;
        let (control, rx) = watch::channel(Control::Run);
        let entry = Arc::new(Entry {
            view: Mutex::new(view.clone()),
            control,
        });
        self.remember(view.id.clone(), Arc::clone(&entry));
        host.publish(&view);
        let rules = Rules {
            tick: D::ZERO,
            step: D::ZERO,
            min: D::ZERO,
        };
        tokio::spawn(run::run(run::Job {
            host: Arc::clone(host),
            entry,
            control: rx,
            exec: Box::new(exec),
            rules,
            spec: view.spec.clone(),
            id: view.id.clone(),
            native_order: Some(order),
            started_at: view.started_at,
        }));
    }

    /// Marks an algo the app closed on as stopped, and cancels what of it
    /// still rests.
    async fn close_after_restart(&self, host: &Arc<dyn Host>, saved: Saved) {
        let engine = host.engine();
        let mut view = saved.view;
        let spec = view.spec.clone();
        let mut detail = None;
        let ids = engine
            .log()
            .and_then(|log| log.algo_client_ids(&view.id).ok())
            .unwrap_or_default();
        if !ids.is_empty() {
            self.budget.take(spec.venue).await;
            let resting = match host.venues().adapter(spec.venue) {
                Ok(adapter) => adapter.account(&spec.account).await.map(|a| a.open_orders),
                Err(e) => Err(e),
            };
            match resting {
                Ok(orders) => {
                    for order in orders
                        .iter()
                        .filter(|o| o.client_id.as_ref().is_some_and(|c| ids.contains(c)))
                    {
                        self.budget.take(spec.venue).await;
                        let by = By {
                            origin: Origin::Engine,
                            algo: Some(&view.id),
                        };
                        if let Err(e) = engine
                            .cancel(
                                host.venues(),
                                by,
                                spec.venue,
                                &spec.account,
                                &order.market,
                                &order.id,
                            )
                            .await
                        {
                            detail = Some(e.to_string());
                        }
                    }
                }
                Err(e) => detail = Some(e.to_string()),
            }
        }
        view.status = AlgoStatus::Stopped;
        view.reason = Some("appClosed".into());
        view.detail = detail;
        view.open_orders = 0;
        view.next_at = None;
        view.updated_at = now_ms();
        let (control, _) = watch::channel(Control::Stop(StopMode::Cancel, "appClosed"));
        let entry = Arc::new(Entry {
            view: Mutex::new(view.clone()),
            control,
        });
        self.remember(view.id.clone(), Arc::clone(&entry));
        run::save(&**host, &entry, None);
        host.publish(&view);
    }
}

#[cfg(test)]
mod tests {
    use pewterdesk_core::{SliceStyle, Unfilled, VenueId};

    use super::*;

    fn spec(kind: AlgoKind) -> AlgoSpec {
        AlgoSpec {
            venue: VenueId::Bybit,
            account: "demo:1".into(),
            market: "BTCUSDT".into(),
            side: pewterdesk_core::Side::Buy,
            size: Decimal("1".parse().unwrap()),
            reduce_only: false,
            max_slippage_bps: 50,
            prefer_native: true,
            kind,
        }
    }

    #[test]
    fn refuses_what_it_cant_run() {
        let twap = |duration_ms, slices| AlgoKind::Twap {
            duration_ms,
            slices,
            randomize: false,
            style: SliceStyle::Market,
            unfilled: Unfilled::Market,
        };
        assert!(validate(&spec(twap(60_000, 6))).is_ok());
        assert!(validate(&spec(twap(1_000, 6))).is_err());
        assert!(validate(&spec(twap(60_000, 0))).is_err());
        assert!(validate(&spec(twap(MAX_DURATION_MS + 1, 6))).is_err());
        let ladder = |count| AlgoKind::Scaled {
            from: Decimal("100".parse().unwrap()),
            to: Decimal("90".parse().unwrap()),
            count,
            distribution: pewterdesk_core::Distribution::Flat,
            post_only: true,
        };
        assert!(validate(&spec(ladder(5))).is_ok());
        assert!(validate(&spec(ladder(1))).is_err());
        let mut zero = spec(ladder(5));
        zero.size = Decimal(D::ZERO);
        assert!(validate(&zero).is_err());
    }
}
