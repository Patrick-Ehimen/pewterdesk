//! Connecting a Bybit account: onboarding takes an API key and secret the
//! user made on Bybit, asks Bybit what that key may do, and stores it in the
//! OS keychain only if it can trade contracts and nothing else.
//!
//! Security invariants - review any change here against
//! `.claude/commands/security-review.md`:
//! - The secret crosses IPC once, into `connect_bybit_key`, and is wrapped in
//!   `Zeroizing` on arrival. Nothing returns it, or the API key: the commands
//!   answer with the account's UID and the key's permissions only.
//! - A key is stored only once Bybit has answered for it, signed with it.
//!   A live key must also hold only permissions on the trade-only allowlist
//!   (`auth::ALLOWED`): one that can withdraw, transfer or trade spot is
//!   refused, so a stored live key can never move funds
//!   (docs/adr/0001-venues-in-rust.md, point 5). A Demo Trading key skips
//!   the allowlist: it reaches only demo funds, and is checked on the demo
//!   host, where live keys don't authenticate.
//! - The status check asks again each time, so a key whose permissions were
//!   widened on Bybit after connecting is reported, not trusted.
//! - Errors are fixed strings or Bybit's own messages, never built from the
//!   key or secret.

use pewterdesk_core::{KeyError, KeySource, VenueError};
use pewterdesk_exchange_bybit::auth::{
    self, check_trade_only, ApiCredentials, ApiKeyInfo, TradeOnlyKey,
};
use serde::Serialize;
use tauri::State;
use zeroize::Zeroizing;

use crate::keychain::{self, KeychainKeySource};
use crate::live_trading::LiveTrading;
use crate::venues::Venues;

/// A connected Bybit key, as the UI shows it. No key material.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BybitKeyInfo {
    /// The Bybit account the key belongs to: its UID, or `demo:` and the
    /// UID for a demo account.
    pub uid: String,
    /// A Demo Trading account: demo funds, on Bybit's demo host.
    pub demo: bool,
    /// Whether Bybit answered just now; offline, only `uid` is known.
    pub checked: bool,
    pub read_only: bool,
    pub sub_account: bool,
    pub ip_restricted: bool,
    /// When the key lapses (ISO 8601), if it does.
    pub expires_at: Option<String>,
    /// What it may do, as `Group.Permission`.
    pub permissions: Vec<String>,
    /// Set when a stored key no longer passes the check (its permissions
    /// were widened on Bybit): Bybit's answer, said plainly.
    pub problem: Option<String>,
}

impl BybitKeyInfo {
    fn from_key(key: TradeOnlyKey, demo: bool) -> Self {
        Self {
            uid: auth::account_id(key.uid, demo),
            demo,
            checked: true,
            read_only: key.read_only,
            sub_account: key.sub_account,
            ip_restricted: key.ip_restricted,
            expires_at: key.expires_at,
            permissions: key.permissions,
            problem: None,
        }
    }

    fn unchecked(uid: String, demo: bool, problem: Option<String>) -> Self {
        Self {
            uid,
            demo,
            checked: false,
            read_only: false,
            sub_account: false,
            ip_restricted: false,
            expires_at: None,
            permissions: Vec::new(),
            problem,
        }
    }
}

/// The keychain entry `uid`'s key lives under, the same one the adapter
/// reads it from for account data.
fn key_account(uid: &str) -> Result<String, VenueError> {
    auth::key_account(uid.trim())
}

/// A live key must be trade-only; a demo key is taken with any permissions.
/// A demo key only reaches demo funds, and only on the demo host - where a
/// live key doesn't authenticate, so choosing "demo" can't let a live key
/// past the check: Bybit has already answered for this key on that host.
fn trade_key(info: &ApiKeyInfo, demo: bool) -> Result<TradeOnlyKey, VenueError> {
    if demo {
        Ok(auth::describe(info))
    } else {
        check_trade_only(info)
    }
}

/// Checks a pasted Bybit API key with Bybit and stores it if it's trade-only.
/// `demo` is a key made in Bybit's Demo Trading, checked (and later used)
/// on the demo host; the same trade-only rule applies to it.
#[tauri::command]
pub async fn connect_bybit_key(
    venues: State<'_, Venues>,
    api_key: String,
    api_secret: String,
    demo: bool,
) -> Result<BybitKeyInfo, VenueError> {
    let creds = ApiCredentials::new(&api_key, Zeroizing::new(api_secret))?;
    let info = venues.bybit().api_key_info(&creds, demo).await?;
    let key = trade_key(&info, demo)?;
    let id = auth::account_id(key.uid, demo);
    keychain::store_key(key_account(&id)?, creds.to_stored())
        .await
        .map_err(|e| VenueError::Key(e.into()))?;
    Ok(BybitKeyInfo::from_key(key, demo))
}

/// The stored key for `uid`, checked again with Bybit, or `None` if none is
/// stored. Offline, the UID still shows.
#[tauri::command]
pub async fn bybit_key_status(
    venues: State<'_, Venues>,
    uid: String,
) -> Result<Option<BybitKeyInfo>, VenueError> {
    let uid = uid.trim().to_owned();
    let (demo, bare) = auth::parse_account(&uid)?;
    let bare = bare.to_owned();
    let creds = match KeychainKeySource.key(&key_account(&uid)?).await {
        Ok(stored) => ApiCredentials::from_stored(&stored)?,
        Err(KeyError::NotFound) => return Ok(None),
        Err(e) => return Err(VenueError::Key(e)),
    };
    let info = match venues.bybit().api_key_info(&creds, demo).await {
        Ok(info) => info,
        // Offline or rate limited: say nothing about the key either way.
        Err(VenueError::Network(_)) => return Ok(Some(BybitKeyInfo::unchecked(uid, demo, None))),
        // Bybit refused the key (revoked, IP, clock): report it.
        Err(VenueError::InvalidRequest(m)) => {
            return Ok(Some(BybitKeyInfo::unchecked(uid, demo, Some(m))))
        }
        Err(e) => return Err(e),
    };
    Ok(Some(match trade_key(&info, demo) {
        Ok(key) if key.uid.to_string() == bare => BybitKeyInfo::from_key(key, demo),
        Ok(_) => BybitKeyInfo::unchecked(
            uid,
            demo,
            Some("the stored key belongs to a different Bybit account".into()),
        ),
        Err(VenueError::InvalidRequest(m)) => BybitKeyInfo::unchecked(uid, demo, Some(m)),
        Err(e) => return Err(e),
    }))
}

/// Checks that the key stored for live account `uid` is still that
/// account's and still trade-only, by asking Bybit now. Any other answer,
/// no answer included, is an error: this is asked before live trading is
/// turned on, and it fails closed.
pub(crate) async fn verify_trade_only(venues: &Venues, uid: &str) -> Result<(), VenueError> {
    let creds = match KeychainKeySource.key(&key_account(uid)?).await {
        Ok(stored) => ApiCredentials::from_stored(&stored)?,
        Err(KeyError::NotFound) => {
            return Err(VenueError::InvalidRequest(
                "no API key is stored for this account".into(),
            ))
        }
        Err(e) => return Err(VenueError::Key(e)),
    };
    let info = venues.bybit().api_key_info(&creds, false).await?;
    let key = check_trade_only(&info)?;
    if key.uid.to_string() != uid {
        return Err(VenueError::InvalidRequest(
            "the stored key belongs to a different Bybit account".into(),
        ));
    }
    Ok(())
}

/// Deletes the stored key, and turns live trading off for the account. The
/// key itself stays live on Bybit until the user deletes it there.
#[tauri::command]
pub async fn disconnect_bybit_key(
    live: State<'_, LiveTrading>,
    uid: String,
) -> Result<(), VenueError> {
    live.forget(&uid);
    keychain::delete_key(key_account(&uid)?)
        .await
        .map_err(|e| VenueError::Key(e.into()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn key_accounts_pass_the_keychains_rules() {
        let account = key_account(" 24617703 ").unwrap();
        assert_eq!(account, "bybit:24617703");
        assert_eq!(key_account("demo:24617703").unwrap(), "bybit:demo:24617703");
        assert!(account.len() <= 128);
        assert!(key_account("0x12").is_err());
    }

    #[test]
    fn only_live_keys_must_be_trade_only() {
        let info: ApiKeyInfo = serde_json::from_value(serde_json::json!({
            "readOnly": 0,
            "permissions": { "ContractTrade": ["Order"], "Wallet": ["AccountTransfer"] },
            "ips": ["*"], "expiredAt": "", "userID": 7, "isMaster": true
        }))
        .unwrap();
        assert!(trade_key(&info, false).is_err());
        let demo = trade_key(&info, true).unwrap();
        assert_eq!(demo.uid, 7);
        assert!(demo
            .permissions
            .contains(&"Wallet.AccountTransfer".to_string()));
    }

    #[test]
    fn info_carries_no_key_material() {
        let info = BybitKeyInfo::unchecked("1".into(), false, None);
        let json = serde_json::to_value(&info).unwrap();
        let mut fields: Vec<_> = json.as_object().unwrap().keys().cloned().collect();
        fields.sort();
        assert_eq!(
            fields,
            [
                "checked",
                "demo",
                "expiresAt",
                "ipRestricted",
                "permissions",
                "problem",
                "readOnly",
                "subAccount",
                "uid"
            ]
        );
    }
}
