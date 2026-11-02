//! The app's market alerts, watched while the app is closed.
//!
//! The app hands them over (`alerts.sync`) whenever they change. While a
//! synced app is connected it checks them itself, as it always has; once it
//! goes (quit, not just its window closed), this takes over: each alert's
//! venue's market summaries, and hourly candles for an RSI alert, read the
//! same way the app reads them, and a crossing fires a system notification.
//! What fired is kept until the app is back and takes it (the reply to its
//! next sync), so its own list and "Fired today" catch up.
//!
//! Notifies only: public market data in, a notification out. Nothing here
//! reaches the router, an account or a key. Kept in `pdd-alerts.json`
//! (0600) in the data folder, so a restarted daemon carries on.

use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use pewterdesk_core::{CandleInterval, MarketSummary, VenueId};
use pewterdesk_protocol::rpc::{
    AlertCondition, AlertFiring, AlertKind, AlertsSync, WatchedAlert, MAX_ALERTS, MAX_ALERT_TEXT,
};
use rust_decimal::prelude::ToPrimitive;
use serde::{Deserialize, Serialize};
use tokio::task::JoinHandle;

use crate::host::Daemon;
use crate::pairing::write_private;

/// How often the alerts are checked against the latest readings.
const TICK: Duration = Duration::from_secs(10);
/// Summaries older than this are a feed gone quiet: not checked against.
const STALE: Duration = Duration::from_secs(90);
/// A repeating alert's quiet time after it fires, as the app's.
const COOLDOWN_MS: u64 = 5 * 60_000;
/// How often an RSI alert's market has its hourly candles read again.
const RSI_EVERY: Duration = Duration::from_secs(5 * 60);
/// Hourly candles read for RSI(14), as the app reads.
const RSI_CANDLES: u32 = 50;
const RSI_PERIOD: usize = 14;
/// Firings kept for the app; the oldest go first.
const AWAY_KEPT: usize = 200;

#[derive(Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Stored {
    alerts: Vec<WatchedAlert>,
    paused: bool,
    /// Fired while the app was away, not yet taken.
    away: Vec<AlertFiring>,
}

pub struct Alerts {
    path: PathBuf,
    stored: Mutex<Stored>,
    /// Connected apps that have synced: while there's one, it checks.
    present: AtomicUsize,
}

/// A synced app's connection; dropped when it goes.
pub struct Presence(Arc<Alerts>);

impl Drop for Presence {
    fn drop(&mut self) {
        self.0.present.fetch_sub(1, Ordering::SeqCst);
    }
}

impl Alerts {
    pub fn load(path: PathBuf) -> Self {
        let stored = std::fs::read(&path)
            .ok()
            .and_then(|b| serde_json::from_slice::<Stored>(&b).ok())
            .unwrap_or_default();
        Self {
            path,
            stored: Mutex::new(stored),
            present: AtomicUsize::new(0),
        }
    }

    /// Marks an app's connection as the one checking, until it's dropped.
    pub fn presence(self: &Arc<Self>) -> Presence {
        self.present.fetch_add(1, Ordering::SeqCst);
        Presence(Arc::clone(self))
    }

    fn app_present(&self) -> bool {
        self.present.load(Ordering::SeqCst) > 0
    }

    fn save(&self, stored: &Stored) {
        if let Ok(json) = serde_json::to_vec(stored) {
            if let Err(e) = write_private(&self.path, &json) {
                eprintln!("pdd: the alerts couldn't be kept: {e}");
            }
        }
    }

    /// Takes the app's alerts in place of what's held, and gives back what
    /// fired while it was away. Refuses a list outside the protocol's bounds.
    pub fn sync(&self, sync: AlertsSync) -> Result<Vec<AlertFiring>, String> {
        if sync.alerts.len() > MAX_ALERTS {
            return Err(format!("at most {MAX_ALERTS} alerts"));
        }
        if let Some(bad) = sync.alerts.iter().find(|a| !a.valid()) {
            return Err(format!(
                "alert {:?} is out of bounds",
                bad.id.chars().take(16).collect::<String>()
            ));
        }
        let mut stored = self
            .stored
            .lock()
            .map_err(|_| "the alerts are unavailable")?;
        stored.alerts = sync.alerts;
        stored.paused = sync.paused;
        let away = std::mem::take(&mut stored.away);
        self.save(&stored);
        Ok(away)
    }
}

/// What `kind` watches, from the market's summary (and its RSI): `None`
/// when it can't be read. The app's `watchedValue`, for these kinds.
fn watched(kind: AlertKind, summary: Option<&MarketSummary>, rsi: Option<f64>) -> Option<f64> {
    if kind == AlertKind::Rsi {
        return rsi.filter(|r| r.is_finite());
    }
    let s = summary?;
    let num = |d: &pewterdesk_core::Decimal| d.0.to_f64();
    let mark = num(&s.mark_price)?;
    let value = match kind {
        AlertKind::Volume => num(&s.day_volume)?,
        AlertKind::Oi => num(&s.open_interest)? * mark,
        AlertKind::Price => mark,
        AlertKind::Move => {
            let prev = num(&s.prev_day_price)?;
            if prev <= 0.0 {
                return None;
            }
            (mark - prev) / prev * 100.0
        }
        AlertKind::Funding => num(&s.funding_rate)? * 100.0,
        AlertKind::Rsi => unreachable!("read above"),
    };
    value.is_finite().then_some(value)
}

/// Whether going from `before` to `now` crossed the line. A first reading
/// never fires, so an alert set on the far side waits for a real crossing.
fn crossed(alert: &WatchedAlert, before: Option<f64>, now: f64) -> bool {
    let Some(before) = before else { return false };
    match alert.condition {
        AlertCondition::Above => before < alert.value && now >= alert.value,
        AlertCondition::Below => before > alert.value && now <= alert.value,
    }
}

/// On, and out of its cooldown.
fn can_fire(alert: &WatchedAlert, now: u64) -> bool {
    alert.active
        && alert
            .fired_at
            .is_none_or(|t| now.saturating_sub(t) >= COOLDOWN_MS)
}

/// Wilder's RSI over `period` changes, as the app's `rsi`.
fn rsi(closes: &[f64], period: usize) -> Option<f64> {
    if closes.len() < period + 1 {
        return None;
    }
    let (mut gain, mut loss) = (0.0, 0.0);
    for w in closes[..=period].windows(2) {
        let d = w[1] - w[0];
        if d > 0.0 {
            gain += d;
        } else {
            loss -= d;
        }
    }
    gain /= period as f64;
    loss /= period as f64;
    for w in closes[period..].windows(2) {
        let d = w[1] - w[0];
        gain = (gain * (period as f64 - 1.0) + d.max(0.0)) / period as f64;
        loss = (loss * (period as f64 - 1.0) + (-d).max(0.0)) / period as f64;
    }
    if loss == 0.0 {
        return Some(if gain == 0.0 { 50.0 } else { 100.0 });
    }
    Some(100.0 - 100.0 / (1.0 + gain / loss))
}

/// The notification's text: plain, one line, bounded.
fn plain(text: &str) -> String {
    text.chars()
        .map(|c| if c.is_control() { ' ' } else { c })
        .take(MAX_ALERT_TEXT)
        .collect::<String>()
        .trim()
        .to_owned()
}

/// A system notification. The text goes as an argument, never into the script.
async fn notify(text: &str, sound: bool) {
    let text = plain(text);
    #[cfg(target_os = "macos")]
    {
        let line = if sound {
            "display notification (item 1 of argv) with title \"pewterdesk\" sound name \"Glass\""
        } else {
            "display notification (item 1 of argv) with title \"pewterdesk\""
        };
        let script = ["on run argv", line, "end run"];
        let mut command = tokio::process::Command::new("/usr/bin/osascript");
        for l in script {
            command.arg("-e").arg(l);
        }
        command.arg("--").arg(&text);
        if let Err(e) = command.output().await {
            eprintln!("pdd: an alert couldn't be shown: {e}");
        }
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = sound;
        eprintln!("pdd: alert: {text}");
    }
}

type Latest = Arc<Mutex<HashMap<VenueId, (Instant, Arc<HashMap<String, MarketSummary>>)>>>;

/// One venue's summaries, kept current while the task runs.
fn feed(daemon: Arc<Daemon>, venue: VenueId, latest: Latest) -> JoinHandle<()> {
    tokio::spawn(async move {
        let Ok(adapter) = daemon.venues.adapter(venue) else {
            return;
        };
        let Ok(mut rx) = adapter.subscribe_market_summaries().await else {
            return;
        };
        while let Some(list) = rx.recv().await {
            let by_market = list.into_iter().map(|s| (s.market.clone(), s)).collect();
            if let Ok(mut latest) = latest.lock() {
                latest.insert(venue, (Instant::now(), Arc::new(by_market)));
            }
        }
    })
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| d.as_millis() as u64)
}

/// Watches the alerts while no app is: runs for the daemon's life.
pub async fn watch(daemon: Arc<Daemon>) {
    let alerts = Arc::clone(&daemon.alerts);
    let latest: Latest = Arc::default();
    let mut feeds: HashMap<VenueId, JoinHandle<()>> = HashMap::new();
    // The last reading each alert saw, so a crossing takes two.
    let mut previous: HashMap<String, f64> = HashMap::new();
    let mut rsi_read: HashMap<(VenueId, String), (Instant, f64)> = HashMap::new();
    loop {
        tokio::time::sleep(TICK).await;
        let (active, paused) = match alerts.stored.lock() {
            Ok(s) => (
                s.alerts
                    .iter()
                    .filter(|a| a.active)
                    .cloned()
                    .collect::<Vec<_>>(),
                s.paused,
            ),
            Err(_) => continue,
        };
        // The app checks while it's here; nothing to do when held or empty.
        if alerts.app_present() || paused || active.is_empty() {
            for (_, task) in feeds.drain() {
                task.abort();
            }
            if let Ok(mut l) = latest.lock() {
                l.clear();
            }
            // Taking over again starts from fresh readings, not the gap.
            previous.clear();
            continue;
        }

        let venues: HashSet<VenueId> = active.iter().map(|a| a.venue).collect();
        feeds.retain(|venue, task| {
            let keep = venues.contains(venue) && !task.is_finished();
            if !keep {
                task.abort();
                if let Ok(mut l) = latest.lock() {
                    l.remove(venue);
                }
            }
            keep
        });
        for venue in &venues {
            feeds
                .entry(*venue)
                .or_insert_with(|| feed(Arc::clone(&daemon), *venue, Arc::clone(&latest)));
        }

        // RSI alerts' hourly candles, every few minutes.
        for a in active.iter().filter(|a| a.kind == AlertKind::Rsi) {
            let key = (a.venue, a.market.clone());
            if rsi_read
                .get(&key)
                .is_some_and(|(at, _)| at.elapsed() < RSI_EVERY)
            {
                continue;
            }
            let Ok(adapter) = daemon.venues.adapter(a.venue) else {
                continue;
            };
            let candles = adapter
                .candles(
                    &a.market,
                    CandleInterval::OneHour,
                    now_ms() + 1,
                    RSI_CANDLES,
                )
                .await;
            if let Ok(candles) = candles {
                let closes: Vec<f64> = candles.iter().filter_map(|c| c.close.0.to_f64()).collect();
                if let Some(value) = rsi(&closes, RSI_PERIOD) {
                    rsi_read.insert(key, (Instant::now(), value));
                }
            }
        }
        rsi_read.retain(|(venue, market), _| {
            active
                .iter()
                .any(|a| a.kind == AlertKind::Rsi && a.venue == *venue && &a.market == market)
        });

        let snapshot: HashMap<VenueId, Arc<HashMap<String, MarketSummary>>> = match latest.lock() {
            Ok(l) => l
                .iter()
                .filter(|(_, (at, _))| at.elapsed() < STALE)
                .map(|(v, (_, m))| (*v, Arc::clone(m)))
                .collect(),
            Err(_) => continue,
        };
        let now = now_ms();
        let mut fired: Vec<(WatchedAlert, f64)> = Vec::new();
        for alert in &active {
            let summaries = snapshot.get(&alert.venue);
            if alert.kind != AlertKind::Rsi && summaries.is_none() {
                continue;
            }
            let rsi = rsi_read
                .get(&(alert.venue, alert.market.clone()))
                .map(|(_, v)| *v);
            let Some(current) = watched(
                alert.kind,
                summaries.and_then(|m| m.get(&alert.market)),
                rsi,
            ) else {
                continue;
            };
            let before = previous.insert(alert.id.clone(), current);
            if can_fire(alert, now) && crossed(alert, before, current) {
                fired.push((alert.clone(), current));
            }
        }
        previous.retain(|id, _| active.iter().any(|a| &a.id == id));
        if fired.is_empty() {
            continue;
        }

        // The app may have come back while this ran: it fires them itself then.
        if alerts.app_present() {
            continue;
        }
        if let Ok(mut stored) = alerts.stored.lock() {
            for (alert, actual) in &fired {
                if let Some(a) = stored.alerts.iter_mut().find(|a| a.id == alert.id) {
                    a.fired_at = Some(now);
                    a.active = a.repeat;
                }
                stored.away.push(AlertFiring {
                    alert_id: alert.id.clone(),
                    actual: *actual,
                    time: now,
                });
            }
            let extra = stored.away.len().saturating_sub(AWAY_KEPT);
            stored.away.drain(..extra);
            alerts.save(&stored);
        }
        for (alert, _) in &fired {
            notify(&alert.text, alert.sound).await;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use pewterdesk_core::Decimal;

    fn alert(condition: AlertCondition, value: f64) -> WatchedAlert {
        WatchedAlert {
            id: "a".into(),
            kind: AlertKind::Price,
            venue: VenueId::Bybit,
            market: "BTCUSDT".into(),
            condition,
            value,
            repeat: false,
            active: true,
            fired_at: None,
            text: "BTC rose above 100".into(),
            sound: false,
        }
    }

    fn summary(mark: &str, prev: &str) -> MarketSummary {
        let d = |s: &str| Decimal(s.parse().unwrap());
        MarketSummary {
            market: "BTCUSDT".into(),
            mark_price: d(mark),
            prev_day_price: d(prev),
            day_volume: d("1000"),
            open_interest: d("2"),
            funding_rate: d("0.0001"),
            funding_interval_secs: 28_800,
        }
    }

    #[test]
    fn a_crossing_takes_two_readings() {
        let above = alert(AlertCondition::Above, 100.0);
        assert!(!crossed(&above, None, 120.0));
        assert!(crossed(&above, Some(99.0), 100.0));
        assert!(!crossed(&above, Some(101.0), 120.0));
        let below = alert(AlertCondition::Below, 100.0);
        assert!(crossed(&below, Some(101.0), 99.0));
    }

    #[test]
    fn a_repeating_alert_waits_out_its_cooldown() {
        let mut a = alert(AlertCondition::Above, 1.0);
        assert!(can_fire(&a, 10));
        a.fired_at = Some(1_000);
        assert!(!can_fire(&a, 1_000 + COOLDOWN_MS - 1));
        assert!(can_fire(&a, 1_000 + COOLDOWN_MS));
        a.active = false;
        assert!(!can_fire(&a, u64::MAX));
    }

    #[test]
    fn reads_each_kind_as_the_app_does() {
        let s = summary("110", "100");
        assert_eq!(watched(AlertKind::Price, Some(&s), None), Some(110.0));
        assert_eq!(watched(AlertKind::Move, Some(&s), None), Some(10.0));
        assert_eq!(watched(AlertKind::Funding, Some(&s), None), Some(0.01));
        assert_eq!(watched(AlertKind::Volume, Some(&s), None), Some(1000.0));
        assert_eq!(watched(AlertKind::Oi, Some(&s), None), Some(220.0));
        assert_eq!(watched(AlertKind::Rsi, None, Some(65.0)), Some(65.0));
        assert_eq!(
            watched(AlertKind::Move, Some(&summary("110", "0")), None),
            None
        );
        assert_eq!(watched(AlertKind::Price, None, None), None);
    }

    #[test]
    fn rsi_matches_the_apps() {
        assert_eq!(rsi(&[1.0; 10], 14), None);
        assert_eq!(rsi(&[5.0; 20], 14), Some(50.0));
        let rising: Vec<f64> = (0..20).map(f64::from).collect();
        assert_eq!(rsi(&rising, 14), Some(100.0));
        // Up 2, down 1, over and over: about two thirds of the movement is up.
        let zigzag: Vec<f64> = (0..40).map(|i| f64::from(i / 2 + (i % 2) * 2)).collect();
        let value = rsi(&zigzag, 14).unwrap();
        assert!(value > 55.0 && value < 80.0, "{value}");
    }

    #[test]
    fn a_sync_replaces_the_alerts_and_hands_back_what_fired_once() {
        let path =
            std::env::temp_dir().join(format!("pdd-alerts-test-{}.json", std::process::id()));
        let alerts = Alerts::load(path.clone());
        alerts.stored.lock().unwrap().away.push(AlertFiring {
            alert_id: "a".into(),
            actual: 101.0,
            time: 5,
        });
        let sync = AlertsSync {
            alerts: vec![alert(AlertCondition::Above, 100.0)],
            paused: false,
        };
        assert_eq!(alerts.sync(sync.clone()).unwrap().len(), 1);
        assert!(alerts.sync(sync).unwrap().is_empty());
        assert_eq!(
            Alerts::load(path.clone())
                .stored
                .lock()
                .unwrap()
                .alerts
                .len(),
            1
        );
        let too_many = AlertsSync {
            alerts: vec![alert(AlertCondition::Above, 1.0); MAX_ALERTS + 1],
            paused: false,
        };
        assert!(alerts.sync(too_many).is_err());
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn presence_counts_connections() {
        let alerts = Arc::new(Alerts::load(
            std::env::temp_dir().join("pdd-alerts-unused.json"),
        ));
        assert!(!alerts.app_present());
        let one = alerts.presence();
        assert!(alerts.app_present());
        drop(one);
        assert!(!alerts.app_present());
    }

    #[test]
    fn notification_text_is_one_bounded_line() {
        assert_eq!(plain("BTC\nrose\u{7}"), "BTC rose");
        assert_eq!(plain(&"x".repeat(500)).chars().count(), MAX_ALERT_TEXT);
    }
}
