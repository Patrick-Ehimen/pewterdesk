//! Chart windows: one chart popped out of the Multi-chart page into a
//! window of its own (the same frontend, at `#chart?...`), to sit on another
//! screen.
//!
//! Security-relevant - review against `.claude/commands/security-review.md`:
//! each is one more window on the app's own page. It adds no command beyond
//! opening itself, holds no key, and its page draws a chart only - no order
//! buttons. The address it loads is built here: the venue and interval are
//! the domain's own types, and the market id is checked before it goes in.

use std::sync::atomic::{AtomicU32, Ordering};

use pewterdesk_core::{CandleInterval, VenueId};
use tauri::{AppHandle, Manager, Runtime, WebviewUrl, WebviewWindowBuilder};

/// Every chart window's label starts with this; the capability in
/// `capabilities/chart.json` matches on it.
const LABEL_PREFIX: &str = "chart-";
/// The most chart windows open at once.
const MAX_WINDOWS: usize = 8;
/// The longest market id taken.
const MARKET_MAX: usize = 48;
const WIDTH: f64 = 900.0;
const HEIGHT: f64 = 560.0;
const MIN_WIDTH: f64 = 380.0;
const MIN_HEIGHT: f64 = 280.0;

/// Numbers the windows, so each label is its own.
static NEXT: AtomicU32 = AtomicU32::new(1);

/// A market id as venues write them (`BTCUSDT`, `kPEPE`, `xyz:TSLA`, `@107`):
/// letters, digits and a few marks, none of which mean anything in a URL's
/// fragment.
fn market_ok(market: &str) -> bool {
    !market.is_empty()
        && market.len() <= MARKET_MAX
        && market
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, ':' | '-' | '_' | '.' | '@' | '/'))
}

/// A unit enum's wire name (`"bybit"`, `"15m"`).
fn wire<T: serde::Serialize>(value: &T) -> Option<String> {
    serde_json::to_value(value)
        .ok()?
        .as_str()
        .map(str::to_owned)
}

/// The page a chart window loads.
fn address(venue: VenueId, market: &str, interval: CandleInterval) -> Option<String> {
    if !market_ok(market) {
        return None;
    }
    Some(format!(
        "index.html#chart?venue={}&market={market}&interval={}",
        wire(&venue)?,
        wire(&interval)?
    ))
}

fn open<R: Runtime>(
    app: &AppHandle<R>,
    venue: VenueId,
    market: &str,
    interval: CandleInterval,
) -> Result<(), &'static str> {
    let address = address(venue, market, interval).ok_or("not a market id")?;
    let open = app
        .webview_windows()
        .keys()
        .filter(|label| label.starts_with(LABEL_PREFIX))
        .count();
    if open >= MAX_WINDOWS {
        return Err("too many chart windows are open");
    }
    let label = format!("{LABEL_PREFIX}{}", NEXT.fetch_add(1, Ordering::Relaxed));
    WebviewWindowBuilder::new(app, label, WebviewUrl::App(address.into()))
        .title(market)
        .inner_size(WIDTH, HEIGHT)
        .min_inner_size(MIN_WIDTH, MIN_HEIGHT)
        .build()
        .map_err(|_| "couldn't open the window")?;
    Ok(())
}

/// From the Multi-chart page: opens `market` on `venue` in a window of its own.
#[tauri::command]
pub fn open_chart_window(
    app: AppHandle,
    venue: VenueId,
    market: String,
    interval: CandleInterval,
) -> Result<(), String> {
    open(&app, venue, &market, interval).map_err(str::to_owned)
}

/// Closes every chart window: they go with the main window where closing
/// that quits the app.
pub fn close_all<R: Runtime>(app: &AppHandle<R>) {
    for (label, window) in app.webview_windows() {
        if label.starts_with(LABEL_PREFIX) {
            let _ = window.close();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn builds_the_address_from_checked_parts() {
        assert_eq!(
            address(VenueId::Bybit, "BTCUSDT", CandleInterval::FifteenMinutes).as_deref(),
            Some("index.html#chart?venue=bybit&market=BTCUSDT&interval=15m")
        );
        assert_eq!(
            address(VenueId::Hyperliquid, "xyz:TSLA", CandleInterval::OneDay).as_deref(),
            Some("index.html#chart?venue=hyperliquid&market=xyz:TSLA&interval=1d")
        );
    }

    #[test]
    fn refuses_anything_that_is_not_a_market_id() {
        for bad in [
            "",
            "BTC&venue=aster",
            "BTC#float",
            "BTC?x=1",
            "a b",
            "BTC%23float",
            "\"><script>",
            &"A".repeat(MARKET_MAX + 1),
        ] {
            assert!(
                address(VenueId::Bybit, bad, CandleInterval::OneHour).is_none(),
                "{bad}"
            );
        }
    }
}
