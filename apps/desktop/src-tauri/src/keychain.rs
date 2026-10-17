//! The keychain commands the page calls (`SecretStore`: write, check,
//! delete - no read), over `pewterdesk_keychain`, which holds the keychain
//! bridge itself and the app's `KeySource`.
//!
//! Security-relevant - review any change here against
//! `.claude/commands/security-review.md`: nothing here reads a secret back
//! to JS.

pub use pewterdesk_keychain::{delete_key, store_key, KeychainError, KeychainKeySource};

#[tauri::command]
pub async fn store_secret(account: String, secret: String) -> Result<(), KeychainError> {
    pewterdesk_keychain::store_secret(account, secret).await
}

#[tauri::command]
pub async fn has_secret(account: String) -> Result<bool, KeychainError> {
    pewterdesk_keychain::has_secret(account).await
}

#[tauri::command]
pub async fn delete_secret(account: String) -> Result<(), KeychainError> {
    pewterdesk_keychain::delete_key(account).await
}
