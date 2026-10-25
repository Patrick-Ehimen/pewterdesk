//! One algo's task: it feeds the executor what it can see, sends what it
//! decides through the router, keeps its orders' state, and pauses, stops
//! and finishes it.

use std::sync::Arc;
use std::time::Duration;

use pewterdesk_core::{
    AlgoSpec, AlgoStatus, Decimal, OrderAmend, OrderStatus, Origin, StopMode, VenueError,
};
use rust_decimal::Decimal as D;
use tokio::sync::watch;
use tokio::time::Instant;

use super::exec::{Act, Ctx, Executor, Mine, Outcome};
use super::math::{floor_to, Rules};
use super::{Control, Entry, Host, Saved};
use crate::rules::now_ms;
use crate::By;

/// A book older than this is stale: an algo that needs it pauses.
const STALE_AFTER: Duration = Duration::from_secs(15);
/// How long an order may be missing from the account's open orders before
/// it's looked up in the order history.
const RESOLVE_AFTER: Duration = Duration::from_secs(2);
/// How long an order the venue has no record of is waited for before it's
/// counted as never placed (and is not sent again).
const UNKNOWN_AFTER: Duration = Duration::from_secs(30);
/// How often the order history is read at most, while resolving.
const HISTORY_EVERY: Duration = Duration::from_secs(1);
/// How often fills are read, for the average price and fees.
const FILLS_EVERY: Duration = Duration::from_secs(5);
/// Errors in a row from the venue before the algo pauses.
const MAX_ERRORS: u32 = 5;
/// How long stopping waits for cancels to settle.
const SETTLE_FOR: Duration = Duration::from_secs(20);
/// The longest sleep between looks, whatever the executor asked for.
const TICK: Duration = Duration::from_secs(1);
/// How often a running algo's state is written to the log.
const SAVE_EVERY: Duration = Duration::from_secs(2);

pub(super) struct Job {
    pub host: Arc<dyn Host>,
    pub entry: Arc<Entry>,
    pub control: watch::Receiver<Control>,
    pub exec: Box<dyn Executor>,
    pub rules: Rules,
    pub spec: AlgoSpec,
    pub id: String,
    /// A venue-run algo already placed (followed again after a restart).
    pub native_order: Option<String>,
    /// When it started, in ms since the epoch.
    pub started_at: u64,
}

/// Writes `entry`'s state to the log.
pub(super) fn save(host: &dyn Host, entry: &Entry, native_order: Option<String>) {
    let Some(log) = host.engine().log() else {
        return;
    };
    let view = entry.view.lock().unwrap().clone();
    let saved = Saved {
        native_order,
        view: view.clone(),
    };
    if let Ok(json) = serde_json::to_value(&saved) {
        let _ = log.save_algo(
            &view.id,
            view.started_at,
            view.updated_at,
            view.status.is_over(),
            &json,
        );
    }
}

/// Why an algo is held paused until the trader resumes it.
struct Held {
    reason: &'static str,
    detail: Option<String>,
}

struct Run {
    job: Job,
    /// The instant that stands for `started_at`.
    zero: Instant,
    mine: Vec<Mine>,
    errors: u32,
    held: Option<Held>,
    user_paused: bool,
    last_history: Option<Instant>,
    last_fills: Option<Instant>,
    last_save: Option<Instant>,
    last_generation: u64,
    start_price: Option<D>,
    avg_price: Option<D>,
    fees: Option<D>,
    native_filled: D,
}

pub(super) async fn run(job: Job) {
    // An algo followed again after a restart counts from when it began.
    let since = Duration::from_millis(now_ms().saturating_sub(job.started_at));
    let zero = Instant::now()
        .checked_sub(since)
        .unwrap_or_else(Instant::now);
    let mut native = Vec::new();
    if let Some(order) = &job.native_order {
        native.push(Mine {
            tag: 0,
            client_id: None,
            order_id: Some(order.clone()),
            size: job.spec.size.0,
            price: None,
            filled: D::ZERO,
            open: true,
            sent_at: 0,
            native: true,
        });
    }
    let mut run = Run {
        job,
        zero,
        mine: native,
        errors: 0,
        held: None,
        user_paused: false,
        last_history: None,
        last_fills: None,
        last_save: None,
        last_generation: 0,
        start_price: None,
        avg_price: None,
        fees: None,
        native_filled: D::ZERO,
    };
    run.go().await;
}

impl Run {
    fn now(&self) -> u64 {
        self.zero.elapsed().as_millis() as u64
    }

    fn by(&self) -> By<'_> {
        By {
            origin: Origin::Algo,
            algo: Some(&self.job.id),
        }
    }

    async fn go(&mut self) {
        let host = Arc::clone(&self.job.host);
        let algos = host.engine().algos();
        let venue = self.job.spec.venue;
        let account = algos.feeds.account(&host, venue, &self.job.spec.account);
        let needs_book = self.job.exec.needs_book();
        // The book for the start price, and for executors that act on it.
        let book = algos
            .feeds
            .book(&host, venue, &self.job.spec.account, &self.job.spec.market);
        let mut book_rx = book.watch();
        let mut account_rx = account.watch();
        if self.job.native_order.is_none() {
            let waited = tokio::time::timeout(Duration::from_secs(5), async {
                loop {
                    let sample = book_rx.borrow_and_update().clone();
                    if let Some(b) = sample.fresh(STALE_AFTER) {
                        if let (Some(bid), Some(ask)) = (b.bids.first(), b.asks.first()) {
                            return Some((bid.price.0 + ask.price.0) / D::TWO);
                        }
                    }
                    if book_rx.changed().await.is_err() {
                        return None;
                    }
                }
            })
            .await;
            self.start_price = waited.ok().flatten();
        }
        let book = needs_book.then_some(book);
        let mut wake;
        loop {
            let control = *self.job.control.borrow_and_update();
            match control {
                Control::Stop(mode, reason) => {
                    self.stop(mode, reason).await;
                    return;
                }
                Control::Pause => self.user_paused = true,
                Control::Run => {
                    if self.user_paused || self.held.is_some() {
                        self.user_paused = false;
                        self.held = None;
                        self.errors = 0;
                    }
                }
            }

            let sample = account.latest();
            // A new connection: re-read the algo's orders before acting.
            let reconnected = sample.connected && sample.generation != self.last_generation;
            if reconnected {
                self.last_generation = sample.generation;
            }
            self.sync(reconnected).await;
            self.account_fills(false).await;

            let book_sample = book.as_ref().map(|feed| feed.latest());
            let book_now = book_sample
                .as_ref()
                .and_then(|s| s.fresh(STALE_AFTER).cloned());
            let trouble = if !sample.connected {
                Some("disconnected")
            } else if book.is_some() && book_now.is_none() {
                Some("stale")
            } else {
                None
            };

            let (status, reason, detail) = if self.user_paused {
                (AlgoStatus::Paused, Some("user"), None)
            } else if let Some(held) = &self.held {
                (AlgoStatus::Paused, Some(held.reason), held.detail.clone())
            } else if let Some(trouble) = trouble {
                (AlgoStatus::Paused, Some(trouble), None)
            } else {
                (AlgoStatus::Running, None, None)
            };

            if status == AlgoStatus::Running {
                let now = self.now();
                let decided = {
                    let cx = Ctx {
                        now,
                        book: book_now.as_deref(),
                        mine: &self.mine,
                        rules: &self.job.rules,
                        spec: &self.job.spec,
                        start_price: self.start_price,
                    };
                    self.job.exec.decide(&cx)
                };
                for act in decided.acts {
                    self.act(act).await;
                }
                if let Some(outcome) = decided.outcome {
                    self.finish(outcome).await;
                    return;
                }
                let next = decided.wake.unwrap_or(now + TICK.as_millis() as u64);
                wake = self.zero + Duration::from_millis(next);
            } else {
                // Paused: look again in a tick (or sooner, on news).
                wake = Instant::now() + TICK;
            }
            self.publish(status, reason, detail, false);

            let until = wake.min(Instant::now() + TICK).max(Instant::now());
            let watch_book = status == AlgoStatus::Running && book.is_some();
            tokio::select! {
                _ = self.job.control.changed() => {}
                _ = book_rx.changed(), if watch_book => {}
                _ = account_rx.changed() => {}
                _ = tokio::time::sleep_until(until) => {}
            }
        }
    }

    /// Sends one act through the router, within the venue's budget.
    async fn act(&mut self, act: Act) {
        let host = Arc::clone(&self.job.host);
        let engine = host.engine();
        let spec = self.job.spec.clone();
        engine.algos().budget.take(spec.venue).await;
        match act {
            Act::Place { tag, request } => {
                let sent_at = self.now();
                let size = request.size.0;
                let price = match &request.kind {
                    pewterdesk_core::OrderKind::Limit { price, .. } => Some(price.0),
                    _ => None,
                };
                let native = matches!(request.kind, pewterdesk_core::OrderKind::Twap { .. });
                let (client_id, placed) = engine
                    .place(
                        host.venues(),
                        host.calendar(),
                        self.by(),
                        spec.venue,
                        &spec.account,
                        &request,
                    )
                    .await;
                let mut mine = Mine {
                    tag,
                    client_id: client_id.clone(),
                    order_id: None,
                    size,
                    price,
                    filled: D::ZERO,
                    open: true,
                    sent_at,
                    native,
                };
                match (client_id, placed) {
                    (_, Ok(order)) => {
                        self.errors = 0;
                        mine.order_id = (!order.id.is_empty()).then_some(order.id.clone());
                        mine.filled = order.filled_size.0;
                        mine.open = native
                            || matches!(order.status, OrderStatus::Open | OrderStatus::Pending);
                        self.mine.push(mine);
                    }
                    // Refused before anything was sent: the gate, or the log.
                    (None, Err(why)) => self.hold("refused", &why),
                    // Sent, and the answer was lost: looked up, never resent.
                    (Some(_), Err(VenueError::Network(_))) => {
                        self.errors += 1;
                        self.mine.push(mine);
                    }
                    // Sent, and the venue said no (post-only would cross,...).
                    (Some(_), Err(why)) => {
                        self.errors += 1;
                        mine.open = false;
                        self.mine.push(mine);
                        self.note_error(&why);
                    }
                }
            }
            Act::Amend {
                order_id, price, ..
            } => {
                let amend = OrderAmend {
                    price: Some(Decimal(price)),
                    size: None,
                    take_profit: Default::default(),
                    stop_loss: Default::default(),
                };
                let result = engine
                    .amend(
                        host.venues(),
                        self.by(),
                        spec.venue,
                        &spec.account,
                        &spec.market,
                        &order_id,
                        &amend,
                    )
                    .await;
                match result {
                    Ok(()) => {
                        self.errors = 0;
                        if let Some(m) = self
                            .mine
                            .iter_mut()
                            .find(|m| m.order_id.as_deref() == Some(&order_id))
                        {
                            m.price = Some(price);
                        }
                    }
                    // The venue can't move it: cancel, and the executor
                    // places a new one once that settles.
                    Err(VenueError::Unsupported(_)) => {
                        let _ = engine
                            .cancel(
                                host.venues(),
                                self.by(),
                                spec.venue,
                                &spec.account,
                                &spec.market,
                                &order_id,
                            )
                            .await;
                    }
                    Err(VenueError::Blocked(code)) => {
                        self.hold("refused", &VenueError::Blocked(code));
                    }
                    Err(why) => {
                        self.errors += 1;
                        self.note_error(&why);
                    }
                }
            }
            Act::Cancel { order_id } => {
                let result = engine
                    .cancel(
                        host.venues(),
                        self.by(),
                        spec.venue,
                        &spec.account,
                        &spec.market,
                        &order_id,
                    )
                    .await;
                // Already gone (filled meanwhile) is fine: the sync sees it.
                if result.is_ok() {
                    self.errors = 0;
                }
            }
        }
    }

    fn hold(&mut self, reason: &'static str, why: &VenueError) {
        self.held = Some(Held {
            reason,
            detail: Some(why.to_string()),
        });
    }

    fn note_error(&mut self, why: &VenueError) {
        if self.errors >= MAX_ERRORS {
            self.hold("venueError", why);
        }
    }

    /// Brings the algo's orders up to date: from the account's open orders,
    /// and the order history for one that has left them (or always, after a
    /// reconnect).
    async fn sync(&mut self, force: bool) {
        let host = Arc::clone(&self.job.host);
        let spec = &self.job.spec;
        let algos = host.engine().algos();
        let sample = algos
            .feeds
            .account(&host, spec.venue, &spec.account)
            .latest();
        let mut needs = Vec::new();
        for (i, m) in self.mine.iter_mut().enumerate() {
            if !m.open || m.native {
                continue;
            }
            let found = sample.value.as_ref().and_then(|snapshot| {
                snapshot.open_orders.iter().find(|o| {
                    (m.client_id.is_some() && o.client_id == m.client_id)
                        || (m.order_id.is_some() && Some(&o.id) == m.order_id.as_ref())
                })
            });
            match found {
                Some(order) if !force => {
                    m.order_id = Some(order.id.clone());
                    m.filled = order.filled_size.0;
                    m.price = order.price.map(|p| p.0).or(m.price);
                }
                _ => {
                    let sent = self.zero + Duration::from_millis(m.sent_at);
                    let seen_since = sample.at.is_some_and(|at| at > sent + RESOLVE_AFTER);
                    let stale_feed = !sample.connected || sample.value.is_none();
                    if force || seen_since || (stale_feed && sent.elapsed() > RESOLVE_AFTER) {
                        needs.push(i);
                    }
                }
            }
        }
        if needs.is_empty()
            || self
                .last_history
                .is_some_and(|at| at.elapsed() < HISTORY_EVERY)
        {
            return;
        }
        self.last_history = Some(Instant::now());
        algos.budget.take(spec.venue).await;
        let Ok(adapter) = host.venues().adapter(spec.venue) else {
            return;
        };
        let Ok(history) = adapter.order_history(&spec.account).await else {
            return;
        };
        let open_now: Vec<_> = sample
            .value
            .as_ref()
            .map(|s| s.open_orders.clone())
            .unwrap_or_default();
        for i in needs {
            let m = &mut self.mine[i];
            let known = history.iter().chain(open_now.iter()).find(|o| {
                (m.client_id.is_some() && o.client_id == m.client_id)
                    || (m.order_id.is_some() && Some(&o.id) == m.order_id.as_ref())
            });
            match known {
                Some(order) => {
                    m.order_id = Some(order.id.clone());
                    m.filled = order.filled_size.0;
                    m.open = matches!(order.status, OrderStatus::Open | OrderStatus::Pending);
                }
                None => {
                    let sent = self.zero + Duration::from_millis(m.sent_at);
                    if sent.elapsed() > UNKNOWN_AFTER {
                        // The venue never had it: counted as not placed,
                        // and not sent again.
                        m.open = false;
                    }
                }
            }
        }
    }

    /// The average price and fees from the account's fills, and a native
    /// algo's progress.
    async fn account_fills(&mut self, now: bool) {
        if !now && self.last_fills.is_some_and(|at| at.elapsed() < FILLS_EVERY) {
            return;
        }
        if self.mine.is_empty() {
            return;
        }
        self.last_fills = Some(Instant::now());
        let host = Arc::clone(&self.job.host);
        let spec = &self.job.spec;
        host.engine().algos().budget.take(spec.venue).await;
        let Ok(adapter) = host.venues().adapter(spec.venue) else {
            return;
        };
        let Ok(fills) = adapter.fills(&spec.account).await else {
            return;
        };
        let ids: Vec<&str> = self
            .mine
            .iter()
            .filter_map(|m| m.order_id.as_deref())
            .collect();
        let native = self.mine.iter().any(|m| m.native);
        let mine = fills.iter().filter(|f| {
            ids.contains(&f.order_id.as_str())
                || (native
                    && f.market == spec.market
                    && f.side == spec.side
                    && f.time >= self.job.started_at)
        });
        let (mut size, mut value, mut fees) = (D::ZERO, D::ZERO, D::ZERO);
        for fill in mine {
            size += fill.size.0;
            value += fill.size.0 * fill.price.0;
            fees += fill.fee.0;
        }
        if size > D::ZERO {
            self.avg_price = Some(value / size);
            self.fees = Some(fees);
        }
        if native {
            self.native_filled = size.min(spec.size.0);
            for m in self.mine.iter_mut().filter(|m| m.native) {
                m.filled = self.native_filled;
            }
        }
    }

    fn filled(&self) -> D {
        self.mine.iter().map(|m| m.filled).sum()
    }

    /// Waits for the algo's orders to settle (none open), up to `SETTLE_FOR`.
    async fn settle(&mut self) {
        let until = Instant::now() + SETTLE_FOR;
        while self.mine.iter().any(|m| m.open && !m.native) && Instant::now() < until {
            tokio::time::sleep(Duration::from_millis(500)).await;
            self.sync(false).await;
        }
    }

    async fn cancel_open(&mut self) {
        let open: Vec<String> = self
            .mine
            .iter()
            .filter(|m| m.open)
            .filter_map(|m| m.order_id.clone())
            .collect();
        for order_id in open {
            self.act(Act::Cancel { order_id }).await;
        }
        // A native algo is gone once the venue has its cancel.
        for m in self.mine.iter_mut().filter(|m| m.native) {
            m.open = false;
        }
    }

    /// Stops the algo: cancels what it has open, waits for that to settle,
    /// then (with `FinishAtMarket`) sends exactly what didn't fill.
    async fn stop(&mut self, mode: StopMode, reason: &'static str) {
        // Orders whose answer was lost are found first, so they can be cancelled.
        self.sync(true).await;
        self.cancel_open().await;
        self.settle().await;
        self.account_fills(true).await;
        if mode == StopMode::FinishAtMarket {
            let rest = floor_to(self.job.spec.size.0 - self.filled(), self.job.rules.step);
            if rest >= self.job.rules.min && rest > D::ZERO {
                let spec = &self.job.spec;
                let request = pewterdesk_core::OrderRequest {
                    market: spec.market.clone(),
                    side: spec.side,
                    size: Decimal(rest),
                    reduce_only: spec.reduce_only,
                    collateral: None,
                    client_id: None,
                    take_profit: None,
                    stop_loss: None,
                    kind: pewterdesk_core::OrderKind::Market {
                        max_slippage_bps: spec.max_slippage_bps,
                    },
                };
                self.act(Act::Place {
                    tag: u32::MAX,
                    request,
                })
                .await;
                self.settle().await;
                self.account_fills(true).await;
            }
        }
        let done = self.filled() >= self.job.spec.size.0;
        let status = if done {
            AlgoStatus::Finished
        } else {
            AlgoStatus::Stopped
        };
        let reason = (!done).then_some(reason);
        let detail = self.held.as_ref().and_then(|h| h.detail.clone());
        self.publish(status, reason, detail, true);
    }

    /// Ends the algo as the executor decided, once its orders have settled.
    async fn finish(&mut self, outcome: Outcome) {
        self.settle().await;
        for m in self.mine.iter_mut().filter(|m| m.native) {
            m.open = false;
        }
        self.account_fills(true).await;
        let (status, reason) = match outcome {
            Outcome::Finished => (AlgoStatus::Finished, None),
            Outcome::Stopped(why) => (AlgoStatus::Stopped, Some(why)),
        };
        self.publish(status, reason, None, true);
    }

    /// Updates the algo's view, hands it to the page, and keeps it.
    fn publish(
        &mut self,
        status: AlgoStatus,
        reason: Option<&str>,
        detail: Option<String>,
        force_save: bool,
    ) {
        let host = Arc::clone(&self.job.host);
        let next_at = self.job.exec.next_at();
        let ends_at = self.job.exec.ends_at();
        let filled = self.filled().min(self.job.spec.size.0);
        let open_orders = self.mine.iter().filter(|m| m.open).count() as u32;
        let changed = {
            let mut view = self.job.entry.view.lock().unwrap();
            let before = (
                view.status,
                view.reason.clone(),
                view.filled,
                view.open_orders,
            );
            view.status = status;
            view.reason = reason.map(str::to_owned);
            view.detail = detail;
            view.filled = Decimal(filled);
            view.avg_price = self.avg_price.map(Decimal);
            view.fees = self.fees.map(Decimal);
            view.start_price = self.start_price.map(Decimal);
            view.open_orders = open_orders;
            view.next_at = if status.is_over() {
                None
            } else {
                next_at.map(|ms| self.job.started_at + ms)
            };
            view.ends_at = ends_at.map(|ms| self.job.started_at + ms);
            view.updated_at = now_ms();
            before
                != (
                    view.status,
                    view.reason.clone(),
                    view.filled,
                    view.open_orders,
                )
        };
        if changed || force_save {
            let view = self.job.entry.view.lock().unwrap().clone();
            host.publish(&view);
        }
        let due = self.last_save.is_none_or(|at| at.elapsed() >= SAVE_EVERY);
        if changed || force_save || due {
            self.last_save = Some(Instant::now());
            let native = self
                .mine
                .iter()
                .find(|m| m.native)
                .and_then(|m| m.order_id.clone());
            save(&*host, &self.job.entry, native);
        }
    }
}
