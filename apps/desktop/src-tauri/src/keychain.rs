//! OS keychain bridge — the only place key material is stored.
//!
//! Secrets live in the platform credential store (macOS Keychain, Windows
//! Credential Manager, Secret Service on Linux) under one service name.
//! `get_secret` is the sole path by which a secret reaches JS.
//!
//! Security invariants — review any change here against
//! `.claude/commands/security-review.md`:
//! - Nothing in this module logs, prints or persists a secret.
//! - Keyring errors are never formatted. Several variants carry credential
//!   material (`BadEncoding`, `BadDataFormat`, `Ambiguous`) and their Display
//!   impls dump it, so every variant maps to a fixed message by hand. Error
//!   details are `&'static str` so a formatted string can't be passed through.

use keyring::{Entry, Error as KeyringError};
use serde::Serialize;

const SERVICE: &str = "app.pewterdesk.desktop";
const ACCOUNT_MAX_LEN: usize = 128;

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

fn store(service: &str, account: &str, secret: &str) -> Result<(), KeychainError> {
    entry(service, account)?
        .set_password(secret)
        .map_err(map_keyring_error)
}

fn get(service: &str, account: &str) -> Result<String, KeychainError> {
    entry(service, account)?
        .get_password()
        .map_err(map_keyring_error)
}

/// The keychain APIs have no existence check, so this reads the secret and
/// drops it immediately. It never leaves Rust.
fn has(service: &str, account: &str) -> Result<bool, KeychainError> {
    match entry(service, account)?.get_password() {
        Ok(_) => Ok(true),
        Err(KeyringError::NoEntry) => Ok(false),
        Err(err) => Err(map_keyring_error(err)),
    }
}

/// Idempotent: deleting an absent secret succeeds.
fn delete(service: &str, account: &str) -> Result<(), KeychainError> {
    match entry(service, account)?.delete_credential() {
        Ok(()) | Err(KeyringError::NoEntry) => Ok(()),
        Err(err) => Err(map_keyring_error(err)),
    }
}

/// Keychain calls block, and on macOS can wait on a user prompt, so they run
/// off the async runtime rather than stalling the webview's IPC.
async fn blocking<T, F>(f: F) -> Result<T, KeychainError>
where
    F: FnOnce() -> Result<T, KeychainError> + Send + 'static,
    T: Send + 'static,
{
    tauri::async_runtime::spawn_blocking(f)
        .await
        .unwrap_or(Err(KeychainError::Backend("keychain task failed")))
}

#[tauri::command]
pub async fn store_secret(account: String, secret: String) -> Result<(), KeychainError> {
    blocking(move || store(SERVICE, &account, &secret)).await
}

#[tauri::command]
pub async fn get_secret(account: String) -> Result<String, KeychainError> {
    blocking(move || get(SERVICE, &account)).await
}

#[tauri::command]
pub async fn has_secret(account: String) -> Result<bool, KeychainError> {
    blocking(move || has(SERVICE, &account)).await
}

#[tauri::command]
pub async fn delete_secret(account: String) -> Result<(), KeychainError> {
    blocking(move || delete(SERVICE, &account)).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

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

    #[test]
    #[ignore = "touches the real OS keychain"]
    fn keychain_delete_is_idempotent() {
        let account = "idempotent-delete";
        delete(TEST_SERVICE, account).unwrap();
        assert_eq!(delete(TEST_SERVICE, account), Ok(()));
    }
}
