//! A market's order book kept locally from a REST snapshot and the
//! `@depth@100ms` diff stream, as Binance's "How to manage a local order
//! book correctly" lays out: diffs older than the snapshot are dropped, the
//! first one kept must straddle it, and each after that must follow on from
//! the one before (`pu` is the previous `u`). Anything else is a gap, and
//! the book starts again from a fresh snapshot.

use std::collections::BTreeMap;

use pewterdesk_core::{BookLevel, Decimal, OrderBook};
use rust_decimal::Decimal as RawDecimal;

use crate::wire::{Depth, DepthDiff};

/// What a diff did to the book.
#[derive(Debug, PartialEq, Eq)]
pub enum Applied {
    /// It changed the book.
    Changed,
    /// It's from before the snapshot: nothing to do.
    Stale,
    /// It doesn't follow on: the book needs a fresh snapshot.
    Gap,
}

#[derive(Default)]
pub struct Book {
    bids: BTreeMap<RawDecimal, Decimal>,
    asks: BTreeMap<RawDecimal, Decimal>,
    /// The snapshot's update id, until the first diff is applied.
    snapshot_id: Option<u64>,
    /// The last applied diff's `u`.
    last: Option<u64>,
    time: u64,
}

fn set(side: &mut BTreeMap<RawDecimal, Decimal>, levels: &[(Decimal, Decimal)]) {
    for &(price, size) in levels {
        if size.0.is_zero() {
            side.remove(&price.0);
        } else {
            side.insert(price.0, size);
        }
    }
}

impl Book {
    /// Starts again from `depth`.
    pub fn reset(&mut self, depth: &Depth) {
        self.bids.clear();
        self.asks.clear();
        set(&mut self.bids, &depth.bids);
        set(&mut self.asks, &depth.asks);
        self.snapshot_id = Some(depth.last_update_id);
        self.last = None;
        self.time = depth.time;
    }

    pub fn apply(&mut self, diff: &DepthDiff) -> Applied {
        match (self.last, self.snapshot_id) {
            (Some(last), _) => {
                if diff.prev != last {
                    return Applied::Gap;
                }
            }
            (None, Some(id)) => {
                if diff.last < id {
                    return Applied::Stale;
                }
                if diff.first > id {
                    return Applied::Gap;
                }
            }
            (None, None) => return Applied::Gap,
        }
        set(&mut self.bids, &diff.bids);
        set(&mut self.asks, &diff.asks);
        self.last = Some(diff.last);
        self.time = diff.time;
        Applied::Changed
    }

    /// The top `depth` levels a side, best first.
    pub fn snapshot(&self, market: &str, depth: usize) -> OrderBook {
        let level = |(price, size): (&RawDecimal, &Decimal)| BookLevel {
            price: Decimal(*price),
            size: *size,
        };
        OrderBook {
            market: market.to_owned(),
            bids: self.bids.iter().rev().take(depth).map(level).collect(),
            asks: self.asks.iter().take(depth).map(level).collect(),
            time: self.time,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn d(s: &str) -> Decimal {
        Decimal(s.parse().unwrap())
    }

    fn depth(id: u64) -> Depth {
        Depth {
            last_update_id: id,
            time: 1,
            bids: vec![(d("100"), d("1")), (d("99"), d("2"))],
            asks: vec![(d("101"), d("1")), (d("102"), d("3"))],
        }
    }

    fn diff(first: u64, last: u64, prev: u64, bids: &[(&str, &str)]) -> DepthDiff {
        DepthDiff {
            first,
            last,
            prev,
            time: last,
            bids: bids.iter().map(|(p, s)| (d(p), d(s))).collect(),
            asks: vec![],
        }
    }

    #[test]
    fn follows_on_from_the_snapshot() {
        let mut book = Book::default();
        book.reset(&depth(100));
        // Wholly before the snapshot.
        assert_eq!(
            book.apply(&diff(90, 95, 89, &[("100", "9")])),
            Applied::Stale
        );
        // Straddles it: the first one kept.
        assert_eq!(
            book.apply(&diff(98, 103, 97, &[("100", "0"), ("98", "5")])),
            Applied::Changed
        );
        assert_eq!(
            book.apply(&diff(104, 110, 103, &[("99", "4")])),
            Applied::Changed
        );
        let snap = book.snapshot("BTCUSDT", 10);
        let bids: Vec<(Decimal, Decimal)> = snap.bids.iter().map(|l| (l.price, l.size)).collect();
        assert_eq!(bids, [(d("99"), d("4")), (d("98"), d("5"))]);
        assert_eq!(snap.asks[0].price, d("101"));
        assert_eq!(snap.time, 110);
    }

    #[test]
    fn a_missed_diff_is_a_gap() {
        let mut book = Book::default();
        book.reset(&depth(100));
        assert_eq!(book.apply(&diff(99, 101, 98, &[])), Applied::Changed);
        assert_eq!(book.apply(&diff(105, 106, 104, &[])), Applied::Gap);
        // A first diff that starts after the snapshot left one out too.
        let mut fresh = Book::default();
        fresh.reset(&depth(100));
        assert_eq!(fresh.apply(&diff(102, 103, 101, &[])), Applied::Gap);
        // And nothing applies before a snapshot.
        assert_eq!(Book::default().apply(&diff(1, 2, 0, &[])), Applied::Gap);
    }

    #[test]
    fn keeps_the_top_levels_best_first() {
        let mut book = Book::default();
        book.reset(&depth(1));
        let snap = book.snapshot("X", 1);
        assert_eq!(snap.bids.len(), 1);
        assert_eq!(snap.bids[0].price, d("100"));
        assert_eq!(snap.asks[0].price, d("101"));
    }
}
