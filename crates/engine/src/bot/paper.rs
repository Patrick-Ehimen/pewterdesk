//! A bot paper trading: its strategy in a backtest session (the
//! backtester's fill model), fed each live candle as it closes. After a
//! restart it's picked up where it was: the candles recorded since its
//! paper run began are fed through again first, and - the strategy and
//! the fill model being deterministic - it ends where it left off.

use pewterdesk_strategy::bot::{paper_costs, BotSpec, BotStatus};
use pewterdesk_strategy::sim::{opens, Session};
use pewterdesk_strategy::{Bar, Intent, Reason};

use super::{day_start, feed, in_hours, log_asked, Control, Job};
use crate::rules::now_ms;

/// Which of its limits the bot is past, after this candle.
fn limit_hit(
    spec: &BotSpec,
    session: &Session,
    bar: &Bar,
    asked_this_minute: usize,
) -> Option<&'static str> {
    let limits = &spec.limits;
    let day = day_start(bar.time);
    let start = session
        .equity_at(day.saturating_sub(1))
        .unwrap_or_else(|| session.capital());
    let today = session.equity_now() - start;
    if limits.daily_loss.is_some_and(|max| today <= -max) {
        return Some("dailyLoss");
    }
    if limits
        .max_position
        .is_some_and(|max| session.position().abs() * bar.close > max)
    {
        return Some("maxPosition");
    }
    if asked_this_minute > limits.orders_per_minute as usize {
        return Some("ordersPerMinute");
    }
    None
}

/// Why the strategy stopped itself, if it did.
fn halt_reason(asked: &[Intent]) -> Option<String> {
    asked.iter().find_map(|i| match i {
        Intent::Halt { reason } => Some(format!("{reason:?}")),
        _ => None,
    })
}

pub(crate) async fn run(mut job: Job) {
    let spec = job.entry.view.lock().unwrap().spec.clone();
    let since = job
        .entry
        .view
        .lock()
        .unwrap()
        .paper_since
        .unwrap_or_else(now_ms);
    let interval_ms = spec.interval.millis();
    let mut session = match Session::new(
        &spec.strategy,
        paper_costs(spec.venue, spec.paper_capital),
        interval_ms,
        u64::MAX,
    ) {
        Ok(session) => session,
        Err(why) => return job.finish(BotStatus::Failed, Some(why)),
    };
    let (history, mut candles) = match job.candles(&spec).await {
        Ok(feed) => feed,
        Err(e) => return job.finish(BotStatus::Failed, Some(e.to_string())),
    };
    // History from before the paper run is only read; what came since is
    // traded again, as it was.
    let replay: Vec<Bar> = match job.recording(&spec) {
        Some(rec) => feed::recorded(&rec, since, u64::MAX),
        None => Vec::new(),
    };
    let warm: Vec<Bar> = history.iter().copied().filter(|b| b.time < since).collect();
    session.warm(&warm);
    let mut last_time: Option<u64> = None;
    for bar in replay
        .iter()
        .chain(history.iter().filter(|b| b.time >= since))
    {
        if last_time.is_none_or(|t| bar.time > t) {
            session.step(*bar);
            last_time = Some(bar.time);
        }
    }
    let show = |job: &Job, session: &Session, bar: Option<&Bar>| {
        let today = bar.map_or(0.0, |b| {
            let start = session
                .equity_at(day_start(b.time).saturating_sub(1))
                .unwrap_or_else(|| session.capital());
            session.equity_now() - start
        });
        job.update(|v| {
            v.position = session.position();
            v.entry = session.entry();
            v.equity = session.equity_now();
            v.pnl_total = session.equity_now() - session.capital();
            v.pnl_today = today;
            v.trades = session.trade_count() as u32;
            v.candles = session.candles() as u32;
            v.last = session.last_asked().cloned();
        });
    };
    show(&job, &session, None);

    let mut paused = false;
    let mut recent: Vec<u64> = Vec::new();
    loop {
        tokio::select! {
            changed = job.control.changed() => {
                if changed.is_err() {
                    return job.finish(BotStatus::Stopped, None);
                }
                let control = *job.control.borrow();
                match control {
                    Control::Run => {
                        paused = false;
                        job.update(|v| v.status = BotStatus::Running);
                    }
                    Control::Pause => {
                        paused = true;
                        job.update(|v| v.status = BotStatus::Paused);
                    }
                    Control::Stop { flatten } => {
                        if flatten {
                            session.flatten_and_halt(Reason::End);
                        }
                        show(&job, &session, None);
                        return job.finish(BotStatus::Stopped, None);
                    }
                }
            }
            bar = candles.recv() => {
                let Some(bar) = bar else {
                    return job.finish(BotStatus::Failed, Some("the candle feed ended".into()));
                };
                if last_time.is_some_and(|t| bar.time <= t) {
                    continue;
                }
                last_time = Some(bar.time);
                if paused {
                    continue;
                }
                let hours = spec.limits.hours;
                let asked = session.step_allowing(bar, &|i| !opens(i) || in_hours(hours, bar.time));
                let id = job.entry.view.lock().unwrap().id.clone();
                log_asked(&job.host, &spec, &id, bar.time, &asked);
                recent.retain(|t| *t + 60_000 > bar.time);
                recent.extend(asked.iter().map(|_| bar.time));
                if let Some(limit) = limit_hit(&spec, &session, &bar, recent.len()) {
                    if spec.limits.flatten_on_stop {
                        session.flatten_and_halt(Reason::Limit);
                    } else {
                        session.halt();
                    }
                    show(&job, &session, Some(&bar));
                    return job.finish(BotStatus::Limit, Some(limit.into()));
                }
                show(&job, &session, Some(&bar));
                if session.halted() {
                    return job.finish(BotStatus::Limit, halt_reason(&asked).or(Some("stopOut".into())));
                }
            }
        }
    }
}
