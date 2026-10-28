//! A request budget per venue, so algos slow down before a venue throttles
//! them. A token bucket each: a burst, then a steady rate. Every venue
//! request an algo makes (placing, changing, cancelling, and the reads it
//! reconciles with) takes a token first; orders from the ticket and the
//! rest of the app don't wait on it.
//!
//! The rates are conservative, below each venue's published limit, since
//! the adapters don't hand back the venue's own counters (Bybit's
//! `X-Bapi-Limit-Status`) for the budget to follow:
//! - Bybit: about 10 order requests a second per account for linear perps.
//! - Aster: weight-based, as Binance's futures API.
//! - Binance: 300 orders per 10 seconds and 1,200 a minute per account,
//!   and a 2,400-weight-a-minute IP budget the app's reads share.
//! - BloFin: 30 trading requests every 10 seconds per account, and 500
//!   requests a minute per IP that the app's reads share.
//! - Hyperliquid: an address limit that, once an account's buffer is spent,
//!   allows about one request per USDC traded and throttles a low-volume
//!   account to one every 10 seconds - the tight one.

use std::collections::HashMap;
use std::sync::Mutex;
use std::time::Duration;

use pewterdesk_core::VenueId;
use tokio::time::Instant;

/// The burst and the steady rate (tokens a second) for `venue`.
fn limits(venue: VenueId) -> (f64, f64) {
    match venue {
        VenueId::Bybit => (10.0, 5.0),
        VenueId::Aster => (10.0, 5.0),
        VenueId::Binance => (10.0, 5.0),
        VenueId::Blofin => (6.0, 2.0),
        VenueId::Hyperliquid => (5.0, 0.5),
    }
}

struct Bucket {
    tokens: f64,
    at: Instant,
}

#[derive(Default)]
pub struct Budget {
    buckets: Mutex<HashMap<VenueId, Bucket>>,
}

impl Budget {
    /// Waits for a token for `venue`, and takes it.
    pub async fn take(&self, venue: VenueId) {
        loop {
            let wait = {
                let (cap, rate) = limits(venue);
                let mut buckets = self.buckets.lock().unwrap();
                let bucket = buckets.entry(venue).or_insert(Bucket {
                    tokens: cap,
                    at: Instant::now(),
                });
                let now = Instant::now();
                let refill = now.duration_since(bucket.at).as_secs_f64() * rate;
                bucket.tokens = (bucket.tokens + refill).min(cap);
                bucket.at = now;
                if bucket.tokens >= 1.0 {
                    bucket.tokens -= 1.0;
                    return;
                }
                Duration::from_secs_f64((1.0 - bucket.tokens) / rate)
            };
            tokio::time::sleep(wait).await;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test(start_paused = true)]
    async fn bursts_then_keeps_to_the_rate() {
        let budget = Budget::default();
        let start = Instant::now();
        for _ in 0..5 {
            budget.take(VenueId::Hyperliquid).await;
        }
        // The burst is free.
        assert!(start.elapsed() < Duration::from_millis(10));
        budget.take(VenueId::Hyperliquid).await;
        // Then one every two seconds.
        assert!(start.elapsed() >= Duration::from_millis(1990));
        // Venues don't share a bucket.
        let before = Instant::now();
        budget.take(VenueId::Bybit).await;
        assert!(before.elapsed() < Duration::from_millis(10));
    }
}
