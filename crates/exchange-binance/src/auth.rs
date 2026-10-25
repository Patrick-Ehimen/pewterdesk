//! Binance API keys: holding one, signing a request with it (HMAC-SHA256),
//! and deciding whether a key is trade-only.
//!
//! Security invariants - review any change here against
//! `.claude/commands/security-review.md`:
//! - The secret lives only in `Zeroizing` memory, inside [`ApiCredentials`],
//!   whose `Debug` prints neither half. Nothing here logs, formats or returns
//!   it; errors are fixed strings or Binance's own messages.
//! - Signing is crate-private and takes no network types: the adapter signs
//!   the requests it builds itself, never caller-supplied bytes.
//! - A key is trade-only when every permission it has switched on is on
//!   [`ALLOWED`], and futures is one of them. It's an allowlist, so a
//!   permission Binance adds later refuses the key rather than slipping
//!   through.
//!
//! The scheme, per Binance's USDⓈ-M "General Info": the signature is hex of
//! HMAC-SHA256(secret, query string), the query string exactly as sent with
//! `timestamp` (ms) and `recvWindow` in it, and goes last in it as
//! `signature`; the key goes in `X-MBX-APIKEY`. Only HMAC (system-generated)
//! keys are taken, not Ed25519 or RSA ones.

use std::collections::BTreeMap;
use std::fmt;

use hmac::{Hmac, Mac};
use pewterdesk_core::VenueError;
use serde::Deserialize;
use sha2::Sha256;
use zeroize::Zeroizing;

/// How long a signed request stays valid at Binance, in ms (its default).
pub(crate) const RECV_WINDOW: u64 = 5000;

/// The `apiRestrictions` fields a stored key may have on: reading, futures
/// trading, the FIX API's read-only access, and an IP binding (a
/// restriction, not a permission). Nothing that moves funds, and nothing
/// that trades anything but futures.
pub const ALLOWED: &[&str] = &[
    "enableReading",
    "enableFutures",
    "enableFixReadOnly",
    "ipRestrict",
];

/// The one permission a trading key must have on.
const FUTURES: &str = "enableFutures";

/// A Binance API key and its secret. Neither half is printed by `Debug`, and
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

/// Binance's HMAC keys and secrets are 64 letters and digits.
fn plain(s: &str, min: usize, max: usize) -> bool {
    (min..=max).contains(&s.len()) && s.bytes().all(|b| b.is_ascii_alphanumeric())
}

impl ApiCredentials {
    /// A pasted key and secret, trimmed and checked for shape. The secret
    /// is taken as `Zeroizing` so it is zeroed even when this fails.
    pub fn new(key: &str, secret: Zeroizing<String>) -> Result<Self, VenueError> {
        let key = key.trim();
        let trimmed = secret.trim();
        if !plain(key, 16, 128) {
            return Err(VenueError::InvalidRequest(
                "that doesn't look like a Binance API key: it's letters and digits only".into(),
            ));
        }
        if !plain(trimmed, 16, 128) {
            return Err(VenueError::InvalidRequest(
                "that doesn't look like a Binance secret key; use a system-generated (HMAC) key, not an Ed25519 or RSA one".into(),
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
            VenueError::InvalidRequest(
                "the stored Binance key is malformed; connect it again".into(),
            )
        })?;
        Self::new(key, Zeroizing::new(secret.to_owned()))
    }

    /// The `signature` value for `query`, the query string exactly as it is
    /// sent (with its `timestamp` and `recvWindow`). Crate-private: only the
    /// adapter's own requests are signed.
    pub(crate) fn sign(&self, query: &str) -> String {
        let mut mac = Hmac::<Sha256>::new_from_slice(self.secret.as_bytes())
            .expect("HMAC takes a key of any length");
        mac.update(query.as_bytes());
        hex::encode(mac.finalize().into_bytes())
    }
}

/// What `GET /sapi/v1/account/apiRestrictions` says about the key that
/// signed it: a flat object of switches (`"enableWithdrawals": false`) and
/// a few other fields (`createTime`). Kept whole, so a switch this code has
/// never heard of is still seen.
#[derive(Clone, Debug, Deserialize)]
#[serde(transparent)]
pub struct ApiRestrictions(pub BTreeMap<String, serde_json::Value>);

impl ApiRestrictions {
    /// The switches that are on, by Binance's field name.
    fn on(&self) -> Vec<String> {
        self.0
            .iter()
            .filter(|(_, v)| v.as_bool() == Some(true))
            .map(|(k, _)| k.clone())
            .collect()
    }
}

/// What a trade-only key is, after [`check_trade_only`].
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TradeOnlyKey {
    /// The Binance account (UID) the key belongs to.
    pub uid: u64,
    pub ip_restricted: bool,
    /// What it has switched on, by Binance's field name (`enableFutures`).
    /// Empty for a Demo Trading key, whose restrictions Binance doesn't serve.
    pub permissions: Vec<String>,
}

/// A permission's name as Binance's API management page words it.
fn label(field: &str) -> &str {
    match field {
        "enableWithdrawals" => "Enable Withdrawals",
        "enableInternalTransfer" => "Permits Universal Transfer between master and sub accounts",
        "permitsUniversalTransfer" => "Permits Universal Transfer",
        "enableSpotAndMarginTrading" => "Enable Spot & Margin Trading",
        "enableMargin" => "Enable Margin Loan, Repay & Transfer",
        "enableVanillaOptions" => "Enable European Options",
        "enablePortfolioMarginTrading" => "Enable Portfolio Margin",
        "enableFixApiTrade" => "FIX API trading",
        other => other,
    }
}

/// Accepts the key only if futures trading is on and everything else it has
/// on is on [`ALLOWED`]. Refuses with the permissions to switch off, so the
/// user can fix the key on Binance rather than guess. `uid` is the account
/// the key read as its own (`/api/v3/account`).
pub fn check_trade_only(
    restrictions: &ApiRestrictions,
    uid: u64,
) -> Result<TradeOnlyKey, VenueError> {
    let on = restrictions.on();
    let extra: Vec<&str> = on
        .iter()
        .filter(|name| !ALLOWED.contains(&name.as_str()))
        .map(|name| label(name))
        .collect();
    if !extra.is_empty() {
        return Err(VenueError::InvalidRequest(format!(
            "this key can do more than trade futures; switch off {} on Binance, or make a key with futures trading only",
            extra.join(", ")
        )));
    }
    if !on.iter().any(|name| name == FUTURES) {
        return Err(VenueError::InvalidRequest(
            "this key can't trade futures; switch on Enable Futures for it on Binance".into(),
        ));
    }
    Ok(TradeOnlyKey {
        uid,
        ip_restricted: on.iter().any(|name| name == "ipRestrict"),
        permissions: on.into_iter().filter(|n| n != "ipRestrict").collect(),
    })
}

/// A Demo Trading key, which only reaches demo funds on the demo host:
/// Binance serves no restrictions for it there, so there's nothing to judge.
/// Live keys go through [`check_trade_only`].
pub fn demo_key(uid: u64) -> TradeOnlyKey {
    TradeOnlyKey {
        uid,
        ip_restricted: false,
        permissions: Vec::new(),
    }
}

/// What `GET /api/v3/account` says, as far as it's read: whose key it is.
#[derive(Clone, Copy, Debug, Deserialize)]
pub struct AccountUid {
    pub uid: u64,
}

/// The prefix of a demo account's id: `demo:{uid}`. Demo accounts trade on
/// Binance's Demo Trading host with demo funds, under keys made there.
pub use pewterdesk_core::accounts::DEMO_PREFIX;

/// A Binance account id: its UID, with `demo:` in front for a Demo Trading
/// account. Returns whether it's demo, and the UID. The rule is `core`'s,
/// shared with onboarding and the engine.
pub use pewterdesk_core::accounts::binance_account as parse_account;

/// The account id for `uid`, live or demo.
pub fn account_id(uid: u64, demo: bool) -> String {
    if demo {
        format!("{DEMO_PREFIX}{uid}")
    } else {
        uid.to_string()
    }
}

/// The keychain entry the API key for Binance account `id` lives under -
/// shared by onboarding, which stores it, and the adapter, which reads it:
/// `binance:{uid}`, or `binance:demo:{uid}` for a demo account.
pub use pewterdesk_core::accounts::binance_key_entry as key_account;

/// The error body Binance sends with a refusal.
#[derive(Deserialize)]
pub(crate) struct ApiError {
    #[serde(default)]
    pub code: i64,
    #[serde(default)]
    pub msg: String,
}

/// What the margin type refusal says when it's already that.
pub(crate) const SAME_MARGIN_TYPE: &str = "the margin mode is already that";

/// Binance's refusals, the ones worth it said plainly. Others keep Binance's
/// own message.
pub(crate) fn api_error(code: i64, message: String) -> VenueError {
    match code {
        // Margin is insufficient / balance is insufficient.
        -2018 | -2019 => VenueError::Rejected(
            "not enough available balance for this order; lower the size, raise the leverage or add funds".into(),
        ),
        -4164 => VenueError::Rejected(
            "the order is below this market's smallest order value; raise the size".into(),
        ),
        _ => VenueError::InvalidRequest(match code {
            -1021 => "the request reached Binance too late (a slow connection or this computer's clock); try again".into(),
            -1022 => "the secret key doesn't match the API key".into(),
            -2014 | -2015 => "Binance refused the key: check it hasn't been deleted, that it was made for this account type (live or Demo Trading), and that it's bound to this computer's IP if it's bound at all".into(),
            -2011 | -2013 => "Binance has no such open order; it may have filled or been cancelled already".into(),
            -4046 => SAME_MARGIN_TYPE.into(),
            -4061 => "this account is in Hedge Mode; pewterdesk trades One-way Mode, so switch it in Binance's futures preferences".into(),
            _ => message,
        }),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Binance's own example key pair, from the docs' signed-endpoint example.
    const KEY: &str = "dbefbc809e3e83c283a984c3a1459732ea7db1360ca80c5c2c8867408d28cc83";
    const SECRET: &str = "2b5eb11e18796d12d88f13dc27dbbd02c2cc51ff7059765ed9821957d82bb4d9";

    fn creds() -> ApiCredentials {
        ApiCredentials::new(KEY, Zeroizing::new(SECRET.into())).unwrap()
    }

    fn restrictions(on: &[&str], off: &[&str]) -> ApiRestrictions {
        let mut map: BTreeMap<String, serde_json::Value> = BTreeMap::new();
        for k in on {
            map.insert((*k).into(), true.into());
        }
        for k in off {
            map.insert((*k).into(), false.into());
        }
        map.insert("createTime".into(), 1623840271000u64.into());
        ApiRestrictions(map)
    }

    /// The docs' HMAC example ("SIGNED Endpoint Examples for POST
    /// /fapi/v1/order"), also checked with `openssl dgst -sha256 -hmac`.
    #[test]
    fn signs_the_docs_example() {
        assert_eq!(
            creds().sign("symbol=BTCUSDT&side=BUY&type=LIMIT&quantity=1&price=9000&timeInForce=GTC&recvWindow=5000&timestamp=1591702613943"),
            "3c661234138461fcc7a7d8746c6558c9842d4e10870d2ecbedf7777cad694af9"
        );
    }

    #[test]
    fn signature_depends_on_every_byte_and_the_secret() {
        let c = creds();
        let base = c.sign("a=1&timestamp=1");
        assert_ne!(base, c.sign("a=1&timestamp=2"));
        assert_ne!(base, c.sign("a=2&timestamp=1"));
        let other = ApiCredentials::new(KEY, Zeroizing::new("Z".repeat(64))).unwrap();
        assert_ne!(base, other.sign("a=1&timestamp=1"));
        assert_eq!(base.len(), 64);
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
        assert!(ApiCredentials::new("has space in it but long enough", secret()).is_err());
        let ed25519 =
            Zeroizing::new("-----BEGIN PRIVATE KEY-----\nMC4CAQAwBQYDK2VwBCIEI".to_owned());
        assert!(ApiCredentials::new(KEY, ed25519).is_err());
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
        assert_eq!(back.sign("x=1"), creds().sign("x=1"));
        assert!(ApiCredentials::from_stored(&Zeroizing::new("no-colon".into())).is_err());
    }

    #[test]
    fn accepts_a_futures_only_key() {
        let r = restrictions(
            &["enableReading", "enableFutures", "enableFixReadOnly"],
            &[
                "enableWithdrawals",
                "enableInternalTransfer",
                "permitsUniversalTransfer",
                "enableMargin",
                "enableSpotAndMarginTrading",
                "enableVanillaOptions",
                "enablePortfolioMarginTrading",
                "enableFixApiTrade",
                "ipRestrict",
            ],
        );
        let k = check_trade_only(&r, 354937868).unwrap();
        assert_eq!(k.uid, 354937868);
        assert!(!k.ip_restricted);
        assert_eq!(
            k.permissions,
            ["enableFixReadOnly", "enableFutures", "enableReading"]
        );
        let bound = restrictions(&["enableFutures", "ipRestrict"], &[]);
        assert!(check_trade_only(&bound, 1).unwrap().ip_restricted);
    }

    #[test]
    fn refuses_keys_that_move_funds_or_trade_anything_else() {
        for extra in [
            "enableWithdrawals",
            "enableInternalTransfer",
            "permitsUniversalTransfer",
            "enableMargin",
            "enableSpotAndMarginTrading",
            "enableVanillaOptions",
            "enablePortfolioMarginTrading",
            "enableFixApiTrade",
            // A switch this code has never heard of is refused too.
            "enableSomethingNew",
        ] {
            let r = restrictions(&["enableReading", "enableFutures", extra], &[]);
            let err = check_trade_only(&r, 1).unwrap_err();
            let VenueError::InvalidRequest(m) = &err else {
                panic!("{extra}: {err:?}");
            };
            assert!(m.contains(label(extra)), "{extra}: {m}");
        }
    }

    #[test]
    fn refuses_a_key_without_futures() {
        let r = restrictions(&["enableReading"], &["enableFutures"]);
        let err = check_trade_only(&r, 1).unwrap_err();
        assert!(err.to_string().contains("Enable Futures"), "{err}");
    }

    #[test]
    fn parses_the_documented_reply() {
        let reply = serde_json::json!({
            "ipRestrict": false, "createTime": 1623840271000u64, "enableReading": true,
            "enableWithdrawals": false, "enableInternalTransfer": false, "enableMargin": false,
            "enableFutures": true, "permitsUniversalTransfer": false,
            "enableVanillaOptions": false, "enableFixApiTrade": false,
            "enableFixReadOnly": true, "enableSpotAndMarginTrading": false,
            "enablePortfolioMarginTrading": false
        });
        let r: ApiRestrictions = serde_json::from_value(reply).unwrap();
        assert!(check_trade_only(&r, 7).is_ok());
        let uid: AccountUid = serde_json::from_value(serde_json::json!({
            "makerCommission": 15, "canTrade": true, "uid": 354937868,
            "accountType": "SPOT", "balances": [], "permissions": ["SPOT"]
        }))
        .unwrap();
        assert_eq!(uid.uid, 354937868);
    }

    #[test]
    fn account_ids_carry_the_environment() {
        assert_eq!(account_id(354937868, true), "demo:354937868");
        assert_eq!(account_id(354937868, false), "354937868");
        assert_eq!(
            parse_account("demo:354937868").unwrap(),
            (true, "354937868")
        );
        assert_eq!(key_account("354937868").unwrap(), "binance:354937868");
        assert_eq!(
            key_account("demo:354937868").unwrap(),
            "binance:demo:354937868"
        );
        for bad in ["", "0x12", "1:2", "demo:", "live:1"] {
            assert!(key_account(bad).is_err(), "{bad:?}");
        }
    }

    #[test]
    fn refusals_read_plainly() {
        assert!(matches!(
            api_error(-2019, "Margin is insufficient.".into()),
            VenueError::Rejected(m) if m.starts_with("not enough available balance")
        ));
        assert_eq!(
            api_error(-4046, "No need to change margin type.".into()),
            VenueError::InvalidRequest(SAME_MARGIN_TYPE.into())
        );
        assert!(api_error(-4061, "x".into())
            .to_string()
            .contains("Hedge Mode"));
        assert_eq!(
            api_error(
                -1111,
                "Precision is over the maximum defined for this asset.".into()
            ),
            VenueError::InvalidRequest(
                "Precision is over the maximum defined for this asset.".into()
            )
        );
    }
}
