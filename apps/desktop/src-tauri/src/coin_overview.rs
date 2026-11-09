//! The crypto market as a whole, for the AI page's Quick Insights: the total
//! market cap with its 24-hour change and a 7-day line, and an altcoin index.
//! Read by `coin_info::CoinInfoState::overview` from two fixed CoinGecko
//! requests (`/global` and the top coins of `/coins/markets`); this module is
//! only the arithmetic over their replies. Numbers reach the UI, nothing else.

use serde::{Deserialize, Serialize};

/// How many of the largest coins are read, for the line and the index.
pub const TOP_COINS: usize = 100;
/// Points kept on the market cap line (CoinGecko gives about 168, hourly).
const CURVE_POINTS: usize = 84;
/// Fewer altcoins counted than this and there's no index.
const MIN_ALTS: usize = 20;

/// The market overview as the UI sees it. Amounts in USD; changes are
/// fractions (0.02 is +2%); each is absent where CoinGecko had none.
#[derive(Clone, Debug, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CryptoOverview {
    pub market_cap: Option<f64>,
    #[serde(rename = "marketCapChange24h")]
    pub market_cap_change_24h: Option<f64>,
    /// The total market cap over the last 7 days, oldest first: the largest
    /// coins' prices times their supply, scaled to `market_cap`.
    pub market_cap_curve: Vec<f64>,
    /// 0 to 100: the share of the largest altcoins (stablecoins and wrapped
    /// or staked copies left out) that did better than Bitcoin over 30 days.
    pub altcoin_index: Option<u8>,
    /// How many altcoins the index counted.
    pub altcoins: u32,
}

/// `GET /global`.
#[derive(Deserialize)]
pub struct WireGlobal {
    data: GlobalData,
}

#[derive(Deserialize)]
struct GlobalData {
    #[serde(default)]
    total_market_cap: std::collections::HashMap<String, f64>,
    market_cap_change_percentage_24h_usd: Option<f64>,
}

/// A row of `GET /coins/markets` with a sparkline and the 30-day change.
#[derive(Deserialize)]
pub struct WireTop {
    #[serde(default)]
    symbol: String,
    #[serde(default)]
    name: String,
    market_cap: Option<f64>,
    current_price: Option<f64>,
    price_change_percentage_30d_in_currency: Option<f64>,
    sparkline_in_7d: Option<Sparkline>,
}

#[derive(Deserialize)]
struct Sparkline {
    #[serde(default)]
    price: Vec<Option<f64>>,
}

/// Stablecoins, gold tokens and wrapped, staked or bridged copies of other
/// coins: not altcoins for the index. Names are caught too (`not_alt`).
const NOT_ALTS: &[&str] = &[
    "USDT",
    "USDC",
    "DAI",
    "USDE",
    "FDUSD",
    "TUSD",
    "USDD",
    "PYUSD",
    "USDS",
    "USD1",
    "USDX",
    "USDY",
    "BUIDL",
    "USDTB",
    "USD0",
    "RLUSD",
    "FRAX",
    "GHO",
    "LUSD",
    "USDB",
    "SUSDE",
    "SUSDS",
    "EURC",
    "XAUT",
    "PAXG",
    "USDF",
    "USDG",
    "BFUSD",
    "USDO",
    "AUSD",
    "SYRUPUSDC",
    "WBTC",
    "WETH",
    "STETH",
    "WSTETH",
    "WEETH",
    "CBBTC",
    "RETH",
    "METH",
    "WBETH",
    "JITOSOL",
    "MSOL",
    "BSOL",
    "LBTC",
    "SOLVBTC",
    "CLBTC",
    "BTCB",
    "WBNB",
    "EZETH",
    "RSETH",
    "CMETH",
    "BNSOL",
    "TBTC",
    "LSETH",
    "OSETH",
    "SWETH",
    "STKAAVE",
    "JUPSOL",
    "KHYPE",
    "STHYPE",
    "WHYPE",
];

fn not_alt(symbol: &str, name: &str) -> bool {
    let name = name.to_lowercase();
    NOT_ALTS.contains(&symbol)
        || ["wrapped", "bridged", "staked", "restaked", "stablecoin"]
            .iter()
            .any(|w| name.contains(w))
}

/// A stablecoin the list doesn't name: a dollar, and still one a month on.
fn looks_stable(price: Option<f64>, change_30d: Option<f64>) -> bool {
    matches!((price, change_30d), (Some(p), Some(c)) if (0.97..=1.03).contains(&p) && c.abs() < 3.0)
}

fn finite(v: Option<f64>) -> Option<f64> {
    v.filter(|v| v.is_finite())
}

pub fn build(global: WireGlobal, top: Vec<WireTop>) -> CryptoOverview {
    let market_cap = finite(global.data.total_market_cap.get("usd").copied()).filter(|v| *v > 0.0);
    let market_cap_change_24h =
        finite(global.data.market_cap_change_percentage_24h_usd).map(|p| p / 100.0);
    let top: Vec<WireTop> = top.into_iter().take(TOP_COINS).collect();
    CryptoOverview {
        market_cap,
        market_cap_change_24h,
        market_cap_curve: curve(&top, market_cap),
        ..altcoin_index(&top)
    }
}

/// The largest coins' total over the week, from each one's price line times
/// its supply (market cap over price), scaled so its end is `total`.
fn curve(top: &[WireTop], total: Option<f64>) -> Vec<f64> {
    // Coins whose line is the common length only, so the sum doesn't jump
    // where a shorter one starts.
    let lines: Vec<(f64, &[Option<f64>])> = top
        .iter()
        .filter_map(|c| {
            let cap = finite(c.market_cap).filter(|v| *v > 0.0)?;
            let price = finite(c.current_price).filter(|v| *v > 0.0)?;
            let line = c.sparkline_in_7d.as_ref()?.price.as_slice();
            Some((cap / price, line))
        })
        .collect();
    let mut lengths: Vec<usize> = lines.iter().map(|(_, l)| l.len()).collect();
    lengths.sort_unstable();
    let Some(&common) = lengths.get(lengths.len() / 2) else {
        return Vec::new();
    };
    if common < 2 {
        return Vec::new();
    }
    let mut sums = vec![0.0; common];
    for (supply, line) in lines.iter().filter(|(_, l)| l.len() == common) {
        // A gap in one coin's line takes its neighbour's price.
        let mut last = None;
        for (sum, p) in sums.iter_mut().zip(line.iter()) {
            let p = finite(*p).filter(|v| *v > 0.0).or(last);
            if let Some(p) = p {
                *sum += p * supply;
                last = Some(p);
            }
        }
    }
    if sums.iter().any(|s| *s <= 0.0) {
        return Vec::new();
    }
    let scale = match (total, sums.last()) {
        (Some(total), Some(end)) => total / end,
        _ => 1.0,
    };
    let step = (common as f64 / CURVE_POINTS as f64).max(1.0);
    let mut out = Vec::with_capacity(CURVE_POINTS + 1);
    let mut at = 0.0;
    while (at as usize) < common {
        out.push(sums[at as usize] * scale);
        at += step;
    }
    if let Some(end) = sums.last() {
        if out.last() != Some(&(end * scale)) {
            out.push(end * scale);
        }
    }
    out
}

fn altcoin_index(top: &[WireTop]) -> CryptoOverview {
    let Some(btc) = top
        .iter()
        .find(|c| c.symbol.eq_ignore_ascii_case("btc"))
        .and_then(|c| finite(c.price_change_percentage_30d_in_currency))
    else {
        return CryptoOverview::default();
    };
    let alts: Vec<f64> = top
        .iter()
        .filter_map(|c| {
            let symbol = c.symbol.trim().to_uppercase();
            let change = finite(c.price_change_percentage_30d_in_currency)?;
            let skip = symbol == "BTC"
                || not_alt(&symbol, &c.name)
                || looks_stable(finite(c.current_price), Some(change));
            (!skip).then_some(change)
        })
        .collect();
    if alts.len() < MIN_ALTS {
        return CryptoOverview::default();
    }
    let better = alts.iter().filter(|c| **c > btc).count();
    CryptoOverview {
        altcoin_index: Some((better as f64 * 100.0 / alts.len() as f64).round() as u8),
        altcoins: alts.len() as u32,
        ..CryptoOverview::default()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn coin(
        symbol: &str,
        name: &str,
        price: f64,
        cap: f64,
        d30: f64,
        line: &[f64],
    ) -> serde_json::Value {
        json!({
            "symbol": symbol, "name": name, "current_price": price, "market_cap": cap,
            "price_change_percentage_30d_in_currency": d30,
            "sparkline_in_7d": { "price": line },
        })
    }

    fn global(cap: f64, change: f64) -> WireGlobal {
        serde_json::from_value(json!({ "data": {
            "total_market_cap": { "usd": cap, "btc": 1.0 },
            "market_cap_change_percentage_24h_usd": change,
        }}))
        .unwrap()
    }

    #[test]
    fn counts_altcoins_that_beat_bitcoin() {
        let mut rows = vec![coin("btc", "Bitcoin", 100.0, 1000.0, 5.0, &[1.0, 1.0])];
        // 30 altcoins: 12 beat Bitcoin's 5%.
        for i in 0..30 {
            let d30 = if i < 12 { 10.0 } else { -3.0 };
            rows.push(coin(&format!("a{i}"), "Alt", 2.0, 10.0, d30, &[1.0, 1.0]));
        }
        // Left out: a listed stable, a wrapped copy, a dollar not on the list.
        rows.push(coin("usdt", "Tether", 1.0, 500.0, 0.0, &[1.0, 1.0]));
        rows.push(coin(
            "wbtc",
            "Wrapped Bitcoin",
            100.0,
            50.0,
            5.5,
            &[1.0, 1.0],
        ));
        rows.push(coin("newusd", "New Dollar", 1.001, 5.0, 0.1, &[1.0, 1.0]));
        let top: Vec<WireTop> = serde_json::from_value(json!(rows)).unwrap();
        let o = build(global(2000.0, -2.24), top);
        assert_eq!(o.altcoins, 30);
        assert_eq!(o.altcoin_index, Some(40));
        assert_eq!(o.market_cap, Some(2000.0));
        assert!((o.market_cap_change_24h.unwrap() + 0.0224).abs() < 1e-9);
    }

    #[test]
    fn too_few_altcoins_gives_no_index() {
        let top: Vec<WireTop> = serde_json::from_value(json!([
            coin("btc", "Bitcoin", 100.0, 1000.0, 5.0, &[1.0, 1.0]),
            coin("eth", "Ethereum", 10.0, 500.0, 8.0, &[1.0, 1.0]),
        ]))
        .unwrap();
        assert_eq!(build(global(1.0, 0.0), top).altcoin_index, None);
    }

    #[test]
    fn the_line_is_the_coins_summed_and_scaled_to_the_total() {
        // Supplies: A 10 (cap 100 at 10), B 5 (cap 50 at 10).
        let top: Vec<WireTop> = serde_json::from_value(json!([
            coin("a", "A", 10.0, 100.0, 0.0, &[8.0, 9.0, 10.0]),
            coin("b", "B", 10.0, 50.0, 0.0, &[12.0, 11.0, 10.0]),
            // A shorter line is left out rather than starting a step.
            coin("c", "C", 1.0, 1.0, 0.0, &[1.0]),
        ]))
        .unwrap();
        let line = curve(&top, Some(300.0));
        // Sums 140, 145, 150, scaled by 300 / 150.
        assert_eq!(line, vec![280.0, 290.0, 300.0]);
    }

    #[test]
    fn a_gap_in_a_line_keeps_the_last_price() {
        let top: Vec<WireTop> = serde_json::from_value(json!([
            { "symbol": "a", "name": "A", "current_price": 1.0, "market_cap": 1.0,
              "sparkline_in_7d": { "price": [1.0, null, 2.0] } },
        ]))
        .unwrap();
        assert_eq!(curve(&top, None), vec![1.0, 1.0, 2.0]);
    }

    #[test]
    fn a_long_line_is_thinned_and_ends_on_the_last_point() {
        let prices: Vec<f64> = (1..=168).map(f64::from).collect();
        let top: Vec<WireTop> =
            serde_json::from_value(json!([coin("a", "A", 168.0, 168.0, 0.0, &prices)])).unwrap();
        let line = curve(&top, None);
        assert!(line.len() <= CURVE_POINTS + 1);
        assert_eq!(line.first(), Some(&1.0));
        assert_eq!(line.last(), Some(&168.0));
    }
}
