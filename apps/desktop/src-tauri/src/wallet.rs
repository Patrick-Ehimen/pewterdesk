//! Connecting a venue account: onboarding takes the venue's trade-only key
//! (on Hyperliquid, an API/agent wallet the user approved from their main
//! wallet), checks it, and stores it in the OS keychain.
//!
//! Security invariants - review any change here against
//! `.claude/commands/security-review.md`:
//! - The pasted key crosses IPC once, into `connect_wallet`, and is wrapped in
//!   `Zeroizing` on arrival. Nothing returns it: the commands answer with
//!   public addresses only.
//! - A key is stored only once Rust has checked it: it parses, it isn't the
//!   main wallet's own key, and the venue lists it as an approved agent of
//!   that account. A main-wallet key is refused, so a stored key can never
//!   withdraw (docs/adr/0001-venues-in-rust.md, point 5).
//! - Errors are fixed strings or the venue's own messages, never built from
//!   the key.

use std::time::{SystemTime, UNIX_EPOCH};

use pewterdesk_core::{KeySource, VenueError, VenueId};
use pewterdesk_exchange_hyperliquid::agent::{agent_address, ApprovedAgent};
use serde::Serialize;
use tauri::State;
use zeroize::Zeroizing;

use crate::keychain::{self, KeychainKeySource};
use crate::venues::Venues;

/// A connected account, as the UI shows it. Public addresses only.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WalletInfo {
    pub venue: VenueId,
    /// The main account: what positions and balances are read from.
    pub address: String,
    /// The stored trade-only key's address.
    pub agent: String,
    /// The name it was approved under, and until when (ms since the epoch);
    /// unset when the venue couldn't be asked.
    pub agent_name: Option<String>,
    pub valid_until: Option<u64>,
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| d.as_millis() as u64)
}

/// Lowercase `0x` + 40 hex, or an error saying what an address looks like.
fn normalize_address(address: &str) -> Result<String, VenueError> {
    let address = address.trim().to_ascii_lowercase();
    let hex = address.strip_prefix("0x").unwrap_or("");
    if hex.len() == 40 && hex.bytes().all(|b| b.is_ascii_hexdigit()) {
        Ok(address)
    } else {
        Err(VenueError::InvalidRequest(
            "an address is 0x followed by 40 hex characters".into(),
        ))
    }
}

/// The keychain entry a venue account's key lives under.
fn key_account(venue: VenueId, address: &str) -> String {
    match venue {
        VenueId::Hyperliquid => format!("hyperliquid:{address}"),
        VenueId::Aster => format!("aster:{address}"),
    }
}

fn only_hyperliquid(venue: VenueId) -> Result<(), VenueError> {
    match venue {
        VenueId::Hyperliquid => Ok(()),
        VenueId::Aster => Err(VenueError::Unsupported(
            "connecting an Aster account isn't available yet",
        )),
    }
}

/// Whether `agent` may trade for the account: listed, and not lapsed.
fn check_approval(
    agent: &str,
    approved: Vec<ApprovedAgent>,
    now: u64,
) -> Result<ApprovedAgent, VenueError> {
    let found = approved
        .into_iter()
        .find(|a| a.address.eq_ignore_ascii_case(agent))
        .ok_or_else(|| {
            VenueError::InvalidRequest(
                "this API wallet isn't approved for that address on Hyperliquid".into(),
            )
        })?;
    if found.valid_until <= now {
        return Err(VenueError::InvalidRequest(
            "this API wallet's approval has expired; approve it again on Hyperliquid".into(),
        ));
    }
    Ok(found)
}

/// Checks a pasted trade-only key against the account and stores it.
#[tauri::command]
pub async fn connect_wallet(
    venues: State<'_, Venues>,
    venue: VenueId,
    address: String,
    key: String,
) -> Result<WalletInfo, VenueError> {
    let key = Zeroizing::new(key);
    only_hyperliquid(venue)?;
    let address = normalize_address(&address)?;
    let agent = agent_address(&key)?;
    if agent == address {
        return Err(VenueError::InvalidRequest(
            "that's your main wallet's key; paste the API wallet's key instead".into(),
        ));
    }
    let approved = venues.hyperliquid().approved_agents(&address).await?;
    let found = check_approval(&agent, approved, now_ms())?;
    keychain::store_key(key_account(venue, &address), key)
        .await
        .map_err(|e| VenueError::Key(e.into()))?;
    Ok(WalletInfo {
        venue,
        address,
        agent,
        agent_name: Some(found.name),
        valid_until: Some(found.valid_until),
    })
}

/// The connected API wallet for `address`, or `None` if no key is stored.
/// Its approval is looked up when the venue answers; offline, the address
/// still shows.
#[tauri::command]
pub async fn wallet_status(
    venues: State<'_, Venues>,
    venue: VenueId,
    address: String,
) -> Result<Option<WalletInfo>, VenueError> {
    only_hyperliquid(venue)?;
    let address = normalize_address(&address)?;
    let agent = match KeychainKeySource.key(&key_account(venue, &address)).await {
        Ok(key) => agent_address(&key)?,
        Err(pewterdesk_core::KeyError::NotFound) => return Ok(None),
        Err(e) => return Err(VenueError::Key(e)),
    };
    let found = venues
        .hyperliquid()
        .approved_agents(&address)
        .await
        .ok()
        .and_then(|approved| {
            approved
                .into_iter()
                .find(|a| a.address.eq_ignore_ascii_case(&agent))
        });
    Ok(Some(WalletInfo {
        venue,
        address,
        agent,
        agent_name: found.as_ref().map(|a| a.name.clone()),
        valid_until: found.map(|a| a.valid_until),
    }))
}

/// Deletes the stored key. The approval on the venue stays until the user
/// revokes it there.
#[tauri::command]
pub async fn disconnect_wallet(venue: VenueId, address: String) -> Result<(), VenueError> {
    let address = normalize_address(&address)?;
    keychain::delete_key(key_account(venue, &address))
        .await
        .map_err(|e| VenueError::Key(e.into()))
}

#[cfg(test)]
mod tests {
    use super::*;

    const AGENT: &str = "0x2c7536e3605d9c16a7a3d7b1898e529396a65c23";

    fn agent(address: &str, valid_until: u64) -> ApprovedAgent {
        ApprovedAgent {
            name: "pewterdesk".into(),
            address: address.into(),
            valid_until,
        }
    }

    #[test]
    fn normalizes_addresses() {
        let mixed = "  0xAbCdEf0123456789abcdef0123456789ABCDEF01 ";
        assert_eq!(
            normalize_address(mixed).unwrap(),
            "0xabcdef0123456789abcdef0123456789abcdef01"
        );
        for bad in [
            "",
            "0x123",
            "abcdef0123456789abcdef0123456789abcdef01",
            "0xzz",
        ] {
            assert!(normalize_address(bad).is_err(), "{bad:?}");
        }
    }

    #[test]
    fn key_accounts_pass_the_keychains_rules() {
        let account = key_account(VenueId::Hyperliquid, AGENT);
        assert_eq!(account, format!("hyperliquid:{AGENT}"));
        assert!(account.len() <= 128);
    }

    #[test]
    fn approval_must_be_listed_and_current() {
        let upper = AGENT.to_uppercase().replace("0X", "0x");
        let ok = check_approval(AGENT, vec![agent(&upper, 2_000)], 1_000).unwrap();
        assert_eq!(ok.valid_until, 2_000);
        assert!(check_approval(AGENT, vec![], 1_000).is_err());
        let other = "0x0000000000000000000000000000000000000001";
        assert!(check_approval(AGENT, vec![agent(other, 2_000)], 1_000).is_err());
        let expired = check_approval(AGENT, vec![agent(AGENT, 1_000)], 1_000);
        assert!(matches!(expired, Err(VenueError::InvalidRequest(m)) if m.contains("expired")));
    }

    #[test]
    fn aster_waits_for_signing() {
        assert!(matches!(
            only_hyperliquid(VenueId::Aster),
            Err(VenueError::Unsupported(_))
        ));
    }
}
