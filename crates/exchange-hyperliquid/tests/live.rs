//! Against Hyperliquid mainnet's public API. Read-only, no key needed, but
//! they need the network, so they're skipped by default:
//! `cargo test -p pewterdesk-exchange-hyperliquid -- --ignored`.

use std::time::Duration;

use pewterdesk_core::{CandleInterval, ExchangeAdapter, VenueError};
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
    let btc = markets.iter().find(|m| m.id == "BTC").unwrap();
    assert_eq!(btc.listed_by, None);
    // Builder-deployed (HIP-3) markets come too, labelled with their exchange.
    let tsla = markets.iter().find(|m| m.id == "xyz:TSLA").unwrap();
    assert_eq!(tsla.listed_by.as_deref(), Some("xyz"));
    assert_eq!(tsla.base, "TSLA");
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
async fn streams_candles_history_first() {
    let mut rx = adapter()
        .subscribe_candles("BTC", CandleInterval::OneHour)
        .await
        .unwrap();
    let history = timeout(Duration::from_secs(15), rx.recv())
        .await
        .unwrap()
        .unwrap();
    assert!(history.len() > 100, "got {} candles", history.len());
    assert!(
        history.windows(2).all(|w| w[0].open_time < w[1].open_time),
        "oldest first"
    );
    assert!(history.iter().all(|c| c.low <= c.high));
}

#[tokio::test]
#[ignore = "hits Hyperliquid mainnet"]
async fn streams_market_summaries() {
    let mut rx = adapter().subscribe_market_summaries().await.unwrap();
    let summaries = timeout(Duration::from_secs(15), rx.recv())
        .await
        .unwrap()
        .unwrap();
    assert!(summaries.iter().any(|s| s.market == "BTC"));
    assert!(summaries.len() > 50, "got {} markets", summaries.len());

    // Builder exchanges arrive with the first all-exchanges push.
    let with_builders = timeout(Duration::from_secs(30), async {
        loop {
            let summaries = rx.recv().await.unwrap();
            if summaries.iter().any(|s| s.market == "xyz:TSLA") {
                return summaries;
            }
        }
    })
    .await
    .unwrap();
    assert!(with_builders.iter().any(|s| s.market == "BTC"));
}

#[tokio::test]
#[ignore = "hits Hyperliquid mainnet"]
async fn streams_market_history_busiest_first() {
    let mut rx = adapter().subscribe_market_history().await.unwrap();
    let first = timeout(Duration::from_secs(20), rx.recv())
        .await
        .unwrap()
        .unwrap();
    // BTC or ETH is almost always the busiest perp.
    assert!(
        ["BTC", "ETH", "HYPE", "SOL"].contains(&first.market.as_str()),
        "{}",
        first.market
    );
    assert!(
        first.candles.len() > 100,
        "got {} candles",
        first.candles.len()
    );
}

#[tokio::test]
#[ignore = "hits Hyperliquid mainnet"]
async fn fetches_funding_history() {
    let since = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_millis() as u64
        - 12 * 3_600_000;
    let history = adapter().funding_history("BTC", since).await.unwrap();
    assert!((10..=13).contains(&history.len()), "got {}", history.len());
    assert!(history.windows(2).all(|w| w[0].time < w[1].time));
}

#[tokio::test]
#[ignore = "hits Hyperliquid mainnet"]
async fn pages_through_long_funding_history() {
    // 30 days of hourly payments is ~720: more than one 500-entry page.
    let since = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_millis() as u64
        - 30 * 24 * 3_600_000;
    let history = adapter().funding_history("BTC", since).await.unwrap();
    assert!(
        (700..=722).contains(&history.len()),
        "got {}",
        history.len()
    );
    // No overlap between pages.
    assert!(history.windows(2).all(|w| w[0].time < w[1].time));
}

#[tokio::test]
#[ignore = "hits Hyperliquid mainnet"]
async fn pages_back_through_candles() {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_millis() as u64;
    let adapter = adapter();
    let page = adapter
        .candles("BTC", CandleInterval::OneHour, now, 100)
        .await
        .unwrap();
    assert!((99..=101).contains(&page.len()), "got {}", page.len());
    assert!(page.windows(2).all(|w| w[0].open_time < w[1].open_time));
    // The page before it ends where this one starts.
    let first = page[0].open_time;
    let older = adapter
        .candles("BTC", CandleInterval::OneHour, first, 100)
        .await
        .unwrap();
    assert!(!older.is_empty() && older.iter().all(|c| c.open_time < first));
    // Far past what the venue keeps: nothing, not an error.
    let ancient = adapter
        .candles(
            "BTC",
            CandleInterval::OneMinute,
            now - 365 * 24 * 3_600_000,
            100,
        )
        .await
        .unwrap();
    assert!(ancient.is_empty());
}

#[tokio::test]
#[ignore = "hits Hyperliquid mainnet"]
async fn fetches_market_icons() {
    let adapter = adapter();
    let btc = adapter.market_icon("BTC").await.unwrap().unwrap();
    assert!(btc.contains("<svg"));
    // Per-thousand markets borrow the plain coin's logo.
    assert!(adapter.market_icon("kPEPE").await.unwrap().is_some());
    assert!(adapter.market_icon("xyz:TSLA").await.unwrap().is_some());
    // An unknown coin gets the web app's HTML page, which isn't a logo.
    assert_eq!(adapter.market_icon("NOTACOIN").await.unwrap(), None);
}

#[tokio::test]
#[ignore = "hits Hyperliquid mainnet"]
async fn fetches_account_history() {
    let adapter = adapter();
    let fills = adapter.fills(ACTIVE_ACCOUNT).await.unwrap();
    assert!(!fills.is_empty());
    assert!(
        fills.windows(2).all(|w| w[0].time >= w[1].time),
        "fills newest first"
    );

    let orders = adapter.order_history(ACTIVE_ACCOUNT).await.unwrap();
    assert!(!orders.is_empty());
    assert!(orders
        .windows(2)
        .all(|w| w[0].created_at >= w[1].created_at));

    let week_ago = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_millis() as u64
        - 7 * 24 * 3_600_000;
    let funding = adapter
        .funding_payments(ACTIVE_ACCOUNT, week_ago)
        .await
        .unwrap();
    assert!(
        funding.windows(2).all(|w| w[0].time >= w[1].time),
        "funding newest first"
    );
    assert!(funding.iter().all(|p| p.time >= week_ago));

    // A malformed address never reaches the venue.
    assert!(adapter.fills("not-an-address").await.is_err());
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
