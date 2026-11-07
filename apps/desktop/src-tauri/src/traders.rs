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

use pewterdesk_core::{PositionSide, VenueError};
use pewterdesk_traders::{
    changes, hyperliquid::Hyperliquid, okx::Okx, valid_id, Change, ChangeKind, Holding, Period,
    SortBy, Source, TraderDetail, TraderRow, TraderStats,
};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, State};

pub const TRADER_MOVE: &str = "trader-move";
pub const TRADER_SNAPSHOT: &str = "trader-snapshot";

/// The most leaderboard traders read in one sweep call.
const MAX_SWEEP: usize = 12;
/// How long a sweep's look at a trader is kept.
const SWEEP_FRESH_FOR: Duration = Duration::from_secs(4 * 60);
/// How long a sweep's record of a trader is kept: weeks change slowly.
const STATS_FRESH_FOR: Duration = Duration::from_secs(30 * 60);
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
    /// The markets that alert (base coins); none means every market.
    #[serde(default)]
    pub markets: Vec<String>,
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
    /// The leaderboard's top traders, as last looked at for its insight cards.
    swept: Mutex<HashMap<(Source, String), Kept>>,
}

/// One trader's last look for the insight cards, and when each position
/// they hold was first seen (only those that appeared after the first look).
struct Kept {
    /// When the positions were read.
    at: Instant,
    /// When the record (`Swept::stats`) was read, if it has been.
    stats_at: Option<Instant>,
    seen: Swept,
}

/// A leaderboard trader's positions, for the insight cards.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Swept {
    pub source: Source,
    pub id: String,
    pub holdings: Vec<Holding>,
    /// When it was read, ms since the epoch.
    pub at: u64,
    /// Positions (market, side) that weren't there at an earlier look, and
    /// when they were first seen. Empty after the first look: what was
    /// already held then may be old.
    pub new_since: Vec<(String, PositionSide, u64)>,
    /// Their record (green weeks, drawdown, the month's line), where read.
    pub stats: Option<TraderStats>,
}

impl TradersState {
    pub fn new() -> Result<Self, VenueError> {
        Ok(Self {
            hl: Hyperliquid::new()?,
            okx: Okx::new()?,
            watch: Mutex::new(Watch::default()),
            swept: Mutex::new(HashMap::new()),
        })
    }

    async fn stats(&self, source: Source, id: &str) -> Result<TraderStats, VenueError> {
        match source {
            Source::Hyperliquid => self.hl.stats(id).await,
            Source::Okx => self.okx.stats(id).await,
        }
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
    follow.kinds.contains(&change.kind)
        && change.value >= follow.min_value
        && (follow.markets.is_empty() || follow.markets.iter().any(|m| m == &change.market))
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
        f.markets
            .retain(|m| m.len() <= 20 && m.bytes().all(|b| b.is_ascii_alphanumeric()));
        f.markets.truncate(50);
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

/// The positions of the leaderboard's top traders, for its insight cards:
/// read again only after `SWEEP_FRESH_FOR`. At most `MAX_SWEEP` a call, so
/// the page asks a few at a time and fills the cards in as they come.
#[tauri::command]
pub async fn traders_sweep(
    state: State<'_, TradersState>,
    source: Source,
    ids: Vec<String>,
) -> Result<Vec<Swept>, VenueError> {
    let mut out = Vec::new();
    for id in ids.into_iter().take(MAX_SWEEP) {
        let Ok(id) = checked(source, &id) else {
            continue;
        };
        let key = (source, id.clone());
        let (kept, positions_fresh, stats_fresh) = {
            let swept = state.swept.lock().unwrap();
            let kept = swept.get(&key);
            (
                kept.map(|k| k.seen.clone()),
                kept.is_some_and(|k| k.at.elapsed() < SWEEP_FRESH_FOR),
                kept.and_then(|k| k.stats_at)
                    .is_some_and(|at| at.elapsed() < STATS_FRESH_FOR),
            )
        };
        if let (Some(seen), true, true) = (&kept, positions_fresh, stats_fresh) {
            out.push(seen.clone());
            continue;
        }
        // One trader that can't be read doesn't stop the rest.
        let holdings = match &kept {
            Some(seen) if positions_fresh => seen.holdings.clone(),
            _ => match state.holdings(source, &id).await {
                Ok(h) => h,
                Err(_) => continue,
            },
        };
        let (stats, stats_at) = if stats_fresh {
            (kept.as_ref().and_then(|k| k.stats.clone()), None)
        } else {
            match state.stats(source, &id).await {
                Ok(s) => (Some(s), Some(Instant::now())),
                // Kept as it was; asked again at the next sweep.
                Err(_) => (kept.as_ref().and_then(|k| k.stats.clone()), None),
            }
        };
        let now = now_ms();
        let mut swept = state.swept.lock().unwrap();
        let previous = swept.get(&key);
        let new_since = if positions_fresh {
            kept.as_ref()
                .map(|k| k.new_since.clone())
                .unwrap_or_default()
        } else {
            new_positions(previous.map(|k| &k.seen), &holdings, now)
        };
        let at = if positions_fresh {
            previous.map_or(Instant::now(), |k| k.at)
        } else {
            Instant::now()
        };
        let stats_at = stats_at.or(previous.and_then(|k| k.stats_at));
        let seen = Swept {
            source,
            id,
            holdings,
            at: if positions_fresh {
                kept.as_ref().map_or(now, |k| k.at)
            } else {
                now
            },
            new_since,
            stats,
        };
        swept.insert(
            key,
            Kept {
                at,
                stats_at,
                seen: seen.clone(),
            },
        );
        out.push(seen);
    }
    Ok(out)
}

/// What's held now that wasn't at the last look, with when it was first
/// seen; carried over from the last look for what's still held. Nothing on
/// a first look.
fn new_positions(
    before: Option<&Swept>,
    now: &[Holding],
    at: u64,
) -> Vec<(String, PositionSide, u64)> {
    let Some(before) = before else {
        return Vec::new();
    };
    let mut out = Vec::new();
    for h in now {
        let key = (h.market.clone(), h.side);
        if out.iter().any(|(m, s, _)| (m, s) == (&key.0, &key.1)) {
            continue;
        }
        let carried = before
            .new_since
            .iter()
            .find(|(m, s, _)| (m, s) == (&key.0, &key.1));
        if let Some((_, _, t)) = carried {
            out.push((key.0, key.1, *t));
        } else if !before
            .holdings
            .iter()
            .any(|b| b.market == h.market && b.side == h.side)
        {
            out.push((key.0, key.1, at));
        }
    }
    out
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
            markets: Vec::new(),
        };
        assert!(alerts(&follow, &change(ChangeKind::Open, 911_000.0)));
        assert!(!alerts(&follow, &change(ChangeKind::Open, 38_000.0)));
        assert!(!alerts(&follow, &change(ChangeKind::Cut, 911_000.0)));
        // Only some markets: the rest stay quiet.
        let btc_only = Follow {
            markets: vec!["ETH".into()],
            ..follow
        };
        assert!(!alerts(&btc_only, &change(ChangeKind::Open, 911_000.0)));
    }

    fn holding(market: &str, side: PositionSide) -> Holding {
        Holding {
            market: market.into(),
            side,
            size: 1.0,
            entry: 1.0,
            mark: None,
            value: 1.0,
            leverage: None,
            unrealized: 0.0,
            liquidation: None,
            opened_at: None,
        }
    }

    #[test]
    fn new_positions_are_the_ones_not_there_before() {
        use PositionSide::{Long, Short};
        let first = vec![holding("BTC", Short)];
        // A first look: nothing counts as new.
        assert!(new_positions(None, &first, 10).is_empty());
        let before = Swept {
            source: Source::Hyperliquid,
            id: "x".into(),
            holdings: first,
            at: 10,
            new_since: Vec::new(),
            stats: None,
        };
        let now = vec![
            holding("BTC", Short),
            holding("ETH", Long),
            holding("ETH", Long),
        ];
        let seen = new_positions(Some(&before), &now, 20);
        assert_eq!(seen, [("ETH".to_string(), Long, 20)]);
        // Still held at the next look: keeps when it was first seen.
        let later = Swept {
            holdings: now.clone(),
            new_since: seen,
            ..before
        };
        assert_eq!(
            new_positions(Some(&later), &now, 30),
            [("ETH".to_string(), Long, 20)]
        );
        // Flipped to the other side: that's new.
        let flipped = vec![holding("BTC", Long)];
        assert_eq!(
            new_positions(Some(&later), &flipped, 40),
            [("BTC".to_string(), Long, 40)]
        );
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
