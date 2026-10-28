//! Against BloFin mainnet's (and Demo Trading's) public API. Read-only, no
//! key needed, but they need the network, so they're skipped by default.
//! Run them one at a time (`make rust-live`).

use std::time::{Duration, SystemTime, UNIX_EPOCH};

use pewterdesk_core::{CandleInterval, ExchangeAdapter, MarketCategory, VenueError};
use pewterdesk_exchange_blofin::auth::ApiCredentials;
use pewterdesk_exchange_blofin::{constants::MAINNET, BlofinAdapter};
use tokio::time::timeout;
use zeroize::Zeroizing;

fn adapter() -> BlofinAdapter {
    BlofinAdapter::new(&MAINNET).unwrap()
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_millis() as u64
}

#[tokio::test]
#[ignore = "hits BloFin mainnet"]
async fn lists_markets_in_base_units() {
    let markets = adapter().markets().await.unwrap();
    assert!(markets.len() > 300, "got {} markets", markets.len());
    let btc = markets.iter().find(|m| m.id == "BTC-USDT").unwrap();
    assert_eq!((btc.base.as_str(), btc.quote.as_str()), ("BTC", "USDT"));
    // 0.1 contracts of 0.001 BTC.
    assert!(
        btc.size_step.0 < "0.01".parse().unwrap(),
        "{:?}",
        btc.size_step
    );
    assert!(btc.max_leverage >= 2);
    assert!(markets
        .iter()
        .any(|m| m.category == Some(MarketCategory::Stock)));
    // No coin-margined (inverse) markets.
    assert!(!markets.iter().any(|m| m.id.ends_with("-USD")));
}

#[tokio::test]
#[ignore = "hits BloFin mainnet"]
async fn fetches_order_book() {
    let book = adapter().order_book("BTC-USDT").await.unwrap();
    assert!(book.bids.len() > 50 && book.asks.len() > 50);
    assert!(book.bids[0].price < book.asks[0].price);
    assert!(book.bids[0].price > book.bids[1].price);
    // Base units: no single level holds thousands of BTC.
    assert!(book.bids[0].size.0 < "1000".parse().unwrap());
}

#[tokio::test]
#[ignore = "hits BloFin mainnet"]
async fn unknown_market_is_an_invalid_request() {
    let adapter = adapter();
    let err = adapter.order_book("NOTACOIN-USDT").await.unwrap_err();
    assert!(matches!(err, VenueError::InvalidRequest(_)), "{err:?}");
    let err = adapter.subscribe_trades("NOTACOIN-USDT").await.unwrap_err();
    assert!(matches!(err, VenueError::InvalidRequest(_)), "{err:?}");
    let err = adapter.order_book("BTC-USDT&size=1").await.unwrap_err();
    assert!(matches!(err, VenueError::InvalidRequest(_)), "{err:?}");
}

#[tokio::test]
#[ignore = "hits BloFin mainnet"]
async fn streams_the_book() {
    let mut rx = adapter().subscribe_order_book("BTC-USDT").await.unwrap();
    let first = timeout(Duration::from_secs(10), rx.recv())
        .await
        .unwrap()
        .unwrap();
    assert!(!first.bids.is_empty());
    // The WebSocket's own snapshot and updates follow.
    for _ in 0..3 {
        let book = timeout(Duration::from_secs(10), rx.recv())
            .await
            .unwrap()
            .unwrap();
        assert!(book.bids.len() > 50, "{}", book.bids.len());
        assert!(book.bids[0].price < book.asks[0].price);
    }
}

#[tokio::test]
#[ignore = "hits BloFin Demo Trading"]
async fn streams_demo_tradings_own_book() {
    let mut rx = adapter()
        .subscribe_account_order_book("demo:1", "BTC-USDT")
        .await
        .unwrap();
    for _ in 0..2 {
        let book = timeout(Duration::from_secs(10), rx.recv())
            .await
            .unwrap()
            .unwrap();
        assert!(!book.bids.is_empty() && !book.asks.is_empty());
    }
}

#[tokio::test]
#[ignore = "hits BloFin mainnet"]
async fn streams_trades() {
    let mut rx = adapter().subscribe_trades("BTC-USDT").await.unwrap();
    let first = timeout(Duration::from_secs(10), rx.recv())
        .await
        .unwrap()
        .unwrap();
    assert!(first.len() > 10);
    let next = timeout(Duration::from_secs(30), rx.recv())
        .await
        .unwrap()
        .unwrap();
    assert!(next[0].time >= first[0].time);
}

#[tokio::test]
#[ignore = "hits BloFin mainnet"]
async fn streams_stats() {
    let mut rx = adapter().subscribe_market_stats("BTC-USDT").await.unwrap();
    let first = timeout(Duration::from_secs(10), rx.recv())
        .await
        .unwrap()
        .unwrap();
    assert!(first.mark_price.0 > "1000".parse().unwrap());
    assert!(first.next_funding_time > now_ms());
    assert!(
        first.open_interest.0 > rust_decimal::Decimal::ZERO,
        "no open interest"
    );
    assert_eq!(first.funding_interval_secs, 8 * 3600);
    let next = timeout(Duration::from_secs(15), rx.recv())
        .await
        .unwrap()
        .unwrap();
    assert!(next.day_volume.0 > rust_decimal::Decimal::ZERO);
}

#[tokio::test]
#[ignore = "hits BloFin mainnet"]
async fn streams_candles_and_pages_back() {
    let adapter = adapter();
    let mut rx = adapter
        .subscribe_candles("BTC-USDT", CandleInterval::OneMinute)
        .await
        .unwrap();
    let history = timeout(Duration::from_secs(10), rx.recv())
        .await
        .unwrap()
        .unwrap();
    assert!(history.len() >= 400);
    assert!(history[0].open_time < history[1].open_time);
    let live = timeout(Duration::from_secs(15), rx.recv())
        .await
        .unwrap()
        .unwrap();
    assert!(live[0].open_time >= history.last().unwrap().open_time);
    let older = adapter
        .candles(
            "BTC-USDT",
            CandleInterval::OneHour,
            history[0].open_time,
            100,
        )
        .await
        .unwrap();
    assert_eq!(older.len(), 100);
    assert!(older.last().unwrap().open_time < history[0].open_time);
}

#[tokio::test]
#[ignore = "hits BloFin mainnet"]
async fn summarises_every_market() {
    let mut rx = adapter().subscribe_market_summaries().await.unwrap();
    let first = timeout(Duration::from_secs(15), rx.recv())
        .await
        .unwrap()
        .unwrap();
    assert!(first.len() > 300);
    // Open interest, in base units, for most of them.
    let with_oi = first
        .iter()
        .filter(|s| s.open_interest.0 > rust_decimal::Decimal::ZERO)
        .count();
    assert!(with_oi > first.len() / 2, "{with_oi} of {}", first.len());
    // Busiest first.
    assert!(first[0].day_volume >= first[10].day_volume);
}

#[tokio::test]
#[ignore = "hits BloFin mainnet"]
async fn reads_funding_history() {
    let since = now_ms() - 30 * 24 * 3_600_000;
    let rates = adapter().funding_history("BTC-USDT", since).await.unwrap();
    // Three a day for 30 days.
    assert!(rates.len() >= 85, "got {}", rates.len());
    assert!(rates[0].time >= since);
    assert!(rates[0].time < rates[1].time);
}

/// A made-up Demo Trading key is refused by BloFin, which shows the signed
/// request reached it in the shape it expects.
#[tokio::test]
#[ignore = "hits BloFin Demo Trading"]
async fn a_made_up_key_is_refused() {
    let creds = ApiCredentials::new(
        "4b6ce8b1a6e64c0ba5f9d2c8e4f7a901",
        Zeroizing::new("6b1fd4b09e8c4c3a9f4b8a2e5d7c1f30".into()),
        Zeroizing::new("passphrase".into()),
    )
    .unwrap();
    let err = adapter().check_key(&creds, true).await.unwrap_err();
    // BloFin's "no such key" (152401), not a malformed request.
    assert!(err.to_string().contains("doesn't know this key"), "{err:?}");
    // A live key is refused before anything is sent.
    let err = adapter().check_key(&creds, false).await.unwrap_err();
    assert!(err.to_string().contains("Demo Trading"), "{err}");
}

/// With a Demo Trading account on screen, the markets are Demo Trading's
/// own: fewer, and none that only mainnet lists.
#[tokio::test]
#[ignore = "hits BloFin mainnet and Demo Trading"]
async fn demo_market_data_is_demo_tradings_own() {
    let adapter = adapter();
    let mainnet = adapter.markets().await.unwrap();
    assert!(adapter.set_demo_market_data(true));
    let demo = adapter.markets().await.unwrap();
    assert!(
        demo.len() < mainnet.len(),
        "{} vs {}",
        demo.len(),
        mainnet.len()
    );
    assert!(demo.iter().any(|m| m.id == "BTC-USDT"));
    let only_mainnet = mainnet
        .iter()
        .find(|m| !demo.iter().any(|d| d.id == m.id))
        .expect("a market only mainnet lists");
    let err = adapter.order_book(&only_mainnet.id).await.unwrap_err();
    assert!(matches!(err, VenueError::InvalidRequest(_)), "{err:?}");
    // Back to mainnet's.
    assert!(adapter.set_demo_market_data(false));
    assert!(adapter.order_book(&only_mainnet.id).await.is_ok());
}
