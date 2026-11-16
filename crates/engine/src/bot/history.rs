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

/// The most pages of funding history read for one backtest.
const FUNDING_PAGES: usize = 12;
/// The most hours of open-interest history asked for.
const OI_HOURS: u32 = 24 * 400;

/// Puts the venue's funding (per 8 hours) and, if `open_interest`, its
/// open interest on each candle: the last known at the candle's close.
/// Where the venue has none, the candles go without; nothing fails for it.
pub async fn context(
    host: &Arc<dyn Host>,
    venue: VenueId,
    market: &str,
    bars: &mut [Bar],
    open_interest: bool,
) {
    let (Some(first), Some(last)) = (bars.first().map(|b| b.time), bars.last().map(|b| b.time))
    else {
        return;
    };
    let step = match bars {
        [a, b, ..] => b.time.saturating_sub(a.time).max(1),
        _ => 1,
    };
    let Ok(adapter) = host.venues().adapter(venue) else {
        return;
    };
    // Funding: from a day before the first candle, a page at a time.
    let mut rates: Vec<(u64, f64)> = Vec::new();
    let mut from = first.saturating_sub(86_400_000);
    for _ in 0..FUNDING_PAGES {
        let Ok(page) = adapter.funding_history(market, from).await else {
            break;
        };
        let mut newest = from;
        for r in &page {
            if let Ok(rate) = r.rate.0.to_string().parse::<f64>() {
                if r.time >= from && r.time <= last + step {
                    rates.push((r.time, rate));
                }
            }
            newest = newest.max(r.time);
        }
        if page.is_empty() || newest <= from || newest >= last {
            break;
        }
        from = newest + 1;
    }
    rates.sort_by_key(|r| r.0);
    rates.dedup_by_key(|r| r.0);
    // Each rate as per 8 hours: the venue's own interval is the gap to the one before.
    let per_8h: Vec<(u64, f64)> = rates
        .iter()
        .enumerate()
        .map(|(i, (t, r))| {
            let gap = i
                .checked_sub(1)
                .and_then(|j| rates.get(j))
                .map_or(8 * 3_600_000, |(p, _)| t.saturating_sub(*p))
                .clamp(3_600_000, 8 * 3_600_000);
            (*t, r * (8.0 * 3_600_000.0) / gap as f64)
        })
        .collect();
    fill(bars, step, &per_8h, |b, v| b.funding = Some(v));

    if open_interest {
        let hours = ((now_ms().saturating_sub(first)) / 3_600_000 + 1).min(u64::from(OI_HOURS));
        if let Ok(points) = adapter.open_interest_history(market, hours as u32).await {
            let mut oi: Vec<(u64, f64)> = points
                .iter()
                .filter_map(|p| Some((p.time, p.open_interest.0.to_string().parse::<f64>().ok()?)))
                .collect();
            oi.sort_by_key(|p| p.0);
            fill(bars, step, &oi, |b, v| b.oi = Some(v));
        }
    }
}

/// Sets on each candle the last value known by its close (`step` after it opened).
fn fill(bars: &mut [Bar], step: u64, values: &[(u64, f64)], set: impl Fn(&mut Bar, f64)) {
    let mut i = 0;
    let mut current = None;
    for b in bars.iter_mut() {
        let close = b.time + step;
        while let Some((t, v)) = values.get(i) {
            if *t > close {
                break;
            }
            current = Some(*v);
            i += 1;
        }
        if let Some(v) = current {
            set(b, v);
        }
    }
}
