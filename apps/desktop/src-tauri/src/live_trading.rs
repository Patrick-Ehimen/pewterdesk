//! Which live Bybit accounts may trade. A demo account trades as soon as
//! it's connected (demo funds); a live one doesn't until the user turns
//! live trading on for it, here. The trading commands ask this before they
//! sign anything (`venues::trading_account`).
//!
//! Security invariants - review any change here against
//! `.claude/commands/security-review.md`:
//! - The switch is kept and checked in Rust: a live order is refused unless
//!   this module says the account is on, whatever the page believes.
//! - Turning it on asks Bybit again what the stored key may do, and refuses
//!   a key that isn't trade-only (`auth::ALLOWED`), belongs to another
//!   account, or can't be checked (offline included): it fails closed.
//! - Only the account's UID is kept, in a small file in the app's config
//!   folder. No key material: keys stay in the keychain.
//! - It guards against an order sent to a live account by mistake. It is
//!   not a defence against the page itself, which can call these commands.

use std::collections::BTreeSet;
use std::path::PathBuf;
use std::sync::Mutex;

use pewterdesk_core::VenueError;
use pewterdesk_exchange_bybit::auth;
use tauri::State;

use crate::bybit_key;
use crate::venues::Venues;

/// The file the switched-on accounts are kept in, in the app's config folder.
pub const FILE: &str = "live-trading.json";

/// A live Bybit account's UID, or an error for anything else (a demo
/// account needs no switch).
fn live_uid(uid: &str) -> Result<String, VenueError> {
    match auth::parse_account(uid.trim())? {
        (false, bare) => Ok(bare.to_owned()),
        (true, _) => Err(VenueError::InvalidRequest(
            "a demo account trades without this switch".into(),
        )),
    }
}

/// The live Bybit accounts (by UID) with trading on.
pub struct LiveTrading {
    on: Mutex<BTreeSet<String>>,
    /// Where they're kept between runs; unset when there's nowhere to.
    path: Option<PathBuf>,
}

impl LiveTrading {
    /// The accounts kept at `path`. A missing or unreadable file is no
    /// accounts: trading stays off until it's turned on again.
    pub fn load(path: Option<PathBuf>) -> Self {
        let on = path
            .as_ref()
            .and_then(|p| std::fs::read(p).ok())
            .and_then(|bytes| serde_json::from_slice::<Vec<String>>(&bytes).ok())
            .unwrap_or_default()
            .into_iter()
            .filter(|uid| live_uid(uid).is_ok_and(|bare| bare == *uid))
            .collect();
        Self {
            on: Mutex::new(on),
            path,
        }
    }

    /// Whether live Bybit account `uid` may trade.
    pub fn is_on(&self, uid: &str) -> bool {
        self.on.lock().unwrap().contains(uid)
    }

    fn list(&self) -> Vec<String> {
        self.on.lock().unwrap().iter().cloned().collect()
    }

    /// Turns `uid` on or off and writes the list. If it can't be written
    /// the change is undone, so what's kept and what's in force agree.
    fn set(&self, uid: &str, on: bool) -> Result<(), VenueError> {
        let mut accounts = self.on.lock().unwrap();
        let changed = if on {
            accounts.insert(uid.to_owned())
        } else {
            accounts.remove(uid)
        };
        if !changed {
            return Ok(());
        }
        let saved = self.path.as_ref().is_some_and(|path| {
            let list: Vec<&String> = accounts.iter().collect();
            path.parent()
                .is_none_or(|dir| std::fs::create_dir_all(dir).is_ok())
                && serde_json::to_vec(&list).is_ok_and(|json| std::fs::write(path, json).is_ok())
        });
        if saved {
            return Ok(());
        }
        if on {
            accounts.remove(uid);
        } else {
            accounts.insert(uid.to_owned());
        }
        Err(VenueError::Network(
            "the setting couldn't be saved; nothing was changed".into(),
        ))
    }

    /// Turns `uid` off when its key is removed. Best effort: without a key
    /// it couldn't trade anyway.
    pub fn forget(&self, uid: &str) {
        if let Ok(bare) = live_uid(uid) {
            let _ = self.set(&bare, false);
        }
    }
}

/// The live Bybit accounts (UIDs) with trading on.
#[tauri::command]
pub fn live_trading_accounts(live: State<'_, LiveTrading>) -> Vec<String> {
    live.list()
}

/// Turns live trading on or off for Bybit account `uid`. Turning it on
/// checks the stored key with Bybit first: it must be this account's and
/// trade-only, or it stays off.
#[tauri::command]
pub async fn set_live_trading(
    venues: State<'_, Venues>,
    live: State<'_, LiveTrading>,
    uid: String,
    on: bool,
) -> Result<(), VenueError> {
    let bare = live_uid(&uid)?;
    if on {
        bybit_key::verify_trade_only(&venues, &bare).await?;
    }
    live.set(&bare, on)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch(name: &str) -> PathBuf {
        let dir =
            std::env::temp_dir().join(format!("pewterdesk-live-{}-{name}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        dir.join("nested").join(FILE)
    }

    #[test]
    fn stays_off_until_turned_on_and_remembers() {
        let path = scratch("remembers");
        let live = LiveTrading::load(Some(path.clone()));
        assert!(!live.is_on("24617703"));
        live.set("24617703", true).unwrap();
        assert!(live.is_on("24617703"));
        // Another run reads the same list.
        let again = LiveTrading::load(Some(path.clone()));
        assert_eq!(again.list(), ["24617703"]);
        again.forget("24617703");
        assert!(LiveTrading::load(Some(path.clone())).list().is_empty());
        let _ = std::fs::remove_dir_all(path.parent().unwrap().parent().unwrap());
    }

    #[test]
    fn nothing_is_on_when_it_cant_be_kept() {
        let live = LiveTrading::load(None);
        assert!(live.set("24617703", true).is_err());
        assert!(!live.is_on("24617703"));
    }

    #[test]
    fn reads_only_live_uids_from_the_file() {
        let path = scratch("reads");
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(&path, br#"["24617703","demo:1","0xabc"," 5 ","77"]"#).unwrap();
        assert_eq!(
            LiveTrading::load(Some(path.clone())).list(),
            ["24617703", "77"]
        );
        std::fs::write(&path, b"not json").unwrap();
        assert!(LiveTrading::load(Some(path.clone())).list().is_empty());
        let _ = std::fs::remove_dir_all(path.parent().unwrap().parent().unwrap());
    }

    #[test]
    fn the_switch_is_for_live_accounts_only() {
        assert_eq!(live_uid(" 24617703 ").unwrap(), "24617703");
        assert!(live_uid("demo:24617703").is_err());
        assert!(live_uid("0x12").is_err());
    }
}
