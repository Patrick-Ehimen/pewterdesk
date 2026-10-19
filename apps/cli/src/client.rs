//! `pd`'s connection to the daemon, over its Unix socket
//! (`pewterdesk_link`), saying hello with this `pd`'s pairing token. The
//! token lives in the keychain (`pd:token`), read here only to hand to the
//! link.

use pewterdesk_keychain::KeychainKeySource;
use pewterdesk_protocol::rpc::{ClientInfo, ClientKind};

pub use pewterdesk_link::{Link as Client, Unreachable};

/// Where `pd`'s pairing token is kept in the keychain.
pub const TOKEN_ACCOUNT: &str = "pd:token";

/// This machine's name, for the pairing prompt.
fn host_name() -> String {
    std::env::var("HOSTNAME")
        .ok()
        .filter(|h| !h.is_empty())
        .or_else(|| {
            std::process::Command::new("hostname")
                .output()
                .ok()
                .and_then(|o| String::from_utf8(o.stdout).ok())
                .map(|h| h.trim().to_owned())
        })
        .unwrap_or_else(|| "this machine".into())
}

pub fn info() -> ClientInfo {
    ClientInfo {
        name: format!("pd on {}", host_name()),
        kind: ClientKind::Pd,
    }
}

/// The pairing token, if this `pd` has one.
pub async fn token() -> Option<String> {
    use pewterdesk_core::KeySource;
    KeychainKeySource
        .key(TOKEN_ACCOUNT)
        .await
        .ok()
        .map(|t| t.to_string())
}

pub async fn keep_token(token: String) -> Result<(), String> {
    pewterdesk_keychain::store_secret(TOKEN_ACCOUNT.into(), token)
        .await
        .map_err(|_| "the token couldn't be kept in the keychain".to_owned())
}

pub async fn forget_token() {
    let _ = pewterdesk_keychain::delete_key(TOKEN_ACCOUNT.into()).await;
}
