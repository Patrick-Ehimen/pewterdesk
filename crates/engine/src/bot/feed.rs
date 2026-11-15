//! Closed candles, from a venue's candle stream: it sends the recent
//! history, then each candle again, whole, as it changes; a candle has
//! closed once the next one opens. Each closed candle is recorded, so a
//! paper bot can be picked up after a restart and a backtest has history.

use std::sync::Arc;

use pewterdesk_core::{Candle, CandleInterval, ExchangeAdapter, VenueError, VenueId};
use pewterdesk_store::{Recorder, StoredCandle};
use pewterdesk_strategy::Bar;
use tokio::sync::mpsc;

fn stored(c: &Candle) -> StoredCandle {
    StoredCandle {
        open_time: c.open_time,
        open: c.open.0.to_string(),
        high: c.high.0.to_string(),
        low: c.low.0.to_string(),
        close: c.close.0.to_string(),
        volume: c.volume.0.to_string(),
    }
}

pub(crate) fn venue_name(venue: VenueId) -> String {
    serde_json::to_value(venue)
        .ok()
        .and_then(|v| v.as_str().map(str::to_owned))
        .unwrap_or_default()
}

pub(crate) fn interval_name(interval: CandleInterval) -> String {
    serde_json::to_value(interval)
        .ok()
        .and_then(|v| v.as_str().map(str::to_owned))
        .unwrap_or_default()
}

/// Where a feed records what it sees.
#[derive(Clone)]
pub struct Recording {
    pub recorder: Arc<Recorder>,
    pub venue: VenueId,
    pub market: String,
    pub interval: CandleInterval,
}

impl Recording {
    fn keep(&self, candles: &[Candle]) {
        let rows: Vec<StoredCandle> = candles.iter().map(stored).collect();
        let _ = self.recorder.save(
            &venue_name(self.venue),
            &self.market,
            &interval_name(self.interval),
            &rows,
        );
    }
}

/// The candles kept for a market, from `from` on, as bars.
pub fn recorded(rec: &Recording, from: u64, to: u64) -> Vec<Bar> {
    rec.recorder
        .range(
            &venue_name(rec.venue),
            &rec.market,
            &interval_name(rec.interval),
            from,
            to,
        )
        .unwrap_or_default()
        .iter()
        .filter_map(|c| {
            let f = |s: &str| s.parse::<f64>().ok();
            Some(Bar {
                time: c.open_time,
                open: f(&c.open)?,
                high: f(&c.high)?,
                low: f(&c.low)?,
                close: f(&c.close)?,
            })
        })
        .collect()
}

/// The market's history (closed candles, oldest first) and, from then on,
/// each candle as it closes. Ends when the venue's stream does.
pub async fn closed(
    adapter: &dyn ExchangeAdapter,
    market: &str,
    interval: CandleInterval,
    recording: Option<Recording>,
) -> Result<(Vec<Bar>, mpsc::Receiver<Bar>), VenueError> {
    let mut stream = adapter.subscribe_candles(market, interval).await?;
    let mut history = stream.recv().await.unwrap_or_default();
    history.sort_by_key(|c| c.open_time);
    // The last is still forming.
    let mut forming = history.pop();
    if let Some(rec) = &recording {
        rec.keep(&history);
    }
    let bars = history.iter().filter_map(Bar::from_candle).collect();
    let (tx, rx) = mpsc::channel(64);
    tokio::spawn(async move {
        while let Some(update) = stream.recv().await {
            let mut update = update;
            update.sort_by_key(|c| c.open_time);
            for candle in update {
                match &forming {
                    Some(f) if candle.open_time < f.open_time => continue,
                    Some(f) if candle.open_time > f.open_time => {
                        // The forming one has closed.
                        let done = f.clone();
                        if let Some(rec) = &recording {
                            rec.keep(std::slice::from_ref(&done));
                        }
                        if let Some(bar) = Bar::from_candle(&done) {
                            if tx.send(bar).await.is_err() {
                                return;
                            }
                        }
                        forming = Some(candle);
                    }
                    _ => forming = Some(candle),
                }
            }
        }
    });
    Ok((bars, rx))
}
