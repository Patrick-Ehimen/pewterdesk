//! The live news wire, for the News feed panel: headlines and tweets from
//! two aggregators, Tree News (Tree of Alpha) and Phoenix News, which watch
//! X accounts, blogs and exchanges and push what they see over a websocket.
//! They're data sources, not venues: nothing is signed, nothing is sent but
//! the login, and each is reached only at its fixed address (`TREE_WS`,
//! `TREE_HISTORY`, `PHOENIX_WS`).
//!
//! Tree's feed is open without a key, about 5 seconds behind; a subscriber's
//! key takes the delay off. Phoenix needs a key. Keys live in the keychain
//! (`treenews:api`, `phoenix:api`), are read only to log in, and are never
//! returned to the page.
//!
//! What arrives is somebody else's text, and on X anyone can post anything,
//! so it's treated as text: control characters dropped, lengths bounded,
//! coin tickers checked. Links stay in Rust: the page gets an id and the
//! link's host, and `open_wire_link` opens only a link this module was
//! sent, over https, filtered by `safe_url`.

use std::collections::{HashMap, VecDeque};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use futures_util::{SinkExt, StreamExt};
use pewterdesk_core::{KeySource, VenueError};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::ipc::Channel;
use tauri::{State, Webview};
use tokio::sync::mpsc;
use tokio_tungstenite::tungstenite::protocol::WebSocketConfig;
use tokio_tungstenite::tungstenite::Message;
use zeroize::Zeroizing;

use crate::about::open_url;
use crate::coin_info::safe_url;
use crate::econ_calendar::iso_time;
use crate::keychain::{self, KeychainKeySource};
use crate::news_feeds::unescape;
use crate::venues::{StreamEvent, Venues};

const TREE_WS: &str = "wss://news.treeofalpha.com/ws";
/// Tree's recent items, to fill the panel when it opens. Delayed, like the free feed.
const TREE_HISTORY: &str = "https://news.treeofalpha.com/api/news?limit=100";
const PHOENIX_WS: &str = "wss://wss.phoenixnews.io";

const USER_AGENT: &str = concat!("pewterdesk/", env!("CARGO_PKG_VERSION"));
const CONNECT_TIMEOUT: Duration = Duration::from_secs(15);
/// A ping goes out this often while the feed is quiet.
const PING_EVERY: Duration = Duration::from_secs(30);
/// No frame at all for this long (not even a pong) and the connection is dropped.
const SILENT_FOR: Duration = Duration::from_secs(95);
/// Waits between reconnects: doubling from the first to the last.
const BACKOFF_FIRST: Duration = Duration::from_secs(2);
const BACKOFF_LAST: Duration = Duration::from_secs(60);
/// A connection that lasted this long resets the backoff.
const STEADY_FOR: Duration = Duration::from_secs(60);
/// One message, at most; an item is a few KB.
const MAX_MESSAGE: usize = 256 * 1024;
const MAX_HISTORY_BYTES: usize = 2 * 1024 * 1024;

const MAX_TEXT: usize = 2000;
const MAX_NAME: usize = 80;
const MAX_HANDLE: usize = 32;
const MAX_ID: usize = 64;
const MAX_COINS: usize = 8;
const MAX_COIN: usize = 15;
/// Links kept to open, newest last; older ones can no longer be opened.
const MAX_LINKS: usize = 2000;
/// Items kept for the AI analyst to search, newest last.
const MAX_RECENT: usize = 1000;

/// Where an item came from.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum WireSource {
    Tree,
    Phoenix,
}

impl WireSource {
    const ALL: [WireSource; 2] = [WireSource::Tree, WireSource::Phoenix];

    fn key_account(self) -> &'static str {
        match self {
            WireSource::Tree => "treenews:api",
            WireSource::Phoenix => "phoenix:api",
        }
    }

    fn address(self) -> &'static str {
        match self {
            WireSource::Tree => TREE_WS,
            WireSource::Phoenix => PHOENIX_WS,
        }
    }

    fn name(self) -> &'static str {
        match self {
            WireSource::Tree => "tree",
            WireSource::Phoenix => "phoenix",
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum WireKind {
    /// A post on X.
    Tweet,
    /// A headline: a blog, an exchange's announcement, a filing.
    News,
}

/// What a tweet is, beyond a post of the author's own.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum WireFlag {
    Retweet,
    Quote,
    Reply,
}

/// One item, as the page takes it: text, no links.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WireItem {
    /// `<source>:<the aggregator's id>`; names the link to `open_wire_link`.
    pub id: String,
    pub source: WireSource,
    pub kind: WireKind,
    /// The account's display name, or the outlet ("DECRYPT", "Binance EN").
    pub author: String,
    /// The X handle, without "@".
    pub handle: Option<String>,
    pub text: String,
    /// Tickers the aggregator found in it ("SOL").
    pub coins: Vec<String>,
    /// When it was posted, in milliseconds since the Unix epoch.
    pub time: u64,
    pub flag: Option<WireFlag>,
    /// The aggregator marked it as important.
    pub important: bool,
    /// Where its link goes ("x.com"), if it has one that may be opened.
    pub link_host: Option<String>,
}

/// How one source's connection stands.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum FeedState {
    Connecting,
    /// Connected; `delayed` while it's the free feed.
    Live {
        delayed: bool,
    },
    /// Phoenix, without a key: nothing to connect with.
    NeedsKey,
    /// Lost, or couldn't connect; it's tried again.
    Down,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum WireEvent {
    Items {
        items: Vec<WireItem>,
    },
    Status {
        source: WireSource,
        state: FeedState,
    },
}

/// The links of the items sent, by id; the oldest go first past `MAX_LINKS`.
/// And the items themselves, the last `MAX_RECENT`, for the AI analyst.
#[derive(Default)]
struct Links {
    by_id: HashMap<String, String>,
    order: VecDeque<String>,
    recent: VecDeque<WireItem>,
}

impl Links {
    fn insert(&mut self, id: String, url: String) {
        if self.by_id.insert(id.clone(), url).is_none() {
            self.order.push_back(id);
        }
        while self.order.len() > MAX_LINKS {
            if let Some(old) = self.order.pop_front() {
                self.by_id.remove(&old);
            }
        }
    }

    fn keep(&mut self, item: &WireItem) {
        if self.recent.iter().any(|i| i.id == item.id) {
            return;
        }
        self.recent.push_back(item.clone());
        while self.recent.len() > MAX_RECENT {
            self.recent.pop_front();
        }
    }
}

pub struct NewsWireState {
    http: reqwest::Client,
    links: Arc<Mutex<Links>>,
}

impl NewsWireState {
    pub fn new() -> Result<Self, VenueError> {
        let http = reqwest::Client::builder()
            .timeout(CONNECT_TIMEOUT)
            .user_agent(USER_AGENT)
            .gzip(true)
            // Never sent anywhere but the host asked for.
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .map_err(|e| VenueError::Network(e.to_string()))?;
        Ok(Self {
            http,
            links: Arc::new(Mutex::new(Links::default())),
        })
    }
}

/// Feed text as text: entities read, control characters (but line breaks)
/// dropped, runs of blank lines closed up, at most `max` characters.
fn clean(text: &str, max: usize) -> String {
    let text = unescape(text).replace("\r\n", "\n");
    let mut out = String::with_capacity(text.len().min(max * 4));
    let mut breaks = 0;
    for ch in text.chars() {
        if ch == '\n' {
            breaks += 1;
            if breaks <= 2 {
                out.push('\n');
            }
            continue;
        }
        if ch.is_control() || matches!(ch, '\u{200b}'..='\u{200f}' | '\u{202a}'..='\u{202e}') {
            continue;
        }
        breaks = 0;
        out.push(ch);
    }
    out.trim().chars().take(max).collect()
}

/// One line of text: `clean`, with line breaks as spaces.
fn line(text: &str, max: usize) -> String {
    clean(&text.replace('\n', " "), max)
}

/// An X handle ("GoGalaGames"), or nothing if it isn't one.
fn handle(text: &str) -> Option<String> {
    let text = text.trim().trim_start_matches('@');
    let ok = !text.is_empty()
        && text.len() <= MAX_HANDLE
        && text.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_');
    ok.then(|| text.to_owned())
}

/// A ticker ("SOL", "1000PEPE"), or nothing if it isn't one.
fn coin(text: &str) -> Option<String> {
    let text = text.trim().to_ascii_uppercase();
    let ok = !text.is_empty()
        && text.len() <= MAX_COIN
        && text.bytes().all(|b| b.is_ascii_alphanumeric());
    ok.then_some(text)
}

/// The tickers the aggregator found: its `suggestions`, then its `coin`.
fn coins(v: &Value) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    let found = v
        .get("suggestions")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|s| s.get("coin").and_then(Value::as_str))
        .chain(v.get("coin").and_then(Value::as_str));
    for c in found.filter_map(coin) {
        if !out.contains(&c) && out.len() < MAX_COINS {
            out.push(c);
        }
    }
    out
}

/// A link that may be opened, and its host: https, plain enough for `safe_url`.
fn link(url: &str) -> Option<(String, String)> {
    let url = url.trim().trim_end_matches('#');
    let rest = url.strip_prefix("https://")?;
    let host = rest.split(['/', '?', '#']).next().unwrap_or("");
    if host.is_empty() || host.contains(['@', ':']) {
        return None;
    }
    let url = safe_url(url)?;
    let host = host.to_ascii_lowercase();
    let host = host.strip_prefix("www.").unwrap_or(&host).to_owned();
    Some((url, host))
}

fn text_of<'a>(v: &'a Value, key: &str) -> &'a str {
    v.get(key).and_then(Value::as_str).unwrap_or("")
}

fn flag_of(v: &Value) -> Option<WireFlag> {
    let on = |key: &str| v.get(key).and_then(Value::as_bool).unwrap_or(false);
    if on("isRetweet") {
        Some(WireFlag::Retweet)
    } else if on("isQuote") {
        Some(WireFlag::Quote)
    } else if on("isReply") && !on("isSelfReply") {
        Some(WireFlag::Reply)
    } else {
        None
    }
}

fn id_of(v: &Value, keys: &[&str]) -> Option<String> {
    keys.iter().find_map(|key| {
        let id = match v.get(*key)? {
            Value::String(s) => s.clone(),
            Value::Number(n) => n.to_string(),
            _ => return None,
        };
        let ok = !id.is_empty()
            && id.len() <= MAX_ID
            && id
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_');
        ok.then_some(id)
    })
}

/// "Gala Games (@GoGalaGames)", or with the post after it as Tree's history
/// sends it ("Gala Games (@GoGalaGames): Are you ..."): the name, handle and post.
fn split_tree_title(title: &str) -> (String, Option<String>, Option<String>) {
    if let Some(open) = title.find(" (@") {
        if let Some(close) = title[open..].find(')') {
            let close = open + close;
            let name = title[..open].to_owned();
            let handle = handle(&title[open + 3..close]);
            let post = title[close + 1..]
                .strip_prefix(':')
                .map(|post| post.trim().to_owned())
                .filter(|post| !post.is_empty());
            return (name, handle, post);
        }
    }
    (title.to_owned(), None, None)
}

/// One of Tree's messages as an item, and its link.
fn tree_item(v: &Value) -> Option<(WireItem, Option<String>)> {
    let id = id_of(v, &["_id"])?;
    let time = v.get("time").and_then(Value::as_u64)?;
    let title = text_of(v, "title");
    let body = text_of(v, "body");
    let url = [text_of(v, "url"), text_of(v, "link")]
        .into_iter()
        .find(|u| !u.is_empty())
        .unwrap_or("");
    let found = link(url);
    let on_x = found
        .as_ref()
        .is_some_and(|(_, host)| host == "x.com" || host == "twitter.com");
    let tweet =
        text_of(v, "source").eq_ignore_ascii_case("twitter") || v.get("info").is_some() && on_x;
    let info = v.get("info").unwrap_or(&Value::Null);
    let (kind, author, handle, text, flag) = if tweet {
        let (name, handle, post) = split_tree_title(title);
        let text = if body.is_empty() {
            post.unwrap_or_default()
        } else {
            body.to_owned()
        };
        (WireKind::Tweet, name, handle, text, flag_of(info))
    } else {
        let outlet = [text_of(v, "sourceName"), text_of(v, "source")]
            .into_iter()
            .find(|s| !s.is_empty())
            .unwrap_or("Tree News")
            .to_owned();
        // "DECRYPT: GTA 6 Trailer..." reads as the headline, under its outlet.
        let headline = title
            .strip_prefix(outlet.as_str())
            .and_then(|rest| rest.strip_prefix(':'))
            .map_or(title, str::trim);
        let text = if body.is_empty() || body == title {
            headline.to_owned()
        } else {
            format!("{headline}\n{body}")
        };
        (WireKind::News, outlet, None, text, None)
    };
    item(
        WireSource::Tree,
        id,
        kind,
        &author,
        handle,
        &text,
        coins(v),
        time,
        flag,
        false,
        found,
    )
}

/// One of Phoenix's messages as an item, and its link. Its heartbeats, and
/// a profile changing or a post being pinned or deleted, aren't items.
fn phoenix_item(v: &Value) -> Option<(WireItem, Option<String>)> {
    let skip = [
        "isProfileUpdate",
        "isTweetDeleted",
        "isTweetPinned",
        "isFollowUpdate",
    ];
    if skip
        .iter()
        .any(|key| v.get(*key).and_then(Value::as_bool) == Some(true))
    {
        return None;
    }
    let time = [text_of(v, "createdAt"), text_of(v, "receivedAt")]
        .into_iter()
        .find_map(iso_time)?;
    let found = link(text_of(v, "url"));
    let important = v.get("important").and_then(Value::as_bool).unwrap_or(false);
    if v.get("username").is_some() {
        let id = id_of(v, &["tweetId", "_id"])?;
        let text = [text_of(v, "body"), text_of(v, "text")]
            .into_iter()
            .find(|t| !t.is_empty())
            .unwrap_or("");
        let name = text_of(v, "name");
        let handle = handle(text_of(v, "username"));
        let author = if name.is_empty() {
            handle.clone().unwrap_or_default()
        } else {
            name.to_owned()
        };
        let flag = flag_of(v);
        return item(
            WireSource::Phoenix,
            id,
            WireKind::Tweet,
            &author,
            handle,
            text,
            coins(v),
            time,
            flag,
            important,
            found,
        );
    }
    let title = text_of(v, "title");
    if title.is_empty() {
        return None;
    }
    let id = id_of(v, &["_id", "noticeId"])?;
    let outlet = [text_of(v, "sourceName"), text_of(v, "source")]
        .into_iter()
        .find(|s| !s.is_empty())
        .unwrap_or("Phoenix News");
    item(
        WireSource::Phoenix,
        id,
        WireKind::News,
        outlet,
        None,
        title,
        coins(v),
        time,
        None,
        important,
        found,
    )
}

#[allow(clippy::too_many_arguments)]
fn item(
    source: WireSource,
    id: String,
    kind: WireKind,
    author: &str,
    handle: Option<String>,
    text: &str,
    coins: Vec<String>,
    time: u64,
    flag: Option<WireFlag>,
    important: bool,
    found: Option<(String, String)>,
) -> Option<(WireItem, Option<String>)> {
    let text = clean(text, MAX_TEXT);
    let author = line(author, MAX_NAME);
    if text.is_empty() || author.is_empty() {
        return None;
    }
    let (url, host) = found.map_or((None, None), |(url, host)| (Some(url), Some(host)));
    let item = WireItem {
        id: format!("{}:{id}", source.name()),
        source,
        kind,
        author,
        handle,
        text,
        coins,
        time,
        flag,
        important,
        link_host: host,
    };
    Some((item, url))
}

fn parse(source: WireSource, text: &str) -> Option<(WireItem, Option<String>)> {
    let v: Value = serde_json::from_str(text).ok()?;
    match source {
        WireSource::Tree => tree_item(&v),
        WireSource::Phoenix => phoenix_item(&v),
    }
}

/// Keeps each item's link, and hands the items on.
fn send_items(
    links: &Mutex<Links>,
    tx: &mpsc::Sender<WireEvent>,
    read: Vec<(WireItem, Option<String>)>,
) -> bool {
    if read.is_empty() {
        return true;
    }
    let mut kept = links.lock().unwrap();
    let items = read
        .into_iter()
        .map(|(item, url)| {
            if let Some(url) = url {
                kept.insert(item.id.clone(), url);
            }
            kept.keep(&item);
            item
        })
        .collect();
    drop(kept);
    tx.try_send(WireEvent::Items { items }).is_ok() || !tx.is_closed()
}

/// Tree's recent items, read once when the panel opens.
async fn tree_history(http: &reqwest::Client) -> Vec<(WireItem, Option<String>)> {
    let Ok(mut response) = http.get(TREE_HISTORY).send().await else {
        return Vec::new();
    };
    if response.status().as_u16() != 200 {
        return Vec::new();
    }
    let mut body = Vec::new();
    while let Ok(Some(chunk)) = response.chunk().await {
        if body.len() + chunk.len() > MAX_HISTORY_BYTES {
            return Vec::new();
        }
        body.extend_from_slice(&chunk);
    }
    let Ok(list) = serde_json::from_slice::<Vec<Value>>(&body) else {
        return Vec::new();
    };
    list.iter().filter_map(tree_item).collect()
}

fn status(tx: &mpsc::Sender<WireEvent>, source: WireSource, state: FeedState) {
    let _ = tx.try_send(WireEvent::Status { source, state });
}

async fn stored_key(source: WireSource) -> Option<Zeroizing<String>> {
    KeychainKeySource
        .key(source.key_account())
        .await
        .ok()
        .filter(|key| !key.is_empty())
}

/// One connection, until it's lost or the page stops listening. True if the
/// page stopped.
async fn connect_once(
    source: WireSource,
    key: Option<&Zeroizing<String>>,
    tx: &mpsc::Sender<WireEvent>,
    links: &Mutex<Links>,
) -> bool {
    let mut config = WebSocketConfig::default();
    config.max_message_size = Some(MAX_MESSAGE);
    config.max_frame_size = Some(MAX_MESSAGE);
    let connect =
        tokio_tungstenite::connect_async_with_config(source.address(), Some(config), false);
    let Ok(Ok((mut ws, _))) = tokio::time::timeout(CONNECT_TIMEOUT, connect).await else {
        return tx.is_closed();
    };
    if let Some(key) = key {
        let login = Zeroizing::new(format!("login {}", key.as_str()));
        if ws.send(Message::text(login.as_str())).await.is_err() {
            return tx.is_closed();
        }
    }
    status(
        tx,
        source,
        FeedState::Live {
            delayed: source == WireSource::Tree && key.is_none(),
        },
    );
    let mut ping = tokio::time::interval(PING_EVERY);
    ping.tick().await;
    let mut heard = Instant::now();
    loop {
        tokio::select! {
            () = tx.closed() => {
                let _ = ws.close(None).await;
                return true;
            }
            _ = ping.tick() => {
                if heard.elapsed() > SILENT_FOR || ws.send(Message::Ping(Vec::new().into())).await.is_err() {
                    return false;
                }
            }
            frame = ws.next() => {
                heard = Instant::now();
                match frame {
                    Some(Ok(Message::Text(text))) => {
                        let read: Vec<_> = parse(source, text.as_str()).into_iter().collect();
                        if !send_items(links, tx, read) {
                            return true;
                        }
                    }
                    Some(Ok(Message::Close(_))) | Some(Err(_)) | None => return false,
                    Some(Ok(_)) => {}
                }
            }
        }
    }
}

/// One source's feed for one page: connects, reconnects with a growing wait,
/// and ends when the page stops listening.
async fn run(source: WireSource, tx: mpsc::Sender<WireEvent>, links: Arc<Mutex<Links>>) {
    let key = stored_key(source).await;
    if source == WireSource::Phoenix && key.is_none() {
        status(&tx, source, FeedState::NeedsKey);
        return;
    }
    let mut wait = BACKOFF_FIRST;
    loop {
        status(&tx, source, FeedState::Connecting);
        let began = Instant::now();
        if connect_once(source, key.as_ref(), &tx, &links).await {
            return;
        }
        status(&tx, source, FeedState::Down);
        if began.elapsed() > STEADY_FOR {
            wait = BACKOFF_FIRST;
        }
        tokio::select! {
            () = tx.closed() => return,
            () = tokio::time::sleep(wait) => {}
        }
        wait = (wait * 2).min(BACKOFF_LAST);
    }
}

/// The wire's recent items, newest first, for the AI analyst: Tree's
/// latest (read now, keyless) and whatever the live wire has brought in
/// while the app ran. Text only, as the page gets them.
pub async fn recent_items(wire: &NewsWireState) -> Vec<WireItem> {
    let read = tree_history(&wire.http).await;
    let mut kept = wire.links.lock().unwrap();
    for (item, url) in read {
        if let Some(url) = url {
            kept.insert(item.id.clone(), url);
        }
        kept.keep(&item);
    }
    let mut items: Vec<WireItem> = kept.recent.iter().cloned().collect();
    drop(kept);
    items.sort_by_key(|i| std::cmp::Reverse(i.time));
    items
}

/// Streams both sources to the page: Tree's recent items first, then what
/// arrives, with each source's state as it changes. Returns the id to pass
/// to `unsubscribe`.
#[tauri::command]
pub async fn subscribe_news_wire(
    venues: State<'_, Venues>,
    wire: State<'_, NewsWireState>,
    webview: Webview,
    on_event: Channel<StreamEvent<WireEvent>>,
) -> Result<u32, VenueError> {
    let (tx, rx) = mpsc::channel(256);
    let http = wire.http.clone();
    let links = Arc::clone(&wire.links);
    let history_tx = tx.clone();
    let history_links = Arc::clone(&links);
    tauri::async_runtime::spawn(async move {
        let read = tree_history(&http).await;
        send_items(&history_links, &history_tx, read);
    });
    for source in WireSource::ALL {
        tauri::async_runtime::spawn(run(source, tx.clone(), Arc::clone(&links)));
    }
    Ok(venues.forward(rx, on_event, &webview))
}

/// Stores a source's API key; the feed picks it up when it next connects.
#[tauri::command]
pub async fn set_news_key(source: WireSource, key: String) -> Result<(), VenueError> {
    let key = Zeroizing::new(key.trim().to_owned());
    let ok = !key.is_empty()
        && key.len() <= 256
        && key
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'.'));
    if !ok {
        return Err(VenueError::InvalidRequest(
            "that doesn't look like an API key".into(),
        ));
    }
    keychain::store_key(source.key_account().to_owned(), key)
        .await
        .map_err(|e| VenueError::Key(e.into()))
}

/// Which sources have a key stored. Never returns one, and never reads
/// one: an existence check, so it asks macOS for no password.
#[tauri::command]
pub async fn news_keys() -> Result<HashMap<WireSource, bool>, VenueError> {
    let mut out = HashMap::new();
    for source in WireSource::ALL {
        let has = keychain::has_secret(source.key_account().to_owned())
            .await
            .unwrap_or(false);
        out.insert(source, has);
    }
    Ok(out)
}

#[tauri::command]
pub async fn clear_news_key(source: WireSource) -> Result<(), VenueError> {
    keychain::delete_key(source.key_account().to_owned())
        .await
        .map_err(|e| VenueError::Key(e.into()))
}

/// Opens an item's link in the browser, by the id the wire gave the item -
/// never a URL from the UI.
#[tauri::command]
pub fn open_wire_link(wire: State<'_, NewsWireState>, id: String) -> Result<(), VenueError> {
    let url = wire
        .links
        .lock()
        .unwrap()
        .by_id
        .get(&id)
        .cloned()
        .ok_or_else(|| VenueError::InvalidRequest("that link isn't available".into()))?;
    open_url(&url).map_err(|_| VenueError::Network("couldn't open the browser".into()))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// As Tree's websocket sends a tweet (its docs' example).
    const TREE_TWEET: &str = r#"{
      "_id": "1749403469352710423",
      "body": "Are you a Founder's Node operator? Do you like drops?\n\n\n\nThank you $GALA &amp; co",
      "coin": "GALA",
      "icon": "https://pbs.twimg.com/profile_images/1/x.jpg",
      "info": {"isQuote": false, "isReply": false, "isRetweet": true, "twitterId": "1288572182444961793"},
      "link": "https://twitter.com/GoGalaGames/status/1749403469352710423",
      "suggestions": [{"coin": "GALA", "found": ["GALA"]}, {"coin": "bad coin!"}],
      "time": 1705925264683,
      "title": "Gala Games (@GoGalaGames)",
      "type": "direct"
    }"#;

    /// As Tree's history sends one: the post in the title.
    const TREE_HISTORY_TWEET: &str = r#"{
      "_id": "2111034704548053389", "source": "Twitter",
      "title": "Startale (@StartaleGroup): This week's key updates",
      "url": "https://x.com/StartaleGroup/status/2111034704548053389#",
      "time": 1792144869709,
      "info": {"isReply": true, "isSelfReply": true, "isRetweet": false, "isQuote": false}
    }"#;

    /// As Tree's websocket sent a blog headline, live.
    const TREE_BLOG: &str = r#"{"title":"DECRYPT: GTA 6 Trailer Features Meme Coin","source":"Blogs",
      "url":"https://decrypt.co/381122","time":1792145763347,"sourceName":"DECRYPT",
      "_id":"1792145763345DG6TFMCSCS2","suggestions":[{"found":["Solana"],"coin":"SOL"}],"delay":5000}"#;

    #[test]
    fn reads_trees_tweets_live_and_from_history() {
        let (item, url) = parse(WireSource::Tree, TREE_TWEET).unwrap();
        assert_eq!(item.id, "tree:1749403469352710423");
        assert_eq!(item.kind, WireKind::Tweet);
        assert_eq!(item.author, "Gala Games");
        assert_eq!(item.handle.as_deref(), Some("GoGalaGames"));
        assert_eq!(item.flag, Some(WireFlag::Retweet));
        assert_eq!(
            item.text,
            "Are you a Founder's Node operator? Do you like drops?\n\nThank you $GALA & co",
            "entities read, blank lines closed up"
        );
        assert_eq!(item.coins, ["GALA"], "a ticker that isn't one is dropped");
        assert_eq!(item.link_host.as_deref(), Some("twitter.com"));
        assert!(url.unwrap().starts_with("https://twitter.com/GoGalaGames/"));

        let (item, url) = parse(WireSource::Tree, TREE_HISTORY_TWEET).unwrap();
        assert_eq!(item.author, "Startale");
        assert_eq!(item.handle.as_deref(), Some("StartaleGroup"));
        assert_eq!(item.text, "This week's key updates");
        assert_eq!(
            item.flag, None,
            "a reply to oneself is the author's own thread"
        );
        assert_eq!(
            url.as_deref(),
            Some("https://x.com/StartaleGroup/status/2111034704548053389")
        );
    }

    #[test]
    fn reads_trees_headlines_under_their_outlet() {
        let (item, _) = parse(WireSource::Tree, TREE_BLOG).unwrap();
        assert_eq!(item.kind, WireKind::News);
        assert_eq!(item.author, "DECRYPT");
        assert_eq!(item.text, "GTA 6 Trailer Features Meme Coin");
        assert_eq!(item.coins, ["SOL"]);
        assert_eq!(item.link_host.as_deref(), Some("decrypt.co"));
    }

    #[test]
    fn reads_phoenix_news_and_tweets() {
        let news = r#"{"source":"Terminal","sourceName":"TERMINAL","category":"SEC FILINGS",
          "receivedAt":"2024-12-02T11:02:01.084Z","createdAt":"2024-12-02T11:02:01.084Z",
          "url":"https://www.sec.gov/Archives/edgar/data/2046791/x-index.htm",
          "title":"WISDOMTREE FILES S-1 FOR XRP ETF","noticeId":"076409c9f8F","important":true,
          "suggestions":[{"coin":"XRP"}]}"#;
        let (item, _) = parse(WireSource::Phoenix, news).unwrap();
        assert_eq!(item.id, "phoenix:076409c9f8F");
        assert_eq!(item.author, "TERMINAL");
        assert!(item.important);
        assert_eq!(item.coins, ["XRP"]);
        assert_eq!(item.link_host.as_deref(), Some("sec.gov"));
        assert_eq!(item.time, iso_time("2024-12-02T11:02:01.084Z").unwrap());

        let tweet = r#"{"_id":"a1","createdAt":"2024-12-02T11:02:01Z","source":"Twitter",
          "username":"tier10k","name":"db","body":"BREAKING: something","text":"something",
          "url":"https://x.com/tier10k/status/1","tweetId":"1","isQuote":true,"coin":"btc"}"#;
        let (item, _) = parse(WireSource::Phoenix, tweet).unwrap();
        assert_eq!(item.id, "phoenix:1");
        assert_eq!(
            (item.author.as_str(), item.handle.as_deref()),
            ("db", Some("tier10k"))
        );
        assert_eq!(
            item.text, "BREAKING: something",
            "the full post, with what it quotes"
        );
        assert_eq!(item.flag, Some(WireFlag::Quote));
        assert_eq!(item.coins, ["BTC"]);
    }

    #[test]
    fn leaves_out_what_isnt_an_item() {
        assert!(parse(WireSource::Phoenix, r#"{"type":"heartbeat"}"#).is_none());
        let pinned = r#"{"_id":"a","createdAt":"2024-12-02T11:02:01Z","username":"x","body":"y","isTweetPinned":true}"#;
        assert!(parse(WireSource::Phoenix, pinned).is_none());
        assert!(parse(WireSource::Tree, "not json").is_none());
        assert!(parse(WireSource::Tree, r#"{"_id":"1","title":"no time"}"#).is_none());
        assert!(parse(
            WireSource::Tree,
            r#"{"_id":"bad id/../","time":1,"title":"x"}"#
        )
        .is_none());
        assert!(parse(WireSource::Tree, r#"{"_id":"1","time":1,"title":"  "}"#).is_none());
    }

    #[test]
    fn opens_only_plain_https_links() {
        assert_eq!(
            link("https://www.x.com/a/status/1").map(|l| l.1).as_deref(),
            Some("x.com")
        );
        assert!(link("http://x.com/a").is_none());
        assert!(link("javascript:alert(1)").is_none());
        assert!(link("https://x.com@evil.test/a").is_none());
        assert!(link("https://evil.test:8443/a").is_none());
        assert!(link("https://x.com/a b").is_none());
        assert!(link("").is_none());
    }

    #[test]
    fn keeps_text_as_text() {
        assert_eq!(clean("a\u{7}b\u{202e}c\r\nd", 80), "abc\nd");
        assert_eq!(clean(&"x".repeat(5000), MAX_TEXT).chars().count(), MAX_TEXT);
        assert_eq!(line("Gala\nGames", 80), "Gala Games");
        assert_eq!(handle("@tier_10k").as_deref(), Some("tier_10k"));
        assert_eq!(handle("not a handle"), None);
    }

    #[test]
    fn forgets_the_oldest_links_past_the_cap() {
        let mut links = Links::default();
        for i in 0..MAX_LINKS + 5 {
            links.insert(format!("tree:{i}"), format!("https://x.com/{i}"));
        }
        assert_eq!(links.by_id.len(), MAX_LINKS);
        assert!(!links.by_id.contains_key("tree:0"));
        assert!(links.by_id.contains_key(&format!("tree:{}", MAX_LINKS + 4)));
    }

    /// Reads Tree's real history and listens to its free feed for a while:
    /// needs the network, so it's skipped by default
    /// (`cargo test -p pewterdesk news_wire -- --ignored --nocapture`).
    #[test]
    #[ignore]
    fn reads_the_live_feed() {
        let state = NewsWireState::new().unwrap();
        let history = tauri::async_runtime::block_on(tree_history(&state.http));
        assert!(history.len() >= 20, "{} items", history.len());
        let tweets = history
            .iter()
            .filter(|(i, _)| i.kind == WireKind::Tweet)
            .count();
        println!(
            "history: {} items, {tweets} tweets; first: {:?}",
            history.len(),
            history[0].0
        );
        let (tx, mut rx) = mpsc::channel(64);
        let links = Arc::new(Mutex::new(Links::default()));
        tauri::async_runtime::block_on(async move {
            let feed = tauri::async_runtime::spawn(run(WireSource::Tree, tx, links));
            let mut live = false;
            let until = Instant::now() + Duration::from_secs(20);
            while Instant::now() < until {
                match tokio::time::timeout(Duration::from_secs(1), rx.recv()).await {
                    Ok(Some(WireEvent::Status { state, .. })) => {
                        println!("status: {state:?}");
                        live |= matches!(state, FeedState::Live { delayed: true });
                    }
                    Ok(Some(WireEvent::Items { items })) => println!("live: {:?}", items[0]),
                    _ => {}
                }
            }
            feed.abort();
            assert!(live, "never connected");
        });
    }
}
