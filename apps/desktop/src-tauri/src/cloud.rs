//! PewterDesk Cloud: the hosted store for the trading plan, playbooks, the
//! journal and trade notes (`docs/adr/0004-hosted-journal.md`), on Supabase
//! (Postgres behind PostgREST, its Auth, its Storage), reached from Rust only.
//!
//! Not a venue and not on the signing surface. What goes up is what the
//! trader wrote and the figures of trades the venue already reported - never
//! key material, a signature, a signed payload or a keychain reference. The
//! store's own Row Level Security keeps every row to the user who wrote it
//! (`supabase/migrations/`).
//!
//! - One fixed project, set when the app is built (`PEWTERDESK_CLOUD_URL`,
//!   https only, and its public anon key `PEWTERDESK_CLOUD_KEY`). A build
//!   without them has no cloud and says so; nothing is sent anywhere else,
//!   and no redirect is followed.
//! - Sign-in is a code sent by email (`cloud_send_code`, `cloud_verify`). The
//!   session's refresh token is kept in the keychain (`cloud:session`) and
//!   never returned; the access token lives in memory only. The page sees
//!   the signed-in email and nothing else of the session.
//! - The page names a collection (a fixed set, each one table) and Rust builds
//!   every request: the filters are typed and checked, the bodies capped.
//! - Attachments are PNG or JPEG images (checked), stored under the user's
//!   own id with a name Rust picks.

use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::ipc::{InvokeBody, Request, Response};
use tauri::State;
use zeroize::Zeroizing;

use pewterdesk_core::KeySource;

use crate::keychain::{self, KeychainKeySource};

/// The keychain entry holding the session's refresh token.
const SESSION_ACCOUNT: &str = "cloud:session";
const TIMEOUT: Duration = Duration::from_secs(20);
/// One record's `data`, as the table's own check allows.
const MAX_RECORD: usize = 256 * 1024;
/// A list read: a few thousand records at most.
const MAX_LIST: usize = 24 * 1024 * 1024;
const MAX_ROWS: usize = 5000;
/// An attachment, as the storage bucket allows.
const MAX_IMAGE: usize = 5 * 1024 * 1024;
/// Refreshed this long before the access token runs out.
const REFRESH_MARGIN: Duration = Duration::from_secs(90);
const BUCKET: &str = "journal";

const PNG_SIGNATURE: [u8; 8] = [0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A];
const JPEG_SIGNATURE: [u8; 3] = [0xFF, 0xD8, 0xFF];

/// Crosses IPC: never carries a token or key, only what went wrong.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", content = "detail", rename_all = "camelCase")]
pub enum CloudError {
    /// This build has no cloud project.
    NotConfigured,
    /// No session, or it ended: sign in again.
    SignedOut,
    /// The request is malformed; nothing was sent.
    Invalid(&'static str),
    /// The store refused it; the detail is its own message, bounded.
    Rejected(String),
    Network(String),
}

#[derive(Clone)]
struct Config {
    /// The project's address, without a trailing slash.
    url: String,
    anon_key: String,
}

impl Config {
    fn from_build() -> Option<Self> {
        let url = option_env!("PEWTERDESK_CLOUD_URL")?
            .trim()
            .trim_end_matches('/');
        let anon_key = option_env!("PEWTERDESK_CLOUD_KEY")?.trim();
        Self::checked(url, anon_key)
    }

    /// An https address with a host and no path, query or credentials, and a
    /// key that's plain text.
    fn checked(url: &str, anon_key: &str) -> Option<Self> {
        let host = url.strip_prefix("https://")?;
        let valid_host = !host.is_empty()
            && host.len() <= 253
            && host
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'.' | b':'));
        let valid_key = !anon_key.is_empty()
            && anon_key.len() <= 4096
            && anon_key.bytes().all(|b| b.is_ascii_graphic());
        (valid_host && valid_key).then(|| Self {
            url: url.to_owned(),
            anon_key: anon_key.to_owned(),
        })
    }
}

struct Session {
    access: Zeroizing<String>,
    expires: Instant,
    user_id: String,
    email: String,
}

pub struct CloudState {
    http: reqwest::Client,
    config: Option<Config>,
    /// Held across a refresh, so two calls don't both rotate the token.
    session: tokio::sync::Mutex<Option<Session>>,
}

impl CloudState {
    pub fn new() -> Result<Self, String> {
        let http = reqwest::Client::builder()
            .timeout(TIMEOUT)
            .gzip(true)
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .map_err(|e| e.to_string())?;
        Ok(Self {
            http,
            config: Config::from_build(),
            session: tokio::sync::Mutex::new(None),
        })
    }

    fn config(&self) -> Result<&Config, CloudError> {
        self.config.as_ref().ok_or(CloudError::NotConfigured)
    }

    /// A valid access token and whose it is, refreshing it from the
    /// keychain's refresh token when it's missing or about to run out.
    async fn access(&self) -> Result<(Zeroizing<String>, String), CloudError> {
        let config = self.config()?;
        let mut session = self.session.lock().await;
        if let Some(s) = session.as_ref() {
            if s.expires > Instant::now() + REFRESH_MARGIN {
                return Ok((s.access.clone(), s.user_id.clone()));
            }
        }
        let refresh = match KeychainKeySource.key(SESSION_ACCOUNT).await {
            Ok(token) if !token.is_empty() => token,
            _ => {
                *session = None;
                return Err(CloudError::SignedOut);
            }
        };
        let body = serde_json::json!({ "refresh_token": refresh.as_str() });
        let url = format!("{}/auth/v1/token?grant_type=refresh_token", config.url);
        let response = self
            .http
            .post(url)
            .header("apikey", &config.anon_key)
            .json(&body)
            .send()
            .await
            .map_err(network)?;
        let status = response.status().as_u16();
        let bytes = read_capped(response, 64 * 1024).await?;
        if status == 400 || status == 401 || status == 403 {
            // The refresh token was revoked or already used: signed out.
            *session = None;
            let _ = keychain::delete_key(SESSION_ACCOUNT.to_owned()).await;
            return Err(CloudError::SignedOut);
        }
        if status != 200 {
            return Err(rejected(status, &bytes));
        }
        let fresh = adopt(&bytes).await?;
        let out = (fresh.access.clone(), fresh.user_id.clone());
        *session = Some(fresh);
        Ok(out)
    }

    fn request(
        &self,
        method: reqwest::Method,
        path: &str,
        access: &str,
    ) -> Result<reqwest::RequestBuilder, CloudError> {
        let config = self.config()?;
        Ok(self
            .http
            .request(method, format!("{}{path}", config.url))
            .header("apikey", &config.anon_key)
            .bearer_auth(access))
    }
}

#[derive(Deserialize)]
struct TokenResponse {
    access_token: String,
    expires_in: u64,
    refresh_token: String,
    user: TokenUser,
}

#[derive(Deserialize)]
struct TokenUser {
    id: String,
    #[serde(default)]
    email: Option<String>,
}

/// Takes a token response: the refresh token into the keychain (Supabase
/// rotates it on every use), the rest into memory.
async fn adopt(bytes: &[u8]) -> Result<Session, CloudError> {
    let token: TokenResponse = serde_json::from_slice(bytes)
        .map_err(|_| CloudError::Rejected("the sign-in answer couldn't be read".into()))?;
    let refresh = Zeroizing::new(token.refresh_token);
    if !is_uuid(&token.user.id) || refresh.is_empty() || token.access_token.is_empty() {
        return Err(CloudError::Rejected(
            "the sign-in answer couldn't be read".into(),
        ));
    }
    keychain::store_key(SESSION_ACCOUNT.to_owned(), refresh)
        .await
        .map_err(|_| CloudError::Rejected("the session couldn't be kept in the keychain".into()))?;
    Ok(Session {
        access: Zeroizing::new(token.access_token),
        expires: Instant::now() + Duration::from_secs(token.expires_in.clamp(60, 7 * 24 * 3600)),
        user_id: token.user.id,
        email: bounded(&token.user.email.unwrap_or_default(), 320),
    })
}

fn network(e: reqwest::Error) -> CloudError {
    CloudError::Network(if e.is_timeout() {
        "the cloud didn't answer in time".into()
    } else {
        "the cloud couldn't be reached".into()
    })
}

/// The store's own words for a refusal, as plain bounded text.
fn rejected(status: u16, bytes: &[u8]) -> CloudError {
    let json: Option<Value> = serde_json::from_slice(bytes).ok();
    let message = json
        .as_ref()
        .and_then(|v| {
            ["msg", "message", "error_description", "error"]
                .iter()
                .find_map(|k| v.get(*k).and_then(Value::as_str))
        })
        .map(|m| bounded(m, 200))
        .unwrap_or_else(|| format!("status {status}"));
    CloudError::Rejected(message)
}

/// Printable characters only, at most `max` of them.
fn bounded(text: &str, max: usize) -> String {
    text.chars().filter(|c| !c.is_control()).take(max).collect()
}

async fn read_capped(mut response: reqwest::Response, max: usize) -> Result<Vec<u8>, CloudError> {
    let mut body = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(network)? {
        if body.len() + chunk.len() > max {
            return Err(CloudError::Rejected("the answer was too large".into()));
        }
        body.extend_from_slice(&chunk);
    }
    Ok(body)
}

fn is_uuid(s: &str) -> bool {
    s.len() == 36
        && s.bytes().enumerate().all(|(i, b)| match i {
            8 | 13 | 18 | 23 => b == b'-',
            _ => b.is_ascii_hexdigit(),
        })
}

/// `YYYY-MM-DD`, a real-looking date.
fn is_day(s: &str) -> bool {
    let b = s.as_bytes();
    b.len() == 10
        && b[4] == b'-'
        && b[7] == b'-'
        && b.iter()
            .enumerate()
            .all(|(i, c)| i == 4 || i == 7 || c.is_ascii_digit())
        && matches!(s[5..7].parse::<u8>(), Ok(1..=12))
        && matches!(s[8..10].parse::<u8>(), Ok(1..=31))
}

/// An account key (`venue:address`, `paper:venue`) or a trade key: letters,
/// digits and a few separators.
fn is_key(s: &str) -> bool {
    !s.is_empty()
        && s.len() <= 200
        && s.bytes().all(|b| {
            b.is_ascii_alphanumeric() || matches!(b, b':' | b'-' | b'_' | b'.' | b'@' | b'/')
        })
}

fn is_email(s: &str) -> bool {
    let Some((local, domain)) = s.split_once('@') else {
        return false;
    };
    !local.is_empty()
        && domain.contains('.')
        && s.len() <= 254
        && s.bytes().all(|b| b.is_ascii_graphic())
}

// ---- sign-in ---------------------------------------------------------------

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CloudStatus {
    /// This build has a cloud project.
    configured: bool,
    /// The signed-in user's email, if signed in.
    email: Option<String>,
}

/// Whether this build has a cloud, and who is signed in (restoring the session
/// from the keychain if there is one).
#[tauri::command]
pub async fn cloud_status(state: State<'_, CloudState>) -> Result<CloudStatus, CloudError> {
    if state.config.is_none() {
        return Ok(CloudStatus {
            configured: false,
            email: None,
        });
    }
    match state.access().await {
        Ok(_) => {
            let session = state.session.lock().await;
            Ok(CloudStatus {
                configured: true,
                email: session.as_ref().map(|s| s.email.clone()),
            })
        }
        Err(CloudError::SignedOut) => Ok(CloudStatus {
            configured: true,
            email: None,
        }),
        Err(e) => Err(e),
    }
}

/// Emails a one-time sign-in code (creating the account on first use).
#[tauri::command]
pub async fn cloud_send_code(
    state: State<'_, CloudState>,
    email: String,
) -> Result<(), CloudError> {
    let config = state.config()?;
    let email = email.trim().to_lowercase();
    if !is_email(&email) {
        return Err(CloudError::Invalid("email"));
    }
    let response = state
        .http
        .post(format!("{}/auth/v1/otp", config.url))
        .header("apikey", &config.anon_key)
        .json(&serde_json::json!({ "email": email, "create_user": true }))
        .send()
        .await
        .map_err(network)?;
    let status = response.status().as_u16();
    let bytes = read_capped(response, 64 * 1024).await?;
    if status == 200 {
        Ok(())
    } else {
        Err(rejected(status, &bytes))
    }
}

/// Signs in with the code from the email; returns the signed-in email.
#[tauri::command]
pub async fn cloud_verify(
    state: State<'_, CloudState>,
    email: String,
    code: String,
) -> Result<String, CloudError> {
    let config = state.config()?;
    let email = email.trim().to_lowercase();
    let code = code.trim().to_owned();
    if !is_email(&email) {
        return Err(CloudError::Invalid("email"));
    }
    if !(6..=10).contains(&code.len()) || !code.bytes().all(|b| b.is_ascii_digit()) {
        return Err(CloudError::Invalid("code"));
    }
    let mut session = state.session.lock().await;
    let response = state
        .http
        .post(format!("{}/auth/v1/verify", config.url))
        .header("apikey", &config.anon_key)
        .json(&serde_json::json!({ "type": "email", "email": email, "token": code }))
        .send()
        .await
        .map_err(network)?;
    let status = response.status().as_u16();
    let bytes = read_capped(response, 64 * 1024).await?;
    if status != 200 {
        return Err(rejected(status, &bytes));
    }
    let fresh = adopt(&bytes).await?;
    let email = fresh.email.clone();
    *session = Some(fresh);
    Ok(email)
}

/// Ends the session here and at the store; the keychain entry goes.
#[tauri::command]
pub async fn cloud_sign_out(state: State<'_, CloudState>) -> Result<(), CloudError> {
    let mut session = state.session.lock().await;
    if let (Some(s), Ok(config)) = (session.as_ref(), state.config()) {
        // Best effort: the token runs out on its own anyway.
        let _ = state
            .http
            .post(format!("{}/auth/v1/logout", config.url))
            .header("apikey", &config.anon_key)
            .bearer_auth(s.access.as_str())
            .send()
            .await;
    }
    *session = None;
    keychain::delete_key(SESSION_ACCOUNT.to_owned())
        .await
        .map_err(|_| {
            CloudError::Rejected("the session couldn't be removed from the keychain".into())
        })
}

// ---- records ---------------------------------------------------------------

/// The page's collections, each one table with its own columns.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Collection {
    Plans,
    Playbooks,
    JournalDays,
    TradeNotes,
}

impl Collection {
    fn table(self) -> &'static str {
        match self {
            Self::Plans => "plans",
            Self::Playbooks => "playbooks",
            Self::JournalDays => "journal_days",
            Self::TradeNotes => "trade_notes",
        }
    }

    /// The unique key an upsert merges on: the record's natural key, so two
    /// machines writing the same day write one row.
    fn conflict(self) -> &'static str {
        match self {
            Self::Plans => "user_id,account_key",
            Self::Playbooks => "id",
            Self::JournalDays => "user_id,account_key,day",
            Self::TradeNotes => "user_id,account_key,trade_key",
        }
    }

    fn has_account(self) -> bool {
        !matches!(self, Self::Playbooks)
    }

    fn has_day(self) -> bool {
        matches!(self, Self::JournalDays | Self::TradeNotes)
    }

    fn order(self) -> &'static str {
        if self.has_day() {
            "day.desc,updated_at.desc"
        } else {
            "updated_at.desc"
        }
    }
}

/// One record, as the page reads and writes it.
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CloudRecord {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub id: Option<String>,
    #[serde(
        default,
        alias = "account_key",
        skip_serializing_if = "Option::is_none"
    )]
    pub account_key: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub day: Option<String>,
    #[serde(default, alias = "trade_key", skip_serializing_if = "Option::is_none")]
    pub trade_key: Option<String>,
    #[serde(
        default,
        alias = "playbook_id",
        skip_serializing_if = "Option::is_none"
    )]
    pub playbook_id: Option<String>,
    #[serde(default)]
    pub data: Value,
    #[serde(default, alias = "updated_at", skip_serializing_if = "Option::is_none")]
    pub updated_at: Option<String>,
}

/// What a list may be narrowed to.
#[derive(Clone, Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CloudQuery {
    account_key: Option<String>,
    /// Inclusive `YYYY-MM-DD` bounds on `day`.
    from: Option<String>,
    to: Option<String>,
    trade_key: Option<String>,
    playbook_id: Option<String>,
}

/// The query string for a list, every value checked first.
fn list_params(
    collection: Collection,
    query: &CloudQuery,
) -> Result<Vec<(String, String)>, CloudError> {
    let mut params = vec![
        ("select".to_owned(), "*".to_owned()),
        ("order".to_owned(), collection.order().to_owned()),
        ("limit".to_owned(), MAX_ROWS.to_string()),
    ];
    if let Some(account) = &query.account_key {
        if !collection.has_account() || !is_key(account) {
            return Err(CloudError::Invalid("account"));
        }
        params.push(("account_key".into(), format!("eq.{account}")));
    }
    for (bound, op) in [(&query.from, "gte"), (&query.to, "lte")] {
        if let Some(day) = bound {
            if !collection.has_day() || !is_day(day) {
                return Err(CloudError::Invalid("day"));
            }
            params.push(("day".into(), format!("{op}.{day}")));
        }
    }
    if let Some(trade) = &query.trade_key {
        if collection != Collection::TradeNotes || !is_key(trade) {
            return Err(CloudError::Invalid("trade"));
        }
        params.push(("trade_key".into(), format!("eq.{trade}")));
    }
    if let Some(playbook) = &query.playbook_id {
        if collection != Collection::TradeNotes || !is_uuid(playbook) {
            return Err(CloudError::Invalid("playbook"));
        }
        params.push(("playbook_id".into(), format!("eq.{playbook}")));
    }
    Ok(params)
}

/// The row an upsert sends: only the table's own columns, each checked.
/// `user_id` is never sent: the store fills it from the session.
fn row(collection: Collection, record: &CloudRecord) -> Result<Value, CloudError> {
    let mut row = serde_json::Map::new();
    match (&record.id, collection) {
        (Some(id), _) if !is_uuid(id) => return Err(CloudError::Invalid("id")),
        (Some(id), Collection::Playbooks) => {
            row.insert("id".into(), Value::String(id.clone()));
        }
        (None, Collection::Playbooks) => return Err(CloudError::Invalid("id")),
        _ => {}
    }
    if collection.has_account() {
        match &record.account_key {
            Some(a) if is_key(a) => row.insert("account_key".into(), Value::String(a.clone())),
            _ => return Err(CloudError::Invalid("account")),
        };
    }
    if collection.has_day() {
        match &record.day {
            Some(d) if is_day(d) => row.insert("day".into(), Value::String(d.clone())),
            _ => return Err(CloudError::Invalid("day")),
        };
    }
    if collection == Collection::TradeNotes {
        match &record.trade_key {
            Some(k) if is_key(k) => row.insert("trade_key".into(), Value::String(k.clone())),
            _ => return Err(CloudError::Invalid("trade")),
        };
        let playbook = match &record.playbook_id {
            Some(p) if is_uuid(p) => Value::String(p.clone()),
            Some(_) => return Err(CloudError::Invalid("playbook")),
            None => Value::Null,
        };
        row.insert("playbook_id".into(), playbook);
    }
    if !record.data.is_object() {
        return Err(CloudError::Invalid("data"));
    }
    let size = serde_json::to_vec(&record.data).map_or(usize::MAX, |b| b.len());
    if size > MAX_RECORD {
        return Err(CloudError::Invalid("too large"));
    }
    row.insert("data".into(), record.data.clone());
    Ok(Value::Object(row))
}

fn parse_rows(bytes: &[u8]) -> Result<Vec<CloudRecord>, CloudError> {
    serde_json::from_slice(bytes)
        .map_err(|_| CloudError::Rejected("the cloud's answer couldn't be read".into()))
}

/// A request with the session, signed out again if the store says so.
async fn send(
    state: &CloudState,
    build: impl Fn(&str) -> Result<reqwest::RequestBuilder, CloudError>,
    max: usize,
) -> Result<(u16, Vec<u8>), CloudError> {
    let (access, _) = state.access().await?;
    let response = build(access.as_str())?.send().await.map_err(network)?;
    let status = response.status().as_u16();
    let bytes = read_capped(response, max).await?;
    if status == 401 {
        // The access token was revoked early: drop it, and the next call
        // refreshes (or signs out).
        *state.session.lock().await = None;
        return Err(CloudError::SignedOut);
    }
    Ok((status, bytes))
}

#[tauri::command]
pub async fn cloud_list(
    state: State<'_, CloudState>,
    collection: Collection,
    query: Option<CloudQuery>,
) -> Result<Vec<CloudRecord>, CloudError> {
    let params = list_params(collection, &query.unwrap_or_default())?;
    let path = format!("/rest/v1/{}", collection.table());
    let (status, bytes) = send(
        &state,
        |access| {
            Ok(state
                .request(reqwest::Method::GET, &path, access)?
                .query(&params))
        },
        MAX_LIST,
    )
    .await?;
    if status != 200 {
        return Err(rejected(status, &bytes));
    }
    parse_rows(&bytes)
}

/// Writes one record whole (insert, or replace on its natural key); returns
/// it as stored.
#[tauri::command]
pub async fn cloud_put(
    state: State<'_, CloudState>,
    collection: Collection,
    record: CloudRecord,
) -> Result<CloudRecord, CloudError> {
    let body = row(collection, &record)?;
    let path = format!("/rest/v1/{}", collection.table());
    let conflict = [("on_conflict", collection.conflict())];
    let (status, bytes) = send(
        &state,
        |access| {
            Ok(state
                .request(reqwest::Method::POST, &path, access)?
                .query(&conflict)
                .header(
                    "Prefer",
                    "resolution=merge-duplicates,return=representation",
                )
                .json(&body))
        },
        MAX_RECORD * 2,
    )
    .await?;
    if !(200..300).contains(&status) {
        return Err(rejected(status, &bytes));
    }
    parse_rows(&bytes)?
        .into_iter()
        .next()
        .ok_or_else(|| CloudError::Rejected("the record wasn't stored".into()))
}

#[tauri::command]
pub async fn cloud_delete(
    state: State<'_, CloudState>,
    collection: Collection,
    id: String,
) -> Result<(), CloudError> {
    if !is_uuid(&id) {
        return Err(CloudError::Invalid("id"));
    }
    let path = format!("/rest/v1/{}", collection.table());
    let filter = [("id", format!("eq.{id}"))];
    let (status, bytes) = send(
        &state,
        |access| {
            Ok(state
                .request(reqwest::Method::DELETE, &path, access)?
                .query(&filter))
        },
        64 * 1024,
    )
    .await?;
    if (200..300).contains(&status) {
        Ok(())
    } else {
        Err(rejected(status, &bytes))
    }
}

// ---- attachments -----------------------------------------------------------

fn image_kind(bytes: &[u8]) -> Option<(&'static str, &'static str)> {
    if bytes.len() <= 16 || bytes.len() > MAX_IMAGE {
        None
    } else if bytes.starts_with(&PNG_SIGNATURE) {
        Some(("image/png", "png"))
    } else if bytes.starts_with(&JPEG_SIGNATURE) {
        Some(("image/jpeg", "jpg"))
    } else {
        None
    }
}

/// `<user id>/<32 hex>.<png|jpg>`, and the user's own.
fn own_path(path: &str, user_id: &str) -> bool {
    let Some((owner, name)) = path.split_once('/') else {
        return false;
    };
    let Some((stem, ext)) = name.split_once('.') else {
        return false;
    };
    owner == user_id
        && stem.len() == 32
        && stem.bytes().all(|b| b.is_ascii_hexdigit())
        && matches!(ext, "png" | "jpg")
}

/// Stores the image in the request body; returns its path, for a record's
/// `data` to name.
#[tauri::command]
pub async fn cloud_upload(
    state: State<'_, CloudState>,
    request: Request<'_>,
) -> Result<String, CloudError> {
    let InvokeBody::Raw(bytes) = request.body() else {
        return Err(CloudError::Invalid("image"));
    };
    let (mime, ext) = image_kind(bytes).ok_or(CloudError::Invalid("image"))?;
    let (_, user_id) = state.access().await?;
    let mut random = [0u8; 16];
    getrandom::getrandom(&mut random).map_err(|_| CloudError::Invalid("random"))?;
    let stem: String = random.iter().map(|b| format!("{b:02x}")).collect();
    let path = format!("{user_id}/{stem}.{ext}");
    let url = format!("/storage/v1/object/{BUCKET}/{path}");
    let body = bytes.clone();
    let (status, answer) = send(
        &state,
        |access| {
            Ok(state
                .request(reqwest::Method::POST, &url, access)?
                .header("Content-Type", mime)
                .body(body.clone()))
        },
        64 * 1024,
    )
    .await?;
    if (200..300).contains(&status) {
        Ok(path)
    } else {
        Err(rejected(status, &answer))
    }
}

/// An attachment's bytes, for the page to show.
#[tauri::command]
pub async fn cloud_attachment(
    state: State<'_, CloudState>,
    path: String,
) -> Result<Response, CloudError> {
    let (_, user_id) = state.access().await?;
    if !own_path(&path, &user_id) {
        return Err(CloudError::Invalid("path"));
    }
    let url = format!("/storage/v1/object/authenticated/{BUCKET}/{path}");
    let (status, bytes) = send(
        &state,
        |access| state.request(reqwest::Method::GET, &url, access),
        MAX_IMAGE,
    )
    .await?;
    if status != 200 {
        return Err(rejected(status, &bytes));
    }
    if image_kind(&bytes).is_none() {
        return Err(CloudError::Rejected("that isn't an image".into()));
    }
    Ok(Response::new(bytes))
}

#[tauri::command]
pub async fn cloud_remove_attachment(
    state: State<'_, CloudState>,
    path: String,
) -> Result<(), CloudError> {
    let (_, user_id) = state.access().await?;
    if !own_path(&path, &user_id) {
        return Err(CloudError::Invalid("path"));
    }
    let url = format!("/storage/v1/object/{BUCKET}/{path}");
    let (status, bytes) = send(
        &state,
        |access| state.request(reqwest::Method::DELETE, &url, access),
        64 * 1024,
    )
    .await?;
    if (200..300).contains(&status) {
        Ok(())
    } else {
        Err(rejected(status, &bytes))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const ID: &str = "3f2b8c1e-9a4d-4e2b-8f1a-2c3d4e5f6a7b";

    #[test]
    fn takes_only_an_https_project() {
        assert!(Config::checked("https://abc.supabase.co", "key").is_some());
        assert!(Config::checked("http://abc.supabase.co", "key").is_none());
        assert!(Config::checked("https://abc.supabase.co/path", "key").is_none());
        assert!(Config::checked("https://user@abc.supabase.co", "key").is_none());
        assert!(Config::checked("https://abc.supabase.co", "").is_none());
        assert!(Config::checked("https://abc.supabase.co", "a key").is_none());
    }

    #[test]
    fn checks_values_before_building_a_query() {
        let query = CloudQuery {
            account_key: Some("hyperliquid:0xabc".into()),
            from: Some("2026-10-26".into()),
            to: Some("2026-11-04".into()),
            ..Default::default()
        };
        let params = list_params(Collection::JournalDays, &query).unwrap();
        assert!(params.contains(&("account_key".into(), "eq.hyperliquid:0xabc".into())));
        assert!(params.contains(&("day".into(), "gte.2026-10-26".into())));

        let bad = |q: CloudQuery, c| list_params(c, &q).is_err();
        assert!(bad(
            CloudQuery {
                account_key: Some("a,b)".into()),
                ..Default::default()
            },
            Collection::Plans
        ));
        assert!(bad(
            CloudQuery {
                from: Some("2026-13-01".into()),
                ..Default::default()
            },
            Collection::JournalDays
        ));
        // Playbooks have no account or day.
        assert!(bad(
            CloudQuery {
                account_key: Some("bybit:1".into()),
                ..Default::default()
            },
            Collection::Playbooks
        ));
        assert!(bad(
            CloudQuery {
                trade_key: Some("x".into()),
                ..Default::default()
            },
            Collection::JournalDays
        ));
    }

    #[test]
    fn sends_only_the_tables_columns() {
        let record = CloudRecord {
            id: Some(ID.into()),
            account_key: Some("bybit:42".into()),
            day: Some("2026-11-04".into()),
            trade_key: Some("BTCUSDT:long:1:2".into()),
            playbook_id: None,
            data: serde_json::json!({ "lesson": "wait" }),
            updated_at: None,
        };
        let body = row(Collection::JournalDays, &record).unwrap();
        let keys: Vec<_> = body.as_object().unwrap().keys().cloned().collect();
        assert_eq!(keys, ["account_key", "data", "day"]);

        let body = row(Collection::TradeNotes, &record).unwrap();
        assert_eq!(body["playbook_id"], Value::Null);
        assert!(body.get("user_id").is_none());

        let body = row(Collection::Playbooks, &record).unwrap();
        let keys: Vec<_> = body.as_object().unwrap().keys().cloned().collect();
        assert_eq!(keys, ["data", "id"]);
    }

    #[test]
    fn refuses_records_that_dont_fit() {
        let base = CloudRecord {
            account_key: Some("bybit:42".into()),
            day: Some("2026-11-04".into()),
            data: serde_json::json!({}),
            ..Default::default()
        };
        assert!(
            row(Collection::Playbooks, &base).is_err(),
            "a playbook needs an id"
        );
        let mut not_object = base.clone();
        not_object.data = serde_json::json!([1, 2]);
        assert!(row(Collection::JournalDays, &not_object).is_err());
        let mut huge = base.clone();
        huge.data = serde_json::json!({ "notes": "x".repeat(MAX_RECORD) });
        assert!(row(Collection::JournalDays, &huge).is_err());
        let mut bad_id = base;
        bad_id.id = Some("not-a-uuid".into());
        assert!(row(Collection::JournalDays, &bad_id).is_err());
    }

    #[test]
    fn reads_rows_with_snake_case_columns() {
        let rows = parse_rows(
            br#"[{"id":"3f2b8c1e-9a4d-4e2b-8f1a-2c3d4e5f6a7b","user_id":"u","account_key":"bybit:42",
                 "day":"2026-11-04","data":{"a":1},"updated_at":"2026-11-04T20:05:00Z"}]"#,
        )
        .unwrap();
        assert_eq!(rows[0].account_key.as_deref(), Some("bybit:42"));
        assert_eq!(rows[0].updated_at.as_deref(), Some("2026-11-04T20:05:00Z"));
        // And they go back to the page in camelCase.
        let json = serde_json::to_value(&rows[0]).unwrap();
        assert_eq!(json["accountKey"], "bybit:42");
    }

    #[test]
    fn attachments_are_images_under_the_owner() {
        let mut png = PNG_SIGNATURE.to_vec();
        png.extend([0; 32]);
        assert_eq!(image_kind(&png), Some(("image/png", "png")));
        assert_eq!(image_kind(b"<svg xmlns=...>  ....."), None);
        let stem = "0123456789abcdef0123456789abcdef";
        assert!(own_path(&format!("{ID}/{stem}.png"), ID));
        assert!(!own_path(&format!("{ID}/{stem}.png"), "other"));
        assert!(!own_path(&format!("{ID}/../x/{stem}.png"), ID));
        assert!(!own_path(&format!("{ID}/{stem}.svg"), ID));
    }

    #[test]
    fn checks_emails_and_days() {
        assert!(is_email("trader@example.com"));
        assert!(!is_email("trader"));
        assert!(!is_email("a b@example.com"));
        assert!(is_day("2026-02-28"));
        assert!(!is_day("2026-2-28"));
        assert!(!is_day("2026-00-10"));
    }

    #[test]
    fn errors_carry_no_token() {
        let e = rejected(400, br#"{"msg":"Token has expired or is invalid"}"#);
        assert_eq!(
            e,
            CloudError::Rejected("Token has expired or is invalid".into())
        );
        let e = rejected(500, b"<html>");
        assert_eq!(e, CloudError::Rejected("status 500".into()));
    }
}
