//! Against Bybit mainnet's public API. Read-only, no key needed, but they
//! need the network, so they're skipped by default. Run them one at a time
//! (`make rust-live`). The one signed request uses a made-up key, never a
//! real one.

use std::time::{Duration, SystemTime, UNIX_EPOCH};

use pewterdesk_core::{CandleInterval, ExchangeAdapter, VenueError};
use pewterdesk_exchange_bybit::{auth::ApiCredentials, constants::MAINNET, BybitAdapter};
use tokio::time::timeout;

fn adapter() -> BybitAdapter {
    BybitAdapter::new(&MAINNET).unwrap()
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_millis() as u64
}

const WAIT: Duration = Duration::from_secs(15);

#[tokio::test]
#[ignore = "hits Bybit mainnet"]
async fn lists_perpetuals() {
    let markets = adapter().markets().await.unwrap();
    assert!(markets.len() > 300, "got {} markets", markets.len());
    let btc = markets.iter().find(|m| m.id == "BTCUSDT").unwrap();
    assert_eq!(btc.symbol, "BTC-USDT");
    assert!(btc.max_leverage >= 50);
    assert!(!btc.tick_size.0.is_zero() && !btc.size_step.0.is_zero());
    // Dated futures (ids with a dash) are left out.
    assert!(markets.iter().all(|m| !m.id.contains('-')));
}

#[tokio::test]
#[ignore = "hits Bybit mainnet"]
async fn fetches_and_streams_the_book() {
    let adapter = adapter();
    let book = adapter.order_book("BTCUSDT").await.unwrap();
    assert!(!book.bids.is_empty() && !book.asks.is_empty());
    assert!(book.bids[0].price < book.asks[0].price);
    let mut rx = adapter.subscribe_order_book("BTCUSDT").await.unwrap();
    let _seed = timeout(WAIT, rx.recv()).await.unwrap().unwrap();
    let live = timeout(WAIT, rx.recv()).await.unwrap().unwrap();
    assert!(live.bids.len() > 5 && live.asks.len() > 5);
    assert!(live.bids[0].price < live.asks[0].price);
    assert!(live.bids.windows(2).all(|w| w[0].price > w[1].price));
}

#[tokio::test]
#[ignore = "hits Bybit mainnet"]
async fn unknown_market_is_an_invalid_request() {
    let adapter = adapter();
    let err = adapter.order_book("NOTACOINUSDT").await.unwrap_err();
    assert!(matches!(err, VenueError::InvalidRequest(_)), "{err:?}");
    let err = adapter.subscribe_trades("NOTACOINUSDT").await.unwrap_err();
    assert!(matches!(err, VenueError::InvalidRequest(_)), "{err:?}");
    let err = adapter.order_book("BTC/USDT").await.unwrap_err();
    assert!(matches!(err, VenueError::InvalidRequest(_)), "{err:?}");
}

#[tokio::test]
#[ignore = "hits Bybit mainnet"]
async fn streams_trades_and_stats() {
    let adapter = adapter();
    let mut trades = adapter.subscribe_trades("BTCUSDT").await.unwrap();
    let tape = timeout(WAIT, trades.recv()).await.unwrap().unwrap();
    assert!(!tape.is_empty());
    assert!(tape.windows(2).all(|w| w[0].time >= w[1].time));

    let mut stats = adapter.subscribe_market_stats("BTCUSDT").await.unwrap();
    let first = timeout(WAIT, stats.recv()).await.unwrap().unwrap();
    assert!(!first.mark_price.0.is_zero());
    assert!(!first.open_interest.0.is_zero());
    assert!(first.funding_interval_secs >= 3600);
    assert!(first.next_funding_time > now_ms());
    let live = timeout(WAIT, stats.recv()).await.unwrap().unwrap();
    assert!(live.mid_price.is_some());
}

#[tokio::test]
#[ignore = "hits Bybit mainnet"]
async fn streams_candles_including_built_widths() {
    let adapter = adapter();
    let mut hourly = adapter
        .subscribe_candles("BTCUSDT", CandleInterval::OneHour)
        .await
        .unwrap();
    let history = timeout(WAIT, hourly.recv()).await.unwrap().unwrap();
    assert!(history.len() >= 400);
    assert!(history
        .windows(2)
        .all(|w| w[1].open_time - w[0].open_time == 3_600_000));

    // No 8-hour klines on Bybit: built from 4-hour ones, on 8-hour boundaries.
    let eight = CandleInterval::EightHours.millis();
    let mut built = adapter
        .subscribe_candles("BTCUSDT", CandleInterval::EightHours)
        .await
        .unwrap();
    let history = timeout(WAIT, built.recv()).await.unwrap().unwrap();
    assert!(history.len() >= 400, "got {}", history.len());
    assert!(history.iter().all(|c| c.open_time % eight == 0));
    assert!(history
        .windows(2)
        .all(|w| w[1].open_time - w[0].open_time == eight));
    let live = timeout(Duration::from_secs(30), built.recv())
        .await
        .unwrap()
        .unwrap();
    assert_eq!(live[0].open_time, history.last().unwrap().open_time);
}

#[tokio::test]
#[ignore = "hits Bybit mainnet"]
async fn pages_candles_back() {
    let before = now_ms() - 30 * 86_400_000;
    let page = adapter()
        .candles("BTCUSDT", CandleInterval::OneDay, before, 20)
        .await
        .unwrap();
    assert_eq!(page.len(), 20);
    assert!(page.iter().all(|c| c.open_time < before));
}

#[tokio::test]
#[ignore = "hits Bybit mainnet"]
async fn summarizes_every_market() {
    let mut rx = adapter().subscribe_market_summaries().await.unwrap();
    let rows = timeout(WAIT, rx.recv()).await.unwrap().unwrap();
    assert!(rows.len() > 300, "got {}", rows.len());
    assert!(rows.windows(2).all(|w| w[0].day_volume >= w[1].day_volume));
    assert!(rows
        .iter()
        .any(|r| r.market == "BTCUSDT" && !r.open_interest.0.is_zero()));
}

#[tokio::test]
#[ignore = "hits Bybit mainnet"]
async fn fetches_funding_history() {
    let since = now_ms() - 10 * 86_400_000;
    let rates = adapter().funding_history("BTCUSDT", since).await.unwrap();
    // 8-hourly: about 30 in ten days.
    assert!((25..=35).contains(&rates.len()), "got {}", rates.len());
    assert!(rates.windows(2).all(|w| w[0].time < w[1].time));
    assert!(rates.iter().all(|r| r.time >= since));
}

#[tokio::test]
#[ignore = "hits Bybit mainnet"]
async fn account_data_is_unsupported_for_now() {
    let err = adapter().account("anything").await.unwrap_err();
    assert!(matches!(err, VenueError::Unsupported(_)), "{err:?}");
}

/// A made-up key reaches Bybit's key check and is refused as unknown - not
/// as a malformed request - so the path, headers and signature format are
/// what Bybit expects. Nothing is stored or accepted.
#[tokio::test]
#[ignore = "hits Bybit mainnet"]
async fn an_unknown_key_is_refused_as_unknown() {
    let creds = ApiCredentials::new(
        "PDTESTKEY000000000",
        zeroize::Zeroizing::new("PDTESTSECRET0000000000000000000000000".into()),
    )
    .unwrap();
    // Both the live host and Demo Trading's.
    for demo in [false, true] {
        let err = adapter().api_key_info(&creds, demo).await.unwrap_err();
        assert!(
            matches!(&err, VenueError::InvalidRequest(m) if m.contains("recognise")),
            "demo {demo}: {err:?}"
        );
    }
}
