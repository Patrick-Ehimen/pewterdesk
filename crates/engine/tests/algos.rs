//! Algos end to end: the engine's runtime driving executors through the
//! router (gate, log, client ids) against `SimVenue`.

use std::sync::{Arc, Mutex};
use std::time::Duration;

use async_trait::async_trait;
use pewterdesk_core::{
    AlgoKind, AlgoSpec, AlgoStatus, AlgoView, BookLevel, Decimal, Distribution, ExchangeAdapter,
    Market, OrderBook, OrderStatus, Origin, Side, SliceStyle, StopMode, Unfilled, VenueError,
    VenueId,
};
use pewterdesk_engine::algo::Host;
use pewterdesk_engine::{Adapters, Calendar, CalendarEvent, Engine, EventLog};
use pewterdesk_sim::SimVenue;

struct TestHost {
    engine: Engine,
    sim: Arc<SimVenue>,
    published: Mutex<Vec<AlgoView>>,
}

struct NoCalendar;

#[async_trait]
impl Calendar for NoCalendar {
    async fn kept(&self) -> Option<Vec<CalendarEvent>> {
        None
    }
}

impl Adapters for TestHost {
    fn adapter(&self, _venue: VenueId) -> Result<&dyn ExchangeAdapter, VenueError> {
        Ok(&*self.sim)
    }
}

impl Host for TestHost {
    fn engine(&self) -> &Engine {
        &self.engine
    }
    fn venues(&self) -> &dyn Adapters {
        self
    }
    fn calendar(&self) -> &dyn Calendar {
        &NoCalendar
    }
    fn publish(&self, view: &AlgoView) {
        self.published.lock().unwrap().push(view.clone());
    }
}

fn d(s: &str) -> Decimal {
    Decimal(s.parse().unwrap())
}

fn market() -> Market {
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

fn host_with(sim: Arc<SimVenue>, log: EventLog) -> Arc<TestHost> {
    let host = Arc::new(TestHost {
        engine: Engine::load(None, Some(log)),
        sim,
        published: Mutex::new(Vec::new()),
    });
    let attached: Arc<dyn Host> = host.clone();
    host.engine.algos().attach(attached);
    host
}

fn host() -> Arc<TestHost> {
    let sim = Arc::new(SimVenue::new(VenueId::Bybit, vec![market()]));
    host_with(sim, EventLog::open_in_memory().unwrap())
}

fn spec(size: &str, kind: AlgoKind) -> AlgoSpec {
    AlgoSpec {
        venue: VenueId::Bybit,
        // A demo account: it trades without the live switch.
        account: "demo:1".into(),
        market: "BTCUSDT".into(),
        side: Side::Buy,
        size: d(size),
        reduce_only: false,
        max_slippage_bps: 50,
        prefer_native: true,
        kind,
    }
}

/// Waits (in the test's time) until `id`'s state satisfies `done`.
async fn until(host: &TestHost, id: &str, done: impl Fn(&AlgoView) -> bool) -> AlgoView {
    for _ in 0..2_000 {
        if let Some(view) = host.engine.algos().list().into_iter().find(|v| v.id == id) {
            if done(&view) {
                return view;
            }
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    panic!(
        "algo {id} never got there: {:?}",
        host.engine.algos().list()
    );
}

#[tokio::test(start_paused = true)]
async fn a_market_twap_sends_every_slice_and_finishes() {
    let host = host();
    host.sim.push_book(book("100", "100.1"));
    let view = host
        .engine
        .algos()
        .start(
            spec(
                "0.9",
                AlgoKind::Twap {
                    duration_ms: 30_000,
                    slices: 3,
                    randomize: false,
                    style: SliceStyle::Market,
                    unfilled: Unfilled::Market,
                },
            ),
            Origin::Palette,
        )
        .await
        .unwrap();
    assert_eq!(view.runs_on, pewterdesk_core::RunsOn::Local);
    let done = until(&host, &view.id, |v| v.status.is_over()).await;
    assert_eq!(done.status, AlgoStatus::Finished, "{done:?}");
    assert_eq!(done.filled, d("0.9"));
    assert_eq!(done.avg_price, Some(d("100.1")));
    let orders = host.sim.orders();
    assert_eq!(orders.len(), 3);
    assert!(orders.iter().all(|o| o.size == d("0.3")));
    // Each went out under a client id of the router's, logged for this algo.
    let ids = host
        .engine
        .log()
        .unwrap()
        .algo_client_ids(&view.id)
        .unwrap();
    assert_eq!(ids.len(), 3);
    assert!(orders
        .iter()
        .all(|o| o.client_id.as_ref().is_some_and(|c| ids.contains(c))));
    // And the progress reached the page along the way.
    assert!(host.published.lock().unwrap().len() >= 2);
}

#[tokio::test(start_paused = true)]
async fn a_chaser_follows_the_book_until_it_fills() {
    let host = host();
    host.sim.push_book(book("100", "100.1"));
    let view = host
        .engine
        .algos()
        .start(
            spec(
                "1",
                AlgoKind::Chaser {
                    post_only: true,
                    give_up_bps: None,
                    finish_at_market: false,
                },
            ),
            Origin::Ticket,
        )
        .await
        .unwrap();
    until(&host, &view.id, |v| v.open_orders == 1).await;
    assert_eq!(host.sim.orders()[0].price, Some(d("100")));
    // The bid moves up: the order is moved to it.
    host.sim.push_book(book("100.2", "100.3"));
    tokio::time::sleep(Duration::from_secs(3)).await;
    assert_eq!(host.sim.orders()[0].price, Some(d("100.2")));
    assert!(host.sim.sent().iter().any(|s| s.starts_with("amend")));
    // The ask comes down to it: filled.
    host.sim.push_book(book("100.1", "100.2"));
    let done = until(&host, &view.id, |v| v.status.is_over()).await;
    assert_eq!(done.status, AlgoStatus::Finished, "{done:?}");
    assert_eq!(done.filled, d("1"));
    // One order the whole time, moved rather than replaced.
    assert_eq!(host.sim.orders().len(), 1);
}

#[tokio::test(start_paused = true)]
async fn a_stale_book_pauses_a_chaser_until_its_fresh() {
    let host = host();
    // No book yet.
    let view = host
        .engine
        .algos()
        .start(
            spec(
                "1",
                AlgoKind::Chaser {
                    post_only: true,
                    give_up_bps: None,
                    finish_at_market: false,
                },
            ),
            Origin::Ticket,
        )
        .await
        .unwrap();
    let paused = until(&host, &view.id, |v| v.status == AlgoStatus::Paused).await;
    assert_eq!(paused.reason.as_deref(), Some("stale"));
    assert!(host.sim.orders().is_empty());
    host.sim.push_book(book("100", "100.1"));
    until(&host, &view.id, |v| {
        v.status == AlgoStatus::Running && v.open_orders == 1
    })
    .await;
}

#[tokio::test(start_paused = true)]
async fn halt_cancels_everything_an_algo_placed() {
    let host = host();
    host.sim.push_book(book("100", "100.1"));
    let view = host
        .engine
        .algos()
        .start(
            spec(
                "0.9",
                AlgoKind::Scaled {
                    from: d("99"),
                    to: d("97"),
                    count: 3,
                    distribution: Distribution::Flat,
                    post_only: true,
                },
            ),
            Origin::App,
        )
        .await
        .unwrap();
    until(&host, &view.id, |v| v.open_orders == 3).await;
    assert_eq!(host.engine.algos().halt(), 1);
    let done = until(&host, &view.id, |v| v.status.is_over()).await;
    assert_eq!(done.status, AlgoStatus::Stopped);
    assert_eq!(done.reason.as_deref(), Some("halted"));
    assert!(host
        .sim
        .orders()
        .iter()
        .all(|o| o.status == OrderStatus::Cancelled));
}

#[tokio::test(start_paused = true)]
async fn stopping_at_market_sends_exactly_what_didnt_fill() {
    let host = host();
    host.sim.push_book(book("100", "100.1"));
    let view = host
        .engine
        .algos()
        .start(
            spec(
                "1",
                AlgoKind::Chaser {
                    post_only: true,
                    give_up_bps: None,
                    finish_at_market: false,
                },
            ),
            Origin::Ticket,
        )
        .await
        .unwrap();
    until(&host, &view.id, |v| v.open_orders == 1).await;
    host.engine
        .algos()
        .stop(&view.id, StopMode::FinishAtMarket)
        .unwrap();
    let done = until(&host, &view.id, |v| v.status.is_over()).await;
    assert_eq!(done.status, AlgoStatus::Finished, "{done:?}");
    let orders = host.sim.orders();
    assert_eq!(orders[0].status, OrderStatus::Cancelled);
    assert_eq!(orders[1].size, d("1"));
    assert_eq!(orders[1].status, OrderStatus::Filled);
}

#[tokio::test(start_paused = true)]
async fn a_live_account_with_trading_off_is_refused_at_the_start() {
    let host = host();
    host.sim.push_book(book("100", "100.1"));
    let mut live = spec(
        "1",
        AlgoKind::Chaser {
            post_only: true,
            give_up_bps: None,
            finish_at_market: false,
        },
    );
    live.account = "24617703".into();
    assert!(matches!(
        host.engine.algos().start(live, Origin::Ticket).await,
        Err(VenueError::Rejected(_))
    ));
    assert!(host.sim.orders().is_empty());
}

/// The app closes mid-algo (its runtime dropped, as in a crash); on the
/// next start the reconciler marks the algo stopped and cancels what of it
/// still rests - and sends nothing new.
#[test]
fn after_a_restart_an_algo_is_stopped_and_its_orders_cancelled() {
    let dir = std::env::temp_dir().join(format!("pewterdesk-algos-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    let path = dir.join("events.sqlite3");
    let sim = Arc::new(SimVenue::new(VenueId::Bybit, vec![market()]));
    sim.push_book(book("100", "100.1"));

    let id = {
        let first = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        let host = host_with(Arc::clone(&sim), EventLog::open(&path).unwrap());
        let id = first.block_on(async {
            let view = host
                .engine
                .algos()
                .start(
                    spec(
                        "0.9",
                        AlgoKind::Scaled {
                            from: d("99"),
                            to: d("97"),
                            count: 3,
                            distribution: Distribution::Flat,
                            post_only: true,
                        },
                    ),
                    Origin::App,
                )
                .await
                .unwrap();
            until(&host, &view.id, |v| v.open_orders == 3).await;
            view.id
        });
        // The app dies: its tasks go with the runtime.
        drop(first);
        id
    };
    let placed = sim.sent().iter().filter(|s| s.starts_with("place")).count();
    assert_eq!(placed, 3);

    let second = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap();
    let host = host_with(Arc::clone(&sim), EventLog::open(&path).unwrap());
    second.block_on(host.engine.algos().reconcile());
    let view = host
        .engine
        .algos()
        .list()
        .into_iter()
        .find(|v| v.id == id)
        .expect("the algo is listed again");
    assert_eq!(view.status, AlgoStatus::Stopped);
    assert_eq!(view.reason.as_deref(), Some("appClosed"));
    // Its orders are cancelled, and nothing was sent again.
    assert!(sim
        .orders()
        .iter()
        .all(|o| o.status == OrderStatus::Cancelled));
    assert_eq!(
        sim.sent().iter().filter(|s| s.starts_with("place")).count(),
        placed
    );
    // And it's in the history, over.
    assert!(host
        .engine
        .algos()
        .history(10)
        .iter()
        .any(|v| v.id == id && v.status == AlgoStatus::Stopped));
    let _ = std::fs::remove_dir_all(&dir);
}

#[tokio::test(start_paused = true)]
async fn the_venues_switch_is_kept_armed_while_an_algo_runs_here() {
    let host = host();
    host.sim.push_book(book("100", "100.1"));
    let view = host
        .engine
        .algos()
        .start(
            spec(
                "1",
                AlgoKind::Chaser {
                    post_only: true,
                    give_up_bps: None,
                    finish_at_market: false,
                },
            ),
            Origin::Ticket,
        )
        .await
        .unwrap();
    tokio::time::sleep(Duration::from_secs(65)).await;
    let armed = |sent: &[String]| {
        sent.iter()
            .filter(|s| *s == "switch BTCUSDT 120000")
            .count()
    };
    // Armed at once, and again every 30 seconds.
    assert!(armed(&host.sim.sent()) >= 3, "{:?}", host.sim.sent());
    host.engine
        .algos()
        .stop(&view.id, StopMode::Cancel)
        .unwrap();
    until(&host, &view.id, |v| v.status.is_over()).await;
    tokio::time::sleep(Duration::from_secs(35)).await;
    // Turned off once nothing runs here.
    assert_eq!(
        host.sim.sent().last().map(String::as_str),
        Some("switch BTCUSDT off")
    );
    // Every arming went through the router, logged as the engine's.
    let log = host.engine.log().unwrap();
    assert!(log
        .recent(500)
        .unwrap()
        .iter()
        .any(|e| e.operation.as_deref() == Some("scheduleCancel")
            && e.origin.as_deref() == Some("engine")));
}
