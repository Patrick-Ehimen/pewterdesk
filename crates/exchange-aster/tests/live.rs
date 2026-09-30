//! Against Aster mainnet's public API. Read-only, no key needed, but they
//! need the network, so they're skipped by default. Run them one at a time
//! (`make rust-live`).

use std::time::{Duration, SystemTime, UNIX_EPOCH};

use pewterdesk_core::{CandleInterval, ExchangeAdapter, VenueError};
use pewterdesk_exchange_aster::{constants::MAINNET, AsterAdapter};
use tokio::time::timeout;

fn adapter() -> AsterAdapter {
    AsterAdapter::new(&MAINNET).unwrap()
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_millis() as u64
}

#[tokio::test]
#[ignore = "hits Aster mainnet"]
async fn lists_markets() {
    let markets = adapter().markets().await.unwrap();
    assert!(markets.len() > 100, "got {} markets", markets.len());
    let btc = markets.iter().find(|m| m.id == "BTCUSDT").unwrap();
    assert_eq!(btc.symbol, "BTC-USDT");
    assert_eq!((btc.base.as_str(), btc.quote.as_str()), ("BTC", "USDT"));
    assert!(btc.max_leverage >= 2);
    assert!(!btc.tick_size.0.is_zero() && !btc.size_step.0.is_zero());
}

#[tokio::test]
#[ignore = "hits Aster mainnet"]
async fn fetches_order_book() {
    let book = adapter().order_book("BTCUSDT").await.unwrap();
    assert!(!book.bids.is_empty() && !book.asks.is_empty());
    assert!(book.bids[0].price < book.asks[0].price);
}

#[tokio::test]
#[ignore = "hits Aster mainnet"]
async fn unknown_market_is_an_invalid_request() {
    let adapter = adapter();
    let err = adapter.order_book("NOTACOINUSDT").await.unwrap_err();
    assert!(matches!(err, VenueError::InvalidRequest(_)), "{err:?}");
    // Streams check over REST first, since the stream would just stay silent.
    let err = adapter.subscribe_trades("NOTACOINUSDT").await.unwrap_err();
    assert!(matches!(err, VenueError::InvalidRequest(_)), "{err:?}");
    // URL syntax never reaches the venue.
    let err = adapter.order_book("BTC/USDT").await.unwrap_err();
    assert!(matches!(err, VenueError::InvalidRequest(_)), "{err:?}");
}

#[tokio::test]
#[ignore = "hits Aster mainnet"]
async fn account_data_is_unsupported_for_now() {
    let err = adapter()
        .account("0x0000000000000000000000000000000000000000")
        .await
        .unwrap_err();
    assert!(matches!(err, VenueError::Unsupported(_)), "{err:?}");
}

#[tokio::test]
#[ignore = "hits Aster mainnet"]
async fn streams_order_book() {
    let mut rx = adapter().subscribe_order_book("BTCUSDT").await.unwrap();
    // The REST seed, then the stream.
    for _ in 0..2 {
        let book = timeout(Duration::from_secs(10), rx.recv())
            .await
            .unwrap()
            .unwrap();
        assert_eq!(book.market, "BTCUSDT");
        assert!(!book.bids.is_empty() && !book.asks.is_empty());
    }
}

#[tokio::test]
#[ignore = "hits Aster mainnet"]
async fn streams_trades() {
    let mut rx = adapter().subscribe_trades("BTCUSDT").await.unwrap();
    let trades = timeout(Duration::from_secs(10), rx.recv())
        .await
        .unwrap()
        .unwrap();
    assert!(!trades.is_empty());
    assert!(trades.iter().all(|t| t.market == "BTCUSDT"));
    assert!(
        trades.windows(2).all(|w| w[0].time >= w[1].time),
        "newest first"
    );
}

#[tokio::test]
#[ignore = "hits Aster mainnet"]
async fn streams_market_stats() {
    let mut rx = adapter().subscribe_market_stats("BTCUSDT").await.unwrap();
    for _ in 0..2 {
        let stats = timeout(Duration::from_secs(15), rx.recv())
            .await
            .unwrap()
            .unwrap();
        assert_eq!(stats.market, "BTCUSDT");
        let (high, low) = (stats.day_high.unwrap(), stats.day_low.unwrap());
        assert!(low <= high, "{low:?} > {high:?}");
        assert!(!stats.open_interest.0.is_zero());
        assert!(stats.next_funding_time > stats.time);
        assert!(stats.funding_interval_secs >= 3600);
    }
}

#[tokio::test]
#[ignore = "hits Aster mainnet"]
async fn streams_candles_history_first() {
    let mut rx = adapter()
        .subscribe_candles("BTCUSDT", CandleInterval::OneMinute)
        .await
        .unwrap();
    let history = timeout(Duration::from_secs(15), rx.recv())
        .await
        .unwrap()
        .unwrap();
    assert_eq!(history.len(), 500);
    assert!(history.windows(2).all(|w| w[0].open_time < w[1].open_time));
    let live = timeout(Duration::from_secs(15), rx.recv())
        .await
        .unwrap()
        .unwrap();
    assert_eq!(live.len(), 1);
    assert!(live[0].open_time >= history.last().unwrap().open_time);
}

#[tokio::test]
#[ignore = "hits Aster mainnet"]
async fn streams_market_summaries() {
    let mut rx = adapter().subscribe_market_summaries().await.unwrap();
    let first = timeout(Duration::from_secs(15), rx.recv())
        .await
        .unwrap()
        .unwrap();
    assert!(first.len() > 100, "got {} markets", first.len());
    assert!(first.iter().any(|s| s.market == "BTCUSDT"));
    // Open interest fills in busiest first, so BTC's arrives quickly.
    let later = timeout(Duration::from_secs(20), rx.recv())
        .await
        .unwrap()
        .unwrap();
    let btc = later.iter().find(|s| s.market == "BTCUSDT").unwrap();
    assert!(!btc.open_interest.0.is_zero());
}

#[tokio::test]
#[ignore = "hits Aster mainnet"]
async fn streams_market_history_busiest_first() {
    let mut rx = adapter().subscribe_market_history().await.unwrap();
    let first = timeout(Duration::from_secs(20), rx.recv())
        .await
        .unwrap()
        .unwrap();
    assert!(
        ["BTCUSDT", "ETHUSDT", "ASTERUSDT", "SOLUSDT", "BNBUSDT"].contains(&first.market.as_str()),
        "busiest first, got {}",
        first.market
    );
    assert!(first.candles.len() >= 160, "got {}", first.candles.len());
}

#[tokio::test]
#[ignore = "hits Aster mainnet"]
async fn fetches_funding_history() {
    let day_ago = now_ms() - 24 * 3_600_000;
    let history = adapter().funding_history("BTCUSDT", day_ago).await.unwrap();
    assert!(
        !history.is_empty() && history.len() <= 25,
        "got {}",
        history.len()
    );
    assert!(history.iter().all(|r| r.time >= day_ago));
    assert!(history.windows(2).all(|w| w[0].time < w[1].time));
}

#[tokio::test]
#[ignore = "hits Aster mainnet"]
async fn pages_through_long_funding_history() {
    // From the start: more than one page of 1,000.
    let history = adapter().funding_history("BTCUSDT", 0).await.unwrap();
    assert!(history.len() > 1000, "got {}", history.len());
    assert!(history.windows(2).all(|w| w[0].time < w[1].time));
}

#[tokio::test]
#[ignore = "hits Aster mainnet"]
async fn pages_back_through_candles() {
    let adapter = adapter();
    let now = now_ms();
    let page = adapter
        .candles("BTCUSDT", CandleInterval::OneHour, now, 100)
        .await
        .unwrap();
    assert_eq!(page.len(), 100);
    assert!(page.iter().all(|c| c.open_time < now));
    assert!(page.windows(2).all(|w| w[0].open_time < w[1].open_time));

    let first = page[0].open_time;
    let older = adapter
        .candles("BTCUSDT", CandleInterval::OneHour, first, 100)
        .await
        .unwrap();
    assert!(!older.is_empty() && older.iter().all(|c| c.open_time < first));

    // Before the market existed: nothing.
    let ancient = adapter
        .candles("BTCUSDT", CandleInterval::OneHour, 1_000_000_000_000, 100)
        .await
        .unwrap();
    assert!(ancient.is_empty());
}

#[tokio::test]
#[ignore = "hits Aster mainnet"]
async fn streams_a_non_ascii_market() {
    // Symbols with non-ASCII letters reach the stream percent-encoded.
    let adapter = adapter();
    let markets = adapter.markets().await.unwrap();
    let Some(market) = markets.iter().find(|m| !m.id.is_ascii()) else {
        return; // None listed right now.
    };
    let mut rx = adapter.subscribe_market_stats(&market.id).await.unwrap();
    for _ in 0..2 {
        let stats = timeout(Duration::from_secs(15), rx.recv())
            .await
            .unwrap()
            .unwrap();
        assert_eq!(stats.market, market.id);
    }
}

#[tokio::test]
#[ignore = "hits Aster mainnet"]
async fn fetches_market_icons() {
    let adapter = adapter();
    let btc = adapter.market_icon("BTCUSDT").await.unwrap().unwrap();
    assert!(btc.starts_with("<svg") && btc.contains("data:image/png;base64,"));
    // Cached: the second call makes no request.
    assert_eq!(adapter.market_icon("BTCUSDT").await.unwrap(), Some(btc));
    assert!(adapter.market_icon("ETHUSDT").await.unwrap().is_some());
    // Unknown markets have no logo.
    assert_eq!(adapter.market_icon("NOTACOINUSDT").await.unwrap(), None);
}

#[tokio::test]
#[ignore = "hits Aster mainnet"]
async fn prices_come_at_the_markets_precision() {
    let adapter = adapter();
    let markets = adapter.markets().await.unwrap();
    let btc = markets.iter().find(|m| m.id == "BTCUSDT").unwrap();
    let places = |d: &pewterdesk_core::Decimal| d.0.scale();
    let tick = btc.tick_size.0.normalize().scale();

    let mut rx = adapter.subscribe_market_stats("BTCUSDT").await.unwrap();
    let stats = timeout(Duration::from_secs(15), rx.recv())
        .await
        .unwrap()
        .unwrap();
    assert_eq!(places(&stats.mark_price), tick);
    assert_eq!(places(&stats.index_price.unwrap()), tick);
    assert_eq!(places(&stats.day_volume), 2);

    let mut rx = adapter.subscribe_market_summaries().await.unwrap();
    let summaries = timeout(Duration::from_secs(15), rx.recv())
        .await
        .unwrap()
        .unwrap();
    let s = summaries.iter().find(|s| s.market == "BTCUSDT").unwrap();
    assert_eq!(places(&s.mark_price), tick);
    assert_eq!(places(&s.day_volume), 2);
}
