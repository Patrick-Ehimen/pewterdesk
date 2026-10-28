//! Connecting a BloFin Demo Trading account: onboarding takes an API key,
//! secret and passphrase the user made in BloFin's Demo Trading, asks BloFin
//! about that key, and stores it in the OS keychain only if it can trade.
//!
//! Security invariants - review any change here against
//! `.claude/commands/security-review.md`:
//! - The secret and passphrase (optional: a key can be made without one)
//!   cross IPC once, into `connect_blofin_key`,
//!   and are wrapped in `Zeroizing` on arrival. Nothing returns them, or the
//!   API key: the commands answer with the account's UID only.
//! - Only Demo Trading keys are stored. BloFin's API can't say whether a
//!   live key has its Transfer permission on (`/api/v1/user/query-apikey`
//!   says only whether it's read-only), so a live key can't be shown to be
//!   trade-only and is refused before it's sent anywhere
//!   (docs/adr/0001-venues-in-rust.md, point 5). A demo key reaches demo
//!   funds only, on Demo Trading's host, where live keys don't authenticate.
//!   There is no live-trading switch for BloFin, and the router refuses a
//!   live BloFin account.
//! - A demo key is stored only once BloFin has answered for it, signed with
//!   it: its UID, that it isn't read-only and that it's an ordinary trading
//!   key.
//! - Errors are fixed strings or BloFin's own messages, never built from
//!   the key, secret or passphrase.

use pewterdesk_core::{KeyError, KeySource, VenueError};
use pewterdesk_exchange_blofin::auth::{self, ApiCredentials};
use pewterdesk_exchange_blofin::KeyCheck;
use serde::Serialize;
use tauri::State;
use zeroize::Zeroizing;

use crate::keychain::{self, KeychainKeySource};
use crate::venues::Venues;

/// A connected BloFin key, as the UI shows it. No key material.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BlofinKeyInfo {
    /// The BloFin account the key belongs to: `demo:` and its UID.
    pub uid: String,
    /// Always true: only Demo Trading accounts connect.
    pub demo: bool,
    /// Whether BloFin answered just now; offline, only `uid` is known.
    pub checked: bool,
    pub ip_restricted: bool,
    /// The account is in Hedge Mode, where pewterdesk places nothing (BloFin
    /// would ignore reduce-only) until it's switched to One-way Mode.
    pub hedge_mode: bool,
    /// Set when the stored key no longer passes the check: BloFin's answer,
    /// said plainly.
    pub problem: Option<String>,
}

impl BlofinKeyInfo {
    fn from_check(check: KeyCheck) -> Self {
        Self {
            uid: auth::account_id(&check.key.uid, true),
            demo: true,
            checked: true,
            ip_restricted: check.key.ip_restricted,
            hedge_mode: check.hedge_mode,
            problem: None,
        }
    }

    fn unchecked(uid: String, problem: Option<String>) -> Self {
        Self {
            uid,
            demo: true,
            checked: false,
            ip_restricted: false,
            hedge_mode: false,
            problem,
        }
    }
}

/// The keychain entry `uid`'s key lives under, the same one the adapter
/// reads it from.
fn key_account(uid: &str) -> Result<String, VenueError> {
    auth::key_account(uid.trim())
}

/// The stored key for `uid`, or `None` if there's none.
async fn stored(uid: &str) -> Result<Option<ApiCredentials>, VenueError> {
    match KeychainKeySource.key(&key_account(uid)?).await {
        Ok(stored) => Ok(Some(ApiCredentials::from_stored(&stored)?)),
        Err(KeyError::NotFound) => Ok(None),
        Err(e) => Err(VenueError::Key(e)),
    }
}

/// Checks a pasted BloFin Demo Trading key with BloFin and stores it if it
/// can trade. `demo` must be true: a live key is refused before it's sent.
#[tauri::command]
pub async fn connect_blofin_key(
    venues: State<'_, Venues>,
    api_key: String,
    api_secret: String,
    passphrase: String,
    demo: bool,
) -> Result<BlofinKeyInfo, VenueError> {
    let creds = ApiCredentials::new(
        &api_key,
        Zeroizing::new(api_secret),
        Zeroizing::new(passphrase),
    )?;
    let check = venues.blofin().check_key(&creds, demo).await?;
    let id = auth::account_id(&check.key.uid, true);
    keychain::store_key(key_account(&id)?, creds.to_stored())
        .await
        .map_err(|e| VenueError::Key(e.into()))?;
    Ok(BlofinKeyInfo::from_check(check))
}

/// The stored key for `uid`, checked again with BloFin, or `None` if none
/// is stored. Offline, the UID still shows.
#[tauri::command]
pub async fn blofin_key_status(
    venues: State<'_, Venues>,
    uid: String,
) -> Result<Option<BlofinKeyInfo>, VenueError> {
    let uid = uid.trim().to_owned();
    let (demo, bare) = auth::parse_account(&uid)?;
    let bare = bare.to_owned();
    let Some(creds) = stored(&uid).await? else {
        return Ok(None);
    };
    Ok(Some(match venues.blofin().check_key(&creds, demo).await {
        Ok(check) if check.key.uid == bare => BlofinKeyInfo::from_check(check),
        Ok(_) => BlofinKeyInfo::unchecked(
            uid,
            Some("the stored key belongs to a different BloFin account".into()),
        ),
        Err(VenueError::Network(_)) => BlofinKeyInfo::unchecked(uid, None),
        Err(VenueError::InvalidRequest(m)) => BlofinKeyInfo::unchecked(uid, Some(m)),
        Err(e) => return Err(e),
    }))
}

/// Deletes the stored key. The key itself stays live on BloFin until the
/// user deletes it there.
#[tauri::command]
pub async fn disconnect_blofin_key(uid: String) -> Result<(), VenueError> {
    keychain::delete_key(key_account(&uid)?)
        .await
        .map_err(|e| VenueError::Key(e.into()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn key_accounts_pass_the_keychains_rules() {
        let account = key_account(" demo:20923487 ").unwrap();
        assert_eq!(account, "blofin:demo:20923487");
        assert!(account.len() <= 128);
        assert!(key_account("0x12").is_err());
    }

    #[test]
    fn info_carries_no_key_material() {
        let info = BlofinKeyInfo::unchecked("demo:1".into(), None);
        let json = serde_json::to_value(&info).unwrap();
        let mut fields: Vec<_> = json.as_object().unwrap().keys().cloned().collect();
        fields.sort();
        assert_eq!(
            fields,
            [
                "checked",
                "demo",
                "hedgeMode",
                "ipRestricted",
                "problem",
                "uid"
            ]
        );
    }
}
