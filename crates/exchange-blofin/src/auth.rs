//! BloFin API keys: holding one, signing a request with it (HMAC-SHA256),
//! and deciding whether a key may be stored.
//!
//! Security invariants - review any change here against
//! `.claude/commands/security-review.md`:
//! - The secret and passphrase live only in `Zeroizing` memory, inside
//!   [`ApiCredentials`], whose `Debug` prints none of the three parts.
//!   Nothing here logs, formats or returns them; errors are fixed strings or
//!   BloFin's own messages.
//! - Signing is crate-private and takes no network types: the adapter signs
//!   the requests it builds itself, never caller-supplied bytes.
//! - Only Demo Trading keys are taken. BloFin's permissions are READ, TRADE
//!   and TRANSFER, and the one request that describes a key
//!   (`/api/v1/user/query-apikey`) says only whether it's read-only - not
//!   whether TRANSFER is on. A live key can't be shown to be trade-only, so
//!   [`check_live`] refuses it before it's sent anywhere. A demo key reaches
//!   demo funds only, on the demo host.
//!
//! The scheme, per BloFin's "REST Authentication": the signature is the
//! base64 of the hex text of an HMAC-SHA256, keyed with the secret, over the
//! path, method, timestamp, nonce and body run together - the path with its
//! query string as sent, the body the JSON exactly as sent (empty for a
//! GET). The key, signature,
//! timestamp (ms), nonce and passphrase (where the key has one) go in
//! `ACCESS-*` headers.

use std::fmt;

use base64::Engine as _;
use hmac::{Hmac, Mac};
use pewterdesk_core::VenueError;
use serde::Deserialize;
use sha2::Sha256;
use zeroize::Zeroizing;

/// A BloFin API key, its secret and its passphrase. None of them is printed
/// by `Debug`; the secret and passphrase are zeroed when this is dropped.
/// Hold it only for the call that signs with it.
pub struct ApiCredentials {
    key: String,
    secret: Zeroizing<String>,
    passphrase: Zeroizing<String>,
}

impl fmt::Debug for ApiCredentials {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("ApiCredentials(..)")
    }
}

/// BloFin's keys and secrets are letters and digits.
fn plain(s: &str, min: usize, max: usize) -> bool {
    (min..=max).contains(&s.len()) && s.bytes().all(|b| b.is_ascii_alphanumeric())
}

/// The passphrase goes in a header, so it must be visible ASCII; it's the
/// user's own, so anything else visible is allowed. A key can be made
/// without one: empty is allowed too.
fn header_safe(s: &str) -> bool {
    s.len() <= 64 && s.bytes().all(|b| b.is_ascii_graphic())
}

fn trimmed(value: Zeroizing<String>) -> Zeroizing<String> {
    let t = value.trim();
    if t.len() == value.len() {
        value
    } else {
        Zeroizing::new(t.to_owned())
    }
}

impl ApiCredentials {
    /// A pasted key, secret and passphrase, trimmed and checked for shape.
    /// The secret and passphrase are taken as `Zeroizing`, so they're zeroed
    /// even when this fails.
    pub fn new(
        key: &str,
        secret: Zeroizing<String>,
        passphrase: Zeroizing<String>,
    ) -> Result<Self, VenueError> {
        let key = key.trim();
        let secret = trimmed(secret);
        let passphrase = trimmed(passphrase);
        if !plain(key, 16, 128) {
            return Err(VenueError::InvalidRequest(
                "that doesn't look like a BloFin API key: it's letters and digits only".into(),
            ));
        }
        if !plain(&secret, 16, 128) {
            return Err(VenueError::InvalidRequest(
                "that doesn't look like a BloFin secret key: it's letters and digits only".into(),
            ));
        }
        if !header_safe(&passphrase) {
            return Err(VenueError::InvalidRequest(
                "the passphrase is the one you set when you made the key (if you set one): up to 64 characters, no spaces".into(),
            ));
        }
        Ok(Self {
            key: key.to_owned(),
            secret,
            passphrase,
        })
    }

    pub fn api_key(&self) -> &str {
        &self.key
    }

    /// `None` for a key made without one.
    pub(crate) fn passphrase(&self) -> Option<&str> {
        Some(self.passphrase.as_str()).filter(|p| !p.is_empty())
    }

    /// The form kept in the keychain: `key:secret:passphrase`, the last part
    /// empty for a key without a passphrase. The key and
    /// secret are alphanumeric, so the first two colons split it back
    /// unambiguously, whatever the passphrase holds.
    pub fn to_stored(&self) -> Zeroizing<String> {
        let mut stored = Zeroizing::new(String::with_capacity(
            self.key.len() + self.secret.len() + self.passphrase.len() + 2,
        ));
        stored.push_str(&self.key);
        stored.push(':');
        stored.push_str(&self.secret);
        stored.push(':');
        stored.push_str(&self.passphrase);
        stored
    }

    /// Reads back what [`to_stored`](Self::to_stored) wrote.
    pub fn from_stored(stored: &Zeroizing<String>) -> Result<Self, VenueError> {
        let malformed = || {
            VenueError::InvalidRequest(
                "the stored BloFin key is malformed; connect it again".into(),
            )
        };
        let (key, rest) = stored.split_once(':').ok_or_else(malformed)?;
        let (secret, passphrase) = rest.split_once(':').ok_or_else(malformed)?;
        Self::new(
            key,
            Zeroizing::new(secret.to_owned()),
            Zeroizing::new(passphrase.to_owned()),
        )
    }

    /// The `ACCESS-SIGN` value for a request: `path` with its query string
    /// as sent, the method in capitals, the `ACCESS-TIMESTAMP` and
    /// `ACCESS-NONCE` values, and the body exactly as sent. Crate-private:
    /// only the adapter's own requests are signed.
    pub(crate) fn sign(
        &self,
        path: &str,
        method: &str,
        timestamp: &str,
        nonce: &str,
        body: &str,
    ) -> String {
        let mut mac = Hmac::<Sha256>::new_from_slice(self.secret.as_bytes())
            .expect("HMAC takes a key of any length");
        for part in [path, method, timestamp, nonce, body] {
            mac.update(part.as_bytes());
        }
        // BloFin signs the hex text, not the raw digest.
        let hex = hex::encode(mac.finalize().into_bytes());
        base64::engine::general_purpose::STANDARD.encode(hex)
    }
}

/// A fresh `ACCESS-NONCE`: 16 random bytes as hex. BloFin refuses one used
/// within the last 60 seconds.
pub(crate) fn nonce() -> Result<String, VenueError> {
    let mut bytes = [0u8; 16];
    getrandom::fill(&mut bytes)
        .map_err(|_| VenueError::Network("no randomness for a request nonce".into()))?;
    Ok(hex::encode(bytes))
}

/// What `GET /api/v1/user/query-apikey` says about the key that signed it.
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ApiKeyInfo {
    #[serde(deserialize_with = "crate::wire::text")]
    pub uid: String,
    /// 1: read only; 0: read and write. `None` where BloFin leaves it out.
    #[serde(default, deserialize_with = "flag")]
    pub read_only: Option<i64>,
    /// 1: a trading key; 2: a third-party (broker) key. Demo Trading keys
    /// can come without it.
    #[serde(rename = "type", default, deserialize_with = "flag")]
    pub kind: Option<i64>,
    #[serde(default, deserialize_with = "ips")]
    pub ips: Vec<String>,
}

/// A small number BloFin may send as a number or a string; anything else is
/// `None`.
fn flag<'de, D: serde::Deserializer<'de>>(d: D) -> Result<Option<i64>, D::Error> {
    Ok(match serde_json::Value::deserialize(d)? {
        serde_json::Value::Number(n) => n.as_i64(),
        serde_json::Value::String(s) => s.trim().parse().ok(),
        _ => None,
    })
}

/// The bound IPs, as a list (null or a comma-separated string read too).
fn ips<'de, D: serde::Deserializer<'de>>(d: D) -> Result<Vec<String>, D::Error> {
    Ok(match serde_json::Value::deserialize(d)? {
        serde_json::Value::Array(items) => items
            .into_iter()
            .filter_map(|v| v.as_str().map(str::to_owned))
            .collect(),
        serde_json::Value::String(s) => s.split(',').map(|ip| ip.trim().to_owned()).collect(),
        _ => Vec::new(),
    })
}

/// A key that may be stored, after [`check_demo`].
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DemoKey {
    /// The BloFin account (UID) the key belongs to.
    pub uid: String,
    pub ip_restricted: bool,
}

/// What a refusal of a live key says.
pub const LIVE_REFUSED: &str = "pewterdesk takes only BloFin Demo Trading keys: BloFin's API can't confirm a live key has its Transfer permission off, so it can't be shown to be trade-only";

/// Refuses a live key, before anything is sent with it.
pub fn check_live() -> Result<DemoKey, VenueError> {
    Err(VenueError::InvalidRequest(LIVE_REFUSED.into()))
}

/// Accepts a Demo Trading key that can trade (not read-only) and is an
/// ordinary trading key, not one bound to a third-party broker.
pub fn check_demo(info: &ApiKeyInfo) -> Result<DemoKey, VenueError> {
    let uid = info.uid.trim();
    if uid.is_empty() || uid.len() > 20 || !uid.bytes().all(|b| b.is_ascii_digit()) {
        return Err(VenueError::Network(
            "BloFin answered with no account for this key".into(),
        ));
    }
    if info.read_only == Some(1) {
        return Err(VenueError::InvalidRequest(
            "this key is read-only; give it the Trade permission on BloFin".into(),
        ));
    }
    // Only a key BloFin says is a broker's (2) is refused: a demo key can
    // come without a type.
    if info.kind == Some(2) {
        return Err(VenueError::InvalidRequest(
            "this is a third-party (broker) key; make an ordinary API trading key on BloFin".into(),
        ));
    }
    Ok(DemoKey {
        uid: uid.to_owned(),
        ip_restricted: info.ips.iter().any(|ip| !ip.trim().is_empty()),
    })
}

/// The prefix of a demo account's id: `demo:{uid}`.
pub use pewterdesk_core::accounts::DEMO_PREFIX;

/// A BloFin account id: its UID, with `demo:` in front for a Demo Trading
/// account. The rule is `core`'s, shared with onboarding and the engine.
pub use pewterdesk_core::accounts::blofin_account as parse_account;

/// The account id for `uid`, live or demo.
pub fn account_id(uid: &str, demo: bool) -> String {
    if demo {
        format!("{DEMO_PREFIX}{uid}")
    } else {
        uid.to_owned()
    }
}

/// The keychain entry the API key for BloFin account `id` lives under:
/// `blofin:{uid}`, or `blofin:demo:{uid}` for a demo account.
pub use pewterdesk_core::accounts::blofin_key_entry as key_account;

/// BloFin's refusals, the ones worth it said plainly. Others keep BloFin's
/// own message.
pub(crate) fn api_error(code: &str, message: String) -> VenueError {
    match code {
        "103003" | "150004" => VenueError::Rejected(
            "not enough available margin for this order; lower the size, raise the leverage or add funds".into(),
        ),
        "102022" => VenueError::Rejected("there's no position on this market to reduce".into()),
        "102167" => VenueError::Rejected(
            "BloFin has stopped new positions on this market through the API; closing still works".into(),
        ),
        "102064" | "102065" => VenueError::Rejected(
            "the price is outside BloFin's limit for this market right now".into(),
        ),
        _ => VenueError::InvalidRequest(match code {
            "152401" | "152402" => {
                "BloFin doesn't know this key, or it has expired; check it on BloFin's API page".into()
            }
            "152404" => "this key can't do that; check its permissions on BloFin".into(),
            "152405" | "152410" => {
                "the request reached BloFin too late (a slow connection or this computer's clock); try again".into()
            }
            "152406" => "this computer's IP isn't on the key's IP list".into(),
            "152408" => "the passphrase doesn't match the key".into(),
            "152409" | "401" => {
                "BloFin refused the signature: check the secret key, and that the key was made in Demo Trading".into()
            }
            "102067" | "102068" => {
                "BloFin has no such open order; it may have filled or been cancelled already".into()
            }
            "102089" => {
                "this account is in Hedge Mode; pewterdesk trades One-way Mode, so switch it in BloFin's futures settings".into()
            }
            "110006" | "110019" => {
                "BloFin won't change this while orders are open or a position is held; cancel or close them first".into()
            }
            _ => message,
        }),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const KEY: &str = "4b6ce8b1a6e64c0ba5f9d2c8e4f7a901";
    const SECRET: &str = "6b1fd4b09e8c4c3a9f4b8a2e5d7c1f30";
    const PASSPHRASE: &str = "my:pass/phrase!";
    const NONCE: &str = "123e4567-e89b-12d3-a456-426614174000";

    fn creds() -> ApiCredentials {
        ApiCredentials::new(
            KEY,
            Zeroizing::new(SECRET.into()),
            Zeroizing::new(PASSPHRASE.into()),
        )
        .unwrap()
    }

    /// Computed with the docs' own Python ("Signature"), on BloFin's example
    /// path and body.
    #[test]
    fn signs_as_the_docs_reference_does() {
        let c = creds();
        assert_eq!(
            c.sign(
                "/api/v1/asset/balances?accountType=futures",
                "GET",
                "1597026383085",
                NONCE,
                ""
            ),
            "YjdjMjIxOGYxMWNiNjIyZmI1YzlhMjU1M2VlMzYzZmM3YjY4ODZmZDIwOTBiNTVmNzcwNDgyZTZhMWE1ZWEwMQ=="
        );
        assert_eq!(
            c.sign(
                "/api/v1/trade/order",
                "POST",
                "1597026383085",
                NONCE,
                r#"{"instId":"BTC-USDT","marginMode":"isolated","side":"buy","orderType":"limit","price":"35000","size":"0.1"}"#
            ),
            "NDJhNzY5YWRiOTYwODQyYTFhNzM0ODVjYWVlOTcyZDM1ZjFhNmZkYjdiYzY0ZGY0NDQzN2E0NGVkMWZkOWI2Mg=="
        );
    }

    #[test]
    fn signature_depends_on_every_part_and_the_secret() {
        let c = creds();
        let base = c.sign("/p", "GET", "1", "n", "");
        assert_ne!(base, c.sign("/q", "GET", "1", "n", ""));
        assert_ne!(base, c.sign("/p", "POST", "1", "n", ""));
        assert_ne!(base, c.sign("/p", "GET", "2", "n", ""));
        assert_ne!(base, c.sign("/p", "GET", "1", "m", ""));
        assert_ne!(base, c.sign("/p", "GET", "1", "n", "{}"));
        let other = ApiCredentials::new(
            KEY,
            Zeroizing::new("Z".repeat(32)),
            Zeroizing::new(PASSPHRASE.into()),
        )
        .unwrap();
        assert_ne!(base, other.sign("/p", "GET", "1", "n", ""));
    }

    #[test]
    fn debug_hides_every_part() {
        let shown = format!("{:?}", creds());
        for part in [KEY, SECRET, PASSPHRASE] {
            assert!(!shown.contains(part), "{shown}");
        }
    }

    #[test]
    fn rejects_malformed_keys() {
        let s = || Zeroizing::new(SECRET.to_owned());
        let p = || Zeroizing::new(PASSPHRASE.to_owned());
        assert!(ApiCredentials::new("", s(), p()).is_err());
        assert!(ApiCredentials::new("short", s(), p()).is_err());
        assert!(ApiCredentials::new(KEY, Zeroizing::new("has space x".repeat(3)), p()).is_err());
        // No passphrase is fine: BloFin keys can be made without one.
        let bare = ApiCredentials::new(KEY, s(), Zeroizing::new(String::new())).unwrap();
        assert_eq!(bare.passphrase(), None);
        let stored = bare.to_stored();
        assert_eq!(stored.as_str(), format!("{KEY}:{SECRET}:"));
        assert_eq!(
            ApiCredentials::from_stored(&stored).unwrap().passphrase(),
            None
        );
        assert_eq!(
            ApiCredentials::new(KEY, s(), Zeroizing::new("   ".into()))
                .unwrap()
                .passphrase(),
            None
        );
        assert!(ApiCredentials::new(KEY, s(), Zeroizing::new("two words".into())).is_err());
        assert!(ApiCredentials::new(KEY, s(), Zeroizing::new("line\nbreak".into())).is_err());
        let padded = ApiCredentials::new(
            &format!(" {KEY}\n"),
            Zeroizing::new(format!("{SECRET} ")),
            Zeroizing::new(format!(" {PASSPHRASE}")),
        )
        .unwrap();
        assert_eq!(padded.api_key(), KEY);
        assert_eq!(padded.passphrase(), Some(PASSPHRASE));
    }

    #[test]
    fn stored_form_round_trips_whatever_the_passphrase_holds() {
        let stored = creds().to_stored();
        assert_eq!(stored.as_str(), format!("{KEY}:{SECRET}:{PASSPHRASE}"));
        let back = ApiCredentials::from_stored(&stored).unwrap();
        assert_eq!(back.api_key(), KEY);
        assert_eq!(back.passphrase(), Some(PASSPHRASE));
        assert_eq!(
            back.sign("/x", "GET", "1", "n", ""),
            creds().sign("/x", "GET", "1", "n", "")
        );
        for bad in ["no-colon", "a:b"] {
            assert!(ApiCredentials::from_stored(&Zeroizing::new(bad.into())).is_err());
        }
    }

    #[test]
    fn nonces_differ() {
        let a = nonce().unwrap();
        assert_eq!(a.len(), 32);
        assert_ne!(a, nonce().unwrap());
    }

    fn info(read_only: i64, kind: i64, ips: &[&str]) -> ApiKeyInfo {
        serde_json::from_value(serde_json::json!({
            "uid": "20923487", "apiName": "pd", "apiKey": KEY, "readOnly": read_only,
            "ips": ips, "type": kind, "expireTime": "1597026383085",
            "createTime": "1597026383085", "referralCode": "", "parentUid": "0"
        }))
        .unwrap()
    }

    #[test]
    fn a_demo_key_must_trade_and_be_a_trading_key() {
        assert_eq!(
            check_demo(&info(0, 1, &[])).unwrap(),
            DemoKey {
                uid: "20923487".into(),
                ip_restricted: false
            }
        );
        assert!(check_demo(&info(0, 1, &["1.2.3.4"])).unwrap().ip_restricted);
        assert!(check_demo(&info(1, 1, &[]))
            .unwrap_err()
            .to_string()
            .contains("read-only"));
        assert!(check_demo(&info(0, 2, &[]))
            .unwrap_err()
            .to_string()
            .contains("broker"));
        let mut odd = info(0, 1, &[]);
        odd.uid = "0x12".into();
        assert!(check_demo(&odd).is_err());
    }

    /// Demo Trading keys can come without a type, with fields as strings,
    /// or with the UID as a number: all of that is still an ordinary key.
    #[test]
    fn a_demo_key_without_a_type_is_taken() {
        for reply in [
            serde_json::json!({"uid": "20923487", "readOnly": 0, "ips": []}),
            serde_json::json!({"uid": 20923487, "readOnly": "0", "type": "1", "ips": null}),
            serde_json::json!({"uid": "20923487", "type": 0}),
            serde_json::json!({"uid": "20923487", "type": 3, "ips": "1.2.3.4"}),
        ] {
            let info: ApiKeyInfo = serde_json::from_value(reply.clone()).unwrap();
            assert!(check_demo(&info).is_ok(), "{reply}");
        }
        let read_only: ApiKeyInfo =
            serde_json::from_value(serde_json::json!({"uid": "1", "readOnly": "1"})).unwrap();
        assert!(check_demo(&read_only).is_err());
    }

    #[test]
    fn a_live_key_is_refused() {
        assert!(check_live()
            .unwrap_err()
            .to_string()
            .contains("Demo Trading"));
    }

    #[test]
    fn account_ids_carry_the_environment() {
        assert_eq!(account_id("20923487", true), "demo:20923487");
        assert_eq!(
            key_account("demo:20923487").unwrap(),
            "blofin:demo:20923487"
        );
        assert_eq!(parse_account("demo:20923487").unwrap(), (true, "20923487"));
        for bad in ["", "0x12", "1:2", "demo:", "live:1"] {
            assert!(key_account(bad).is_err(), "{bad:?}");
        }
    }

    #[test]
    fn refusals_read_plainly() {
        assert!(matches!(
            api_error("103003", "Insufficient".into()),
            VenueError::Rejected(m) if m.starts_with("not enough available margin")
        ));
        assert!(api_error("102089", "x".into())
            .to_string()
            .contains("Hedge Mode"));
        assert_eq!(
            api_error("152002", "Parameter size error.".into()),
            VenueError::InvalidRequest("Parameter size error.".into())
        );
    }
}
