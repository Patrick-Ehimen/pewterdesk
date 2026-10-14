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
//!   wallet's signature recovers to the main address before it's sent.
//! - The agent's key signs one thing: an order or cancel action built by
//!   `orders.rs` ([`sign_action`], which takes that module's own type, not
//!   bytes). The key is decoded into `Zeroizing` memory for that call and
//!   dropped. It never signs an approval, a transfer or a withdrawal -
//!   those are "user-signed actions" in another EIP-712 domain, which this
//!   key isn't used in.

use k256::ecdsa::{RecoveryId, Signature, SigningKey, VerifyingKey};
use pewterdesk_core::{KeyError, VenueError};
use rand_core::OsRng;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha3::{Digest, Keccak256};
use zeroize::Zeroizing;

use crate::orders::Wire;

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

/// The domain every agent-signed ("L1") action uses, on either network.
const L1_DOMAIN_NAME: &str = "Exchange";
const L1_CHAIN_ID: u64 = 1337;
const L1_AGENT_TYPE: &str = "Agent(string source,bytes32 connectionId)";

/// What an action's signature commits to: its MessagePack encoding, the
/// nonce, and "no vault" - the SDK's `action_hash` with no vault address
/// and no expiry.
fn action_hash(action: &Wire, nonce: u64) -> [u8; 32] {
    let mut data = action.packed();
    data.extend(nonce.to_be_bytes());
    data.push(0);
    keccak(&data)
}

/// The EIP-712 digest for an L1 action: a "phantom agent" whose
/// `connectionId` is the action's hash and whose `source` names the
/// network, so a signature for one can't be replayed on the other.
fn l1_signing_hash(connection_id: &[u8; 32], chain: &str) -> Result<[u8; 32], VenueError> {
    let source: &[u8] = match chain {
        "Mainnet" => b"a",
        "Testnet" => b"b",
        _ => return Err(VenueError::InvalidRequest("unknown network".into())),
    };
    let mut domain = Vec::with_capacity(5 * 32);
    domain.extend(keccak(DOMAIN_TYPE.as_bytes()));
    domain.extend(keccak(L1_DOMAIN_NAME.as_bytes()));
    domain.extend(keccak(b"1"));
    domain.extend(uint_word(L1_CHAIN_ID));
    domain.extend(address_word(ZERO_ADDRESS)?);

    let mut message = Vec::with_capacity(3 * 32);
    message.extend(keccak(L1_AGENT_TYPE.as_bytes()));
    message.extend(keccak(source));
    message.extend(connection_id);

    let mut digest = Vec::with_capacity(66);
    digest.extend([0x19, 0x01]);
    digest.extend(keccak(&domain));
    digest.extend(keccak(&message));
    Ok(keccak(&digest))
}

/// The agent's signature over `action` (an order or cancel `orders.rs`
/// built) with `nonce`, as the exchange endpoint takes it. `key` is held
/// only to make it. Laid out as the official Python SDK's `sign_l1_action`.
pub(crate) fn sign_action(
    key: &str,
    action: &Wire,
    nonce: u64,
    chain: &str,
) -> Result<Value, VenueError> {
    let hash = l1_signing_hash(&action_hash(action, nonce), chain)?;
    let bytes = decode_key(key)?;
    // SigningKey zeroes itself on drop.
    let signing = SigningKey::from_bytes((&*bytes).into()).map_err(|_| BAD_KEY)?;
    let (signature, recovery) = signing
        .sign_prehash_recoverable(&hash)
        .map_err(|_| VenueError::Key(KeyError::Backend("the order couldn't be signed")))?;
    let bytes = signature.to_bytes();
    let mut r = [0u8; 32];
    let mut s = [0u8; 32];
    r.copy_from_slice(&bytes[..32]);
    s.copy_from_slice(&bytes[32..]);
    Ok(WalletSignature {
        r,
        s,
        v: 27 + recovery.to_byte(),
    }
    .to_json())
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

    /// The key the official Python SDK's signing tests use, and its
    /// signatures (`tests/signing_test.py`), zero-padded to 32 bytes.
    const SDK_KEY: &str = "0x0123456789012345678901234567890123456789012345678901234567890123";

    fn str(s: &str) -> Wire {
        Wire::Str(s.into())
    }

    /// One ETH order (asset 1), 100 at 100, as the SDK's tests build it.
    fn sdk_order(kind: Wire, client_id: Option<&str>) -> Wire {
        let mut order = vec![
            ("a", Wire::Uint(1)),
            ("b", Wire::Bool(true)),
            ("p", str("100")),
            ("s", str("100")),
            ("r", Wire::Bool(false)),
            ("t", kind),
        ];
        if let Some(id) = client_id {
            order.push(("c", str(id)));
        }
        Wire::Map(vec![
            ("type", str("order")),
            ("orders", Wire::List(vec![Wire::Map(order)])),
            ("grouping", str("na")),
        ])
    }

    fn gtc() -> Wire {
        Wire::Map(vec![("limit", Wire::Map(vec![("tif", str("Gtc"))]))])
    }

    fn signed(action: &Wire, chain: &str) -> (String, String, u64) {
        let sig = sign_action(SDK_KEY, action, 0, chain).unwrap();
        (
            sig["r"].as_str().unwrap().to_owned(),
            sig["s"].as_str().unwrap().to_owned(),
            sig["v"].as_u64().unwrap(),
        )
    }

    #[test]
    fn the_action_hash_matches_the_sdks() {
        // test_phantom_agent_creation_matches_production
        let action = Wire::Map(vec![
            ("type", str("order")),
            (
                "orders",
                Wire::List(vec![Wire::Map(vec![
                    ("a", Wire::Uint(4)),
                    ("b", Wire::Bool(true)),
                    ("p", str("1670.1")),
                    ("s", str("0.0147")),
                    ("r", Wire::Bool(false)),
                    (
                        "t",
                        Wire::Map(vec![("limit", Wire::Map(vec![("tif", str("Ioc"))]))]),
                    ),
                ])]),
            ),
            ("grouping", str("na")),
        ]);
        let mut hex = String::new();
        push_hex(&mut hex, &action_hash(&action, 1_677_777_606_040));
        assert_eq!(
            hex,
            "0fcbeda5ae3c4950a548021552a4fea2226858c4453571bf3f24ba017eac2908"
        );
    }

    #[test]
    fn actions_are_signed_as_the_sdk_signs_them() {
        // test_l1_action_signing_matches
        let dummy = Wire::Map(vec![
            ("type", str("dummy")),
            ("num", Wire::Uint(100_000_000_000)),
        ]);
        assert_eq!(
            signed(&dummy, "Mainnet"),
            (
                "0x053749d5b30552aeb2fca34b530185976545bb22d0b3ce6f62e31be961a59298".into(),
                "0x755c40ba9bf05223521753995abb2f73ab3229be8ec921f350cb447e384d8ed8".into(),
                27
            )
        );
        assert_eq!(
            signed(&dummy, "Testnet"),
            (
                "0x542af61ef1f429707e3c76c5293c80d01f74ef853e34b76efffcb57e574f9510".into(),
                "0x17b8b32f086e8cdede991f1e2c529f5dd5297cbe8128500e00cbaf766204a613".into(),
                28
            )
        );
        // test_l1_action_signing_order_matches
        let order = sdk_order(gtc(), None);
        assert_eq!(
            signed(&order, "Mainnet"),
            (
                "0xd65369825a9df5d80099e513cce430311d7d26ddf477f5b3a33d2806b100d78e".into(),
                "0x2b54116ff64054968aa237c20ca9ff68000f977c93289157748a3162b6ea940e".into(),
                28
            )
        );
        assert_eq!(
            signed(&order, "Testnet"),
            (
                "0x82b2ba28e76b3d761093aaded1b1cdad4960b3af30212b343fb2e6cdfa4e3d54".into(),
                "0x6b53878fc99d26047f4d7e8c90eb98955a109f44209163f52d8dc4278cbbd9f5".into(),
                27
            )
        );
        // test_l1_action_signing_order_with_cloid_matches
        let with_id = sdk_order(gtc(), Some("0x00000000000000000000000000000001"));
        assert_eq!(
            signed(&with_id, "Mainnet"),
            (
                "0x041ae18e8239a56cacbc5dad94d45d0b747e5da11ad564077fcac71277a946e3".into(),
                "0x3c61f667e747404fe7eea8f90ab0e76cc12ce60270438b2058324681a00116da".into(),
                27
            )
        );
        // test_l1_action_signing_tpsl_order_matches
        let stop = sdk_order(
            Wire::Map(vec![(
                "trigger",
                Wire::Map(vec![
                    ("isMarket", Wire::Bool(true)),
                    ("triggerPx", str("103")),
                    ("tpsl", str("sl")),
                ]),
            )]),
            None,
        );
        assert_eq!(
            signed(&stop, "Mainnet"),
            (
                "0x98343f2b5ae8e26bb2587daad3863bc70d8792b09af1841b6fdd530a2065a3f9".into(),
                "0x6b5bb6bb0633b710aa22b721dd9dee6d083646a5f8e581a20b545be6c1feb405".into(),
                27
            )
        );
        assert_eq!(
            signed(&stop, "Testnet"),
            (
                "0x971c554d917c44e0e1b6cc45d8f9404f32172a9d3b3566262347d0302896a2e4".into(),
                "0x206257b104788f80450f8e786c329daa589aa0b32ba96948201ae556d5637eac".into(),
                28
            )
        );
    }

    #[test]
    fn a_different_action_nonce_or_network_is_a_different_signature() {
        let order = sdk_order(gtc(), None);
        let base = sign_action(SDK_KEY, &order, 0, "Mainnet").unwrap();
        assert_ne!(sign_action(SDK_KEY, &order, 1, "Mainnet").unwrap(), base);
        assert_ne!(sign_action(SDK_KEY, &order, 0, "Testnet").unwrap(), base);
        let other = sdk_order(gtc(), Some("0x00000000000000000000000000000001"));
        assert_ne!(sign_action(SDK_KEY, &other, 0, "Mainnet").unwrap(), base);
        // Nothing is signed for a network that isn't one, or without a key.
        assert!(sign_action(SDK_KEY, &order, 0, "Devnet").is_err());
        assert_eq!(
            sign_action("not a key", &order, 0, "Mainnet").unwrap_err(),
            BAD_KEY
        );
    }

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
