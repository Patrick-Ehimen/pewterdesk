//! The Backtest page's commands: a strategy run on a market's history
//! between two dates, and the optimizer that runs it over a grid of its
//! settings. Both only read candles (recorded ones, and the venue's public
//! history) and compute; nothing here reaches the router, an account or a
//! key, so they always run on the app's own engine.

use pewterdesk_core::VenueError;
use pewterdesk_engine::Engine;
use pewterdesk_strategy::lab::{Cell, LabRun, Sweep};
use pewterdesk_strategy::sim::RunResult;
use tauri::State;

#[tauri::command]
pub async fn backtest_run(engine: State<'_, Engine>, run: LabRun) -> Result<RunResult, VenueError> {
    engine.bots().backtest_between(&run).await
}

#[tauri::command]
pub async fn backtest_optimize(
    engine: State<'_, Engine>,
    run: LabRun,
    sweep: Sweep,
) -> Result<Vec<Cell>, VenueError> {
    engine.bots().optimize(&run, &sweep).await
}
