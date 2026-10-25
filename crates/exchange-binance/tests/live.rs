//! Against Binance mainnet's public futures API. Read-only, no key needed,
//! but they need the network, so they're skipped by default. Run them one
//! at a time (`make rust-live`).

use std::time::{Duration, SystemTime, UNIX_EPOCH};

use pewterdesk_core::{CandleInterval, ExchangeAdapter, MarketCategory, VenueError};
use pewterdesk_exchange_binance::auth::ApiCredentials;
use pewterdesk_exchange_binance::{constants::MAINNET, BinanceAdapter};
use tokio::time::timeout;
use zeroize::Zeroizing;

fn adapter() -> BinanceAdapter {
    BinanceAdapter::new(&MAINNET).unwrap()
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_millis() as u64
}

#[tokio::test]
#[ignore = "hits Binance mainnet"]
async fn lists_markets() {
    let markets = adapter().markets().await.unwrap();
    assert!(markets.len() > 300, "got {} markets", markets.len());
    let btc = markets.iter().find(|m| m.id == "BTCUSDT").unwrap();
    assert_eq!(btc.symbol, "BTC-USDT");
    assert_eq!((btc.base.as_str(), btc.quote.as_str()), ("BTC", "USDT"));
    assert!(btc.max_leverage >= 2);
    assert!(!btc.tick_size.0.is_zero() && !btc.size_step.0.is_zero());
    assert!(btc.listed_at.is_some());
    // The TradFi perpetuals come with their category; no dated futures.
    assert!(markets
        .iter()
        .any(|m| m.category == Some(MarketCategory::Stock)));
    assert!(!markets.iter().any(|m| m.id.contains('_')));
}

#[tokio::test]
#[ignore = "hits Binance mainnet"]
async fn fetches_order_book() {
    let book = adapter().order_book("BTCUSDT").await.unwrap();
    assert!(book.bids.len() > 100 && book.asks.len() > 100);
    assert!(book.bids[0].price < book.asks[0].price);
    assert!(book.bids[0].price > book.bids[1].price);
}

#[tokio::test]
#[ignore = "hits Binance mainnet"]
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
#[ignore = "hits Binance mainnet"]
async fn account_data_needs_a_key_store() {
    let err = adapter().account("354937868").await.unwrap_err();
    assert!(matches!(err, VenueError::Unsupported(_)), "{err:?}");
}

#[tokio::test]
#[ignore = "hits Binance mainnet"]
async fn a_made_up_key_is_refused_plainly() {
    let creds = ApiCredentials::new(&"A".repeat(64), Zeroizing::new("B".repeat(64))).unwrap();
    for demo in [false, true] {
        let err = adapter().check_key(&creds, demo).await.unwrap_err();
        assert!(
            matches!(&err, VenueError::InvalidRequest(m) if m.contains("refused the key")),
            "{demo}: {err:?}"
        );
    }
}

#[tokio::test]
#[ignore = "hits Binance mainnet"]
async fn streams_order_book() {
    let mut rx = adapter().subscribe_order_book("BTCUSDT").await.unwrap();
    // The REST seed, then the book kept from the diff stream.
    let mut last = 0;
    for _ in 0..4 {
        let book = timeout(Duration::from_secs(10), rx.recv())
            .await
            .unwrap()
            .unwrap();
        assert_eq!(book.market, "BTCUSDT");
        assert!(!book.bids.is_empty() && !book.asks.is_empty());
        assert!(book.bids[0].price < book.asks[0].price, "crossed book");
        assert!(book.time >= last);
        last = book.time;
    }
}

#[tokio::test]
#[ignore = "hits Binance mainnet"]
async fn streams_trades_newest_first() {
    let mut rx = adapter().subscribe_trades("BTCUSDT").await.unwrap();
    let first = timeout(Duration::from_secs(10), rx.recv())
        .await
        .unwrap()
        .unwrap();
    assert!(first.len() >= 50);
    assert!(first[0].time >= first[first.len() - 1].time);
    // A live print on top of the seed.
    let next = timeout(Duration::from_secs(20), rx.recv())
        .await
        .unwrap()
        .unwrap();
    assert!(next[0].time >= first[0].time);
}

#[tokio::test]
#[ignore = "hits Binance mainnet"]
async fn streams_market_stats() {
    let mut rx = adapter().subscribe_market_stats("BTCUSDT").await.unwrap();
    for _ in 0..2 {
        let stats = timeout(Duration::from_secs(10), rx.recv())
            .await
            .unwrap()
            .unwrap();
        assert_eq!(stats.market, "BTCUSDT");
        assert!(!stats.mark_price.0.is_zero());
        assert!(!stats.open_interest.0.is_zero());
        assert!(stats.mid_price.is_some());
        assert!(stats.next_funding_time > now_ms());
    }
}

#[tokio::test]
#[ignore = "hits Binance mainnet"]
async fn streams_candles() {
    let mut rx = adapter()
        .subscribe_candles("BTCUSDT", CandleInterval::OneMinute)
        .await
        .unwrap();
    let history = timeout(Duration::from_secs(10), rx.recv())
        .await
        .unwrap()
        .unwrap();
    assert_eq!(history.len(), 500);
    assert!(history[0].open_time < history[499].open_time);
    let live = timeout(Duration::from_secs(10), rx.recv())
        .await
        .unwrap()
        .unwrap();
    assert!(live[0].open_time >= history[499].open_time);
}

#[tokio::test]
#[ignore = "hits Binance mainnet"]
async fn pages_back_through_candles() {
    let before = now_ms() - 30 * 24 * 3_600_000;
    let candles = adapter()
        .candles("BTCUSDT", CandleInterval::OneHour, before, 200)
        .await
        .unwrap();
    assert_eq!(candles.len(), 200);
    assert!(candles.iter().all(|c| c.open_time < before));
}

#[tokio::test]
#[ignore = "hits Binance mainnet"]
async fn streams_summaries() {
    let mut rx = adapter().subscribe_market_summaries().await.unwrap();
    let first = timeout(Duration::from_secs(15), rx.recv())
        .await
        .unwrap()
        .unwrap();
    assert!(first.len() > 300);
    // Busiest first.
    assert!(first[0].day_volume >= first[first.len() - 1].day_volume);
    assert!(first.iter().any(|s| s.funding_interval_secs == 4 * 3600));
}

#[tokio::test]
#[ignore = "hits Binance mainnet"]
async fn reads_positioning_and_funding_history() {
    let adapter = adapter();
    let oi = adapter.open_interest_history("BTCUSDT", 48).await.unwrap();
    assert_eq!(oi.len(), 48);
    assert!(oi[0].time < oi[47].time);
    let ratio = adapter.long_short_ratio("BTCUSDT", 24).await.unwrap();
    assert_eq!(ratio.len(), 24);
    let one = ratio[0].long_ratio.0 + ratio[0].short_ratio.0;
    assert!((one - rust_decimal::Decimal::ONE).abs() < rust_decimal::Decimal::new(1, 2));
    let funding = adapter
        .funding_history("BTCUSDT", now_ms() - 7 * 24 * 3_600_000)
        .await
        .unwrap();
    // Every 8 hours.
    assert!((20..=22).contains(&funding.len()), "{}", funding.len());
}

#[tokio::test]
#[ignore = "hits Binance mainnet"]
async fn subscribes_to_liquidations() {
    // Quiet markets may send nothing for a while; connecting is the check.
    let rx = adapter().subscribe_liquidations().await.unwrap();
    drop(rx);
}
