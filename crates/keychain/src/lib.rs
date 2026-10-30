//! OS keychain bridge - the only place key material is stored.
//!
//! Secrets live in the platform credential store (macOS Keychain, Windows
//! Credential Manager, Secret Service on Linux) under one service name.
//! Nothing reads a secret back to JS: Rust gets at a stored key only through
//! [`KeychainKeySource`], the app's `KeySource`. A crate of its own so the
//! desktop app and, later, the daemon (`pdd`) share one implementation; the
//! app keeps the Tauri commands over it (`src-tauri/src/keychain.rs`).
//!
//! On macOS every key is also kept in one item, the vault (`VAULT`): a map
//! of account to secret. macOS asks for the login password once per item a
//! build reads (the first time, or every launch until "Always Allow"), so
//! one item means one prompt rather than one per key. Each key's own item
//! stays the record of whether it exists (`has` reads attributes only, no
//! prompt), and of its value where the vault doesn't have it yet: a key not
//! in the vault is read from its own item once and copied in. Nothing is
//! kept in memory: each read reads the vault, as each read read the key's
//! item before. Other platforms keep one item per key (Windows also caps an
//! item's size, which a vault of every key could pass).
//!
//! Security invariants - review any change here against
//! `.claude/commands/security-review.md`:
//! - Nothing in this module logs, prints or persists a secret.
//! - Keyring errors are never formatted. Several variants carry credential
//!   material (`BadEncoding`, `BadDataFormat`, `Ambiguous`) and their Display
//!   impls dump it, so every variant maps to a fixed message by hand. Error
//!   details are `&'static str` so a formatted string can't be passed through.

use std::collections::BTreeMap;
use std::sync::{Mutex, MutexGuard};

use async_trait::async_trait;
use keyring::{Entry, Error as KeyringError};
use pewterdesk_core::{KeyError, KeySource};
use serde::Serialize;
use zeroize::Zeroizing;

const SERVICE: &str = "app.pewterdesk.desktop";
const ACCOUNT_MAX_LEN: usize = 128;
/// The item holding every key, on macOS; not an account anyone may name.
const VAULT: &str = "pewterdesk.vault";
/// Where keys are kept in the vault as well as in their own items.
const USE_VAULT: bool = cfg!(target_os = "macos");

/// Serialized adjacently tagged, so unit variants arrive in JS without a
/// `detail` field. Keep in sync with `RustKeychainError` in
/// `src/secrets/tauriSecretStore.ts`.
#[derive(Debug, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", content = "detail", rename_all = "camelCase")]
pub enum KeychainError {
    InvalidAccount(&'static str),
    NotFound,
    Backend(&'static str),
}

/// Mirrors `isValidAccount` in `@pewterdesk/core`. This side is the authority.
fn validate_account(account: &str) -> Result<(), KeychainError> {
    let valid = !account.is_empty()
        && account != VAULT
        && account.len() <= ACCOUNT_MAX_LEN
        && account
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'.' | b':'));
    if valid {
        Ok(())
    } else {
        Err(KeychainError::InvalidAccount(
            "account must be 1-128 characters of A-Z a-z 0-9 - _ . :",
        ))
    }
}

fn map_keyring_error(err: KeyringError) -> KeychainError {
    use KeychainError::Backend;
    match err {
        KeyringError::NoEntry => KeychainError::NotFound,
        KeyringError::NoStorageAccess(_) => Backend("keychain is locked or access was denied"),
        KeyringError::PlatformFailure(_) => Backend("keychain platform error"),
        KeyringError::BadEncoding(_) => Backend("stored secret is not valid UTF-8"),
        KeyringError::BadDataFormat(..) => Backend("stored secret is malformed"),
        KeyringError::BadStoreFormat(_) => Backend("keychain store is malformed"),
        KeyringError::TooLong(..) => Backend("value exceeds the keychain's length limit"),
        KeyringError::Invalid(..) => Backend("keychain rejected a parameter"),
        KeyringError::Ambiguous(_) => Backend("more than one keychain entry matches this account"),
        KeyringError::NoDefaultStore => Backend("no keychain is available on this platform"),
        KeyringError::NotSupportedByStore(_) => Backend("operation not supported by this keychain"),
        _ => Backend("keychain error"),
    }
}

fn entry(service: &str, account: &str) -> Result<Entry, KeychainError> {
    validate_account(account)?;
    Entry::new(service, account).map_err(map_keyring_error)
}

/// A key's own item, written.
fn item_store(service: &str, account: &str, secret: &str) -> Result<(), KeychainError> {
    entry(service, account)?
        .set_password(secret)
        .map_err(map_keyring_error)
}

/// A key's own item, read: on macOS, a prompt for each item a build reads.
fn item_get(service: &str, account: &str) -> Result<String, KeychainError> {
    entry(service, account)?
        .get_password()
        .map_err(map_keyring_error)
}

/// Every key the vault holds, by account.
type Secrets = BTreeMap<String, Zeroizing<String>>;

/// The vault's stored form: a JSON object of account to secret.
fn decode(raw: &str) -> Result<Secrets, KeychainError> {
    // serde_json's error is dropped unread: it can quote the input.
    let map: BTreeMap<String, String> = serde_json::from_str(raw)
        .map_err(|_| KeychainError::Backend("stored secret is malformed"))?;
    Ok(map
        .into_iter()
        .map(|(account, secret)| (account, Zeroizing::new(secret)))
        .collect())
}

fn encode(secrets: &Secrets) -> Zeroizing<String> {
    let view: BTreeMap<&str, &str> = secrets
        .iter()
        .map(|(account, secret)| (account.as_str(), secret.as_str()))
        .collect();
    Zeroizing::new(serde_json::to_string(&view).unwrap_or_default())
}

fn vault_entry(service: &str) -> Result<Entry, KeychainError> {
    Entry::new(service, VAULT).map_err(map_keyring_error)
}

/// The vault's keys; none yet before it's first written.
fn vault_read(service: &str) -> Result<Secrets, KeychainError> {
    match vault_entry(service)?.get_password() {
        Ok(raw) => decode(&Zeroizing::new(raw)),
        Err(KeyringError::NoEntry) => Ok(Secrets::new()),
        Err(err) => Err(map_keyring_error(err)),
    }
}

/// The app, `pdd` and `pd` all write the vault: a change is a read and a
/// write, so it's made under a lock, this process's and a file lock the
/// others take too, or one could write back over another's key.
struct VaultLock {
    _local: MutexGuard<'static, ()>,
    #[cfg(unix)]
    _file: Option<std::fs::File>,
}

static IN_PROCESS: Mutex<()> = Mutex::new(());

impl VaultLock {
    fn take(service: &str) -> Self {
        let local = IN_PROCESS
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        #[cfg(unix)]
        let file = {
            use std::os::fd::AsRawFd;
            let path = std::env::temp_dir().join(format!("{service}.vault.lock"));
            std::fs::OpenOptions::new()
                .create(true)
                .truncate(false)
                .write(true)
                .open(path)
                .ok()
                .inspect(|file| {
                    // SAFETY: flock on a descriptor this process owns, held
                    // until the file is dropped with the lock.
                    unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX) };
                })
        };
        VaultLock {
            _local: local,
            #[cfg(unix)]
            _file: file,
        }
    }
}

/// Changes the vault under the lock: read, `change`, write back.
fn vault_change(service: &str, change: impl FnOnce(&mut Secrets)) -> Result<(), KeychainError> {
    let _lock = VaultLock::take(service);
    let mut secrets = vault_read(service)?;
    change(&mut secrets);
    let raw = encode(&secrets);
    vault_entry(service)?
        .set_password(&raw)
        .map_err(map_keyring_error)
}

/// Stores a key: in the vault first, then its own item, so the vault is
/// never behind an item (a failed write leaves the newer key in the vault,
/// where a read finds it; the item still says whether it exists).
fn store(service: &str, account: &str, secret: &str) -> Result<(), KeychainError> {
    validate_account(account)?;
    if USE_VAULT {
        vault_change(service, |secrets| {
            secrets.insert(account.to_owned(), Zeroizing::new(secret.to_owned()));
        })?;
    }
    item_store(service, account, secret)
}

/// Reads a key. Its own item says whether it exists, so a key deleted (by
/// any of the app, `pdd` or `pd`) doesn't linger in the vault; the vault
/// gives its value, or the item does the once it isn't in the vault yet.
fn get(service: &str, account: &str) -> Result<String, KeychainError> {
    validate_account(account)?;
    if !USE_VAULT {
        return item_get(service, account);
    }
    if !has(service, account)? {
        return Err(KeychainError::NotFound);
    }
    if let Some(secret) = vault_read(service)?.get(account) {
        return Ok(secret.to_string());
    }
    // Not in the vault yet (stored before it, or a write that failed):
    // read once from its own item, and keep it in the vault from now on. A
    // vault that can't be written is tried again on the next read.
    let secret = Zeroizing::new(item_get(service, account)?);
    let _ = vault_change(service, |secrets| {
        secrets.insert(account.to_owned(), Zeroizing::new(secret.to_string()));
    });
    Ok(secret.to_string())
}

/// Whether a secret is stored, without reading it: a search by service and
/// account returns the entries' attributes only. On macOS that's what
/// matters - reading a secret's data asks for the login password (once per
/// entry, for each build the Mac hasn't seen), reading its attributes
/// doesn't, so a "connected?" check costs no prompt.
///
/// A store that can't search that way (the error says so) falls back to
/// reading the secret and dropping it at once; it never leaves Rust.
fn has(service: &str, account: &str) -> Result<bool, KeychainError> {
    // Also sets up keyring's default store, which the search goes to.
    let entry = entry(service, account)?;
    let spec = std::collections::HashMap::from([("service", service), ("user", account)]);
    match keyring_core::Entry::search(&spec) {
        Ok(found) => Ok(!found.is_empty()),
        Err(_) => match entry.get_password() {
            Ok(_) => Ok(true),
            Err(KeyringError::NoEntry) => Ok(false),
            Err(err) => Err(map_keyring_error(err)),
        },
    }
}

/// Idempotent: deleting an absent secret succeeds. The key's own item goes
/// first: from then on it doesn't exist, whatever the vault says.
fn delete(service: &str, account: &str) -> Result<(), KeychainError> {
    match entry(service, account)?.delete_credential() {
        Ok(()) | Err(KeyringError::NoEntry) => {}
        Err(err) => return Err(map_keyring_error(err)),
    }
    if USE_VAULT {
        vault_change(service, |secrets| {
            secrets.remove(account);
        })?;
    }
    Ok(())
}

/// Keychain calls block, and on macOS can wait on a user prompt, so they run
/// off the async runtime rather than stalling the webview's IPC.
async fn blocking<T, F>(f: F) -> Result<T, KeychainError>
where
    F: FnOnce() -> Result<T, KeychainError> + Send + 'static,
    T: Send + 'static,
{
    tokio::task::spawn_blocking(f)
        .await
        .unwrap_or(Err(KeychainError::Backend("keychain task failed")))
}

/// Stores a key that Rust has already checked (onboarding, in `wallet.rs`).
pub async fn store_key(account: String, key: Zeroizing<String>) -> Result<(), KeychainError> {
    blocking(move || store(SERVICE, &account, &key)).await
}

/// Stores a secret the page hands over (the `SecretStore` contract: write,
/// check, delete - no read).
pub async fn store_secret(account: String, secret: String) -> Result<(), KeychainError> {
    blocking(move || store(SERVICE, &account, &secret)).await
}

/// Whether a secret is stored under `account`. The secret itself never
/// leaves this crate.
pub async fn has_secret(account: String) -> Result<bool, KeychainError> {
    blocking(move || has(SERVICE, &account)).await
}

/// Deletes a stored key; idempotent.
pub async fn delete_key(account: String) -> Result<(), KeychainError> {
    blocking(move || delete(SERVICE, &account)).await
}

impl From<KeychainError> for KeyError {
    fn from(err: KeychainError) -> Self {
        match err {
            KeychainError::NotFound => KeyError::NotFound,
            KeychainError::InvalidAccount(detail) | KeychainError::Backend(detail) => {
                KeyError::Backend(detail)
            }
        }
    }
}

/// The app's `KeySource`: keys come from the OS keychain, straight into
/// `Zeroizing` memory, and never cross to JS. Venue crates receive this;
/// they never construct one.
pub struct KeychainKeySource;

#[async_trait]
impl KeySource for KeychainKeySource {
    async fn key(&self, account: &str) -> Result<Zeroizing<String>, KeyError> {
        let account = account.to_owned();
        Ok(Zeroizing::new(
            blocking(move || get(SERVICE, &account)).await?,
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    /// The existence check against the real OS store, without reading the
    /// secret (on macOS: no password prompt for it). Skipped by default
    /// (`cargo test -p pewterdesk-keychain -- --ignored`).
    #[test]
    #[ignore]
    fn tells_a_stored_secret_from_none_without_reading_it() {
        let service = "app.pewterdesk.desktop.test";
        let account = "has-check:probe";
        delete(service, account).unwrap();
        assert_eq!(has(service, account), Ok(false));
        store(service, account, "not-a-real-secret").unwrap();
        assert_eq!(has(service, account), Ok(true));
        // Another account under the same service isn't it.
        assert_eq!(has(service, "has-check:other"), Ok(false));
        delete(service, account).unwrap();
        assert_eq!(has(service, account), Ok(false));
    }

    #[test]
    fn the_vault_round_trips_and_its_name_is_no_account() {
        let mut secrets = Secrets::new();
        secrets.insert("bybit:1".into(), Zeroizing::new("k:s".into()));
        secrets.insert(
            "anthropic:api".into(),
            Zeroizing::new("sk-\"quoted\"".into()),
        );
        let back = decode(&encode(&secrets)).unwrap();
        assert_eq!(back.get("bybit:1").map(|s| s.as_str()), Some("k:s"));
        assert_eq!(
            back.get("anthropic:api").map(|s| s.as_str()),
            Some("sk-\"quoted\"")
        );
        assert!(matches!(
            validate_account(VAULT),
            Err(KeychainError::InvalidAccount(_))
        ));
    }

    #[test]
    fn a_malformed_vault_says_so_without_quoting_it() {
        let err = decode("{\"a\": \"secret-value").unwrap_err();
        let serialized = serde_json::to_string(&err).unwrap();
        assert!(!serialized.contains("secret-value"), "{serialized}");
    }

    #[test]
    fn accepts_valid_accounts() {
        let max = "x".repeat(ACCOUNT_MAX_LEN);
        for account in ["a", "hyperliquid:main", "wallet_0.api-key", "ABC123", &max] {
            assert_eq!(validate_account(account), Ok(()), "{account:?}");
        }
    }

    #[test]
    fn rejects_invalid_accounts() {
        let too_long = "x".repeat(ACCOUNT_MAX_LEN + 1);
        for account in [
            "",
            &too_long,
            "my wallet",
            "venue/main",
            "wället",
            "wallet\n",
            "wallet\0",
        ] {
            assert!(
                matches!(
                    validate_account(account),
                    Err(KeychainError::InvalidAccount(_))
                ),
                "{account:?}"
            );
        }
    }

    #[test]
    fn invalid_account_is_rejected_before_touching_the_keychain() {
        assert!(matches!(
            get(SERVICE, "not valid"),
            Err(KeychainError::InvalidAccount(_))
        ));
    }

    #[test]
    fn no_entry_maps_to_not_found() {
        assert_eq!(
            map_keyring_error(KeyringError::NoEntry),
            KeychainError::NotFound
        );
    }

    #[test]
    fn error_details_never_carry_credential_material() {
        let secret = "0xdeadbeef-private-key";
        let errors = [
            KeyringError::BadEncoding(secret.as_bytes().to_vec()),
            KeyringError::BadStoreFormat(secret.into()),
            KeyringError::Invalid(secret.into(), secret.into()),
            KeyringError::TooLong(secret.into(), 1),
            KeyringError::NotSupportedByStore(secret.into()),
            KeyringError::Ambiguous(vec![]),
        ];
        for err in errors {
            let serialized = serde_json::to_string(&map_keyring_error(err)).unwrap();
            assert!(!serialized.contains(secret), "{serialized}");
        }
    }

    /// Guards the shape `tauriSecretStore.ts` parses.
    #[test]
    fn errors_serialize_as_the_ts_side_expects() {
        assert_eq!(
            serde_json::to_value(KeychainError::NotFound).unwrap(),
            json!({ "kind": "notFound" })
        );
        assert_eq!(
            serde_json::to_value(KeychainError::Backend("boom")).unwrap(),
            json!({ "kind": "backend", "detail": "boom" })
        );
        assert_eq!(
            serde_json::to_value(KeychainError::InvalidAccount("bad")).unwrap(),
            json!({ "kind": "invalidAccount", "detail": "bad" })
        );
    }

    // Touch the real OS keychain, under a separate service so they can't
    // clobber app data. Run with `cargo test -- --ignored`.
    const TEST_SERVICE: &str = "app.pewterdesk.desktop.test";

    #[test]
    #[ignore = "touches the real OS keychain"]
    fn keychain_round_trip() {
        let account = "roundtrip";
        delete(TEST_SERVICE, account).unwrap();

        assert_eq!(has(TEST_SERVICE, account), Ok(false));
        assert_eq!(get(TEST_SERVICE, account), Err(KeychainError::NotFound));

        store(TEST_SERVICE, account, "first").unwrap();
        store(TEST_SERVICE, account, "second").unwrap();
        assert_eq!(has(TEST_SERVICE, account), Ok(true));
        assert_eq!(get(TEST_SERVICE, account).as_deref(), Ok("second"));

        delete(TEST_SERVICE, account).unwrap();
        assert_eq!(has(TEST_SERVICE, account), Ok(false));
    }

    /// A key stored before the vault is read from its own item once and
    /// kept in the vault; deleting it leaves nothing a read can find.
    #[test]
    #[ignore = "touches the real OS keychain"]
    fn keychain_vault_takes_in_older_keys_and_forgets_deleted_ones() {
        let account = "vault-migration";
        delete(TEST_SERVICE, account).unwrap();
        item_store(TEST_SERVICE, account, "older").unwrap();
        assert_eq!(get(TEST_SERVICE, account).as_deref(), Ok("older"));
        if USE_VAULT {
            let vault = vault_read(TEST_SERVICE).unwrap();
            assert_eq!(vault.get(account).map(|s| s.as_str()), Some("older"));
        }
        store(TEST_SERVICE, account, "newer").unwrap();
        assert_eq!(get(TEST_SERVICE, account).as_deref(), Ok("newer"));
        delete(TEST_SERVICE, account).unwrap();
        assert_eq!(get(TEST_SERVICE, account), Err(KeychainError::NotFound));
        if USE_VAULT {
            assert!(!vault_read(TEST_SERVICE).unwrap().contains_key(account));
        }
    }

    #[test]
    #[ignore = "touches the real OS keychain"]
    fn keychain_delete_is_idempotent() {
        let account = "idempotent-delete";
        delete(TEST_SERVICE, account).unwrap();
        assert_eq!(delete(TEST_SERVICE, account), Ok(()));
    }
}
