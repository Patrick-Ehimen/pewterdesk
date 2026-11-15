//! Indicators, a candle at a time: each takes the next closed candle and
//! gives its value once it has enough history. The same definitions as the
//! Bots page's (`apps/desktop/src/lib/backtest.ts`).

use crate::Bar;

/// One indicator's running state.
#[derive(Clone, Debug)]
pub enum Line {
    /// The close itself.
    Price,
    /// A fixed number.
    Value(f64),
    /// An exponential average, seeded with the simple average of its first `period`.
    Ema {
        period: usize,
        seen: usize,
        sum: f64,
        value: Option<f64>,
    },
    /// A simple average over the last `period` closes.
    Sma {
        period: usize,
        window: std::collections::VecDeque<f64>,
        sum: f64,
    },
    /// Wilder's RSI, 0 to 100.
    Rsi {
        period: usize,
        seen: usize,
        prev: Option<f64>,
        gain: f64,
        loss: f64,
    },
    /// Wilder's average true range.
    Atr {
        period: usize,
        seen: usize,
        prev_close: Option<f64>,
        value: Option<f64>,
    },
}

impl Line {
    pub fn ema(period: usize) -> Self {
        Line::Ema {
            period: period.max(1),
            seen: 0,
            sum: 0.0,
            value: None,
        }
    }

    pub fn sma(period: usize) -> Self {
        Line::Sma {
            period: period.max(1),
            window: Default::default(),
            sum: 0.0,
        }
    }

    pub fn rsi(period: usize) -> Self {
        Line::Rsi {
            period: period.max(1),
            seen: 0,
            prev: None,
            gain: 0.0,
            loss: 0.0,
        }
    }

    pub fn atr(period: usize) -> Self {
        Line::Atr {
            period: period.max(1),
            seen: 0,
            prev_close: None,
            value: None,
        }
    }

    /// Takes the next candle; its value, once there's enough history.
    pub fn push(&mut self, bar: &Bar) -> Option<f64> {
        let close = bar.close;
        match self {
            Line::Price => Some(close),
            Line::Value(v) => Some(*v),
            Line::Ema {
                period,
                seen,
                sum,
                value,
            } => {
                *seen += 1;
                if *seen < *period {
                    *sum += close;
                    return None;
                }
                *value = Some(match *value {
                    None => (*sum + close) / *period as f64,
                    Some(prev) => {
                        let k = 2.0 / (*period as f64 + 1.0);
                        close * k + prev * (1.0 - k)
                    }
                });
                *value
            }
            Line::Sma {
                period,
                window,
                sum,
            } => {
                window.push_back(close);
                *sum += close;
                if window.len() > *period {
                    *sum -= window.pop_front().unwrap_or(0.0);
                }
                (window.len() == *period).then(|| *sum / *period as f64)
            }
            Line::Rsi {
                period,
                seen,
                prev,
                gain,
                loss,
            } => {
                let before = prev.replace(close)?;
                *seen += 1;
                let change = close - before;
                let (up, down) = (change.max(0.0), (-change).max(0.0));
                let p = *period as f64;
                if *seen <= *period {
                    *gain += up / p;
                    *loss += down / p;
                } else {
                    *gain = (*gain * (p - 1.0) + up) / p;
                    *loss = (*loss * (p - 1.0) + down) / p;
                }
                if *seen < *period {
                    return None;
                }
                Some(if *loss == 0.0 {
                    100.0
                } else {
                    100.0 - 100.0 / (1.0 + *gain / *loss)
                })
            }
            Line::Atr {
                period,
                seen,
                prev_close,
                value,
            } => {
                let prev = prev_close.replace(close).unwrap_or(close);
                let tr = (bar.high - bar.low)
                    .max((bar.high - prev).abs())
                    .max((bar.low - prev).abs());
                *seen += 1;
                let p = *period as f64;
                *value = Some(match *value {
                    None => tr,
                    Some(v) => (v * (p - 1.0) + tr) / p,
                });
                (*seen >= *period).then_some(value.unwrap_or(tr))
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn bar(close: f64) -> Bar {
        Bar {
            time: 0,
            open: close,
            high: close,
            low: close,
            close,
        }
    }

    fn run(mut line: Line, closes: &[f64]) -> Vec<Option<f64>> {
        closes.iter().map(|c| line.push(&bar(*c))).collect()
    }

    #[test]
    fn an_ema_starts_from_its_simple_average() {
        let out = run(Line::ema(3), &[1.0, 2.0, 3.0, 4.0]);
        assert_eq!(out[..2], [None, None]);
        assert_eq!(out[2], Some(2.0));
        assert_eq!(out[3], Some(3.0)); // 4 * 0.5 + 2 * 0.5
    }

    #[test]
    fn an_sma_averages_its_window() {
        assert_eq!(
            run(Line::sma(2), &[1.0, 3.0, 5.0]),
            [None, Some(2.0), Some(4.0)]
        );
    }

    #[test]
    fn rsi_is_100_with_no_losses_and_waits_for_its_period() {
        let out = run(Line::rsi(3), &[1.0, 2.0, 3.0, 4.0, 5.0]);
        assert_eq!(out[..3], [None, None, None]);
        assert_eq!(out[3], Some(100.0));
        let mixed = run(Line::rsi(2), &[10.0, 11.0, 10.0]);
        assert_eq!(mixed[2], Some(50.0));
    }
}
