//! Which live accounts may trade. A Bybit demo account, or a Binance Demo
//! Trading one, trades as soon as it's connected (demo funds); a live Bybit
//! or Binance account, and a Hyperliquid or Aster account (always real
//! funds), doesn't until the user turns live trading on for it, here. The trading commands ask this before they sign
//! anything (the router's `trading_account`).
//!
//! Security invariants - review any change here against
//! `.claude/commands/security-review.md`:
//! - The switch is kept and checked in Rust: a live order is refused unless
//!   this module says the account is on, whatever the page believes.
//! - Turning it on asks the venue again what the stored key may do, and
//!   refuses a key that isn't trade-only (Bybit's and Binance's
//!   `auth::ALLOWED`; on Hyperliquid and Aster, an API wallet still approved for that account,
//!   which on Aster can't withdraw), belongs to another account, or can't
//!   be checked (offline included): it fails closed.
//! - Only the account's id is kept (a Bybit UID, `binance:` and a Binance
//!   UID, or the venue and the main wallet's public address), in a small file in the app's config folder.
//!   No key material: keys stay in the keychain.
//! - It guards against an order sent to a live account by mistake. It is
//!   not a defence against the page itself, which can call these commands.

use std::collections::BTreeSet;
use std::path::PathBuf;
use std::sync::{Mutex, MutexGuard};

use pewterdesk_core::accounts::{binance_account, bybit_account, normalize_address};

use crate::kept::{Change, Kept};
use pewterdesk_core::{VenueError, VenueId};

/// The file the switched-on accounts are kept in, in the app's config folder.
pub const FILE: &str = "live-trading.json";

/// A live Bybit account's UID, or an error for anything else (a demo
/// account needs no switch).
pub fn live_uid(uid: &str) -> Result<String, VenueError> {
    match bybit_account(uid.trim())? {
        (false, bare) => Ok(bare.to_owned()),
        (true, _) => Err(VenueError::InvalidRequest(
            "a demo account trades without this switch".into(),
        )),
    }
}

/// How a live Binance account is kept in the list: `binance:` and its UID,
/// so it can't be mistaken for a Bybit UID (also digits). An error for a
/// Demo Trading account, which needs no switch.
pub fn binance_id(uid: &str) -> Result<String, VenueError> {
    match binance_account(uid.trim())? {
        (false, bare) => Ok(format!("binance:{bare}")),
        (true, _) => Err(VenueError::InvalidRequest(
            "a Demo Trading account trades without this switch".into(),
        )),
    }
}

/// How a Hyperliquid or Aster account is kept in the list: its venue, then
/// its main wallet's address (lowercase). Bybit accounts are bare UIDs,
/// which are all digits, so the two can't be mistaken for each other.
pub fn wallet_id(venue: VenueId, address: &str) -> Result<String, VenueError> {
    let address = normalize_address(address)?;
    match venue {
        VenueId::Hyperliquid => Ok(format!("hyperliquid:{address}")),
        VenueId::Aster => Ok(format!("aster:{address}")),
        VenueId::Bybit => Err(VenueError::InvalidRequest(
            "a Bybit account is switched by its UID".into(),
        )),
        VenueId::Binance => Err(VenueError::InvalidRequest(
            "a Binance account is switched by its UID".into(),
        )),
    }
}

/// Whether `id` is one this module writes: a live Bybit UID, a live
/// Binance id or a wallet id.
fn known_id(id: &str) -> bool {
    if live_uid(id).is_ok_and(|bare| bare == id) {
        return true;
    }
    if id
        .strip_prefix("binance:")
        .and_then(|uid| binance_id(uid).ok())
        .is_some_and(|whole| whole == id)
    {
        return true;
    }
    [VenueId::Hyperliquid, VenueId::Aster]
        .into_iter()
        .any(|venue| {
            id.split_once(':')
                .and_then(|(_, address)| wallet_id(venue, address).ok())
                .is_some_and(|whole| whole == id)
        })
}

/// The live accounts with trading on: Bybit UIDs, Binance ids and wallet ids.
pub struct LiveTrading {
    on: Mutex<BTreeSet<String>>,
    /// Where they're kept between runs, which another engine (the app's, or
    /// the daemon's) may change: read again whenever it has.
    file: Kept,
}

/// The accounts a kept list names. Unreadable is none: trading stays off
/// until it's turned on again.
fn accounts_in(bytes: Option<&[u8]>) -> BTreeSet<String> {
    bytes
        .and_then(|bytes| serde_json::from_slice::<Vec<String>>(bytes).ok())
        .unwrap_or_default()
        .into_iter()
        .filter(|id| known_id(id))
        .collect()
}

impl LiveTrading {
    /// The accounts kept at `path`. A missing or unreadable file is no
    /// accounts: trading stays off until it's turned on again.
    pub fn load(path: Option<PathBuf>) -> Self {
        let file = Kept::new(path);
        let on = accounts_in(file.read().as_deref());
        Self {
            on: Mutex::new(on),
            file,
        }
    }

    /// The accounts as they are now: the file read again if another engine
    /// has changed it. Gone or unreadable is none (it fails closed).
    fn current(&self) -> MutexGuard<'_, BTreeSet<String>> {
        let mut on = self.on.lock().unwrap();
        match self.file.changed() {
            Change::Same => {}
            Change::Gone => {
                on.clear();
                self.file.taken();
            }
            Change::Written(bytes) => {
                *on = accounts_in(Some(&bytes));
                self.file.taken();
            }
        }
        on
    }

    /// Whether the live account `uid` (a Bybit UID, a `binance_id` or a
    /// `wallet_id`) may trade.
    pub fn is_on(&self, uid: &str) -> bool {
        self.current().contains(uid)
    }

    /// The live accounts with trading on: Bybit UIDs, Binance accounts as
    /// `binance:<uid>`, and Hyperliquid and Aster accounts as
    /// `<venue>:<address>`. Public ids only.
    pub fn list(&self) -> Vec<String> {
        self.current().iter().cloned().collect()
    }

    /// Turns `uid` on or off and writes the list. If it can't be written
    /// the change is undone, so what's kept and what's in force agree.
    ///
    /// The caller checks the account's key first when turning it on (the
    /// app's `set_live_trading` and `set_wallet_trading`): this only keeps
    /// the switch.
    pub fn set(&self, uid: &str, on: bool) -> Result<(), VenueError> {
        let mut accounts = self.current();
        let changed = if on {
            accounts.insert(uid.to_owned())
        } else {
            accounts.remove(uid)
        };
        if !changed {
            return Ok(());
        }
        let list: Vec<&String> = accounts.iter().collect();
        let saved = serde_json::to_vec(&list).is_ok_and(|json| self.file.write(&json));
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

    /// Turns a live Binance account off when its key is removed.
    pub fn forget_binance(&self, uid: &str) {
        if let Ok(id) = binance_id(uid) {
            let _ = self.set(&id, false);
        }
    }

    /// Turns a Hyperliquid or Aster account off when its key is removed.
    pub fn forget_wallet(&self, venue: VenueId, address: &str) {
        if let Ok(id) = wallet_id(venue, address) {
            let _ = self.set(&id, false);
        }
    }
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

    /// The app and the daemon each keep a copy: switching an account off
    /// in one stops it in the other before its next order.
    #[test]
    fn another_engine_turning_it_off_reaches_this_one() {
        let path = scratch("shared");
        let app = LiveTrading::load(Some(path.clone()));
        let daemon = LiveTrading::load(Some(path.clone()));
        app.set("24617703", true).unwrap();
        assert!(daemon.is_on("24617703"), "turned on in the app");
        app.set("24617703", false).unwrap();
        assert!(!daemon.is_on("24617703"), "turned off in the app");
        // The file gone, or not a list, is nobody on.
        daemon.set("24617703", true).unwrap();
        assert!(app.is_on("24617703"));
        std::fs::write(&path, b"garbage").unwrap();
        assert!(!app.is_on("24617703"));
        std::fs::remove_file(&path).unwrap();
        assert!(daemon.list().is_empty());
        let _ = std::fs::remove_dir_all(path.parent().unwrap().parent().unwrap());
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
    fn wallets_are_kept_by_venue_and_address() {
        let address = "0x2c7536e3605d9c16a7a3d7b1898e529396a65c23";
        let id = wallet_id(
            VenueId::Hyperliquid,
            &address.to_uppercase().replace("0X", "0x"),
        );
        assert_eq!(id.unwrap(), format!("hyperliquid:{address}"));
        assert_eq!(
            wallet_id(VenueId::Aster, address).unwrap(),
            format!("aster:{address}")
        );
        assert!(wallet_id(VenueId::Bybit, address).is_err());
        assert!(wallet_id(VenueId::Aster, "0x12").is_err());

        let path = scratch("wallets");
        let live = LiveTrading::load(Some(path.clone()));
        let hl = wallet_id(VenueId::Hyperliquid, address).unwrap();
        live.set(&hl, true).unwrap();
        // On for that venue's account only: not the same address on Aster.
        assert!(live.is_on(&hl));
        assert!(!live.is_on(&wallet_id(VenueId::Aster, address).unwrap()));
        assert_eq!(
            LiveTrading::load(Some(path.clone())).list(),
            std::slice::from_ref(&hl)
        );
        live.forget_wallet(VenueId::Aster, address);
        assert!(live.is_on(&hl));
        live.forget_wallet(VenueId::Hyperliquid, address);
        assert!(!live.is_on(&hl));

        // Only ids this module writes are read back.
        std::fs::write(
            &path,
            format!(
                r#"["aster:{address}","bybit:{address}","aster:0x12","hyperliquid:{}","x:1"]"#,
                address.to_uppercase()
            ),
        )
        .unwrap();
        assert_eq!(
            LiveTrading::load(Some(path.clone())).list(),
            [format!("aster:{address}")]
        );
        let _ = std::fs::remove_dir_all(path.parent().unwrap().parent().unwrap());
    }

    #[test]
    fn binance_accounts_are_kept_apart_from_bybits() {
        assert_eq!(binance_id(" 354937868 ").unwrap(), "binance:354937868");
        assert!(binance_id("demo:354937868").is_err());
        assert!(binance_id("0x12").is_err());
        assert!(wallet_id(
            VenueId::Binance,
            "0x2c7536e3605d9c16a7a3d7b1898e529396a65c23"
        )
        .is_err());

        let path = scratch("binance");
        let live = LiveTrading::load(Some(path.clone()));
        let id = binance_id("354937868").unwrap();
        live.set(&id, true).unwrap();
        // The same UID on Bybit stays off.
        assert!(live.is_on(&id) && !live.is_on("354937868"));
        assert_eq!(
            LiveTrading::load(Some(path.clone())).list(),
            std::slice::from_ref(&id)
        );
        live.forget_binance("354937868");
        assert!(!live.is_on(&id));
        // Only well-formed ids are read back.
        std::fs::write(
            &path,
            br#"["binance:354937868","binance:demo:1","binance:","binance:x","binance:1 "]"#,
        )
        .unwrap();
        assert_eq!(
            LiveTrading::load(Some(path.clone())).list(),
            ["binance:354937868"]
        );
        let _ = std::fs::remove_dir_all(path.parent().unwrap().parent().unwrap());
    }

    #[test]
    fn the_switch_is_for_live_accounts_only() {
        assert_eq!(live_uid(" 24617703 ").unwrap(), "24617703");
        assert!(live_uid("demo:24617703").is_err());
        assert!(live_uid("0x12").is_err());
    }
}
