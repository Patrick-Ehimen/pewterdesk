//! Bybit API keys: holding one, signing a request with it (HMAC-SHA256), and
//! deciding whether a key is trade-only.
//!
//! Security invariants - review any change here against
//! `.claude/commands/security-review.md`:
//! - The secret lives only in `Zeroizing` memory, inside [`ApiCredentials`],
//!   whose `Debug` prints neither half. Nothing here logs, formats or returns
//!   it; errors are fixed strings.
//! - Signing is crate-private and takes no network types: the adapter signs
//!   the requests it builds itself, never caller-supplied bytes.
//! - A key is trade-only when every permission it holds is on [`ALLOWED`].
//!   It's an allowlist, so a permission Bybit adds later (or one named
//!   differently than expected) refuses the key rather than slipping through.
//!
//! The scheme, per Bybit's V5 docs: the signature is lowercase hex of
//! HMAC-SHA256(secret, timestamp + api key + recv window + payload), where
//! the payload is a GET's query string exactly as sent, or a POST's JSON body.
//! It goes in `X-BAPI-SIGN`, with `X-BAPI-API-KEY`, `X-BAPI-TIMESTAMP` (ms)
//! and `X-BAPI-RECV-WINDOW`. Only HMAC (system-generated) keys are taken, not
//! self-generated RSA ones.

use std::collections::BTreeMap;
use std::fmt;

use hmac::{Hmac, Mac};
use pewterdesk_core::VenueError;
use serde::Deserialize;
use sha2::Sha256;
use zeroize::Zeroizing;

/// How long a signed request stays valid at Bybit, in ms (its default).
pub(crate) const RECV_WINDOW: u64 = 5000;

/// The permissions a stored key may hold, by Bybit's group name: placing,
/// amending and cancelling contract orders, and managing contract positions
/// (leverage, TP/SL). Nothing that moves funds.
pub const ALLOWED: &[(&str, &[&str])] = &[
    ("ContractTrade", &["Order", "Position"]),
    ("Derivatives", &["DerivativesTrade"]),
];

/// A Bybit API key and its secret. Neither half is printed by `Debug`, and
/// the secret is zeroed when this is dropped; hold it only for the call that
/// signs with it.
pub struct ApiCredentials {
    key: String,
    secret: Zeroizing<String>,
}

impl fmt::Debug for ApiCredentials {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("ApiCredentials(..)")
    }
}

/// Bybit's HMAC keys and secrets are short runs of letters and digits.
fn plain(s: &str, min: usize, max: usize) -> bool {
    (min..=max).contains(&s.len()) && s.bytes().all(|b| b.is_ascii_alphanumeric())
}

impl ApiCredentials {
    /// A pasted key and secret, trimmed and checked for shape. The secret
    /// is taken as `Zeroizing` so it is zeroed even when this fails.
    pub fn new(key: &str, secret: Zeroizing<String>) -> Result<Self, VenueError> {
        let key = key.trim();
        let trimmed = secret.trim();
        if !plain(key, 8, 64) {
            return Err(VenueError::InvalidRequest(
                "that doesn't look like a Bybit API key: it's letters and digits only".into(),
            ));
        }
        if !plain(trimmed, 16, 128) {
            return Err(VenueError::InvalidRequest(
                "that doesn't look like a Bybit API secret; use a system-generated (HMAC) key, not an RSA one".into(),
            ));
        }
        let secret = if trimmed.len() == secret.len() {
            secret
        } else {
            Zeroizing::new(trimmed.to_owned())
        };
        Ok(Self {
            key: key.to_owned(),
            secret,
        })
    }

    pub fn api_key(&self) -> &str {
        &self.key
    }

    /// The form kept in the keychain: `key:secret`. Neither half contains a
    /// colon (both are alphanumeric), so it splits back unambiguously.
    pub fn to_stored(&self) -> Zeroizing<String> {
        let mut stored = Zeroizing::new(String::with_capacity(
            self.key.len() + 1 + self.secret.len(),
        ));
        stored.push_str(&self.key);
        stored.push(':');
        stored.push_str(&self.secret);
        stored
    }

    /// Reads back what [`to_stored`](Self::to_stored) wrote.
    pub fn from_stored(stored: &Zeroizing<String>) -> Result<Self, VenueError> {
        let (key, secret) = stored.split_once(':').ok_or_else(|| {
            VenueError::InvalidRequest("the stored Bybit key is malformed; connect it again".into())
        })?;
        Self::new(key, Zeroizing::new(secret.to_owned()))
    }

    /// The `X-BAPI-SIGN` value for a request sent at `timestamp` (ms) with
    /// `payload` (the query string or JSON body). Crate-private: only the
    /// adapter's own requests are signed.
    pub(crate) fn sign(&self, timestamp: u64, recv_window: u64, payload: &str) -> String {
        sign(
            self.secret.as_bytes(),
            timestamp,
            &self.key,
            recv_window,
            payload,
        )
    }
}

fn sign(secret: &[u8], timestamp: u64, api_key: &str, recv_window: u64, payload: &str) -> String {
    let mut mac = Hmac::<Sha256>::new_from_slice(secret).expect("HMAC takes a key of any length");
    mac.update(timestamp.to_string().as_bytes());
    mac.update(api_key.as_bytes());
    mac.update(recv_window.to_string().as_bytes());
    mac.update(payload.as_bytes());
    hex::encode(mac.finalize().into_bytes())
}

/// What `GET /v5/user/query-api` says about the key that signed the request.
/// Only what the check and the UI need; the reply's `secret` field is never
/// read.
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ApiKeyInfo {
    /// 1 for a read-only key, 0 for read-write.
    pub read_only: u8,
    /// Each permission group and what it grants (`"Wallet": ["Withdraw"]`).
    pub permissions: BTreeMap<String, Vec<String>>,
    /// The IPs the key is bound to; `["*"]` when it isn't.
    #[serde(default)]
    pub ips: Vec<String>,
    /// When the key lapses (ISO 8601); keys bound to an IP don't.
    #[serde(default)]
    pub expired_at: String,
    #[serde(rename = "userID")]
    pub user_id: u64,
    #[serde(default)]
    pub is_master: bool,
}

/// What a trade-only key may do, after [`check_trade_only`].
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TradeOnlyKey {
    /// The Bybit account (UID) the key belongs to.
    pub uid: u64,
    pub read_only: bool,
    pub sub_account: bool,
    pub ip_restricted: bool,
    /// When it lapses, if it does (ISO 8601).
    pub expires_at: Option<String>,
    /// What it holds, as `Group.Permission`.
    pub permissions: Vec<String>,
}

/// Accepts the key only if every permission it holds is on [`ALLOWED`].
/// Refuses with the permissions to switch off, so the user can fix the key
/// on Bybit rather than guess.
pub fn check_trade_only(info: &ApiKeyInfo) -> Result<TradeOnlyKey, VenueError> {
    let allowed = |group: &str, permission: &str| {
        ALLOWED
            .iter()
            .any(|(g, ps)| *g == group && ps.contains(&permission))
    };
    let extra: Vec<String> = held_permissions(info)
        .into_iter()
        .filter(|name| {
            let (group, permission) = name.split_once('.').unwrap_or((name, ""));
            !allowed(group, permission)
        })
        .collect();
    if !extra.is_empty() {
        return Err(VenueError::InvalidRequest(format!(
            "this key can do more than trade contracts; switch off {} on Bybit, or make a key with contract trading only",
            extra.join(", ")
        )));
    }
    Ok(describe(info))
}

/// What a key is and holds, with no judgement of its permissions: for a
/// Demo Trading key, which only reaches demo funds on the demo host, so any
/// permission set is accepted. Live keys go through [`check_trade_only`].
pub fn describe(info: &ApiKeyInfo) -> TradeOnlyKey {
    let ip_restricted = !info.ips.is_empty() && !info.ips.iter().any(|ip| ip == "*");
    TradeOnlyKey {
        uid: info.user_id,
        read_only: info.read_only == 1,
        sub_account: !info.is_master,
        ip_restricted,
        expires_at: (!info.expired_at.is_empty()).then(|| info.expired_at.clone()),
        permissions: held_permissions(info),
    }
}

/// Every permission the key holds, as `Group.Permission`.
fn held_permissions(info: &ApiKeyInfo) -> Vec<String> {
    info.permissions
        .iter()
        .flat_map(|(group, permissions)| permissions.iter().map(move |p| format!("{group}.{p}")))
        .collect()
}

/// The prefix of a demo account's id: `demo:{uid}`. Demo accounts trade on
/// Bybit's demo host with demo funds, under keys made in its Demo Trading.
pub const DEMO_PREFIX: &str = "demo:";

/// A Bybit account id: its UID (digits, as Bybit numbers its accounts),
/// with `demo:` in front for a demo account. Returns whether it's demo, and
/// the UID.
pub fn parse_account(id: &str) -> Result<(bool, &str), VenueError> {
    let (demo, uid) = match id.strip_prefix(DEMO_PREFIX) {
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

/// The account id for `uid`, live or demo.
pub fn account_id(uid: u64, demo: bool) -> String {
    if demo {
        format!("{DEMO_PREFIX}{uid}")
    } else {
        uid.to_string()
    }
}

/// The keychain entry the API key for Bybit account `id` lives under -
/// shared by onboarding, which stores it, and the adapter, which reads it:
/// `bybit:{uid}`, or `bybit:demo:{uid}` for a demo account.
pub fn key_account(id: &str) -> Result<String, VenueError> {
    parse_account(id)?;
    Ok(format!("bybit:{id}"))
}

/// Bybit's auth failures, said plainly. Other codes keep the venue's message.
pub(crate) fn auth_error(code: i64, message: String) -> VenueError {
    VenueError::InvalidRequest(match code {
        10002 => "the request reached Bybit too late (a slow connection or this computer's clock); try again".into(),
        10003 => "Bybit doesn't recognise that API key".into(),
        10004 => "the API secret doesn't match the key".into(),
        10005 => "the key doesn't have the permission this needs".into(),
        10010 => "this key is bound to other IP addresses than this computer's".into(),
        _ => message,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    const KEY: &str = "XXXXXXXXXXXXXXXXXX";
    const SECRET: &str = "YYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYY";

    fn creds() -> ApiCredentials {
        ApiCredentials::new(KEY, Zeroizing::new(SECRET.into())).unwrap()
    }

    fn info(permissions: &[(&str, &[&str])]) -> ApiKeyInfo {
        ApiKeyInfo {
            read_only: 0,
            permissions: permissions
                .iter()
                .map(|(g, ps)| (g.to_string(), ps.iter().map(|p| p.to_string()).collect()))
                .collect(),
            ips: vec!["*".into()],
            expired_at: "2027-01-01T00:00:00Z".into(),
            user_id: 1234567,
            is_master: false,
        }
    }

    /// The vector is HMAC-SHA256 over the documented concatenation, computed
    /// independently (`openssl dgst -sha256 -hmac`), so a change to the
    /// order or encoding fails here.
    #[test]
    fn signs_timestamp_key_window_payload() {
        let sig = creds().sign(1658384314791, 5000, "category=linear&symbol=BTCUSDT");
        assert_eq!(
            sig,
            "af3133994322e5188bc766d9e5c41ae6767194e275403da6e68ea1d9ba908a3c"
        );
    }

    #[test]
    fn signature_depends_on_every_part() {
        let c = creds();
        let base = c.sign(1, 5000, "a=1");
        assert_ne!(base, c.sign(2, 5000, "a=1"));
        assert_ne!(base, c.sign(1, 5001, "a=1"));
        assert_ne!(base, c.sign(1, 5000, "a=2"));
        let other = ApiCredentials::new(KEY, Zeroizing::new("Z".repeat(36))).unwrap();
        assert_ne!(base, other.sign(1, 5000, "a=1"));
        assert_eq!(base.len(), 64);
        assert!(base
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)));
    }

    #[test]
    fn debug_hides_the_key_and_secret() {
        let shown = format!("{:?}", creds());
        assert!(!shown.contains(KEY) && !shown.contains(SECRET), "{shown}");
    }

    #[test]
    fn rejects_malformed_keys() {
        let secret = || Zeroizing::new(SECRET.to_owned());
        assert!(ApiCredentials::new("", secret()).is_err());
        assert!(ApiCredentials::new("short", secret()).is_err());
        assert!(ApiCredentials::new("has space in it", secret()).is_err());
        let rsa = Zeroizing::new("-----BEGIN PRIVATE KEY-----\nMIIE".to_owned());
        assert!(ApiCredentials::new(KEY, rsa).is_err());
        // Whitespace around a paste is fine.
        let padded =
            ApiCredentials::new(&format!(" {KEY}\n"), Zeroizing::new(format!("{SECRET} ")));
        assert_eq!(padded.unwrap().api_key(), KEY);
    }

    #[test]
    fn stored_form_round_trips() {
        let stored = creds().to_stored();
        assert_eq!(stored.as_str(), format!("{KEY}:{SECRET}"));
        let back = ApiCredentials::from_stored(&stored).unwrap();
        assert_eq!(back.api_key(), KEY);
        assert_eq!(back.sign(1, 5000, ""), creds().sign(1, 5000, ""));
        assert!(ApiCredentials::from_stored(&Zeroizing::new("no-colon".into())).is_err());
    }

    #[test]
    fn accepts_contract_trading_only() {
        let ok = check_trade_only(&info(&[
            ("ContractTrade", &["Order", "Position"]),
            ("Spot", &[]),
            ("Wallet", &[]),
        ]))
        .unwrap();
        assert_eq!(ok.uid, 1234567);
        assert_eq!(
            ok.permissions,
            ["ContractTrade.Order", "ContractTrade.Position"]
        );
        assert!(ok.sub_account && !ok.ip_restricted && !ok.read_only);
        assert_eq!(ok.expires_at.as_deref(), Some("2027-01-01T00:00:00Z"));
    }

    #[test]
    fn refuses_keys_that_move_funds() {
        for (group, permission) in [
            ("Wallet", "Withdraw"),
            ("Wallet", "AccountTransfer"),
            ("Wallet", "SubMemberTransfer"),
            ("Spot", "SpotTrade"),
            ("Exchange", "ExchangeHistory"),
            // A group this code has never heard of is refused too.
            ("SomethingNew", "Anything"),
            // An unknown permission in an allowed group as well.
            ("ContractTrade", "Withdraw"),
        ] {
            let perms: &[(&str, &[&str])] =
                &[("ContractTrade", &["Order"]), (group, &[permission])];
            let err = check_trade_only(&info(perms)).unwrap_err();
            assert!(
                matches!(&err, VenueError::InvalidRequest(m) if m.contains(&format!("{group}.{permission}"))),
                "{group}.{permission}: {err:?}"
            );
        }
    }

    #[test]
    fn describing_a_demo_key_accepts_any_permissions() {
        let i = info(&[
            ("ContractTrade", &["Order", "Position"]),
            ("Wallet", &["AccountTransfer"]),
            ("Spot", &["SpotTrade"]),
        ]);
        assert!(check_trade_only(&i).is_err());
        let k = describe(&i);
        assert_eq!(k.uid, 1234567);
        assert_eq!(
            k.permissions,
            [
                "ContractTrade.Order",
                "ContractTrade.Position",
                "Spot.SpotTrade",
                "Wallet.AccountTransfer"
            ]
        );
    }

    #[test]
    fn reads_ip_binding_and_read_only() {
        let mut i = info(&[("ContractTrade", &["Order"])]);
        i.ips = vec!["203.0.113.7".into()];
        i.read_only = 1;
        i.is_master = true;
        i.expired_at = String::new();
        let k = check_trade_only(&i).unwrap();
        assert!(k.ip_restricted && k.read_only && !k.sub_account);
        assert_eq!(k.expires_at, None);
    }

    #[test]
    fn parses_the_documented_reply() {
        let reply = serde_json::json!({
            "id": "13770661", "note": "pewterdesk", "apiKey": KEY, "readOnly": 0,
            "secret": "", "permissions": {
                "ContractTrade": ["Order", "Position"], "Spot": [], "Wallet": [],
                "Options": [], "Derivatives": [], "CopyTrading": [], "BlockTrade": [],
                "Exchange": [], "NFT": [], "Affiliate": []
            },
            "ips": ["*"], "type": 1, "deadlineDay": 83, "expiredAt": "2026-12-23T07:20:25Z",
            "createdAt": "2026-09-23T07:20:25Z", "unified": 0, "uta": 1,
            "userID": 24617703, "inviterID": 0, "vipLevel": "No VIP",
            "mktMakerLevel": "0", "affiliateID": 0, "rsaPublicKey": "",
            "isMaster": true, "parentUid": "0", "kycLevel": "LEVEL_DEFAULT", "kycRegion": ""
        });
        let info: ApiKeyInfo = serde_json::from_value(reply).unwrap();
        let k = check_trade_only(&info).unwrap();
        assert_eq!(k.uid, 24617703);
        assert!(!k.sub_account);
    }

    #[test]
    fn key_accounts_are_digit_uids() {
        assert_eq!(key_account("24617703").unwrap(), "bybit:24617703");
        assert_eq!(key_account("demo:24617703").unwrap(), "bybit:demo:24617703");
        for bad in [
            "",
            "abc",
            "0x12",
            "12 34",
            "1:2",
            "123456789012345678901",
            "demo:",
            "demo:abc",
            "live:123",
            "demo:demo:1",
        ] {
            assert!(key_account(bad).is_err(), "{bad:?}");
        }
    }

    #[test]
    fn account_ids_carry_the_environment() {
        assert_eq!(parse_account("24617703").unwrap(), (false, "24617703"));
        assert_eq!(parse_account("demo:24617703").unwrap(), (true, "24617703"));
        assert_eq!(account_id(24617703, true), "demo:24617703");
        assert_eq!(account_id(24617703, false), "24617703");
    }

    #[test]
    fn auth_failures_read_plainly() {
        let m = |code| match auth_error(code, "raw".into()) {
            VenueError::InvalidRequest(m) => m,
            _ => unreachable!(),
        };
        assert!(m(10002).contains("too late"));
        assert!(m(10004).contains("secret"));
        assert_eq!(m(99999), "raw");
    }
}
