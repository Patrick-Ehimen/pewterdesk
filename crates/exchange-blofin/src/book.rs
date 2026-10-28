//! A market's book kept from the `books` channel: a full snapshot (200
//! levels a side), then updates every 100ms, each naming the sequence id of
//! the one before it (`prevSeqId`). One that doesn't follow on means an
//! update was missed: the book is no longer right, and the stream starts
//! over from a fresh snapshot (`ws::Handled::Resync`).

use std::collections::BTreeMap;

use pewterdesk_core::{BookLevel, Decimal, OrderBook};
use rust_decimal::Decimal as Raw;
use serde_json::Value;

use crate::wire::{self, Spec};

#[derive(Default)]
pub struct Book {
    /// Price to contracts.
    bids: BTreeMap<Raw, Raw>,
    asks: BTreeMap<Raw, Raw>,
    /// The last applied message's `seqId`; `None` until a snapshot.
    seq: Option<u64>,
    time: u64,
}

#[derive(Debug, PartialEq, Eq)]
pub enum Applied {
    Changed,
    /// An update that doesn't follow the last one: start over.
    Gap,
}

fn seq(data: &Value, key: &str) -> Option<u64> {
    match &data[key] {
        Value::String(s) => s.parse().ok(),
        Value::Number(n) => n.as_u64(),
        _ => None,
    }
}

fn apply_side(side: &mut BTreeMap<Raw, Raw>, levels: Vec<(Raw, Raw)>) {
    for (price, size) in levels {
        if size.is_zero() {
            side.remove(&price);
        } else {
            side.insert(price, size);
        }
    }
}

impl Book {
    /// Applies one push: `action` is `snapshot` or `update`.
    pub fn apply(&mut self, action: Option<&str>, data: &Value) -> Applied {
        let this = seq(data, "seqId");
        if action == Some("snapshot") {
            self.bids.clear();
            self.asks.clear();
        } else {
            let follows = matches!(
                (self.seq, seq(data, "prevSeqId")),
                (Some(last), Some(prev)) if last == prev
            );
            if !follows {
                return Applied::Gap;
            }
        }
        apply_side(&mut self.bids, wire::levels(&data["bids"]));
        apply_side(&mut self.asks, wire::levels(&data["asks"]));
        self.seq = this;
        if let Some(time) = seq(data, "ts") {
            self.time = time;
        }
        Applied::Changed
    }

    /// The top `depth` levels a side, best first, in base units.
    pub fn snapshot(&self, market: &str, depth: usize, spec: &Spec) -> OrderBook {
        let level = |(price, size): (&Raw, &Raw)| BookLevel {
            price: Decimal(*price),
            size: spec.base(Decimal(*size)),
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
    use serde_json::json;

    use super::*;

    fn spec() -> Spec {
        Spec {
            contract_value: Decimal("0.01".parse().unwrap()),
            tick: Decimal("0.01".parse().unwrap()),
            lot: Decimal("1".parse().unwrap()),
            min_contracts: Decimal("1".parse().unwrap()),
            max_leverage: 100,
        }
    }

    fn prices(levels: &[BookLevel]) -> Vec<String> {
        levels.iter().map(|l| l.price.0.to_string()).collect()
    }

    /// The docs' own snapshot and update ("WS Order Book Channel").
    #[test]
    fn applies_the_docs_example() {
        let mut book = Book::default();
        let snapshot = json!({
            "asks":[[1639.75,392],[1639.95,541]],
            "bids":[[1639.7,6817],[1639.65,4744]],
            "ts":"1696670727520","prevSeqId":"0","seqId":"107600747"
        });
        assert_eq!(book.apply(Some("snapshot"), &snapshot), Applied::Changed);
        let update = json!({
            "asks":[[1639.95,2208],[1640,4605],[1639.75,0]],
            "bids":[[1639.65,7115],[1639.6,4791]],
            "ts":"1696670728525","prevSeqId":"107600747","seqId":"107600806"
        });
        assert_eq!(book.apply(Some("update"), &update), Applied::Changed);
        let shown = book.snapshot("ETH-USDT", 10, &spec());
        assert_eq!(prices(&shown.asks), ["1639.95", "1640"]);
        assert_eq!(prices(&shown.bids), ["1639.7", "1639.65", "1639.6"]);
        assert_eq!(shown.asks[0].size, Decimal("22.08".parse().unwrap()));
        assert_eq!(shown.time, 1696670728525);
    }

    #[test]
    fn an_update_out_of_sequence_is_a_gap() {
        let mut book = Book::default();
        // Nothing to apply an update to before a snapshot.
        assert_eq!(
            book.apply(Some("update"), &json!({"prevSeqId":"1","seqId":"2"})),
            Applied::Gap
        );
        book.apply(
            Some("snapshot"),
            &json!({"asks":[],"bids":[],"prevSeqId":"0","seqId":"10"}),
        );
        assert_eq!(
            book.apply(
                Some("update"),
                &json!({"asks":[],"bids":[],"prevSeqId":"9","seqId":"12"})
            ),
            Applied::Gap
        );
        assert_eq!(
            book.apply(
                Some("update"),
                &json!({"asks":[],"bids":[],"prevSeqId":"10","seqId":"12"})
            ),
            Applied::Changed
        );
    }
}
