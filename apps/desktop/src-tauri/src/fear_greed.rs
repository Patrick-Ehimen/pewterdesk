//! The crypto Fear & Greed Index, for the Screener's market sentiment gauge:
//! Alternative.me's, the one Bybit shows. A data source, not a venue: no key,
//! nothing signed, one read-only GET to one fixed URL (`FEED`), no redirects
//! followed, a size cap, kept an hour (the index moves once a day).
//!
//! It reaches the UI as numbers only, a value from 0 to 100 and the day it's
//! for: the page names the band itself, so none of the feed's text is shown.

use std::time::{Duration, Instant};

use pewterdesk_core::VenueError;
use serde::{Deserialize, Serialize};
use tauri::State;

/// Today's reading and the 30 days before it, newest first.
const FEED: &str = "https://api.alternative.me/fng/?limit=31";
const TIMEOUT: Duration = Duration::from_secs(12);
const FRESH_FOR: Duration = Duration::from_secs(60 * 60);
/// A month of readings runs to some 3 KB.
const MAX_BYTES: usize = 32 * 1024;
const MAX_DAYS: usize = 31;

#[derive(Deserialize)]
struct Raw {
    data: Vec<RawDay>,
}

#[derive(Deserialize)]
struct RawDay {
    value: String,
    timestamp: String,
}

/// One day's reading: 0 is extreme fear, 100 extreme greed.
#[derive(Clone, Copy, Debug, PartialEq, Serialize)]
pub struct FearGreedDay {
    /// The day's start, in Unix seconds.
    pub time: i64,
    pub value: u8,
}

/// The readings that make sense, newest first; anything else is dropped.
fn parse(json: &str) -> Option<Vec<FearGreedDay>> {
    let raw: Raw = serde_json::from_str(json).ok()?;
    let mut days: Vec<FearGreedDay> = raw
        .data
        .iter()
        .filter_map(|day| {
            let value: u8 = day.value.trim().parse().ok()?;
            let time: i64 = day.timestamp.trim().parse().ok()?;
            (value <= 100 && time > 0).then_some(FearGreedDay { time, value })
        })
        .take(MAX_DAYS)
        .collect();
    days.sort_by_key(|day| std::cmp::Reverse(day.time));
    (!days.is_empty()).then_some(days)
}

pub struct FearGreedState {
    http: reqwest::Client,
    /// Held across a read, so two views don't both fetch.
    cache: tokio::sync::Mutex<Option<(Instant, Vec<FearGreedDay>)>>,
}

impl FearGreedState {
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
            cache: tokio::sync::Mutex::new(None),
        })
    }

    /// The feed, up to `MAX_BYTES` and no further.
    async fn fetch(&self) -> Option<Vec<FearGreedDay>> {
        let mut response = self.http.get(FEED).send().await.ok()?;
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

/// The index, newest first: kept a while, and the last read if a new one fails.
#[tauri::command]
pub async fn fear_greed(state: State<'_, FearGreedState>) -> Result<Vec<FearGreedDay>, VenueError> {
    let mut cache = state.cache.lock().await;
    if let Some((at, days)) = cache.as_ref() {
        if at.elapsed() < FRESH_FOR {
            return Ok(days.clone());
        }
    }
    match state.fetch().await {
        Some(days) => {
            *cache = Some((Instant::now(), days.clone()));
            Ok(days)
        }
        None => cache
            .as_ref()
            .map(|(_, days)| days.clone())
            .ok_or_else(|| VenueError::Network("the fear and greed index couldn't be read".into())),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_the_feed_newest_first() {
        let days = parse(
            r#"{"name":"Fear and Greed Index","data":[
                {"value":"37","value_classification":"Fear","timestamp":"1793577600"},
                {"value":"26","value_classification":"Fear","timestamp":"1793664000",
                 "time_until_update":"43965"}],"metadata":{"error":null}}"#,
        )
        .unwrap();
        assert_eq!(
            days,
            [
                FearGreedDay {
                    time: 1793664000,
                    value: 26
                },
                FearGreedDay {
                    time: 1793577600,
                    value: 37
                },
            ]
        );
    }

    #[test]
    fn drops_readings_that_make_no_sense() {
        let days = parse(
            r#"{"data":[{"value":"101","timestamp":"1"},{"value":"-3","timestamp":"2"},
                {"value":"fear","timestamp":"3"},{"value":"50","timestamp":"0"},
                {"value":"12","timestamp":"4"}]}"#,
        )
        .unwrap();
        assert_eq!(days, [FearGreedDay { time: 4, value: 12 }]);
    }

    #[test]
    fn a_feed_with_nothing_usable_is_no_index() {
        assert_eq!(parse(r#"{"data":[]}"#), None);
        assert_eq!(parse("<html>"), None);
    }

    #[test]
    fn every_request_is_to_the_one_host() {
        assert!(FEED.starts_with("https://api.alternative.me/"));
    }
}
