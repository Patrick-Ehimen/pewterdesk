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
//! - Approving an agent ([`ApproveAgent`]) is signed by the user's main
//!   wallet, never here: this module builds the exact action, and checks the
//!   wallet's signature recovers to the main address before it's sent. It
//!   never signs anything itself.

use k256::ecdsa::{RecoveryId, Signature, SigningKey, VerifyingKey};
use pewterdesk_core::{KeyError, VenueError};
use rand_core::OsRng;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha3::{Digest, Keccak256};
use zeroize::Zeroizing;

/// The name pewterdesk approves its agent under. Approving again under the
/// same name replaces the previous agent, so reconnecting doesn't pile up
/// approvals.
pub const AGENT_NAME: &str = "pewterdesk";

const HEX: &[u8; 16] = b"0123456789abcdef";

fn push_hex(out: &mut String, bytes: &[u8]) {
    for b in bytes {
        out.push(HEX[usize::from(b >> 4)] as char);
        out.push(HEX[usize::from(b & 15)] as char);
    }
}

fn keccak(bytes: &[u8]) -> [u8; 32] {
    Keccak256::digest(bytes).into()
}

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

/// The address a public key signs as: the last 20 bytes of the keccak hash
/// of the uncompressed point (without its 0x04 tag), as lowercase `0x` hex.
fn address_of(key: &VerifyingKey) -> String {
    let point = key.to_encoded_point(false);
    let hash = keccak(&point.as_bytes()[1..]);
    let mut address = String::with_capacity(42);
    address.push_str("0x");
    push_hex(&mut address, &hash[12..]);
    address
}

/// The address a private key signs as.
pub fn agent_address(key: &str) -> Result<String, VenueError> {
    let bytes = decode_key(key)?;
    // SigningKey zeroes itself on drop.
    let signing = SigningKey::from_bytes((&*bytes).into()).map_err(|_| BAD_KEY)?;
    Ok(address_of(signing.verifying_key()))
}

/// A new API wallet: a key from the OS's random source, as `0x` hex in
/// `Zeroizing` memory, and its address.
pub fn generate_agent() -> (Zeroizing<String>, String) {
    let signing = SigningKey::random(&mut OsRng);
    let bytes = Zeroizing::new(<[u8; 32]>::from(signing.to_bytes()));
    let mut key = Zeroizing::new(String::with_capacity(66));
    key.push_str("0x");
    push_hex(&mut key, &*bytes);
    (key, address_of(signing.verifying_key()))
}

/// 20 address bytes, left-padded to an ABI word.
fn address_word(address: &str) -> Result<[u8; 32], VenueError> {
    let hex = address.strip_prefix("0x").unwrap_or("").as_bytes();
    let bad =
        || VenueError::InvalidRequest("an address is 0x followed by 40 hex characters".into());
    if hex.len() != 40 {
        return Err(bad());
    }
    let mut word = [0u8; 32];
    for (i, pair) in hex.chunks_exact(2).enumerate() {
        let (Some(hi), Some(lo)) = (nibble(pair[0]), nibble(pair[1])) else {
            return Err(bad());
        };
        word[12 + i] = (hi << 4) | lo;
    }
    Ok(word)
}

fn uint_word(n: u64) -> [u8; 32] {
    let mut word = [0u8; 32];
    word[24..].copy_from_slice(&n.to_be_bytes());
    word
}

/// Approving an API wallet for an account: a Hyperliquid "user-signed
/// action", EIP-712 typed data the main wallet signs. Laid out as the
/// official Python SDK's `approve_agent` / `sign_user_signed_action`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ApproveAgent {
    /// "Mainnet" or "Testnet": signed in, so it can't be replayed across.
    pub chain: &'static str,
    /// The chain the wallet signs on (the EIP-712 domain's chain id).
    /// Hyperliquid takes any; wallets want the one they're connected to.
    pub signature_chain_id: u64,
    pub agent_address: String,
    pub agent_name: String,
    /// Milliseconds since the epoch; Hyperliquid wants it recent and unused.
    pub nonce: u64,
}

const DOMAIN_TYPE: &str =
    "EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)";
const APPROVE_TYPE: &str = "HyperliquidTransaction:ApproveAgent(string hyperliquidChain,address agentAddress,string agentName,uint64 nonce)";
const DOMAIN_NAME: &str = "HyperliquidSignTransaction";
const ZERO_ADDRESS: &str = "0x0000000000000000000000000000000000000000";

impl ApproveAgent {
    /// The EIP-712 digest the wallet signs.
    pub fn signing_hash(&self) -> Result<[u8; 32], VenueError> {
        let mut domain = Vec::with_capacity(5 * 32);
        domain.extend(keccak(DOMAIN_TYPE.as_bytes()));
        domain.extend(keccak(DOMAIN_NAME.as_bytes()));
        domain.extend(keccak(b"1"));
        domain.extend(uint_word(self.signature_chain_id));
        domain.extend(address_word(ZERO_ADDRESS)?);

        let mut message = Vec::with_capacity(5 * 32);
        message.extend(keccak(APPROVE_TYPE.as_bytes()));
        message.extend(keccak(self.chain.as_bytes()));
        message.extend(address_word(&self.agent_address)?);
        message.extend(keccak(self.agent_name.as_bytes()));
        message.extend(uint_word(self.nonce));

        let mut digest = Vec::with_capacity(66);
        digest.extend([0x19, 0x01]);
        digest.extend(keccak(&domain));
        digest.extend(keccak(&message));
        Ok(keccak(&digest))
    }

    /// The typed data for the wallet's `eth_signTypedData_v4`.
    pub fn typed_data(&self) -> Value {
        json!({
            "domain": {
                "name": DOMAIN_NAME,
                "version": "1",
                "chainId": self.signature_chain_id,
                "verifyingContract": ZERO_ADDRESS,
            },
            "types": {
                "EIP712Domain": [
                    { "name": "name", "type": "string" },
                    { "name": "version", "type": "string" },
                    { "name": "chainId", "type": "uint256" },
                    { "name": "verifyingContract", "type": "address" },
                ],
                "HyperliquidTransaction:ApproveAgent": [
                    { "name": "hyperliquidChain", "type": "string" },
                    { "name": "agentAddress", "type": "address" },
                    { "name": "agentName", "type": "string" },
                    { "name": "nonce", "type": "uint64" },
                ],
            },
            "primaryType": "HyperliquidTransaction:ApproveAgent",
            "message": {
                "hyperliquidChain": self.chain,
                "agentAddress": self.agent_address,
                "agentName": self.agent_name,
                "nonce": self.nonce,
            },
        })
    }

    /// The action as the exchange endpoint takes it.
    pub fn action(&self) -> Value {
        json!({
            "type": "approveAgent",
            "hyperliquidChain": self.chain,
            "signatureChainId": format!("0x{:x}", self.signature_chain_id),
            "agentAddress": self.agent_address,
            "agentName": self.agent_name,
            "nonce": self.nonce,
        })
    }
}

/// A wallet's 65-byte signature: r, s, then v (27/28, or 0/1).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct WalletSignature {
    r: [u8; 32],
    s: [u8; 32],
    /// 27 or 28.
    v: u8,
}

const BAD_SIGNATURE: VenueError = VenueError::Key(KeyError::Backend(
    "the wallet's signature isn't 65 bytes of hex",
));

impl WalletSignature {
    pub fn parse(hex: &str) -> Result<Self, VenueError> {
        let hex = hex.trim();
        let hex = hex.strip_prefix("0x").unwrap_or(hex).as_bytes();
        if hex.len() != 130 {
            return Err(BAD_SIGNATURE);
        }
        let mut bytes = [0u8; 65];
        for (i, pair) in hex.chunks_exact(2).enumerate() {
            let (Some(hi), Some(lo)) = (nibble(pair[0]), nibble(pair[1])) else {
                return Err(BAD_SIGNATURE);
            };
            bytes[i] = (hi << 4) | lo;
        }
        let v = match bytes[64] {
            0 | 1 => bytes[64] + 27,
            27 | 28 => bytes[64],
            _ => return Err(BAD_SIGNATURE),
        };
        let mut r = [0u8; 32];
        let mut s = [0u8; 32];
        r.copy_from_slice(&bytes[..32]);
        s.copy_from_slice(&bytes[32..64]);
        Ok(Self { r, s, v })
    }

    /// The address that produced this signature over `hash`.
    pub fn signer(&self, hash: &[u8; 32]) -> Result<String, VenueError> {
        let invalid = VenueError::Key(KeyError::Backend("the wallet's signature is invalid"));
        let signature = Signature::from_scalars(self.r, self.s).map_err(|_| invalid.clone())?;
        let id = RecoveryId::from_byte(self.v - 27).ok_or_else(|| invalid.clone())?;
        let key = VerifyingKey::recover_from_prehash(hash, &signature, id).map_err(|_| invalid)?;
        Ok(address_of(&key))
    }

    /// As the exchange endpoint takes it.
    pub fn to_json(&self) -> Value {
        let word = |bytes: &[u8; 32]| {
            let mut out = String::with_capacity(66);
            out.push_str("0x");
            push_hex(&mut out, bytes);
            out
        };
        json!({ "r": word(&self.r), "s": word(&self.s), "v": self.v })
    }
}

/// What the exchange endpoint said: `{"status":"ok"}`, or `{"status":"err",
/// "response":"<why>"}` with the venue's own message.
pub fn approval_result(body: &Value) -> Result<(), VenueError> {
    match body["status"].as_str() {
        Some("ok") => Ok(()),
        Some("err") => Err(VenueError::Rejected(
            body["response"]
                .as_str()
                .unwrap_or("approval refused")
                .to_owned(),
        )),
        _ => Err(VenueError::Network("unexpected exchange response".into())),
    }
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

    // Checked against viem's hashTypedData / signTypedData (an independent
    // EIP-712 implementation), signing with KEY.
    const AGENT: &str = "0x0d1d9635d0640821d15e323ac8adadfa9c111414";
    const HASH: &str = "7afdcc6b02a9266cfa973c1532d7ae881df2b557d79a41751f2f181b3bf35c95";
    const SIGNATURE: &str = "0x7e690b65cf41e2bd21a3e4fa29230cc74808f04927267d1cf9fa799cfab08efb2a173cf7394b95179acd4382aefe594faf7488dda2766a911731e583d59e76b11c";

    fn approval() -> ApproveAgent {
        ApproveAgent {
            chain: "Mainnet",
            signature_chain_id: 42161,
            agent_address: AGENT.into(),
            agent_name: AGENT_NAME.into(),
            nonce: 1_790_000_000_000,
        }
    }

    fn hex_of(bytes: &[u8]) -> String {
        let mut out = String::new();
        push_hex(&mut out, bytes);
        out
    }

    #[test]
    fn hashes_approve_agent_as_eip712() {
        assert_eq!(hex_of(&approval().signing_hash().unwrap()), HASH);
        // Any field changes the digest: the network, the agent, the nonce.
        let testnet = ApproveAgent {
            chain: "Testnet",
            ..approval()
        };
        assert_ne!(hex_of(&testnet.signing_hash().unwrap()), HASH);
        let later = ApproveAgent {
            nonce: 1_790_000_000_001,
            ..approval()
        };
        assert_ne!(hex_of(&later.signing_hash().unwrap()), HASH);
    }

    #[test]
    fn recovers_the_wallet_that_signed() {
        let hash = approval().signing_hash().unwrap();
        let signature = WalletSignature::parse(SIGNATURE).unwrap();
        assert_eq!(signature.signer(&hash).unwrap(), ADDRESS);
        // Over other data, the same signature recovers someone else.
        let other = ApproveAgent {
            nonce: 1,
            ..approval()
        }
        .signing_hash()
        .unwrap();
        assert_ne!(signature.signer(&other).ok().as_deref(), Some(ADDRESS));
        let json = signature.to_json();
        assert_eq!(json["v"], 28);
        assert_eq!(json["r"].as_str().unwrap().len(), 66);
    }

    #[test]
    fn rejects_malformed_signatures() {
        assert_eq!(WalletSignature::parse("0x1234").unwrap_err(), BAD_SIGNATURE);
        let bad_v = format!("{}05", &SIGNATURE[..130]);
        assert_eq!(WalletSignature::parse(&bad_v).unwrap_err(), BAD_SIGNATURE);
        // v as 0/1 is read as 27/28.
        let zero_one = format!("{}01", &SIGNATURE[..130]);
        assert_eq!(WalletSignature::parse(&zero_one).unwrap().v, 28);
    }

    #[test]
    fn builds_the_action_and_typed_data() {
        let action = approval().action();
        assert_eq!(action["type"], "approveAgent");
        assert_eq!(action["signatureChainId"], "0xa4b1");
        assert_eq!(action["hyperliquidChain"], "Mainnet");
        assert_eq!(action["agentName"], AGENT_NAME);
        let typed = approval().typed_data();
        assert_eq!(typed["primaryType"], "HyperliquidTransaction:ApproveAgent");
        assert_eq!(typed["domain"]["chainId"], 42161);
        assert_eq!(typed["message"]["nonce"], 1_790_000_000_000u64);
    }

    #[test]
    fn generates_usable_keys() {
        let (key, address) = generate_agent();
        assert_eq!(key.len(), 66);
        assert_eq!(agent_address(&key).unwrap(), address);
        let (other, _) = generate_agent();
        assert_ne!(*key, *other);
    }

    #[test]
    fn reads_the_exchange_reply() {
        assert_eq!(
            approval_result(&json!({ "status": "ok", "response": { "type": "default" } })),
            Ok(())
        );
        assert_eq!(
            approval_result(
                &json!({ "status": "err", "response": "Must deposit before performing actions." })
            ),
            Err(VenueError::Rejected(
                "Must deposit before performing actions.".into()
            ))
        );
        assert!(matches!(
            approval_result(&json!({})),
            Err(VenueError::Network(_))
        ));
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
