//! Against Hyperliquid mainnet's public API. Read-only, no key needed, but
//! they need the network, so they're skipped by default:
//! `cargo test -p pewterdesk-exchange-hyperliquid -- --ignored`.

use std::time::Duration;

use pewterdesk_core::{ExchangeAdapter, VenueError};
use pewterdesk_exchange_hyperliquid::{constants::MAINNET, HyperliquidAdapter};
use tokio::time::timeout;

/// A Hyperliquid-run HLP vault account, which always holds positions and
/// resting orders.
const ACTIVE_ACCOUNT: &str = "0x31ca8395cf837de08b24da3f660e77761dfb974b";

fn adapter() -> HyperliquidAdapter {
    HyperliquidAdapter::new(&MAINNET).unwrap()
}

#[tokio::test]
#[ignore = "hits Hyperliquid mainnet"]
async fn lists_markets() {
    let markets = adapter().markets().await.unwrap();
    assert!(markets.iter().any(|m| m.id == "BTC"));
}

#[tokio::test]
#[ignore = "hits Hyperliquid mainnet"]
async fn fetches_order_book() {
    let book = adapter().order_book("BTC").await.unwrap();
    assert!(!book.bids.is_empty() && !book.asks.is_empty());
    assert!(book.bids[0].price < book.asks[0].price);
}

#[tokio::test]
#[ignore = "hits Hyperliquid mainnet"]
async fn unknown_market_is_an_invalid_request() {
    let err = adapter().order_book("NOT-A-COIN").await.unwrap_err();
    assert!(matches!(err, VenueError::InvalidRequest(_)), "{err:?}");
}

#[tokio::test]
#[ignore = "hits Hyperliquid mainnet"]
async fn fetches_account() {
    let account = adapter().account(ACTIVE_ACCOUNT).await.unwrap();
    assert!(!account.positions.is_empty());
}

#[tokio::test]
#[ignore = "hits Hyperliquid mainnet"]
async fn streams_order_book() {
    let mut rx = adapter().subscribe_order_book("BTC").await.unwrap();
    let book = timeout(Duration::from_secs(10), rx.recv())
        .await
        .unwrap()
        .unwrap();
    assert_eq!(book.market, "BTC");
}

#[tokio::test]
#[ignore = "hits Hyperliquid mainnet"]
async fn streams_trades() {
    let mut rx = adapter().subscribe_trades("BTC").await.unwrap();
    let trades = timeout(Duration::from_secs(10), rx.recv())
        .await
        .unwrap()
        .unwrap();
    assert!(!trades.is_empty());
    assert!(trades.iter().all(|t| t.market == "BTC"));
    assert!(
        trades.windows(2).all(|w| w[0].time >= w[1].time),
        "newest first"
    );
}

#[tokio::test]
#[ignore = "hits Hyperliquid mainnet"]
async fn streams_market_stats() {
    let mut rx = adapter().subscribe_market_stats("BTC").await.unwrap();
    let stats = timeout(Duration::from_secs(15), rx.recv())
        .await
        .unwrap()
        .unwrap();
    assert_eq!(stats.market, "BTC");
    let (high, low) = (stats.day_high.unwrap(), stats.day_low.unwrap());
    assert!(low <= high, "{low:?} > {high:?}");
    assert!(stats.next_funding_time > stats.time);
    assert_eq!(stats.funding_interval_secs, 3600);
}

#[tokio::test]
#[ignore = "hits Hyperliquid mainnet"]
async fn streams_account() {
    let mut rx = adapter().subscribe_account(ACTIVE_ACCOUNT).await.unwrap();
    let account = timeout(Duration::from_secs(10), rx.recv())
        .await
        .unwrap()
        .unwrap();
    assert_eq!(account.address, ACTIVE_ACCOUNT);
    assert!(!account.positions.is_empty());
}
