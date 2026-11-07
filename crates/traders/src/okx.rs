//! OKX's copy-trading lead traders, from its documented public endpoints
//! (`/api/v5/copytrading/public-*` on `www.okx.com`; keyless, 5 requests
//! per 2 seconds per IP, so requests here are spaced to fit). Lead traders
//! chose to be copied, so their positions are public on purpose.
//!
//! Sizes come in contracts; they're turned into base units with each swap's
//! contract size (`/api/v5/public/instruments`, read at most hourly).

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde::de::DeserializeOwned;
use serde::Deserialize;

use crate::stats::{best_step_share, max_drawdown, weeks_from_weekly, win_share, TraderStats};
use crate::{
    body, client, hyperliquid::win_rate, now_ms, num, plain, ClosedTrade, Holding, Period,
    PositionSide, SortBy, Source, TraderDetail, TraderRow, VenueError,
};

const BASE: &str = "https://www.okx.com";
const WHO: &str = "OKX";
const CAP: usize = 4 * 1024 * 1024;
/// 5 requests per 2 seconds, with room to spare.
const SPACING: Duration = Duration::from_millis(450);
const MARKETS_FRESH_FOR: Duration = Duration::from_secs(60 * 60);
/// OKX makes a new leaderboard every 10 minutes.
const BOARD_FRESH_FOR: Duration = Duration::from_secs(10 * 60);
/// The leaderboard's page size: OKX's most.
const PAGE: usize = 20;
/// The most rows a leaderboard read returns (10 pages, some 5 seconds).
pub const MAX_ROWS: usize = 200;
const MAX_CURVE: usize = 120;

/// Whether `s` is a lead trader's code: 16 or 18 letters and digits.
pub fn is_code(s: &str) -> bool {
    matches!(s.len(), 16 | 18) && s.bytes().all(|b| b.is_ascii_alphanumeric())
}

#[derive(Deserialize)]
struct Reply<T> {
    code: String,
    #[serde(default)]
    msg: String,
    #[serde(default = "Vec::new")]
    data: Vec<T>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Instrument {
    #[serde(default)]
    inst_id: String,
    #[serde(default)]
    ct_val: String,
    #[serde(default)]
    ct_mult: String,
    #[serde(default)]
    ct_type: String,
}

/// A swap's id ("BTC-USDT-SWAP") to its base coin and contract size.
fn contract_sizes(instruments: Vec<Instrument>) -> HashMap<String, (String, f64)> {
    instruments
        .into_iter()
        .filter(|i| i.ct_type == "linear")
        .filter_map(|i| {
            let base = base_of(&i.inst_id)?;
            let size = num(&i.ct_val)? * num(&i.ct_mult).unwrap_or(1.0);
            (size > 0.0).then_some((i.inst_id, (base, size)))
        })
        .collect()
}

/// "BTC-USDT-SWAP" -> "BTC".
fn base_of(inst_id: &str) -> Option<String> {
    let base = inst_id.split('-').next()?;
    (!base.is_empty() && base.len() <= 20 && base.bytes().all(|b| b.is_ascii_alphanumeric()))
        .then(|| base.to_owned())
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RankPage {
    #[serde(default)]
    data_ver: String,
    #[serde(default)]
    total_page: String,
    #[serde(default)]
    ranks: Vec<Rank>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Rank {
    unique_code: String,
    #[serde(default)]
    nick_name: String,
    #[serde(default)]
    aum: String,
    #[serde(default)]
    pnl: String,
    #[serde(default)]
    pnl_ratio: String,
    #[serde(default)]
    win_ratio: String,
    #[serde(default)]
    copy_trader_num: String,
    #[serde(default)]
    lead_days: String,
    #[serde(default)]
    pnl_ratios: Vec<Ratio>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Ratio {
    begin_ts: String,
    pnl_ratio: String,
}

fn rank_row(r: Rank) -> Option<TraderRow> {
    if !is_code(&r.unique_code) {
        return None;
    }
    let mut curve: Vec<(u64, f64)> = r
        .pnl_ratios
        .iter()
        .filter_map(|p| Some((p.begin_ts.parse().ok()?, num(&p.pnl_ratio)?)))
        .collect();
    curve.sort_by_key(|(t, _)| *t);
    let skip = curve.len().saturating_sub(MAX_CURVE);
    Some(TraderRow {
        source: Source::Okx,
        name: Some(plain(&r.nick_name, 40)).filter(|n| !n.is_empty()),
        account_value: num(&r.aum).unwrap_or(0.0),
        pnl: num(&r.pnl).unwrap_or(0.0),
        roi: num(&r.pnl_ratio).unwrap_or(0.0),
        volume: None,
        win_rate: num(&r.win_ratio),
        copiers: r.copy_trader_num.parse().ok(),
        lead_days: r.lead_days.parse().ok(),
        positive: None,
        roi_curve: curve.into_iter().skip(skip).map(|(_, v)| v).collect(),
        id: r.unique_code,
    })
}

fn sort_type(sort: SortBy) -> &'static str {
    match sort {
        SortBy::Pnl => "pnl",
        SortBy::Roi => "pnl_ratio",
        SortBy::AccountValue => "aum",
        SortBy::WinRate => "win_ratio",
        SortBy::Volume => "overview",
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SubPosition {
    inst_id: String,
    #[serde(default)]
    pos_side: String,
    #[serde(default)]
    sub_pos: String,
    #[serde(default)]
    open_avg_px: String,
    #[serde(default)]
    mark_px: String,
    #[serde(default)]
    lever: String,
    #[serde(default)]
    upl: String,
    #[serde(default)]
    open_time: String,
    // Closed ones only.
    #[serde(default)]
    close_avg_px: String,
    #[serde(default)]
    close_time: String,
    #[serde(default)]
    pnl: String,
}

/// The side, from `posSide`, or for one-way ("net") positions from the size's sign.
fn side(pos_side: &str, contracts: f64) -> Option<PositionSide> {
    match pos_side {
        "long" => Some(PositionSide::Long),
        "short" => Some(PositionSide::Short),
        "net" if contracts > 0.0 => Some(PositionSide::Long),
        "net" if contracts < 0.0 => Some(PositionSide::Short),
        _ => None,
    }
}

type Markets = HashMap<String, (String, f64)>;

fn holding(p: &SubPosition, markets: &Markets) -> Option<Holding> {
    let (base, contract) = markets.get(&p.inst_id)?;
    let contracts = num(&p.sub_pos).filter(|c| *c != 0.0)?;
    let size = contracts.abs() * contract;
    let entry = num(&p.open_avg_px)?;
    let mark = num(&p.mark_px).filter(|m| *m > 0.0);
    Some(Holding {
        market: base.clone(),
        side: side(&p.pos_side, contracts)?,
        size,
        entry,
        mark,
        value: size * mark.unwrap_or(entry),
        leverage: num(&p.lever).filter(|l| *l > 0.0),
        unrealized: num(&p.upl).unwrap_or(0.0),
        liquidation: None,
        opened_at: p.open_time.parse().ok(),
    })
}

fn closed(p: &SubPosition, markets: &Markets) -> Option<ClosedTrade> {
    let (base, contract) = markets.get(&p.inst_id)?;
    let contracts = num(&p.sub_pos).filter(|c| *c != 0.0)?;
    Some(ClosedTrade {
        market: base.clone(),
        side: side(&p.pos_side, contracts)?,
        size: contracts.abs() * contract,
        price: num(&p.close_avg_px)?,
        pnl: num(&p.pnl).unwrap_or(0.0),
        time: p.close_time.parse().ok()?,
        opened_at: p.open_time.parse().ok(),
    })
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PnlPoint {
    begin_ts: String,
    pnl: String,
    #[serde(default)]
    pnl_ratio: String,
}

/// The record from a month of daily PnL (cumulative, with its ratio) and the
/// weekly figures. Drawdown is on their equity: 1 plus the ratio.
fn stats_from(daily: Vec<PnlPoint>, weekly: Vec<PnlPoint>, now: u64) -> TraderStats {
    let mut ratio: Vec<(u64, f64)> = daily
        .iter()
        .filter_map(|p| Some((p.begin_ts.parse().ok()?, num(&p.pnl_ratio)?)))
        .collect();
    ratio.sort_by_key(|(t, _)| *t);
    let curve = points(daily);
    let equity = |t: u64| {
        1.0 + ratio
            .iter()
            .take_while(|(at, _)| *at <= t)
            .last()
            .map_or(0.0, |(_, r)| *r)
    };
    TraderStats {
        weeks: weeks_from_weekly(&points(weekly), now),
        max_drawdown: max_drawdown(&ratio, equity),
        best_day_share: best_step_share(&curve),
        win_days: win_share(&curve),
        curve,
    }
}

fn points(rows: Vec<PnlPoint>) -> Vec<(u64, f64)> {
    let mut out: Vec<(u64, f64)> = rows
        .into_iter()
        .filter_map(|p| Some((p.begin_ts.parse().ok()?, num(&p.pnl)?)))
        .collect();
    out.sort_by_key(|(t, _)| *t);
    out
}

#[derive(Deserialize)]
struct Preference {
    ccy: String,
    ratio: String,
}

/// OKX's `lastDays` for a period: 7, 30 or 365 days.
fn last_days(period: Period) -> &'static str {
    match period {
        Period::Day | Period::Week => "1",
        Period::Month => "2",
        Period::AllTime => "4",
    }
}

type Board = (Instant, Arc<Vec<TraderRow>>);

pub struct Okx {
    http: reqwest::Client,
    markets: Mutex<Option<(Instant, Arc<Markets>)>>,
    boards: Mutex<HashMap<SortBy, Board>>,
    next: tokio::sync::Mutex<Instant>,
}

impl Okx {
    pub fn new() -> Result<Self, VenueError> {
        Ok(Self {
            http: client()?,
            markets: Mutex::new(None),
            boards: Mutex::new(HashMap::new()),
            next: tokio::sync::Mutex::new(Instant::now()),
        })
    }

    /// A GET of `path` with `query`, whose values are fixed or checked.
    async fn get<T: DeserializeOwned>(
        &self,
        path: &str,
        query: &[(&str, &str)],
    ) -> Result<Vec<T>, VenueError> {
        debug_assert!(query
            .iter()
            .all(|(k, v)| k.bytes().all(|b| b.is_ascii_alphanumeric())
                && v.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_')));
        {
            let mut next = self.next.lock().await;
            tokio::time::sleep_until((*next).into()).await;
            *next = Instant::now() + SPACING;
        }
        let query: Vec<String> = query.iter().map(|(k, v)| format!("{k}={v}")).collect();
        let url = format!("{BASE}{path}?{}", query.join("&"));
        let response = self
            .http
            .get(url)
            .send()
            .await
            .map_err(|e| VenueError::Network(e.without_url().to_string()))?;
        let bytes = body(response, CAP, WHO).await?;
        let reply: Reply<T> = serde_json::from_slice(&bytes)
            .map_err(|e| VenueError::Network(format!("unexpected answer from {WHO}: {e}")))?;
        if reply.code != "0" {
            let msg: String = reply.msg.chars().take(120).collect();
            return Err(VenueError::Rejected(format!("{WHO}: {msg}")));
        }
        Ok(reply.data)
    }

    async fn markets(&self) -> Result<Arc<Markets>, VenueError> {
        if let Some((at, m)) = self.markets.lock().unwrap().as_ref() {
            if at.elapsed() < MARKETS_FRESH_FOR {
                return Ok(Arc::clone(m));
            }
        }
        let instruments: Vec<Instrument> = self
            .get("/api/v5/public/instruments", &[("instType", "SWAP")])
            .await?;
        let markets = Arc::new(contract_sizes(instruments));
        *self.markets.lock().unwrap() = Some((Instant::now(), Arc::clone(&markets)));
        Ok(markets)
    }

    fn checked(code: &str) -> Result<&str, VenueError> {
        if is_code(code) {
            Ok(code)
        } else {
            Err(VenueError::InvalidRequest(
                "that isn't an OKX lead trader".into(),
            ))
        }
    }

    /// The top `limit` lead traders (at most [`MAX_ROWS`]) by `sort`,
    /// from memory while OKX's current leaderboard is.
    pub async fn leaderboard(
        &self,
        sort: SortBy,
        limit: usize,
    ) -> Result<Vec<TraderRow>, VenueError> {
        let limit = limit.clamp(1, MAX_ROWS);
        if let Some((at, rows)) = self.boards.lock().unwrap().get(&sort) {
            if at.elapsed() < BOARD_FRESH_FOR && rows.len() >= limit {
                return Ok(rows[..limit].to_vec());
            }
        }
        let mut rows = Vec::new();
        let mut version = String::new();
        let limit_s = PAGE.to_string();
        for page in 1..=limit.div_ceil(PAGE) {
            let page_s = page.to_string();
            let mut query = vec![
                ("instType", "SWAP"),
                ("sortType", sort_type(sort)),
                ("limit", limit_s.as_str()),
                ("page", page_s.as_str()),
            ];
            // Every page from the same version of the board.
            if version.len() == 14 && version.bytes().all(|b| b.is_ascii_digit()) {
                query.push(("dataVer", version.as_str()));
            }
            let pages: Vec<RankPage> = self
                .get("/api/v5/copytrading/public-lead-traders", &query)
                .await?;
            let Some(p) = pages.into_iter().next() else {
                break;
            };
            if version.is_empty() {
                version = p.data_ver;
            }
            let last = p.total_page.parse::<usize>().unwrap_or(page) <= page;
            rows.extend(p.ranks.into_iter().filter_map(rank_row));
            if last {
                break;
            }
        }
        rows.dedup_by(|a, b| a.id == b.id);
        let rows = Arc::new(rows);
        self.boards
            .lock()
            .unwrap()
            .insert(sort, (Instant::now(), Arc::clone(&rows)));
        Ok(rows.iter().take(limit).cloned().collect())
    }

    /// `code`'s line on a leaderboard read in the last 10 minutes, if any.
    pub fn row(&self, code: &str) -> Option<TraderRow> {
        self.boards
            .lock()
            .unwrap()
            .values()
            .filter(|(at, _)| at.elapsed() < BOARD_FRESH_FOR)
            .find_map(|(_, rows)| rows.iter().find(|r| r.id == code).cloned())
    }

    /// What `code` holds now.
    pub async fn holdings(&self, code: &str) -> Result<Vec<Holding>, VenueError> {
        let code = Self::checked(code)?;
        let markets = self.markets().await?;
        let rows: Vec<SubPosition> = self
            .get(
                "/api/v5/copytrading/public-current-subpositions",
                &[("instType", "SWAP"), ("uniqueCode", code), ("limit", "100")],
            )
            .await?;
        Ok(rows.iter().filter_map(|p| holding(p, &markets)).collect())
    }

    /// `code`'s record for the leaderboard: a month of daily PnL and the
    /// weekly figures (two requests).
    pub async fn stats(&self, code: &str) -> Result<TraderStats, VenueError> {
        let code = Self::checked(code)?;
        let daily: Vec<PnlPoint> = self
            .get(
                "/api/v5/copytrading/public-pnl",
                &[
                    ("instType", "SWAP"),
                    ("uniqueCode", code),
                    ("lastDays", "2"),
                ],
            )
            .await?;
        let weekly: Vec<PnlPoint> = self
            .get(
                "/api/v5/copytrading/public-weekly-pnl",
                &[("instType", "SWAP"), ("uniqueCode", code)],
            )
            .await?;
        Ok(stats_from(daily, weekly, now_ms()))
    }

    /// `code`'s page; `period` picks the PnL history's window (7, 30 or 365 days).
    pub async fn detail(&self, code: &str, period: Period) -> Result<TraderDetail, VenueError> {
        let code = Self::checked(code)?;
        let holdings = self.holdings(code).await?;
        let markets = self.markets().await?;
        let history: Vec<SubPosition> = self
            .get(
                "/api/v5/copytrading/public-subpositions-history",
                &[("instType", "SWAP"), ("uniqueCode", code), ("limit", "100")],
            )
            .await?;
        let mut closed: Vec<ClosedTrade> =
            history.iter().filter_map(|p| closed(p, &markets)).collect();
        closed.sort_by_key(|t| std::cmp::Reverse(t.time));
        let daily: Vec<PnlPoint> = self
            .get(
                "/api/v5/copytrading/public-pnl",
                &[
                    ("instType", "SWAP"),
                    ("uniqueCode", code),
                    ("lastDays", last_days(period)),
                ],
            )
            .await?;
        let weekly: Vec<PnlPoint> = self
            .get(
                "/api/v5/copytrading/public-weekly-pnl",
                &[("instType", "SWAP"), ("uniqueCode", code)],
            )
            .await?;
        let preferred: Vec<Preference> = self
            .get(
                "/api/v5/copytrading/public-preference-currency",
                &[("instType", "SWAP"), ("uniqueCode", code)],
            )
            .await?;
        let mut pnl_history = points(daily);
        // A day's figure is cumulative; with nothing in the window, a flat line now.
        if pnl_history.is_empty() {
            pnl_history.push((now_ms(), 0.0));
        }
        Ok(TraderDetail {
            source: Source::Okx,
            id: code.to_owned(),
            account_value: self.row(code).map_or(0.0, |r| r.account_value),
            holdings,
            win_rate: win_rate(&closed),
            closed,
            pnl_history,
            weekly_pnl: points(weekly),
            preferred: preferred
                .into_iter()
                .filter_map(|p| Some((plain(&p.ccy, 20), num(&p.ratio)?)))
                .take(6)
                .collect(),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn codes_are_checked() {
        assert!(is_code("9F25A5FBE6CFF912"));
        assert!(is_code("381749205163847291"));
        for bad in [
            "",
            "9F25A5FBE6CFF91",
            "9F25A5FBE6CFF912X",
            "9F25A5FBE6CFF9&2",
            "9F25A5FB E6CFF912",
        ] {
            assert!(!is_code(bad), "{bad}");
        }
    }

    fn markets() -> Markets {
        contract_sizes(
            serde_json::from_value(serde_json::json!([
                { "instId": "BTC-USDT-SWAP", "ctVal": "0.01", "ctMult": "1", "ctType": "linear" },
                { "instId": "BTC-USD-SWAP", "ctVal": "100", "ctMult": "1", "ctType": "inverse" },
                { "instId": "NEAR-USDT-SWAP", "ctVal": "10", "ctMult": "1", "ctType": "linear" }
            ]))
            .unwrap(),
        )
    }

    #[test]
    fn reads_a_rank() {
        let rank: Rank = serde_json::from_value(serde_json::json!({
            "accCopyTraderNum": "1051", "aum": "444578.57", "ccy": "USDT", "copyState": "0",
            "copyTraderNum": "600", "leadDays": "63", "nickName": "Disti", "pnl": "189071.76",
            "pnlRatio": "5.8492",
            "pnlRatios": [{ "beginTs": "200", "pnlRatio": "5.8" }, { "beginTs": "100", "pnlRatio": "5.6" }],
            "traderInsts": ["ICP-USDT-SWAP", "BTC-USDT-SWAP", "ICP-USDT-SWAP"],
            "uniqueCode": "9F25A5FBE6CFF912", "winRatio": "0.6452"
        }))
        .unwrap();
        let r = rank_row(rank).unwrap();
        assert_eq!(
            (r.id.as_str(), r.name.as_deref()),
            ("9F25A5FBE6CFF912", Some("Disti"))
        );
        assert_eq!(
            (r.copiers, r.lead_days, r.win_rate),
            (Some(600), Some(63), Some(0.6452))
        );
        assert_eq!(r.roi_curve, [5.6, 5.8]);
    }

    #[test]
    fn positions_come_in_coins() {
        let rows: Vec<SubPosition> = serde_json::from_value(serde_json::json!([
            { "instId": "BTC-USDT-SWAP", "posSide": "net", "subPos": "-300", "openAvgPx": "79492.9",
              "markPx": "75925.7", "lever": "30", "upl": "10701.6", "openTime": "1793888012911" },
            { "instId": "NEAR-USDT-SWAP", "posSide": "long", "subPos": "500", "openAvgPx": "3.79",
              "markPx": "3.714", "lever": "30", "upl": "-380", "openTime": "1793887122806" },
            { "instId": "ODD-USDT-SWAP", "posSide": "long", "subPos": "1", "openAvgPx": "1" }
        ]))
        .unwrap();
        let m = markets();
        let h: Vec<Holding> = rows.iter().filter_map(|p| holding(p, &m)).collect();
        assert_eq!(h.len(), 2);
        assert_eq!(
            (h[0].market.as_str(), h[0].side),
            ("BTC", PositionSide::Short)
        );
        assert!((h[0].size - 3.0).abs() < 1e-12);
        assert!((h[0].value - 3.0 * 75925.7).abs() < 1e-6);
        assert_eq!(
            (h[1].side, h[1].size, h[1].opened_at),
            (PositionSide::Long, 5000.0, Some(1793887122806))
        );
    }

    #[test]
    fn a_record_from_daily_and_weekly_pnl() {
        let day = 86_400_000_u64;
        let now = 100 * day;
        let daily: Vec<PnlPoint> = serde_json::from_value(serde_json::json!([
            { "beginTs": (now - 3 * day).to_string(), "pnl": "0", "pnlRatio": "0" },
            { "beginTs": (now - 2 * day).to_string(), "pnl": "100", "pnlRatio": "1.0" },
            { "beginTs": (now - day).to_string(), "pnl": "40", "pnlRatio": "0.4" },
            { "beginTs": now.to_string(), "pnl": "120", "pnlRatio": "1.2" }
        ]))
        .unwrap();
        let weekly: Vec<PnlPoint> = serde_json::from_value(serde_json::json!([
            { "beginTs": (now - 6 * day).to_string(), "pnl": "-12", "pnlRatio": "0" }
        ]))
        .unwrap();
        let s = stats_from(daily, weekly, now);
        // From twice the stake (ratio 1.0) down to 1.4: 30% of equity.
        assert!((s.max_drawdown.unwrap() - 0.3).abs() < 1e-12);
        assert!((s.best_day_share.unwrap() - 100.0 / 120.0).abs() < 1e-12);
        assert_eq!(s.weeks.last(), Some(&Some(-12.0)));
        assert_eq!(s.curve.len(), 4);
    }

    #[test]
    fn reads_a_closed_position() {
        let row: SubPosition = serde_json::from_value(serde_json::json!({
            "closeAvgPx": "75238.1", "closeTime": "1793977768192", "instId": "BTC-USDT-SWAP",
            "lever": "2E+1", "openAvgPx": "74852", "openTime": "1793977535581", "pnl": "1062.82",
            "posSide": "long", "subPos": "300"
        }))
        .unwrap();
        let t = closed(&row, &markets()).unwrap();
        assert_eq!(
            (t.side, t.pnl, t.time),
            (PositionSide::Long, 1062.82, 1793977768192)
        );
        assert!((t.size - 3.0).abs() < 1e-12);
        // OKX writes some numbers in exponent form.
        assert_eq!(num("2E+1"), Some(20.0));
    }
}
