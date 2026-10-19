//! Exchange-agnostic contracts: the domain types, the `ExchangeAdapter` trait
//! every venue crate implements, the `KeySource` they get keys through, and
//! how accounts and their keychain entries are named (`accounts`).
//! Venue crates depend on this one, never the other way around.

pub mod accounts;
mod adapter;
mod algo;
mod domain;
mod keys;

pub use adapter::{ExchangeAdapter, VenueError};
pub use algo::*;
pub use domain::*;
pub use keys::{KeyError, KeySource};
