//! The executors: each algo's decisions, as pure functions of what it can
//! see (the book, its own orders, the time). The runtime (`run.rs`) does
//! the sending - every order through the router and its gate - and keeps
//! the executor's view of its orders up to date; an executor never calls a
//! venue.

use pewterdesk_core::{
    AlgoSpec, Decimal, OrderBook, OrderKind, OrderRequest, Side, SliceStyle, TimeInForce, Unfilled,
};
use rust_decimal::Decimal as D;

use super::math::{floor_to, Rules};

/// How long a chaser leaves its order before moving it again.
pub const REPRICE_EVERY_MS: u64 = 1_000;
/// How long after a refused or failed placement a chaser tries again.
pub const RETRY_AFTER_MS: u64 = 1_000;

/// One of an algo's orders, as the runtime tracks it.
#[derive(Clone, Debug, PartialEq)]
pub struct Mine {
    /// Which part of the algo it's for: a TWAP slice, a ladder level.
    pub tag: u32,
    /// The router's client order id; unset only when it couldn't record one.
    pub client_id: Option<String>,
    /// The venue's id, once known.
    pub order_id: Option<String>,
    pub size: D,
    pub price: Option<D>,
    pub filled: D,
    /// Still on the venue, or not yet known not to be.
    pub open: bool,
    /// When it was sent, in ms since the algo started.
    pub sent_at: u64,
    /// The venue runs it (a native TWAP): it isn't an open order to look for.
    pub native: bool,
}

/// What an executor sees.
pub struct Ctx<'a> {
    /// Milliseconds since the algo started.
    pub now: u64,
    /// The order book, while it's fresh.
    pub book: Option<&'a OrderBook>,
    pub mine: &'a [Mine],
    pub rules: &'a Rules,
    pub spec: &'a AlgoSpec,
    /// The book's mid when the algo started.
    pub start_price: Option<D>,
}

impl Ctx<'_> {
    fn of(&self, tag: u32) -> impl Iterator<Item = &Mine> {
        self.mine.iter().filter(move |m| m.tag == tag)
    }

    /// The best price on the algo's own side: the bid to buy at, the ask to
    /// sell at.
    fn best(&self) -> Option<D> {
        let book = self.book?;
        let level = match self.spec.side {
            Side::Buy => book.bids.first(),
            Side::Sell => book.asks.first(),
        }?;
        Some(level.price.0)
    }

    fn market_order(&self, size: D) -> OrderRequest {
        OrderRequest {
            market: self.spec.market.clone(),
            side: self.spec.side,
            size: Decimal(size),
            reduce_only: self.spec.reduce_only,
            collateral: None,
            client_id: None,
            take_profit: None,
            stop_loss: None,
            kind: OrderKind::Market {
                max_slippage_bps: self.spec.max_slippage_bps,
            },
        }
    }

    fn limit_order(&self, size: D, price: D, post_only: bool) -> OrderRequest {
        OrderRequest {
            kind: OrderKind::Limit {
                price: Decimal(price),
                time_in_force: Some(if post_only {
                    TimeInForce::PostOnly
                } else {
                    TimeInForce::Gtc
                }),
            },
            ..self.market_order(size)
        }
    }
}

/// Something an executor wants done.
#[derive(Clone, Debug, PartialEq)]
pub enum Act {
    Place {
        tag: u32,
        request: OrderRequest,
    },
    /// Move a resting order to `price` (size unchanged).
    Amend {
        tag: u32,
        order_id: String,
        price: D,
    },
    Cancel {
        order_id: String,
    },
}

/// How an algo ends.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Outcome {
    Finished,
    /// With a reason code (`gaveUp`, `unfilled`).
    Stopped(&'static str),
}

#[derive(Debug, Default)]
pub struct Decision {
    pub acts: Vec<Act>,
    /// When to decide again at the latest, in ms since the start.
    pub wake: Option<u64>,
    pub outcome: Option<Outcome>,
}

pub trait Executor: Send {
    fn decide(&mut self, cx: &Ctx<'_>) -> Decision;
    /// When it next sends something, in ms since the start.
    fn next_at(&self) -> Option<u64> {
        None
    }
    /// When it's due to end, in ms since the start.
    fn ends_at(&self) -> Option<u64> {
        None
    }
    /// It acts on the book (and pauses when the book goes stale).
    fn needs_book(&self) -> bool {
        true
    }
}

/// What's filled of `tag` so far.
fn filled(cx: &Ctx<'_>, tag: u32) -> D {
    cx.of(tag).map(|m| m.filled).sum()
}

/// A chaser: a limit order kept at the top of the book until `size` fills.
#[derive(Debug)]
pub struct Chaser {
    tag: u32,
    size: D,
    post_only: bool,
    give_up_bps: Option<u32>,
    finish_at_market: bool,
    last_move: Option<u64>,
    /// Gave up with `finish_at_market`: cancelling, then the rest at market.
    finishing: bool,
    /// The rest has gone at market.
    final_sent: bool,
}

impl Chaser {
    pub fn new(
        tag: u32,
        size: D,
        post_only: bool,
        give_up_bps: Option<u32>,
        finish_at_market: bool,
    ) -> Self {
        Self {
            tag,
            size,
            post_only,
            give_up_bps,
            finish_at_market,
            last_move: None,
            finishing: false,
            final_sent: false,
        }
    }

    /// Whether the top of the book has run `give_up_bps` against us.
    fn gave_up(&self, cx: &Ctx<'_>, target: D) -> bool {
        let (Some(limit), Some(start)) = (self.give_up_bps, cx.start_price) else {
            return false;
        };
        if start <= D::ZERO {
            return false;
        }
        let moved = match cx.spec.side {
            Side::Buy => target - start,
            Side::Sell => start - target,
        };
        moved / start * D::from(10_000) > D::from(limit)
    }
}

impl Executor for Chaser {
    fn decide(&mut self, cx: &Ctx<'_>) -> Decision {
        let open: Vec<&Mine> = cx.of(self.tag).filter(|m| m.open).collect();
        let remaining = floor_to(self.size - filled(cx, self.tag), cx.rules.step);
        let cancel_open = || {
            open.iter()
                .filter_map(|m| m.order_id.clone())
                .map(|order_id| Act::Cancel { order_id })
                .collect::<Vec<_>>()
        };
        if remaining < cx.rules.min || remaining <= D::ZERO {
            return Decision {
                acts: cancel_open(),
                outcome: Some(Outcome::Finished),
                ..Decision::default()
            };
        }
        if self.finishing {
            // Only once nothing rests, so what's sent at market is exactly
            // what didn't fill.
            if !open.is_empty() {
                return Decision {
                    wake: Some(cx.now + 500),
                    ..Decision::default()
                };
            }
            if self.final_sent {
                return Decision {
                    outcome: Some(Outcome::Finished),
                    ..Decision::default()
                };
            }
            self.final_sent = true;
            return Decision {
                acts: vec![Act::Place {
                    tag: self.tag,
                    request: cx.market_order(remaining),
                }],
                wake: Some(cx.now + 500),
                ..Decision::default()
            };
        }
        let wake = Some(cx.now + REPRICE_EVERY_MS);
        let Some(target) = cx.best() else {
            return Decision {
                wake,
                ..Decision::default()
            };
        };
        if self.gave_up(cx, target) {
            if self.finish_at_market {
                // Cancel first; the rest goes at market once that settles.
                self.finishing = true;
                return Decision {
                    acts: cancel_open(),
                    wake: Some(cx.now + 500),
                    ..Decision::default()
                };
            }
            return Decision {
                acts: cancel_open(),
                outcome: Some(Outcome::Stopped("gaveUp")),
                ..Decision::default()
            };
        }
        match open.first() {
            None => {
                // Not straight after a placement that didn't stay.
                let last = cx.of(self.tag).map(|m| m.sent_at).max();
                if last.is_some_and(|at| cx.now < at + RETRY_AFTER_MS) {
                    return Decision {
                        wake: last.map(|at| at + RETRY_AFTER_MS),
                        ..Decision::default()
                    };
                }
                Decision {
                    acts: vec![Act::Place {
                        tag: self.tag,
                        request: cx.limit_order(remaining, target, self.post_only),
                    }],
                    wake,
                    ..Decision::default()
                }
            }
            Some(order) => {
                let moved_lately = self
                    .last_move
                    .is_some_and(|at| cx.now < at + REPRICE_EVERY_MS);
                let off = order.price != Some(target);
                match (&order.order_id, off && !moved_lately) {
                    (Some(order_id), true) => {
                        self.last_move = Some(cx.now);
                        Decision {
                            acts: vec![Act::Amend {
                                tag: self.tag,
                                order_id: order_id.clone(),
                                price: target,
                            }],
                            wake,
                            ..Decision::default()
                        }
                    }
                    _ => Decision {
                        wake,
                        ..Decision::default()
                    },
                }
            }
        }
    }
}

/// A TWAP: slices sent at set times, at market or chased.
#[derive(Debug)]
pub struct Twap {
    sizes: Vec<D>,
    times: Vec<u64>,
    duration: u64,
    style: SliceStyle,
    unfilled: Unfilled,
    /// The next slice to send.
    next: usize,
    /// The slice being chased, and when its window ends.
    chasing: Option<(usize, Chaser, u64)>,
    /// A chased slice whose window ended: its order is being cancelled, and
    /// what didn't fill is dealt with once that settles.
    closing: Option<usize>,
}

impl Twap {
    pub fn new(
        sizes: Vec<D>,
        times: Vec<u64>,
        duration: u64,
        style: SliceStyle,
        unfilled: Unfilled,
    ) -> Self {
        Self {
            sizes,
            times,
            duration,
            style,
            unfilled,
            next: 0,
            chasing: None,
            closing: None,
        }
    }

    fn window_end(&self, i: usize) -> u64 {
        self.times.get(i + 1).copied().unwrap_or(self.duration)
    }
}

impl Executor for Twap {
    fn decide(&mut self, cx: &Ctx<'_>) -> Decision {
        let mut acts = Vec::new();
        // The chased slice: its window, or its own decisions.
        // A slice whose window ended: once its order is gone, what didn't
        // fill goes at market, is skipped, or stops the TWAP.
        if let Some(i) = self.closing {
            let tag = i as u32;
            if cx.of(tag).any(|m| m.open) {
                return Decision {
                    wake: Some(cx.now + 500),
                    ..Decision::default()
                };
            }
            self.closing = None;
            let rest = floor_to(self.sizes[i] - filled(cx, tag), cx.rules.step);
            if rest >= cx.rules.min && rest > D::ZERO {
                match self.unfilled {
                    Unfilled::Market => acts.push(Act::Place {
                        tag,
                        request: cx.market_order(rest),
                    }),
                    Unfilled::Stop => {
                        return Decision {
                            outcome: Some(Outcome::Stopped("unfilled")),
                            ..Decision::default()
                        }
                    }
                    Unfilled::Skip => {}
                }
            }
        }
        if let Some((i, mut chaser, end)) = self.chasing.take() {
            let tag = i as u32;
            if cx.now >= end {
                acts.extend(
                    cx.of(tag)
                        .filter(|m| m.open)
                        .filter_map(|m| m.order_id.clone())
                        .map(|order_id| Act::Cancel { order_id }),
                );
                self.closing = Some(i);
                return Decision {
                    acts,
                    wake: Some(cx.now + 500),
                    ..Decision::default()
                };
            } else {
                let decided = chaser.decide(cx);
                acts.extend(decided.acts);
                match decided.outcome {
                    // The slice filled; on to the next when it's due.
                    Some(Outcome::Finished) => {}
                    Some(Outcome::Stopped(why)) => {
                        return Decision {
                            acts,
                            outcome: Some(Outcome::Stopped(why)),
                            ..Decision::default()
                        }
                    }
                    None => {
                        self.chasing = Some((i, chaser, end));
                        return Decision {
                            acts,
                            wake: decided.wake.map(|w| w.min(end)).or(Some(end)),
                            ..Decision::default()
                        };
                    }
                }
            }
        }
        // The next slice, once it's due: one per decision, so slices that
        // came due while paused don't go out in a burst.
        if self.next < self.sizes.len() && self.times[self.next] <= cx.now {
            let i = self.next;
            self.next += 1;
            let tag = i as u32;
            match self.style {
                SliceStyle::Market => acts.push(Act::Place {
                    tag,
                    request: cx.market_order(self.sizes[i]),
                }),
                SliceStyle::Chaser => {
                    let mut chaser = Chaser::new(tag, self.sizes[i], true, None, false);
                    let end = self.window_end(i);
                    let decided = chaser.decide(cx);
                    acts.extend(decided.acts);
                    if decided.outcome.is_none() {
                        self.chasing = Some((i, chaser, end));
                    }
                }
            }
            return Decision {
                acts,
                wake: Some(cx.now + 1),
                ..Decision::default()
            };
        }
        let settled = cx.mine.iter().all(|m| !m.open);
        if self.next >= self.sizes.len()
            && self.chasing.is_none()
            && self.closing.is_none()
            && settled
        {
            return Decision {
                acts,
                outcome: Some(Outcome::Finished),
                ..Decision::default()
            };
        }
        Decision {
            acts,
            wake: self.times.get(self.next).copied().or(Some(cx.now + 1_000)),
            ..Decision::default()
        }
    }

    fn next_at(&self) -> Option<u64> {
        self.times.get(self.next).copied()
    }

    fn ends_at(&self) -> Option<u64> {
        Some(self.duration)
    }

    fn needs_book(&self) -> bool {
        self.style == SliceStyle::Chaser
    }
}

/// A scaled ladder: every level placed at once, then tracked as one.
#[derive(Debug)]
pub struct Scaled {
    levels: Vec<(D, D)>,
    post_only: bool,
    placed: bool,
}

impl Scaled {
    pub fn new(levels: Vec<(D, D)>, post_only: bool) -> Self {
        Self {
            levels,
            post_only,
            placed: false,
        }
    }
}

impl Executor for Scaled {
    fn decide(&mut self, cx: &Ctx<'_>) -> Decision {
        if !self.placed {
            self.placed = true;
            return Decision {
                acts: self
                    .levels
                    .iter()
                    .enumerate()
                    .map(|(i, (price, size))| Act::Place {
                        tag: i as u32,
                        request: cx.limit_order(*size, *price, self.post_only),
                    })
                    .collect(),
                wake: Some(cx.now + 1_000),
                ..Decision::default()
            };
        }
        // Done once nothing of it rests: filled, or cancelled on the venue.
        if cx.mine.iter().all(|m| !m.open) {
            return Decision {
                outcome: Some(Outcome::Finished),
                ..Decision::default()
            };
        }
        Decision {
            wake: Some(cx.now + 5_000),
            ..Decision::default()
        }
    }

    fn needs_book(&self) -> bool {
        false
    }
}

#[cfg(test)]
mod tests {
    use pewterdesk_core::{AlgoKind, BookLevel, VenueId};

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

    fn spec(side: Side) -> AlgoSpec {
        AlgoSpec {
            venue: VenueId::Bybit,
            account: "demo:1".into(),
            market: "BTCUSDT".into(),
            side,
            size: Decimal(d("1")),
            reduce_only: false,
            max_slippage_bps: 50,
            prefer_native: true,
            kind: AlgoKind::Chaser {
                post_only: true,
                give_up_bps: None,
                finish_at_market: false,
            },
        }
    }

    fn book(bid: &str, ask: &str) -> OrderBook {
        let level = |p: &str| BookLevel {
            price: Decimal(d(p)),
            size: Decimal(d("5")),
        };
        OrderBook {
            market: "BTCUSDT".into(),
            bids: vec![level(bid)],
            asks: vec![level(ask)],
            time: 0,
        }
    }

    fn resting(tag: u32, price: &str, filled: &str) -> Mine {
        Mine {
            tag,
            client_id: Some("0x1".into()),
            order_id: Some("o1".into()),
            size: d("1"),
            price: Some(d(price)),
            filled: d(filled),
            open: true,
            sent_at: 0,
            native: false,
        }
    }

    #[test]
    fn a_chaser_rests_at_the_top_and_follows_it() {
        let spec = spec(Side::Buy);
        let rules = rules();
        let top = book("100", "100.1");
        let cx = |now, book, mine| Ctx {
            now,
            book,
            mine,
            rules: &rules,
            spec: &spec,
            start_price: Some(d("100.05")),
        };
        let mut chaser = Chaser::new(0, d("1"), true, None, false);
        let first = chaser.decide(&cx(0, Some(&top), &[]));
        let Act::Place { request, .. } = &first.acts[0] else {
            panic!("{first:?}")
        };
        assert_eq!(
            request.kind,
            OrderKind::Limit {
                price: Decimal(d("100")),
                time_in_force: Some(TimeInForce::PostOnly)
            }
        );
        // The bid moves up: the order follows it.
        let higher = book("100.2", "100.3");
        let mine = [resting(0, "100", "0.4")];
        let moved = chaser.decide(&cx(2_000, Some(&higher), &mine));
        assert_eq!(
            moved.acts,
            [Act::Amend {
                tag: 0,
                order_id: "o1".into(),
                price: d("100.2")
            }]
        );
        // Not again straight away.
        let mine = [resting(0, "100", "0.4")];
        let higher_still = book("100.3", "100.4");
        assert!(chaser
            .decide(&cx(2_500, Some(&higher_still), &mine))
            .acts
            .is_empty());
        // Filled: done, nothing left to cancel.
        let done = [Mine {
            open: false,
            ..resting(0, "100.2", "1")
        }];
        assert_eq!(
            chaser.decide(&cx(3_000, Some(&higher), &done)).outcome,
            Some(Outcome::Finished)
        );
    }

    #[test]
    fn a_chaser_gives_up_or_finishes_at_market() {
        let spec = spec(Side::Buy);
        let rules = rules();
        let far = book("101", "101.1");
        let mine = [resting(0, "100", "0.25")];
        let cx = Ctx {
            now: 5_000,
            book: Some(&far),
            mine: &mine,
            rules: &rules,
            spec: &spec,
            start_price: Some(d("100")),
        };
        // 100 bps away, past a 50 bps limit.
        let mut quits = Chaser::new(0, d("1"), true, Some(50), false);
        let decided = quits.decide(&cx);
        assert_eq!(decided.outcome, Some(Outcome::Stopped("gaveUp")));
        assert_eq!(
            decided.acts,
            [Act::Cancel {
                order_id: "o1".into()
            }]
        );
        // Finishing at market: cancel first, and nothing else yet.
        let mut finishes = Chaser::new(0, d("1"), true, Some(50), true);
        let decided = finishes.decide(&cx);
        assert_eq!(decided.outcome, None);
        assert_eq!(
            decided.acts,
            [Act::Cancel {
                order_id: "o1".into()
            }]
        );
        // While the cancel hasn't settled, it waits.
        assert!(finishes.decide(&cx).acts.is_empty());
        // Settled, a little more filled meanwhile: exactly the rest goes.
        let cancelled = [Mine {
            open: false,
            ..resting(0, "100", "0.3")
        }];
        let cx = Ctx {
            mine: &cancelled,
            ..cx
        };
        let decided = finishes.decide(&cx);
        let Act::Place { request, .. } = &decided.acts[0] else {
            panic!("{decided:?}")
        };
        assert_eq!(request.size, Decimal(d("0.7")));
        assert!(matches!(request.kind, OrderKind::Market { .. }));
        // Once that has gone out and settled, it's finished.
        let all = [
            cancelled[0].clone(),
            Mine {
                open: false,
                filled: d("0.7"),
                ..resting(0, "100", "0.7")
            },
        ];
        let cx = Ctx { mine: &all, ..cx };
        assert_eq!(finishes.decide(&cx).outcome, Some(Outcome::Finished));
    }

    #[test]
    fn a_chaser_waits_after_a_placement_that_didnt_stay() {
        let spec = spec(Side::Sell);
        let rules = rules();
        let top = book("100", "100.1");
        let rejected = [Mine {
            open: false,
            sent_at: 1_000,
            ..resting(0, "100.1", "0")
        }];
        let mut chaser = Chaser::new(0, d("1"), true, None, false);
        let cx = |now| Ctx {
            now,
            book: Some(&top),
            mine: &rejected,
            rules: &rules,
            spec: &spec,
            start_price: None,
        };
        assert!(chaser.decide(&cx(1_500)).acts.is_empty());
        assert_eq!(chaser.decide(&cx(2_000)).acts.len(), 1);
    }

    #[test]
    fn a_market_twap_sends_its_slices_on_time_and_finishes() {
        let spec = spec(Side::Buy);
        let rules = rules();
        let mut twap = Twap::new(
            vec![d("0.5"), d("0.5")],
            vec![0, 1_000],
            2_000,
            SliceStyle::Market,
            Unfilled::Market,
        );
        assert!(!twap.needs_book());
        let cx = |now, mine| Ctx {
            now,
            book: None,
            mine,
            rules: &rules,
            spec: &spec,
            start_price: None,
        };
        let first = twap.decide(&cx(0, &[]));
        assert!(matches!(&first.acts[..], [Act::Place { tag: 0, .. }]));
        assert_eq!(twap.next_at(), Some(1_000));
        let sent = [Mine {
            open: false,
            filled: d("0.5"),
            ..resting(0, "100", "0.5")
        }];
        // Not due yet: waits for the next slice.
        let waiting = twap.decide(&cx(500, &sent));
        assert!(waiting.acts.is_empty());
        assert_eq!(waiting.wake, Some(1_000));
        let second = twap.decide(&cx(1_000, &sent));
        assert!(matches!(&second.acts[..], [Act::Place { tag: 1, .. }]));
        let both = [
            sent[0].clone(),
            Mine {
                tag: 1,
                ..sent[0].clone()
            },
        ];
        assert_eq!(
            twap.decide(&cx(1_200, &both)).outcome,
            Some(Outcome::Finished)
        );
    }

    #[test]
    fn a_chased_slice_goes_to_market_when_its_window_ends() {
        let spec = spec(Side::Buy);
        let rules = rules();
        let top = book("100", "100.1");
        let mut twap = Twap::new(
            vec![d("1")],
            vec![0],
            1_000,
            SliceStyle::Chaser,
            Unfilled::Market,
        );
        let cx = |now, mine| Ctx {
            now,
            book: Some(&top),
            mine,
            rules: &rules,
            spec: &spec,
            start_price: None,
        };
        let first = twap.decide(&cx(0, &[]));
        assert!(matches!(&first.acts[..], [Act::Place { tag: 0, .. }]));
        // The window ends with the order resting: cancel it, and the rest
        // waits for it to settle rather than doubling up.
        let mine = [resting(0, "100", "0.4")];
        let ended = twap.decide(&cx(1_000, &mine));
        assert_eq!(
            ended.acts,
            [Act::Cancel {
                order_id: "o1".into()
            }]
        );
        assert!(twap.decide(&cx(1_100, &mine)).acts.is_empty());
        // Settled with 0.4 filled: the other 0.6 goes at market.
        let settled = [Mine {
            open: false,
            ..resting(0, "100", "0.4")
        }];
        let rest = twap.decide(&cx(1_200, &settled));
        let [Act::Place { request, .. }] = &rest.acts[..] else {
            panic!("{rest:?}")
        };
        assert_eq!(request.size, Decimal(d("0.6")));
    }

    #[test]
    fn a_ladder_is_placed_at_once_and_ends_when_nothing_rests() {
        let spec = spec(Side::Buy);
        let rules = rules();
        let mut ladder = Scaled::new(vec![(d("100"), d("0.5")), (d("99"), d("0.5"))], true);
        let cx = |mine| Ctx {
            now: 0,
            book: None,
            mine,
            rules: &rules,
            spec: &spec,
            start_price: None,
        };
        assert_eq!(ladder.decide(&cx(&[])).acts.len(), 2);
        let resting = [resting(0, "100", "0"), resting(1, "99", "0")];
        assert!(ladder.decide(&cx(&resting)).outcome.is_none());
        let gone = [
            Mine {
                open: false,
                ..resting[0].clone()
            },
            Mine {
                open: false,
                ..resting[1].clone()
            },
        ];
        assert_eq!(ladder.decide(&cx(&gone)).outcome, Some(Outcome::Finished));
    }
}
