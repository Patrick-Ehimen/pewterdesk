//! The engine: everything that decides whether an order is sent, and sends
//! it. Every trading operation goes through its router (`Engine`), which
//! builds the account's key reference, checks the gate - the live-trading
//! switch (`live`) and the trader's own rules (`rules`) - and only then calls
//! the venue's adapter. Nothing else calls an adapter's trading methods.
//!
//! Security-relevant - review any change against
//! `.claude/commands/security-review.md` and `docs/bots/safety.md`:
//! - The six operations of `ExchangeAdapter` (place, cancel and amend orders,
//!   a position's protection, leverage, margin mode) are the whole surface.
//!   Nothing here withdraws, transfers, approves a key or signs anything the
//!   caller supplies; the adapters do the signing.
//! - Every order passes the gate, whoever sent it. It only ever refuses, and
//!   fails closed.
//! - No key material: the engine names an account's keychain entry, and the
//!   adapter reads the key through its `KeySource` for the signing call.
//!
//! The engine is a library with no runtime of its own: the host (the desktop
//! app, later the daemon) owns the adapters and the calendar and lends them
//! through `Adapters` and `Calendar`.

use async_trait::async_trait;
use pewterdesk_core::{ExchangeAdapter, VenueError, VenueId};
use serde::Serialize;

pub mod live;
mod router;
pub mod rules;

pub use pewterdesk_store::EventLog;
pub use router::{client_id, trading_account, Engine};

/// Each venue's adapter, as the host has set it up.
pub trait Adapters: Send + Sync {
    fn adapter(&self, venue: VenueId) -> Result<&dyn ExchangeAdapter, VenueError>;
}

/// How much a release is expected to move markets.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Impact {
    High,
    Medium,
    Low,
    /// A bank holiday: markets thin, nothing released.
    Holiday,
}

/// One scheduled release on the economic calendar.
#[derive(Clone, Debug, PartialEq)]
pub struct CalendarEvent {
    pub title: String,
    /// The currency it's about ("USD"), or "All" for one that touches every one.
    pub currency: String,
    /// When, in milliseconds since the Unix epoch.
    pub time: u64,
    pub impact: Impact,
}

/// The economic calendar, for the trading rules' news blackout.
#[async_trait]
pub trait Calendar: Send + Sync {
    /// This week's releases as last read, at once: never waiting on the
    /// network once the calendar has been read. `None` only until it has
    /// been read once (the blackout then fails closed).
    async fn kept(&self) -> Option<Vec<CalendarEvent>>;
}
