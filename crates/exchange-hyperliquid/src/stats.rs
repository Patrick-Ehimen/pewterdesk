//! Market stats: the pieces `activeAssetCtx` doesn't carry. Hyperliquid has no
//! 24h high/low, so they come from hourly candles — seeded over REST, then kept
//! current from the `candle` channel — and funding is paid every hour, on the
//! hour.

use std::collections::BTreeMap;

use pewterdesk_core::Decimal;

pub const HOUR_MS: u64 = 3_600_000;
const DAY_MS: u64 = 24 * HOUR_MS;

/// Hyperliquid pays funding hourly.
pub const FUNDING_INTERVAL_SECS: u32 = 3600;

/// When the current hour's funding is paid: the top of the next hour.
pub fn next_funding_time(now_ms: u64) -> u64 {
    (now_ms / HOUR_MS + 1) * HOUR_MS
}

/// The high and low over the last 24 hours, from hourly candles keyed by
/// their open time. A candle counts while any part of it is inside the window.
#[derive(Default)]
pub struct DayRange {
    candles: BTreeMap<u64, (Decimal, Decimal)>,
}

impl DayRange {
    /// Adds or updates the candle that opened at `open_time`; the live channel
    /// re-sends the current hour's candle as it moves.
    pub fn record(&mut self, open_time: u64, high: Decimal, low: Decimal) {
        self.candles.insert(open_time, (high, low));
    }

    /// `(high, low)` over the day before `now_ms`, or `None` with no candles.
    /// Drops candles that have left the window.
    pub fn range(&mut self, now_ms: u64) -> Option<(Decimal, Decimal)> {
        // A candle opening at `t` covers [t, t + 1h); it overlaps the window
        // (now - 24h, now] while t + 1h > now - 24h, i.e. t > now - 25h.
        let oldest_open = (now_ms + 1).saturating_sub(DAY_MS + HOUR_MS);
        self.candles = self.candles.split_off(&oldest_open);
        self.candles
            .values()
            .fold(None, |acc, &(high, low)| match acc {
                None => Some((high, low)),
                Some((h, l)) => Some((h.max(high), l.min(low))),
            })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn dec(s: &str) -> Decimal {
        Decimal(s.parse().unwrap())
    }

    #[test]
    fn funding_is_paid_at_the_top_of_the_next_hour() {
        assert_eq!(next_funding_time(0), HOUR_MS);
        assert_eq!(next_funding_time(HOUR_MS - 1), HOUR_MS);
        // Exactly on the hour, that hour's payment has just happened.
        assert_eq!(next_funding_time(HOUR_MS), 2 * HOUR_MS);
    }

    #[test]
    fn takes_the_extremes_across_candles() {
        let mut range = DayRange::default();
        range.record(0, dec("10"), dec("8"));
        range.record(HOUR_MS, dec("12"), dec("9"));
        range.record(2 * HOUR_MS, dec("11"), dec("7"));
        assert_eq!(range.range(3 * HOUR_MS), Some((dec("12"), dec("7"))));
    }

    #[test]
    fn a_live_update_replaces_that_hours_candle() {
        let mut range = DayRange::default();
        range.record(0, dec("10"), dec("9"));
        range.record(0, dec("13"), dec("9"));
        assert_eq!(range.range(HOUR_MS / 2), Some((dec("13"), dec("9"))));
    }

    #[test]
    fn candles_leave_once_wholly_outside_the_day() {
        let mut range = DayRange::default();
        range.record(0, dec("99"), dec("1"));
        range.record(DAY_MS, dec("10"), dec("9"));
        // At 24h + 30m, the first candle (0–1h) still overlaps the window.
        assert_eq!(
            range.range(DAY_MS + HOUR_MS / 2),
            Some((dec("99"), dec("1")))
        );
        // At 25h + 1ms it's gone.
        assert_eq!(
            range.range(DAY_MS + HOUR_MS + 1),
            Some((dec("10"), dec("9")))
        );
    }

    #[test]
    fn empty_until_a_candle_arrives() {
        assert_eq!(DayRange::default().range(DAY_MS), None);
    }
}
