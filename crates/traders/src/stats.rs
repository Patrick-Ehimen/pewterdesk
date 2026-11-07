//! A trader's record at a glance, for the leaderboard: green weeks, max
//! drawdown, the month's PnL line and how much of it one day made. The same
//! arithmetic for both sources, over the PnL history each one publishes.

use serde::Serialize;

const DAY: u64 = 86_400_000;
const WEEK: u64 = 7 * DAY;
/// Weeks shown as green or red.
pub const WEEKS: usize = 8;

#[derive(Clone, Debug, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TraderStats {
    /// PnL week by week, the last `WEEKS` (oldest first); `None` for a week
    /// before their history starts.
    pub weeks: Vec<Option<f64>>,
    /// The largest fall from a peak over the month, as a fraction of what
    /// they had at that peak (0.18 is 18%).
    pub max_drawdown: Option<f64>,
    /// Cumulative PnL over the month: (ms since the epoch, USD), oldest first.
    pub curve: Vec<(u64, f64)>,
    /// The share of the month's PnL made in its best step (a day, about),
    /// when the month's PnL is above zero. Over 0.5: one day carried it.
    pub best_day_share: Option<f64>,
}

/// The cumulative value at `t`: the last point at or before it, 0 before the first.
fn at(points: &[(u64, f64)], t: u64) -> f64 {
    points
        .iter()
        .take_while(|(pt, _)| *pt <= t)
        .last()
        .map_or(0.0, |(_, v)| *v)
}

/// Week by week PnL from a cumulative history, the `WEEKS` weeks up to `now`.
pub fn weeks_from_cumulative(points: &[(u64, f64)], now: u64) -> Vec<Option<f64>> {
    let Some(&(first, _)) = points.first() else {
        return vec![None; WEEKS];
    };
    (0..WEEKS)
        .map(|k| {
            let start = now.saturating_sub((WEEKS - k) as u64 * WEEK);
            let end = start + WEEK;
            (end >= first).then(|| at(points, end) - at(points, start))
        })
        .collect()
}

/// Weekly figures given as (week start, PnL), any order: the last `WEEKS` up to `now`.
pub fn weeks_from_weekly(weekly: &[(u64, f64)], now: u64) -> Vec<Option<f64>> {
    (0..WEEKS)
        .map(|k| {
            let start = now.saturating_sub((WEEKS - k) as u64 * WEEK);
            let end = start + WEEK;
            weekly
                .iter()
                .find(|(t, _)| *t >= start && *t < end)
                .map(|(_, v)| *v)
        })
        .collect()
}

/// The largest fall from a peak of `pnl`, as a fraction of `base(t)` at
/// that peak (what the trader had then). `None` without a base to measure by.
pub fn max_drawdown(pnl: &[(u64, f64)], base: impl Fn(u64) -> f64) -> Option<f64> {
    // The peak so far, and what they had then.
    let mut peak: Option<(f64, f64)> = None;
    let mut worst: Option<f64> = None;
    for &(t, v) in pnl {
        if peak.is_none_or(|(p, _)| v > p) {
            peak = Some((v, base(t)));
        }
        if let Some((p, b)) = peak.filter(|(_, b)| *b > 0.0) {
            let dd = ((p - v) / b).max(0.0);
            worst = Some(worst.map_or(dd, |w: f64| w.max(dd)));
        }
    }
    worst
}

/// The share of the period's PnL made in its single best step.
pub fn best_step_share(curve: &[(u64, f64)]) -> Option<f64> {
    let (first, last) = (curve.first()?.1, curve.last()?.1);
    let total = last - first;
    if total <= 0.0 {
        return None;
    }
    let best = curve
        .windows(2)
        .map(|w| w[1].1 - w[0].1)
        .fold(0.0_f64, f64::max);
    Some(best / total)
}

#[cfg(test)]
mod tests {
    use super::*;

    const NOW: u64 = 100 * WEEK;

    #[test]
    fn weeks_from_a_cumulative_history() {
        // Weekly points: +10 a week, then -5 in the last week.
        let mut points: Vec<(u64, f64)> = (0..=10)
            .map(|i| (NOW - (10 - i) * WEEK, i as f64 * 10.0))
            .collect();
        points.last_mut().unwrap().1 = 85.0;
        let weeks = weeks_from_cumulative(&points, NOW);
        assert_eq!(weeks.len(), WEEKS);
        assert_eq!(weeks[0], Some(10.0));
        assert_eq!(weeks[WEEKS - 1], Some(-5.0));
        // History that starts 3 weeks ago: the weeks before it are unknown.
        let young = [(NOW - 3 * WEEK, 0.0), (NOW, 30.0)];
        let w = weeks_from_cumulative(&young, NOW);
        assert_eq!(w.iter().filter(|x| x.is_none()).count(), 4);
        assert_eq!(w[WEEKS - 1], Some(30.0));
        assert_eq!(weeks_from_cumulative(&[], NOW), vec![None; WEEKS]);
    }

    #[test]
    fn weeks_from_weekly_figures() {
        let weekly = [(NOW - WEEK, -3.0), (NOW - 3 * WEEK, 7.0)];
        let w = weeks_from_weekly(&weekly, NOW);
        assert_eq!(w[WEEKS - 1], Some(-3.0));
        assert_eq!(w[WEEKS - 3], Some(7.0));
        assert_eq!(w[WEEKS - 2], None);
    }

    #[test]
    fn drawdown_is_measured_against_what_they_had_at_the_peak() {
        // Up to 200 on a 1,000 account, down to 20: a 180 fall from 1,000.
        let pnl = [(1, 0.0), (2, 200.0), (3, 20.0), (4, 150.0)];
        let dd = max_drawdown(&pnl, |_| 1000.0).unwrap();
        assert!((dd - 0.18).abs() < 1e-12);
        assert_eq!(max_drawdown(&[(1, 0.0), (2, 5.0)], |_| 100.0), Some(0.0));
        assert_eq!(max_drawdown(&pnl, |_| 0.0), None);
    }

    #[test]
    fn one_day_carrying_the_month() {
        let curve = [(1, 0.0), (2, 10.0), (3, 80.0), (4, 100.0)];
        assert!((best_step_share(&curve).unwrap() - 0.7).abs() < 1e-12);
        assert_eq!(best_step_share(&[(1, 0.0), (2, -5.0)]), None);
        assert_eq!(best_step_share(&[]), None);
    }
}
