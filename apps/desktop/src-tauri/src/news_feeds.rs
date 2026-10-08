//! Crypto news sites' public RSS feeds, for the News page. Like CoinGecko
//! and OKX, the publishers are data sources, not venues: no key, nothing
//! signed, one read-only GET each, to a fixed list of hosts (`PUBLISHERS`).
//! Redirects aren't followed and a feed is read only up to a size cap.
//!
//! A feed is somebody else's text, so it's treated as text: markup is
//! stripped, lengths are bounded, and nothing from it is ever interpreted.
//! An article's link stays in Rust. The UI gets an id and opens the article
//! through `open_news_article`, which opens only a link this module fetched,
//! on its publisher's own host, over https, with its query string dropped.

use std::collections::HashMap;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use pewterdesk_core::VenueError;
use quick_xml::events::Event;
use quick_xml::Reader;
use serde::Serialize;
use tauri::State;

use crate::about::open_url;
use crate::coin_info::safe_url;

const USER_AGENT: &str = concat!("pewterdesk/", env!("CARGO_PKG_VERSION"));
const TIMEOUT: Duration = Duration::from_secs(12);
/// How long the headlines are kept before the feeds are read again.
const FRESH_FOR: Duration = Duration::from_secs(5 * 60);
/// The most of one feed that's read; they run to some 50 KB.
const MAX_BYTES: usize = 2 * 1024 * 1024;
/// Articles kept from one feed, newest first.
const MAX_ARTICLES: usize = 40;
const MAX_TITLE: usize = 200;
const MAX_SUMMARY: usize = 600;
const MAX_TAGS: usize = 6;
const MAX_TAG: usize = 32;

/// A news site whose feed is read.
struct Publisher {
    id: &'static str,
    name: &'static str,
    feed: &'static str,
    /// Article links must be on this host or under it.
    host: &'static str,
}

const PUBLISHERS: [Publisher; 4] = [
    Publisher {
        id: "coindesk",
        name: "CoinDesk",
        feed: "https://www.coindesk.com/arc/outboundfeeds/rss",
        host: "coindesk.com",
    },
    Publisher {
        id: "cointelegraph",
        name: "Cointelegraph",
        feed: "https://cointelegraph.com/rss",
        host: "cointelegraph.com",
    },
    Publisher {
        id: "theblock",
        name: "The Block",
        feed: "https://www.theblock.co/rss.xml",
        host: "theblock.co",
    },
    Publisher {
        id: "decrypt",
        name: "Decrypt",
        feed: "https://decrypt.co/feed",
        host: "decrypt.co",
    },
];

/// A headline, as the UI takes it. Its link isn't here; see `open_news_article`.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Article {
    /// Names the article to `open_news_article`.
    pub id: String,
    /// The publisher's id, e.g. "coindesk".
    pub source: String,
    /// The publisher's name, e.g. "CoinDesk".
    pub source_name: String,
    pub title: String,
    pub summary: String,
    /// The publisher's own labels, e.g. "Markets".
    pub tags: Vec<String>,
    /// When it was published, in milliseconds since the Unix epoch.
    pub time: u64,
}

/// An `<item>` as read from a feed, before it's checked.
#[derive(Default)]
struct RawItem {
    title: String,
    link: String,
    description: String,
    date: String,
    categories: Vec<String>,
}

/// A feed's `<item>`s, in the feed's order. Tolerant: whatever can't be
/// read ends the list there rather than failing it.
fn items(xml: &str) -> Vec<RawItem> {
    let mut reader = Reader::from_str(xml);
    let mut out = Vec::new();
    let mut item: Option<RawItem> = None;
    // The item's child element being read, and its text so far.
    let mut field: Option<String> = None;
    let mut text = String::new();
    loop {
        match reader.read_event() {
            Ok(Event::Start(e)) => {
                let name = e.name().as_ref().to_owned();
                if name == "item" {
                    item = Some(RawItem::default());
                } else if item.is_some() && field.is_none() {
                    field = Some(name);
                    text.clear();
                }
            }
            Ok(Event::Text(e)) if field.is_some() => text.push_str(&e.xml10_content()),
            Ok(Event::CData(e)) if field.is_some() => text.push_str(&e.xml10_content()),
            Ok(Event::GeneralRef(e)) if field.is_some() => {
                // Left as written: `plain` reads entities, in markup or out.
                text.push('&');
                text.push_str(&e.xml10_content());
                text.push(';');
            }
            Ok(Event::End(e)) => {
                let name = e.name().as_ref().to_owned();
                if name == "item" {
                    out.extend(item.take());
                    field = None;
                } else if field.as_deref() == Some(name.as_str()) {
                    if let Some(item) = item.as_mut() {
                        let value = std::mem::take(&mut text);
                        match name.as_str() {
                            "title" => item.title = value,
                            "link" => item.link = value,
                            "description" => item.description = value,
                            "pubDate" => item.date = value,
                            "category" => item.categories.push(value),
                            _ => {}
                        }
                    }
                    field = None;
                }
            }
            Ok(Event::Eof) | Err(_) => break,
            Ok(_) => {}
        }
    }
    out
}

/// The character an entity stands for: `amp`, `#8217`, `#x2019`, and the
/// few named ones feeds use. Anything else isn't one.
fn entity(name: &str) -> Option<char> {
    if let Some(number) = name.strip_prefix('#') {
        let code = match number.strip_prefix(['x', 'X']) {
            Some(hex) => u32::from_str_radix(hex, 16).ok()?,
            None => number.parse().ok()?,
        };
        return char::from_u32(code);
    }
    Some(match name {
        "amp" => '&',
        "lt" => '<',
        "gt" => '>',
        "quot" => '"',
        "apos" => '\'',
        "nbsp" => ' ',
        "rsquo" => '\u{2019}',
        "lsquo" => '\u{2018}',
        "rdquo" => '\u{201d}',
        "ldquo" => '\u{201c}',
        "mdash" => '\u{2014}',
        "ndash" => '\u{2013}',
        "hellip" => '\u{2026}',
        _ => return None,
    })
}

/// `text` with its entities read ("&amp;" to "&").
fn unescape(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(at) = rest.find('&') {
        out.push_str(&rest[..at]);
        let after = &rest[at + 1..];
        let found = after
            .find(';')
            .filter(|end| *end <= 10)
            .and_then(|end| entity(&after[..end]).map(|ch| (ch, end)));
        match found {
            Some((ch, end)) => {
                out.push(ch);
                rest = &after[end + 1..];
            }
            None => {
                out.push('&');
                rest = after;
            }
        }
    }
    out.push_str(rest);
    out
}

/// Feed text as plain text: tags dropped, entities read, control characters
/// removed, runs of spaces closed up, and at most `max` characters.
fn plain(text: &str, max: usize) -> String {
    // Entities first where the markup itself came escaped ("&lt;p&gt;").
    let text = unescape(text);
    let mut bare = String::with_capacity(text.len());
    let mut in_tag = false;
    for ch in text.chars() {
        match ch {
            '<' => in_tag = true,
            '>' if in_tag => {
                in_tag = false;
                bare.push(' ');
            }
            _ if !in_tag => bare.push(ch),
            _ => {}
        }
    }
    let bare = unescape(&bare);
    let words: Vec<&str> = bare
        .split(|c: char| c.is_whitespace() || c.is_control())
        .filter(|w| !w.is_empty())
        .collect();
    words.join(" ").chars().take(max).collect()
}

/// Days from 1970-01-01 to a date (the proleptic Gregorian calendar).
fn days_from_civil(year: i64, month: i64, day: i64) -> i64 {
    let y = if month <= 2 { year - 1 } else { year };
    let era = y.div_euclid(400);
    let yoe = y.rem_euclid(400);
    let doy = (153 * (month + if month > 2 { -3 } else { 9 }) + 2) / 5 + day - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

/// An RSS date ("Wed, 07 Oct 2026 20:48:34 +0000") in milliseconds since
/// the Unix epoch. A named zone counts as UTC, which is what feeds use.
fn rss_time(date: &str) -> Option<u64> {
    let date = date.trim();
    // The weekday is optional and tells nothing.
    let date = date.split_once(',').map_or(date, |(_, rest)| rest);
    let mut parts = date.split_whitespace();
    let day: i64 = parts.next()?.parse().ok()?;
    let month = match parts.next()?.get(..3)?.to_ascii_lowercase().as_str() {
        "jan" => 1,
        "feb" => 2,
        "mar" => 3,
        "apr" => 4,
        "may" => 5,
        "jun" => 6,
        "jul" => 7,
        "aug" => 8,
        "sep" => 9,
        "oct" => 10,
        "nov" => 11,
        "dec" => 12,
        _ => return None,
    };
    let year: i64 = parts.next()?.parse().ok()?;
    let mut clock = parts.next()?.split(':');
    let hour: i64 = clock.next()?.parse().ok()?;
    let minute: i64 = clock.next()?.parse().ok()?;
    let second: i64 = clock.next().map_or(Some(0), |s| s.parse().ok())?;
    let zone = parts.next().unwrap_or("+0000");
    let offset = match zone.as_bytes().first() {
        Some(sign @ (b'+' | b'-')) if zone.len() == 5 => {
            let hours: i64 = zone.get(1..3)?.parse().ok()?;
            let minutes: i64 = zone.get(3..5)?.parse().ok()?;
            (hours * 3600 + minutes * 60) * if *sign == b'-' { -1 } else { 1 }
        }
        _ => 0,
    };
    let in_range = (1970..=2200).contains(&year)
        && (1..=31).contains(&day)
        && (0..24).contains(&hour)
        && (0..60).contains(&minute)
        && (0..=60).contains(&second);
    if !in_range {
        return None;
    }
    let seconds =
        days_from_civil(year, month, day) * 86_400 + hour * 3600 + minute * 60 + second - offset;
    u64::try_from(seconds).ok().map(|s| s * 1000)
}

/// An article's link if it may be opened: https, on the publisher's host
/// or under it, and plain enough for `safe_url`. The query string and
/// fragment (tracking, mostly) are dropped.
fn article_link(link: &str, host: &str) -> Option<String> {
    let link = link.trim();
    let link = link.split(['?', '#']).next().unwrap_or(link);
    let rest = link.strip_prefix("https://")?;
    let on = rest.split('/').next().unwrap_or("");
    let ours = on == host
        || on
            .strip_suffix(host)
            .is_some_and(|sub| sub.ends_with('.') && sub.len() > 1);
    if !ours {
        return None;
    }
    safe_url(link)
}

/// A short, stable name for a link: FNV-1a, in hex.
fn link_id(link: &str) -> String {
    let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
    for byte in link.bytes() {
        hash ^= u64::from(byte);
        hash = hash.wrapping_mul(0x0000_0100_0000_01b3);
    }
    format!("{hash:016x}")
}

/// A feed's articles with their links, newest first. Items without a
/// title, a time or a link that may be opened are left out.
fn articles(xml: &str, publisher: &Publisher) -> Vec<(Article, String)> {
    let mut out: Vec<(Article, String)> = items(xml)
        .into_iter()
        .filter_map(|item| {
            let title = plain(&item.title, MAX_TITLE);
            let link = article_link(&unescape(&item.link), publisher.host)?;
            let time = rss_time(&item.date)?;
            if title.is_empty() {
                return None;
            }
            let mut tags: Vec<String> = Vec::new();
            for category in &item.categories {
                let tag = plain(category, MAX_TAG);
                if !tag.is_empty() && !tags.contains(&tag) && tags.len() < MAX_TAGS {
                    tags.push(tag);
                }
            }
            let article = Article {
                id: format!("{}:{}", publisher.id, link_id(&link)),
                source: publisher.id.to_owned(),
                source_name: publisher.name.to_owned(),
                title,
                summary: plain(&item.description, MAX_SUMMARY),
                tags,
                time,
            };
            Some((article, link))
        })
        .collect();
    out.sort_by_key(|a| std::cmp::Reverse(a.0.time));
    out.truncate(MAX_ARTICLES);
    out
}

/// One publisher's feed, as text. Read up to `MAX_BYTES` and no further.
async fn fetch(http: reqwest::Client, feed: &'static str) -> Option<String> {
    let mut response = http.get(feed).send().await.ok()?;
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

type Cached = (Instant, Vec<Article>);

pub struct NewsState {
    http: reqwest::Client,
    /// The last headlines read, and when. Held across a read, so two
    /// callers don't both fetch.
    cache: tokio::sync::Mutex<Option<Cached>>,
    /// Each article's link, by its id. Never sent to the UI.
    links: Mutex<HashMap<String, String>>,
}

impl NewsState {
    pub fn new() -> Result<Self, VenueError> {
        let http = reqwest::Client::builder()
            .timeout(TIMEOUT)
            .user_agent(USER_AGENT)
            .gzip(true)
            // Never sent anywhere but the host asked for.
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .map_err(|e| VenueError::Network(e.to_string()))?;
        Ok(Self {
            http,
            cache: tokio::sync::Mutex::new(None),
            links: Mutex::new(HashMap::new()),
        })
    }
}

/// The publishers' latest headlines, newest first. A feed that can't be
/// read is left out; it's an error only when none can.
#[tauri::command]
pub async fn news_feed(state: State<'_, NewsState>) -> Result<Vec<Article>, VenueError> {
    let mut cache = state.cache.lock().await;
    if let Some((at, articles)) = cache.as_ref() {
        if at.elapsed() < FRESH_FOR {
            return Ok(articles.clone());
        }
    }
    let reads: Vec<_> = PUBLISHERS
        .iter()
        .map(|p| tauri::async_runtime::spawn(fetch(state.http.clone(), p.feed)))
        .collect();
    let mut all = Vec::new();
    let mut links = HashMap::new();
    let mut read = 0;
    for (publisher, task) in PUBLISHERS.iter().zip(reads) {
        let Ok(Some(xml)) = task.await else { continue };
        read += 1;
        for (article, link) in articles(&xml, publisher) {
            links.insert(article.id.clone(), link);
            all.push(article);
        }
    }
    if read == 0 {
        // The last headlines, if there are any, beat none at all.
        return match cache.as_ref() {
            Some((_, articles)) => Ok(articles.clone()),
            None => Err(VenueError::Network("no news feed could be read".into())),
        };
    }
    all.sort_by_key(|a| std::cmp::Reverse(a.time));
    *state.links.lock().unwrap() = links;
    *cache = Some((Instant::now(), all.clone()));
    Ok(all)
}

/// Opens an article in the browser, by the id `news_feed` gave it - never
/// a URL from the UI.
#[tauri::command]
pub fn open_news_article(state: State<'_, NewsState>, id: String) -> Result<(), VenueError> {
    let url = state
        .links
        .lock()
        .unwrap()
        .get(&id)
        .cloned()
        .ok_or_else(|| VenueError::InvalidRequest("that article isn't available".into()))?;
    open_url(&url).map_err(|_| VenueError::Network("couldn't open the browser".into()))
}

#[cfg(test)]
mod tests {
    use super::*;

    const FEED: &str = r#"<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:dc="http://purl.org/dc/elements/1.1/">
  <channel>
    <title>Example News</title>
    <link>https://example.com</link>
    <item>
      <title><![CDATA[Bitcoin tops $100,000 &amp; holds]]></title>
      <link><![CDATA[https://www.example.com/markets/btc-tops?utm_source=rss&utm_medium=rss]]></link>
      <pubDate>Wed, 07 Oct 2026 20:48:34 +0000</pubDate>
      <description><![CDATA[<p style="x"><img src="https://evil.test/a.png"></p><p>It&#8217;s up&nbsp;4%.</p>]]></description>
      <category>Markets</category>
      <category><![CDATA[Bitcoin]]></category>
      <dc:creator>Someone</dc:creator>
    </item>
    <item>
      <title>Older &amp; plainer</title>
      <link>https://example.com/older</link>
      <pubDate>Tue, 06 Oct 2026 10:00:00 GMT</pubDate>
      <description>Plain text.</description>
    </item>
    <item>
      <title>Off-site link</title>
      <link>https://example.com.evil.test/x</link>
      <pubDate>Wed, 07 Oct 2026 21:00:00 +0000</pubDate>
    </item>
    <item>
      <title>No date</title>
      <link>https://example.com/undated</link>
    </item>
  </channel>
</rss>"#;

    const EXAMPLE: Publisher = Publisher {
        id: "example",
        name: "Example",
        feed: "https://example.com/rss",
        host: "example.com",
    };

    #[test]
    fn reads_a_feed_as_plain_text() {
        let read = articles(FEED, &EXAMPLE);
        assert_eq!(read.len(), 2, "the off-site and undated items are left out");
        let (first, link) = &read[0];
        assert_eq!(first.title, "Bitcoin tops $100,000 & holds");
        assert_eq!(first.summary, "It\u{2019}s up 4%.");
        assert_eq!(first.tags, ["Markets", "Bitcoin"]);
        assert_eq!(first.source_name, "Example");
        assert_eq!(first.time, 1_791_406_114_000);
        // The tracking query is gone, and the id names the link without carrying it.
        assert_eq!(link, "https://www.example.com/markets/btc-tops");
        assert!(first.id.starts_with("example:") && !first.id.contains("http"));
        assert_eq!(read[1].0.title, "Older & plainer");
    }

    #[test]
    fn opens_only_the_publishers_own_https_links() {
        let ok = |link| article_link(link, "example.com");
        assert!(ok("https://example.com/a").is_some());
        assert!(ok("https://www.example.com/a/b-c").is_some());
        assert!(ok("http://example.com/a").is_none());
        assert!(ok("https://example.com.evil.test/a").is_none());
        assert!(ok("https://notexample.com/a").is_none());
        assert!(ok("https://example.com@evil.test/a").is_none());
        assert!(ok("https://example.com/a b").is_none());
        assert!(ok("javascript:alert(1)").is_none());
    }

    #[test]
    fn reads_rss_dates() {
        assert_eq!(rss_time("Thu, 01 Jan 1970 00:00:00 GMT"), Some(0));
        assert_eq!(
            rss_time("Wed, 07 Oct 2026 20:48:34 +0000"),
            Some(1_791_406_114_000)
        );
        // An offset is taken off: 22:48 at +02:00 is the same moment.
        assert_eq!(
            rss_time("07 Oct 2026 22:48:34 +0200"),
            Some(1_791_406_114_000)
        );
        assert_eq!(rss_time("yesterday"), None);
        assert_eq!(rss_time("Wed, 07 Foo 2026 20:48:34 +0000"), None);
    }

    #[test]
    fn strips_markup_and_bounds_text() {
        assert_eq!(plain("&lt;b&gt;Bold&lt;/b&gt; move", 80), "Bold move");
        assert_eq!(plain("a\u{7}\n\n  b", 80), "a b");
        assert_eq!(
            plain("AT&T & co &bogus; done", 80),
            "AT&T & co &bogus; done"
        );
        assert_eq!(
            plain(&"x".repeat(900), MAX_SUMMARY).chars().count(),
            MAX_SUMMARY
        );
    }

    /// Reads the real feeds: needs the network, so it's skipped by default
    /// (`cargo test -p pewterdesk news_feeds -- --ignored`).
    #[test]
    #[ignore]
    fn reads_the_live_feeds() {
        let state = NewsState::new().unwrap();
        for publisher in &PUBLISHERS {
            let xml = tauri::async_runtime::block_on(fetch(state.http.clone(), publisher.feed))
                .unwrap_or_else(|| panic!("{} didn't answer", publisher.name));
            let read = articles(&xml, publisher);
            assert!(
                read.len() >= 5,
                "{}: {} articles",
                publisher.name,
                read.len()
            );
            let summaries = read.iter().filter(|(a, _)| !a.summary.is_empty()).count();
            println!(
                "{}: {} articles, {summaries} with a summary; first: {:?}",
                publisher.name,
                read.len(),
                read[0].0
            );
        }
    }

    #[test]
    fn every_publisher_is_https_on_its_own_host() {
        for p in &PUBLISHERS {
            assert!(article_link(p.feed, p.host).is_some(), "{}", p.name);
        }
    }
}
