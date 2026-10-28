//! How accounts are named, and the keychain entries their keys live under -
//! shared by onboarding (which stores a key), the adapters (which read it)
//! and the engine (which builds an account's key reference before an order
//! is signed). One copy, so the three can't drift apart.
//!
//! Security-relevant: these names decide which stored key signs for which
//! account. Review any change against `.claude/commands/security-review.md`.

use crate::{VenueError, VenueId};

/// What a demo account's id starts with, before its UID, on the venues
/// whose accounts are API keys (Bybit, Binance, BloFin).
pub const DEMO_PREFIX: &str = "demo:";

/// What a Bybit demo account's id starts with, before its UID.
pub const BYBIT_DEMO_PREFIX: &str = DEMO_PREFIX;

/// An account id on a venue that numbers its accounts: its UID (digits),
/// with `demo:` in front for a demo account. Returns whether it's demo, and
/// the UID; `venue` names it in the error.
fn uid_account<'a>(venue: &str, id: &'a str) -> Result<(bool, &'a str), VenueError> {
    let (demo, uid) = match id.strip_prefix(DEMO_PREFIX) {
        Some(uid) => (true, uid),
        None => (false, id),
    };
    if !uid.is_empty() && uid.len() <= 20 && uid.bytes().all(|b| b.is_ascii_digit()) {
        Ok((demo, uid))
    } else {
        Err(VenueError::InvalidRequest(format!(
            "a {venue} account is its UID (digits), or demo: and its UID"
        )))
    }
}

/// A Bybit account id: its UID (digits, as Bybit numbers its accounts),
/// with `demo:` in front for a demo account. Returns whether it's demo, and
/// the UID.
pub fn bybit_account(id: &str) -> Result<(bool, &str), VenueError> {
    uid_account("Bybit", id)
}

/// The keychain entry the API key for Bybit account `id` lives under:
/// `bybit:{uid}`, or `bybit:demo:{uid}` for a demo account.
pub fn bybit_key_entry(id: &str) -> Result<String, VenueError> {
    bybit_account(id)?;
    Ok(format!("bybit:{id}"))
}

/// A Binance account id: its UID, with `demo:` in front for a Demo Trading
/// account, as on Bybit. Returns whether it's demo, and the UID.
pub fn binance_account(id: &str) -> Result<(bool, &str), VenueError> {
    uid_account("Binance", id)
}

/// The keychain entry the API key for Binance account `id` lives under:
/// `binance:{uid}`, or `binance:demo:{uid}` for a Demo Trading account.
pub fn binance_key_entry(id: &str) -> Result<String, VenueError> {
    binance_account(id)?;
    Ok(format!("binance:{id}"))
}

/// A BloFin account id: its UID, with `demo:` in front for a Demo Trading
/// account, as on Bybit. Returns whether it's demo, and the UID. Only demo
/// accounts trade (the router refuses a live one): BloFin can't say whether
/// a key may transfer funds.
pub fn blofin_account(id: &str) -> Result<(bool, &str), VenueError> {
    uid_account("BloFin", id)
}

/// The keychain entry the API key for BloFin account `id` lives under:
/// `blofin:{uid}`, or `blofin:demo:{uid}` for a Demo Trading account.
pub fn blofin_key_entry(id: &str) -> Result<String, VenueError> {
    blofin_account(id)?;
    Ok(format!("blofin:{id}"))
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
        VenueId::Binance => format!("binance:{address}"),
        VenueId::Blofin => format!("blofin:{address}"),
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
    fn binance_accounts_are_digit_uids_under_their_own_entries() {
        assert_eq!(binance_account("354937868").unwrap(), (false, "354937868"));
        assert_eq!(
            binance_account("demo:354937868").unwrap(),
            (true, "354937868")
        );
        for bad in ["", "demo:", "0xabc", "demo:demo:1", "1 2"] {
            assert!(binance_account(bad).is_err(), "{bad:?}");
        }
        assert_eq!(binance_key_entry("354937868").unwrap(), "binance:354937868");
        assert_eq!(
            binance_key_entry("demo:354937868").unwrap(),
            "binance:demo:354937868"
        );
        // The same UID on Bybit is a different entry: one venue's key can't
        // be read for the other's account.
        assert_ne!(
            binance_key_entry("354937868").unwrap(),
            bybit_key_entry("354937868").unwrap()
        );
        assert!(binance_account("x")
            .unwrap_err()
            .to_string()
            .contains("Binance"));
    }

    #[test]
    fn blofin_accounts_are_digit_uids_under_their_own_entries() {
        assert_eq!(blofin_account("demo:20923487").unwrap(), (true, "20923487"));
        assert_eq!(blofin_account("20923487").unwrap(), (false, "20923487"));
        for bad in ["", "demo:", "0xabc", "demo:demo:1", "1 2"] {
            assert!(blofin_account(bad).is_err(), "{bad:?}");
        }
        assert_eq!(
            blofin_key_entry("demo:20923487").unwrap(),
            "blofin:demo:20923487"
        );
        // The same UID on another venue is a different entry.
        assert_ne!(
            blofin_key_entry("demo:20923487").unwrap(),
            binance_key_entry("demo:20923487").unwrap()
        );
        assert_ne!(
            blofin_key_entry("demo:20923487").unwrap(),
            bybit_key_entry("demo:20923487").unwrap()
        );
        assert!(blofin_account("x")
            .unwrap_err()
            .to_string()
            .contains("BloFin"));
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
