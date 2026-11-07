//! Top traders: who trades best on Hyperliquid and among OKX's copy-trading
//! lead traders, what they hold now, and what changed between two looks.
//!
//! Read-only and keyless. Nothing here signs, holds a key, or reaches an
//! account of the trader's own: every request is a public read, to a fixed
//! host (`api.hyperliquid.xyz`, `stats-data.hyperliquid.xyz`, `www.okx.com`),
//! with no redirects followed and every body size-capped. A trader is named
//! by an id checked before any request is built (a Hyperliquid address, an
//! OKX lead trader's code), so nothing from the page reaches a URL.
//!
//! Shared by the desktop app and the watch server (ADR 0005), so both detect
//! a trade the same way ([`changes`]).

use std::time::{Duration, SystemTime, UNIX_EPOCH};

pub use pewterdesk_core::{PositionSide, VenueError};
use serde::{Deserialize, Serialize};

mod events;
pub mod hyperliquid;
pub mod okx;

pub use events::{changes, Change, ChangeKind};

const USER_AGENT: &str = concat!("pewterdesk/", env!("CARGO_PKG_VERSION"));
const TIMEOUT: Duration = Duration::from_secs(30);

/// Where a trader trades.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Source {
    Hyperliquid,
    Okx,
}

/// The window a leaderboard ranks over. OKX ranks over the whole time a
/// trader has led, so it takes none.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Period {
    Day,
    Week,
    Month,
    AllTime,
}

/// What a leaderboard is sorted by, highest first.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum SortBy {
    Pnl,
    Roi,
    AccountValue,
    /// Hyperliquid: volume traded. OKX: win rate.
    Volume,
    WinRate,
}

/// One trader's line on a leaderboard.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TraderRow {
    pub source: Source,
    /// A Hyperliquid address (lowercase) or an OKX lead trader's code.
    pub id: String,
    /// The name they gave themselves, if any (bounded, plain text).
    pub name: Option<String>,
    /// In USD (USDT on OKX).
    pub account_value: f64,
    /// Over the period asked for (OKX: since they started leading).
    pub pnl: f64,
    /// A fraction: 0.25 is +25%.
    pub roi: f64,
    /// Hyperliquid only: volume traded over the period.
    pub volume: Option<f64>,
    /// OKX only: a fraction of their trades that made money.
    pub win_rate: Option<f64>,
    /// OKX only: people copying them now.
    pub copiers: Option<u32>,
    /// OKX only: days they've led.
    pub lead_days: Option<u32>,
    /// Hyperliquid only: whether the day's, week's, month's and all time's
    /// PnL were each above zero, in that order.
    pub positive: Option<[bool; 4]>,
    /// OKX only: the markets they trade (base coins, at most 8).
    pub markets: Vec<String>,
    /// OKX only: their ROI day by day, oldest first (a fraction).
    pub roi_curve: Vec<f64>,
}

/// One position a trader holds.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Holding {
    /// The base coin: "BTC", "ETH", or on a Hyperliquid builder exchange "xyz:TSLA".
    pub market: String,
    pub side: PositionSide,
    /// In base units, always positive.
    pub size: f64,
    pub entry: f64,
    /// The price it's valued at now, where the source says.
    pub mark: Option<f64>,
    /// Its notional value in USD.
    pub value: f64,
    pub leverage: Option<f64>,
    pub unrealized: f64,
    pub liquidation: Option<f64>,
    /// Milliseconds since the epoch, where the source says (OKX does).
    pub opened_at: Option<u64>,
}

/// A trade they finished: a closing order on Hyperliquid, a closed position on OKX.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClosedTrade {
    pub market: String,
    /// The side of the position that was closed.
    pub side: PositionSide,
    pub size: f64,
    pub price: f64,
    pub pnl: f64,
    /// When it closed, ms since the epoch.
    pub time: u64,
    /// When it opened, where the source says (OKX does).
    pub opened_at: Option<u64>,
}

/// A trader's page: what they hold, what they did, how their PnL went.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TraderDetail {
    pub source: Source,
    pub id: String,
    pub account_value: f64,
    pub holdings: Vec<Holding>,
    /// Newest first.
    pub closed: Vec<ClosedTrade>,
    /// Cumulative PnL over the period asked for: (ms since the epoch, USD), oldest first.
    pub pnl_history: Vec<(u64, f64)>,
    /// A fraction of `closed` that made money; `None` with nothing closed.
    pub win_rate: Option<f64>,
    /// Week by week PnL, oldest first, where the source keeps it (OKX does).
    pub weekly_pnl: Vec<(u64, f64)>,
    /// What they trade most: (base coin, share), largest first.
    pub preferred: Vec<(String, f64)>,
}

/// An HTTP client for one fixed host: no redirects, a timeout, gzip.
fn client() -> Result<reqwest::Client, VenueError> {
    reqwest::Client::builder()
        .timeout(TIMEOUT)
        .user_agent(USER_AGENT)
        .gzip(true)
        // Never sent anywhere but the host asked for.
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|e| VenueError::Network(e.to_string()))
}

/// A response's body, refused past `cap` bytes before it's all in memory.
async fn body(
    mut response: reqwest::Response,
    cap: usize,
    who: &str,
) -> Result<Vec<u8>, VenueError> {
    let status = response.status().as_u16();
    if status == 429 {
        return Err(VenueError::Network(format!(
            "{who}'s rate limit was reached; it will be tried again"
        )));
    }
    if status != 200 {
        return Err(VenueError::Network(format!("{who} returned {status}")));
    }
    if response.content_length().is_some_and(|n| n as usize > cap) {
        return Err(VenueError::Network(format!("{who}'s answer was too large")));
    }
    let mut out = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|e| VenueError::Network(e.without_url().to_string()))?
    {
        if out.len() + chunk.len() > cap {
            return Err(VenueError::Network(format!("{who}'s answer was too large")));
        }
        out.extend_from_slice(&chunk);
    }
    Ok(out)
}

/// A number from the decimal string sources send, if it is one.
fn num(s: &str) -> Option<f64> {
    s.trim().parse::<f64>().ok().filter(|v| v.is_finite())
}

/// Plain text, at most `max` characters: control characters dropped, so a
/// name can't carry anything but words.
fn plain(s: &str, max: usize) -> String {
    s.chars()
        .filter(|c| !c.is_control())
        .take(max)
        .collect::<String>()
        .trim()
        .to_owned()
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| d.as_millis() as u64)
}

/// Whether `id` is a trader `source` can be asked about. Checked before
/// any request is built.
pub fn valid_id(source: Source, id: &str) -> bool {
    match source {
        Source::Hyperliquid => hyperliquid::is_address(id),
        Source::Okx => okx::is_code(id),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn names_are_plain_and_bounded() {
        assert_eq!(plain("  Glacier\u{0007}\n ", 40), "Glacier");
        assert_eq!(plain("abcdef", 3), "abc");
    }

    #[test]
    fn ids_are_checked_per_source() {
        assert!(valid_id(
            Source::Hyperliquid,
            "0xf5d81a135f756ca16544e53c20fc20643ec3ad53"
        ));
        assert!(!valid_id(
            Source::Okx,
            "0xf5d81a135f756ca16544e53c20fc20643ec3ad53"
        ));
        assert!(valid_id(Source::Okx, "9F25A5FBE6CFF912"));
        assert!(!valid_id(Source::Hyperliquid, "9F25A5FBE6CFF912"));
    }
}
