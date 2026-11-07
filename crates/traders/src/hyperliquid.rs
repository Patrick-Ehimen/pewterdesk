//! Hyperliquid's traders, from public data.
//!
//! - The leaderboard is the file Hyperliquid's own web app reads
//!   (`stats-data.hyperliquid.xyz/Mainnet/leaderboard`). It isn't part of the
//!   documented API and can change; it's every account at once (some 40 MB,
//!   served without compression), so it's read at most every 10 minutes and
//!   only the top few hundred rows ever leave this module.
//! - A trader's positions, PnL history and fills come from the documented
//!   info API (`api.hyperliquid.xyz/info`: `clearinghouseState`, weight 2;
//!   `portfolio` and `userFills`, weight 20 and up), inside its 1200 a minute.
//!
//! Perpetuals on Hyperliquid's own exchange only: builder-deployed ones and
//! spot are left out.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde::Deserialize;

use crate::stats::{best_step_share, max_drawdown, weeks_from_cumulative, win_share, TraderStats};
use crate::{
    body, client, now_ms, num, plain, ClosedTrade, Holding, Period, PositionSide, SortBy, Source,
    TraderDetail, TraderRow, VenueError,
};

const INFO: &str = "https://api.hyperliquid.xyz/info";
const LEADERBOARD: &str = "https://stats-data.hyperliquid.xyz/Mainnet/leaderboard";
const WHO: &str = "Hyperliquid";
/// The leaderboard file is about 40 MB; past this something is wrong.
const LEADERBOARD_CAP: usize = 128 * 1024 * 1024;
const INFO_CAP: usize = 8 * 1024 * 1024;
/// How long the leaderboard is kept before it's read again.
const BOARD_FRESH_FOR: Duration = Duration::from_secs(10 * 60);
/// Time between info requests per unit of the last one's weight: about 860
/// weight a minute, inside Hyperliquid's 1200 per IP with room for the rest
/// of the app's requests.
const PER_WEIGHT: Duration = Duration::from_millis(70);
/// The most rows a leaderboard read returns.
pub const MAX_ROWS: usize = 500;
/// Closed trades kept on a trader's page.
const MAX_CLOSED: usize = 100;

/// Whether `s` is an address: `0x` and 40 hex digits.
pub fn is_address(s: &str) -> bool {
    s.len() == 42 && s.starts_with("0x") && s[2..].bytes().all(|b| b.is_ascii_hexdigit())
}

#[derive(Clone, Copy, Default)]
struct Perf {
    pnl: f64,
    roi: f64,
    vlm: f64,
}

/// One leaderboard row, as kept in memory.
struct Entry {
    address: String,
    name: Option<String>,
    account_value: f64,
    /// Day, week, month, all time.
    perf: [Perf; 4],
}

#[derive(Deserialize)]
struct RawBoard {
    #[serde(rename = "leaderboardRows")]
    rows: Vec<RawRow>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawRow {
    eth_address: String,
    #[serde(default)]
    account_value: String,
    #[serde(default)]
    window_performances: Vec<(String, RawPerf)>,
    #[serde(default)]
    display_name: Option<String>,
}

#[derive(Deserialize)]
struct RawPerf {
    #[serde(default)]
    pnl: String,
    #[serde(default)]
    roi: String,
    #[serde(default)]
    vlm: String,
}

fn window(name: &str) -> Option<usize> {
    match name {
        "day" => Some(0),
        "week" => Some(1),
        "month" => Some(2),
        "allTime" => Some(3),
        _ => None,
    }
}

fn index(period: Period) -> usize {
    match period {
        Period::Day => 0,
        Period::Week => 1,
        Period::Month => 2,
        Period::AllTime => 3,
    }
}

/// The rows that can be read; one with a bad address or account value is dropped.
fn entries(raw: RawBoard) -> Vec<Entry> {
    raw.rows
        .into_iter()
        .filter_map(|r| {
            let address = r.eth_address.to_ascii_lowercase();
            if !is_address(&address) {
                return None;
            }
            let mut perf = [Perf::default(); 4];
            for (name, p) in &r.window_performances {
                if let Some(i) = window(name) {
                    perf[i] = Perf {
                        pnl: num(&p.pnl).unwrap_or(0.0),
                        roi: num(&p.roi).unwrap_or(0.0),
                        vlm: num(&p.vlm).unwrap_or(0.0),
                    };
                }
            }
            Some(Entry {
                address,
                name: r
                    .display_name
                    .map(|n| plain(&n, 40))
                    .filter(|n| !n.is_empty()),
                account_value: num(&r.account_value)?,
                perf,
            })
        })
        .collect()
}

fn row(e: &Entry, period: Period) -> TraderRow {
    let p = e.perf[index(period)];
    TraderRow {
        source: Source::Hyperliquid,
        id: e.address.clone(),
        name: e.name.clone(),
        account_value: e.account_value,
        pnl: p.pnl,
        roi: p.roi,
        volume: Some(p.vlm),
        win_rate: None,
        copiers: None,
        lead_days: None,
        positive: Some(e.perf.map(|p| p.pnl > 0.0)),
        roi_curve: Vec::new(),
    }
}

/// The top `limit` rows by `sort` over `period`, among accounts worth at
/// least `min_account`.
fn rank(
    board: &[Entry],
    period: Period,
    sort: SortBy,
    min_account: f64,
    limit: usize,
) -> Vec<TraderRow> {
    let i = index(period);
    let key = |e: &Entry| match sort {
        SortBy::Roi => e.perf[i].roi,
        SortBy::AccountValue => e.account_value,
        SortBy::Volume => e.perf[i].vlm,
        SortBy::Pnl | SortBy::WinRate => e.perf[i].pnl,
    };
    let mut kept: Vec<&Entry> = board
        .iter()
        .filter(|e| e.account_value >= min_account)
        .collect();
    kept.sort_by(|a, b| key(b).total_cmp(&key(a)));
    kept.into_iter()
        .take(limit.min(MAX_ROWS))
        .map(|e| row(e, period))
        .collect()
}

/// `clearinghouseState`'s parts this reads.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct State {
    margin_summary: Summary,
    #[serde(default)]
    asset_positions: Vec<AssetPosition>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Summary {
    account_value: String,
}

#[derive(Deserialize)]
struct AssetPosition {
    position: RawPosition,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawPosition {
    coin: String,
    szi: String,
    #[serde(default)]
    entry_px: Option<String>,
    #[serde(default)]
    position_value: String,
    #[serde(default)]
    unrealized_pnl: String,
    #[serde(default)]
    liquidation_px: Option<String>,
    #[serde(default)]
    leverage: Option<Leverage>,
}

#[derive(Deserialize)]
struct Leverage {
    value: f64,
}

/// A market name that's one of Hyperliquid's own perpetuals: letters and digits.
fn perp_coin(coin: &str) -> bool {
    !coin.is_empty() && coin.len() <= 20 && coin.bytes().all(|b| b.is_ascii_alphanumeric())
}

fn holding(p: &RawPosition) -> Option<Holding> {
    if !perp_coin(&p.coin) {
        return None;
    }
    let signed = num(&p.szi).filter(|s| *s != 0.0)?;
    let size = signed.abs();
    let value = num(&p.position_value).unwrap_or(0.0).abs();
    Some(Holding {
        market: p.coin.clone(),
        side: if signed < 0.0 {
            PositionSide::Short
        } else {
            PositionSide::Long
        },
        size,
        entry: p.entry_px.as_deref().and_then(num).unwrap_or(0.0),
        mark: (value > 0.0).then(|| value / size),
        value,
        leverage: p
            .leverage
            .as_ref()
            .map(|l| l.value)
            .filter(|v| v.is_finite() && *v > 0.0),
        unrealized: num(&p.unrealized_pnl).unwrap_or(0.0),
        liquidation: p
            .liquidation_px
            .as_deref()
            .and_then(num)
            .filter(|v| *v > 0.0),
        opened_at: None,
    })
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Fill {
    coin: String,
    px: String,
    sz: String,
    time: u64,
    #[serde(default)]
    dir: String,
    #[serde(default)]
    closed_pnl: String,
    oid: u64,
}

/// The side a fill closed, if it closed one: "Close Long", or "Long > Short" (a flip).
fn closed_side(dir: &str) -> Option<PositionSide> {
    match dir {
        "Close Long" | "Long > Short" => Some(PositionSide::Long),
        "Close Short" | "Short > Long" => Some(PositionSide::Short),
        _ => None,
    }
}

/// Closing fills, one trade per closing order, newest first.
fn closed_trades(fills: &[Fill]) -> Vec<ClosedTrade> {
    // (market, side) by order: size, price times size, pnl, latest time.
    let mut by_order: HashMap<u64, (String, PositionSide, f64, f64, f64, u64)> = HashMap::new();
    for f in fills {
        let (Some(side), true) = (closed_side(&f.dir), perp_coin(&f.coin)) else {
            continue;
        };
        let (Some(px), Some(sz)) = (num(&f.px), num(&f.sz)) else {
            continue;
        };
        let e = by_order
            .entry(f.oid)
            .or_insert_with(|| (f.coin.clone(), side, 0.0, 0.0, 0.0, 0));
        e.2 += sz;
        e.3 += px * sz;
        e.4 += num(&f.closed_pnl).unwrap_or(0.0);
        e.5 = e.5.max(f.time);
    }
    let mut out: Vec<ClosedTrade> = by_order
        .into_values()
        .filter(|e| e.2 > 0.0)
        .map(|(market, side, size, notional, pnl, time)| ClosedTrade {
            market,
            side,
            size,
            price: notional / size,
            pnl,
            time,
            opened_at: None,
        })
        .collect();
    out.sort_by_key(|t| std::cmp::Reverse(t.time));
    out.truncate(MAX_CLOSED);
    out
}

pub(crate) fn win_rate(closed: &[ClosedTrade]) -> Option<f64> {
    (!closed.is_empty())
        .then(|| closed.iter().filter(|t| t.pnl > 0.0).count() as f64 / closed.len() as f64)
}

/// The portfolio window for a period, perpetuals only.
fn portfolio_key(period: Period) -> &'static str {
    match period {
        Period::Day => "perpDay",
        Period::Week => "perpWeek",
        Period::Month => "perpMonth",
        Period::AllTime => "perpAllTime",
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Window {
    #[serde(default)]
    pnl_history: Vec<(u64, String)>,
    #[serde(default)]
    account_value_history: Vec<(u64, String)>,
}

fn points(raw: &[(u64, String)]) -> Vec<(u64, f64)> {
    raw.iter()
        .filter_map(|(t, v)| Some((*t, num(v)?)))
        .collect()
}

/// A request's weight, by Hyperliquid's docs: 2 for `clearinghouseState`, 20
/// for most others, and `userFills` 20 more per 20 fills (up to 2,000 here).
fn weight(request: &serde_json::Value) -> u32 {
    match request["type"].as_str() {
        Some("clearinghouseState") => 2,
        Some("userFills") => 60,
        _ => 20,
    }
}

/// The record from a portfolio: weeks from all time's PnL (about a point a
/// week), the rest from the month's (about one a day).
fn stats_from(portfolio: &[(String, Window)], now: u64) -> TraderStats {
    let window = |k: &str| portfolio.iter().find(|(n, _)| n == k).map(|(_, w)| w);
    let all = window("perpAllTime").map_or_else(Vec::new, |w| points(&w.pnl_history));
    let (month, account) = window("perpMonth").map_or_else(Default::default, |w| {
        (points(&w.pnl_history), points(&w.account_value_history))
    });
    // What they had at `t`: the account's value then (or its first).
    let base = |t: u64| {
        account
            .iter()
            .take_while(|(at, _)| *at <= t)
            .last()
            .or(account.first())
            .map_or(0.0, |(_, v)| *v)
    };
    TraderStats {
        weeks: weeks_from_cumulative(&all, now),
        max_drawdown: max_drawdown(&month, base),
        best_day_share: best_step_share(&month),
        win_days: win_share(&month),
        curve: month,
    }
}

fn pnl_history(portfolio: Vec<(String, Window)>, period: Period) -> Vec<(u64, f64)> {
    let key = portfolio_key(period);
    portfolio
        .into_iter()
        .find(|(name, _)| name == key)
        .map(|(_, w)| {
            w.pnl_history
                .into_iter()
                .filter_map(|(t, v)| Some((t, num(&v)?)))
                .collect()
        })
        .unwrap_or_default()
}

type Board = (Instant, Arc<Vec<Entry>>);

pub struct Hyperliquid {
    http: reqwest::Client,
    board: Mutex<Option<Board>>,
    /// Held while the leaderboard is being read, so it's read once at a time.
    reading: tokio::sync::Mutex<()>,
    next: tokio::sync::Mutex<Instant>,
}

impl Hyperliquid {
    pub fn new() -> Result<Self, VenueError> {
        Ok(Self {
            http: client()?,
            board: Mutex::new(None),
            reading: tokio::sync::Mutex::new(()),
            next: tokio::sync::Mutex::new(Instant::now()),
        })
    }

    fn fresh_board(&self) -> Option<Arc<Vec<Entry>>> {
        let held = self.board.lock().unwrap();
        held.as_ref()
            .filter(|(at, _)| at.elapsed() < BOARD_FRESH_FOR)
            .map(|(_, b)| Arc::clone(b))
    }

    /// Every account on the leaderboard, from memory while fresh.
    async fn board(&self) -> Result<Arc<Vec<Entry>>, VenueError> {
        if let Some(board) = self.fresh_board() {
            return Ok(board);
        }
        let _reading = self.reading.lock().await;
        // Another caller may have read it while this one waited.
        if let Some(board) = self.fresh_board() {
            return Ok(board);
        }
        let response = self
            .http
            .get(LEADERBOARD)
            .send()
            .await
            .map_err(|e| VenueError::Network(e.without_url().to_string()))?;
        let bytes = body(response, LEADERBOARD_CAP, WHO).await?;
        let parsed = tokio::task::spawn_blocking(move || {
            serde_json::from_slice::<RawBoard>(&bytes).map(entries)
        })
        .await
        .map_err(|e| VenueError::Network(e.to_string()))?
        .map_err(|e| VenueError::Network(format!("unexpected leaderboard from {WHO}: {e}")))?;
        if parsed.is_empty() {
            return Err(VenueError::Network(format!(
                "{WHO}'s leaderboard was empty"
            )));
        }
        let board = Arc::new(parsed);
        *self.board.lock().unwrap() = Some((Instant::now(), Arc::clone(&board)));
        Ok(board)
    }

    /// The leaderboard: the top `limit` (at most [`MAX_ROWS`]) by `sort` over
    /// `period`, among accounts worth at least `min_account` USD.
    pub async fn leaderboard(
        &self,
        period: Period,
        sort: SortBy,
        min_account: f64,
        limit: usize,
    ) -> Result<Vec<TraderRow>, VenueError> {
        let board = self.board().await?;
        Ok(rank(&board, period, sort, min_account.max(0.0), limit))
    }

    /// `address`'s line on the leaderboard, if it's on it.
    pub async fn row(
        &self,
        address: &str,
        period: Period,
    ) -> Result<Option<TraderRow>, VenueError> {
        let board = self.board().await?;
        Ok(board
            .iter()
            .find(|e| e.address == address)
            .map(|e| row(e, period)))
    }

    async fn info<T: serde::de::DeserializeOwned>(
        &self,
        request: serde_json::Value,
    ) -> Result<T, VenueError> {
        {
            let mut next = self.next.lock().await;
            tokio::time::sleep_until((*next).into()).await;
            *next = Instant::now() + PER_WEIGHT * weight(&request);
        }
        let response = self
            .http
            .post(INFO)
            .header("content-type", "application/json")
            .body(request.to_string())
            .send()
            .await
            .map_err(|e| VenueError::Network(e.without_url().to_string()))?;
        let bytes = body(response, INFO_CAP, WHO).await?;
        serde_json::from_slice(&bytes)
            .map_err(|e| VenueError::Network(format!("unexpected answer from {WHO}: {e}")))
    }

    fn checked(address: &str) -> Result<String, VenueError> {
        let address = address.to_ascii_lowercase();
        if is_address(&address) {
            Ok(address)
        } else {
            Err(VenueError::InvalidRequest(
                "that isn't a Hyperliquid address".into(),
            ))
        }
    }

    /// What `address` holds now, and its account value.
    pub async fn holdings(&self, address: &str) -> Result<(f64, Vec<Holding>), VenueError> {
        let user = Self::checked(address)?;
        let state: State = self
            .info(serde_json::json!({ "type": "clearinghouseState", "user": user }))
            .await?;
        let holdings = state
            .asset_positions
            .iter()
            .filter_map(|p| holding(&p.position))
            .collect();
        Ok((
            num(&state.margin_summary.account_value).unwrap_or(0.0),
            holdings,
        ))
    }

    /// `address`'s record for the leaderboard: green weeks, max drawdown,
    /// the month's PnL line. One `portfolio` request (weight 20).
    pub async fn stats(&self, address: &str) -> Result<TraderStats, VenueError> {
        let user = Self::checked(address)?;
        let portfolio: Vec<(String, Window)> = self
            .info(serde_json::json!({ "type": "portfolio", "user": user }))
            .await?;
        Ok(stats_from(&portfolio, now_ms()))
    }

    /// `address`'s page: holdings, closed trades, and PnL over `period`.
    pub async fn detail(&self, address: &str, period: Period) -> Result<TraderDetail, VenueError> {
        let user = Self::checked(address)?;
        let (account_value, holdings) = self.holdings(&user).await?;
        let portfolio: Vec<(String, Window)> = self
            .info(serde_json::json!({ "type": "portfolio", "user": user }))
            .await?;
        let fills: Vec<Fill> = self
            .info(serde_json::json!({ "type": "userFills", "user": user }))
            .await?;
        let closed = closed_trades(&fills);
        let mut preferred: HashMap<&str, f64> = HashMap::new();
        for t in &closed {
            *preferred.entry(t.market.as_str()).or_default() += t.size * t.price;
        }
        let total: f64 = preferred.values().sum();
        let mut preferred: Vec<(String, f64)> = preferred
            .into_iter()
            .filter(|_| total > 0.0)
            .map(|(m, v)| (m.to_owned(), v / total))
            .collect();
        preferred.sort_by(|a, b| b.1.total_cmp(&a.1));
        preferred.truncate(6);
        Ok(TraderDetail {
            source: Source::Hyperliquid,
            id: user,
            account_value,
            holdings,
            win_rate: win_rate(&closed),
            closed,
            pnl_history: pnl_history(portfolio, period),
            weekly_pnl: Vec::new(),
            preferred,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const A: &str = "0xf5d81a135f756ca16544e53c20fc20643ec3ad53";

    #[test]
    fn addresses_are_checked() {
        assert!(is_address(A));
        for bad in [
            "",
            "0x",
            "f5d81a135f756ca16544e53c20fc20643ec3ad5300",
            "0xg5d81a135f756ca16544e53c20fc20643ec3ad53",
            "0xf5d81a135f756ca16544e53c20fc20643ec3ad5",
        ] {
            assert!(!is_address(bad), "{bad}");
        }
    }

    fn board() -> Vec<Entry> {
        let raw: RawBoard = serde_json::from_value(serde_json::json!({ "leaderboardRows": [
            { "ethAddress": A.to_uppercase().replacen("0X", "0x", 1), "accountValue": "2000000",
              "windowPerformances": [
                ["day", { "pnl": "-5", "roi": "-0.01", "vlm": "10" }],
                ["week", { "pnl": "100", "roi": "0.05", "vlm": "20" }],
                ["month", { "pnl": "900", "roi": "0.40", "vlm": "30" }],
                ["allTime", { "pnl": "5000", "roi": "1.2", "vlm": "40" }]],
              "prize": 0, "displayName": "Glacier\n" },
            { "ethAddress": "0x0000000000000000000000000000000000000002", "accountValue": "50000",
              "windowPerformances": [["month", { "pnl": "99999", "roi": "9.0", "vlm": "1" }]],
              "displayName": null },
            { "ethAddress": "0x0000000000000000000000000000000000000003", "accountValue": "9000000",
              "windowPerformances": [["month", { "pnl": "400", "roi": "0.01", "vlm": "500" }]] },
            { "ethAddress": "not an address", "accountValue": "1", "windowPerformances": [] }
        ]}))
        .unwrap();
        entries(raw)
    }

    #[test]
    fn reads_the_board_and_drops_bad_rows() {
        let b = board();
        assert_eq!(b.len(), 3);
        assert_eq!(b[0].address, A);
        assert_eq!(b[0].name.as_deref(), Some("Glacier"));
    }

    #[test]
    fn ranks_by_period_and_sort_above_the_floor() {
        let b = board();
        let by_pnl = rank(&b, Period::Month, SortBy::Pnl, 100_000.0, 10);
        // The 50k account is under the floor, whatever its PnL.
        assert_eq!(
            by_pnl.iter().map(|r| r.pnl).collect::<Vec<_>>(),
            [900.0, 400.0]
        );
        assert_eq!(by_pnl[0].positive, Some([false, true, true, true]));
        let by_size = rank(&b, Period::Month, SortBy::AccountValue, 0.0, 2);
        assert_eq!(by_size[0].account_value, 9_000_000.0);
        assert_eq!(by_size.len(), 2);
        let by_volume = rank(&b, Period::Month, SortBy::Volume, 0.0, 1);
        assert_eq!(by_volume[0].volume, Some(500.0));
    }

    #[test]
    fn reads_positions() {
        let state: State = serde_json::from_value(serde_json::json!({
            "marginSummary": { "accountValue": "2041429.9" },
            "assetPositions": [
              { "type": "oneWay", "position": { "coin": "BTC", "szi": "-5.12656",
                "leverage": { "type": "cross", "value": 3 }, "entryPx": "75950.0",
                "positionValue": "389367.35856", "unrealizedPnl": "-5.11",
                "liquidationPx": "467205.69", "marginUsed": "1", "maxLeverage": 40 } },
              { "type": "oneWay", "position": { "coin": "xyz:TSLA", "szi": "2", "entryPx": "1",
                "positionValue": "2", "unrealizedPnl": "0", "liquidationPx": null } },
              { "type": "oneWay", "position": { "coin": "ETH", "szi": "0.0", "entryPx": null,
                "positionValue": "0", "unrealizedPnl": "0", "liquidationPx": null } }
            ]
        }))
        .unwrap();
        let h: Vec<Holding> = state
            .asset_positions
            .iter()
            .filter_map(|p| holding(&p.position))
            .collect();
        assert_eq!(h.len(), 1);
        assert_eq!(
            (h[0].market.as_str(), h[0].side),
            ("BTC", PositionSide::Short)
        );
        assert!((h[0].mark.unwrap() - 389367.35856 / 5.12656).abs() < 1e-6);
        assert_eq!(h[0].leverage, Some(3.0));
    }

    #[test]
    fn one_closing_order_is_one_trade() {
        let fills: Vec<Fill> = serde_json::from_value(serde_json::json!([
            { "coin": "BTC", "px": "76000", "sz": "1", "time": 10, "dir": "Close Short", "closedPnl": "100", "oid": 7 },
            { "coin": "BTC", "px": "76100", "sz": "1", "time": 12, "dir": "Close Short", "closedPnl": "50", "oid": 7 },
            { "coin": "ETH", "px": "2400", "sz": "3", "time": 20, "dir": "Long > Short", "closedPnl": "-30", "oid": 8 },
            { "coin": "ETH", "px": "2400", "sz": "3", "time": 5, "dir": "Open Long", "closedPnl": "0", "oid": 6 },
            { "coin": "@107", "px": "1", "sz": "1", "time": 30, "dir": "Sell", "closedPnl": "5", "oid": 9 }
        ]))
        .unwrap();
        let closed = closed_trades(&fills);
        assert_eq!(closed.len(), 2);
        assert_eq!(
            (closed[0].market.as_str(), closed[0].side, closed[0].pnl),
            ("ETH", PositionSide::Long, -30.0)
        );
        assert_eq!(
            (
                closed[1].size,
                closed[1].price,
                closed[1].pnl,
                closed[1].time
            ),
            (2.0, 76050.0, 150.0, 12)
        );
        assert_eq!(win_rate(&closed), Some(0.5));
        assert_eq!(win_rate(&[]), None);
    }

    #[test]
    fn a_record_from_the_portfolio() {
        let week = 7 * 86_400_000_u64;
        let now = 20 * week;
        let all: Vec<serde_json::Value> = (0..=10)
            .map(|i| serde_json::json!([now - (10 - i) * week, format!("{}", i * 100)]))
            .collect();
        let portfolio: Vec<(String, Window)> = serde_json::from_value(serde_json::json!([
            ["perpAllTime", { "pnlHistory": all, "accountValueHistory": [] }],
            ["perpMonth", {
                "pnlHistory": [[1, "0"], [2, "500"], [3, "300"], [4, "700"]],
                "accountValueHistory": [[1, "10000"], [2, "10500"], [3, "10300"], [4, "10700"]]
            }]
        ]))
        .unwrap();
        let s = stats_from(&portfolio, now);
        assert_eq!(s.weeks.len(), crate::stats::WEEKS);
        assert!(s.weeks.iter().all(|w| *w == Some(100.0)));
        // From 500 down to 300, against the 10,500 they had at the top.
        assert!((s.max_drawdown.unwrap() - 200.0 / 10_500.0).abs() < 1e-12);
        assert!((s.best_day_share.unwrap() - 500.0 / 700.0).abs() < 1e-12);
        assert_eq!(s.curve.len(), 4);
        assert_eq!(
            weight(&serde_json::json!({ "type": "clearinghouseState" })),
            2
        );
        assert_eq!(weight(&serde_json::json!({ "type": "portfolio" })), 20);
    }

    #[test]
    fn reads_the_perp_pnl_history_for_the_period() {
        let portfolio: Vec<(String, Window)> = serde_json::from_value(serde_json::json!([
            ["month", { "accountValueHistory": [], "pnlHistory": [[1, "5"]], "vlm": "0" }],
            ["perpMonth", { "accountValueHistory": [], "pnlHistory": [[1, "0.0"], [2, "16903.39"], [3, "x"]], "vlm": "0" }]
        ]))
        .unwrap();
        assert_eq!(
            pnl_history(portfolio, Period::Month),
            [(1, 0.0), (2, 16903.39)]
        );
    }
}
