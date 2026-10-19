//! Bots end to end: the engine's bot host, paper and live, against
//! `SimVenue`, with candles the test feeds it.

use std::sync::{Arc, Mutex};
use std::time::Duration;

use async_trait::async_trait;
use pewterdesk_core::{
    AlgoView, BookLevel, CandleInterval, Decimal, ExchangeAdapter, Market, OrderBook, PositionSide,
    VenueError, VenueId,
};
use pewterdesk_engine::algo::Host;
use pewterdesk_engine::{Adapters, Calendar, CalendarEvent, Engine, EventLog};
use pewterdesk_sim::SimVenue;
use pewterdesk_strategy::bot::{
    paper_costs, BotLimits, BotMode, BotSpec, BotStatus, BotView, DAY_MS,
};
use pewterdesk_strategy::sim::backtest;
use pewterdesk_strategy::{
    Bar, Compare, CustomParams, GridParams, Intent, Rule, Source, StrategyConfig,
};
use tokio::sync::mpsc;

const H: u64 = 3_600_000;

struct TestHost {
    engine: Engine,
    sim: Arc<SimVenue>,
    bots: Mutex<Vec<BotView>>,
}

struct NoCalendar;

#[async_trait]
impl Calendar for NoCalendar {
    async fn kept(&self) -> Option<Vec<CalendarEvent>> {
        Some(Vec::new())
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
    fn publish(&self, _view: &AlgoView) {}
    fn publish_bot(&self, view: &BotView) {
        self.bots.lock().unwrap().push(view.clone());
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

fn host_with(log: EventLog) -> Arc<TestHost> {
    let sim = Arc::new(SimVenue::new(VenueId::Bybit, vec![market()]));
    sim.push_book(book("100", "100.1"));
    let host = Arc::new(TestHost {
        engine: Engine::load(None, Some(log)),
        sim,
        bots: Mutex::new(Vec::new()),
    });
    let attached: Arc<dyn Host> = host.clone();
    host.engine.algos().attach(Arc::clone(&attached));
    host.engine.bots().attach(attached);
    host
}

fn host() -> Arc<TestHost> {
    host_with(EventLog::open_in_memory().unwrap())
}

fn grid() -> StrategyConfig {
    StrategyConfig::Grid(GridParams {
        lower: 90.0,
        upper: 110.0,
        levels: 9,
        size_per_level: 1.0,
        stop_below: 70.0,
        stop_above: 130.0,
    })
}

fn spec(strategy: StrategyConfig, limits: BotLimits) -> BotSpec {
    BotSpec {
        name: None,
        venue: VenueId::Bybit,
        account: "demo:1".into(),
        market: "BTCUSDT".into(),
        interval: CandleInterval::OneHour,
        strategy,
        limits,
        paper_capital: 10_000.0,
        max_slippage_bps: 500,
    }
}

/// Candles that wander inside the grid's range.
fn wandering(n: u64) -> Vec<Bar> {
    (1..=n)
        .map(|i| {
            let c = 100.0 + 8.0 * ((i as f64) / 7.0).sin();
            Bar {
                time: i * H,
                open: c - 0.5,
                high: c + 2.0,
                low: c - 2.0,
                close: c,
            }
        })
        .collect()
}

/// Waits until the bot's view satisfies `done`.
async fn until(host: &TestHost, id: &str, done: impl Fn(&BotView) -> bool) -> BotView {
    for _ in 0..500 {
        let view = host.engine.bots().get(id).unwrap();
        if done(&view) {
            return view;
        }
        tokio::time::sleep(Duration::from_millis(5)).await;
    }
    panic!("never got there: {:?}", host.engine.bots().get(id).unwrap());
}

/// The intents a bot logged, as (candle time, intent).
fn logged(host: &TestHost, id: &str) -> Vec<(u64, Intent)> {
    host.engine
        .log()
        .unwrap()
        .for_algo(&format!("bot:{id}"), "intent")
        .unwrap()
        .into_iter()
        .map(|e| {
            let time = e.detail["time"].as_u64().unwrap();
            let intent: Intent = serde_json::from_value(e.detail["intent"].clone()).unwrap();
            (time, intent)
        })
        .collect()
}

/// Phase 4's exit test: the same grid, on the same candles, asks the same
/// things in a backtest and paper trading.
#[tokio::test]
async fn a_grid_asks_the_same_in_a_backtest_and_on_paper() {
    let bars = wandering(200);
    let run = backtest(&grid(), paper_costs(VenueId::Bybit, 10_000.0), &bars, 0.0).unwrap();
    let backtested: Vec<(u64, Intent)> = run
        .asked
        .iter()
        .map(|a| (a.time, a.intent.clone()))
        .collect();
    assert!(!backtested.is_empty());

    let host = host();
    let bot = host
        .engine
        .bots()
        .create(spec(grid(), BotLimits::default()))
        .await
        .unwrap();
    assert_eq!(bot.mode, BotMode::Paper);
    let (tx, rx) = mpsc::channel(256);
    host.engine
        .bots()
        .start_with_feed(&bot.id, Vec::new(), rx)
        .await
        .unwrap();
    for bar in &bars {
        tx.send(*bar).await.unwrap();
    }
    let view = until(&host, &bot.id, |v| v.candles == bars.len() as u32).await;
    assert_eq!(logged(&host, &bot.id), backtested);
    // And the same trades.
    assert_eq!(
        view.trades as usize,
        run.trades.len()
            - run
                .trades
                .iter()
                .filter(|t| t.exit_reason == pewterdesk_strategy::Reason::End)
                .count()
    );
    // Paper sends nothing to the venue.
    assert!(host.sim.sent().is_empty());
}

/// Phase 4's other exit test: a bot that hits its daily loss stops,
/// flattens, and says so.
#[tokio::test]
async fn a_bot_at_its_daily_loss_stops_flattens_and_says_so() {
    let always_long = StrategyConfig::Custom(CustomParams {
        side: PositionSide::Long,
        entry: vec![Rule {
            left: Source::Price,
            op: Compare::Above,
            right: Source::Value { value: 0.0 },
        }],
        exit: vec![],
        stop_loss: 0.0,
        take_profit: 0.0,
        size: 1.0,
    });
    let limits = BotLimits {
        daily_loss: Some(200.0),
        ..BotLimits::default()
    };
    let host = host();
    let bot = host
        .engine
        .bots()
        .create(spec(always_long, limits))
        .await
        .unwrap();
    let (tx, rx) = mpsc::channel(16);
    host.engine
        .bots()
        .start_with_feed(&bot.id, Vec::new(), rx)
        .await
        .unwrap();
    let day = 10 * DAY_MS;
    for (i, close) in [100.0, 100.0, 95.0, 90.0].into_iter().enumerate() {
        tx.send(Bar {
            time: day + i as u64 * H,
            open: close,
            high: close,
            low: close,
            close,
        })
        .await
        .unwrap();
    }
    let view = until(&host, &bot.id, |v| v.status != BotStatus::Running).await;
    assert_eq!(view.status, BotStatus::Limit);
    assert_eq!(view.reason.as_deref(), Some("dailyLoss"));
    assert_eq!(view.position, 0.0, "flattened");
    assert!(view.pnl_today <= -200.0);
    // The page heard of it.
    assert!(host
        .bots
        .lock()
        .unwrap()
        .iter()
        .any(|v| v.id == bot.id && v.status == BotStatus::Limit));
}

#[tokio::test]
async fn a_bot_goes_live_only_after_its_paper_run() {
    let host = host();
    let bot = host
        .engine
        .bots()
        .create(spec(grid(), BotLimits::default()))
        .await
        .unwrap();
    assert_eq!(
        host.engine.bots().go_live(&bot.id).await.map(|v| v.id),
        Err(VenueError::Blocked("paperFirst".into()))
    );
    // A live account with trading off can't even start, after its paper run.
    let mut live = spec(grid(), BotLimits::default());
    live.account = "24617703".into();
    let bot = host.engine.bots().create(live).await.unwrap();
    assert!(host.engine.bots().go_live(&bot.id).await.is_err());
}

/// A live grid on SimVenue: its limits go out through the router as the
/// bot's, a fill is read back from the venue, and the strategy's sell for
/// that level follows.
#[tokio::test]
async fn a_live_grid_trades_through_the_router() {
    // A bot whose paper run is over, kept in the log as the engine keeps it.
    let log = EventLog::open_in_memory().unwrap();
    let view = BotView {
        id: "live1".into(),
        spec: spec(grid(), BotLimits::default()),
        mode: BotMode::Live,
        status: BotStatus::Stopped,
        reason: None,
        created_at: 0,
        paper_since: Some(0),
        live_since: Some(1),
        position: 0.0,
        entry: 0.0,
        pnl_today: 0.0,
        pnl_total: 0.0,
        equity: 0.0,
        trades: 0,
        candles: 0,
        last: None,
    };
    log.save_bot("live1", 0, 1, false, &serde_json::to_value(&view).unwrap())
        .unwrap();
    let host = host_with(log);
    let (tx, rx) = mpsc::channel(16);
    host.engine
        .bots()
        .start_with_feed("live1", Vec::new(), rx)
        .await
        .unwrap();
    let bar = |i: u64, c: f64| Bar {
        time: i * H,
        open: c,
        high: c,
        low: c,
        close: c,
    };
    tx.send(bar(1, 100.0)).await.unwrap();
    until(&host, "live1", |v| v.candles == 1).await;
    // Buys rest below the price: 90 to 97.5.
    let placed = host.sim.sent();
    assert!(placed.iter().all(|s| s.starts_with("place")), "{placed:?}");
    assert_eq!(placed.len(), 4, "{placed:?}");
    let command = host
        .engine
        .log()
        .unwrap()
        .recent(50)
        .unwrap()
        .into_iter()
        .find(|e| e.kind == "command")
        .unwrap();
    assert_eq!(command.origin.as_deref(), Some("bot"));
    assert_eq!(command.algo.as_deref(), Some("bot:live1"));
    // The price dips through 97.5: that buy fills on the venue.
    host.sim.push_book(book("97", "97.1"));
    host.sim.push_book(book("100", "100.1"));
    tx.send(bar(2, 100.0)).await.unwrap();
    until(&host, "live1", |v| v.candles == 2).await;
    let sell = host
        .sim
        .orders()
        .into_iter()
        .find(|o| o.side == pewterdesk_core::Side::Sell)
        .expect("its sell one level up follows");
    assert!(sell.reduce_only);
    assert_eq!(sell.price, Some(d("100.0")));
    host.engine.bots().stop("live1", false).unwrap();
    let stopped = until(&host, "live1", |v| v.status == BotStatus::Stopped).await;
    assert_eq!(stopped.mode, BotMode::Live);
    // Stopping took its resting orders off.
    assert!(host
        .sim
        .orders()
        .iter()
        .all(|o| o.status != pewterdesk_core::OrderStatus::Open));
}
