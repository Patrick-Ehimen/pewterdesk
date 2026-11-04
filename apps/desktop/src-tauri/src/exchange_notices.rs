//! Exchanges' listing notices, for the Maps page's pump / dump watch: new
//! listings and delistings from Binance and OKX, and Upbit's trading notices
//! (listings, delistings, investment warnings). A listing is the most common
//! trigger of a pump, a delisting or warning of a dump, and each exchange
//! posts them before trading changes. Data sources, not venues: no key,
//! nothing signed, one read-only GET to each of a fixed list of URLs
//! (`SOURCES`; no redirects followed, a size cap), kept 45 seconds.
//!
//! Notices reach the UI as bounded plain text, a time, a kind and the
//! tickers named in the title, never a link.

use std::time::{Duration, Instant};

use pewterdesk_core::VenueError;
use serde::Serialize;
use serde_json::Value;
use tauri::State;

const TIMEOUT: Duration = Duration::from_secs(10);
const FRESH_FOR: Duration = Duration::from_secs(45);
/// A page of notices runs to some 20 KB; Binance's carries more around it.
const MAX_BYTES: usize = 512 * 1024;
const MAX_TITLE: usize = 200;
const MAX_TICKERS: usize = 12;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Exchange {
    Binance,
    Okx,
    Upbit,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum NoticeKind {
    Listing,
    Delisting,
    Warning,
    Other,
}

/// Where each feed is, what it lists, and how it's read.
struct Source {
    exchange: Exchange,
    url: &'static str,
    /// What every notice on it is, where the feed itself says.
    kind: Option<NoticeKind>,
}

const SOURCES: &[Source] = &[
    Source {
        exchange: Exchange::Binance,
        url: "https://www.binance.com/bapi/composite/v1/public/cms/article/list/query?type=1&catalogId=48&pageNo=1&pageSize=20",
        kind: Some(NoticeKind::Listing),
    },
    Source {
        exchange: Exchange::Binance,
        url: "https://www.binance.com/bapi/composite/v1/public/cms/article/list/query?type=1&catalogId=161&pageNo=1&pageSize=20",
        kind: Some(NoticeKind::Delisting),
    },
    Source {
        exchange: Exchange::Okx,
        url: "https://www.okx.com/api/v5/support/announcements?annType=announcements-new-listings",
        kind: Some(NoticeKind::Listing),
    },
    Source {
        exchange: Exchange::Okx,
        url: "https://www.okx.com/api/v5/support/announcements?annType=announcements-delistings",
        kind: Some(NoticeKind::Delisting),
    },
    Source {
        exchange: Exchange::Upbit,
        url: "https://api-manager.upbit.com/api/v1/announcements?os=web&page=1&per_page=20&category=trade",
        kind: None,
    },
];

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExchangeNotice {
    pub id: String,
    pub exchange: Exchange,
    pub kind: NoticeKind,
    pub title: String,
    /// When it was posted, in milliseconds since the Unix epoch.
    pub time: i64,
    /// The tickers its title names, upper case (or, where it names none, its body).
    pub tickers: Vec<String>,
    /// Binance's article code, to read the body by: kept in Rust.
    #[serde(skip)]
    pub code: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Notices {
    /// Newest first.
    pub items: Vec<ExchangeNotice>,
    /// The exchanges whose feed couldn't be read this time.
    pub failed: Vec<Exchange>,
}

/// Plain text, one line, bounded: what a title may carry to the page.
fn plain(text: &str) -> String {
    let one_line: String = text
        .chars()
        .map(|c| if c.is_control() { ' ' } else { c })
        .collect::<String>()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ");
    one_line.chars().take(MAX_TITLE).collect()
}

/// A ticker as a title writes one: 2 to 12 capitals and digits, a letter among them.
fn ticker_like(word: &str) -> bool {
    (2..=12).contains(&word.len())
        && word
            .chars()
            .all(|c| c.is_ascii_uppercase() || c.is_ascii_digit())
        && word.chars().any(|c| c.is_ascii_uppercase())
}

/// Words in capitals that aren't tickers, in the titles these feeds write.
const NOT_TICKERS: &[&str] = &[
    "OKX", "USDT", "USDC", "USD", "KRW", "BTC", "TRADFI", "API", "AI", "TGE", "UTC", "KST", "FAQ",
    "NFT", "ETF", "VIP", "HODLER", "USDⓈ",
];

/// A ticker as it goes in the list: a perpetual's name ("PTBUSDT") is its coin.
fn push_ticker(out: &mut Vec<String>, word: &str) {
    let word = word.trim();
    let coin = ["USDT", "USDC"]
        .iter()
        .find_map(|q| word.strip_suffix(q).filter(|c| c.len() >= 2))
        .unwrap_or(word);
    if ticker_like(coin) && !NOT_TICKERS.contains(&coin) && !out.iter().any(|o| o == coin) {
        out.push(coin.to_owned());
    }
}

/// The words a title lists coins after, in any case.
const LIST_WORDS: &[&str] = &[" for ", " delist ", " list ", " remove "];

/// The tickers a title names: in brackets ("Nillion(NIL)"), else, for a list
/// of them ("perpetual futures for ADI, FLEX and PEP", "Will Delist EPIC,
/// QUICK", "Will Remove PTB, AA"), the capitals after "for", "list", "delist"
/// or "remove".
fn tickers(title: &str) -> Vec<String> {
    let push = push_ticker;
    let mut out: Vec<String> = Vec::new();
    let mut rest = title;
    while let Some(open) = rest.find('(') {
        let after = &rest[open + 1..];
        let Some(close) = after.find(')') else { break };
        push(&mut out, &after[..close]);
        rest = &after[close + 1..];
    }
    if out.is_empty() {
        // "...futures for ADI, FLEX and PEP", "OKX to delist DORA, ICX and ELF ..."
        // Lower-casing ASCII keeps every byte where it was.
        let lower = title.to_ascii_lowercase();
        let starts = LIST_WORDS
            .iter()
            .filter_map(|w| lower.find(w).map(|at| at + w.len()));
        if let Some(at) = starts.min() {
            for word in title[at..].split([',', ' ']) {
                push(&mut out, word);
            }
        }
    }
    out.truncate(MAX_TICKERS);
    out
}

/// The coins an article's body names, for a notice whose title names none
/// ("Will Delist Multiple USDⓈ-M Perpetual Contracts"): its contracts
/// ("ABCUSDT"), its pairs ("ABC/USDT") and its bracketed tickers.
fn body_tickers(body: &str) -> Vec<String> {
    let mut out = tickers(body);
    for word in body.split(|c: char| !(c.is_ascii_alphanumeric() || c == '/')) {
        let coin = word.split('/').next().unwrap_or(word);
        if word.contains('/') || word.ends_with("USDT") || word.ends_with("USDC") {
            push_ticker(&mut out, coin);
        }
        if out.len() >= MAX_TICKERS {
            break;
        }
    }
    out.truncate(MAX_TICKERS);
    out
}

/// Binance's notices that remove some trading pairs, not a coin: no dump signal.
fn pair_removal(title: &str) -> bool {
    let lower = title.to_ascii_lowercase();
    lower.contains("removal of") && lower.contains("trading pairs")
}

/// A Binance article's code, as its list gives it: 32 hex digits, nothing else.
fn article_code(code: &str) -> bool {
    code.len() == 32 && code.bytes().all(|b| b.is_ascii_hexdigit())
}

const BINANCE_ARTICLE: &str =
    "https://www.binance.com/bapi/composite/v1/public/cms/article/detail/query?articleCode=";

/// What an Upbit notice is, by its title, in Korean or English.
fn upbit_kind(title: &str) -> NoticeKind {
    let lower = title.to_lowercase();
    if title.contains("종료") || lower.contains("end of") || lower.contains("delist") {
        NoticeKind::Delisting
    } else if title.contains("유의") || lower.contains("warning") || title.contains("경고") {
        NoticeKind::Warning
    } else if title.contains("추가")
        || lower.contains("market support for")
        || lower.contains("listing")
    {
        NoticeKind::Listing
    } else {
        NoticeKind::Other
    }
}

/// Days from 1970-01-01 to a civil date (Howard Hinnant's algorithm).
fn days_from_civil(y: i64, m: i64, d: i64) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = y.div_euclid(400);
    let yoe = y - era * 400;
    let doy = (153 * (m + if m > 2 { -3 } else { 9 }) + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

/// `2026-10-30T16:00:00+09:00` (Upbit's) in milliseconds since the epoch.
fn rfc3339_ms(text: &str) -> Option<i64> {
    let b = text.as_bytes();
    if b.len() < 20 || b[4] != b'-' || b[7] != b'-' || b[10] != b'T' || b[13] != b':' {
        return None;
    }
    let n = |r: std::ops::Range<usize>| text.get(r)?.parse::<i64>().ok();
    let (y, mo, d, h, mi, s) = (
        n(0..4)?,
        n(5..7)?,
        n(8..10)?,
        n(11..13)?,
        n(14..16)?,
        n(17..19)?,
    );
    if !(1..=12).contains(&mo) || !(1..=31).contains(&d) || h > 23 || mi > 59 || s > 60 {
        return None;
    }
    let zone = &text[19..];
    let offset = match zone {
        "Z" => 0,
        _ if zone.len() == 6 && (zone.starts_with('+') || zone.starts_with('-')) => {
            let sign = if zone.starts_with('-') { -1 } else { 1 };
            sign * (zone[1..3].parse::<i64>().ok()? * 3600 + zone[4..6].parse::<i64>().ok()? * 60)
        }
        _ => return None,
    };
    let secs = days_from_civil(y, mo, d) * 86_400 + h * 3600 + mi * 60 + s - offset;
    Some(secs * 1000)
}

fn parse(source: &Source, json: &str) -> Option<Vec<ExchangeNotice>> {
    let v: Value = serde_json::from_str(json).ok()?;
    let notice = |id: String, title: &str, time: i64, kind: NoticeKind| {
        let title = plain(title);
        (!title.is_empty() && time > 0).then(|| ExchangeNotice {
            id,
            exchange: source.exchange,
            kind,
            tickers: tickers(&title),
            title,
            time,
            code: None,
        })
    };
    let items = match source.exchange {
        Exchange::Binance => v["data"]["catalogs"][0]["articles"]
            .as_array()?
            .iter()
            .filter_map(|a| {
                let title = a["title"].as_str()?;
                let kind = if pair_removal(title) {
                    NoticeKind::Other
                } else {
                    source.kind?
                };
                let mut n = notice(
                    format!("binance:{}", a["id"].as_i64()?),
                    title,
                    a["releaseDate"].as_i64()?,
                    kind,
                )?;
                n.code = a["code"]
                    .as_str()
                    .filter(|c| article_code(c))
                    .map(str::to_owned);
                Some(n)
            })
            .collect(),
        Exchange::Okx => v["data"][0]["details"]
            .as_array()?
            .iter()
            .filter_map(|a| {
                let time: i64 = a["pTime"].as_str()?.parse().ok()?;
                let title = a["title"].as_str()?;
                notice(
                    format!("okx:{time}:{}", title.len()),
                    title,
                    time,
                    source.kind?,
                )
            })
            .collect(),
        Exchange::Upbit => v["data"]["notices"]
            .as_array()?
            .iter()
            .filter_map(|a| {
                let title = a["title"].as_str()?;
                let time = rfc3339_ms(a["listed_at"].as_str()?)?;
                notice(
                    format!("upbit:{}", a["id"].as_i64()?),
                    title,
                    time,
                    upbit_kind(title),
                )
            })
            .collect(),
    };
    Some(items)
}

pub struct NoticesState {
    http: reqwest::Client,
    /// Held across a read, so two views don't both fetch.
    cache: tokio::sync::Mutex<Cache>,
}

#[derive(Default)]
struct Cache {
    /// The whole answer, and when it was put together.
    latest: Option<(Instant, Notices)>,
    /// Each feed's last good read, by its place in `SOURCES`.
    feeds: Vec<Option<(Instant, Vec<ExchangeNotice>)>>,
    /// The coins each Binance article's body names, by notice id: read once.
    bodies: std::collections::HashMap<String, Vec<String>>,
}

/// A feed that fails keeps showing its last good read this long.
const KEEP_FOR: Duration = Duration::from_secs(10 * 60);
/// Article bodies read at most each refresh, for notices whose title names no coin.
const BODIES_PER_READ: usize = 5;
const MAX_BODIES: usize = 500;

impl NoticesState {
    pub fn new() -> Result<Self, VenueError> {
        let http = reqwest::Client::builder()
            .timeout(TIMEOUT)
            .gzip(true)
            // Never sent anywhere but the host asked for.
            .redirect(reqwest::redirect::Policy::none())
            .user_agent(concat!("PewterDesk/", env!("CARGO_PKG_VERSION")))
            .build()
            .map_err(|e| VenueError::Network(e.to_string()))?;
        Ok(Self {
            http,
            cache: tokio::sync::Mutex::new(Cache::default()),
        })
    }

    /// A URL's body as text, up to `MAX_BYTES` and no further.
    async fn get(&self, url: &str) -> Option<String> {
        let mut response = self
            .http
            .get(url)
            .header("Accept", "application/json")
            .send()
            .await
            .ok()?;
        if response.status().as_u16() != 200 {
            return None;
        }
        let mut body = Vec::new();
        while let Some(chunk) = response.chunk().await.ok()? {
            if body.len() + chunk.len() > MAX_BYTES {
                return None;
            }
            body.extend_from_slice(&chunk);
        }
        String::from_utf8(body).ok()
    }

    /// One feed, tried a second time if the first goes unanswered.
    async fn fetch(&self, source: &Source) -> Option<Vec<ExchangeNotice>> {
        for _ in 0..2 {
            if let Some(items) = self.get(source.url).await.and_then(|b| parse(source, &b)) {
                return Some(items);
            }
        }
        None
    }

    /// The coins a Binance article's body names.
    async fn body_coins(&self, code: &str) -> Option<Vec<String>> {
        if !article_code(code) {
            return None;
        }
        let text = self.get(&format!("{BINANCE_ARTICLE}{code}")).await?;
        let v: Value = serde_json::from_str(&text).ok()?;
        Some(body_tickers(v["data"]["body"].as_str()?))
    }
}

/// The exchanges' latest listing notices, newest first: kept a little while.
#[tauri::command]
pub async fn exchange_notices(state: State<'_, NoticesState>) -> Result<Notices, VenueError> {
    let mut cache = state.cache.lock().await;
    if let Some((at, notices)) = cache.latest.as_ref() {
        if at.elapsed() < FRESH_FOR {
            return Ok(notices.clone());
        }
    }
    cache.feeds.resize(SOURCES.len(), None);
    let reads = futures_util::future::join_all(SOURCES.iter().map(|s| state.fetch(s))).await;
    let mut items = Vec::new();
    let mut failed = Vec::new();
    for (i, (source, read)) in SOURCES.iter().zip(reads).enumerate() {
        match read {
            Some(found) => {
                cache.feeds[i] = Some((Instant::now(), found.clone()));
                items.extend(found);
            }
            None => {
                // A feed that didn't answer keeps its last good read a while.
                if let Some((_, old)) = cache.feeds[i]
                    .as_ref()
                    .filter(|(at, _)| at.elapsed() < KEEP_FOR)
                {
                    items.extend(old.iter().cloned());
                }
                if !failed.contains(&source.exchange) {
                    failed.push(source.exchange);
                }
            }
        }
    }
    // Binance notices whose title names no coin: their body does, read once each.
    let mut read_now = 0;
    for n in items.iter_mut() {
        if !n.tickers.is_empty() || n.kind == NoticeKind::Other {
            continue;
        }
        if let Some(coins) = cache.bodies.get(&n.id) {
            n.tickers = coins.clone();
            continue;
        }
        let Some(code) = n.code.clone() else { continue };
        if read_now >= BODIES_PER_READ {
            continue;
        }
        read_now += 1;
        if let Some(coins) = state.body_coins(&code).await {
            if cache.bodies.len() >= MAX_BODIES {
                cache.bodies.clear();
            }
            cache.bodies.insert(n.id.clone(), coins.clone());
            n.tickers = coins;
        }
    }
    if items.is_empty() {
        if let Some((_, old)) = cache.latest.as_ref() {
            return Ok(old.clone());
        }
        return Err(VenueError::Network(
            "exchange notices couldn't be read".into(),
        ));
    }
    items.sort_by_key(|n| std::cmp::Reverse(n.time));
    items.dedup_by(|a, b| a.id == b.id);
    let notices = Notices { items, failed };
    cache.latest = Some((Instant::now(), notices.clone()));
    Ok(notices)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_the_tickers_a_title_names() {
        assert_eq!(
            tickers("Binance Will List Predict (PREDICT) with Seed Tag Applied"),
            ["PREDICT"]
        );
        assert_eq!(
            tickers("Market Support for Nillion(NIL) (KRW Market)"),
            ["NIL"]
        );
        assert_eq!(
            tickers("블러(BLUR) 거래지원 종료 안내 (11/30 15:00)"),
            ["BLUR"]
        );
        assert_eq!(
            tickers("OKX to list TradFi perpetual futures for ADI, FLEX, MELI, PEP and UMC"),
            ["ADI", "FLEX", "MELI", "PEP", "UMC"]
        );
        assert_eq!(
            tickers("OKX to delist DORA, ICX, STORJ, ZEUS and ELF spot trading pairs"),
            ["DORA", "ICX", "STORJ", "ZEUS", "ELF"]
        );
        assert_eq!(
            tickers("Binance Will Delist EPIC, QUICK on 2026-10-28"),
            ["EPIC", "QUICK"]
        );
        assert_eq!(
            tickers("Binance Futures Will Delist PTBUSDT and MITOUSDT USDⓈ-M Perpetual Contracts"),
            ["PTB", "MITO"]
        );
        assert_eq!(
            tickers("Binance Alpha Will Remove PTB, AA, OWL, DORA (2026-10-23)"),
            ["PTB", "AA", "OWL", "DORA"]
        );
        assert!(tickers("Binance Futures Will Launch USDⓈ-Margined Contracts").is_empty());
    }

    #[test]
    fn names_an_upbit_notice_by_its_title() {
        assert_eq!(
            upbit_kind("Market Support for Nillion(NIL) (KRW Market)"),
            NoticeKind::Listing
        );
        assert_eq!(
            upbit_kind("닐리온(NIL) KRW 마켓 디지털 자산 추가"),
            NoticeKind::Listing
        );
        assert_eq!(
            upbit_kind("블러(BLUR) 거래지원 종료 안내"),
            NoticeKind::Delisting
        );
        assert_eq!(upbit_kind("Investment Warning(INIT)"), NoticeKind::Warning);
        assert_eq!(upbit_kind("정기 점검 안내"), NoticeKind::Other);
    }

    #[test]
    fn reads_the_coins_an_article_body_names() {
        let body = r#"{"node":"p","child":[{"text":"ABCUSDT and XYZUSDT perpetual contracts; the QRS/USDT pair; Foo (FOO)."}]}"#;
        assert_eq!(body_tickers(body), ["FOO", "ABC", "XYZ", "QRS"]);
    }

    #[test]
    fn a_pair_removal_is_no_delisting() {
        assert!(pair_removal(
            "Notice of Removal of Spot Trading Pairs - 2026-10-30"
        ));
        assert!(!pair_removal(
            "Binance Will Delist EPIC, QUICK on 2026-10-28"
        ));
        let got = parse(
            &SOURCES[1],
            r#"{"data":{"catalogs":[{"articles":[{"id":2,"code":"de45689cbd7b4e1fa87055cdf5a85997","title":"Notice of Removal of Spot Trading Pairs - 2026-10-30","releaseDate":1793274532329}]}]}}"#,
        )
        .unwrap();
        assert_eq!(got[0].kind, NoticeKind::Other);
        assert!(got[0].code.is_some());
    }

    #[test]
    fn only_a_plain_article_code_reaches_a_url() {
        assert!(article_code("de45689cbd7b4e1fa87055cdf5a85997"));
        assert!(!article_code("../../x"));
        assert!(!article_code("de45689cbd7b4e1fa87055cdf5a8599&x=1"));
    }

    #[test]
    fn reads_upbits_dates() {
        assert_eq!(
            rfc3339_ms("2026-10-30T16:00:00+09:00"),
            Some(1_793_343_600_000)
        );
        assert_eq!(rfc3339_ms("1970-01-01T00:00:00Z"), Some(0));
        assert_eq!(
            rfc3339_ms("2024-02-29T12:30:00-05:00"),
            Some(1_709_227_800_000)
        );
        assert_eq!(rfc3339_ms("yesterday"), None);
    }

    #[test]
    fn keeps_titles_plain_and_bounded() {
        assert_eq!(plain("  a\n\tb  "), "a b");
        assert_eq!(plain(&"x".repeat(500)).len(), MAX_TITLE);
    }

    #[test]
    fn parses_each_feed() {
        let binance = &SOURCES[0];
        let got = parse(
            binance,
            r#"{"data":{"catalogs":[{"articles":[{"id":1,"title":"Binance Will List Foo (FOO)","releaseDate":1793274532329}]}]}}"#,
        )
        .unwrap();
        assert_eq!(got[0].tickers, ["FOO"]);
        assert_eq!(got[0].kind, NoticeKind::Listing);
        let upbit = &SOURCES[4];
        let got = parse(
            upbit,
            r#"{"data":{"notices":[{"id":6721,"title":"Investment Warning(INIT)","listed_at":"2026-10-30T16:00:00+09:00"}]}}"#,
        )
        .unwrap();
        assert_eq!(got[0].kind, NoticeKind::Warning);
        assert_eq!(got[0].time, 1793343600000);
        assert!(parse(binance, "<html>").is_none());
    }

    #[test]
    fn every_request_is_to_a_fixed_host() {
        assert!(BINANCE_ARTICLE.starts_with("https://www.binance.com/"));
        for s in SOURCES {
            assert!(
                [
                    "https://www.binance.com/",
                    "https://www.okx.com/",
                    "https://api-manager.upbit.com/"
                ]
                .iter()
                .any(|h| s.url.starts_with(h)),
                "{}",
                s.url
            );
        }
    }

    /// Every feed answers and parses. Needs the network: `cargo test -- --ignored`.
    #[tokio::test]
    #[ignore]
    async fn live_feeds_parse() {
        let state = NoticesState::new().unwrap();
        for source in SOURCES {
            let items = state
                .fetch(source)
                .await
                .unwrap_or_else(|| panic!("{} didn't answer", source.url));
            assert!(!items.is_empty(), "{} had no notices", source.url);
            let named = items.iter().filter(|n| !n.tickers.is_empty()).count();
            println!(
                "{:?} {:?}: {} notices, {} name a ticker; newest: {} {:?}",
                source.exchange,
                source.kind,
                items.len(),
                named,
                items[0].title,
                items[0].tickers
            );
        }
    }
}
