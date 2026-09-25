//! How a venue crate gets at key material without owning key storage.
//!
//! core owns the trait; the app owns the implementation (the desktop app backs
//! it with the OS keychain). Venue crates receive a `KeySource`, they never
//! construct one — the same direction as `SecretStore` on the TS side.

use async_trait::async_trait;
use serde::Serialize;
use ts_rs::TS;
use zeroize::Zeroizing;

/// Details are `&'static str` so a formatted string — which might embed key
/// material from a backend error — can't be passed through.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, TS, thiserror::Error)]
#[serde(tag = "kind", content = "detail", rename_all = "camelCase")]
#[ts(export, export_to = "domain.ts")]
pub enum KeyError {
    #[error("no key stored for this account")]
    NotFound,
    #[error("{0}")]
    Backend(&'static str),
}

#[async_trait]
pub trait KeySource: Send + Sync {
    /// The trade-only key stored under `account`. It is zeroed when dropped,
    /// so hold it only for the signing call that needs it.
    async fn key(&self, account: &str) -> Result<Zeroizing<String>, KeyError>;
}
