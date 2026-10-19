//! The venue's own version of an algo, where it has one, so it carries on
//! while this machine sleeps. Today: Hyperliquid's TWAP (5 minutes to 7
//! days, market slices at most every 30 seconds, each within 3% of the
//! price, $100 minimum). A TWAP is sent natively only when that's what was
//! asked for - market slices - and the trader didn't turn native off;
//! anything else (chased slices, a slice count the venue won't honour)
//! runs on this machine instead, and says so (`RunsOn::Local`).
//!
//! The venue doesn't say which fills are the TWAP's, so its progress is
//! counted from the account's fills on that market and side since it
//! started: a fill of the trader's own there counts too.

use pewterdesk_core::{AlgoKind, AlgoSpec, AlgoView, OrderKind, OrderRequest, SliceStyle, VenueId};
use rust_decimal::Decimal as D;

use super::exec::{Act, Ctx, Decision, Executor, Outcome};

const MIN_MINUTES: u64 = 5;
const MAX_MINUTES: u64 = 7 * 24 * 60;
/// How long after its end a native TWAP is still followed, for late fills.
const GRACE_MS: u64 = 120_000;
/// How often its progress is read.
const CHECK_EVERY_MS: u64 = 15_000;

#[derive(Debug)]
pub(super) struct NativeTwap {
    minutes: u32,
    randomize: bool,
    duration: u64,
    placed: bool,
}

/// The native TWAP for `spec`, if the venue has one that does what it asks.
pub(super) fn twap(spec: &AlgoSpec) -> Option<NativeTwap> {
    if !spec.prefer_native || spec.venue != VenueId::Hyperliquid {
        return None;
    }
    let AlgoKind::Twap {
        duration_ms,
        randomize,
        style: SliceStyle::Market,
        ..
    } = spec.kind
    else {
        return None;
    };
    let minutes = duration_ms.div_ceil(60_000);
    if !(MIN_MINUTES..=MAX_MINUTES).contains(&minutes) {
        return None;
    }
    Some(NativeTwap {
        minutes: minutes as u32,
        randomize,
        duration: minutes * 60_000,
        placed: false,
    })
}

/// A native TWAP already placed, followed again after a restart.
pub(super) fn resume(view: &AlgoView) -> Option<NativeTwap> {
    let mut twap = twap(&view.spec)?;
    twap.placed = true;
    Some(twap)
}

impl Executor for NativeTwap {
    fn decide(&mut self, cx: &Ctx<'_>) -> Decision {
        if !self.placed {
            self.placed = true;
            let request = OrderRequest {
                market: cx.spec.market.clone(),
                side: cx.spec.side,
                size: cx.spec.size,
                reduce_only: cx.spec.reduce_only,
                collateral: None,
                client_id: None,
                take_profit: None,
                stop_loss: None,
                kind: OrderKind::Twap {
                    minutes: self.minutes,
                    randomize: self.randomize,
                },
            };
            return Decision {
                acts: vec![Act::Place { tag: 0, request }],
                wake: Some(cx.now + CHECK_EVERY_MS),
                ..Decision::default()
            };
        }
        let filled: D = cx.mine.iter().map(|m| m.filled).sum();
        // Refused by the venue: nothing is running there.
        if cx.mine.iter().all(|m| !m.open) && filled <= D::ZERO {
            return Decision {
                outcome: Some(Outcome::Stopped("venueError")),
                ..Decision::default()
            };
        }
        if filled >= cx.spec.size.0 || cx.now >= self.duration + GRACE_MS {
            return Decision {
                outcome: Some(Outcome::Finished),
                ..Decision::default()
            };
        }
        Decision {
            wake: Some(cx.now + CHECK_EVERY_MS),
            ..Decision::default()
        }
    }

    fn ends_at(&self) -> Option<u64> {
        Some(self.duration)
    }

    fn needs_book(&self) -> bool {
        false
    }
}

#[cfg(test)]
mod tests {
    use pewterdesk_core::{Decimal, Side, Unfilled};

    use super::*;

    fn spec(venue: VenueId, style: SliceStyle, duration_ms: u64, native: bool) -> AlgoSpec {
        AlgoSpec {
            venue,
            account: "0x".into(),
            market: "BTC".into(),
            side: Side::Buy,
            size: Decimal("1".parse().unwrap()),
            reduce_only: false,
            max_slippage_bps: 300,
            prefer_native: native,
            kind: AlgoKind::Twap {
                duration_ms,
                slices: 10,
                randomize: true,
                style,
                unfilled: Unfilled::Market,
            },
        }
    }

    #[test]
    fn native_only_where_the_venue_does_what_was_asked() {
        let hour = 3_600_000;
        assert!(twap(&spec(VenueId::Hyperliquid, SliceStyle::Market, hour, true)).is_some());
        // Turned off, another venue, chased slices, too short or too long.
        assert!(twap(&spec(VenueId::Hyperliquid, SliceStyle::Market, hour, false)).is_none());
        assert!(twap(&spec(VenueId::Bybit, SliceStyle::Market, hour, true)).is_none());
        assert!(twap(&spec(VenueId::Hyperliquid, SliceStyle::Chaser, hour, true)).is_none());
        assert!(twap(&spec(
            VenueId::Hyperliquid,
            SliceStyle::Market,
            60_000,
            true
        ))
        .is_none());
        assert!(twap(&spec(
            VenueId::Hyperliquid,
            SliceStyle::Market,
            8 * 24 * hour,
            true
        ))
        .is_none());
        // Minutes round up: 90 seconds isn't enough, 5m30s is 6 minutes.
        let six = twap(&spec(
            VenueId::Hyperliquid,
            SliceStyle::Market,
            330_000,
            true,
        ))
        .unwrap();
        assert_eq!(six.minutes, 6);
    }
}
