//! What a trader did between two looks at their positions.
//!
//! Positions are compared per market, by net size, so it reads the same
//! whether a source reports one position a market (Hyperliquid) or several
//! (an OKX lead trader's sub-positions): opened, added to, cut, closed or
//! flipped. A fill split in twenty pieces is one change, not twenty.

use std::collections::BTreeMap;

use serde::Serialize;

use crate::{Holding, PositionSide};

/// Changes smaller than this share of the position are noise (rounding).
const NOISE: f64 = 1e-6;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ChangeKind {
    Open,
    Add,
    Cut,
    Close,
    /// Closed one side and opened the other in one step.
    Flip,
}

/// One market's change between two looks.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Change {
    pub market: String,
    pub kind: ChangeKind,
    /// The side held after it, or for a close the side that was closed.
    pub side: PositionSide,
    /// In base units, both positive.
    pub size_before: f64,
    pub size_after: f64,
    /// The price it's put at: the position's mark where known, else its entry.
    pub price: f64,
    /// What changed hands, in USD: the size that moved, at `price` (for a
    /// flip, the new position's size).
    pub value: f64,
}

/// A market's net position: signed size (long positive) and a price for it.
#[derive(Clone, Copy)]
struct Net {
    size: f64,
    price: f64,
}

fn nets(holdings: &[Holding]) -> BTreeMap<&str, Net> {
    let mut out: BTreeMap<&str, (f64, f64, f64)> = BTreeMap::new();
    for h in holdings {
        let signed = match h.side {
            PositionSide::Long => h.size,
            PositionSide::Short => -h.size,
        };
        let price = h.mark.unwrap_or(h.entry);
        let e = out.entry(h.market.as_str()).or_default();
        e.0 += signed;
        e.1 += price * h.size;
        e.2 += h.size;
    }
    out.into_iter()
        .map(|(m, (size, weighted, total))| {
            let price = if total > 0.0 { weighted / total } else { 0.0 };
            (m, Net { size, price })
        })
        .collect()
}

fn side_of(size: f64) -> PositionSide {
    if size < 0.0 {
        PositionSide::Short
    } else {
        PositionSide::Long
    }
}

/// What changed from `before` to `after`, market by market (sorted by market).
pub fn changes(before: &[Holding], after: &[Holding]) -> Vec<Change> {
    let (b, a) = (nets(before), nets(after));
    let mut markets: Vec<&str> = b.keys().chain(a.keys()).copied().collect();
    markets.sort_unstable();
    markets.dedup();
    let zero = Net {
        size: 0.0,
        price: 0.0,
    };
    let mut out = Vec::new();
    for market in markets {
        let was = b.get(market).copied().unwrap_or(zero);
        let now = a.get(market).copied().unwrap_or(zero);
        let scale = was.size.abs().max(now.size.abs());
        let flat = |s: f64| s.abs() <= scale * NOISE;
        if scale == 0.0 || flat(now.size - was.size) {
            continue;
        }
        let (kind, side, moved) = if flat(was.size) {
            (ChangeKind::Open, side_of(now.size), now.size.abs())
        } else if flat(now.size) {
            (ChangeKind::Close, side_of(was.size), was.size.abs())
        } else if was.size.signum() != now.size.signum() {
            (ChangeKind::Flip, side_of(now.size), now.size.abs())
        } else if now.size.abs() > was.size.abs() {
            (
                ChangeKind::Add,
                side_of(now.size),
                (now.size - was.size).abs(),
            )
        } else {
            (
                ChangeKind::Cut,
                side_of(now.size),
                (now.size - was.size).abs(),
            )
        };
        let price = if flat(now.size) { was.price } else { now.price };
        out.push(Change {
            market: market.to_owned(),
            kind,
            side,
            size_before: if flat(was.size) { 0.0 } else { was.size.abs() },
            size_after: if flat(now.size) { 0.0 } else { now.size.abs() },
            price,
            value: moved * price,
        });
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn h(market: &str, side: PositionSide, size: f64, mark: f64) -> Holding {
        Holding {
            market: market.into(),
            side,
            size,
            entry: mark,
            mark: Some(mark),
            value: size * mark,
            leverage: None,
            unrealized: 0.0,
            liquidation: None,
            opened_at: None,
        }
    }
    use PositionSide::{Long, Short};

    fn kinds(c: &[Change]) -> Vec<(&str, ChangeKind, PositionSide)> {
        c.iter()
            .map(|c| (c.market.as_str(), c.kind, c.side))
            .collect()
    }

    #[test]
    fn nothing_moved_is_nothing() {
        let x = [h("BTC", Short, 2.0, 75_000.0)];
        assert!(changes(&x, &x).is_empty());
        assert!(changes(&[], &[]).is_empty());
    }

    #[test]
    fn open_add_cut_close() {
        let open = changes(&[], &[h("BTC", Short, 12.0, 75_940.0)]);
        assert_eq!(kinds(&open), [("BTC", ChangeKind::Open, Short)]);
        assert_eq!(open[0].value, 12.0 * 75_940.0);

        let add = changes(
            &[h("BTC", Short, 18.5, 76_000.0)],
            &[h("BTC", Short, 22.5, 76_480.0)],
        );
        assert_eq!(kinds(&add), [("BTC", ChangeKind::Add, Short)]);
        assert!((add[0].value - 4.0 * 76_480.0).abs() < 1e-6);

        let cut = changes(
            &[h("SOL", Long, 9000.0, 181.0)],
            &[h("SOL", Long, 4500.0, 180.1)],
        );
        assert_eq!(kinds(&cut), [("SOL", ChangeKind::Cut, Long)]);
        assert_eq!((cut[0].size_before, cut[0].size_after), (9000.0, 4500.0));

        let close = changes(&[h("HYPE", Long, 1000.0, 41.0)], &[]);
        assert_eq!(kinds(&close), [("HYPE", ChangeKind::Close, Long)]);
        assert_eq!((close[0].size_after, close[0].price), (0.0, 41.0));
    }

    #[test]
    fn a_flip_is_one_change() {
        let c = changes(
            &[h("ETH", Short, 300.0, 2400.0)],
            &[h("ETH", Long, 420.0, 2431.0)],
        );
        assert_eq!(kinds(&c), [("ETH", ChangeKind::Flip, Long)]);
        assert_eq!(c[0].value, 420.0 * 2431.0);
    }

    #[test]
    fn sub_positions_count_as_one_net_position() {
        // An OKX lead trader opening a second sub-position in the same market adds to it.
        let before = [h("BTC", Long, 1.0, 75_000.0)];
        let after = [h("BTC", Long, 1.0, 75_000.0), h("BTC", Long, 0.5, 75_200.0)];
        assert_eq!(
            kinds(&changes(&before, &after)),
            [("BTC", ChangeKind::Add, Long)]
        );
        // A long and a short of the same size net to nothing open.
        let hedged = [
            h("BTC", Long, 1.0, 75_000.0),
            h("BTC", Short, 1.0, 75_000.0),
        ];
        assert!(changes(&[], &hedged).is_empty());
    }

    #[test]
    fn rounding_is_not_a_trade() {
        let before = [h("BTC", Long, 1.0, 75_000.0)];
        let after = [h("BTC", Long, 1.000_000_000_1, 75_010.0)];
        assert!(changes(&before, &after).is_empty());
    }

    #[test]
    fn several_markets_at_once_are_sorted() {
        let before = [h("ETH", Long, 1.0, 2400.0), h("BTC", Short, 1.0, 75_000.0)];
        let after = [h("SOL", Long, 10.0, 180.0), h("BTC", Short, 1.0, 75_000.0)];
        assert_eq!(
            kinds(&changes(&before, &after)),
            [
                ("ETH", ChangeKind::Close, Long),
                ("SOL", ChangeKind::Open, Long)
            ]
        );
    }
}
