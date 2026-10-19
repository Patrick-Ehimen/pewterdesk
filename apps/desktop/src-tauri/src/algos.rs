//! The commands that start, steer and show algo orders (chaser, TWAP,
//! scaled), over the engine's algos (`pewterdesk_engine::algo`), and the
//! host the engine runs them on: the app's venues and calendar, and an
//! `algo` event to every window when one changes.
//!
//! Security-relevant - review any change here against
//! `.claude/commands/security-review.md`: an algo sends orders, but only
//! through the engine's router - the same gate (live-trading switch, trading
//! rules), log and client ids as the ticket - so these commands add no way
//! to reach a venue. `halt` only stops and cancels.

use std::sync::Arc;

use pewterdesk_core::{AlgoSpec, AlgoView, Origin, StopMode, VenueError};
use pewterdesk_engine::algo::Host;
use pewterdesk_engine::{Adapters, Calendar, Engine};
use tauri::{AppHandle, Emitter, Manager, State};

use crate::daemon::{self, DaemonLink};
use crate::econ_calendar::CalendarState;
use crate::venues::Venues;
use pewterdesk_protocol::rpc::Call;

/// The most past algos the history returns.
const HISTORY_MAX: usize = 200;

/// The app, as the engine's host.
pub struct AppHost(pub AppHandle);

impl Host for AppHost {
    fn engine(&self) -> &Engine {
        self.0.state::<Engine>().inner()
    }

    fn venues(&self) -> &dyn Adapters {
        self.0.state::<Venues>().inner()
    }

    fn calendar(&self) -> &dyn Calendar {
        self.0.state::<CalendarState>().inner()
    }

    fn publish(&self, view: &AlgoView) {
        let _ = self.0.emit("algo", view);
    }
}

/// Connects the engine's algos to the app, then deals with any the app
/// closed on last time (stopped, their resting orders cancelled; a
/// venue-run one followed again).
pub fn install(app: &AppHandle) {
    let host: Arc<dyn Host> = Arc::new(AppHost(app.clone()));
    app.state::<Engine>().algos().attach(host);
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        app.state::<Engine>().algos().reconcile().await;
    });
}

/// Starts an algo: checked first (the account can trade, the market
/// exists, the size can be placed), then every order it sends is checked
/// by the gate as it goes.
#[tauri::command]
pub async fn start_algo(
    engine: State<'_, Engine>,
    daemon: State<'_, DaemonLink>,
    spec: AlgoSpec,
    origin: Option<Origin>,
) -> Result<AlgoView, VenueError> {
    // With always on, pdd runs it (and it keeps running with the app quit).
    if let Some(link) = daemon.route().await? {
        return daemon::forward(&link, Call::AlgoStart { spec }).await;
    }
    engine
        .algos()
        .start(spec, origin.unwrap_or(Origin::App))
        .await
}

/// The algos running, newest first: pdd's with always on, else this
/// session's (and this session's too, should any have run here).
#[tauri::command]
pub async fn algos(
    engine: State<'_, Engine>,
    daemon: State<'_, DaemonLink>,
) -> Result<Vec<AlgoView>, VenueError> {
    let mut list = engine.algos().list();
    if let Some(link) = daemon.route().await.ok().flatten() {
        list.extend(daemon::forward::<Vec<AlgoView>>(&link, Call::AlgoList).await?);
    }
    Ok(list)
}

/// Algos that are over, from the log (shared with pdd), newest first.
#[tauri::command]
pub fn algo_history(engine: State<'_, Engine>, limit: Option<usize>) -> Vec<AlgoView> {
    engine.algos().history(limit.unwrap_or(50).min(HISTORY_MAX))
}

/// `id` steered here if it's this session's, else in pdd's engine.
async fn steer(
    engine: &Engine,
    daemon: &DaemonLink,
    id: String,
    here: impl FnOnce(&Engine, &str) -> Result<(), VenueError>,
    there: impl FnOnce(String) -> Call,
) -> Result<(), VenueError> {
    if engine.algos().list().iter().any(|a| a.id == id) {
        return here(engine, &id);
    }
    match daemon.route().await? {
        Some(link) => daemon::forward(&link, there(id)).await,
        None => here(engine, &id),
    }
}

#[tauri::command]
pub async fn pause_algo(
    engine: State<'_, Engine>,
    daemon: State<'_, DaemonLink>,
    id: String,
) -> Result<(), VenueError> {
    steer(
        &engine,
        &daemon,
        id,
        |e, id| e.algos().pause(id),
        |id| Call::AlgoPause { id },
    )
    .await
}

#[tauri::command]
pub async fn resume_algo(
    engine: State<'_, Engine>,
    daemon: State<'_, DaemonLink>,
    id: String,
) -> Result<(), VenueError> {
    steer(
        &engine,
        &daemon,
        id,
        |e, id| e.algos().resume(id),
        |id| Call::AlgoResume { id },
    )
    .await
}

/// Stops an algo: cancels what it has open, and with `finishAtMarket`
/// sends the rest at market.
#[tauri::command]
pub async fn stop_algo(
    engine: State<'_, Engine>,
    daemon: State<'_, DaemonLink>,
    id: String,
    mode: StopMode,
) -> Result<(), VenueError> {
    steer(
        &engine,
        &daemon,
        id,
        |e, id| e.algos().stop(id, mode),
        |id| Call::AlgoStop { id, mode },
    )
    .await
}

/// Stops every algo and cancels everything they placed - here, and in pdd
/// when it's there; how many it stopped.
#[tauri::command]
pub async fn halt_algos(
    engine: State<'_, Engine>,
    daemon: State<'_, DaemonLink>,
) -> Result<usize, ()> {
    let mut stopped = engine.algos().halt();
    if let Some(link) = daemon.route_cancel().await {
        if let Ok(halted) =
            daemon::forward::<pewterdesk_protocol::rpc::Halted>(&link, Call::Halt).await
        {
            stopped += halted.stopped;
        }
    }
    Ok(stopped)
}
