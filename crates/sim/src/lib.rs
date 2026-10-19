//! `SimVenue`: an `ExchangeAdapter` that trades against order books a test
//! (or, later, a recording) feeds it, with no network and no keys. Good
//! enough to drive the engine's algos end to end.
//!
//! Its fill model, kept simple and stated so a result can be judged:
//! - A limit order that crosses the book when placed fills at once, in
//!   full, at the best opposite price (a taker); post-only, it's refused.
//! - A resting limit order fills in full, at its own price (a maker), as
//!   soon as a book arrives whose opposite side reaches it.
//! - A market order fills in full at the best opposite price if that's
//!   within its slippage bound of the mid, and is cancelled unfilled if not
//!   (an IOC at the bound).
//! - No partial fills, no queue position, no fees but a flat taker fee
//!   (0.05%) and maker rebate-free; no funding, no positions' margin.
//! - A trigger order rests and never fires. A venue-run TWAP is refused.
//! - The dead-man's switch is only recorded, never fires.

use std::collections::HashMap;
use std::sync::Mutex;

use async_trait::async_trait;
use pewterdesk_core::{
    AccountSnapshot, Capabilities, Decimal, ExchangeAdapter, Fill, FillEffect, Market, Order,
    OrderAmend, OrderBook, OrderCategory, OrderKind, OrderRequest, OrderStatus, OrderType, Side,
    TimeInForce, TradingAccount, VenueError, VenueId,
};
use rust_decimal::Decimal as D;
use tokio::sync::mpsc;

/// The taker fee, as a fraction of a fill's value.
const TAKER_FEE: &str = "0.0005";

#[derive(Default)]
struct State {
    books: HashMap<String, OrderBook>,
    orders: Vec<Order>,
    fills: Vec<Fill>,
    next_id: u64,
    book_subs: Vec<(String, mpsc::Sender<OrderBook>)>,
    account_subs: Vec<mpsc::Sender<AccountSnapshot>>,
    /// Every request that reached the venue, in order: what was "signed".
    sent: Vec<String>,
}

pub struct SimVenue {
    venue: VenueId,
    markets: Vec<Market>,
    state: Mutex<State>,
}

fn best(book: &OrderBook, side: Side) -> Option<D> {
    match side {
        Side::Buy => book.asks.first().map(|l| l.price.0),
        Side::Sell => book.bids.first().map(|l| l.price.0),
    }
}

fn mid(book: &OrderBook) -> Option<D> {
    Some((book.bids.first()?.price.0 + book.asks.first()?.price.0) / D::TWO)
}

impl State {
    fn snapshot(&self, venue: VenueId, address: &str) -> AccountSnapshot {
        AccountSnapshot {
            venue,
            address: address.to_owned(),
            equity: Decimal(D::from(100_000)),
            available_margin: Decimal(D::from(100_000)),
            realized_pnl: None,
            positions: Vec::new(),
            open_orders: self
                .orders
                .iter()
                .filter(|o| o.status == OrderStatus::Open)
                .cloned()
                .collect(),
            time: self.next_id,
        }
    }

    fn fill(&mut self, venue: VenueId, index: usize, price: D, taker: bool) {
        let order = &mut self.orders[index];
        order.status = OrderStatus::Filled;
        order.filled_size = order.size;
        let size = order.size.0;
        let fee = if taker {
            price * size * TAKER_FEE.parse::<D>().unwrap_or_default()
        } else {
            D::ZERO
        };
        self.next_id += 1;
        let fill = Fill {
            venue,
            id: format!("f{}", self.next_id),
            order_id: order.id.clone(),
            market: order.market.clone(),
            side: order.side,
            effect: match order.side {
                Side::Buy => FillEffect::OpenLong,
                Side::Sell => FillEffect::OpenShort,
            },
            price: Decimal(price),
            size: Decimal(size),
            closed_pnl: Decimal(D::ZERO),
            fee: Decimal(fee),
            fee_asset: "USDT".into(),
            taker,
            time: self.next_id,
        };
        self.fills.push(fill);
    }

    /// Fills resting limit orders the book on `market` has reached.
    fn match_resting(&mut self, venue: VenueId, market: &str) {
        let Some(book) = self.books.get(market).cloned() else {
            return;
        };
        let hits: Vec<(usize, D)> = self
            .orders
            .iter()
            .enumerate()
            .filter(|(_, o)| o.status == OrderStatus::Open && o.market == market)
            .filter(|(_, o)| o.order_type == OrderType::Limit)
            .filter_map(|(i, o)| {
                let price = o.price?.0;
                let reached = match o.side {
                    Side::Buy => best(&book, Side::Buy).is_some_and(|ask| ask <= price),
                    Side::Sell => best(&book, Side::Sell).is_some_and(|bid| bid >= price),
                };
                reached.then_some((i, price))
            })
            .collect();
        for (i, price) in hits {
            self.fill(venue, i, price, false);
        }
    }

    fn notify(&mut self, venue: VenueId) {
        let snapshot = self.snapshot(venue, "sim");
        self.account_subs
            .retain(|tx| tx.try_send(snapshot.clone()).is_ok() || !tx.is_closed());
    }
}

impl SimVenue {
    pub fn new(venue: VenueId, markets: Vec<Market>) -> Self {
        Self {
            venue,
            markets,
            state: Mutex::new(State::default()),
        }
    }

    /// A new book for its market: resting orders it reaches fill, and every
    /// subscriber hears of it.
    pub fn push_book(&self, book: OrderBook) {
        let mut state = self.state.lock().unwrap();
        let market = book.market.clone();
        state
            .book_subs
            .retain(|(m, tx)| *m != market || tx.try_send(book.clone()).is_ok() || !tx.is_closed());
        state.books.insert(market.clone(), book);
        state.match_resting(self.venue, &market);
        state.notify(self.venue);
    }

    /// Every order it has seen, open or not.
    pub fn orders(&self) -> Vec<Order> {
        self.state.lock().unwrap().orders.clone()
    }

    pub fn fills_now(&self) -> Vec<Fill> {
        self.state.lock().unwrap().fills.clone()
    }

    /// What reached the venue, in order (`place ...`, `amend ...`, `cancel ...`).
    pub fn sent(&self) -> Vec<String> {
        self.state.lock().unwrap().sent.clone()
    }
}

#[async_trait]
impl ExchangeAdapter for SimVenue {
    fn venue(&self) -> VenueId {
        self.venue
    }

    fn capabilities(&self) -> Capabilities {
        Capabilities {
            order_book: true,
            order_types: vec![OrderType::Market, OrderType::Limit, OrderType::Trigger],
            isolated_collateral: false,
        }
    }

    async fn markets(&self) -> Result<Vec<Market>, VenueError> {
        Ok(self.markets.clone())
    }

    async fn order_book(&self, market: &str) -> Result<OrderBook, VenueError> {
        self.state
            .lock()
            .unwrap()
            .books
            .get(market)
            .cloned()
            .ok_or_else(|| VenueError::InvalidRequest("no book yet".into()))
    }

    async fn subscribe_order_book(
        &self,
        market: &str,
    ) -> Result<mpsc::Receiver<OrderBook>, VenueError> {
        let (tx, rx) = mpsc::channel(256);
        let mut state = self.state.lock().unwrap();
        if let Some(book) = state.books.get(market) {
            let _ = tx.try_send(book.clone());
        }
        state.book_subs.push((market.to_owned(), tx));
        Ok(rx)
    }

    async fn account(&self, address: &str) -> Result<AccountSnapshot, VenueError> {
        Ok(self.state.lock().unwrap().snapshot(self.venue, address))
    }

    async fn subscribe_account(
        &self,
        address: &str,
    ) -> Result<mpsc::Receiver<AccountSnapshot>, VenueError> {
        let (tx, rx) = mpsc::channel(256);
        let mut state = self.state.lock().unwrap();
        let _ = tx.try_send(state.snapshot(self.venue, address));
        state.account_subs.push(tx);
        Ok(rx)
    }

    async fn fills(&self, _address: &str) -> Result<Vec<Fill>, VenueError> {
        let mut fills = self.state.lock().unwrap().fills.clone();
        fills.reverse();
        Ok(fills)
    }

    async fn order_history(&self, _address: &str) -> Result<Vec<Order>, VenueError> {
        let mut orders = self.state.lock().unwrap().orders.clone();
        orders.reverse();
        Ok(orders)
    }

    async fn place_order(
        &self,
        _account: &TradingAccount,
        request: &OrderRequest,
    ) -> Result<Order, VenueError> {
        let mut state = self.state.lock().unwrap();
        let book = state
            .books
            .get(&request.market)
            .cloned()
            .ok_or_else(|| VenueError::Rejected("no book for that market".into()))?;
        state.next_id += 1;
        let id = format!("o{}", state.next_id);
        state.sent.push(format!("place {id}"));
        let mut order = Order {
            venue: self.venue,
            id: id.clone(),
            client_id: request.client_id.clone(),
            market: request.market.clone(),
            side: request.side,
            order_type: request.kind.order_type(),
            size: request.size,
            filled_size: Decimal(D::ZERO),
            price: None,
            trigger_price: None,
            reduce_only: request.reduce_only,
            status: OrderStatus::Open,
            created_at: state.next_id,
            category: OrderCategory::default(),
            trigger_by: None,
            take_profit: None,
            stop_loss: None,
        };
        let opposite = best(&book, request.side);
        match &request.kind {
            OrderKind::Twap { .. } => return Err(VenueError::Unsupported("a venue-run TWAP")),
            OrderKind::Trigger { trigger_price, .. } => order.trigger_price = Some(*trigger_price),
            OrderKind::Limit {
                price,
                time_in_force,
            } => {
                order.price = Some(*price);
                let crosses = opposite.is_some_and(|o| match request.side {
                    Side::Buy => o <= price.0,
                    Side::Sell => o >= price.0,
                });
                if crosses && *time_in_force == Some(TimeInForce::PostOnly) {
                    return Err(VenueError::Rejected("post-only order would cross".into()));
                }
                state.orders.push(order);
                let i = state.orders.len() - 1;
                if let (true, Some(at)) = (crosses, opposite) {
                    state.fill(self.venue, i, at, true);
                }
                state.notify(self.venue);
                return Ok(state.orders[i].clone());
            }
            OrderKind::Market { max_slippage_bps } => {
                let bound = mid(&book).map(|m| {
                    let off = m * D::from(*max_slippage_bps) / D::from(10_000);
                    match request.side {
                        Side::Buy => m + off,
                        Side::Sell => m - off,
                    }
                });
                order.price = bound.map(Decimal);
                let within = match (opposite, bound) {
                    (Some(o), Some(b)) => match request.side {
                        Side::Buy => o <= b,
                        Side::Sell => o >= b,
                    },
                    _ => false,
                };
                state.orders.push(order);
                let i = state.orders.len() - 1;
                match (within, opposite) {
                    (true, Some(at)) => state.fill(self.venue, i, at, true),
                    _ => state.orders[i].status = OrderStatus::Cancelled,
                }
                state.notify(self.venue);
                return Ok(state.orders[i].clone());
            }
        }
        state.orders.push(order.clone());
        state.notify(self.venue);
        Ok(order)
    }

    async fn cancel_order(
        &self,
        _account: &TradingAccount,
        _market: &str,
        order_id: &str,
    ) -> Result<(), VenueError> {
        let mut state = self.state.lock().unwrap();
        state.sent.push(format!("cancel {order_id}"));
        let order = state
            .orders
            .iter_mut()
            .find(|o| o.id == order_id && o.status == OrderStatus::Open)
            .ok_or_else(|| VenueError::Rejected("order not open".into()))?;
        order.status = OrderStatus::Cancelled;
        state.notify(self.venue);
        Ok(())
    }

    /// A per-market dead-man's switch that only records being armed
    /// (`switch <market> <ms>`) or turned off (`switch <market> off`).
    async fn schedule_cancel(
        &self,
        _account: &TradingAccount,
        market: &str,
        after_ms: Option<u64>,
    ) -> Result<(), VenueError> {
        let what = after_ms.map_or("off".to_owned(), |ms| ms.to_string());
        self.state
            .lock()
            .unwrap()
            .sent
            .push(format!("switch {market} {what}"));
        Ok(())
    }

    async fn amend_order(
        &self,
        _account: &TradingAccount,
        market: &str,
        order_id: &str,
        amend: &OrderAmend,
    ) -> Result<(), VenueError> {
        let mut state = self.state.lock().unwrap();
        state.sent.push(format!("amend {order_id}"));
        let book = state.books.get(market).cloned();
        let order = state
            .orders
            .iter_mut()
            .find(|o| o.id == order_id && o.status == OrderStatus::Open)
            .ok_or_else(|| VenueError::Rejected("order not open".into()))?;
        if let Some(price) = amend.price {
            order.price = Some(price);
        }
        if let Some(size) = amend.size {
            order.size = size;
        }
        // A move that crosses fills now, as a placement would.
        if let (Some(book), Some(price)) = (book, order.price) {
            let opposite = best(&book, order.side);
            let crosses = opposite.is_some_and(|o| match order.side {
                Side::Buy => o <= price.0,
                Side::Sell => o >= price.0,
            });
            if crosses {
                let i = state.orders.iter().position(|o| o.id == order_id).unwrap();
                state.fill(self.venue, i, opposite.unwrap(), true);
            }
        }
        state.notify(self.venue);
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use pewterdesk_core::BookLevel;

    use super::*;

    fn d(s: &str) -> Decimal {
        Decimal(s.parse().unwrap())
    }

    pub fn market() -> Market {
        Market {
            venue: VenueId::Bybit,
            id: "BTCUSDT".into(),
            symbol: "BTC-USDT".into(),
            base: "BTC".into(),
            quote: "USDT".into(),
            tick_size: d("0.1"),
            size_step: d("0.01"),
            min_size: d("0.01"),
            max_leverage: 50,
            listed_by: None,
            category: None,
            listed_at: None,
        }
    }

    fn book(bid: &str, ask: &str) -> OrderBook {
        let level = |p: &str| BookLevel {
            price: d(p),
            size: d("10"),
        };
        OrderBook {
            market: "BTCUSDT".into(),
            bids: vec![level(bid)],
            asks: vec![level(ask)],
            time: 0,
        }
    }

    fn limit(side: Side, price: &str, post_only: bool) -> OrderRequest {
        OrderRequest {
            market: "BTCUSDT".into(),
            side,
            size: d("1"),
            reduce_only: false,
            collateral: None,
            client_id: Some("0x1".into()),
            take_profit: None,
            stop_loss: None,
            kind: OrderKind::Limit {
                price: d(price),
                time_in_force: post_only.then_some(TimeInForce::PostOnly),
            },
        }
    }

    fn account() -> TradingAccount {
        TradingAccount {
            address: "sim".into(),
            key: "sim".into(),
        }
    }

    #[tokio::test]
    async fn rests_fills_when_reached_and_refuses_a_crossing_post_only() {
        let sim = SimVenue::new(VenueId::Bybit, vec![market()]);
        sim.push_book(book("100", "100.1"));
        let resting = sim
            .place_order(&account(), &limit(Side::Buy, "100", true))
            .await
            .unwrap();
        assert_eq!(resting.status, OrderStatus::Open);
        assert!(sim
            .place_order(&account(), &limit(Side::Buy, "100.1", true))
            .await
            .is_err());
        sim.push_book(book("99.8", "99.9"));
        let orders = sim.orders();
        assert_eq!(orders[0].status, OrderStatus::Filled);
        assert_eq!(sim.fills_now()[0].price, d("100"));
        assert!(!sim.fills_now()[0].taker);
    }

    #[tokio::test]
    async fn a_market_order_fills_within_its_bound_or_not_at_all() {
        let sim = SimVenue::new(VenueId::Bybit, vec![market()]);
        sim.push_book(book("100", "100.1"));
        let market = |bps| OrderRequest {
            kind: OrderKind::Market {
                max_slippage_bps: bps,
            },
            ..limit(Side::Buy, "0", false)
        };
        let filled = sim.place_order(&account(), &market(50)).await.unwrap();
        assert_eq!(filled.status, OrderStatus::Filled);
        // A wide book: 100.1 is more than 1 bp above the mid of 99.5..100.1.
        sim.push_book(book("99", "100.1"));
        let missed = sim.place_order(&account(), &market(1)).await.unwrap();
        assert_eq!(missed.status, OrderStatus::Cancelled);
    }
}
