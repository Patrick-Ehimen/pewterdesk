//! How accounts are named, and the keychain entries their keys live under -
//! shared by onboarding (which stores a key), the adapters (which read it)
//! and the engine (which builds an account's key reference before an order
//! is signed). One copy, so the three can't drift apart.
//!
//! Security-relevant: these names decide which stored key signs for which
//! account. Review any change against `.claude/commands/security-review.md`.

use crate::{VenueError, VenueId};

/// What a Bybit demo account's id starts with, before its UID.
pub const BYBIT_DEMO_PREFIX: &str = "demo:";

/// A Bybit account id: its UID (digits, as Bybit numbers its accounts),
/// with `demo:` in front for a demo account. Returns whether it's demo, and
/// the UID.
pub fn bybit_account(id: &str) -> Result<(bool, &str), VenueError> {
    let (demo, uid) = match id.strip_prefix(BYBIT_DEMO_PREFIX) {
        Some(uid) => (true, uid),
        None => (false, id),
    };
    if !uid.is_empty() && uid.len() <= 20 && uid.bytes().all(|b| b.is_ascii_digit()) {
        Ok((demo, uid))
    } else {
        Err(VenueError::InvalidRequest(
            "a Bybit account is its UID (digits), or demo: and its UID".into(),
        ))
    }
}

/// The keychain entry the API key for Bybit account `id` lives under:
/// `bybit:{uid}`, or `bybit:demo:{uid}` for a demo account.
pub fn bybit_key_entry(id: &str) -> Result<String, VenueError> {
    bybit_account(id)?;
    Ok(format!("bybit:{id}"))
}

/// A wallet address as accounts are kept: lowercase `0x` + 40 hex, or an
/// error saying what an address looks like.
pub fn normalize_address(address: &str) -> Result<String, VenueError> {
    let address = address.trim().to_ascii_lowercase();
    let hex = address.strip_prefix("0x").unwrap_or("");
    if hex.len() == 40 && hex.bytes().all(|b| b.is_ascii_hexdigit()) {
        Ok(address)
    } else {
        Err(VenueError::InvalidRequest(
            "an address is 0x followed by 40 hex characters".into(),
        ))
    }
}

/// The keychain entry the API wallet for a venue account lives under, by
/// its main wallet's address (already normalized).
pub fn wallet_key_entry(venue: VenueId, address: &str) -> String {
    match venue {
        VenueId::Hyperliquid => format!("hyperliquid:{address}"),
        VenueId::Aster => format!("aster:{address}"),
        VenueId::Bybit => format!("bybit:{address}"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bybit_accounts_are_digit_uids() {
        assert_eq!(bybit_account("24617703").unwrap(), (false, "24617703"));
        assert_eq!(bybit_account("demo:24617703").unwrap(), (true, "24617703"));
        for bad in [
            "",
            "demo:",
            "abc",
            "demo:12a",
            "1".repeat(21).as_str(),
            " 1",
        ] {
            assert!(bybit_account(bad).is_err(), "{bad:?}");
        }
        assert_eq!(bybit_key_entry("24617703").unwrap(), "bybit:24617703");
        assert_eq!(
            bybit_key_entry("demo:24617703").unwrap(),
            "bybit:demo:24617703"
        );
        assert!(bybit_key_entry("x").is_err());
    }

    #[test]
    fn addresses_are_kept_lowercase() {
        let address = format!("0x{}", "a".repeat(40));
        assert_eq!(
            normalize_address(&format!(" 0x{} ", "A".repeat(40))).unwrap(),
            address
        );
        assert!(normalize_address("0x12").is_err());
        assert!(normalize_address(&format!("0x{}", "g".repeat(40))).is_err());
        assert_eq!(
            wallet_key_entry(VenueId::Hyperliquid, &address),
            format!("hyperliquid:{address}")
        );
        assert_eq!(
            wallet_key_entry(VenueId::Aster, &address),
            format!("aster:{address}")
        );
    }
}
