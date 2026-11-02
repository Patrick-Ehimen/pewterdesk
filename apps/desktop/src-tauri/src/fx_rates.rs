//! What a US dollar is worth in other currencies, for showing a chart or the
//! app's money in them: the community `currency-api` exports on jsDelivr, the
//! one free source with naira and with rates by date. A data source, not a
//! venue: no key, nothing signed, one read-only GET to one fixed file (the
//! latest, or a date's), no redirects followed, a size cap.
//!
//! Rates are display only and a day old at best: nothing here reaches an
//! order, a trading rule or a limit. The UI names a currency from `CURRENCIES`
//! and a date as `YYYY-MM-DD`; anything else is refused before a URL is built.

use std::collections::{BTreeMap, HashMap};
use std::time::{Duration, Instant};

use pewterdesk_core::VenueError;
use serde::{Deserialize, Serialize};
use tauri::State;

const BASE: &str = "https://cdn.jsdelivr.net/npm/@fawazahmed0/currency-api@";
const FILE: &str = "/v1/currencies/usd.min.json";
const TIMEOUT: Duration = Duration::from_secs(12);
/// The latest rates change daily; a read is kept this long.
const FRESH_FOR: Duration = Duration::from_secs(6 * 60 * 60);
/// A day's file runs to some 6 KB.
const MAX_BYTES: usize = 64 * 1024;
/// Dates a chart may ask for at once: a month each, over years of candles.
const MAX_DATES: usize = 64;
/// Past days kept: they never change.
const MAX_DAYS: usize = 400;
/// The first date the exports cover.
const FIRST_YEAR: u32 = 2024;

/// What may be shown. A fixed list: the feed's own is hundreds long.
const CURRENCIES: &[&str] = &[
    "AED", "AUD", "BRL", "CAD", "CHF", "CNY", "DKK", "EGP", "EUR", "GBP", "GHS", "HKD", "IDR",
    "INR", "JPY", "KES", "KRW", "MXN", "NGN", "NOK", "NZD", "PHP", "PLN", "SAR", "SEK", "SGD",
    "THB", "TRY", "USD", "VND", "ZAR",
];

type Rates = BTreeMap<String, f64>;

#[derive(Deserialize)]
struct Raw {
    usd: HashMap<String, serde_json::Value>,
}

/// One day's rates, as the UI takes them: units of each currency to a dollar.
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct FxDay {
    pub date: String,
    pub rates: Rates,
}

/// The export's rates for the currencies on the list; anything else is dropped.
fn parse(json: &str) -> Option<Rates> {
    let raw: Raw = serde_json::from_str(json).ok()?;
    let rates: Rates = CURRENCIES
        .iter()
        .filter_map(|code| {
            let rate = raw.usd.get(&code.to_ascii_lowercase())?.as_f64()?;
            (rate.is_finite() && rate > 0.0).then(|| ((*code).to_owned(), rate))
        })
        .collect();
    (!rates.is_empty()).then_some(rates)
}

/// A calendar date of the shape the feed's versions take, and nothing else.
fn valid_date(date: &str) -> bool {
    let bytes = date.as_bytes();
    let digits = |r: std::ops::Range<usize>| bytes[r].iter().all(u8::is_ascii_digit);
    if bytes.len() != 10 || bytes[4] != b'-' || bytes[7] != b'-' {
        return false;
    }
    if !digits(0..4) || !digits(5..7) || !digits(8..10) {
        return false;
    }
    let year: u32 = date[..4].parse().unwrap_or(0);
    let month: u32 = date[5..7].parse().unwrap_or(0);
    let day: u32 = date[8..].parse().unwrap_or(0);
    (FIRST_YEAR..=2100).contains(&year) && (1..=12).contains(&month) && (1..=31).contains(&day)
}

fn url(version: &str) -> String {
    format!("{BASE}{version}{FILE}")
}

#[derive(Default)]
struct Cache {
    latest: Option<(Instant, FxDay)>,
    days: HashMap<String, Rates>,
}

pub struct FxState {
    http: reqwest::Client,
    /// Held across a read, so two charts don't both fetch.
    cache: tokio::sync::Mutex<Cache>,
}

impl FxState {
    pub fn new() -> Result<Self, VenueError> {
        let http = reqwest::Client::builder()
            .timeout(TIMEOUT)
            .gzip(true)
            // Never sent anywhere but the host asked for.
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .map_err(|e| VenueError::Network(e.to_string()))?;
        Ok(Self {
            http,
            cache: tokio::sync::Mutex::new(Cache::default()),
        })
    }

    /// The export, up to `MAX_BYTES` and no further.
    async fn fetch(&self, version: &str) -> Option<Rates> {
        let mut response = self.http.get(url(version)).send().await.ok()?;
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
        parse(std::str::from_utf8(&body).ok()?)
    }
}

const UNREADABLE: &str = "exchange rates couldn't be read";

/// The latest rates: kept a while, and the last ones read if a new read fails.
#[tauri::command]
pub async fn fx_latest(state: State<'_, FxState>) -> Result<FxDay, VenueError> {
    let mut cache = state.cache.lock().await;
    if let Some((at, day)) = &cache.latest {
        if at.elapsed() < FRESH_FOR {
            return Ok(day.clone());
        }
    }
    match state.fetch("latest").await {
        Some(rates) => {
            let day = FxDay {
                date: "latest".into(),
                rates,
            };
            cache.latest = Some((Instant::now(), day.clone()));
            Ok(day)
        }
        None => cache
            .latest
            .as_ref()
            .map(|(_, day)| day.clone())
            .ok_or_else(|| VenueError::Network(UNREADABLE.into())),
    }
}

/// These dates' rates. A date the feed doesn't have is left out.
#[tauri::command]
pub async fn fx_history(
    state: State<'_, FxState>,
    dates: Vec<String>,
) -> Result<Vec<FxDay>, VenueError> {
    if dates.len() > MAX_DATES || !dates.iter().all(|d| valid_date(d)) {
        return Err(VenueError::Network("those dates can't be read".into()));
    }
    let mut cache = state.cache.lock().await;
    let mut out = Vec::with_capacity(dates.len());
    for date in dates {
        if !cache.days.contains_key(&date) {
            let Some(rates) = state.fetch(&date).await else {
                continue;
            };
            if cache.days.len() >= MAX_DAYS {
                cache.days.clear();
            }
            cache.days.insert(date.clone(), rates);
        }
        if let Some(rates) = cache.days.get(&date) {
            out.push(FxDay {
                date,
                rates: rates.clone(),
            });
        }
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keeps_only_the_listed_currencies_with_real_rates() {
        let rates = parse(
            r#"{"date":"2026-10-30","usd":{"ngn":1346.9,"eur":0.89,"btc":0.00001,"xyz":3,
                "jpy":0,"gbp":"high","chf":-1}}"#,
        )
        .unwrap();
        assert_eq!(
            rates.keys().map(String::as_str).collect::<Vec<_>>(),
            ["EUR", "NGN"]
        );
        assert_eq!(rates["NGN"], 1346.9);
    }

    #[test]
    fn an_export_with_nothing_usable_is_no_rates() {
        assert_eq!(parse(r#"{"usd":{"xyz":3}}"#), None);
        assert_eq!(parse("<html>"), None);
    }

    #[test]
    fn only_a_plain_date_reaches_a_url() {
        assert!(valid_date("2025-01-15"));
        for bad in [
            "latest",
            "2023-12-31",
            "2025-13-01",
            "2025-01-32",
            "2025-1-15",
            "../../etc",
            "2025-01-15/../x",
            "2025-01-1५",
        ] {
            assert!(!valid_date(bad), "{bad}");
        }
    }

    #[test]
    fn every_request_is_to_the_one_host() {
        assert_eq!(
            url("2025-01-15"),
            "https://cdn.jsdelivr.net/npm/@fawazahmed0/currency-api@2025-01-15/v1/currencies/usd.min.json"
        );
    }

    #[test]
    fn naira_is_on_the_list() {
        assert!(CURRENCIES.contains(&"NGN"));
    }
}
