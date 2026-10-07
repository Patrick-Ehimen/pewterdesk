//! OKX's public liquidation history, for the Maps page's Liquidations view.
//! OKX isn't a venue here (nothing trades on it, no key is held): like
//! CoinGecko it's a public data source, read because Bybit publishes
//! liquidations only as they happen, while OKX also serves the last day of
//! them. Two read-only GETs, both keyless, both on `www.okx.com`:
//!
//! - `/api/v5/public/instruments` - the live USDT-margined swaps and each
//!   one's contract size, read at most once an hour.
//! - `/api/v5/public/liquidation-orders` - one swap's filled liquidations,
//!   newest first, paged back to the time asked for.
//!
//! The UI names a market only from the list this module itself returned;
//! anything else is refused before a request is built. Requests are spaced
//! to stay well inside OKX's limit (40 per 2 seconds per IP).

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use pewterdesk_core::{PositionSide, VenueError};
use serde::{Deserialize, Serialize};
use tauri::State;

const BASE: &str = "https://www.okx.com";
const USER_AGENT: &str = concat!("pewterdesk/", env!("CARGO_PKG_VERSION"));
const TIMEOUT: Duration = Duration::from_secs(15);
/// How long the list of swaps is kept before it's read again.
const MARKETS_FRESH_FOR: Duration = Duration::from_secs(60 * 60);
/// Requests start at least this far apart: about 12 a second, of the 20 allowed.
const SPACING: Duration = Duration::from_millis(80);
/// Rows per page: OKX's most.
const PAGE: usize = 100;
/// The most pages read for one market in one call (OKX keeps about a day,
/// which is some 20 pages for its busiest market).
const MAX_PAGES: usize = 40;
/// How far back a caller may ask: OKX serves no more.
const MAX_AGE_MS: u64 = 24 * 60 * 60 * 1000;

/// One liquidation on OKX, as the UI takes it.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OkxLiquidation {
    /// The swap's base coin, e.g. "BTC".
    pub base: String,
    /// The side of the position that was liquidated.
    pub side: PositionSide,
    /// The bankruptcy price it was closed at.
    pub price: f64,
    /// In base units (contracts times the contract's size).
    pub size: f64,
    /// Milliseconds since the Unix epoch.
    pub time: u64,
}

#[derive(Deserialize)]
struct Reply<T> {
    code: String,
    #[serde(default)]
    msg: String,
    #[serde(default = "Vec::new")]
    data: Vec<T>,
}

/// A row of `GET /api/v5/public/instruments`.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Instrument {
    #[serde(default)]
    inst_family: String,
    #[serde(default)]
    settle_ccy: String,
    #[serde(default)]
    ct_type: String,
    #[serde(default)]
    ct_val: String,
    #[serde(default)]
    ct_mult: String,
    #[serde(default)]
    state: String,
}

/// A group of `GET /api/v5/public/liquidation-orders`.
#[derive(Deserialize)]
struct LiquidationGroup {
    #[serde(default)]
    details: Vec<Detail>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Detail {
    #[serde(default)]
    pos_side: String,
    #[serde(default)]
    bk_px: String,
    #[serde(default)]
    sz: String,
    #[serde(default)]
    ts: String,
}

/// A swap family OKX may be asked about: "BTC-USDT" and the like. Letters,
/// digits and one dash, so nothing in it can change the request.
fn is_family(name: &str) -> bool {
    let mut parts = name.split('-');
    let ok = |p: Option<&str>| {
        p.is_some_and(|p| {
            !p.is_empty() && p.len() <= 20 && p.bytes().all(|b| b.is_ascii_alphanumeric())
        })
    };
    ok(parts.next()) && parts.next() == Some("USDT") && parts.next().is_none()
}

/// The live, linear, USDT-margined swaps and how many base units one contract is.
fn contract_sizes(instruments: Vec<Instrument>) -> HashMap<String, f64> {
    instruments
        .into_iter()
        .filter(|i| i.state == "live" && i.settle_ccy == "USDT" && i.ct_type == "linear")
        .filter(|i| is_family(&i.inst_family))
        .filter_map(|i| {
            let size = i.ct_val.parse::<f64>().ok()? * i.ct_mult.parse::<f64>().unwrap_or(1.0);
            (size.is_finite() && size > 0.0).then_some((i.inst_family, size))
        })
        .collect()
}

/// A row as the UI takes it, or `None` for one that can't be read.
fn liquidation(detail: &Detail, base: &str, contract: f64) -> Option<OkxLiquidation> {
    let side = match detail.pos_side.as_str() {
        "long" => PositionSide::Long,
        "short" => PositionSide::Short,
        _ => return None,
    };
    let price = detail
        .bk_px
        .parse::<f64>()
        .ok()
        .filter(|p| p.is_finite() && *p > 0.0)?;
    let contracts = detail
        .sz
        .parse::<f64>()
        .ok()
        .filter(|s| s.is_finite() && *s > 0.0)?;
    Some(OkxLiquidation {
        base: base.to_owned(),
        side,
        price,
        size: contracts * contract,
        time: detail.ts.parse().ok()?,
    })
}

type Markets = (Instant, Arc<HashMap<String, f64>>);

pub struct OkxState {
    http: reqwest::Client,
    markets: Mutex<Option<Markets>>,
    /// When the next request may start; see `SPACING`.
    next: tokio::sync::Mutex<Instant>,
}

impl OkxState {
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
            markets: Mutex::new(None),
            next: tokio::sync::Mutex::new(Instant::now()),
        })
    }

    async fn get<T: serde::de::DeserializeOwned>(
        &self,
        path: &str,
        query: &[(&str, &str)],
    ) -> Result<Vec<T>, VenueError> {
        {
            let mut next = self.next.lock().await;
            tokio::time::sleep_until((*next).into()).await;
            *next = Instant::now() + SPACING;
        }
        let response = self
            .http
            .get(format!("{BASE}{path}"))
            .query(query)
            .send()
            .await
            .map_err(|e| VenueError::Network(e.without_url().to_string()))?;
        let status = response.status().as_u16();
        if status == 429 {
            return Err(VenueError::Network(
                "OKX's rate limit was reached; it will be tried again".into(),
            ));
        }
        if status != 200 {
            return Err(VenueError::Network(format!("OKX returned {status}")));
        }
        let reply: Reply<T> = response
            .json()
            .await
            .map_err(|e| VenueError::Network(format!("unexpected OKX response: {e}")))?;
        if reply.code != "0" {
            let msg: String = reply.msg.chars().take(120).collect();
            return Err(VenueError::Rejected(format!("OKX: {msg}")));
        }
        Ok(reply.data)
    }

    /// The swaps and their contract sizes, from memory while fresh.
    async fn markets(&self) -> Result<Arc<HashMap<String, f64>>, VenueError> {
        if let Some((at, markets)) = self.markets.lock().unwrap().as_ref() {
            if at.elapsed() < MARKETS_FRESH_FOR {
                return Ok(Arc::clone(markets));
            }
        }
        let instruments: Vec<Instrument> = self
            .get("/api/v5/public/instruments", &[("instType", "SWAP")])
            .await?;
        let markets = Arc::new(contract_sizes(instruments));
        *self.markets.lock().unwrap() = Some((Instant::now(), Arc::clone(&markets)));
        Ok(markets)
    }
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| d.as_millis() as u64)
}

/// The swaps whose liquidations can be read: "BTC-USDT" and so on.
#[tauri::command]
pub async fn okx_liquidation_markets(
    state: State<'_, OkxState>,
) -> Result<Vec<String>, VenueError> {
    let mut markets: Vec<String> = state.markets().await?.keys().cloned().collect();
    markets.sort();
    Ok(markets)
}

/// `market`'s liquidations on OKX since `since` (ms; at most a day back),
/// newest first. `market` must be one `okx_liquidation_markets` returned.
#[tauri::command]
pub async fn okx_liquidations(
    state: State<'_, OkxState>,
    market: String,
    since: u64,
) -> Result<Vec<OkxLiquidation>, VenueError> {
    let markets = state.markets().await?;
    let Some(&contract) = markets.get(&market) else {
        return Err(VenueError::InvalidRequest("that isn't an OKX swap".into()));
    };
    let base = market.split('-').next().unwrap_or_default().to_owned();
    let since = since.max(now_ms().saturating_sub(MAX_AGE_MS));
    let mut out = Vec::new();
    let mut after: Option<u64> = None;
    for _ in 0..MAX_PAGES {
        let cursor = after.map(|t| t.to_string());
        let limit = PAGE.to_string();
        let mut query = vec![
            ("instType", "SWAP"),
            ("instFamily", market.as_str()),
            ("state", "filled"),
            ("limit", limit.as_str()),
        ];
        if let Some(cursor) = cursor.as_deref() {
            query.push(("after", cursor));
        }
        let groups: Vec<LiquidationGroup> = state
            .get("/api/v5/public/liquidation-orders", &query)
            .await?;
        let rows: Vec<OkxLiquidation> = groups
            .iter()
            .flat_map(|g| g.details.iter())
            .filter_map(|d| liquidation(d, &base, contract))
            .collect();
        let Some(oldest) = rows.iter().map(|r| r.time).min() else {
            break;
        };
        out.extend(rows.into_iter().filter(|r| r.time >= since));
        // Reached what was asked for, or OKX has stopped going back.
        if oldest < since || after.is_some_and(|a| oldest >= a) {
            break;
        }
        after = Some(oldest);
    }
    out.sort_by_key(|r| std::cmp::Reverse(r.time));
    out.dedup_by(|a, b| a == b);
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_plain_usdt_swap_names_are_asked_about() {
        assert!(is_family("BTC-USDT"));
        assert!(is_family("1000BONK-USDT"));
        for bad in [
            "BTC-USD",
            "BTC-USDT-SWAP",
            "-USDT",
            "BTC-USDT&state=x",
            "BTC USDT",
            "../x-USDT",
            "",
        ] {
            assert!(!is_family(bad), "{bad}");
        }
    }

    #[test]
    fn reads_swaps_and_their_contract_sizes() {
        let instruments: Vec<Instrument> = serde_json::from_value(serde_json::json!([
            { "instFamily": "BTC-USDT", "settleCcy": "USDT", "ctType": "linear",
              "ctVal": "0.01", "ctMult": "1", "state": "live" },
            { "instFamily": "BTC-USD", "settleCcy": "BTC", "ctType": "inverse",
              "ctVal": "100", "ctMult": "1", "state": "live" },
            { "instFamily": "OLD-USDT", "settleCcy": "USDT", "ctType": "linear",
              "ctVal": "1", "ctMult": "1", "state": "suspend" },
            { "instFamily": "BAD-USDT", "settleCcy": "USDT", "ctType": "linear",
              "ctVal": "x", "ctMult": "1", "state": "live" }
        ]))
        .unwrap();
        let sizes = contract_sizes(instruments);
        assert_eq!(sizes.len(), 1);
        assert_eq!(sizes["BTC-USDT"], 0.01);
    }

    #[test]
    fn maps_a_liquidation_to_base_units() {
        let detail: Detail = serde_json::from_value(serde_json::json!({
            "bkLoss": "0", "bkPx": "83314.7", "ccy": "", "posSide": "short",
            "side": "buy", "sz": "24", "ts": "1791387785517"
        }))
        .unwrap();
        let l = liquidation(&detail, "BTC", 0.01).unwrap();
        assert_eq!(
            (l.base.as_str(), l.side, l.time),
            ("BTC", PositionSide::Short, 1791387785517)
        );
        assert!((l.size - 0.24).abs() < 1e-12 && l.price == 83314.7);
        let odd: Detail = serde_json::from_value(
            serde_json::json!({ "posSide": "net", "bkPx": "1", "sz": "1", "ts": "1" }),
        )
        .unwrap();
        assert!(liquidation(&odd, "BTC", 0.01).is_none());
    }
}
