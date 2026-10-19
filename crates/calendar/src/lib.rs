//! `pewterdesk-calendar`: the week's economic calendar, for the trading
//! rules' news blackout and the Calendar panel - in the app and in the
//! daemon, from one copy of the code - and the text helpers it shares with
//! the app's news feeds.
//!
//! Security-relevant: a data source, not a venue (see `econ`). Changing the
//! source is a security-relevant change.

pub mod econ;
pub mod text;

pub use econ::{iso_time, CalendarEvent, CalendarState, Impact};
