//! Top traders, for the Traders page: Hyperliquid's and OKX's leaderboards,
//! a trader's page, and the traders the trader follows, watched while the
//! app runs.
//!
//! Data sources, not venues: keyless public reads through
//! `pewterdesk-traders` (fixed hosts, no redirects, size caps), nothing
//! signed, no account of the trader's own. The page names a trader by an id
//! that's checked before any request is built, and a source, period and
//! sort from fixed sets.
//!
//! The watch: the page hands over who's followed (`set_trader_watch`); a
//! task reads each one's positions - Hyperliquid's every 15 seconds, OKX's
//! every 30 (its limit is 5 requests per 2 seconds) - and emits what
//! changed (`TRADER_MOVE`), each marked whether it meets that trader's
//! alert settings, and each look's positions (`TRADER_SNAPSHOT`). The
//! first look at a trader only sets where they start. It stops when no one
//! is followed, and runs only while the app does: the watch server (ADR
//! 0005) is for when it doesn't.

use std::collections::HashMap;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use pewterdesk_core::VenueError;
use pewterdesk_traders::{
    changes, hyperliquid::Hyperliquid, okx::Okx, valid_id, Change, ChangeKind, Holding, Period,
    SortBy, Source, TraderDetail, TraderRow,
};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, State};

pub const TRADER_MOVE: &str = "trader-move";
pub const TRADER_SNAPSHOT: &str = "trader-snapshot";

/// The most traders watched at once.
const MAX_FOLLOWS: usize = 40;
/// The most names looked up in one call.
const MAX_LOOKUPS: usize = 60;
const HL_EVERY: Duration = Duration::from_secs(15);
const OKX_EVERY: Duration = Duration::from_secs(30);
/// How often the watch wakes to see who's due.
const TICK: Duration = Duration::from_secs(3);

/// One followed trader, as the page hands it over.
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Follow {
    pub source: Source,
    pub id: String,
    /// Moves worth less than this (USD) are kept but don't alert.
    #[serde(default)]
    pub min_value: f64,
    /// The kinds that alert; the rest are kept but don't.
    #[serde(default)]
    pub kinds: Vec<ChangeKind>,
}

/// What a followed trader just did.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TraderMove {
    pub source: Source,
    pub id: String,
    pub change: Change,
    /// When it was seen, ms since the epoch.
    pub at: u64,
    /// Whether it meets the trader's alert settings for them.
    pub alert: bool,
}

/// A look at a followed trader's positions.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    pub source: Source,
    pub id: String,
    pub holdings: Vec<Holding>,
    /// When it was read, ms since the epoch; for an error, the last good read's.
    pub at: u64,
    /// Seconds between looks.
    pub every: u64,
    /// Why the last look failed, if it did.
    pub error: Option<String>,
}

#[derive(Default)]
struct Watch {
    follows: Vec<Follow>,
    /// The last good look at each, and when the next is due.
    seen: HashMap<(Source, String), Snapshot>,
    due: HashMap<(Source, String), Instant>,
    running: bool,
}

pub struct TradersState {
    hl: Hyperliquid,
    okx: Okx,
    watch: Mutex<Watch>,
}

impl TradersState {
    pub fn new() -> Result<Self, VenueError> {
        Ok(Self {
            hl: Hyperliquid::new()?,
            okx: Okx::new()?,
            watch: Mutex::new(Watch::default()),
        })
    }

    async fn holdings(&self, source: Source, id: &str) -> Result<Vec<Holding>, VenueError> {
        match source {
            Source::Hyperliquid => self.hl.holdings(id).await.map(|(_, h)| h),
            Source::Okx => self.okx.holdings(id).await,
        }
    }
}

fn checked(source: Source, id: &str) -> Result<String, VenueError> {
    let id = match source {
        Source::Hyperliquid => id.to_ascii_lowercase(),
        Source::Okx => id.to_owned(),
    };
    if valid_id(source, &id) {
        Ok(id)
    } else {
        Err(VenueError::InvalidRequest(
            "that isn't a trader this source knows".into(),
        ))
    }
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| d.as_millis() as u64)
}

fn every(source: Source) -> Duration {
    match source {
        Source::Hyperliquid => HL_EVERY,
        Source::Okx => OKX_EVERY,
    }
}

/// Whether `change` meets `follow`'s alert settings.
fn alerts(follow: &Follow, change: &Change) -> bool {
    follow.kinds.contains(&change.kind) && change.value >= follow.min_value
}

/// A leaderboard. OKX ranks over the time a trader has led, so `period` is
/// Hyperliquid's only, as is `min_account` (USD).
#[tauri::command]
pub async fn traders_leaderboard(
    state: State<'_, TradersState>,
    source: Source,
    period: Period,
    sort: SortBy,
    min_account: f64,
    limit: usize,
) -> Result<Vec<TraderRow>, VenueError> {
    match source {
        Source::Hyperliquid => state.hl.leaderboard(period, sort, min_account, limit).await,
        Source::Okx => state.okx.leaderboard(sort, limit).await,
    }
}

/// A trader's page.
#[tauri::command]
pub async fn trader_detail(
    state: State<'_, TradersState>,
    source: Source,
    id: String,
    period: Period,
) -> Result<TraderDetail, VenueError> {
    let id = checked(source, &id)?;
    match source {
        Source::Hyperliquid => state.hl.detail(&id, period).await,
        Source::Okx => state.okx.detail(&id, period).await,
    }
}

/// The leaderboard lines of traders the page names (followed ones), where
/// they're on one: Hyperliquid's from its board, OKX's from a board read
/// in the last 10 minutes.
#[tauri::command]
pub async fn trader_rows(
    state: State<'_, TradersState>,
    traders: Vec<(Source, String)>,
    period: Period,
) -> Result<Vec<TraderRow>, VenueError> {
    let mut out = Vec::new();
    for (source, id) in traders.into_iter().take(MAX_LOOKUPS) {
        let Ok(id) = checked(source, &id) else {
            continue;
        };
        let row = match source {
            Source::Hyperliquid => state.hl.row(&id, period).await?,
            Source::Okx => state.okx.row(&id),
        };
        out.extend(row);
    }
    Ok(out)
}

/// Who to watch, replacing whoever was. Starts the watch if it isn't running.
#[tauri::command]
pub fn set_trader_watch(
    app: AppHandle,
    state: State<'_, TradersState>,
    follows: Vec<Follow>,
) -> Result<(), VenueError> {
    let mut kept: Vec<Follow> = Vec::new();
    for mut f in follows {
        let Ok(id) = checked(f.source, &f.id) else {
            continue;
        };
        f.id = id;
        f.min_value = if f.min_value.is_finite() {
            f.min_value.max(0.0)
        } else {
            0.0
        };
        if kept.len() < MAX_FOLLOWS && !kept.iter().any(|k| k.source == f.source && k.id == f.id) {
            kept.push(f);
        }
    }
    let mut watch = state.watch.lock().unwrap();
    // Forget whoever isn't followed any more, so following them again starts afresh.
    watch
        .seen
        .retain(|(s, id), _| kept.iter().any(|f| f.source == *s && &f.id == id));
    watch
        .due
        .retain(|(s, id), _| kept.iter().any(|f| f.source == *s && &f.id == id));
    let start = !kept.is_empty() && !watch.running;
    watch.follows = kept;
    if start {
        watch.running = true;
        tauri::async_runtime::spawn(run(app));
    }
    Ok(())
}

/// The last look at each followed trader, for a page that just opened.
#[tauri::command]
pub fn trader_snapshots(state: State<'_, TradersState>) -> Vec<Snapshot> {
    state.watch.lock().unwrap().seen.values().cloned().collect()
}

/// The watch: until no one is followed, look at whoever is due.
async fn run(app: AppHandle) {
    loop {
        let due: Vec<Follow> = {
            let state = app.state::<TradersState>();
            let mut watch = state.watch.lock().unwrap();
            if watch.follows.is_empty() {
                watch.running = false;
                return;
            }
            let now = Instant::now();
            let follows = watch.follows.clone();
            follows
                .into_iter()
                .filter(|f| {
                    watch
                        .due
                        .get(&(f.source, f.id.clone()))
                        .is_none_or(|at| *at <= now)
                })
                .collect()
        };
        for follow in due {
            look(&app, &follow).await;
        }
        tokio::time::sleep(TICK).await;
    }
}

/// One look at `follow`: compared with the last, what changed is emitted.
async fn look(app: &AppHandle, follow: &Follow) {
    let state = app.state::<TradersState>();
    let key = (follow.source, follow.id.clone());
    let read = state.holdings(follow.source, &follow.id).await;
    let at = now_ms();
    let mut moves = Vec::new();
    let snapshot = {
        let mut watch = state.watch.lock().unwrap();
        watch
            .due
            .insert(key.clone(), Instant::now() + every(follow.source));
        // Unfollowed while this look was out: drop it.
        let current = watch
            .follows
            .iter()
            .find(|f| f.source == follow.source && f.id == follow.id)
            .cloned();
        let Some(current) = current else { return };
        let snapshot = match read {
            Ok(holdings) => {
                if let Some(before) = watch.seen.get(&key) {
                    for change in changes(&before.holdings, &holdings) {
                        moves.push(TraderMove {
                            source: follow.source,
                            id: follow.id.clone(),
                            alert: alerts(&current, &change),
                            change,
                            at,
                        });
                    }
                }
                Snapshot {
                    source: follow.source,
                    id: follow.id.clone(),
                    holdings,
                    at,
                    every: every(follow.source).as_secs(),
                    error: None,
                }
            }
            Err(e) => {
                // Keep the last good look to compare against; say why this one failed.
                let mut last = watch.seen.get(&key).cloned().unwrap_or(Snapshot {
                    source: follow.source,
                    id: follow.id.clone(),
                    holdings: Vec::new(),
                    at: 0,
                    every: every(follow.source).as_secs(),
                    error: None,
                });
                last.error = Some(e.to_string().chars().take(160).collect());
                // A first look that failed sets no starting point.
                if last.at == 0 {
                    let _ = app.emit(TRADER_SNAPSHOT, &last);
                    return;
                }
                last
            }
        };
        watch.seen.insert(key, snapshot.clone());
        snapshot
    };
    for m in &moves {
        let _ = app.emit(TRADER_MOVE, m);
    }
    let _ = app.emit(TRADER_SNAPSHOT, &snapshot);
}

#[cfg(test)]
mod tests {
    use super::*;
    use pewterdesk_core::PositionSide;

    fn change(kind: ChangeKind, value: f64) -> Change {
        Change {
            market: "BTC".into(),
            kind,
            side: PositionSide::Short,
            size_before: 0.0,
            size_after: 1.0,
            price: value,
            value,
        }
    }

    #[test]
    fn alerts_follow_the_kinds_and_the_floor() {
        let follow = Follow {
            source: Source::Hyperliquid,
            id: "0xf5d81a135f756ca16544e53c20fc20643ec3ad53".into(),
            min_value: 250_000.0,
            kinds: vec![ChangeKind::Open, ChangeKind::Close],
        };
        assert!(alerts(&follow, &change(ChangeKind::Open, 911_000.0)));
        assert!(!alerts(&follow, &change(ChangeKind::Open, 38_000.0)));
        assert!(!alerts(&follow, &change(ChangeKind::Cut, 911_000.0)));
    }

    #[test]
    fn ids_are_checked_and_addresses_lowercased() {
        assert_eq!(
            checked(
                Source::Hyperliquid,
                "0xF5D81A135F756CA16544E53C20FC20643EC3AD53"
            )
            .unwrap(),
            "0xf5d81a135f756ca16544e53c20fc20643ec3ad53"
        );
        assert!(checked(Source::Okx, "9F25A5FBE6CFF912").is_ok());
        assert!(checked(Source::Okx, "../../x").is_err());
        assert!(checked(Source::Hyperliquid, "9F25A5FBE6CFF912").is_err());
    }
}
