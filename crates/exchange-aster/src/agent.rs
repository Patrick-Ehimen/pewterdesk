//! The API wallet (agent): the trade-only key pewterdesk stores for Aster,
//! and the two signatures around it. Aster's V3 API has no API key or
//! secret: every private request carries the agent's address, a nonce and
//! the agent's signature, and the agent acts for the account that approved
//! it.
//!
//! Security-sensitive - review any change against
//! `.claude/commands/security-review.md`:
//! - Approving an agent ([`ApproveAgent`]) is signed by the user's main
//!   wallet, never here. This module builds the exact message, with the
//!   agent's permissions fixed in the code: perpetuals only, no spot, and
//!   **no withdrawals**. Nothing a caller passes can turn withdrawals on.
//!   It checks the wallet's signature recovers to the main address before
//!   the approval is sent.
//! - Requests are signed with the agent's key ([`sign_request`]), over
//!   exactly the parameter string that is sent. The key is decoded into
//!   `Zeroizing` memory for that one call and dropped. Nothing here logs,
//!   formats or returns it.
//! - [`check_trade_only`] reads back what Aster says the agent may do, and
//!   refuses one that can withdraw: an approval made or changed elsewhere
//!   isn't trusted.
//! - Errors are fixed strings, never built from a key.
//!
//! The scheme, per Aster's V3 docs (`asterdex/api-docs`, "Authentication
//! signature payload" and "Register and Approve Agent"), checked against
//! the live API and against `eth_account`'s EIP-712 encoding: both
//! signatures are EIP-712 typed data in the `AsterSignTransaction` domain,
//! of one type, `Message(string msg)`, whose `msg` is the request's
//! parameters as `key=value` joined by `&`. The approval's domain carries
//! the chain the main wallet is on, named in the message as
//! `signatureChainId`: the docs give 56 (BNB Chain), but the live API takes
//! others (Arbitrum and Ethereum were tried), so the wallet signs where it
//! already is. The agent's requests use 1666, Aster's own chain.

use k256::ecdsa::{RecoveryId, Signature, SigningKey, VerifyingKey};
use pewterdesk_core::{KeyError, VenueError};
use rand_core::OsRng;
use serde::Deserialize;
use serde_json::{json, Value};
use sha3::{Digest, Keccak256};
use zeroize::Zeroizing;

/// The name pewterdesk approves its agent under.
pub const AGENT_NAME: &str = "pewterdesk";
/// Aster Chain's id: the domain every agent-signed request uses.
const REQUEST_CHAIN_ID: u64 = 1666;
/// How long an approval lasts: Aster wants a deadline, and this is far
/// enough out that reconnecting isn't a chore. The user can revoke sooner.
pub const APPROVAL_FOR_MS: u64 = 365 * 24 * 60 * 60 * 1000;

/// The keychain entry the API wallet for Aster account `address` lives
/// under - shared by onboarding, which stores it, and the adapter, which
/// reads it. `address` is the main account, lowercase `0x` hex.
pub fn key_account(address: &str) -> Result<String, VenueError> {
    if is_address(address) {
        Ok(format!("aster:{address}"))
    } else {
        Err(VenueError::InvalidRequest(
            "an Aster account is its address: 0x followed by 40 hex characters".into(),
        ))
    }
}

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

/// The key as k256 takes it. `SigningKey` zeroes itself on drop.
fn signing_key(key: &str) -> Result<SigningKey, VenueError> {
    let bytes = decode_key(key)?;
    SigningKey::from_bytes((&*bytes).into()).map_err(|_| BAD_KEY)
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
    Ok(address_of(signing_key(key)?.verifying_key()))
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

const DOMAIN_TYPE: &str =
    "EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)";
const MESSAGE_TYPE: &str = "Message(string msg)";
const DOMAIN_NAME: &str = "AsterSignTransaction";
const ZERO_ADDRESS: &str = "0x0000000000000000000000000000000000000000";

fn uint_word(n: u64) -> [u8; 32] {
    let mut word = [0u8; 32];
    word[24..].copy_from_slice(&n.to_be_bytes());
    word
}

/// The EIP-712 digest of `Message { msg }` in Aster's domain on `chain_id`.
fn message_hash(msg: &str, chain_id: u64) -> [u8; 32] {
    let mut domain = Vec::with_capacity(5 * 32);
    domain.extend(keccak(DOMAIN_TYPE.as_bytes()));
    domain.extend(keccak(DOMAIN_NAME.as_bytes()));
    domain.extend(keccak(b"1"));
    domain.extend(uint_word(chain_id));
    // The verifying contract is the zero address: a word of zeroes.
    domain.extend([0u8; 32]);

    let mut message = Vec::with_capacity(2 * 32);
    message.extend(keccak(MESSAGE_TYPE.as_bytes()));
    message.extend(keccak(msg.as_bytes()));

    let mut digest = Vec::with_capacity(66);
    digest.extend([0x19, 0x01]);
    digest.extend(keccak(&domain));
    digest.extend(keccak(&message));
    keccak(&digest)
}

/// Lowercase `0x` + 40 hex: the only shape an address goes into a signed
/// message in, so nothing in one can add a parameter to it.
fn is_address(address: &str) -> bool {
    address.len() == 42
        && address.starts_with("0x")
        && address[2..]
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

/// Approving an API wallet for an account: what the main wallet signs, and
/// what's posted to `/fapi/v3/registerAndApproveAgent`.
///
/// The agent's permissions aren't fields: they're written into [`Self::msg`]
/// as perpetuals on, spot off, withdrawals off, with no IP list (Aster only
/// requires one for an agent that can withdraw).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ApproveAgent {
    /// The main account, lowercase `0x` hex.
    pub user: String,
    /// The API wallet being approved, lowercase `0x` hex.
    pub agent_address: String,
    /// The chain the wallet signs on (the EIP-712 domain's chain id), which
    /// the message names too. Wallets want the one they're connected to.
    pub signature_chain_id: u64,
    /// Microseconds since the epoch; Aster wants it within 10 seconds of
    /// its clock, and unused.
    pub nonce: u64,
    /// When the approval lapses, in milliseconds since the epoch.
    pub expired: u64,
}

impl ApproveAgent {
    /// An approval of `agent_address` for `user`, from `now_micros`, to be
    /// signed on `signature_chain_id`.
    pub fn new(
        user: &str,
        agent_address: &str,
        signature_chain_id: u64,
        now_micros: u64,
    ) -> Result<Self, VenueError> {
        if signature_chain_id == 0 {
            return Err(VenueError::InvalidRequest(
                "the wallet's chain is unknown".into(),
            ));
        }
        if !is_address(user) || !is_address(agent_address) {
            return Err(VenueError::InvalidRequest(
                "an address is 0x followed by 40 hex characters".into(),
            ));
        }
        Ok(Self {
            user: user.to_owned(),
            agent_address: agent_address.to_owned(),
            signature_chain_id,
            nonce: now_micros,
            expired: now_micros / 1000 + APPROVAL_FOR_MS,
        })
    }

    /// The parameters, in the order Aster's docs sign them. The signature
    /// goes on the end when they're posted.
    fn params(&self) -> [(&'static str, String); 10] {
        [
            ("user", self.user.clone()),
            ("nonce", self.nonce.to_string()),
            ("agentName", AGENT_NAME.to_owned()),
            ("agentAddress", self.agent_address.clone()),
            ("expired", self.expired.to_string()),
            ("signatureChainId", self.signature_chain_id.to_string()),
            ("canSpotTrade", "false".to_owned()),
            ("canPerpTrade", "true".to_owned()),
            ("canWithdraw", "false".to_owned()),
            ("ipWhitelist", String::new()),
        ]
    }

    /// The message body that's signed: `key=value` joined by `&`.
    pub fn msg(&self) -> String {
        join(&self.params())
    }

    /// The EIP-712 digest the wallet signs.
    pub fn signing_hash(&self) -> [u8; 32] {
        message_hash(&self.msg(), self.signature_chain_id)
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
                "Message": [{ "name": "msg", "type": "string" }],
            },
            "primaryType": "Message",
            "message": { "msg": self.msg() },
        })
    }

    /// The form posted to Aster: the signed parameters and the signature.
    pub fn form(&self, signature: &WalletSignature) -> Vec<(&'static str, String)> {
        let mut form = self.params().to_vec();
        form.push(("signature", signature.to_hex()));
        form
    }
}

fn join(params: &[(&str, String)]) -> String {
    let mut out = String::new();
    for (i, (key, value)) in params.iter().enumerate() {
        if i > 0 {
            out.push('&');
        }
        out.push_str(key);
        out.push('=');
        out.push_str(value);
    }
    out
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

    /// As Aster takes it: `0x`, then r, s and v in hex.
    pub fn to_hex(&self) -> String {
        let mut out = String::with_capacity(132);
        out.push_str("0x");
        push_hex(&mut out, &self.r);
        push_hex(&mut out, &self.s);
        push_hex(&mut out, &[self.v]);
        out
    }
}

/// A request's parameters, signed by the agent: the query string to send,
/// `signer`, `nonce` and `signature` included.
///
/// `params` are the request's own, as `(name, value)`; names and values must
/// be plain (letters, digits and `._-`), which every request this adapter
/// builds is, so the string that's signed is the string that's sent, byte
/// for byte, with nothing for URL encoding to change.
pub fn sign_request(
    key: &str,
    params: &[(&str, String)],
    nonce_micros: u64,
) -> Result<String, VenueError> {
    let plain = |s: &str| {
        !s.is_empty()
            && s.bytes()
                .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b'-'))
    };
    if !params.iter().all(|(k, v)| plain(k) && plain(v)) {
        return Err(VenueError::InvalidRequest(
            "a request parameter has characters that can't be signed as they are".into(),
        ));
    }
    let signing = signing_key(key)?;
    let mut all: Vec<(&str, String)> = params.to_vec();
    all.push(("signer", address_of(signing.verifying_key())));
    all.push(("nonce", nonce_micros.to_string()));
    let mut query = join(&all);

    let hash = message_hash(&query, REQUEST_CHAIN_ID);
    let (signature, recovery) = signing
        .sign_prehash_recoverable(&hash)
        .map_err(|_| VenueError::Key(KeyError::Backend("the request couldn't be signed")))?;
    query.push_str("&signature=0x");
    push_hex(&mut query, &signature.to_bytes());
    push_hex(&mut query, &[27 + recovery.to_byte()]);
    Ok(query)
}

/// An agent approved for an account, as `GET /fapi/v3/agent` lists it.
#[derive(Clone, Debug, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ApprovedAgent {
    pub agent_address: String,
    #[serde(default)]
    pub agent_name: String,
    /// When the approval lapses, in ms since the epoch.
    #[serde(default)]
    pub expired: u64,
    /// Missing reads as true: an agent that might withdraw is refused.
    #[serde(default = "yes")]
    pub can_withdraw: bool,
    #[serde(default = "yes")]
    pub can_spot_trade: bool,
    #[serde(default)]
    pub can_perp_trade: bool,
}

fn yes() -> bool {
    true
}

/// The entry for `agent` among the account's approved agents, if it's one
/// pewterdesk may hold: it trades perpetuals, and can neither withdraw nor
/// trade spot. Anything else is refused, with why.
pub fn check_trade_only(
    agent: &str,
    approved: Vec<ApprovedAgent>,
    now_ms: u64,
) -> Result<ApprovedAgent, VenueError> {
    let found = approved
        .into_iter()
        .find(|a| a.agent_address.eq_ignore_ascii_case(agent))
        .ok_or_else(|| {
            VenueError::InvalidRequest("this API wallet isn't approved on Aster".into())
        })?;
    if found.can_withdraw {
        return Err(VenueError::InvalidRequest(
            "this API wallet can withdraw on Aster; pewterdesk only keeps one that can't".into(),
        ));
    }
    if found.can_spot_trade || !found.can_perp_trade {
        return Err(VenueError::InvalidRequest(
            "this API wallet's permissions on Aster aren't perpetuals only".into(),
        ));
    }
    if found.expired != 0 && found.expired <= now_ms {
        return Err(VenueError::InvalidRequest(
            "this API wallet's approval on Aster has expired; connect again".into(),
        ));
    }
    Ok(found)
}

#[cfg(test)]
mod tests {
    use super::*;

    // The well-known example key from the web3.js / ethers docs.
    const KEY: &str = "0x4c0883a69102937d6231471b5dbb6204fe5129617082792ae468d01a3f362318";
    const ADDRESS: &str = "0x2c7536e3605d9c16a7a3d7b1898e529396a65c23";
    const AGENT: &str = "0x15e995b216908f03d22f64772e3560b374da43a0";

    fn hex(bytes: &[u8]) -> String {
        let mut out = String::new();
        push_hex(&mut out, bytes);
        out
    }

    fn approval() -> ApproveAgent {
        ApproveAgent {
            user: ADDRESS.into(),
            agent_address: AGENT.into(),
            signature_chain_id: 56,
            nonce: 1_791_450_680_085_530,
            expired: 1_807_002_680_085,
        }
    }

    /// The message Aster's live API accepted, and its digest and signature
    /// as `eth_account` (`encode_typed_data`, `sign_message`) computes them
    /// for this key: an independent implementation of EIP-712.
    #[test]
    fn the_approval_matches_the_reference_encoding() {
        let approval = approval();
        assert_eq!(
            approval.msg(),
            "user=0x2c7536e3605d9c16a7a3d7b1898e529396a65c23&nonce=1791450680085530&agentName=pewterdesk&agentAddress=0x15e995b216908f03d22f64772e3560b374da43a0&expired=1807002680085&signatureChainId=56&canSpotTrade=false&canPerpTrade=true&canWithdraw=false&ipWhitelist="
        );
        assert_eq!(
            hex(&approval.signing_hash()),
            "ef1543b5e0e7c04aa266b26ceb3a520148ab48dde0274254c2832ffcfeccea51"
        );
        let signature = WalletSignature::parse("27e7c7ef3170c151788ceeca871096cd84ee52326ed4f5db1a028c8b89f8031c2fd852e609c1ff0c312c3637a89ca70494b0ca7a51d27c207fda052f49bb82291c").unwrap();
        assert_eq!(signature.signer(&approval.signing_hash()).unwrap(), ADDRESS);
        // The typed data a wallet is shown carries the same message and chain.
        let typed = approval.typed_data();
        assert_eq!(typed["message"]["msg"], approval.msg());
        assert_eq!(typed["domain"]["chainId"], 56);
        assert_eq!(typed["primaryType"], "Message");
        // And what's posted is those parameters, then the signature.
        let form = approval.form(&signature);
        assert_eq!(form.len(), 11);
        assert_eq!(form[10].0, "signature");
        assert!(form[10].1.starts_with("0x27e7c7ef") && form[10].1.ends_with("1c"));
    }

    /// Withdrawals and spot stay off whatever the approval is made from.
    #[test]
    fn an_approval_never_grants_withdrawals() {
        let msg = ApproveAgent::new(ADDRESS, AGENT, 42161, 1_791_450_680_085_530)
            .unwrap()
            .msg();
        // It names the chain it's signed on, and the digest follows it.
        assert!(msg.contains("&signatureChainId=42161&"));
        let on = |chain| {
            ApproveAgent::new(ADDRESS, AGENT, chain, 1)
                .unwrap()
                .signing_hash()
        };
        assert_ne!(on(42161), on(56));
        assert!(ApproveAgent::new(ADDRESS, AGENT, 0, 1).is_err());
        assert!(msg.contains("&canWithdraw=false&"));
        assert!(msg.contains("&canSpotTrade=false&"));
        assert!(msg.contains("&canPerpTrade=true&"));
        assert_eq!(msg.matches("canWithdraw").count(), 1);
        // An address that could carry another parameter isn't an address.
        for bad in [
            "0x2c7536e3605d9c16a7a3d7b1898e529396a65c23&canWithdraw=true",
            "0x2C7536E3605D9C16A7A3D7B1898E529396A65C23",
            "2c7536e3605d9c16a7a3d7b1898e529396a65c23",
            "",
        ] {
            assert!(ApproveAgent::new(bad, AGENT, 56, 1).is_err(), "{bad}");
            assert!(ApproveAgent::new(ADDRESS, bad, 56, 1).is_err(), "{bad}");
        }
    }

    /// A signature from another wallet doesn't recover to the account.
    #[test]
    fn a_signature_over_something_else_is_someone_elses() {
        let signature = WalletSignature::parse("27e7c7ef3170c151788ceeca871096cd84ee52326ed4f5db1a028c8b89f8031c2fd852e609c1ff0c312c3637a89ca70494b0ca7a51d27c207fda052f49bb82291c").unwrap();
        let mut other = approval();
        other.nonce += 1;
        assert_ne!(signature.signer(&other.signing_hash()).unwrap(), ADDRESS);
        assert!(WalletSignature::parse("0x1234").is_err());
        assert!(WalletSignature::parse(&"zz".repeat(65)).is_err());
    }

    /// Requests, against the same reference: the digest's signature is the
    /// one `eth_account` makes (signing is deterministic, RFC 6979).
    #[test]
    fn requests_are_signed_as_the_reference_signs_them() {
        assert_eq!(
            sign_request(KEY, &[], 1_791_450_680_085_530).unwrap(),
            "signer=0x2c7536e3605d9c16a7a3d7b1898e529396a65c23&nonce=1791450680085530&signature=0xd1d509b6870ee02414b72365c28bc857837028dc019812aace1aebc2fc284dc90ac176521c382a33495045b11ffb3444388284516c2d4eae9730187d21fa29ed1c"
        );
        assert_eq!(
            sign_request(KEY, &[("symbol", "BTCUSDT".into())], 1_791_450_680_085_531).unwrap(),
            "symbol=BTCUSDT&signer=0x2c7536e3605d9c16a7a3d7b1898e529396a65c23&nonce=1791450680085531&signature=0x2b967e20e597b82331b60871d30848e14815f2c6157f078a3b46aed7c3f3d73f3fb7c5eca11ddfcdd45674ee6e86cee439acff1991b9ca2cb977aadea68dc4941b"
        );
    }

    #[test]
    fn nothing_that_needs_encoding_is_signed() {
        for (name, value) in [
            ("symbol", "BTC&x=1"),
            ("sym bol", "BTC"),
            ("symbol", ""),
            ("a=b", "c"),
        ] {
            assert!(
                sign_request(KEY, &[(name, value.into())], 1).is_err(),
                "{name}={value}"
            );
        }
    }

    #[test]
    fn derives_addresses_and_rejects_what_isnt_a_key() {
        assert_eq!(agent_address(KEY).unwrap(), ADDRESS);
        assert_eq!(agent_address("").unwrap_err(), BAD_KEY);
        assert_eq!(agent_address(&"0".repeat(64)).unwrap_err(), BAD_KEY);
        let (key, address) = generate_agent();
        assert_eq!(agent_address(&key).unwrap(), address);
        // A bad key's error says nothing of the key.
        let secret = format!("0x{}", "g".repeat(64));
        let error = format!("{:?}", sign_request(&secret, &[], 1).unwrap_err());
        assert!(!error.contains("gggg"));
    }

    fn listed(json: &str) -> Vec<ApprovedAgent> {
        serde_json::from_str(json).unwrap()
    }

    #[test]
    fn keeps_only_an_agent_that_cant_withdraw() {
        // As the live API lists an agent pewterdesk approved.
        let ours = r#"[{"agentAddress":"0x15E995B216908F03d22f64772E3560B374Da43a0","agentName":"pewterdesk","ipWhitelist":"","expired":1807002680085,"source":"API","canRead":true,"canSpotTrade":false,"canPerpTrade":true,"canWithdraw":false}]"#;
        let found = check_trade_only(AGENT, listed(ours), 1_800_000_000_000).unwrap();
        assert_eq!(found.agent_name, "pewterdesk");
        // Lapsed.
        assert!(check_trade_only(AGENT, listed(ours), 1_900_000_000_000).is_err());
        // Not this account's agent.
        assert!(check_trade_only(ADDRESS, listed(ours), 1).is_err());
        // One that can withdraw, or trade spot, or can't trade perps.
        for change in [
            ("\"canWithdraw\":false", "\"canWithdraw\":true"),
            ("\"canSpotTrade\":false", "\"canSpotTrade\":true"),
            ("\"canPerpTrade\":true", "\"canPerpTrade\":false"),
            // A listing that doesn't say is taken as one that can.
            (",\"canWithdraw\":false", ""),
        ] {
            let other = ours.replace(change.0, change.1);
            assert!(
                check_trade_only(AGENT, listed(&other), 1).is_err(),
                "{change:?}"
            );
        }
    }
}
