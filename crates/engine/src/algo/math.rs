//! The arithmetic algos share: rounding to a market's tick and step, a
//! ladder's prices and sizes, and a TWAP's slices and their times.

use pewterdesk_core::{Distribution, Market, Side};
use rust_decimal::prelude::*;
use rust_decimal::Decimal as D;

/// `value` rounded down to a multiple of `step` (a size never grows).
pub fn floor_to(value: D, step: D) -> D {
    if step <= D::ZERO {
        return value;
    }
    (value / step).floor() * step
}

/// `price` on `tick`, rounded the way that never pays more: down for a buy,
/// up for a sell.
pub fn to_tick(price: D, tick: D, side: Side) -> D {
    if tick <= D::ZERO {
        return price;
    }
    let ticks = price / tick;
    let whole = match side {
        Side::Buy => ticks.floor(),
        Side::Sell => ticks.ceil(),
    };
    (whole * tick).normalize()
}

/// The market's tick, step and minimum as numbers.
pub struct Rules {
    pub tick: D,
    pub step: D,
    pub min: D,
}

impl From<&Market> for Rules {
    fn from(market: &Market) -> Self {
        Self {
            tick: market.tick_size.0,
            step: market.size_step.0,
            min: market.min_size.0,
        }
    }
}

/// A ladder of `count` orders from `from` to `to` sharing `size`: each
/// level's price (on the tick) and size (on the step, at least the minimum).
/// Levels too small to place are dropped and their share goes to the
/// others; the last level takes what rounding left over.
pub fn ladder(
    size: D,
    from: D,
    to: D,
    count: u32,
    distribution: Distribution,
    side: Side,
    rules: &Rules,
) -> Vec<(D, D)> {
    let count = count.max(1);
    let weights: Vec<D> = (0..count)
        .map(|i| {
            let i = D::from(i + 1);
            match distribution {
                Distribution::Flat => D::ONE,
                // More at the far end: weights grow towards `to`.
                Distribution::MoreFar => i,
                Distribution::MoreNear => D::from(count + 1) - i,
            }
        })
        .collect();
    let total: D = weights.iter().sum();
    let price_at = |i: u32| {
        if count == 1 {
            from
        } else {
            from + (to - from) * D::from(i) / D::from(count - 1)
        }
    };
    let mut levels: Vec<(D, D)> = Vec::new();
    let mut placed = D::ZERO;
    for (i, weight) in weights.iter().enumerate() {
        let share = floor_to(size * weight / total, rules.step);
        if share < rules.min || share <= D::ZERO {
            continue;
        }
        levels.push((to_tick(price_at(i as u32), rules.tick, side), share));
        placed += share;
    }
    // Rounding's leftovers go on the last level.
    let rest = floor_to(size - placed, rules.step);
    match levels.last_mut() {
        Some(last) => last.1 += rest,
        None if rest >= rules.min && rest > D::ZERO => {
            levels.push((to_tick(from, rules.tick, side), rest))
        }
        None => {}
    }
    levels
}

/// A TWAP's slices: `slices` sizes on the step summing to `size` (the last
/// takes what rounding left), dropping any below the minimum.
pub fn slices(size: D, slices: u32, rules: &Rules) -> Vec<D> {
    let n = slices.max(1);
    let each = floor_to(size / D::from(n), rules.step);
    let mut out: Vec<D> = Vec::new();
    if each >= rules.min && each > D::ZERO {
        out = vec![each; n as usize];
    }
    let rest = floor_to(size - each * D::from(out.len() as u32), rules.step);
    match out.last_mut() {
        Some(last) => *last += rest,
        None if rest > D::ZERO => out.push(rest),
        None => {}
    }
    out
}

/// When each of `n` slices goes, in ms from the start, over `duration_ms`:
/// evenly spaced, the first at once. With `jitter` each moves by up to a
/// fifth of the spacing (never before the start or past the end), from a
/// seed so a run can be repeated.
pub fn schedule(n: usize, duration_ms: u64, jitter: bool, seed: u64) -> Vec<u64> {
    if n == 0 {
        return Vec::new();
    }
    let spacing = duration_ms / n as u64;
    let mut state = seed | 1;
    (0..n as u64)
        .map(|i| {
            let at = i * spacing;
            if !jitter || i == 0 || spacing < 5 {
                return at;
            }
            // xorshift: small, deterministic, good enough for spreading.
            state ^= state << 13;
            state ^= state >> 7;
            state ^= state << 17;
            let span = spacing / 5;
            let shift = state % (2 * span + 1);
            (at + shift).saturating_sub(span).min(duration_ms)
        })
        .collect()
}

/// `price` against `start`, in basis points, signed so that positive is
/// worse for the trader: paid more on a buy, received less on a sell.
pub fn slippage_bps(start: D, price: D, side: Side) -> Option<f64> {
    if start <= D::ZERO {
        return None;
    }
    let raw = (price - start) / start * D::from(10_000);
    let signed = match side {
        Side::Buy => raw,
        Side::Sell => -raw,
    };
    signed.to_f64()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn d(s: &str) -> D {
        s.parse().unwrap()
    }

    fn rules() -> Rules {
        Rules {
            tick: d("0.1"),
            step: d("0.01"),
            min: d("0.01"),
        }
    }

    #[test]
    fn rounding_never_grows_a_size_or_pays_more() {
        assert_eq!(floor_to(d("1.239"), d("0.01")), d("1.23"));
        assert_eq!(to_tick(d("100.07"), d("0.1"), Side::Buy), d("100"));
        assert_eq!(to_tick(d("100.01"), d("0.1"), Side::Sell), d("100.1"));
    }

    #[test]
    fn a_ladder_spends_the_whole_size_on_the_step() {
        for distribution in [
            Distribution::Flat,
            Distribution::MoreFar,
            Distribution::MoreNear,
        ] {
            let levels = ladder(
                d("1"),
                d("100"),
                d("95"),
                5,
                distribution,
                Side::Buy,
                &rules(),
            );
            assert_eq!(levels.len(), 5, "{distribution:?}");
            let total: D = levels.iter().map(|(_, size)| *size).sum();
            assert_eq!(total, d("1"), "{distribution:?}");
            assert_eq!(levels[0].0, d("100"));
            assert_eq!(levels[4].0, d("95"));
        }
        let far = ladder(
            d("1"),
            d("100"),
            d("95"),
            5,
            Distribution::MoreFar,
            Side::Buy,
            &rules(),
        );
        assert!(far[4].1 > far[0].1);
        // Too small to split five ways: fewer, bigger levels.
        let thin = ladder(
            d("0.03"),
            d("100"),
            d("95"),
            5,
            Distribution::Flat,
            Side::Buy,
            &rules(),
        );
        assert_eq!(thin.iter().map(|(_, s)| *s).sum::<D>(), d("0.03"));
        assert!(thin.len() < 5);
    }

    #[test]
    fn slices_add_up_and_respect_the_minimum() {
        let s = slices(d("1"), 3, &rules());
        assert_eq!(s, [d("0.33"), d("0.33"), d("0.34")]);
        assert_eq!(slices(d("0.005"), 3, &rules()), Vec::<D>::new());
        assert_eq!(slices(d("0.02"), 5, &rules()), [d("0.02")]);
    }

    #[test]
    fn a_schedule_spans_the_duration_and_jitters_within_it() {
        assert_eq!(schedule(4, 1000, false, 1), [0, 250, 500, 750]);
        let jittered = schedule(4, 1000, true, 42);
        assert_eq!(jittered[0], 0);
        for (i, at) in jittered.iter().enumerate().skip(1) {
            let even = i as u64 * 250;
            assert!(at.abs_diff(even) <= 50, "{at} vs {even}");
        }
        assert_eq!(jittered, schedule(4, 1000, true, 42));
    }

    #[test]
    fn slippage_is_positive_when_worse() {
        assert_eq!(slippage_bps(d("100"), d("101"), Side::Buy), Some(100.0));
        assert_eq!(slippage_bps(d("100"), d("101"), Side::Sell), Some(-100.0));
    }
}
