//! The venues' dead-man's switches, kept armed while an algo runs on this
//! machine: if the app stops (the machine asleep, a crash), the venue
//! cancels what's resting within a couple of minutes rather than leaving
//! orders nobody manages. Re-armed every 30 seconds with a 2-minute
//! countdown (Aster's advice); turned off once no algo needs it.
//!
//! Where the switch is per account (Hyperliquid's `scheduleCancel`), it
//! would cancel every open order the account has - the trader's own too -
//! not only the algo's; where it's per market (Aster's
//! `countdownCancelAll`), that market's. Bybit's (DCP) is a websocket
//! feature for institutional accounts only, so a Bybit algo has none.
//! Hyperliquid's fires at most 10 times a day; re-arming doesn't count.

use std::collections::HashSet;
use std::sync::Arc;
use std::time::Duration;

use pewterdesk_core::{AlgoStatus, Origin, RunsOn, VenueError, VenueId};

use super::Host;
use crate::By;

const EVERY: Duration = Duration::from_secs(30);
const COUNTDOWN_MS: u64 = 120_000;

/// What one switch covers: a venue's account, and the market where it's per
/// market (`None` where it's per account).
type Key = (VenueId, String, Option<String>);

fn key(venue: VenueId, account: &str, market: &str) -> Key {
    match venue {
        VenueId::Hyperliquid => (venue, account.to_owned(), None),
        _ => (venue, account.to_owned(), Some(market.to_owned())),
    }
}

/// Which switches algos on this machine need now.
fn wanted(host: &Arc<dyn Host>) -> HashSet<Key> {
    host.engine()
        .algos()
        .list()
        .into_iter()
        .filter(|v| v.runs_on == RunsOn::Local)
        .filter(|v| matches!(v.status, AlgoStatus::Running | AlgoStatus::Paused))
        .map(|v| key(v.spec.venue, &v.spec.account, &v.spec.market))
        .collect()
}

pub(super) async fn run(host: Arc<dyn Host>) {
    let mut armed: HashSet<Key> = HashSet::new();
    // Venues without one, found out once.
    let mut unsupported: HashSet<VenueId> = HashSet::new();
    let by = By {
        origin: Origin::Engine,
        algo: None,
    };
    loop {
        let wanted = wanted(&host);
        let engine = host.engine();
        for (venue, account, market) in &wanted {
            if unsupported.contains(venue) {
                continue;
            }
            engine.algos().budget.take(*venue).await;
            let market = market.as_deref().unwrap_or("");
            match engine
                .schedule_cancel(
                    host.venues(),
                    by,
                    *venue,
                    account,
                    market,
                    Some(COUNTDOWN_MS),
                )
                .await
            {
                Ok(()) => {
                    armed.insert((
                        *venue,
                        account.clone(),
                        (!market.is_empty()).then(|| market.to_owned()),
                    ));
                }
                Err(VenueError::Unsupported(_)) => {
                    unsupported.insert(*venue);
                }
                // Logged by the router; tried again next round.
                Err(_) => {}
            }
        }
        let done: Vec<Key> = armed.difference(&wanted).cloned().collect();
        for key in done {
            let (venue, account, market) = &key;
            engine.algos().budget.take(*venue).await;
            let market = market.as_deref().unwrap_or("");
            if engine
                .schedule_cancel(host.venues(), by, *venue, account, market, None)
                .await
                .is_ok()
            {
                armed.remove(&key);
            }
        }
        tokio::time::sleep(EVERY).await;
    }
}
