//! Candles of several months, built from monthly ones: no venue serves 3, 6
//! or 12 months. Groups follow the calendar (UTC), as on TradingView:
//! quarters start in January, April, July and October, halves in January
//! and July, years in January.

use std::collections::BTreeMap;

use crate::{Candle, Decimal};

const DAY: u64 = 86_400_000;

/// The UTC year and month (1-12) of a time in milliseconds since the epoch.
fn year_month(ms: u64) -> (i64, u32) {
    // Howard Hinnant's civil_from_days.
    let z = (ms / DAY) as i64 + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let month = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    let year = yoe + era * 400 + i64::from(month <= 2);
    (year, month)
}

/// Midnight UTC on the first of `month` (1-12) of `year`, in milliseconds.
fn month_start(year: i64, month: u32) -> u64 {
    // Howard Hinnant's days_from_civil.
    let y = if month <= 2 { year - 1 } else { year };
    let era = y.div_euclid(400);
    let yoe = y - era * 400;
    let m = i64::from(month);
    let doy = (153 * (if m > 2 { m - 3 } else { m + 9 }) + 2) / 5;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    let days = era * 146_097 + doe - 719_468;
    days.max(0) as u64 * DAY
}

/// When the `months`-long group holding `ms` opens, and whether `ms` is its
/// first month.
fn group_open(ms: u64, months: u32) -> (u64, bool) {
    let (year, month) = year_month(ms);
    let first = (month - 1) / months * months + 1;
    (month_start(year, first), month == first)
}

fn merge_into(group: &mut Candle, part: &Candle) {
    group.high = group.high.max(part.high);
    group.low = group.low.min(part.low);
    group.close = part.close;
    group.volume = Decimal(group.volume.0 + part.volume.0);
}

/// `months`-long candles from monthly ones (oldest first), each opening on
/// its group's first month. The oldest group is dropped when its first
/// month is missing, since it would open late - unless that's the market's
/// first month (`complete`: the venue had nothing older), where it's all
/// there is. The newest may be still forming, which is right.
pub fn group_months(parts: &[Candle], months: u32, complete: bool) -> Vec<Candle> {
    let mut out: Vec<Candle> = Vec::new();
    for part in parts {
        let (open, _) = group_open(part.open_time, months);
        match out.last_mut() {
            Some(last) if last.open_time == open => merge_into(last, part),
            _ => out.push(Candle {
                open_time: open,
                ..part.clone()
            }),
        }
    }
    if !complete
        && parts
            .first()
            .is_some_and(|p| !group_open(p.open_time, months).1)
    {
        out.remove(0);
    }
    out
}

/// Monthly candles as they stream in, turned into `months`-long ones: each
/// update re-emits the groups it touched, whole.
pub struct MonthGroups {
    months: u32,
    parts: BTreeMap<u64, Candle>,
}

impl MonthGroups {
    /// Starts from the monthly history (oldest first), which is kept to
    /// rebuild the groups that later updates touch.
    pub fn new(months: u32, history: &[Candle]) -> Self {
        Self {
            months,
            parts: history.iter().map(|c| (c.open_time, c.clone())).collect(),
        }
    }

    /// Takes monthly candles in and returns the groups they fall in, oldest
    /// first.
    pub fn update(&mut self, candles: Vec<Candle>) -> Vec<Candle> {
        let mut opens: Vec<u64> = Vec::new();
        for c in candles {
            let (open, _) = group_open(c.open_time, self.months);
            if !opens.contains(&open) {
                opens.push(open);
            }
            self.parts.insert(c.open_time, c);
        }
        opens.sort_unstable();
        opens
            .into_iter()
            .filter_map(|open| {
                let group: Vec<Candle> = self
                    .parts
                    .range(open..)
                    .map(|(_, c)| c)
                    .take_while(|c| group_open(c.open_time, self.months).0 == open)
                    .cloned()
                    .collect();
                group_months(&group, self.months, true).into_iter().next()
            })
            .collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn d(n: i64) -> Decimal {
        Decimal(rust_decimal::Decimal::from(n))
    }

    fn month(year: i64, m: u32, open: i64, high: i64, low: i64, close: i64) -> Candle {
        Candle {
            open_time: month_start(year, m),
            open: d(open),
            high: d(high),
            low: d(low),
            close: d(close),
            volume: d(1),
        }
    }

    #[test]
    fn calendar_round_trips() {
        assert_eq!(month_start(1970, 1), 0);
        // 2024-03-01T00:00:00Z, after a leap February.
        assert_eq!(month_start(2024, 3), 1_709_251_200_000);
        for (y, m) in [(2000, 2), (2023, 12), (2024, 1), (2024, 2), (2100, 3)] {
            assert_eq!(year_month(month_start(y, m)), (y, m));
            assert_eq!(year_month(month_start(y, m) + 27 * DAY), (y, m));
        }
    }

    #[test]
    fn quarters_open_in_january_april_july_and_october() {
        let parts = [
            month(2024, 2, 5, 6, 4, 5),
            month(2024, 3, 5, 7, 4, 6),
            month(2024, 4, 6, 9, 5, 8),
            month(2024, 5, 8, 8, 2, 3),
            month(2024, 6, 3, 4, 3, 4),
            month(2024, 7, 4, 5, 4, 5),
        ];
        // February starts the list mid-quarter, so Q1 is dropped.
        let q = group_months(&parts, 3, false);
        assert_eq!(q.len(), 2);
        assert_eq!(q[0].open_time, month_start(2024, 4));
        assert_eq!(
            (q[0].open, q[0].high, q[0].low, q[0].close),
            (d(6), d(9), d(2), d(4))
        );
        assert_eq!(q[0].volume, d(3));
        assert_eq!(q[1].open_time, month_start(2024, 7));
        // A market that began in February: its first quarter is all there is.
        assert_eq!(
            group_months(&parts, 3, true)[0].open_time,
            month_start(2024, 1)
        );
        let years = group_months(&parts, 12, true);
        assert_eq!(years.len(), 1);
        assert_eq!(years[0].open_time, month_start(2024, 1));
    }

    #[test]
    fn updates_re_emit_their_whole_group() {
        let mut groups =
            MonthGroups::new(6, &[month(2024, 7, 1, 3, 1, 2), month(2024, 8, 2, 4, 2, 3)]);
        let out = groups.update(vec![month(2024, 9, 3, 10, 0, 9)]);
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].open_time, month_start(2024, 7));
        assert_eq!(
            (out[0].open, out[0].high, out[0].low, out[0].close),
            (d(1), d(10), d(0), d(9))
        );
        let next = groups.update(vec![month(2025, 1, 9, 9, 9, 9)]);
        assert_eq!(next[0].open_time, month_start(2025, 1));
    }
}
