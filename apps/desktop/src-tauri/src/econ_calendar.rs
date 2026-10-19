//! The Calendar panel's command, over the shared economic calendar
//! (`pewterdesk_calendar`, which the daemon uses too): the week's releases
//! from Forex Factory's public export, read by one fixed GET and kept an
//! hour. The trading rules' news blackout reads the same copy, through the
//! engine's `Calendar` trait.

use pewterdesk_core::VenueError;
use tauri::State;

pub use pewterdesk_calendar::{iso_time, CalendarEvent, CalendarState};

/// This week's economic calendar, soonest first.
#[tauri::command]
pub async fn economic_calendar(
    state: State<'_, CalendarState>,
) -> Result<Vec<CalendarEvent>, VenueError> {
    state
        .read()
        .await
        .ok_or_else(|| VenueError::Network("the calendar couldn't be read".into()))
}
