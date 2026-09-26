//! A market's recent trades, kept so the `trades` channel — which pushes only
//! new prints — can be re-emitted as a snapshot like every other stream.

use std::collections::VecDeque;

use pewterdesk_core::Trade;

/// Trades kept per subscription.
pub const TAPE_LEN: usize = 100;

#[derive(Default)]
pub struct Tape {
    /// Newest first.
    trades: VecDeque<Trade>,
}

impl Tape {
    /// Adds `incoming` and returns whether anything was new. A reconnect
    /// replays recent trades, so ids already on the tape are skipped.
    pub fn record(&mut self, mut incoming: Vec<Trade>) -> bool {
        // Oldest first, so each push_front leaves the newest at the front.
        incoming.sort_by_key(|t| t.time);
        let mut changed = false;
        for trade in incoming {
            if self.trades.iter().any(|t| t.id == trade.id) {
                continue;
            }
            // A replayed trade can be older than the front; keep time order.
            let at = self.trades.iter().position(|t| t.time <= trade.time);
            match at {
                Some(i) => self.trades.insert(i, trade),
                None => self.trades.push_back(trade),
            }
            changed = true;
        }
        self.trades.truncate(TAPE_LEN);
        changed
    }

    /// Newest first.
    pub fn snapshot(&self) -> Vec<Trade> {
        self.trades.iter().cloned().collect()
    }
}

#[cfg(test)]
mod tests {
    use pewterdesk_core::{Decimal, Side};

    use super::*;

    fn trade(id: u64, time: u64) -> Trade {
        Trade {
            market: "BTC".into(),
            id: id.to_string(),
            side: Side::Buy,
            price: Decimal::default(),
            size: Decimal::default(),
            time,
        }
    }

    fn ids(tape: &Tape) -> Vec<String> {
        tape.snapshot().into_iter().map(|t| t.id).collect()
    }

    #[test]
    fn keeps_newest_first() {
        let mut tape = Tape::default();
        assert!(tape.record(vec![trade(1, 10), trade(3, 30), trade(2, 20)]));
        assert!(tape.record(vec![trade(4, 40)]));
        assert_eq!(ids(&tape), ["4", "3", "2", "1"]);
    }

    #[test]
    fn skips_trades_it_already_has() {
        let mut tape = Tape::default();
        tape.record(vec![trade(1, 10), trade(2, 20)]);
        assert!(!tape.record(vec![trade(1, 10), trade(2, 20)]));
        assert_eq!(ids(&tape), ["2", "1"]);
    }

    #[test]
    fn slots_a_late_replay_into_time_order() {
        let mut tape = Tape::default();
        tape.record(vec![trade(1, 10), trade(3, 30)]);
        tape.record(vec![trade(2, 20)]);
        assert_eq!(ids(&tape), ["3", "2", "1"]);
    }

    #[test]
    fn caps_the_tape() {
        let mut tape = Tape::default();
        tape.record((0..TAPE_LEN as u64 + 10).map(|i| trade(i, i)).collect());
        let snapshot = tape.snapshot();
        assert_eq!(snapshot.len(), TAPE_LEN);
        assert_eq!(snapshot[0].id, (TAPE_LEN + 9).to_string());
    }
}
