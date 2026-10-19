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

use crate::econ_calendar::CalendarState;
use crate::venues::Venues;

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
    spec: AlgoSpec,
    origin: Option<Origin>,
) -> Result<AlgoView, VenueError> {
    engine
        .algos()
        .start(spec, origin.unwrap_or(Origin::App))
        .await
}

/// This session's algos, newest first.
#[tauri::command]
pub fn algos(engine: State<'_, Engine>) -> Vec<AlgoView> {
    engine.algos().list()
}

/// Algos that are over, from the log, newest first.
#[tauri::command]
pub fn algo_history(engine: State<'_, Engine>, limit: Option<usize>) -> Vec<AlgoView> {
    engine.algos().history(limit.unwrap_or(50).min(HISTORY_MAX))
}

#[tauri::command]
pub fn pause_algo(engine: State<'_, Engine>, id: String) -> Result<(), VenueError> {
    engine.algos().pause(&id)
}

#[tauri::command]
pub fn resume_algo(engine: State<'_, Engine>, id: String) -> Result<(), VenueError> {
    engine.algos().resume(&id)
}

/// Stops an algo: cancels what it has open, and with `finishAtMarket`
/// sends the rest at market.
#[tauri::command]
pub fn stop_algo(engine: State<'_, Engine>, id: String, mode: StopMode) -> Result<(), VenueError> {
    engine.algos().stop(&id, mode)
}

/// Stops every algo and cancels everything they placed; how many it stopped.
#[tauri::command]
pub fn halt_algos(engine: State<'_, Engine>) -> usize {
    engine.algos().halt()
}
