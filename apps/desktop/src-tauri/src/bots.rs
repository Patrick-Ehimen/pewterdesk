//! The commands that make, backtest, start and steer bots, over the
//! engine's bot host (`pewterdesk_engine::bot`) - or, with "always on",
//! `pdd`'s, so they keep running with the app quit.
//!
//! Security-relevant - review any change here against
//! `.claude/commands/security-review.md`: a bot sends orders only through
//! the engine's router (the live switch, the trading rules, the log, client
//! ids), it paper trades for `PAPER_DAYS` before it may go live, and an
//! account whose rules bar bots can't run one live. These commands add no
//! other way to a venue.

use pewterdesk_core::VenueError;
use pewterdesk_engine::Engine;
use pewterdesk_protocol::rpc::Call;
use pewterdesk_strategy::bot::{BotSpec, BotView};
use pewterdesk_strategy::sim::RunResult;
use tauri::State;

use crate::daemon::{self, DaemonLink};

/// With always on, the call goes to pdd; else the app's own engine answers.
macro_rules! routed {
    ($daemon:expr, $call:expr, $here:expr) => {
        match $daemon.route().await? {
            Some(link) => daemon::forward(&link, $call).await,
            None => $here,
        }
    };
}

#[tauri::command]
pub async fn bots(
    engine: State<'_, Engine>,
    daemon: State<'_, DaemonLink>,
) -> Result<Vec<BotView>, VenueError> {
    routed!(daemon, Call::BotList, Ok(engine.bots().list()))
}

/// A new bot, in paper, not yet running.
#[tauri::command]
pub async fn bot_create(
    engine: State<'_, Engine>,
    daemon: State<'_, DaemonLink>,
    spec: BotSpec,
) -> Result<BotView, VenueError> {
    routed!(
        daemon,
        Call::BotCreate {
            spec: Box::new(spec.clone())
        },
        engine.bots().create(spec).await
    )
}

/// A backtest of `spec` on its market's candles from `since` (ms):
/// recorded ones, and older ones the venue still serves.
#[tauri::command]
pub async fn bot_backtest(
    engine: State<'_, Engine>,
    daemon: State<'_, DaemonLink>,
    spec: BotSpec,
    since: u64,
    hold_out_days: f64,
) -> Result<RunResult, VenueError> {
    routed!(
        daemon,
        Call::BotBacktest {
            spec: Box::new(spec.clone()),
            since,
            hold_out_days
        },
        engine.bots().backtest(&spec, since, hold_out_days).await
    )
}

#[tauri::command]
pub async fn bot_start(
    engine: State<'_, Engine>,
    daemon: State<'_, DaemonLink>,
    id: String,
) -> Result<BotView, VenueError> {
    routed!(
        daemon,
        Call::BotStart { id: id.clone() },
        engine.bots().start(&id).await
    )
}

/// From paper to live: only after its paper run.
#[tauri::command]
pub async fn bot_go_live(
    engine: State<'_, Engine>,
    daemon: State<'_, DaemonLink>,
    id: String,
) -> Result<BotView, VenueError> {
    routed!(
        daemon,
        Call::BotLive { id: id.clone() },
        engine.bots().go_live(&id).await
    )
}

#[tauri::command]
pub async fn bot_pause(
    engine: State<'_, Engine>,
    daemon: State<'_, DaemonLink>,
    id: String,
) -> Result<(), VenueError> {
    routed!(
        daemon,
        Call::BotPause { id: id.clone() },
        engine.bots().pause(&id)
    )
}

#[tauri::command]
pub async fn bot_resume(
    engine: State<'_, Engine>,
    daemon: State<'_, DaemonLink>,
    id: String,
) -> Result<(), VenueError> {
    routed!(
        daemon,
        Call::BotResume { id: id.clone() },
        engine.bots().resume(&id)
    )
}

#[tauri::command]
pub async fn bot_stop(
    engine: State<'_, Engine>,
    daemon: State<'_, DaemonLink>,
    id: String,
    flatten: bool,
) -> Result<(), VenueError> {
    routed!(
        daemon,
        Call::BotStop {
            id: id.clone(),
            flatten
        },
        engine.bots().stop(&id, flatten)
    )
}

#[tauri::command]
pub async fn bot_delete(
    engine: State<'_, Engine>,
    daemon: State<'_, DaemonLink>,
    id: String,
) -> Result<(), VenueError> {
    routed!(
        daemon,
        Call::BotDelete { id: id.clone() },
        engine.bots().delete(&id)
    )
}
