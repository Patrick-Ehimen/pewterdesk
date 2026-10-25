//! Connecting a Binance account: onboarding takes an API key and secret the
//! user made on Binance (or in its Demo Trading), asks Binance what that key
//! may do, and stores it in the OS keychain only if it can trade futures and
//! nothing else.
//!
//! Security invariants - review any change here against
//! `.claude/commands/security-review.md`:
//! - The secret crosses IPC once, into `connect_binance_key`, and is wrapped
//!   in `Zeroizing` on arrival. Nothing returns it, or the API key: the
//!   commands answer with the account's UID and the key's permissions only.
//! - A key is stored only once Binance has answered for it, signed with it:
//!   its UID (`/api/v3/account`) and that it reaches the futures account. A
//!   live key must also have on only what's on the trade-only allowlist
//!   (`auth::ALLOWED`, read from `/sapi/v1/account/apiRestrictions`): one
//!   that can withdraw, transfer or trade spot, margin or options is
//!   refused, so a stored live key can never move funds
//!   (docs/adr/0001-venues-in-rust.md, point 5). A Demo Trading key skips
//!   the allowlist: it reaches only demo funds, and is checked on the demo
//!   hosts, where live keys don't authenticate.
//! - The status check asks again each time, so a key whose permissions were
//!   widened on Binance after connecting is reported, not trusted.
//! - Errors are fixed strings or Binance's own messages, never built from
//!   the key or secret.

use pewterdesk_core::{KeyError, KeySource, VenueError};
use pewterdesk_engine::Engine;
use pewterdesk_exchange_binance::auth::{self, ApiCredentials};
use pewterdesk_exchange_binance::KeyCheck;
use serde::Serialize;
use tauri::State;
use zeroize::Zeroizing;

use crate::keychain::{self, KeychainKeySource};
use crate::venues::Venues;

/// A connected Binance key, as the UI shows it. No key material.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BinanceKeyInfo {
    /// The Binance account the key belongs to: its UID, or `demo:` and the
    /// UID for a Demo Trading account.
    pub uid: String,
    /// A Demo Trading account: demo funds, on Binance's demo host.
    pub demo: bool,
    /// Whether Binance answered just now; offline, only `uid` is known.
    pub checked: bool,
    pub ip_restricted: bool,
    /// The futures account is in Hedge Mode, which pewterdesk's orders
    /// don't use: they're refused until it's switched to One-way Mode.
    pub hedge_mode: bool,
    /// What it has on, by Binance's name (`enableFutures`). Empty for a
    /// Demo Trading key, whose restrictions Binance doesn't serve.
    pub permissions: Vec<String>,
    /// Set when a stored key no longer passes the check (its permissions
    /// were widened on Binance): Binance's answer, said plainly.
    pub problem: Option<String>,
}

impl BinanceKeyInfo {
    fn from_check(check: KeyCheck, demo: bool) -> Self {
        Self {
            uid: auth::account_id(check.key.uid, demo),
            demo,
            checked: true,
            ip_restricted: check.key.ip_restricted,
            hedge_mode: check.hedge_mode,
            permissions: check.key.permissions,
            problem: None,
        }
    }

    fn unchecked(uid: String, demo: bool, problem: Option<String>) -> Self {
        Self {
            uid,
            demo,
            checked: false,
            ip_restricted: false,
            hedge_mode: false,
            permissions: Vec::new(),
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

/// Checks a pasted Binance API key with Binance and stores it if it's
/// trade-only. `demo` is a key made in Binance's Demo Trading, checked (and
/// later used) on the demo hosts.
#[tauri::command]
pub async fn connect_binance_key(
    venues: State<'_, Venues>,
    api_key: String,
    api_secret: String,
    demo: bool,
) -> Result<BinanceKeyInfo, VenueError> {
    let creds = ApiCredentials::new(&api_key, Zeroizing::new(api_secret))?;
    let check = venues.binance().check_key(&creds, demo).await?;
    let id = auth::account_id(check.key.uid, demo);
    keychain::store_key(key_account(&id)?, creds.to_stored())
        .await
        .map_err(|e| VenueError::Key(e.into()))?;
    Ok(BinanceKeyInfo::from_check(check, demo))
}

/// The stored key for `uid`, checked again with Binance, or `None` if none
/// is stored. Offline, the UID still shows.
#[tauri::command]
pub async fn binance_key_status(
    venues: State<'_, Venues>,
    uid: String,
) -> Result<Option<BinanceKeyInfo>, VenueError> {
    let uid = uid.trim().to_owned();
    let (demo, bare) = auth::parse_account(&uid)?;
    let bare = bare.to_owned();
    let Some(creds) = stored(&uid).await? else {
        return Ok(None);
    };
    Ok(Some(match venues.binance().check_key(&creds, demo).await {
        Ok(check) if check.key.uid.to_string() == bare => BinanceKeyInfo::from_check(check, demo),
        Ok(_) => BinanceKeyInfo::unchecked(
            uid,
            demo,
            Some("the stored key belongs to a different Binance account".into()),
        ),
        // Offline or rate limited: say nothing about the key either way.
        Err(VenueError::Network(_)) => BinanceKeyInfo::unchecked(uid, demo, None),
        // Binance refused the key, or it's no longer trade-only: report it.
        Err(VenueError::InvalidRequest(m)) => BinanceKeyInfo::unchecked(uid, demo, Some(m)),
        Err(e) => return Err(e),
    }))
}

/// Checks that the key stored for live account `uid` is still that
/// account's and still trade-only, by asking Binance now. Any other answer,
/// no answer included, is an error: this is asked before live trading is
/// turned on, and it fails closed.
pub(crate) async fn verify_trade_only(venues: &Venues, uid: &str) -> Result<(), VenueError> {
    let Some(creds) = stored(uid).await? else {
        return Err(VenueError::InvalidRequest(
            "no API key is stored for this account".into(),
        ));
    };
    let check = venues.binance().check_key(&creds, false).await?;
    if check.key.uid.to_string() != uid {
        return Err(VenueError::InvalidRequest(
            "the stored key belongs to a different Binance account".into(),
        ));
    }
    Ok(())
}

/// Deletes the stored key, and turns live trading off for the account. The
/// key itself stays live on Binance until the user deletes it there.
#[tauri::command]
pub async fn disconnect_binance_key(
    engine: State<'_, Engine>,
    uid: String,
) -> Result<(), VenueError> {
    engine.live().forget_binance(&uid);
    keychain::delete_key(key_account(&uid)?)
        .await
        .map_err(|e| VenueError::Key(e.into()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn key_accounts_pass_the_keychains_rules() {
        let account = key_account(" 354937868 ").unwrap();
        assert_eq!(account, "binance:354937868");
        assert_eq!(
            key_account("demo:354937868").unwrap(),
            "binance:demo:354937868"
        );
        assert!(account.len() <= 128);
        assert!(key_account("0x12").is_err());
    }

    #[test]
    fn info_carries_no_key_material() {
        let info = BinanceKeyInfo::unchecked("1".into(), false, None);
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
                "permissions",
                "problem",
                "uid"
            ]
        );
    }
}
