//! History for a backtest: the candles recorded, and older ones the venue
//! still serves (a page at a time), recorded as they come - so the next
//! backtest reads them here, and what the venue drops off stays.

use std::sync::Arc;

use pewterdesk_core::{CandleInterval, VenueError, VenueId};
use pewterdesk_strategy::Bar;

use super::feed::{interval_name, recorded, venue_name, Recording};
use crate::algo::Host;
use crate::rules::now_ms;

/// Candles asked of a venue at a time.
const PAGE: u32 = 1000;
/// The most pages read for one backtest.
const MAX_PAGES: usize = 40;

/// `market`'s closed candles at `interval` from `since` (ms) to now, oldest
/// first.
pub async fn candles(
    host: &Arc<dyn Host>,
    venue: VenueId,
    market: &str,
    interval: CandleInterval,
    since: u64,
) -> Result<Vec<Bar>, VenueError> {
    let step = interval.millis();
    let now = now_ms();
    // The forming candle isn't one.
    let last_closed = now - now % step - step;
    let recording = host.recorder().map(|recorder| Recording {
        recorder,
        venue,
        market: market.to_owned(),
        interval,
    });
    let adapter = host.venues().adapter(venue)?;
    // Read back from now, a page at a time, until `since` is covered.
    let mut before = now;
    let mut fetched: Vec<pewterdesk_core::Candle> = Vec::new();
    for _ in 0..MAX_PAGES {
        if before <= since {
            break;
        }
        let page = match adapter.candles(market, interval, before, PAGE).await {
            Ok(page) => page,
            // A venue without history: what's recorded is all there is.
            Err(VenueError::Unsupported(_)) => break,
            Err(e) if fetched.is_empty() && recording.is_none() => return Err(e),
            Err(_) => break,
        };
        let Some(oldest) = page.iter().map(|c| c.open_time).min() else {
            break;
        };
        if oldest >= before {
            break;
        }
        before = oldest;
        fetched.extend(page);
    }
    fetched.retain(|c| c.open_time >= since && c.open_time <= last_closed);
    if let Some(rec) = &recording {
        let rows: Vec<_> = fetched
            .iter()
            .map(|c| pewterdesk_store::StoredCandle {
                open_time: c.open_time,
                open: c.open.0.to_string(),
                high: c.high.0.to_string(),
                low: c.low.0.to_string(),
                close: c.close.0.to_string(),
                volume: c.volume.0.to_string(),
            })
            .collect();
        let _ = rec
            .recorder
            .save(&venue_name(venue), market, &interval_name(interval), &rows);
        return Ok(recorded(rec, since, last_closed));
    }
    let mut bars: Vec<Bar> = fetched.iter().filter_map(Bar::from_candle).collect();
    bars.sort_by_key(|b| b.time);
    bars.dedup_by_key(|b| b.time);
    Ok(bars)
}
