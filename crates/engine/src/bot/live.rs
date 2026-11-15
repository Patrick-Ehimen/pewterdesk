//! A bot trading live: its strategy on each candle as it closes, shown the
//! account as the venue has it, its intents sent through the router
//! (`Origin::Bot`, the bot's id on the command) - the live switch, the
//! trader's rules, the log, client ids - like any order. Sizes are cut to
//! the market's step and prices to its tick (a buy's down, a sell's up).
//!
//! A refusal stops the bot (it's never tried again around one); so does an
//! answer that didn't come (it's looked up by its client id at the next
//! start, never sent again). Its own limits: an opening order past its
//! position cap, its orders a minute, or a day's loss on the account
//! stops it; outside its hours it opens nothing.
//!
//! Fills are read from the venue: a limit it placed that's no longer open
//! is looked up in the order history - filled, the strategy hears of it;
//! gone otherwise, it may ask again.

use std::collections::BTreeMap;
use std::sync::Arc;
use std::time::Instant;

use pewterdesk_core::{
    AccountSnapshot, Decimal, ExitChange, Market, OrderKind, OrderRequest, OrderStatus,
    PositionProtection, PositionSide, Side, TimeInForce, VenueError,
};
use pewterdesk_strategy::bot::{BotSpec, BotStatus, BotView};
use pewterdesk_strategy::sim::{opens, Asked};
use pewterdesk_strategy::{Bar, Fill, Intent, Reason, Resting, Snapshot, Strategy};
use rust_decimal::prelude::{FromPrimitive, ToPrimitive};
use rust_decimal::Decimal as D;

use super::{by, day_start, in_hours, log_asked, tag, Control, Job};
use crate::algo::Host;

/// A limit the bot has resting, by its strategy's tag.
#[derive(Clone, Debug)]
struct Placed {
    order_id: String,
    side: Side,
    price: f64,
    size: f64,
}

/// Why a live bot stops.
enum Stop {
    Limit(&'static str),
    Failed(String),
    Strategy(String),
}

fn num(d: &Decimal) -> f64 {
    d.0.to_f64().unwrap_or(0.0)
}

/// `value` on `step`'s grid: down, or up.
fn on_grid(value: f64, step: &Decimal, up: bool) -> Option<Decimal> {
    let v = D::from_f64(value)?;
    let step = step.0;
    if step <= D::ZERO {
        return Some(Decimal(v));
    }
    let n = v / step;
    let n = if up { n.ceil() } else { n.floor() };
    let mut out = n * step;
    out.rescale(step.scale());
    Some(Decimal(out))
}

struct Live {
    host: Arc<dyn Host>,
    id: String,
    spec: BotSpec,
    market: Market,
    tag: String,
    strategy: Box<dyn Strategy>,
    placed: BTreeMap<String, Placed>,
    /// The exits asked for, and those set on the venue.
    exits: (Option<f64>, Option<f64>),
    exits_set: Option<(Option<f64>, Option<f64>)>,
    sent: Vec<Instant>,
    bars: Vec<Bar>,
    /// The account's equity at the start of the UTC day, as first seen.
    day: Option<(u64, f64)>,
}

impl Live {
    async fn account(&self) -> Result<AccountSnapshot, VenueError> {
        self.host
            .venues()
            .adapter(self.spec.venue)?
            .account(&self.spec.account)
            .await
    }

    /// The bot's position on its market: signed size and entry.
    fn position(&self, a: &AccountSnapshot) -> (f64, f64) {
        a.positions
            .iter()
            .find(|p| p.market == self.spec.market)
            .map_or((0.0, 0.0), |p| {
                let size = num(&p.size).abs();
                let signed = if p.side == PositionSide::Long {
                    size
                } else {
                    -size
                };
                (signed, num(&p.entry_price))
            })
    }

    /// Its limits that are gone from the venue: filled ones told to the
    /// strategy, cancelled ones forgotten.
    async fn read_fills(&mut self, a: &AccountSnapshot) -> Result<(), VenueError> {
        let gone: Vec<(String, Placed)> = self
            .placed
            .iter()
            .filter(|(_, p)| !a.open_orders.iter().any(|o| o.id == p.order_id))
            .map(|(t, p)| (t.clone(), p.clone()))
            .collect();
        if gone.is_empty() {
            return Ok(());
        }
        let history = self
            .host
            .venues()
            .adapter(self.spec.venue)?
            .order_history(&self.spec.account)
            .await?;
        for (t, placed) in gone {
            self.placed.remove(&t);
            match history.iter().find(|o| o.id == placed.order_id) {
                Some(o) if o.status == OrderStatus::Filled => self.strategy.on_fill(&Fill {
                    tag: Some(t),
                    side: placed.side,
                    price: o.price.as_ref().map_or(placed.price, num),
                    size: num(&o.filled_size).max(placed.size.min(num(&o.size))),
                    reason: Reason::Entry,
                }),
                _ => self.strategy.on_gone(&t),
            }
        }
        Ok(())
    }

    /// Counts an order against the bot's orders-a-minute.
    fn count_order(&mut self) -> Result<(), Stop> {
        let now = Instant::now();
        self.sent.retain(|t| now.duration_since(*t).as_secs() < 60);
        if self.sent.len() >= self.spec.limits.orders_per_minute as usize {
            return Err(Stop::Limit("ordersPerMinute"));
        }
        self.sent.push(now);
        Ok(())
    }

    async fn place(&mut self, request: OrderRequest) -> Result<pewterdesk_core::Order, Stop> {
        self.count_order()?;
        let engine = self.host.engine();
        let (_, placed) = engine
            .place(
                self.host.venues(),
                self.host.calendar(),
                by(&self.tag),
                self.spec.venue,
                &self.spec.account,
                &request,
            )
            .await;
        placed.map_err(|e| match e {
            VenueError::Blocked(code) => Stop::Failed(format!("refused: {code}")),
            other => Stop::Failed(other.to_string()),
        })
    }

    async fn cancel(&mut self, t: &str) -> Result<(), Stop> {
        let Some(placed) = self.placed.remove(t) else {
            return Ok(());
        };
        let engine = self.host.engine();
        engine
            .cancel(
                self.host.venues(),
                by(&self.tag),
                self.spec.venue,
                &self.spec.account,
                &self.spec.market,
                &placed.order_id,
            )
            .await
            .map_err(|e| Stop::Failed(format!("a cancel failed: {e}")))
    }

    async fn cancel_all(&mut self) {
        let tags: Vec<String> = self.placed.keys().cloned().collect();
        for t in tags {
            let _ = self.cancel(&t).await;
        }
    }

    fn market_order(&self, side: Side, size: Decimal, reduce_only: bool) -> OrderRequest {
        OrderRequest {
            market: self.spec.market.clone(),
            side,
            size,
            reduce_only,
            collateral: None,
            client_id: None,
            take_profit: None,
            stop_loss: None,
            kind: OrderKind::Market {
                max_slippage_bps: self.spec.max_slippage_bps,
            },
        }
    }

    /// A size on the market's step, or none if it's under the minimum.
    fn size(&self, size: f64) -> Option<Decimal> {
        let cut = on_grid(size.abs(), &self.market.size_step, false)?;
        (cut.0 > D::ZERO && cut.0 >= self.market.min_size.0).then_some(cut)
    }

    /// Whether an opening order of `size` keeps the position inside its cap.
    fn within_cap(&self, position: f64, side: Side, size: f64, price: f64) -> bool {
        let Some(max) = self.spec.limits.max_position else {
            return true;
        };
        let after = position + if side == Side::Buy { size } else { -size };
        after.abs() * price <= max
    }

    async fn close(&mut self, position: f64) -> Result<(), Stop> {
        if position.abs() <= 0.0 {
            return Ok(());
        }
        let side = if position > 0.0 {
            Side::Sell
        } else {
            Side::Buy
        };
        // The whole position, on the step (a little left over beats more).
        let Some(size) = on_grid(position.abs(), &self.market.size_step, true) else {
            return Ok(());
        };
        let request = self.market_order(side, size, true);
        self.place(request).await.map(|_| ())
    }

    async fn apply(&mut self, intent: Intent, position: f64, bar: &Bar) -> Result<(), Stop> {
        let open_ok = in_hours(self.spec.limits.hours, bar.time) || !opens(&intent);
        if !open_ok {
            return Ok(());
        }
        match intent {
            Intent::Market {
                side,
                size,
                reduce_only,
                ..
            } => {
                if !reduce_only && !self.within_cap(position, side, size, bar.close) {
                    return Err(Stop::Limit("maxPosition"));
                }
                let Some(size) = self.size(size) else {
                    return Ok(());
                };
                let request = self.market_order(side, size, reduce_only);
                self.place(request).await?;
            }
            Intent::Limit {
                tag: t,
                side,
                price,
                size,
                reduce_only,
                ..
            } => {
                if !reduce_only && !self.within_cap(position, side, size, price) {
                    return Err(Stop::Limit("maxPosition"));
                }
                self.cancel(&t).await?;
                let (Some(cut), Some(at)) = (
                    self.size(size),
                    on_grid(price, &self.market.tick_size, side == Side::Sell),
                ) else {
                    return Ok(());
                };
                let request = OrderRequest {
                    kind: OrderKind::Limit {
                        price: at,
                        time_in_force: Some(TimeInForce::Gtc),
                    },
                    ..self.market_order(side, cut, reduce_only)
                };
                let order = self.place(request).await?;
                self.placed.insert(
                    t,
                    Placed {
                        order_id: order.id,
                        side,
                        price: num(&at),
                        size: num(&cut),
                    },
                );
            }
            Intent::Cancel { tag: t } => self.cancel(&t).await?,
            Intent::Exits { stop, target, .. } => self.exits = (stop, target),
            Intent::Close { .. } => self.close(position).await?,
            Intent::Halt { reason } => return Err(Stop::Strategy(format!("{reason:?}"))),
        }
        Ok(())
    }

    /// The exits asked for, set on the venue once there's a position to
    /// protect (and whenever they change).
    async fn protect(&mut self, position: f64) -> Result<(), Stop> {
        if position.abs() <= 0.0 || self.exits_set == Some(self.exits) {
            return Ok(());
        }
        let change =
            |v: Option<f64>, tick: &Decimal, up: bool| match v.and_then(|p| on_grid(p, tick, up)) {
                Some(p) => ExitChange::Set(p),
                None => ExitChange::Remove,
            };
        let long = position > 0.0;
        let protection = PositionProtection {
            // A long's stop rounds up (tighter), its target down; a short's the other way.
            stop_loss: change(self.exits.0, &self.market.tick_size, long),
            take_profit: change(self.exits.1, &self.market.tick_size, !long),
            trailing_stop: ExitChange::Keep,
            trailing_activation: None,
        };
        self.count_order()?;
        let engine = self.host.engine();
        engine
            .set_position_protection(
                self.host.venues(),
                pewterdesk_core::Origin::Bot,
                self.spec.venue,
                &self.spec.account,
                &self.spec.market,
                &protection,
            )
            .await
            .map_err(|e| Stop::Failed(format!("its exits couldn't be set: {e}")))?;
        self.exits_set = Some(self.exits);
        Ok(())
    }

    /// One closed candle: the account read, fills told, the strategy's
    /// turn, its intents sent.
    async fn step(&mut self, bar: Bar) -> Result<(AccountSnapshot, Vec<Intent>), Stop> {
        self.bars.push(bar);
        let account = self
            .account()
            .await
            .map_err(|e| Stop::Failed(e.to_string()))?;
        self.read_fills(&account)
            .await
            .map_err(|e| Stop::Failed(e.to_string()))?;
        let (position, entry) = self.position(&account);
        let equity = num(&account.equity);
        // A day's loss, on the account, from its first candle of the day.
        let day = day_start(bar.time);
        let start = match self.day {
            Some((d, e)) if d == day => e,
            _ => {
                self.day = Some((day, equity));
                equity
            }
        };
        if self
            .spec
            .limits
            .daily_loss
            .is_some_and(|max| equity - start <= -max)
        {
            return Err(Stop::Limit("dailyLoss"));
        }
        self.protect(position).await?;
        let resting: Vec<Resting> = self
            .placed
            .iter()
            .map(|(t, p)| Resting {
                tag: t.clone(),
                side: p.side,
                price: p.price,
                size: p.size,
            })
            .collect();
        let asked = self.strategy.on_bar(&Snapshot {
            bars: &self.bars,
            position,
            entry,
            equity,
            resting: &resting,
        });
        log_asked(&self.host, &self.spec, &self.id, bar.time, &asked);
        for intent in asked.clone() {
            self.apply(intent, position, &bar).await?;
        }
        Ok((account, asked))
    }
}

pub(crate) async fn run(mut job: Job) {
    let spec = job.entry.view.lock().unwrap().spec.clone();
    let market = match job.host.venues().adapter(spec.venue) {
        Ok(adapter) => match adapter.markets().await {
            Ok(markets) => markets.into_iter().find(|m| m.id == spec.market),
            Err(e) => return job.finish(BotStatus::Failed, Some(e.to_string())),
        },
        Err(e) => return job.finish(BotStatus::Failed, Some(e.to_string())),
    };
    let Some(market) = market else {
        return job.finish(BotStatus::Failed, Some("its market isn't listed".into()));
    };
    let strategy = match spec.strategy.build() {
        Ok(s) => s,
        Err(why) => return job.finish(BotStatus::Failed, Some(why)),
    };
    let (history, mut candles) = match job.candles(&spec).await {
        Ok(feed) => feed,
        Err(e) => return job.finish(BotStatus::Failed, Some(e.to_string())),
    };
    let id = job.entry.view.lock().unwrap().id.clone();
    let mut live = Live {
        host: Arc::clone(&job.host),
        id: id.clone(),
        tag: tag(&id),
        spec: spec.clone(),
        market,
        strategy,
        placed: BTreeMap::new(),
        exits: (None, None),
        exits_set: None,
        sent: Vec::new(),
        bars: Vec::new(),
        day: None,
    };
    // History is read, not traded.
    live.strategy.warm(&history);
    let mut last_time = history.last().map(|b| b.time);
    let mut paused = false;
    let mut trades = 0u32;
    loop {
        tokio::select! {
            changed = job.control.changed() => {
                if changed.is_err() {
                    live.cancel_all().await;
                    return job.finish(BotStatus::Stopped, None);
                }
                let control = *job.control.borrow();
                match control {
                    Control::Run => { paused = false; job.update(|v| v.status = BotStatus::Running); }
                    Control::Pause => { paused = true; job.update(|v| v.status = BotStatus::Paused); }
                    Control::Stop { flatten } => {
                        live.cancel_all().await;
                        if flatten {
                            if let Ok(a) = live.account().await {
                                let (position, _) = live.position(&a);
                                let _ = live.close(position).await;
                            }
                        }
                        return job.finish(BotStatus::Stopped, None);
                    }
                }
            }
            bar = candles.recv() => {
                let Some(bar) = bar else {
                    live.cancel_all().await;
                    return job.finish(BotStatus::Failed, Some("the candle feed ended".into()));
                };
                if last_time.is_some_and(|t| bar.time <= t) || paused {
                    last_time = Some(last_time.map_or(bar.time, |t| t.max(bar.time)));
                    continue;
                }
                last_time = Some(bar.time);
                match live.step(bar).await {
                    Ok((account, asked)) => {
                        let (position, entry) = live.position(&account);
                        trades += asked.iter().filter(|i| matches!(i, Intent::Market { .. })).count() as u32;
                        let last = asked.last().map(|i| Asked { time: bar.time, intent: i.clone() });
                        let start = live.day.map_or(0.0, |(_, e)| e);
                        job.update(|v: &mut BotView| {
                            v.position = position;
                            v.entry = entry;
                            v.equity = num(&account.equity);
                            v.pnl_today = num(&account.equity) - start;
                            v.trades = trades;
                            v.candles += 1;
                            if last.is_some() {
                                v.last = last;
                            }
                        });
                    }
                    Err(stop) => {
                        live.cancel_all().await;
                        let (status, reason) = match stop {
                            Stop::Limit(why) => {
                                if spec.limits.flatten_on_stop {
                                    if let Ok(a) = live.account().await {
                                        let (position, _) = live.position(&a);
                                        let _ = live.close(position).await;
                                    }
                                }
                                (BotStatus::Limit, why.to_owned())
                            }
                            Stop::Strategy(why) => (BotStatus::Limit, why),
                            Stop::Failed(why) => (BotStatus::Failed, why),
                        };
                        return job.finish(status, Some(reason));
                    }
                }
            }
        }
    }
}

/// After a restart: what a live bot left resting is cancelled (found by the
/// client ids the log has for it), nothing sent again.
pub(crate) async fn cancel_left_over(host: &Arc<dyn Host>, view: &BotView) {
    let engine = host.engine();
    let Some(log) = engine.log() else { return };
    let ids = log.algo_client_ids(&tag(&view.id)).unwrap_or_default();
    if ids.is_empty() {
        return;
    }
    let Ok(adapter) = host.venues().adapter(view.spec.venue) else {
        return;
    };
    let Ok(account) = adapter.account(&view.spec.account).await else {
        return;
    };
    let t = tag(&view.id);
    for order in account
        .open_orders
        .iter()
        .filter(|o| o.client_id.as_ref().is_some_and(|c| ids.contains(c)))
    {
        let _ = engine
            .cancel(
                host.venues(),
                by(&t),
                view.spec.venue,
                &view.spec.account,
                &order.market,
                &order.id,
            )
            .await;
    }
}
