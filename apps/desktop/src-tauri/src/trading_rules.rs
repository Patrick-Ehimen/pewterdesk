//! The commands that show and set the trader's rules. The rules themselves
//! are the engine's (`pewterdesk_engine::rules`), checked by its router
//! before an order is signed; these only read and edit them for the page.
//!
//! Security-relevant - review any change here against
//! `.claude/commands/security-review.md`: loosening a rule or turning a set
//! off waits for the next 00:00 UTC (the engine enforces it); deleting a set
//! is immediate, behind a confirmation on the page.

use pewterdesk_core::{OrderRequest, VenueError, VenueId};
use pewterdesk_engine::rules::{named, Check, Rules, Status, View};
use pewterdesk_engine::Engine;
use tauri::State;

use crate::econ_calendar::CalendarState;
use crate::venues::Venues;

/// Every account's rules: whether they're on, and any change that's waiting.
#[tauri::command]
pub fn trading_rules(engine: State<'_, Engine>) -> Vec<View> {
    engine.rules().views()
}

/// Saves `account`'s rules, under a name of the trader's. Tightening
/// applies now; a loosening, or turning them off, at the next 00:00 UTC.
#[tauri::command]
pub fn set_trading_rules(
    engine: State<'_, Engine>,
    venue: VenueId,
    account: String,
    name: String,
    on: bool,
    rules: Rules,
) -> Result<Vec<View>, VenueError> {
    engine.rules().set(named(venue, account)?, &name, on, rules)
}

/// Forgets `account`'s rules at once, whether they're on or off.
#[tauri::command]
pub fn delete_trading_rules(
    engine: State<'_, Engine>,
    venue: VenueId,
    account: String,
) -> Result<Vec<View>, VenueError> {
    engine.rules().remove(&named(venue, account)?)
}

/// Where `account` stands against the rules; nothing while they're off or
/// are another account's. Read-only on the venue.
#[tauri::command]
pub async fn trading_rules_status(
    engine: State<'_, Engine>,
    venues: State<'_, Venues>,
    calendar: State<'_, CalendarState>,
    venue: VenueId,
    account: String,
) -> Result<Option<Status>, VenueError> {
    engine
        .rules()
        .status(&*venues, &*calendar, venue, &account)
        .await
}

/// What each rule says about an order before it's sent, for the ticket.
/// Empty while the rules are off, and for an order that only reduces.
#[tauri::command]
pub async fn check_trading_rules(
    engine: State<'_, Engine>,
    venues: State<'_, Venues>,
    calendar: State<'_, CalendarState>,
    venue: VenueId,
    account: String,
    request: OrderRequest,
) -> Result<Vec<Check>, VenueError> {
    engine
        .rules()
        .check(&*venues, &*calendar, venue, &account, &request)
        .await
}
