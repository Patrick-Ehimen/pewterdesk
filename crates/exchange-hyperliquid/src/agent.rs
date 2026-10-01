//! The API (agent) wallet: the trade-only key pewterdesk stores for
//! Hyperliquid. The user creates and approves it from their main wallet on
//! Hyperliquid's site; an agent can place and cancel orders for that
//! account but can't withdraw or transfer.
//!
//! Security-sensitive - review any change against
//! `.claude/commands/security-review.md`:
//! - The key is decoded into `Zeroizing` memory and dropped as soon as the
//!   address is derived. Nothing here logs, formats or returns it.
//! - Errors are fixed strings, never built from the input.

use pewterdesk_core::{KeyError, VenueError};
use serde::{Deserialize, Serialize};
use sha3::{Digest, Keccak256};
use zeroize::Zeroizing;

/// An agent approved for an account, as `extraAgents` reports it.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ApprovedAgent {
    pub name: String,
    pub address: String,
    /// When the approval lapses, in ms since the epoch.
    pub valid_until: u64,
}

const BAD_KEY: VenueError = VenueError::Key(KeyError::Backend(
    "a private key is 64 hex characters, optionally after 0x",
));

fn nibble(b: u8) -> Option<u8> {
    match b {
        b'0'..=b'9' => Some(b - b'0'),
        b'a'..=b'f' => Some(b - b'a' + 10),
        b'A'..=b'F' => Some(b - b'A' + 10),
        _ => None,
    }
}

/// The 32 key bytes, from hex with or without `0x` and surrounding space.
fn decode_key(key: &str) -> Result<Zeroizing<[u8; 32]>, VenueError> {
    let key = key.trim();
    let hex = key.strip_prefix("0x").unwrap_or(key).as_bytes();
    if hex.len() != 64 {
        return Err(BAD_KEY);
    }
    let mut bytes = Zeroizing::new([0u8; 32]);
    for (i, pair) in hex.chunks_exact(2).enumerate() {
        let (Some(hi), Some(lo)) = (nibble(pair[0]), nibble(pair[1])) else {
            return Err(BAD_KEY);
        };
        bytes[i] = (hi << 4) | lo;
    }
    Ok(bytes)
}

/// The address a private key signs as: the last 20 bytes of the keccak hash
/// of its public key, as lowercase `0x` hex.
pub fn agent_address(key: &str) -> Result<String, VenueError> {
    let bytes = decode_key(key)?;
    // SigningKey zeroes itself on drop.
    let signing = k256::ecdsa::SigningKey::from_bytes((&*bytes).into()).map_err(|_| BAD_KEY)?;
    let point = signing.verifying_key().to_encoded_point(false);
    // Uncompressed: a 0x04 tag, then x and y.
    let hash = Keccak256::digest(&point.as_bytes()[1..]);
    let mut address = String::with_capacity(42);
    address.push_str("0x");
    for b in &hash[12..] {
        address.push_str(&format!("{b:02x}"));
    }
    Ok(address)
}

#[cfg(test)]
mod tests {
    use super::*;

    // The well-known example key from the web3.js / ethers docs.
    const KEY: &str = "0x4c0883a69102937d6231471b5dbb6204fe5129617082792ae468d01a3f362318";
    const ADDRESS: &str = "0x2c7536e3605d9c16a7a3d7b1898e529396a65c23";

    #[test]
    fn derives_the_address_from_a_key() {
        assert_eq!(agent_address(KEY).unwrap(), ADDRESS);
        // Without 0x, in capitals, padded with whitespace.
        let bare = format!("  {}\n", KEY[2..].to_uppercase());
        assert_eq!(agent_address(&bare).unwrap(), ADDRESS);
    }

    #[test]
    fn rejects_what_isnt_a_key() {
        assert_eq!(agent_address("").unwrap_err(), BAD_KEY);
        assert_eq!(agent_address(&KEY[..64]).unwrap_err(), BAD_KEY);
        let not_hex = format!("0x{}", "g".repeat(64));
        assert_eq!(agent_address(&not_hex).unwrap_err(), BAD_KEY);
        // Zero isn't a valid secp256k1 scalar.
        assert_eq!(agent_address(&"0".repeat(64)).unwrap_err(), BAD_KEY);
    }

    #[test]
    fn errors_never_echo_the_input() {
        let key = format!("0x{}zz", &KEY[2..64]);
        let message = format!(
            "{} {:?}",
            agent_address(&key).unwrap_err(),
            agent_address(&key)
        );
        assert!(!message.contains(&KEY[2..20]));
    }

    #[test]
    fn reads_extra_agents() {
        let agents: Vec<ApprovedAgent> = serde_json::from_value(serde_json::json!([
            { "name": "pewterdesk", "address": ADDRESS, "validUntil": 1_790_000_000_000u64 }
        ]))
        .unwrap();
        assert_eq!(agents[0].address, ADDRESS);
        assert_eq!(agents[0].valid_until, 1_790_000_000_000);
    }
}
