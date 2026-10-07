//! What a coin is, for the Markets panel's Overview tab: market cap, FDV,
//! supplies, a description, categories, explorers, socials and official
//! links - from CoinGecko, which no venue serves. Read-only and keyless by
//! default; a CoinGecko demo API key, if the user adds one, raises the rate
//! limit.
//!
//! It also serves a coin's logo, as a last resort for a market whose own
//! venue (and the venues it borrows from) has none: CoinGecko's search names
//! the logo's file on its image host, `IMAGES`.
//!
//! Invariants - review against `.claude/commands/security-review.md`:
//! - Talks only to `BASE` (api.coingecko.com) and, for logos, `IMAGES`
//!   (coin-images.coingecko.com) - never a host from an argument. A logo
//!   CoinGecko lists anywhere else is ignored, redirects aren't followed,
//!   and only a PNG, JPEG or WebP within a size cap is accepted.
//!   The coin looked up is a ticker the app validates.
//! - The demo key is kept in the OS keychain (`KEY_ACCOUNT`), read once per
//!   session into `Zeroizing` memory (a data key, not a trading one: each
//!   keychain read can raise a macOS prompt), and sent only to CoinGecko. No
//!   command returns it.
//! - Links reach JS as labels and indexes, not URLs, and open only through
//!   `open_coin_link`, which takes a coin and an index into the links Rust
//!   itself fetched for it - and only if the URL passes `safe_url` (http or
//!   https, a conservative character set: `open_url` hands it to the OS
//!   shell on Windows). No command opens a URL it's given.
//! - The description arrives as HTML; it's reduced to plain text here, and
//!   the UI renders it as text.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use pewterdesk_core::{KeySource, VenueError};
use serde::{Deserialize, Serialize};
use tauri::State;
use zeroize::Zeroizing;

use crate::about::open_url;
use crate::keychain::{self, KeychainKeySource};

const BASE: &str = "https://api.coingecko.com/api/v3";
/// CoinGecko's image host, for coin logos only.
const IMAGES: &str = "https://coin-images.coingecko.com";
/// A logo larger than this isn't one; the size asked for is a few KB.
const MAX_LOGO_BYTES: usize = 96 * 1024;
/// Logo lookups are spaced this far apart: a list of markets asks for many
/// at once, and CoinGecko allows only a few requests a minute without a key.
const LOGO_SPACING: Duration = Duration::from_millis(2500);
/// CoinGecko refuses requests without a user agent.
const USER_AGENT: &str = concat!("pewterdesk/", env!("CARGO_PKG_VERSION"));
/// The keychain entry holding the demo API key.
const KEY_ACCOUNT: &str = "coingecko:demo";
/// How long a coin's details are reused before asking again.
const FRESH_FOR: Duration = Duration::from_secs(10 * 60);
const TIMEOUT: Duration = Duration::from_secs(15);
/// Categories shown as tags at most.
const MAX_TAGS: usize = 8;
/// Explorers listed at most.
const MAX_EXPLORERS: usize = 8;
/// Longest description kept, in characters.
const MAX_DESCRIPTION: usize = 4000;
/// Coins read per sector for the market heatmap: CoinGecko's largest by market cap.
const SECTOR_COINS: usize = 60;
/// How long a sector's coins are kept before they're fetched again.
const SECTOR_FRESH_FOR: Duration = Duration::from_secs(5 * 60);
/// Sector requests start at least this far apart: the heatmap asks for ten
/// in a row. CoinGecko's keyless limit is a few a minute (a sixth request
/// 4s apart was refused when this was written); a demo key allows 30.
const SECTOR_SPACING: Duration = Duration::from_millis(7500);
const SECTOR_SPACING_WITH_KEY: Duration = Duration::from_millis(2200);

/// The sectors the market heatmap groups coins by. A fixed set, each one of
/// CoinGecko's categories: the UI names a sector, never a category id.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum CoinSector {
    Layer1,
    SmartContracts,
    Ethereum,
    ProofOfWork,
    Defi,
    Memes,
    Solana,
    Ai,
    Layer2,
    RealWorldAssets,
}

impl CoinSector {
    /// CoinGecko's id for the category.
    fn category(self) -> &'static str {
        match self {
            Self::Layer1 => "layer-1",
            Self::SmartContracts => "smart-contract-platform",
            Self::Ethereum => "ethereum-ecosystem",
            Self::ProofOfWork => "proof-of-work-pow",
            Self::Defi => "decentralized-finance-defi",
            Self::Memes => "meme-token",
            Self::Solana => "solana-ecosystem",
            Self::Ai => "artificial-intelligence",
            Self::Layer2 => "layer-2",
            Self::RealWorldAssets => "real-world-assets-rwa",
        }
    }
}

/// One coin on the market heatmap, as the UI sees it. Figures are in USD;
/// changes are fractions (0.05 is +5%), absent where CoinGecko has none.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CoinMarket {
    /// The ticker, upper case.
    pub symbol: String,
    pub name: String,
    pub market_cap: f64,
    pub price: f64,
    /// Traded over the last 24 hours.
    pub volume: f64,
    #[serde(rename = "change1h")]
    pub change_1h: Option<f64>,
    #[serde(rename = "change24h")]
    pub change_24h: Option<f64>,
    #[serde(rename = "change7d")]
    pub change_7d: Option<f64>,
}

/// A row of `GET /coins/markets`.
#[derive(Deserialize)]
struct WireMarket {
    #[serde(default)]
    symbol: String,
    #[serde(default)]
    name: String,
    market_cap: Option<f64>,
    current_price: Option<f64>,
    total_volume: Option<f64>,
    price_change_percentage_1h_in_currency: Option<f64>,
    price_change_percentage_24h_in_currency: Option<f64>,
    price_change_percentage_7d_in_currency: Option<f64>,
}

/// A row as the heatmap takes it, or `None` for one it can't size or name:
/// no market cap, or a ticker that isn't a short run of letters and digits.
fn coin_market(wire: WireMarket) -> Option<CoinMarket> {
    let symbol = wire.symbol.trim().to_uppercase();
    let plain = !symbol.is_empty()
        && symbol.len() <= 12
        && symbol.bytes().all(|b| b.is_ascii_alphanumeric());
    let market_cap = positive(wire.market_cap)?;
    if !plain {
        return None;
    }
    let fraction = |pct: Option<f64>| pct.filter(|p| p.is_finite()).map(|p| p / 100.0);
    Some(CoinMarket {
        symbol,
        name: wire.name.trim().chars().take(40).collect(),
        market_cap,
        price: positive(wire.current_price).unwrap_or(0.0),
        volume: positive(wire.total_volume).unwrap_or(0.0),
        change_1h: fraction(wire.price_change_percentage_1h_in_currency),
        change_24h: fraction(wire.price_change_percentage_24h_in_currency),
        change_7d: fraction(wire.price_change_percentage_7d_in_currency),
    })
}

/// What a link is, for the UI to label and give an icon.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum LinkKind {
    Explorer,
    Github,
    X,
    Reddit,
    Telegram,
    Website,
    Whitepaper,
    Forum,
}

/// A link as the UI sees it: what it is and its host, opened by `index`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CoinLink {
    pub kind: LinkKind,
    /// The host, e.g. "mempool.space".
    pub label: String,
    pub index: usize,
}

/// A coin's overview. Amounts are in USD; each is absent where CoinGecko
/// has none.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CoinInfo {
    /// CoinGecko's id, which `open_coin_link` takes back.
    pub id: String,
    pub name: String,
    pub symbol: String,
    /// Plain text, paragraphs separated by blank lines.
    pub description: String,
    pub tags: Vec<String>,
    pub market_cap: Option<f64>,
    pub fdv: Option<f64>,
    pub circulating_supply: Option<f64>,
    pub total_supply: Option<f64>,
    pub max_supply: Option<f64>,
    pub links: Vec<CoinLink>,
}

/// A fetched coin: what the UI gets, and the URLs behind its links.
struct Coin {
    info: CoinInfo,
    urls: Vec<String>,
}

/// What CoinGecko's search found for a ticker.
#[derive(Clone)]
struct Found {
    id: String,
    /// Its logo's URL, as listed; checked before it's fetched.
    image: String,
}

/// A sector's coins and when they were read.
type SectorCoins = (Instant, Arc<Vec<CoinMarket>>);

/// The caches: ticker to what CoinGecko has for it (or none), and id to details.
pub struct CoinInfoState {
    http: reqwest::Client,
    /// For logos only. Never follows a redirect, so it can't be sent off
    /// the image host.
    images: reqwest::Client,
    ids: Mutex<HashMap<String, Option<Found>>>,
    /// Logos fetched this session, by ticker (`None`: CoinGecko has none).
    logos: Mutex<HashMap<String, Option<String>>>,
    /// When the next logo lookup may start; see `LOGO_SPACING`.
    next_logo: tokio::sync::Mutex<Instant>,
    coins: Mutex<HashMap<String, (Instant, Arc<Coin>)>>,
    /// Each sector's coins for the market heatmap, and when they were read.
    sectors: Mutex<HashMap<CoinSector, SectorCoins>>,
    /// When the next sector request may start; see `SECTOR_SPACING`.
    next_sector: tokio::sync::Mutex<Instant>,
    /// The demo key, read from the keychain once per session (`None` until
    /// then): every keychain read can raise a macOS permission prompt, and
    /// this is a data key, not a trading one, so it needn't be re-read.
    key: tokio::sync::Mutex<Option<Option<Arc<Zeroizing<String>>>>>,
}

impl CoinInfoState {
    pub fn new() -> Result<Self, VenueError> {
        let http = reqwest::Client::builder()
            .timeout(TIMEOUT)
            .user_agent(USER_AGENT)
            .gzip(true)
            .build()
            .map_err(|e| VenueError::Network(e.to_string()))?;
        let images = reqwest::Client::builder()
            .timeout(TIMEOUT)
            .user_agent(USER_AGENT)
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .map_err(|e| VenueError::Network(e.to_string()))?;
        Ok(Self {
            http,
            images,
            logos: Mutex::default(),
            next_logo: tokio::sync::Mutex::new(Instant::now()),
            ids: Mutex::default(),
            coins: Mutex::default(),
            sectors: Mutex::default(),
            next_sector: tokio::sync::Mutex::new(Instant::now()),
            key: tokio::sync::Mutex::new(None),
        })
    }

    /// A GET on CoinGecko, with the demo key if there is one.
    async fn get<T: serde::de::DeserializeOwned>(
        &self,
        path: &str,
        query: &[(&str, &str)],
        key: Option<&str>,
    ) -> Result<T, VenueError> {
        let mut request = self.http.get(format!("{BASE}{path}")).query(query);
        if let Some(key) = key {
            request = request.header("x-cg-demo-api-key", key);
        }
        let response = request
            .send()
            .await
            .map_err(|e| VenueError::Network(e.without_url().to_string()))?;
        match response.status().as_u16() {
            200 => response
                .json()
                .await
                .map_err(|e| VenueError::Network(format!("unexpected CoinGecko response: {e}"))),
            429 => Err(VenueError::Network(
                "CoinGecko's rate limit was reached; try again in a minute, or add a demo key in Settings".into(),
            )),
            401 | 403 if key.is_some() => Err(VenueError::InvalidRequest(
                "CoinGecko refused the demo API key; check it in Settings".into(),
            )),
            status => Err(VenueError::Network(format!("CoinGecko returned {status}"))),
        }
    }

    /// A sector's largest coins by market cap, from memory while fresh.
    /// Requests are spaced out, so asking for several sectors at once
    /// queues them rather than tripping CoinGecko's rate limit.
    async fn sector(
        &self,
        sector: CoinSector,
        key: Option<&str>,
    ) -> Result<Arc<Vec<CoinMarket>>, VenueError> {
        let cached = |this: &Self| {
            this.sectors
                .lock()
                .unwrap()
                .get(&sector)
                .filter(|(at, _)| at.elapsed() < SECTOR_FRESH_FOR)
                .map(|(_, coins)| Arc::clone(coins))
        };
        if let Some(coins) = cached(self) {
            return Ok(coins);
        }
        // One at a time: whoever waited here may find it fetched meanwhile.
        let mut next = self.next_sector.lock().await;
        if let Some(coins) = cached(self) {
            return Ok(coins);
        }
        tokio::time::sleep_until((*next).into()).await;
        *next = Instant::now()
            + if key.is_some() {
                SECTOR_SPACING_WITH_KEY
            } else {
                SECTOR_SPACING
            };
        let rows: Vec<WireMarket> = self
            .get(
                "/coins/markets",
                &[
                    ("vs_currency", "usd"),
                    ("category", sector.category()),
                    ("order", "market_cap_desc"),
                    ("per_page", &SECTOR_COINS.to_string()),
                    ("page", "1"),
                    ("price_change_percentage", "1h,24h,7d"),
                ],
                key,
            )
            .await?;
        let coins = Arc::new(rows.into_iter().filter_map(coin_market).collect::<Vec<_>>());
        self.sectors
            .lock()
            .unwrap()
            .insert(sector, (Instant::now(), Arc::clone(&coins)));
        Ok(coins)
    }

    /// What CoinGecko has for `ticker`: the best-ranked coin with exactly
    /// that symbol, or none.
    async fn find(&self, ticker: &str, key: Option<&str>) -> Result<Option<Found>, VenueError> {
        if let Some(known) = self.ids.lock().unwrap().get(ticker) {
            return Ok(known.clone());
        }
        let reply: SearchReply = self.get("/search", &[("query", ticker)], key).await?;
        let found = best_match(ticker, &reply.coins);
        self.ids
            .lock()
            .unwrap()
            .insert(ticker.to_owned(), found.clone());
        Ok(found)
    }

    /// The CoinGecko id for `ticker`, or none.
    async fn id_for(&self, ticker: &str, key: Option<&str>) -> Result<Option<String>, VenueError> {
        Ok(self.find(ticker, key).await?.map(|f| f.id))
    }

    /// `ticker`'s logo as SVG, or `None` when CoinGecko lists no coin by
    /// that symbol or no usable logo for it. Lookups wait their turn.
    async fn logo(&self, ticker: &str, key: Option<&str>) -> Result<Option<String>, VenueError> {
        if let Some(known) = self.logos.lock().unwrap().get(ticker) {
            return Ok(known.clone());
        }
        {
            let mut next = self.next_logo.lock().await;
            // Looked up while this one waited: no need to ask again.
            if let Some(known) = self.logos.lock().unwrap().get(ticker) {
                return Ok(known.clone());
            }
            tokio::time::sleep_until((*next).into()).await;
            *next = Instant::now() + LOGO_SPACING;
        }
        let url = self
            .find(ticker, key)
            .await?
            .and_then(|f| logo_url(&f.image));
        let logo = match url {
            Some(url) => self.fetch_logo(&url).await?,
            None => None,
        };
        self.logos
            .lock()
            .unwrap()
            .insert(ticker.to_owned(), logo.clone());
        Ok(logo)
    }

    /// The image at `url` (already checked to be on the image host), as SVG.
    async fn fetch_logo(&self, url: &str) -> Result<Option<String>, VenueError> {
        let response = self
            .images
            .get(url)
            .send()
            .await
            .map_err(|e| VenueError::Network(e.without_url().to_string()))?;
        let status = response.status();
        if status.is_server_error() || status.as_u16() == 429 {
            return Err(VenueError::Network(format!(
                "CoinGecko's image host returned {status}"
            )));
        }
        if !status.is_success()
            || response
                .content_length()
                .is_some_and(|n| n > MAX_LOGO_BYTES as u64)
        {
            return Ok(None);
        }
        let body = response
            .bytes()
            .await
            .map_err(|e| VenueError::Network(e.without_url().to_string()))?;
        Ok(logo_svg(&body))
    }

    async fn coin(&self, id: &str, key: Option<&str>) -> Result<Arc<Coin>, VenueError> {
        // The id goes into the path: CoinGecko's own, but checked all the same.
        let ok = !id.is_empty()
            && id.len() <= 100
            && id
                .bytes()
                .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-');
        if !ok {
            return Err(VenueError::InvalidRequest(
                "unexpected CoinGecko coin id".into(),
            ));
        }
        if let Some((at, coin)) = self.coins.lock().unwrap().get(id) {
            if at.elapsed() < FRESH_FOR {
                return Ok(Arc::clone(coin));
            }
        }
        let path = format!("/coins/{id}");
        let wire: WireCoin = self
            .get(
                &path,
                &[
                    ("localization", "false"),
                    ("tickers", "false"),
                    ("market_data", "true"),
                    ("community_data", "false"),
                    ("developer_data", "false"),
                    ("sparkline", "false"),
                ],
                key,
            )
            .await?;
        let coin = Arc::new(build(wire));
        self.coins
            .lock()
            .unwrap()
            .insert(id.to_owned(), (Instant::now(), Arc::clone(&coin)));
        Ok(coin)
    }
}

/// The ticker CoinGecko knows a market's base by: without the size
/// multipliers venues put in front (1000PEPE, kPEPE), upper case.
fn ticker(base: &str) -> Option<String> {
    let base = base.trim();
    let mut t = base;
    for prefix in ["1000000", "100000", "10000", "1000", "k"] {
        if let Some(rest) = t.strip_prefix(prefix) {
            if rest.len() >= 2
                && rest
                    .bytes()
                    .all(|b| b.is_ascii_uppercase() || b.is_ascii_digit())
            {
                t = rest;
                break;
            }
        }
    }
    let t = t.to_ascii_uppercase();
    let ok = !t.is_empty() && t.len() <= 20 && t.bytes().all(|b| b.is_ascii_alphanumeric());
    ok.then_some(t)
}

#[derive(Deserialize)]
struct SearchReply {
    #[serde(default)]
    coins: Vec<SearchCoin>,
}

#[derive(Deserialize)]
struct SearchCoin {
    id: String,
    symbol: String,
    #[serde(default)]
    market_cap_rank: Option<u32>,
    /// The logo at its largest size.
    #[serde(default)]
    large: String,
}

fn best_match(ticker: &str, coins: &[SearchCoin]) -> Option<Found> {
    coins
        .iter()
        .filter(|c| c.symbol.eq_ignore_ascii_case(ticker))
        .min_by_key(|c| c.market_cap_rank.unwrap_or(u32::MAX))
        .map(|c| Found {
            id: c.id.clone(),
            image: c.large.clone(),
        })
}

/// The logo to fetch for a listed one: the same file at CoinGecko's small
/// size (a few KB), and only if it's a plain path on the image host.
/// Anything else - another host, a query, a path that climbs - is `None`.
fn logo_url(listed: &str) -> Option<String> {
    let path = listed
        .strip_prefix(IMAGES)?
        .strip_prefix("/coins/images/")?;
    let path = path.split('?').next().unwrap_or(path);
    let plain = !path.is_empty()
        && path.len() <= 200
        && !path.contains("..")
        && path
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'/' | b'.' | b'_' | b'-'));
    plain.then(|| {
        format!(
            "{IMAGES}/coins/images/{}",
            path.replacen("/large/", "/small/", 1)
        )
    })
}

/// `bytes` as an SVG that embeds them, or `None` if they aren't a PNG, JPEG
/// or WebP image within the size cap. The UI shows it only through an
/// `<img>`, where nothing in it can run or load anything.
fn logo_svg(bytes: &[u8]) -> Option<String> {
    if bytes.len() > MAX_LOGO_BYTES {
        return None;
    }
    let mime = if bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
        "image/png"
    } else if bytes.starts_with(&[0xFF, 0xD8, 0xFF]) {
        "image/jpeg"
    } else if bytes.len() > 12 && &bytes[..4] == b"RIFF" && &bytes[8..12] == b"WEBP" {
        "image/webp"
    } else {
        return None;
    };
    Some(format!(
        r#"<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><image width="64" height="64" href="data:{mime};base64,{}"/></svg>"#,
        base64(bytes)
    ))
}

/// Standard base64 with padding (RFC 4648).
fn base64(bytes: &[u8]) -> String {
    const ALPHABET: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let n = (u32::from(chunk[0]) << 16)
            | (u32::from(*chunk.get(1).unwrap_or(&0)) << 8)
            | u32::from(*chunk.get(2).unwrap_or(&0));
        let sextets = [n >> 18, n >> 12, n >> 6, n];
        for (i, s) in sextets.iter().enumerate() {
            if i <= chunk.len() {
                out.push(ALPHABET[(s & 63) as usize] as char);
            } else {
                out.push('=');
            }
        }
    }
    out
}

#[derive(Deserialize, Default)]
struct WireCoin {
    #[serde(default)]
    id: String,
    #[serde(default)]
    name: String,
    #[serde(default)]
    symbol: String,
    #[serde(default)]
    description: Description,
    #[serde(default)]
    categories: Vec<Option<String>>,
    #[serde(default)]
    links: WireLinks,
    #[serde(default)]
    market_data: Option<MarketData>,
}

#[derive(Deserialize, Default)]
struct Description {
    #[serde(default)]
    en: String,
}

#[derive(Deserialize, Default)]
struct WireLinks {
    #[serde(default)]
    homepage: Vec<String>,
    #[serde(default)]
    whitepaper: Option<String>,
    #[serde(default)]
    blockchain_site: Vec<String>,
    #[serde(default)]
    official_forum_url: Vec<String>,
    #[serde(default)]
    twitter_screen_name: Option<String>,
    #[serde(default)]
    telegram_channel_identifier: Option<String>,
    #[serde(default)]
    subreddit_url: Option<String>,
    #[serde(default)]
    repos_url: Repos,
}

#[derive(Deserialize, Default)]
struct Repos {
    #[serde(default)]
    github: Vec<String>,
}

#[derive(Deserialize, Default)]
struct MarketData {
    #[serde(default)]
    market_cap: HashMap<String, Option<f64>>,
    #[serde(default)]
    fully_diluted_valuation: HashMap<String, Option<f64>>,
    #[serde(default)]
    circulating_supply: Option<f64>,
    #[serde(default)]
    total_supply: Option<f64>,
    #[serde(default)]
    max_supply: Option<f64>,
}

/// A URL that's safe to hand to the system browser: http or https, a host,
/// and only characters no shell gives a meaning to (`open_url` goes through
/// `cmd` on Windows). Anything else isn't offered at all.
fn safe_url(url: &str) -> Option<String> {
    let url = url.trim();
    let rest = url
        .strip_prefix("https://")
        .or_else(|| url.strip_prefix("http://"))?;
    let host = rest.split(['/', '?', '#']).next().unwrap_or("");
    let host_ok = !host.is_empty()
        && host.contains('.')
        && host
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'.' || b == b'-');
    let chars_ok = url.len() <= 512
        && url.bytes().all(|b| {
            b.is_ascii_alphanumeric()
                || matches!(
                    b,
                    b'-' | b'.'
                        | b'_'
                        | b'~'
                        | b':'
                        | b'/'
                        | b'?'
                        | b'#'
                        | b'@'
                        | b'+'
                        | b','
                        | b';'
                        | b'='
                )
        });
    (host_ok && chars_ok).then(|| url.to_owned())
}

/// The host a URL is shown by: "mempool.space", without "www.".
fn host_of(url: &str) -> String {
    let rest = url.split_once("://").map_or(url, |(_, r)| r);
    let host = rest.split(['/', '?', '#']).next().unwrap_or(rest);
    host.strip_prefix("www.").unwrap_or(host).to_owned()
}

/// A handle (X name, Telegram channel): letters, digits and `_`.
fn handle(name: &Option<String>) -> Option<&str> {
    let name = name.as_deref()?.trim();
    (!name.is_empty()
        && name.len() <= 64
        && name.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_'))
    .then_some(name)
}

/// CoinGecko's HTML description as plain text: tags dropped, the common
/// entities decoded, paragraphs kept.
fn plain_text(html: &str) -> String {
    let mut out = String::with_capacity(html.len());
    let mut in_tag = false;
    for c in html.chars() {
        match c {
            '<' => in_tag = true,
            '>' if in_tag => in_tag = false,
            _ if !in_tag => out.push(c),
            _ => {}
        }
    }
    let out = out
        .replace("&amp;", "&")
        .replace("&quot;", "\"")
        .replace("&#39;", "'")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&nbsp;", " ")
        .replace("\r\n", "\n");
    let paragraphs: Vec<&str> = out
        .split("\n\n")
        .map(str::trim)
        .filter(|p| !p.is_empty())
        .collect();
    let text = paragraphs.join("\n\n");
    if text.chars().count() > MAX_DESCRIPTION {
        let cut: String = text.chars().take(MAX_DESCRIPTION).collect();
        format!("{}…", cut.trim_end())
    } else {
        text
    }
}

fn positive(v: Option<f64>) -> Option<f64> {
    v.filter(|v| v.is_finite() && *v > 0.0)
}

fn build(wire: WireCoin) -> Coin {
    let mut urls = Vec::new();
    let mut links = Vec::new();
    let mut add = |kind: LinkKind, url: Option<String>| {
        if let Some(url) = url.as_deref().and_then(safe_url) {
            if urls.contains(&url) {
                return;
            }
            links.push(CoinLink {
                kind,
                label: host_of(&url),
                index: urls.len(),
            });
            urls.push(url);
        }
    };
    let l = &wire.links;
    for site in l
        .blockchain_site
        .iter()
        .filter(|s| !s.is_empty())
        .take(MAX_EXPLORERS)
    {
        add(LinkKind::Explorer, Some(site.clone()));
    }
    add(LinkKind::Github, l.repos_url.github.first().cloned());
    add(
        LinkKind::X,
        handle(&l.twitter_screen_name).map(|n| format!("https://x.com/{n}")),
    );
    add(LinkKind::Reddit, l.subreddit_url.clone());
    add(
        LinkKind::Telegram,
        handle(&l.telegram_channel_identifier).map(|n| format!("https://t.me/{n}")),
    );
    add(
        LinkKind::Website,
        l.homepage.iter().find(|h| !h.is_empty()).cloned(),
    );
    add(LinkKind::Whitepaper, l.whitepaper.clone());
    add(
        LinkKind::Forum,
        l.official_forum_url.iter().find(|f| !f.is_empty()).cloned(),
    );

    let md = wire.market_data.unwrap_or_default();
    let usd = |m: &HashMap<String, Option<f64>>| positive(m.get("usd").copied().flatten());
    Coin {
        info: CoinInfo {
            id: wire.id,
            name: wire.name,
            symbol: wire.symbol.to_ascii_uppercase(),
            description: plain_text(&wire.description.en),
            tags: wire
                .categories
                .into_iter()
                .flatten()
                .filter(|c| !c.is_empty())
                .take(MAX_TAGS)
                .collect(),
            market_cap: usd(&md.market_cap),
            fdv: usd(&md.fully_diluted_valuation),
            circulating_supply: positive(md.circulating_supply),
            total_supply: positive(md.total_supply),
            max_supply: positive(md.max_supply),
            links,
        },
        urls,
    }
}

impl CoinInfoState {
    /// The demo key, if one is stored: from the keychain the first time,
    /// then from memory. A keychain that can't be read (or a denied prompt)
    /// counts as none for the session - the overview still works keyless,
    /// and the user isn't asked again on every refresh.
    async fn stored_key(&self) -> Option<Arc<Zeroizing<String>>> {
        let mut cached = self.key.lock().await;
        if let Some(key) = cached.as_ref() {
            return key.clone();
        }
        let key = KeychainKeySource.key(KEY_ACCOUNT).await.ok().map(Arc::new);
        *cached = Some(key.clone());
        key
    }
}

/// The overview for a market's base coin (e.g. "BTC", "1000PEPE"), or
/// `None` when CoinGecko doesn't list it.
#[tauri::command]
pub async fn coin_info(
    state: State<'_, CoinInfoState>,
    base: String,
) -> Result<Option<CoinInfo>, VenueError> {
    let Some(ticker) = ticker(&base) else {
        return Ok(None);
    };
    let key = state.stored_key().await;
    let key = key.as_deref().map(|k| k.as_str());
    let Some(id) = state.id_for(&ticker, key).await? else {
        return Ok(None);
    };
    Ok(Some(state.coin(&id, key).await?.info.clone()))
}

/// A sector's largest coins by market cap, for the Maps page's market
/// heatmap: market cap, price, 24h volume and the 1h, 24h and 7d changes.
/// The UI names one of a fixed set of sectors; Rust maps it to CoinGecko's
/// category and builds the request.
#[tauri::command]
pub async fn coin_markets(
    state: State<'_, CoinInfoState>,
    sector: CoinSector,
) -> Result<Vec<CoinMarket>, VenueError> {
    let key = state.stored_key().await;
    let coins = state
        .sector(sector, key.as_deref().map(|k| k.as_str()))
        .await?;
    Ok(coins.as_ref().clone())
}

/// A coin's logo from CoinGecko, as SVG markup, for a market's base coin
/// (e.g. "MOG", or "1000000MOG": the multiplier is dropped). `None` when
/// CoinGecko has none. The last place a logo is looked for: the UI asks
/// only when the market's own venue, and the venues it borrows from, have
/// none - and never for a stock, ETF, commodity or forex market, whose
/// ticker would match some unrelated coin.
#[tauri::command]
pub async fn coin_logo(
    state: State<'_, CoinInfoState>,
    base: String,
) -> Result<Option<String>, VenueError> {
    let Some(ticker) = ticker(&base) else {
        return Ok(None);
    };
    let key = state.stored_key().await;
    state
        .logo(&ticker, key.as_deref().map(|k| k.as_str()))
        .await
}

/// Opens one of the links Rust fetched for coin `id`, by its index - never
/// a URL from the UI.
#[tauri::command]
pub fn open_coin_link(
    state: State<'_, CoinInfoState>,
    id: String,
    index: usize,
) -> Result<(), VenueError> {
    let url = state
        .coins
        .lock()
        .unwrap()
        .get(&id)
        .and_then(|(_, coin)| coin.urls.get(index).cloned())
        .ok_or_else(|| VenueError::InvalidRequest("that link isn't available".into()))?;
    open_url(&url).map_err(|_| VenueError::Network("couldn't open the browser".into()))
}

/// Checks a CoinGecko demo API key with CoinGecko, then keeps it in the
/// keychain. It crosses IPC once, here.
#[tauri::command]
pub async fn set_coingecko_key(
    state: State<'_, CoinInfoState>,
    key: String,
) -> Result<(), VenueError> {
    let key = Zeroizing::new(key.trim().to_owned());
    let ok = !key.is_empty()
        && key.len() <= 128
        && key.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-');
    if !ok {
        return Err(VenueError::InvalidRequest(
            "that doesn't look like a CoinGecko API key".into(),
        ));
    }
    let _: serde_json::Value = state.get("/ping", &[], Some(&key)).await?;
    keychain::store_key(KEY_ACCOUNT.to_owned(), key.clone())
        .await
        .map_err(|e| VenueError::Key(e.into()))?;
    *state.key.lock().await = Some(Some(Arc::new(key)));
    Ok(())
}

/// Whether a demo key is stored. Never returns it.
#[tauri::command]
pub async fn has_coingecko_key(state: State<'_, CoinInfoState>) -> Result<bool, VenueError> {
    Ok(state.stored_key().await.is_some())
}

#[tauri::command]
pub async fn clear_coingecko_key(state: State<'_, CoinInfoState>) -> Result<(), VenueError> {
    keychain::delete_key(KEY_ACCOUNT.to_owned())
        .await
        .map_err(|e| VenueError::Key(e.into()))?;
    *state.key.lock().await = Some(None);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn heatmap_coins_come_from_named_sectors_only() {
        let parse = |s: &str| serde_json::from_str::<CoinSector>(s);
        assert_eq!(parse("\"layer1\"").unwrap(), CoinSector::Layer1);
        assert_eq!(
            parse("\"realWorldAssets\"").unwrap().category(),
            "real-world-assets-rwa"
        );
        assert!(parse("\"layer-1&x_cg_demo_api_key=1\"").is_err());
        let rows: Vec<WireMarket> = serde_json::from_value(serde_json::json!([
            { "symbol": "btc", "name": "Bitcoin", "current_price": 83045.0,
              "market_cap": 1668716873526.0, "total_volume": 37969004192.0,
              "price_change_percentage_1h_in_currency": -0.34,
              "price_change_percentage_24h_in_currency": -4.08,
              "price_change_percentage_7d_in_currency": null },
            { "symbol": "<img src=x>", "name": "Bad", "market_cap": 5.0 },
            { "symbol": "dead", "name": "No cap", "market_cap": 0.0 },
            { "symbol": "nul", "name": "Null cap", "market_cap": null }
        ]))
        .unwrap();
        let coins: Vec<CoinMarket> = rows.into_iter().filter_map(coin_market).collect();
        assert_eq!(coins.len(), 1);
        assert_eq!(
            (coins[0].symbol.as_str(), coins[0].name.as_str()),
            ("BTC", "Bitcoin")
        );
        assert!((coins[0].change_24h.unwrap() + 0.0408).abs() < 1e-9);
        assert_eq!(coins[0].change_7d, None);
    }

    #[test]
    fn tickers_lose_size_multipliers() {
        assert_eq!(ticker("BTC").as_deref(), Some("BTC"));
        assert_eq!(ticker("1000PEPE").as_deref(), Some("PEPE"));
        assert_eq!(ticker("kPEPE").as_deref(), Some("PEPE"));
        assert_eq!(ticker("1000000MOG").as_deref(), Some("MOG"));
        // A coin that's just digits, or starts with k, keeps its name.
        assert_eq!(ticker("1INCH").as_deref(), Some("1INCH"));
        assert_eq!(ticker("KAS").as_deref(), Some("KAS"));
        assert_eq!(ticker("xyz:TSLA"), None);
        assert_eq!(ticker(""), None);
    }

    #[test]
    fn fetches_logos_only_from_the_image_host() {
        // The listed (large) logo, asked for at the small size.
        assert_eq!(
            logo_url("https://coin-images.coingecko.com/coins/images/31059/large/MOG_LOGO_200x200.png?1696529893").as_deref(),
            Some("https://coin-images.coingecko.com/coins/images/31059/small/MOG_LOGO_200x200.png")
        );
        for bad in [
            "",
            "https://evil.example/coins/images/1/large/a.png",
            "https://coin-images.coingecko.com.evil.example/coins/images/1/large/a.png",
            "http://coin-images.coingecko.com/coins/images/1/large/a.png",
            "https://coin-images.coingecko.com/other/1/large/a.png",
            "https://coin-images.coingecko.com/coins/images/../../x.png",
            "https://coin-images.coingecko.com/coins/images/1/large/a b.png",
            "https://coin-images.coingecko.com/coins/images/1/large/a.png#frag",
        ] {
            assert_eq!(logo_url(bad), None, "{bad}");
        }
    }

    #[test]
    fn wraps_only_raster_images_as_svg() {
        let svg = logo_svg(b"\x89PNG\r\n\x1a\nrest").unwrap();
        assert!(svg.starts_with("<svg") && svg.contains("data:image/png;base64,iVBORw0KGgpyZXN0"));
        assert!(logo_svg(&[0xFF, 0xD8, 0xFF, 0xE0])
            .unwrap()
            .contains("image/jpeg"));
        // Markup, an error page, and something too big to be a logo.
        assert_eq!(logo_svg(b"<svg onload=\"x()\"></svg>"), None);
        assert_eq!(logo_svg(b"<html>denied</html>"), None);
        let mut huge = b"\x89PNG\r\n\x1a\n".to_vec();
        huge.resize(MAX_LOGO_BYTES + 1, 0);
        assert_eq!(logo_svg(&huge), None);
    }

    #[test]
    fn picks_the_best_ranked_exact_symbol() {
        let coins = vec![
            SearchCoin {
                id: "ape-and-pepe".into(),
                symbol: "APEPE".into(),
                market_cap_rank: Some(9),
                large: String::new(),
            },
            SearchCoin {
                id: "pepe-copy".into(),
                symbol: "PEPE".into(),
                market_cap_rank: None,
                large: String::new(),
            },
            SearchCoin {
                id: "pepe".into(),
                symbol: "pepe".into(),
                market_cap_rank: Some(56),
                large: String::new(),
            },
        ];
        assert_eq!(
            best_match("PEPE", &coins).map(|f| f.id).as_deref(),
            Some("pepe")
        );
        assert!(best_match("NONE", &coins).is_none());
    }

    #[test]
    fn only_plain_web_urls_are_offered() {
        assert!(safe_url("https://mempool.space/").is_some());
        assert!(safe_url("http://www.bitcoin.org").is_some());
        assert!(safe_url("https://www.oklink.com/btc").is_some());
        for bad in [
            "javascript:alert(1)",
            "file:///etc/passwd",
            "https://x.com/a&calc.exe",
            "https://a.com/\"x",
            "https://a.com/%20",
            "https://a.com/ b",
            "https://a.com/^x",
            "https://a.com/|x",
            "https://no-dot/",
            "https:///path",
            "ftp://a.com",
        ] {
            assert!(safe_url(bad).is_none(), "{bad}");
        }
    }

    #[test]
    fn descriptions_become_plain_text() {
        let html = "Bitcoin is <a href=\"https://x\">great</a> &amp; old.\r\n\r\n\r\nSecond &quot;para&quot;.";
        assert_eq!(
            plain_text(html),
            "Bitcoin is great & old.\n\nSecond \"para\"."
        );
        let long = "x".repeat(MAX_DESCRIPTION + 10);
        assert!(plain_text(&long).ends_with('…'));
    }

    #[test]
    fn builds_the_overview_from_coingeckos_reply() {
        let wire: WireCoin = serde_json::from_value(json!({
            "id": "bitcoin", "name": "Bitcoin", "symbol": "btc",
            "description": { "en": "Bitcoin is the first." },
            "categories": ["Layer 1 (L1)", null, "Proof of Work (PoW)"],
            "links": {
                "homepage": ["http://www.bitcoin.org", ""],
                "whitepaper": "https://bitcoin.org/bitcoin.pdf",
                "blockchain_site": ["https://mempool.space/", "", "https://btc.com/", "https://evil.com/a&b"],
                "official_forum_url": ["https://bitcointalk.org/"],
                "twitter_screen_name": "bitcoin",
                "telegram_channel_identifier": "",
                "subreddit_url": "https://www.reddit.com/r/Bitcoin/",
                "repos_url": { "github": ["https://github.com/bitcoin/bitcoin"] }
            },
            "market_data": {
                "market_cap": { "usd": 1726102219495.0 },
                "fully_diluted_valuation": { "usd": null },
                "circulating_supply": 20092278.0,
                "total_supply": 20092300.0,
                "max_supply": null
            }
        }))
        .unwrap();
        let coin = build(wire);
        let i = &coin.info;
        assert_eq!((i.id.as_str(), i.symbol.as_str()), ("bitcoin", "BTC"));
        assert_eq!(i.tags, ["Layer 1 (L1)", "Proof of Work (PoW)"]);
        assert_eq!(i.market_cap, Some(1726102219495.0));
        assert_eq!((i.fdv, i.max_supply), (None, None));
        let kinds: Vec<(LinkKind, &str)> =
            i.links.iter().map(|l| (l.kind, l.label.as_str())).collect();
        assert_eq!(
            kinds,
            [
                (LinkKind::Explorer, "mempool.space"),
                (LinkKind::Explorer, "btc.com"),
                (LinkKind::Github, "github.com"),
                (LinkKind::X, "x.com"),
                (LinkKind::Reddit, "reddit.com"),
                (LinkKind::Website, "bitcoin.org"),
                (LinkKind::Whitepaper, "bitcoin.org"),
                (LinkKind::Forum, "bitcointalk.org"),
            ]
        );
        // Each link's index finds its URL; the unsafe one never made it in.
        for link in &i.links {
            assert!(coin.urls[link.index].contains(&link.label));
        }
        assert!(!coin.urls.iter().any(|u| u.contains("evil")));
        assert_eq!(coin.urls[3], "https://x.com/bitcoin");
    }

    /// Against CoinGecko's keyless API: needs the network. Run with
    /// `cargo test -p pewterdesk coin_info -- --ignored`.
    #[test]
    #[ignore = "hits CoinGecko"]
    fn reads_bitcoin_and_pepe_from_coingecko() {
        let state = CoinInfoState::new().unwrap();
        tauri::async_runtime::block_on(async {
            let id = state.id_for("BTC", None).await.unwrap();
            assert_eq!(id.as_deref(), Some("bitcoin"));
            let coin = state.coin("bitcoin", None).await.unwrap();
            let i = &coin.info;
            assert_eq!(i.symbol, "BTC");
            assert!(i.market_cap.unwrap() > 1e11);
            assert_eq!(i.max_supply, Some(21_000_000.0));
            assert!(!i.description.contains('<'));
            assert!(i.links.iter().any(|l| l.kind == LinkKind::Explorer));
            assert_eq!(
                state
                    .id_for(&ticker("1000PEPE").unwrap(), None)
                    .await
                    .unwrap()
                    .as_deref(),
                Some("pepe")
            );
        });
    }

    /// Against CoinGecko's keyless API and image host: needs the network.
    #[test]
    #[ignore = "hits CoinGecko"]
    fn fetches_logos_for_multiplied_tokens() {
        let state = CoinInfoState::new().unwrap();
        tauri::async_runtime::block_on(async {
            // 1000000MOG and 1000000BABYDOGE use the plain coin's logo.
            for base in ["1000000MOG", "1000000BABYDOGE"] {
                let logo = state.logo(&ticker(base).unwrap(), None).await.unwrap();
                let svg = logo.unwrap_or_else(|| panic!("no logo for {base}"));
                assert!(svg.starts_with("<svg") && svg.contains("base64,"), "{base}");
            }
            assert_eq!(state.logo("NOTACOINXYZQ", None).await.unwrap(), None);
        });
    }
}
