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
//! - Connecting through a wallet (WalletConnect) generates the agent key here,
//!   in Rust. JS only carries the typed data to the wallet and the signature
//!   back: the approval it signs is built here and kept here, the signature
//!   must recover to the connected main address, and only then is it sent to
//!   the venue and the key stored. JS can't change what gets approved.

use std::sync::Mutex;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use pewterdesk_core::{KeySource, VenueError, VenueId};
use pewterdesk_exchange_hyperliquid::agent::{
    agent_address, generate_agent, ApproveAgent, ApprovedAgent, WalletSignature, AGENT_NAME,
};
use serde::Serialize;
use serde_json::Value;
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
        VenueId::Bybit => format!("bybit:{address}"),
    }
}

fn only_hyperliquid(venue: VenueId) -> Result<(), VenueError> {
    match venue {
        VenueId::Hyperliquid => Ok(()),
        VenueId::Aster => Err(VenueError::Unsupported(
            "connecting an Aster account isn't available yet",
        )),
        VenueId::Bybit => Err(VenueError::Unsupported(
            "connecting a Bybit account isn't available yet",
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

/// An agent approval waiting on the user's wallet. The new key never leaves
/// this struct until the approval is through and it goes to the keychain.
struct Pending {
    venue: VenueId,
    address: String,
    key: Zeroizing<String>,
    approval: ApproveAgent,
    started: Instant,
}

/// The one approval in flight, if any; starting another replaces it.
#[derive(Default)]
pub struct Onboarding(Mutex<Option<Pending>>);

/// How long the wallet has to sign before the approval is dropped.
const PENDING_FOR: Duration = Duration::from_secs(5 * 60);

/// Whether `address` can approve an agent: Hyperliquid refuses accounts
/// that have never deposited, and agents can't approve agents. Checked
/// before asking the wallet to sign, so the user isn't asked for nothing.
fn check_role(role: &str) -> Result<(), VenueError> {
    match role {
        "missing" => Err(VenueError::InvalidRequest(
            "this account hasn't deposited on Hyperliquid yet; deposit at least 5 USDC from Arbitrum, then try again".into(),
        )),
        "agent" => Err(VenueError::InvalidRequest(
            "that address is an API wallet; connect your main wallet instead".into(),
        )),
        _ => Ok(()),
    }
}

/// Starts approving a new agent for `address`: generates its key and
/// returns the typed data for the wallet to sign (`eth_signTypedData_v4`) on
/// `chain_id`, the chain the wallet is connected to. Shared by WalletConnect
/// (through the command) and the browser page (`browser_connect.rs`).
pub async fn begin(
    onboarding: &Onboarding,
    venues: &Venues,
    venue: VenueId,
    address: &str,
    chain_id: u64,
) -> Result<Value, VenueError> {
    only_hyperliquid(venue)?;
    let address = normalize_address(address)?;
    if chain_id == 0 {
        return Err(VenueError::InvalidRequest(
            "the wallet's chain is unknown".into(),
        ));
    }
    check_role(&venues.hyperliquid().user_role(&address).await?)?;
    let (key, agent) = generate_agent();
    let approval = ApproveAgent {
        chain: venues.hyperliquid().chain(),
        signature_chain_id: chain_id,
        agent_address: agent,
        agent_name: AGENT_NAME.into(),
        nonce: now_ms(),
    };
    let typed = approval.typed_data();
    *onboarding.0.lock().unwrap() = Some(Pending {
        venue,
        address,
        key,
        approval,
        started: Instant::now(),
    });
    Ok(typed)
}

/// Finishes the approval with the wallet's signature: checks it's the
/// connected main wallet's, sends it to the venue, and stores the key.
pub async fn finish(
    onboarding: &Onboarding,
    venues: &Venues,
    signature: &str,
) -> Result<WalletInfo, VenueError> {
    let pending =
        onboarding.0.lock().unwrap().take().ok_or_else(|| {
            VenueError::InvalidRequest("no approval is waiting; start again".into())
        })?;
    if pending.started.elapsed() > PENDING_FOR {
        return Err(VenueError::InvalidRequest(
            "the approval took too long; start again".into(),
        ));
    }
    let signature = WalletSignature::parse(signature)?;
    let signer = signature.signer(&pending.approval.signing_hash()?)?;
    if signer != pending.address {
        return Err(VenueError::InvalidRequest(
            "the signature came from a different wallet than the connected one".into(),
        ));
    }
    venues
        .hyperliquid()
        .approve_agent(&pending.approval, &signature)
        .await?;
    let Pending {
        venue,
        address,
        key,
        approval,
        ..
    } = pending;
    keychain::store_key(key_account(venue, &address), key)
        .await
        .map_err(|e| VenueError::Key(e.into()))?;
    Ok(WalletInfo {
        venue,
        address,
        agent: approval.agent_address,
        agent_name: Some(approval.agent_name),
        valid_until: None,
    })
}

/// Drops the approval in flight, if any; its key is zeroed with it.
pub fn cancel(onboarding: &Onboarding) {
    onboarding.0.lock().unwrap().take();
}

#[tauri::command]
pub async fn begin_agent_approval(
    onboarding: State<'_, Onboarding>,
    venues: State<'_, Venues>,
    venue: VenueId,
    address: String,
    chain_id: u64,
) -> Result<Value, VenueError> {
    begin(&onboarding, &venues, venue, &address, chain_id).await
}

#[tauri::command]
pub async fn finish_agent_approval(
    onboarding: State<'_, Onboarding>,
    venues: State<'_, Venues>,
    signature: String,
) -> Result<WalletInfo, VenueError> {
    finish(&onboarding, &venues, &signature).await
}

/// Drops an approval in flight (the user closed the dialog or the wallet
/// refused); its key is zeroed with it.
#[tauri::command]
pub fn cancel_agent_approval(onboarding: State<'_, Onboarding>) {
    cancel(&onboarding);
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
    fn unfunded_accounts_and_agents_cant_approve() {
        assert!(check_role("user").is_ok());
        assert!(check_role("subAccount").is_ok());
        assert!(
            matches!(check_role("missing"), Err(VenueError::InvalidRequest(m)) if m.contains("deposit"))
        );
        assert!(
            matches!(check_role("agent"), Err(VenueError::InvalidRequest(m)) if m.contains("main wallet"))
        );
    }

    #[test]
    fn aster_waits_for_signing() {
        assert!(matches!(
            only_hyperliquid(VenueId::Aster),
            Err(VenueError::Unsupported(_))
        ));
    }
}
