//! The week's economic calendar (rate decisions, inflation, jobs...), for
//! the Calendar panel, from Forex Factory's public weekly export. Like the
//! news feeds it's a data source, not a venue: no key, nothing signed, one
//! read-only GET to one fixed URL (`FEED`), no redirects followed, read up
//! to a size cap and kept an hour (the export changes about that often, and
//! its host turns away callers who ask more).
//!
//! The export is somebody else's text, so it's treated as text: every field
//! goes through `plain` and is bounded, and nothing in it is a link.

use std::sync::Arc;
use std::time::{Duration, Instant};

use async_trait::async_trait;
use pewterdesk_core::VenueError;
use pewterdesk_engine as engine;
use serde::{Deserialize, Serialize};
use tauri::State;

use crate::news_feeds::{days_from_civil, plain};

const FEED: &str = "https://nfs.faireconomy.media/ff_calendar_thisweek.json";
const USER_AGENT: &str = concat!("pewterdesk/", env!("CARGO_PKG_VERSION"));
const TIMEOUT: Duration = Duration::from_secs(12);
/// How long the calendar is kept before it's read again.
const FRESH_FOR: Duration = Duration::from_secs(60 * 60);
/// How long a failed read waits before the next try.
const RETRY_AFTER: Duration = Duration::from_secs(5 * 60);
/// The most of the export that's read; a week runs to some 15 KB.
const MAX_BYTES: usize = 512 * 1024;
const MAX_EVENTS: usize = 500;
const MAX_TITLE: usize = 120;
/// A forecast or previous figure ("0.3%", "245K").
const MAX_FIGURE: usize = 24;

/// How much an event is expected to move its currency, as the calendar rates it.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Impact {
    High,
    Medium,
    Low,
    /// A bank holiday: markets thin, nothing released.
    Holiday,
}

/// One scheduled release or event, as the UI takes it.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CalendarEvent {
    pub title: String,
    /// The currency it's about ("USD"), or "All" for one that touches every one.
    pub currency: String,
    /// When, in milliseconds since the Unix epoch.
    pub time: u64,
    pub impact: Impact,
    pub forecast: Option<String>,
    pub previous: Option<String>,
}

#[derive(Deserialize)]
struct RawEvent {
    title: String,
    country: String,
    date: String,
    impact: String,
    #[serde(default)]
    forecast: String,
    #[serde(default)]
    previous: String,
}

/// An ISO 8601 time with an offset ("2026-10-12T05:30:00-04:00", or with
/// fractional seconds, "2024-12-02T11:02:01.084Z") in milliseconds since the
/// Unix epoch. "Z" counts as UTC.
pub(crate) fn iso_time(date: &str) -> Option<u64> {
    let date = date.trim();
    let num = |range: std::ops::Range<usize>| -> Option<i64> {
        let part = date.get(range)?;
        part.bytes()
            .all(|b| b.is_ascii_digit())
            .then(|| part.parse().ok())?
    };
    let shape = date.as_bytes();
    if shape.len() < 20 || shape[4] != b'-' || shape[7] != b'-' || shape[10] != b'T' {
        return None;
    }
    let (year, month, day) = (num(0..4)?, num(5..7)?, num(8..10)?);
    let (hour, minute, second) = (num(11..13)?, num(14..16)?, num(17..19)?);
    // Fractional seconds, to the millisecond (any further digits dropped).
    let rest = &date[19..];
    let (millis, zone) = match rest.strip_prefix('.') {
        Some(frac) => {
            let digits = frac.bytes().take_while(u8::is_ascii_digit).count();
            if digits == 0 {
                return None;
            }
            let ms: u64 = format!("{:0<3}", &frac[..digits.min(3)]).parse().ok()?;
            (ms, &frac[digits..])
        }
        None => (0, rest),
    };
    let offset = match zone.as_bytes().first() {
        Some(b'Z') if zone.len() == 1 => 0,
        Some(sign @ (b'+' | b'-')) if zone.len() == 6 && zone.as_bytes()[3] == b':' => {
            let hours: i64 = zone.get(1..3)?.parse().ok()?;
            let minutes: i64 = zone.get(4..6)?.parse().ok()?;
            (hours * 3600 + minutes * 60) * if *sign == b'-' { -1 } else { 1 }
        }
        _ => return None,
    };
    let in_range = (1970..=2200).contains(&year)
        && (1..=12).contains(&month)
        && (1..=31).contains(&day)
        && (0..24).contains(&hour)
        && (0..60).contains(&minute)
        && (0..=60).contains(&second);
    if !in_range {
        return None;
    }
    let seconds =
        days_from_civil(year, month, day) * 86_400 + hour * 3600 + minute * 60 + second - offset;
    u64::try_from(seconds).ok().map(|s| s * 1000 + millis)
}

/// A currency code ("USD"), or "All"; anything else isn't one.
fn currency(code: &str) -> Option<String> {
    let code = code.trim();
    if code.eq_ignore_ascii_case("all") {
        return Some("All".into());
    }
    (code.len() == 3 && code.bytes().all(|b| b.is_ascii_alphabetic()))
        .then(|| code.to_ascii_uppercase())
}

fn impact(rating: &str) -> Option<Impact> {
    Some(match rating.trim().to_ascii_lowercase().as_str() {
        "high" => Impact::High,
        "medium" => Impact::Medium,
        "low" => Impact::Low,
        "holiday" => Impact::Holiday,
        _ => return None,
    })
}

fn figure(text: &str) -> Option<String> {
    Some(plain(text, MAX_FIGURE)).filter(|f| !f.is_empty())
}

/// The export's events, soonest first. An entry that can't be read (no
/// title, an unknown currency, impact or time) is left out, not the week.
fn events(json: &str) -> Result<Vec<CalendarEvent>, VenueError> {
    let raw: Vec<serde_json::Value> = serde_json::from_str(json)
        .map_err(|_| VenueError::Network("the calendar couldn't be read".into()))?;
    let mut out: Vec<CalendarEvent> = raw
        .into_iter()
        .take(MAX_EVENTS)
        .filter_map(|value| {
            let raw: RawEvent = serde_json::from_value(value).ok()?;
            let title = plain(&raw.title, MAX_TITLE);
            if title.is_empty() {
                return None;
            }
            Some(CalendarEvent {
                title,
                currency: currency(&raw.country)?,
                time: iso_time(&raw.date)?,
                impact: impact(&raw.impact)?,
                forecast: figure(&raw.forecast),
                previous: figure(&raw.previous),
            })
        })
        .collect();
    out.sort_by_key(|e| e.time);
    Ok(out)
}

/// The export, as text. Read up to `MAX_BYTES` and no further.
async fn fetch(http: &reqwest::Client) -> Option<String> {
    let mut response = http.get(FEED).send().await.ok()?;
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

#[derive(Default)]
struct Cache {
    /// The last calendar read, and when.
    events: Option<(Instant, Vec<CalendarEvent>)>,
    /// When a read last failed.
    failed: Option<Instant>,
}

pub struct CalendarState {
    inner: Arc<Inner>,
}

struct Inner {
    http: reqwest::Client,
    /// Held across a read, so two callers don't both fetch.
    cache: tokio::sync::Mutex<Cache>,
    /// The last calendar read, for `kept`: readable while a read holds `cache`.
    latest: std::sync::Mutex<Option<(Instant, Vec<CalendarEvent>)>>,
}

impl CalendarState {
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
            inner: Arc::new(Inner {
                http,
                cache: tokio::sync::Mutex::new(Cache::default()),
                latest: std::sync::Mutex::new(None),
            }),
        })
    }

    /// This week's calendar, soonest first: the copy kept, read again once
    /// it's an hour old. A read that fails keeps the last copy, which beats
    /// none at all; `None` only until the calendar has been read once.
    pub(crate) async fn read(&self) -> Option<Vec<CalendarEvent>> {
        self.inner.read().await
    }

    /// The calendar for an order's check (the trading rules' news
    /// blackout): the copy kept, at once, never waiting on the network, with
    /// a read started in the background once it's an hour old. It waits only
    /// for the very first read, when there's no copy to answer from.
    async fn kept_events(&self) -> Option<Vec<CalendarEvent>> {
        let latest = self.inner.latest.lock().unwrap().clone();
        match latest {
            Some((at, events)) => {
                if at.elapsed() >= FRESH_FOR {
                    let inner = Arc::clone(&self.inner);
                    tauri::async_runtime::spawn(async move {
                        inner.read().await;
                    });
                }
                Some(events)
            }
            None => self.inner.read().await,
        }
    }
}

impl Inner {
    async fn read(&self) -> Option<Vec<CalendarEvent>> {
        let mut cache = self.cache.lock().await;
        let fresh = cache
            .events
            .as_ref()
            .is_some_and(|(at, _)| at.elapsed() < FRESH_FOR);
        let resting = cache.failed.is_some_and(|at| at.elapsed() < RETRY_AFTER);
        if !fresh && !resting {
            match fetch(&self.http).await.map(|json| events(&json)) {
                Some(Ok(read)) => {
                    *self.latest.lock().unwrap() = Some((Instant::now(), read.clone()));
                    cache.events = Some((Instant::now(), read));
                    cache.failed = None;
                }
                _ => cache.failed = Some(Instant::now()),
            }
        }
        cache.events.as_ref().map(|(_, events)| events.clone())
    }
}

/// The trading rules' news blackout reads the calendar through this: the
/// copy kept, never waiting on the network once it has been read.
#[async_trait]
impl engine::Calendar for CalendarState {
    async fn kept(&self) -> Option<Vec<engine::CalendarEvent>> {
        let events = self.kept_events().await?;
        Some(
            events
                .into_iter()
                .map(|e| engine::CalendarEvent {
                    title: e.title,
                    currency: e.currency,
                    time: e.time,
                    impact: match e.impact {
                        Impact::High => engine::Impact::High,
                        Impact::Medium => engine::Impact::Medium,
                        Impact::Low => engine::Impact::Low,
                        Impact::Holiday => engine::Impact::Holiday,
                    },
                })
                .collect(),
        )
    }
}

/// This week's economic calendar, soonest first.
#[tauri::command]
pub async fn economic_calendar(
    state: State<'_, CalendarState>,
) -> Result<Vec<CalendarEvent>, VenueError> {
    state
        .read()
        .await
        .ok_or_else(|| VenueError::Network("the calendar couldn't be read".into()))
}

#[cfg(test)]
mod tests {
    use super::*;

    const WEEK: &str = r#"[
      {"title":"Core CPI m/m","country":"USD","date":"2026-10-14T08:30:00-04:00","impact":"High","forecast":"0.3%","previous":"0.2%"},
      {"title":"Bank Holiday","country":"JPY","date":"2026-10-11T19:00:00-04:00","impact":"Holiday","forecast":"","previous":""},
      {"title":"IMF <b>Meetings</b>","country":"All","date":"2026-10-12T10:15:00-04:00","impact":"Medium"},
      {"title":"Bad currency","country":"US$","date":"2026-10-12T10:15:00-04:00","impact":"Low"},
      {"title":"Bad impact","country":"EUR","date":"2026-10-12T10:15:00-04:00","impact":"Huge"},
      {"title":"Bad date","country":"EUR","date":"Tuesday","impact":"Low"},
      {"title":"","country":"EUR","date":"2026-10-12T10:15:00-04:00","impact":"Low"},
      {"nonsense":true}
    ]"#;

    #[test]
    fn reads_the_week_soonest_first() {
        let read = events(WEEK).unwrap();
        assert_eq!(read.len(), 3, "the unreadable entries are left out");
        assert_eq!(read[0].title, "Bank Holiday");
        assert_eq!(read[0].impact, Impact::Holiday);
        assert_eq!(read[0].forecast, None);
        assert_eq!(read[1].title, "IMF Meetings", "markup is stripped");
        assert_eq!(read[1].currency, "All");
        let cpi = &read[2];
        assert_eq!(cpi.currency, "USD");
        assert_eq!(cpi.impact, Impact::High);
        assert_eq!(cpi.forecast.as_deref(), Some("0.3%"));
        assert_eq!(cpi.previous.as_deref(), Some("0.2%"));
        // 08:30 at -04:00 is 12:30 UTC.
        assert_eq!(cpi.time, iso_time("2026-10-14T12:30:00Z").unwrap());
    }

    #[test]
    fn refuses_what_isnt_a_calendar() {
        assert!(events("<html>blocked</html>").is_err());
        assert!(events(r#"{"title":"x"}"#).is_err());
        assert_eq!(events("[]").unwrap(), vec![]);
    }

    #[test]
    fn reads_iso_times() {
        assert_eq!(iso_time("1970-01-01T00:00:00Z"), Some(0));
        assert_eq!(iso_time("1970-01-01T01:00:00+01:00"), Some(0));
        assert_eq!(iso_time("1970-01-01T19:00:00-05:00"), Some(86_400_000));
        assert_eq!(
            iso_time("2026-10-14T08:30:00-04:00"),
            Some(1_791_981_000_000)
        );
        assert_eq!(iso_time("2026-13-14T08:30:00Z"), None);
        assert_eq!(iso_time("2026-10-14 08:30:00Z"), None);
        assert_eq!(iso_time("2026-10-14T08:30:00"), None);
        assert_eq!(iso_time("2026-10-14T08:30:00+0400"), None);
        assert_eq!(iso_time("２026-10-14T08:30:00Z"), None);
        assert_eq!(iso_time("1970-01-01T00:00:01.084Z"), Some(1084));
        assert_eq!(iso_time("1970-01-01T00:00:01.5+00:00"), Some(1500));
        assert_eq!(iso_time("1970-01-01T00:00:01.123456Z"), Some(1123));
        assert_eq!(iso_time("1970-01-01T00:00:01.Z"), None);
    }

    #[test]
    fn reads_only_currency_codes() {
        assert_eq!(currency("usd").as_deref(), Some("USD"));
        assert_eq!(currency("ALL").as_deref(), Some("All"));
        assert_eq!(currency("US"), None);
        assert_eq!(currency("U$D"), None);
    }

    /// Reads the real export: needs the network, so it's skipped by default
    /// (`cargo test -p pewterdesk econ_calendar -- --ignored`).
    #[test]
    #[ignore]
    fn reads_the_live_calendar() {
        let state = CalendarState::new().unwrap();
        let json = tauri::async_runtime::block_on(fetch(&state.inner.http)).expect("no answer");
        let read = events(&json).unwrap();
        assert!(read.len() >= 20, "{} events", read.len());
        let high = read.iter().filter(|e| e.impact == Impact::High).count();
        println!(
            "{} events, {high} high impact; first: {:?}",
            read.len(),
            read[0]
        );
    }
}
