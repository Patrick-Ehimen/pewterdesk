//! Trading rules: the trader's own limits (daily loss, drawdown, risk per
//! trade, position size, trades a day, trading hours, a cool-off after
//! losses), kept here and checked here before an order is signed.
//!
//! Security-relevant - review any change against
//! `.claude/commands/security-review.md`: this sits on the signing path.
//! - It only ever refuses. An order that reduces a position, a cancel, and
//!   an exit moved closer always pass; nothing here signs or builds a request.
//! - The check that matters runs in Rust, in the trading commands
//!   (`venues.rs`), against the venue's own account, fills and closed trades,
//!   whatever window, hotkey or script asked. The page only mirrors it.
//! - It fails closed: an opening order is refused when the account can't be
//!   read to check it.
//! - Each account has its own rules (a prop firm's, a venue's), checked only
//!   against that account's orders.
//! - Loosening a rule or turning rules off has no immediate command: it is
//!   stored and takes effect at the next 00:00 UTC. Tightening applies at
//!   once. Deleting a set of rules, though, is immediate, on or off: it is
//!   the one way out that doesn't wait, and the page asks first.
//! - The file holds rules and equity figures, no key material.
//! - It guards a trader against themselves on this app. It does not stop an
//!   order placed on the venue's own site, though that order still counts.

use std::collections::{BTreeSet, HashMap};
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use pewterdesk_core::{
    AccountSnapshot, ClosedTrade, Decimal, ExitChange, Fill, FillEffect, OrderAmend, OrderKind,
    OrderRequest, PositionProtection, PositionSide, Side, VenueError, VenueId,
};
use serde::{Deserialize, Serialize};
use tauri::State;

use crate::venues::Venues;

/// The file the rules and their progress are kept in, in the app's config folder.
pub const FILE: &str = "trading-rules.json";

const DAY_MS: u64 = 86_400_000;
const MINUTE_MS: u64 = 60_000;
/// Where "warn at 80%" warns: the share of the daily limit used.
const WARN_AT: f64 = 0.8;
/// How far back closed trades are read, for the usual size and pace.
const HISTORY_DAYS: u64 = 30;
/// How long the day's fills and closed trades are reused between checks.
const RECENT_FOR: Duration = Duration::from_secs(5);
/// How long the 30-day history is reused.
const HISTORY_FOR: Duration = Duration::from_secs(600);
/// The most daily points kept for the equity chart.
const CURVE_MAX: usize = 400;
/// The most accounts with rules of their own, and the longest name one is kept under.
const MAX_SETS: usize = 20;
const NAME_MAX: usize = 40;
/// The trades whose sizes the dashboard shows.
const RECENT_SIZES: usize = 5;

fn num(d: Decimal) -> f64 {
    d.0.to_string().parse().unwrap_or(0.0)
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| d.as_millis() as u64)
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Preset {
    Classic,
    OneStep,
    Instant,
    Own,
}

/// What reaching a limit does. `Warn` never refuses an order.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Breach {
    Warn,
    WarnLock,
    Lock,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum DailyFrom {
    Balance,
    Equity,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum MaxKind {
    Static,
    Intraday,
    Eod,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum HourDays {
    Weekdays,
    EveryDay,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum StopMode {
    Stop,
    Warn,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum RevengeMode {
    Warn,
    CoolOff,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Challenge {
    /// The balance the rules start from, in USD; the percentages are of this.
    pub size: f64,
    pub target_pct: f64,
    pub daily_pct: f64,
    pub daily_from: DailyFrom,
    pub max_pct: f64,
    pub max_kind: MaxKind,
    pub min_days: f64,
    pub max_days: f64,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TradeLoss {
    pub pct: f64,
    pub mode: StopMode,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct PositionLimit {
    pub usd: f64,
    pub leverage: f64,
}

/// UTC, "HH:MM". A window that ends before it starts runs over midnight.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Hours {
    pub days: HourDays,
    pub from: String,
    pub to: String,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct News {
    pub on: bool,
    pub minutes: f64,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct CoolOff {
    pub losses: f64,
    pub minutes: f64,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Revenge {
    pub on: bool,
    pub minutes: f64,
    pub mode: RevengeMode,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Factor {
    pub on: bool,
    pub factor: f64,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Tilt {
    pub revenge: Revenge,
    pub size_creep: Factor,
    pub overtrading: Factor,
}

/// The rules as the page edits them (`lib/tradingRules.ts` is the same shape).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Rules {
    pub preset: Preset,
    pub breach: Breach,
    pub challenge: Challenge,
    pub trade_loss: TradeLoss,
    pub position: PositionLimit,
    pub trades_per_day: f64,
    pub hours: Hours,
    pub news: News,
    pub cool_off: CoolOff,
    pub tilt: Tilt,
}

impl Default for Rules {
    fn default() -> Self {
        Self {
            preset: Preset::Own,
            breach: Breach::WarnLock,
            challenge: Challenge {
                size: 10_000.0,
                target_pct: 0.0,
                daily_pct: 5.0,
                daily_from: DailyFrom::Equity,
                max_pct: 10.0,
                max_kind: MaxKind::Static,
                min_days: 0.0,
                max_days: 0.0,
            },
            trade_loss: TradeLoss {
                pct: 1.0,
                mode: StopMode::Stop,
            },
            position: PositionLimit {
                usd: 25_000.0,
                leverage: 10.0,
            },
            trades_per_day: 8.0,
            hours: Hours {
                days: HourDays::Weekdays,
                from: "07:00".into(),
                to: "20:00".into(),
            },
            news: News {
                on: false,
                minutes: 15.0,
            },
            cool_off: CoolOff {
                losses: 3.0,
                minutes: 30.0,
            },
            tilt: Tilt {
                revenge: Revenge {
                    on: true,
                    minutes: 10.0,
                    mode: RevengeMode::CoolOff,
                },
                size_creep: Factor {
                    on: true,
                    factor: 1.5,
                },
                overtrading: Factor {
                    on: true,
                    factor: 1.5,
                },
            },
        }
    }
}

/// "HH:MM" as minutes into the day.
fn clock(text: &str) -> Option<u64> {
    let (h, m) = text.split_once(':')?;
    if h.len() != 2 || m.len() != 2 {
        return None;
    }
    let (h, m) = (h.parse::<u64>().ok()?, m.parse::<u64>().ok()?);
    (h < 24 && m < 60).then_some(h * 60 + m)
}

/// The minutes of the day a trading window covers.
fn window(hours: &Hours) -> BTreeSet<u64> {
    let (Some(from), Some(to)) = (clock(&hours.from), clock(&hours.to)) else {
        return BTreeSet::new();
    };
    (0..1440)
        .filter(|m| {
            if from < to {
                (from..to).contains(m)
            } else {
                from != to && (*m >= from || *m < to)
            }
        })
        .collect()
}

impl Rules {
    /// Whether every number is one a rule can be, so nothing unreadable
    /// (a NaN, a negative limit) is ever checked against.
    fn valid(&self) -> Result<(), &'static str> {
        let within = |v: f64, lo: f64, hi: f64| v.is_finite() && v >= lo && v <= hi;
        let c = &self.challenge;
        let ok = within(c.size, 1.0, 1e12)
            && within(c.target_pct, 0.0, 1000.0)
            && within(c.daily_pct, 0.01, 100.0)
            && within(c.max_pct, 0.01, 100.0)
            && within(c.min_days, 0.0, 365.0)
            && within(c.max_days, 0.0, 3650.0)
            && within(self.trade_loss.pct, 0.01, 100.0)
            && within(self.position.usd, 1.0, 1e12)
            && within(self.position.leverage, 0.01, 1000.0)
            && within(self.trades_per_day, 1.0, 10_000.0)
            && clock(&self.hours.from).is_some()
            && clock(&self.hours.to).is_some()
            && within(self.news.minutes, 0.0, 1440.0)
            && within(self.cool_off.losses, 1.0, 100.0)
            && within(self.cool_off.minutes, 0.0, 1440.0)
            && within(self.tilt.revenge.minutes, 0.0, 1440.0)
            && within(self.tilt.size_creep.factor, 1.0, 100.0)
            && within(self.tilt.overtrading.factor, 1.0, 100.0);
        if ok {
            Ok(())
        } else {
            Err("a rule is out of range")
        }
    }

    /// Whether these rules start the challenge over from `old`'s: another
    /// preset or account size.
    fn restarts(&self, old: &Rules) -> bool {
        self.preset != old.preset || self.challenge.size != old.challenge.size
    }

    /// Whether these rules let through anything `old` would have refused.
    /// Such a change waits for the next day; anything else applies at once.
    fn looser_than(&self, old: &Rules) -> bool {
        let (c, o) = (&self.challenge, &old.challenge);
        let days_wider =
            self.hours.days == HourDays::EveryDay && old.hours.days == HourDays::Weekdays;
        self.restarts(old)
            || self.breach < old.breach
            || c.daily_pct > o.daily_pct
            || c.daily_from != o.daily_from
            || c.max_pct > o.max_pct
            || c.max_kind != o.max_kind
            || self.trade_loss.pct > old.trade_loss.pct
            || (self.trade_loss.mode == StopMode::Warn && old.trade_loss.mode == StopMode::Stop)
            || self.position.usd > old.position.usd
            || self.position.leverage > old.position.leverage
            || self.trades_per_day > old.trades_per_day
            || days_wider
            || !window(&self.hours).is_subset(&window(&old.hours))
            || self.cool_off.losses > old.cool_off.losses
            || self.cool_off.minutes < old.cool_off.minutes
            || (old.tilt.revenge.on
                && (!self.tilt.revenge.on
                    || self.tilt.revenge.minutes < old.tilt.revenge.minutes
                    || (self.tilt.revenge.mode == RevengeMode::Warn
                        && old.tilt.revenge.mode == RevengeMode::CoolOff)))
    }

    fn daily(&self) -> f64 {
        self.challenge.size * self.challenge.daily_pct / 100.0
    }

    fn max(&self) -> f64 {
        self.challenge.size * self.challenge.max_pct / 100.0
    }

    fn trade_risk(&self) -> f64 {
        self.challenge.size * self.trade_loss.pct / 100.0
    }

    /// Whether the trading hours are open at `now`.
    fn open_at(&self, now: u64) -> bool {
        let minute = now / MINUTE_MS % 1440;
        if !window(&self.hours).contains(&minute) {
            return false;
        }
        if self.hours.days == HourDays::EveryDay {
            return true;
        }
        let (from, to) = (clock(&self.hours.from), clock(&self.hours.to));
        // The day a window belongs to is the one it started on.
        let over_midnight = from > to && Some(minute) < to;
        let day = now / DAY_MS - u64::from(over_midnight);
        // 1 January 1970 was a Thursday.
        !matches!((day + 4) % 7, 0 | 6)
    }
}

/// The account a set of rules is checked against.
#[derive(Clone, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct Account {
    pub venue: VenueId,
    pub id: String,
}

/// A change waiting for the next day.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
struct Pending {
    on: bool,
    rules: Rules,
    /// When it takes effect (ms).
    at: u64,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
struct Day {
    /// Days since the epoch, UTC.
    index: u64,
    /// The balance and the equity the day began with.
    start_balance: f64,
    start_equity: f64,
}

#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
pub struct Point {
    pub at: u64,
    pub equity: f64,
}

/// Where the account has got to since the rules were started.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
struct Progress {
    started_at: u64,
    /// The highest equity seen, and the highest a day ended on.
    peak: f64,
    eod_peak: f64,
    day: Option<Day>,
    /// The last equity seen.
    last: Option<Point>,
    /// One point a day, oldest first.
    curve: Vec<Point>,
    /// The day (index) opening orders were locked on.
    day_locked: Option<u64>,
    /// When the overall drawdown was breached: locked until started over.
    failed_at: Option<u64>,
}

/// One account's rules: a prop firm's, a venue's, a second account's. Each
/// account has at most one set, with its own progress.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
struct Set {
    /// The trader's name for it ("Firm 100k"); may be empty.
    #[serde(default)]
    name: String,
    on: bool,
    account: Account,
    rules: Rules,
    pending: Option<Pending>,
    #[serde(default)]
    progress: Progress,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
struct Saved {
    sets: Vec<Set>,
}

/// The file as it was when there was one set of rules, for reading it once more.
#[derive(Deserialize)]
struct SavedOnce {
    on: bool,
    account: Option<Account>,
    rules: Rules,
    #[serde(default)]
    progress: Progress,
}

impl Saved {
    fn read(bytes: &[u8]) -> Self {
        if let Ok(saved) = serde_json::from_slice::<Saved>(bytes) {
            return saved;
        }
        // The one set an earlier version kept, carried over with its progress.
        let sets = serde_json::from_slice::<SavedOnce>(bytes)
            .ok()
            .and_then(|old| {
                Some(Set {
                    name: String::new(),
                    on: old.on,
                    account: old.account?,
                    rules: old.rules,
                    pending: None,
                    progress: old.progress,
                })
            })
            .into_iter()
            .collect();
        Self { sets }
    }

    fn set_for(&mut self, account: &Account) -> Option<&mut Set> {
        self.sets.iter_mut().find(|s| s.account == *account)
    }
}

/// An order going in, a trade opened, as the rules count them.
#[derive(Clone, Debug, PartialEq)]
struct Entry {
    market: String,
    at: u64,
    notional: f64,
}

#[derive(Clone, Debug, PartialEq)]
struct Closed {
    market: String,
    at: u64,
    opened_at: Option<u64>,
    side: PositionSide,
    pnl: f64,
    entry_value: f64,
}

#[derive(Clone, Debug, PartialEq)]
struct Held {
    market: String,
    side: PositionSide,
    size: f64,
    notional: f64,
    entry: f64,
    mark: f64,
    stop: Option<f64>,
    unrealized: f64,
}

/// What the venue says about the account right now.
#[derive(Clone, Debug, Default, PartialEq)]
struct Facts {
    now: u64,
    equity: f64,
    positions: Vec<Held>,
    /// Orders that opened or added to a position, oldest first, as far back
    /// as the venue's fills go.
    entries: Vec<Entry>,
    /// Closed trades over the history window, oldest first.
    closed: Vec<Closed>,
}

impl Facts {
    fn from_venue(
        now: u64,
        account: &AccountSnapshot,
        fills: &[Fill],
        closed: &[ClosedTrade],
    ) -> Self {
        let positions = account
            .positions
            .iter()
            .map(|p| {
                let size = num(p.size).abs();
                Held {
                    market: p.market.clone(),
                    side: p.side,
                    size,
                    notional: size * num(p.mark_price),
                    entry: num(p.entry_price),
                    mark: num(p.mark_price),
                    stop: p.stop_loss.map(num),
                    unrealized: num(p.unrealized_pnl),
                }
            })
            .collect();
        // One entry per order that opened: its fills added up.
        let mut entries: Vec<(String, Entry)> = Vec::new();
        for fill in fills {
            let opens = matches!(
                fill.effect,
                FillEffect::OpenLong
                    | FillEffect::OpenShort
                    | FillEffect::LongToShort
                    | FillEffect::ShortToLong
            );
            if !opens {
                continue;
            }
            let notional = num(fill.price) * num(fill.size).abs();
            match entries.iter_mut().find(|(id, _)| *id == fill.order_id) {
                Some((_, entry)) => {
                    entry.notional += notional;
                    entry.at = entry.at.min(fill.time);
                }
                None => entries.push((
                    fill.order_id.clone(),
                    Entry {
                        market: fill.market.clone(),
                        at: fill.time,
                        notional,
                    },
                )),
            }
        }
        let mut entries: Vec<Entry> = entries.into_iter().map(|(_, e)| e).collect();
        entries.sort_by_key(|e| e.at);
        let mut closed: Vec<Closed> = closed
            .iter()
            .map(|c| Closed {
                market: c.market.clone(),
                at: c.time,
                opened_at: c.opened_at,
                side: c.side,
                pnl: num(c.closed_pnl),
                entry_value: num(c.entry_value).abs(),
            })
            .collect();
        closed.sort_by_key(|c| c.at);
        Self {
            now,
            equity: num(account.equity),
            positions,
            entries,
            closed,
        }
    }

    fn unrealized(&self) -> f64 {
        self.positions.iter().map(|p| p.unrealized).sum()
    }

    fn day_start(&self) -> u64 {
        self.now / DAY_MS * DAY_MS
    }

    fn entries_today(&self) -> impl Iterator<Item = &Entry> {
        let start = self.day_start();
        self.entries.iter().filter(move |e| e.at >= start)
    }

    fn closed_today(&self) -> impl Iterator<Item = &Closed> {
        let start = self.day_start();
        self.closed.iter().filter(move |c| c.at >= start)
    }

    /// The run of losing trades the account is on, and when the last closed.
    fn loss_streak(&self) -> (u64, Option<u64>) {
        let streak = self.closed.iter().rev().take_while(|c| c.pnl < 0.0).count() as u64;
        let last = self.closed.last().filter(|c| c.pnl < 0.0).map(|c| c.at);
        (streak, last)
    }

    /// The latest losing close on `market`, if no later close there won.
    fn last_loss_on(&self, market: &str) -> Option<u64> {
        self.closed
            .iter()
            .rev()
            .find(|c| c.market == market)
            .filter(|c| c.pnl < 0.0)
            .map(|c| c.at)
    }

    /// What a trade usually costs to open here: the mean over the history.
    fn usual_size(&self) -> Option<f64> {
        let sizes: Vec<f64> = self
            .closed
            .iter()
            .map(|c| c.entry_value)
            .filter(|v| *v > 0.0)
            .collect();
        (!sizes.is_empty()).then(|| sizes.iter().sum::<f64>() / sizes.len() as f64)
    }

    /// Trades opened by this time of day, on average over the days traded.
    fn usual_pace(&self) -> Option<f64> {
        let today = self.now / DAY_MS;
        let by_now = self.now % DAY_MS;
        let mut days = BTreeSet::new();
        let mut count = 0u64;
        for at in self.closed.iter().map(|c| c.opened_at.unwrap_or(c.at)) {
            if at / DAY_MS == today {
                continue;
            }
            days.insert(at / DAY_MS);
            if at % DAY_MS <= by_now {
                count += 1;
            }
        }
        (!days.is_empty()).then(|| count as f64 / days.len() as f64)
    }
}

/// Why opening orders are locked, and until when (unset: until started over).
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct Lock {
    pub reason: &'static str,
    pub until: Option<u64>,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DayTrade {
    pub at: u64,
    pub market: String,
    pub side: PositionSide,
    pub pnl: f64,
    pub tag: Option<&'static str>,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct RevengeSeen {
    pub market: String,
    pub minutes: u64,
    pub count: u64,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct Sizes {
    pub recent: Vec<f64>,
    pub usual: f64,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct Pace {
    pub today: u64,
    pub average: f64,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct Exposure {
    pub notional: f64,
    pub leverage: f64,
}

/// Where the account stands against the rules, for the page.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    pub equity: f64,
    pub started_at: u64,
    pub day_start: f64,
    pub peak: f64,
    pub day_pnl: f64,
    pub trades_today: u64,
    pub loss_streak: u64,
    pub cool_off_until: Option<u64>,
    pub cool_off_served: bool,
    /// What the newest position risks to its stop; unset where it has none.
    pub last_risk: Option<f64>,
    pub needs_stop: bool,
    pub position: Option<Exposure>,
    pub trading_days: u64,
    pub day: u64,
    pub curve: Vec<Point>,
    pub revenge: Option<RevengeSeen>,
    pub sizes: Option<Sizes>,
    pub pace: Option<Pace>,
    pub trades: Vec<DayTrade>,
    pub lock: Option<Lock>,
    /// Share of the daily loss limit used, for the warning at 80%.
    pub daily_used: f64,
    /// Whether that share has reached the warning (where the rules warn first).
    pub daily_warned: bool,
    pub hours_open: bool,
}

/// The floor the overall drawdown is measured from.
fn drawdown_from(rules: &Rules, progress: &Progress) -> f64 {
    match rules.challenge.max_kind {
        MaxKind::Static => rules.challenge.size,
        // A trailing floor stops rising once it reaches the starting balance.
        MaxKind::Intraday => progress.peak.min(rules.challenge.size + rules.max()),
        MaxKind::Eod => progress.eod_peak.min(rules.challenge.size + rules.max()),
    }
    .max(rules.challenge.size)
}

/// Brings `progress` up to `facts` (a new day, a new peak, a lock reached)
/// and says where the account stands.
fn observe(rules: &Rules, progress: &mut Progress, facts: &Facts) -> Status {
    let today = facts.now / DAY_MS;
    if progress.started_at == 0 {
        progress.started_at = facts.now;
    }
    let realized: f64 = facts.closed_today().map(|c| c.pnl).sum();
    if progress.day.as_ref().is_none_or(|d| d.index != today) {
        // The balance the day began with: what's here now, less what today made.
        let start_balance = facts.equity - facts.unrealized() - realized;
        // Yesterday's last equity, where the app saw it; the balance otherwise.
        let seen = progress
            .last
            .filter(|p| p.at / DAY_MS + 1 == today)
            .map(|p| p.equity);
        if let Some(last) = progress.last.filter(|p| p.at / DAY_MS < today) {
            progress.eod_peak = progress.eod_peak.max(last.equity);
            progress.curve.push(last);
            let extra = progress.curve.len().saturating_sub(CURVE_MAX);
            progress.curve.drain(..extra);
        }
        progress.day = Some(Day {
            index: today,
            start_balance,
            start_equity: seen.unwrap_or(start_balance),
        });
    }
    progress.peak = progress.peak.max(facts.equity).max(rules.challenge.size);
    progress.eod_peak = progress.eod_peak.max(rules.challenge.size);
    progress.last = Some(Point {
        at: facts.now,
        equity: facts.equity,
    });

    let day = progress.day.clone().unwrap_or(Day {
        index: today,
        start_balance: facts.equity,
        start_equity: facts.equity,
    });
    let day_start = match rules.challenge.daily_from {
        DailyFrom::Balance => day.start_balance,
        DailyFrom::Equity => day.start_equity,
    };
    let day_pnl = facts.equity - day_start;
    let daily_used = (-day_pnl).max(0.0) / rules.daily();
    let fall = (drawdown_from(rules, progress) - facts.equity).max(0.0);

    // A limit reached locks, and stays locked though the equity recovers.
    if rules.breach != Breach::Warn {
        if daily_used >= 1.0 {
            progress.day_locked = Some(today);
        }
        if fall >= rules.max() && progress.failed_at.is_none() {
            progress.failed_at = Some(facts.now);
        }
    }
    let lock = if progress.failed_at.is_some() {
        Some(Lock {
            reason: "maxDrawdown",
            until: None,
        })
    } else if progress.day_locked == Some(today) {
        Some(Lock {
            reason: "dailyLoss",
            until: Some((today + 1) * DAY_MS),
        })
    } else {
        None
    };

    let (loss_streak, last_loss) = facts.loss_streak();
    let pause = (rules.cool_off.minutes * MINUTE_MS as f64) as u64;
    let cool_off_until = last_loss
        .filter(|_| loss_streak as f64 >= rules.cool_off.losses)
        .map(|at| at + pause);
    let cooling = cool_off_until.is_some_and(|until| until > facts.now);

    // Entries made soon after a loss on the same market.
    let within = (rules.tilt.revenge.minutes * MINUTE_MS as f64) as u64;
    let loss_before = |market: &str, at: u64| {
        facts
            .closed
            .iter()
            .rev()
            .find(|c| c.market == market && c.at <= at)
            .filter(|c| c.pnl < 0.0 && at - c.at <= within)
            .map(|c| (at - c.at) / MINUTE_MS)
    };
    let revenges: Vec<(&Entry, u64)> = facts
        .entries_today()
        .filter_map(|e| loss_before(&e.market, e.at).map(|m| (e, m)))
        .collect();
    let revenge = revenges.last().map(|(entry, minutes)| RevengeSeen {
        market: entry.market.clone(),
        minutes: *minutes,
        count: revenges.len() as u64,
    });

    let recent: Vec<f64> = facts
        .entries
        .iter()
        .rev()
        .take(RECENT_SIZES)
        .rev()
        .map(|e| e.notional)
        .collect();
    let sizes = facts
        .usual_size()
        .filter(|_| !recent.is_empty())
        .map(|usual| Sizes { recent, usual });
    let trades_today = facts.entries_today().count() as u64;
    let pace = facts.usual_pace().map(|average| Pace {
        today: trades_today,
        average,
    });

    // The newest position's risk to its stop.
    let newest = facts
        .entries
        .iter()
        .rev()
        .find_map(|e| facts.positions.iter().find(|p| p.market == e.market))
        .or(facts.positions.first());
    let last_risk = newest.and_then(|p| p.stop.map(|stop| (p.entry - stop).abs() * p.size));
    let total: f64 = facts.positions.iter().map(|p| p.notional).sum();
    let position = facts
        .positions
        .iter()
        .map(|p| p.notional)
        .reduce(f64::max)
        .map(|notional| Exposure {
            notional,
            leverage: if facts.equity > 0.0 {
                total / facts.equity
            } else {
                0.0
            },
        });

    let mut trades: Vec<DayTrade> = facts
        .closed_today()
        .map(|c| {
            let at = c.opened_at.unwrap_or(c.at);
            DayTrade {
                at,
                market: c.market.clone(),
                side: c.side,
                pnl: c.pnl,
                tag: loss_before(&c.market, at).map(|_| "revenge"),
            }
        })
        .collect();
    trades.extend(facts.positions.iter().map(|p| {
        DayTrade {
            at: facts
                .entries
                .iter()
                .rev()
                .find(|e| e.market == p.market)
                .map_or(facts.now, |e| e.at),
            market: p.market.clone(),
            side: p.side,
            pnl: p.unrealized,
            tag: Some("open"),
        }
    }));
    trades.sort_by_key(|t| t.at);

    let traded: BTreeSet<u64> = facts
        .closed
        .iter()
        .filter(|c| c.at >= progress.started_at)
        .map(|c| c.at / DAY_MS)
        .collect();
    let mut curve = progress.curve.clone();
    curve.push(Point {
        at: facts.now,
        equity: facts.equity,
    });

    Status {
        equity: facts.equity,
        started_at: progress.started_at,
        day_start,
        peak: drawdown_from(rules, progress),
        day_pnl,
        trades_today,
        loss_streak,
        cool_off_until: cool_off_until.filter(|_| cooling),
        cool_off_served: cool_off_until
            .is_some_and(|until| until <= facts.now && until >= facts.day_start()),
        last_risk,
        needs_stop: newest.is_some_and(|p| p.stop.is_none()),
        position,
        trading_days: traded.len() as u64,
        day: (facts.now.saturating_sub(progress.started_at)) / DAY_MS + 1,
        curve,
        revenge: revenge.filter(|_| rules.tilt.revenge.on),
        sizes,
        pace,
        trades,
        lock,
        daily_used,
        daily_warned: rules.breach == Breach::WarnLock && daily_used >= WARN_AT,
        hours_open: rules.open_at(facts.now),
    }
}

/// One rule's answer for an order.
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct Check {
    /// Which rule: the page's name for it, and the code an order is refused with.
    pub rule: &'static str,
    pub ok: bool,
    /// What the order comes to against the rule, and the rule's limit.
    pub value: f64,
    pub limit: f64,
}

/// An order, as far as the rules look at it.
#[derive(Clone, Debug, PartialEq)]
struct Asked {
    market: String,
    side: Side,
    size: f64,
    /// The price it's expected to fill at.
    price: f64,
    stop: Option<f64>,
    reduce_only: bool,
}

/// Whether the order only takes risk off: it closes some or all of a
/// position and opens nothing. A flip counts as opening.
fn reduces(asked: &Asked, positions: &[Held]) -> bool {
    if asked.reduce_only {
        return true;
    }
    positions.iter().any(|p| {
        p.market == asked.market
            && asked.size <= p.size
            && matches!(
                (p.side, asked.side),
                (PositionSide::Long, Side::Sell) | (PositionSide::Short, Side::Buy)
            )
    })
}

/// Every rule's answer for an opening order. Empty for one that reduces.
fn check(rules: &Rules, status: &Status, facts: &Facts, asked: &Asked) -> Vec<Check> {
    if reduces(asked, &facts.positions) {
        return Vec::new();
    }
    let mut out = Vec::new();
    let mut push = |rule, ok, value, limit| {
        out.push(Check {
            rule,
            ok,
            value,
            limit,
        })
    };
    if let Some(lock) = &status.lock {
        let rule = if lock.reason == "dailyLoss" {
            "lockedDailyLoss"
        } else {
            "lockedMaxDrawdown"
        };
        push(rule, false, 0.0, 0.0);
    }
    push("hours", status.hours_open, 0.0, 0.0);
    push(
        "coolOff",
        status.cool_off_until.is_none(),
        status.loss_streak as f64,
        rules.cool_off.losses,
    );
    let revenge = &rules.tilt.revenge;
    if revenge.on && revenge.mode == RevengeMode::CoolOff {
        let within = (revenge.minutes * MINUTE_MS as f64) as u64;
        let soon = facts
            .last_loss_on(&asked.market)
            .is_some_and(|at| facts.now.saturating_sub(at) < within);
        push("revenge", !soon, 0.0, revenge.minutes);
    }
    push(
        "tradesPerDay",
        (status.trades_today as f64) < rules.trades_per_day,
        status.trades_today as f64,
        rules.trades_per_day,
    );
    // The position this market would hold, and the account's exposure, once filled.
    let adding = asked.size * asked.price;
    let held = facts
        .positions
        .iter()
        .find(|p| p.market == asked.market)
        .map_or(0.0, |p| {
            let same = matches!(
                (p.side, asked.side),
                (PositionSide::Long, Side::Buy) | (PositionSide::Short, Side::Sell)
            );
            if same {
                p.notional
            } else {
                -p.notional
            }
        });
    let after = (held + adding).abs();
    push(
        "positionSize",
        after <= rules.position.usd,
        after,
        rules.position.usd,
    );
    let total: f64 = facts.positions.iter().map(|p| p.notional).sum::<f64>() - held.abs() + after;
    let leverage = if facts.equity > 0.0 {
        total / facts.equity
    } else {
        f64::INFINITY
    };
    push(
        "leverage",
        leverage <= rules.position.leverage,
        leverage,
        rules.position.leverage,
    );
    // What it risks to its stop, against the trade's limit and what the day has left.
    let left = (rules.daily() * (1.0 - status.daily_used)).max(0.0);
    match asked.stop {
        Some(stop) => {
            let risk = (asked.price - stop).abs() * asked.size;
            push(
                "tradeRisk",
                risk <= rules.trade_risk(),
                risk,
                rules.trade_risk(),
            );
            push("dailyLeft", risk <= left, risk, left);
        }
        None => push(
            "needsStop",
            rules.trade_loss.mode == StopMode::Warn,
            0.0,
            rules.trade_risk(),
        ),
    }
    out
}

/// An account's fills and today's closed trades, and when they were read.
type Recent = (Instant, Vec<Fill>, Vec<ClosedTrade>);
/// An account's closed trades over the history window, and when they were read.
type History = (Instant, Vec<ClosedTrade>);

/// Every account's rules, their progress, and what's been read from the
/// venues lately.
pub struct TradingRules {
    saved: Mutex<Saved>,
    /// Where they're kept between runs; unset when there's nowhere to.
    path: Option<PathBuf>,
    recent: Mutex<HashMap<Account, Recent>>,
    history: Mutex<HashMap<Account, History>>,
}

/// One account's rules as the page shows them.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct View {
    name: String,
    on: bool,
    account: Account,
    rules: Rules,
    /// A change that's waiting, and when it applies.
    pending: Option<PendingView>,
}

#[derive(Clone, Debug, Serialize)]
pub struct PendingView {
    on: bool,
    rules: Rules,
    at: u64,
}

/// A set's name as it's kept: trimmed, printable, not long.
fn tidy_name(name: &str) -> String {
    name.trim()
        .chars()
        .filter(|c| !c.is_control())
        .take(NAME_MAX)
        .collect()
}

impl TradingRules {
    /// The rules kept at `path`. A missing or unreadable file is no rules.
    pub fn load(path: Option<PathBuf>) -> Self {
        let mut saved = path
            .as_ref()
            .and_then(|p| std::fs::read(p).ok())
            .map(|bytes| Saved::read(&bytes))
            .unwrap_or_default();
        // Rules that don't read as rules are no rules, not half-checked ones.
        saved.sets.retain(|set| {
            set.rules.valid().is_ok()
                && set.pending.as_ref().is_none_or(|p| p.rules.valid().is_ok())
        });
        saved.sets.truncate(MAX_SETS);
        Self {
            saved: Mutex::new(saved),
            path,
            recent: Mutex::new(HashMap::new()),
            history: Mutex::new(HashMap::new()),
        }
    }

    fn write(&self, saved: &Saved) -> bool {
        self.path.as_ref().is_some_and(|path| {
            path.parent()
                .is_none_or(|dir| std::fs::create_dir_all(dir).is_ok())
                && serde_json::to_vec(saved).is_ok_and(|json| std::fs::write(path, json).is_ok())
        })
    }

    /// Applies each waiting change whose time has come.
    fn settle(saved: &mut Saved, now: u64) {
        for set in &mut saved.sets {
            let Some(pending) = set.pending.take_if(|p| p.at <= now) else {
                continue;
            };
            if pending.rules.restarts(&set.rules) || !pending.on {
                set.progress = Progress::default();
            }
            set.on = pending.on;
            set.rules = pending.rules;
        }
    }

    fn views(&self) -> Vec<View> {
        let mut saved = self.saved.lock().unwrap();
        Self::settle(&mut saved, now_ms());
        saved
            .sets
            .iter()
            .map(|set| View {
                name: set.name.clone(),
                on: set.on,
                account: set.account.clone(),
                rules: set.rules.clone(),
                pending: set.pending.as_ref().map(|p| PendingView {
                    on: p.on,
                    rules: p.rules.clone(),
                    at: p.at,
                }),
            })
            .collect()
    }

    /// Keeps a change, or puts everything back if it can't be written.
    fn change(
        &self,
        edit: impl FnOnce(&mut Saved) -> Result<(), VenueError>,
    ) -> Result<(), VenueError> {
        let mut saved = self.saved.lock().unwrap();
        Self::settle(&mut saved, now_ms());
        let before = saved.clone();
        if let Err(why) = edit(&mut saved) {
            *saved = before;
            return Err(why);
        }
        if !self.write(&saved) {
            *saved = before;
            return Err(VenueError::Network(
                "the rules couldn't be saved; nothing was changed".into(),
            ));
        }
        Ok(())
    }

    /// Takes `account`'s rules. New ones, and ones no looser than those in
    /// force, apply now; a loosening or turning them off waits for 00:00 UTC.
    fn set(
        &self,
        account: Account,
        name: &str,
        on: bool,
        rules: Rules,
    ) -> Result<Vec<View>, VenueError> {
        rules
            .valid()
            .map_err(|why| VenueError::InvalidRequest(why.into()))?;
        let now = now_ms();
        let name = tidy_name(name);
        self.change(|saved| {
            let Some(set) = saved.set_for(&account) else {
                if saved.sets.len() >= MAX_SETS {
                    return Err(VenueError::InvalidRequest(
                        "that's as many sets of rules as are kept".into(),
                    ));
                }
                saved.sets.push(Set {
                    name,
                    on,
                    account,
                    rules,
                    pending: None,
                    progress: Progress::default(),
                });
                return Ok(());
            };
            // A name is only a name: it never waits.
            set.name = name;
            if set.on && (!on || rules.looser_than(&set.rules)) {
                set.pending = Some(Pending {
                    on,
                    rules,
                    at: (now / DAY_MS + 1) * DAY_MS,
                });
            } else {
                if (!set.on && on) || rules.restarts(&set.rules) {
                    set.progress = Progress::default();
                }
                set.on = on;
                set.rules = rules;
                set.pending = None;
            }
            Ok(())
        })?;
        Ok(self.views())
    }

    /// Forgets `account`'s rules, on or off, at once: the trader's decision,
    /// confirmed on the page. From then its orders are checked against nothing.
    fn remove(&self, account: &Account) -> Result<Vec<View>, VenueError> {
        self.change(|saved| {
            saved.sets.retain(|set| set.account != *account);
            Ok(())
        })?;
        Ok(self.views())
    }

    /// The rules in force for `account`, if any are.
    fn in_force(&self, venue: VenueId, account: &str) -> Option<Rules> {
        let mut saved = self.saved.lock().unwrap();
        Self::settle(&mut saved, now_ms());
        saved
            .sets
            .iter()
            .find(|set| set.on && set.account.venue == venue && set.account.id == account)
            .map(|set| set.rules.clone())
    }

    /// Reads what the rules need from the venue: the account now, and its
    /// fills and closed trades (reused for a few seconds between checks).
    async fn facts(
        &self,
        venues: &Venues,
        venue: VenueId,
        account: &str,
    ) -> Result<Facts, VenueError> {
        let adapter = venues.adapter(venue)?;
        let who = Account {
            venue,
            id: account.to_owned(),
        };
        let now = now_ms();
        let snapshot = adapter.account(account).await?;
        let cached = self
            .recent
            .lock()
            .unwrap()
            .get(&who)
            .filter(|(at, ..)| at.elapsed() < RECENT_FOR)
            .map(|(_, fills, closed)| (fills.clone(), closed.clone()));
        let (fills, today) = match cached {
            Some(kept) => kept,
            None => {
                let fills = adapter.fills(account).await?;
                let today = adapter
                    .closed_trades_since(account, now / DAY_MS * DAY_MS)
                    .await?;
                self.recent
                    .lock()
                    .unwrap()
                    .insert(who.clone(), (Instant::now(), fills.clone(), today.clone()));
                (fills, today)
            }
        };
        let cached = self
            .history
            .lock()
            .unwrap()
            .get(&who)
            .filter(|(at, _)| at.elapsed() < HISTORY_FOR)
            .map(|(_, closed)| closed.clone());
        let history = match cached {
            Some(kept) => kept,
            // The history only feeds the usual size and pace: without it the
            // limits are still checked.
            None => match adapter
                .closed_trades_since(account, now.saturating_sub(HISTORY_DAYS * DAY_MS))
                .await
            {
                Ok(closed) => {
                    self.history
                        .lock()
                        .unwrap()
                        .insert(who, (Instant::now(), closed.clone()));
                    closed
                }
                Err(_) => Vec::new(),
            },
        };
        // Today's, read fresh, over the history's older days.
        let start = now / DAY_MS * DAY_MS;
        let mut closed: Vec<ClosedTrade> = history.into_iter().filter(|c| c.time < start).collect();
        closed.extend(today);
        Ok(Facts::from_venue(now, &snapshot, &fills, &closed))
    }

    /// Where `facts` leave `account`, with its progress brought up to date and kept.
    fn stand(&self, venue: VenueId, account: &str, rules: &Rules, facts: &Facts) -> Status {
        let mut saved = self.saved.lock().unwrap();
        let who = Account {
            venue,
            id: account.to_owned(),
        };
        let Some(set) = saved.set_for(&who) else {
            // Removed since it was read: where the account stands, kept nowhere.
            return observe(rules, &mut Progress::default(), facts);
        };
        let before = set.progress.clone();
        let status = observe(rules, &mut set.progress, facts);
        if set.progress != before {
            // Best effort: what's in memory is what's checked against.
            let _ = self.write(&saved);
        }
        status
    }

    /// Refuses an order the rules don't allow. One that reduces a position
    /// always passes; an opening one is refused if it can't be checked.
    pub async fn guard_order(
        &self,
        venues: &Venues,
        venue: VenueId,
        account: &str,
        request: &OrderRequest,
    ) -> Result<(), VenueError> {
        let Some(rules) = self.in_force(venue, account) else {
            return Ok(());
        };
        if request.reduce_only {
            return Ok(());
        }
        let checks = self
            .order_checks(venues, venue, account, &rules, request)
            .await?;
        if rules.breach == Breach::Warn {
            return Ok(());
        }
        match checks.iter().find(|c| !c.ok) {
            Some(failed) => Err(VenueError::Blocked(failed.rule.into())),
            None => Ok(()),
        }
    }

    async fn order_checks(
        &self,
        venues: &Venues,
        venue: VenueId,
        account: &str,
        rules: &Rules,
        request: &OrderRequest,
    ) -> Result<Vec<Check>, VenueError> {
        let unread = |_| VenueError::Blocked("unchecked".into());
        let facts = self.facts(venues, venue, account).await.map_err(unread)?;
        let price = match &request.kind {
            OrderKind::Limit { price, .. } => num(*price),
            OrderKind::Trigger {
                trigger_price,
                limit_price,
            } => num(limit_price.unwrap_or(*trigger_price)),
            OrderKind::Market { .. } => {
                match facts.positions.iter().find(|p| p.market == request.market) {
                    Some(held) => held.mark,
                    None => {
                        let book = venues
                            .adapter(venue)?
                            .order_book(&request.market)
                            .await
                            .map_err(unread)?;
                        let level = match request.side {
                            Side::Buy => book.asks.first(),
                            Side::Sell => book.bids.first(),
                        };
                        level
                            .map(|l| num(l.price))
                            .ok_or_else(|| VenueError::Blocked("unchecked".into()))?
                    }
                }
            }
        };
        let asked = Asked {
            market: request.market.clone(),
            side: request.side,
            size: num(request.size).abs(),
            price,
            stop: request.stop_loss.map(num),
            reduce_only: request.reduce_only,
        };
        let status = self.stand(venue, account, rules, &facts);
        Ok(check(rules, &status, &facts, &asked))
    }

    /// While opening orders are locked: refuses making an open order larger.
    pub async fn guard_amend(
        &self,
        venues: &Venues,
        venue: VenueId,
        account: &str,
        order_id: &str,
        amend: &OrderAmend,
    ) -> Result<(), VenueError> {
        let (Some(rules), Some(size)) = (self.in_force(venue, account), amend.size) else {
            return Ok(());
        };
        if rules.breach == Breach::Warn {
            return Ok(());
        }
        let unread = |_| VenueError::Blocked("unchecked".into());
        let snapshot = venues
            .adapter(venue)?
            .account(account)
            .await
            .map_err(unread)?;
        let Some(order) = snapshot.open_orders.iter().find(|o| o.id == order_id) else {
            return Ok(());
        };
        if order.reduce_only || num(size) <= num(order.size) {
            return Ok(());
        }
        let facts = self.facts(venues, venue, account).await.map_err(unread)?;
        match self.stand(venue, account, &rules, &facts).lock {
            Some(_) => Err(VenueError::Blocked("lockedAmend".into())),
            None => Ok(()),
        }
    }

    /// While opening orders are locked: refuses taking a stop off or moving
    /// it further away. Setting one, moving it closer, and take-profits pass.
    pub async fn guard_protection(
        &self,
        venues: &Venues,
        venue: VenueId,
        account: &str,
        market: &str,
        protection: &PositionProtection,
    ) -> Result<(), VenueError> {
        let Some(rules) = self.in_force(venue, account) else {
            return Ok(());
        };
        if rules.breach == Breach::Warn || protection.stop_loss == ExitChange::Keep {
            return Ok(());
        }
        let unread = |_| VenueError::Blocked("unchecked".into());
        let facts = self.facts(venues, venue, account).await.map_err(unread)?;
        if self.stand(venue, account, &rules, &facts).lock.is_none() {
            return Ok(());
        }
        let Some(held) = facts.positions.iter().find(|p| p.market == market) else {
            return Ok(());
        };
        let further = match (protection.stop_loss, held.stop) {
            (ExitChange::Remove, Some(_)) => true,
            (ExitChange::Set(to), Some(now)) => match held.side {
                PositionSide::Long => num(to) < now,
                PositionSide::Short => num(to) > now,
            },
            _ => false,
        };
        if further {
            Err(VenueError::Blocked("lockedStop".into()))
        } else {
            Ok(())
        }
    }
}

/// Every account's rules: whether they're on, and any change that's waiting.
#[tauri::command]
pub fn trading_rules(rules: State<'_, TradingRules>) -> Vec<View> {
    rules.views()
}

/// An account as a command names it, checked.
fn named(venue: VenueId, account: String) -> Result<Account, VenueError> {
    if account.trim().is_empty() || account.len() > 128 {
        return Err(VenueError::InvalidRequest("not an account".into()));
    }
    Ok(Account { venue, id: account })
}

/// Saves `account`'s rules, under a name of the trader's. Tightening
/// applies now; a loosening, or turning them off, at the next 00:00 UTC.
#[tauri::command]
pub fn set_trading_rules(
    state: State<'_, TradingRules>,
    venue: VenueId,
    account: String,
    name: String,
    on: bool,
    rules: Rules,
) -> Result<Vec<View>, VenueError> {
    state.set(named(venue, account)?, &name, on, rules)
}

/// Forgets `account`'s rules at once, whether they're on or off.
#[tauri::command]
pub fn delete_trading_rules(
    state: State<'_, TradingRules>,
    venue: VenueId,
    account: String,
) -> Result<Vec<View>, VenueError> {
    state.remove(&named(venue, account)?)
}

/// Where `account` stands against the rules; nothing while they're off or
/// are another account's. Read-only on the venue.
#[tauri::command]
pub async fn trading_rules_status(
    state: State<'_, TradingRules>,
    venues: State<'_, Venues>,
    venue: VenueId,
    account: String,
) -> Result<Option<Status>, VenueError> {
    let Some(rules) = state.in_force(venue, &account) else {
        return Ok(None);
    };
    let facts = state.facts(&venues, venue, &account).await?;
    Ok(Some(state.stand(venue, &account, &rules, &facts)))
}

/// What each rule says about an order before it's sent, for the ticket.
/// Empty while the rules are off, and for an order that only reduces.
#[tauri::command]
pub async fn check_trading_rules(
    state: State<'_, TradingRules>,
    venues: State<'_, Venues>,
    venue: VenueId,
    account: String,
    request: OrderRequest,
) -> Result<Vec<Check>, VenueError> {
    let Some(rules) = state.in_force(venue, &account) else {
        return Ok(Vec::new());
    };
    if request.reduce_only {
        return Ok(Vec::new());
    }
    state
        .order_checks(&venues, venue, &account, &rules, &request)
        .await
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 2026-10-07 (a Wednesday) 12:04 UTC.
    const NOON: u64 = 1_791_374_640_000;

    fn facts(equity: f64) -> Facts {
        Facts {
            now: NOON,
            equity,
            ..Facts::default()
        }
    }

    fn closed(market: &str, ago_min: u64, pnl: f64) -> Closed {
        Closed {
            market: market.into(),
            at: NOON - ago_min * MINUTE_MS,
            opened_at: Some(NOON - (ago_min + 20) * MINUTE_MS),
            side: PositionSide::Long,
            pnl,
            entry_value: 2_000.0,
        }
    }

    fn buy(market: &str, size: f64, price: f64, stop: Option<f64>) -> Asked {
        Asked {
            market: market.into(),
            side: Side::Buy,
            size,
            price,
            stop,
            reduce_only: false,
        }
    }

    fn failed(checks: &[Check]) -> Vec<&'static str> {
        checks.iter().filter(|c| !c.ok).map(|c| c.rule).collect()
    }

    #[test]
    fn the_clock_is_a_wednesday_noon() {
        assert_eq!(NOON / DAY_MS % 7, 6, "days since a Thursday");
        assert_eq!(NOON % DAY_MS, (12 * 60 + 4) * MINUTE_MS);
    }

    #[test]
    fn rules_out_of_range_are_refused() {
        assert!(Rules::default().valid().is_ok());
        let mut rules = Rules::default();
        rules.challenge.daily_pct = f64::NAN;
        assert!(rules.valid().is_err());
        let mut rules = Rules::default();
        rules.hours.from = "25:00".into();
        assert!(rules.valid().is_err());
        let mut rules = Rules::default();
        rules.position.leverage = -1.0;
        assert!(rules.valid().is_err());
    }

    #[test]
    fn tells_a_loosening_from_a_tightening() {
        let old = Rules::default();
        let change = |edit: fn(&mut Rules)| {
            let mut rules = Rules::default();
            edit(&mut rules);
            rules.looser_than(&old)
        };
        assert!(!old.looser_than(&old));
        // Tighter, or not a limit: at once.
        assert!(!change(|r| r.challenge.daily_pct = 3.0));
        assert!(!change(|r| r.trades_per_day = 4.0));
        assert!(!change(|r| r.hours.to = "18:00".into()));
        assert!(!change(|r| r.cool_off.minutes = 60.0));
        assert!(!change(|r| r.breach = Breach::Lock));
        assert!(!change(|r| r.challenge.target_pct = 12.0));
        // Looser: tomorrow.
        assert!(change(|r| r.challenge.daily_pct = 6.0));
        assert!(change(|r| r.challenge.max_pct = 12.0));
        assert!(change(|r| r.trade_loss.mode = StopMode::Warn));
        assert!(change(|r| r.position.usd = 30_000.0));
        assert!(change(|r| r.hours.to = "21:00".into()));
        assert!(change(|r| r.hours.days = HourDays::EveryDay));
        assert!(change(|r| r.cool_off.losses = 4.0));
        assert!(change(|r| r.breach = Breach::Warn));
        assert!(change(|r| r.tilt.revenge.on = false));
        // Another preset or size starts over, which waits too.
        assert!(change(|r| r.preset = Preset::Classic));
        assert!(change(|r| r.challenge.size = 20_000.0));
    }

    #[test]
    fn trading_hours_follow_the_utc_clock() {
        let rules = Rules::default();
        assert!(rules.open_at(NOON));
        assert!(!rules.open_at(NOON + 9 * 60 * MINUTE_MS), "21:04");
        assert!(!rules.open_at(NOON + 3 * DAY_MS), "Saturday");
        let mut night = Rules::default();
        night.hours.from = "22:00".into();
        night.hours.to = "06:00".into();
        // Friday's window runs into Saturday morning, and ends there.
        let saturday_3am = NOON + 3 * DAY_MS - (9 * 60 + 4) * MINUTE_MS;
        assert!(night.open_at(saturday_3am));
        assert!(
            !night.open_at(saturday_3am + 20 * 60 * MINUTE_MS),
            "Saturday 23:00"
        );
    }

    #[test]
    fn a_reduction_is_never_checked() {
        let held = Held {
            market: "ETH".into(),
            side: PositionSide::Long,
            size: 2.0,
            notional: 5_000.0,
            entry: 2_500.0,
            mark: 2_500.0,
            stop: None,
            unrealized: 0.0,
        };
        let sell = |size: f64| Asked {
            side: Side::Sell,
            ..buy("ETH", size, 2_500.0, None)
        };
        assert!(reduces(&sell(2.0), std::slice::from_ref(&held)));
        assert!(reduces(&sell(0.5), std::slice::from_ref(&held)));
        // More than the position is a flip, and adding is opening.
        assert!(!reduces(&sell(2.5), std::slice::from_ref(&held)));
        assert!(!reduces(
            &buy("ETH", 1.0, 2_500.0, None),
            std::slice::from_ref(&held)
        ));
        assert!(!reduces(&sell(1.0), &[]));
        assert!(reduces(
            &Asked {
                reduce_only: true,
                ..sell(9.0)
            },
            &[]
        ));

        // Locked or not, it passes: no rule is asked.
        let rules = Rules::default();
        let mut progress = Progress::default();
        let mut now = facts(9_000.0);
        now.positions = vec![held];
        let status = observe(&rules, &mut progress, &now);
        assert!(check(&rules, &status, &now, &sell(2.0)).is_empty());
    }

    #[test]
    fn the_daily_limit_locks_until_midnight_and_stays_locked() {
        let rules = Rules::default();
        let mut progress = Progress::default();
        // The day began at 10,000: all of today's change is unrealized... none yet.
        let status = observe(&rules, &mut progress, &facts(10_000.0));
        assert_eq!(status.day_start, 10_000.0);
        assert!(status.lock.is_none());
        // 4% down of the 5% allowed: warned, not locked.
        let status = observe(&rules, &mut progress, &facts(9_600.0));
        assert!((status.daily_used - 0.8).abs() < 1e-9);
        assert!(status.daily_used >= WARN_AT && status.lock.is_none());
        // The limit reached: locked until the next 00:00 UTC.
        let status = observe(&rules, &mut progress, &facts(9_500.0));
        let lock = status.lock.expect("locked");
        assert_eq!(lock.reason, "dailyLoss");
        assert_eq!(lock.until, Some((NOON / DAY_MS + 1) * DAY_MS));
        // Recovering doesn't unlock it.
        let now = facts(9_900.0);
        let status = observe(&rules, &mut progress, &now);
        assert!(status.lock.is_some());
        let checks = check(
            &rules,
            &status,
            &now,
            &buy("BTC", 0.01, 100_000.0, Some(99_000.0)),
        );
        assert_eq!(failed(&checks), ["lockedDailyLoss"]);
        // The next day does, from the equity yesterday ended on.
        let mut tomorrow = facts(9_900.0);
        tomorrow.now = NOON + DAY_MS;
        let status = observe(&rules, &mut progress, &tomorrow);
        assert!(status.lock.is_none());
        assert_eq!(status.day_start, 9_900.0);
        assert_eq!(progress.curve.len(), 1);
    }

    #[test]
    fn warn_only_never_locks() {
        let rules = Rules {
            breach: Breach::Warn,
            ..Rules::default()
        };
        let mut progress = Progress::default();
        observe(&rules, &mut progress, &facts(10_000.0));
        let status = observe(&rules, &mut progress, &facts(8_000.0));
        assert!(status.lock.is_none());
        assert!(status.daily_used > 1.0);
    }

    #[test]
    fn the_overall_drawdown_locks_until_started_over() {
        let mut rules = Rules::default();
        rules.challenge.max_kind = MaxKind::Intraday;
        rules.challenge.daily_pct = 50.0;
        let mut progress = Progress::default();
        observe(&rules, &mut progress, &facts(10_000.0));
        // A new high lifts the floor with it: 10,600 less 1,000.
        let status = observe(&rules, &mut progress, &facts(10_600.0));
        assert_eq!(status.peak, 10_600.0);
        assert!(observe(&rules, &mut progress, &facts(9_700.0))
            .lock
            .is_none());
        let status = observe(&rules, &mut progress, &facts(9_600.0));
        assert_eq!(
            status.lock.map(|l| (l.reason, l.until)),
            Some(("maxDrawdown", None))
        );
        // Not lifted by the next day.
        let mut tomorrow = facts(9_900.0);
        tomorrow.now = NOON + DAY_MS;
        assert!(observe(&rules, &mut progress, &tomorrow).lock.is_some());
        // A static floor stays under the starting balance.
        let mut fixed = Progress::default();
        let rules = Rules {
            challenge: Challenge {
                daily_pct: 50.0,
                ..Rules::default().challenge
            },
            ..Rules::default()
        };
        observe(&rules, &mut fixed, &facts(10_600.0));
        assert!(observe(&rules, &mut fixed, &facts(9_100.0)).lock.is_none());
        assert!(observe(&rules, &mut fixed, &facts(9_000.0)).lock.is_some());
    }

    #[test]
    fn checks_an_opening_order_against_each_limit() {
        let rules = Rules::default();
        let mut progress = Progress::default();
        let now = facts(10_000.0);
        let status = observe(&rules, &mut progress, &now);
        let ask = |asked: &Asked| failed(&check(&rules, &status, &now, asked));
        // 0.02 BTC at 100,000 with a stop 2% away risks 40: fine.
        assert!(ask(&buy("BTC", 0.02, 100_000.0, Some(98_000.0))).is_empty());
        // No stop, where one is required.
        assert_eq!(ask(&buy("BTC", 0.02, 100_000.0, None)), ["needsStop"]);
        // 0.1 BTC with that stop risks 200, over the 100 a trade may.
        assert_eq!(
            ask(&buy("BTC", 0.1, 100_000.0, Some(98_000.0))),
            ["tradeRisk"]
        );
        // 0.3 BTC is 30,000: over the position limit (3x, inside the leverage one).
        assert_eq!(
            ask(&buy("BTC", 0.3, 100_000.0, Some(99_900.0))),
            ["positionSize"]
        );
        // Small positions can still add up to too much exposure.
        let mut loaded = facts(2_000.0);
        loaded.positions = vec![Held {
            market: "ETH".into(),
            side: PositionSide::Long,
            size: 8.0,
            notional: 20_000.0,
            entry: 2_500.0,
            mark: 2_500.0,
            stop: Some(2_490.0),
            unrealized: 0.0,
        }];
        let mut fresh = Progress::default();
        let mut rules = Rules::default();
        rules.challenge.size = 2_000.0;
        let status = observe(&rules, &mut fresh, &loaded);
        let over = check(
            &rules,
            &status,
            &loaded,
            &buy("BTC", 0.01, 100_000.0, Some(99_900.0)),
        );
        assert_eq!(failed(&over), ["leverage"]);
    }

    #[test]
    fn what_the_day_has_left_bounds_a_trades_risk() {
        let rules = Rules::default();
        let mut progress = Progress::default();
        observe(&rules, &mut progress, &facts(10_000.0));
        // 430 of the 500 gone: 70 left, and this order risks 80.
        let now = facts(9_570.0);
        let status = observe(&rules, &mut progress, &now);
        let checks = check(
            &rules,
            &status,
            &now,
            &buy("BTC", 0.04, 100_000.0, Some(98_000.0)),
        );
        assert_eq!(failed(&checks), ["dailyLeft"]);
        let left = checks.iter().find(|c| c.rule == "dailyLeft").unwrap();
        assert!((left.value - 80.0).abs() < 1e-6 && (left.limit - 70.0).abs() < 1e-6);
    }

    #[test]
    fn a_run_of_losses_starts_a_cool_off() {
        let rules = Rules::default();
        let mut progress = Progress::default();
        let mut now = facts(10_000.0);
        now.closed = vec![
            closed("BTC", 300, 50.0),
            closed("SOL", 90, -20.0),
            closed("BTC", 60, -30.0),
            closed("SOL", 10, -10.0),
        ];
        let status = observe(&rules, &mut progress, &now);
        assert_eq!(status.loss_streak, 3);
        assert_eq!(status.cool_off_until, Some(NOON + 20 * MINUTE_MS));
        let order = buy("DOGE", 100.0, 0.2, Some(0.19));
        assert_eq!(failed(&check(&rules, &status, &now, &order)), ["coolOff"]);
        // Half an hour after the last loss it's served.
        now.now = NOON + 21 * MINUTE_MS;
        let status = observe(&rules, &mut progress, &now);
        assert!(status.cool_off_until.is_none() && status.cool_off_served);
        assert!(failed(&check(&rules, &status, &now, &order)).is_empty());
        // A win ends the run.
        now.closed.push(Closed {
            at: now.now,
            ..closed("ETH", 0, 5.0)
        });
        assert_eq!(observe(&rules, &mut progress, &now).loss_streak, 0);
    }

    #[test]
    fn a_reentry_after_a_loss_waits_out_the_same_market() {
        let rules = Rules::default();
        let mut progress = Progress::default();
        let mut now = facts(10_000.0);
        now.closed = vec![closed("ETH", 2, -40.0)];
        let status = observe(&rules, &mut progress, &now);
        let eth = buy("ETH", 0.1, 2_500.0, Some(2_480.0));
        assert_eq!(failed(&check(&rules, &status, &now, &eth)), ["revenge"]);
        // Another market is fine, and so is ETH once ten minutes have gone.
        let btc = buy("BTC", 0.01, 100_000.0, Some(99_500.0));
        assert!(failed(&check(&rules, &status, &now, &btc)).is_empty());
        now.now = NOON + 9 * MINUTE_MS;
        let status = observe(&rules, &mut progress, &now);
        assert!(failed(&check(&rules, &status, &now, &eth)).is_empty());
        // Set to warn only, it's shown but doesn't refuse.
        let mut warn = Rules::default();
        warn.tilt.revenge.mode = RevengeMode::Warn;
        now.now = NOON;
        let status = observe(&warn, &mut progress, &now);
        assert!(failed(&check(&warn, &status, &now, &eth)).is_empty());
    }

    #[test]
    fn counts_the_days_trades_and_spots_tilt() {
        let rules = Rules::default();
        let mut progress = Progress::default();
        let mut now = facts(10_000.0);
        let entry = |market: &str, ago_min: u64, notional: f64| Entry {
            market: market.into(),
            at: NOON - ago_min * MINUTE_MS,
            notional,
        };
        // Yesterday: three trades by this time of day, of 2,000 each.
        now.closed = (0..3)
            .map(|i| Closed {
                at: NOON - DAY_MS - i * 60 * MINUTE_MS,
                opened_at: Some(NOON - DAY_MS - (i + 1) * 60 * MINUTE_MS),
                ..closed("BTC", 0, 10.0)
            })
            .collect();
        now.closed.push(closed("ETH", 30, -50.0));
        now.entries = vec![
            entry("BTC", 26 * 60, 2_000.0),
            entry("ETH", 50, 2_000.0),
            // Back into ETH two minutes after the loss, at twice the size.
            entry("ETH", 28, 4_000.0),
        ];
        let status = observe(&rules, &mut progress, &now);
        assert_eq!(status.trades_today, 2);
        let revenge = status.revenge.expect("a revenge trade");
        assert_eq!(
            (revenge.market.as_str(), revenge.minutes, revenge.count),
            ("ETH", 2, 1)
        );
        let sizes = status.sizes.expect("sizes");
        assert_eq!(sizes.recent, [2_000.0, 2_000.0, 4_000.0]);
        assert_eq!(sizes.usual, 2_000.0);
        assert_eq!(
            status.pace,
            Some(Pace {
                today: 2,
                average: 3.0
            })
        );
        // The eighth trade of the day is the last.
        now.entries = (0..8).map(|i| entry("SOL", i * 31 + 31, 500.0)).collect();
        now.closed.clear();
        let status = observe(&rules, &mut progress, &now);
        let order = buy("BTC", 0.01, 100_000.0, Some(99_500.0));
        assert_eq!(
            failed(&check(&rules, &status, &now, &order)),
            ["tradesPerDay"]
        );
    }

    #[test]
    fn a_loosening_waits_for_midnight_and_a_tightening_does_not() {
        let state = TradingRules::load(Some(
            std::env::temp_dir().join(format!("pd-rules-test-{}.json", now_ms())),
        ));
        let me = Account {
            venue: VenueId::Bybit,
            id: "demo:1".into(),
        };
        let mine = |views: Vec<View>| {
            views
                .into_iter()
                .find(|v| v.account.id == "demo:1")
                .unwrap()
        };
        // Turning them on is at once.
        let view = mine(
            state
                .set(me.clone(), "  Firm 100k ", true, Rules::default())
                .unwrap(),
        );
        assert!(view.on && view.pending.is_none());
        assert_eq!(view.name, "Firm 100k");
        // Tighter: at once.
        let mut tight = Rules::default();
        tight.challenge.daily_pct = 3.0;
        let view = mine(
            state
                .set(me.clone(), "Firm 100k", true, tight.clone())
                .unwrap(),
        );
        assert_eq!(view.rules.challenge.daily_pct, 3.0);
        assert!(view.pending.is_none());
        // Looser: kept for tomorrow, the tight ones still in force. A new name doesn't wait.
        let view = mine(
            state
                .set(me.clone(), "Firm", true, Rules::default())
                .unwrap(),
        );
        assert_eq!(
            (view.rules.challenge.daily_pct, view.name.as_str()),
            (3.0, "Firm")
        );
        let pending = view.pending.expect("waiting");
        assert_eq!(pending.at % DAY_MS, 0);
        assert!(pending.at > now_ms());
        // So is turning them off.
        assert!(mine(state.set(me.clone(), "Firm", false, tight.clone()).unwrap()).on);
        // Once its time comes, the waiting change is the rules.
        {
            let mut saved = state.saved.lock().unwrap();
            saved.sets[0].pending.as_mut().unwrap().at = 1;
        }
        assert!(state.in_force(VenueId::Bybit, "demo:1").is_none());
        // Off, they can go at once.
        assert!(state.remove(&me).unwrap().is_empty());
        // Rules that are on go at once too, and a change that was waiting with them.
        state.set(me.clone(), "Firm", true, tight.clone()).unwrap();
        state
            .set(me.clone(), "Firm", true, Rules::default())
            .unwrap();
        assert!(state.in_force(VenueId::Bybit, "demo:1").is_some());
        assert!(state.remove(&me).unwrap().is_empty());
        assert!(state.in_force(VenueId::Bybit, "demo:1").is_none());
        if let Some(path) = &state.path {
            let _ = std::fs::remove_file(path);
        }
    }

    #[test]
    fn each_account_has_its_own_rules() {
        let state = TradingRules::load(Some(
            std::env::temp_dir().join(format!("pd-rules-sets-{}.json", now_ms())),
        ));
        let on = |venue, id: &str| Account {
            venue,
            id: id.into(),
        };
        let strict = Rules {
            trades_per_day: 2.0,
            ..Rules::default()
        };
        state
            .set(
                on(VenueId::Bybit, "demo:1"),
                "Firm A",
                true,
                Rules::default(),
            )
            .unwrap();
        // Another account's rules start at once, however loose beside the first's.
        let views = state
            .set(on(VenueId::Bybit, "2002"), "Firm B", true, strict)
            .unwrap();
        assert_eq!(views.len(), 2);
        assert!(views.iter().all(|v| v.on && v.pending.is_none()));
        assert_eq!(
            state
                .in_force(VenueId::Bybit, "demo:1")
                .unwrap()
                .trades_per_day,
            8.0
        );
        assert_eq!(
            state
                .in_force(VenueId::Bybit, "2002")
                .unwrap()
                .trades_per_day,
            2.0
        );
        // The same id on another venue is another account, with none.
        assert!(state.in_force(VenueId::Hyperliquid, "2002").is_none());
        // One account's lock is its own.
        let mut down = facts(10_000.0);
        down.now = now_ms();
        assert!(state
            .stand(VenueId::Bybit, "demo:1", &Rules::default(), &down)
            .lock
            .is_none());
        down.equity = 9_400.0;
        assert!(state
            .stand(VenueId::Bybit, "demo:1", &Rules::default(), &down)
            .lock
            .is_some());
        let mut fine = facts(10_000.0);
        fine.now = down.now;
        assert!(state
            .stand(VenueId::Bybit, "2002", &Rules::default(), &fine)
            .lock
            .is_none());
        // Kept, and read back: both sets, each with its progress.
        let again = TradingRules::load(state.path.clone());
        assert_eq!(again.views().len(), 2);
        assert!(again
            .stand(VenueId::Bybit, "demo:1", &Rules::default(), &down)
            .lock
            .is_some());
        if let Some(path) = &state.path {
            let _ = std::fs::remove_file(path);
        }
    }

    #[test]
    fn reads_the_file_an_earlier_version_kept() {
        let old = serde_json::json!({
            "on": true,
            "account": { "venue": "bybit", "id": "demo:7" },
            "rules": Rules::default(),
            "pending": null,
            "progress": { "started_at": 5, "peak": 10_500.0, "eod_peak": 10_000.0, "day": null,
                "last": null, "curve": [], "day_locked": null, "failed_at": null },
        });
        let saved = Saved::read(&serde_json::to_vec(&old).unwrap());
        assert_eq!(saved.sets.len(), 1);
        assert_eq!(saved.sets[0].account.id, "demo:7");
        assert!(saved.sets[0].on);
        assert_eq!(saved.sets[0].progress.peak, 10_500.0);
        assert!(Saved::read(b"not json").sets.is_empty());
    }
}
