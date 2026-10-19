//! One engine per account. The app's engine and the daemon's can both run;
//! only one may trade a given account at a time, or two would chase each
//! other's orders and miscount the trader's rules. The first to trade an
//! account takes its lock - a lock file per account, held with `flock` for
//! as long as that engine runs, and let go by the OS when it exits, a crash
//! included - and the other is refused until then. Cancels need no lock:
//! like the gate, nothing stops an order being taken off.
//!
//! Security-relevant: it only ever refuses (`docs/bots/safety.md`).

use std::collections::BTreeMap;
use std::fs::{File, OpenOptions};
use std::io::Write;
use std::path::PathBuf;
use std::sync::Mutex;

use pewterdesk_core::{VenueError, VenueId};

/// The refusal's code when another engine trades the account.
pub const LOCKED: &str = "another-engine";
/// The locks' folder, in the app's data folder (the daemon uses the same).
pub const LOCK_DIR: &str = "locks";

/// The accounts this engine has taken, and where their locks live.
#[derive(Default)]
pub struct Owners {
    /// No folder: no locks (a test, or a host that runs alone).
    dir: Option<PathBuf>,
    held: Mutex<BTreeMap<String, File>>,
}

fn venue_name(venue: VenueId) -> String {
    serde_json::to_value(venue)
        .ok()
        .and_then(|v| v.as_str().map(str::to_owned))
        .unwrap_or_default()
}

/// The account's lock, as a file name: its venue and id, with anything but
/// letters, digits and dashes made an underscore.
fn lock_name(venue: VenueId, account: &str) -> String {
    let id: String = account
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '-' {
                c
            } else {
                '_'
            }
        })
        .collect();
    format!("{}-{id}.lock", venue_name(venue))
}

impl Owners {
    /// Locks kept in `dir` (the app's data folder's `locks`).
    pub fn in_dir(dir: PathBuf) -> Self {
        Self {
            dir: Some(dir),
            held: Mutex::default(),
        }
    }

    /// Takes `account` for this engine, or refuses because another has it.
    pub fn claim(&self, venue: VenueId, account: &str) -> Result<(), VenueError> {
        let Some(dir) = &self.dir else {
            return Ok(());
        };
        let name = lock_name(venue, account);
        let mut held = self.held.lock().unwrap();
        if held.contains_key(&name) {
            return Ok(());
        }
        // Fails closed: a lock that can't be taken is a refusal.
        let refused = || VenueError::Blocked(LOCKED.into());
        std::fs::create_dir_all(dir).map_err(|_| refused())?;
        let mut file = OpenOptions::new()
            .create(true)
            .truncate(false)
            .write(true)
            .open(dir.join(&name))
            .map_err(|_| refused())?;
        if !try_lock(&file) {
            return Err(refused());
        }
        // Who holds it, for a person looking (`pd status`, or the file).
        let _ = file.set_len(0);
        let _ = writeln!(file, "{}", std::process::id());
        held.insert(name, file);
        Ok(())
    }

    /// The accounts this engine holds, as their lock names.
    pub fn held(&self) -> Vec<String> {
        self.held
            .lock()
            .unwrap()
            .keys()
            .map(|name| name.trim_end_matches(".lock").to_owned())
            .collect()
    }
}

#[cfg(unix)]
fn try_lock(file: &File) -> bool {
    use std::os::unix::io::AsRawFd;
    // SAFETY: flock on a descriptor this process owns, for its lifetime.
    unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) == 0 }
}

/// Elsewhere one engine per account isn't enforced yet: the daemon is
/// macOS-first (`docs/bots/plan.md`).
#[cfg(not(unix))]
fn try_lock(_file: &File) -> bool {
    true
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;

    fn dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("pd-owners-{}-{name}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        dir
    }

    #[test]
    fn one_engine_per_account() {
        let dir = dir("one");
        let app = Owners::in_dir(dir.clone());
        let daemon = Owners::in_dir(dir.clone());
        app.claim(VenueId::Bybit, "demo:1").unwrap();
        // Again for the same engine is fine.
        app.claim(VenueId::Bybit, "demo:1").unwrap();
        assert_eq!(
            daemon.claim(VenueId::Bybit, "demo:1"),
            Err(VenueError::Blocked(LOCKED.into()))
        );
        // Another account is free.
        daemon.claim(VenueId::Hyperliquid, "0xabc").unwrap();
        assert_eq!(app.held(), ["bybit-demo_1"]);
        // The lock goes with its engine.
        drop(app);
        daemon.claim(VenueId::Bybit, "demo:1").unwrap();
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn without_a_folder_nothing_is_locked() {
        let a = Owners::default();
        let b = Owners::default();
        a.claim(VenueId::Aster, "0x1").unwrap();
        b.claim(VenueId::Aster, "0x1").unwrap();
    }
}
