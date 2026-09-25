//! Exchange-agnostic contracts: the domain types, the `ExchangeAdapter` trait
//! every venue crate implements, and the `KeySource` they get keys through.
//! Venue crates depend on this one, never the other way around.

mod adapter;
mod domain;
mod keys;

pub use adapter::{ExchangeAdapter, VenueError};
pub use domain::*;
pub use keys::{KeyError, KeySource};
