//! Against Hyperliquid's and OKX's public data. Read-only, no key needed,
//! but they need the network (and the leaderboard is some 40 MB), so they're
//! skipped by default. Run them one at a time (`make rust-live`).

use pewterdesk_traders::{
    changes, hyperliquid::Hyperliquid, okx::Okx, AccountRange, Period, SortBy, Source,
};

const fn floor(min: f64) -> AccountRange {
    AccountRange { min, max: None }
}

#[tokio::test]
#[ignore = "reads Hyperliquid's leaderboard and a trader's account"]
async fn hyperliquid_board_and_a_trader() {
    let hl = Hyperliquid::new().unwrap();
    let rows = hl
        .leaderboard(Period::Month, SortBy::Pnl, floor(100_000.0), 50)
        .await
        .unwrap();
    assert_eq!(rows.len(), 50);
    assert!(rows.windows(2).all(|w| w[0].pnl >= w[1].pnl));
    assert!(rows
        .iter()
        .all(|r| r.source == Source::Hyperliquid && r.account_value >= 100_000.0));
    // Read again: from memory, not another 40 MB.
    let again = hl
        .leaderboard(Period::Week, SortBy::Roi, floor(1_000_000.0), 10)
        .await
        .unwrap();
    assert!(again.windows(2).all(|w| w[0].roi >= w[1].roi));
    // "Account >= $1M", and a band of small accounts.
    let million = hl
        .leaderboard(Period::Month, SortBy::Pnl, floor(1_000_000.0), 300)
        .await
        .unwrap();
    assert!(!million.is_empty() && million.iter().all(|r| r.account_value >= 1_000_000.0));
    let band = AccountRange {
        min: 10_000.0,
        max: Some(100_000.0),
    };
    let small = hl
        .leaderboard(Period::Month, SortBy::Pnl, band, 300)
        .await
        .unwrap();
    assert!(!small.is_empty());
    assert!(small
        .iter()
        .all(|r| (10_000.0..100_000.0).contains(&r.account_value)));

    let top = &rows[0].id;
    let stats = hl.stats(top).await.unwrap();
    assert_eq!(stats.weeks.len(), pewterdesk_traders::stats::WEEKS);
    assert!(stats.curve.len() > 10, "a month of points");
    assert!(stats.max_drawdown.is_some_and(|d| (0.0..10.0).contains(&d)));
    let detail = hl.detail(top, Period::Month).await.unwrap();
    assert_eq!(&detail.id, top);
    assert!(!detail.pnl_history.is_empty());
    assert!(detail
        .holdings
        .iter()
        .all(|h| h.size > 0.0 && h.value >= 0.0));
    // Two looks a moment apart: whatever changed, it's read as changes, not noise.
    let (_, now) = hl.holdings(top).await.unwrap();
    assert!(changes(&detail.holdings, &now).len() <= now.len() + detail.holdings.len());
}

#[tokio::test]
#[ignore = "reads OKX's lead traders"]
async fn okx_board_and_a_lead_trader() {
    let okx = Okx::new().unwrap();
    let rows = okx
        .leaderboard(SortBy::Pnl, AccountRange::default(), 40)
        .await
        .unwrap();
    assert_eq!(rows.len(), 40);
    assert!(rows
        .iter()
        .all(|r| r.source == Source::Okx && r.copiers.is_some()));
    let band = AccountRange {
        min: 1_000.0,
        max: Some(10_000.0),
    };
    let small = okx.leaderboard(SortBy::Pnl, band, 20).await.unwrap();
    assert!(!small.is_empty());
    assert!(
        small
            .iter()
            .all(|r| (1_000.0..10_000.0).contains(&r.account_value)),
        "{:?}",
        small.iter().map(|r| r.account_value).collect::<Vec<_>>()
    );
    let code = &rows[0].id;
    assert!(okx.row(code).is_some());
    let stats = okx.stats(code).await.unwrap();
    assert!(stats.weeks.iter().any(|w| w.is_some()));
    assert!(!stats.curve.is_empty());
    let detail = okx.detail(code, Period::Month).await.unwrap();
    assert!(detail
        .holdings
        .iter()
        .all(|h| h.size > 0.0 && h.entry > 0.0));
    assert!(detail.closed.iter().all(|t| t.size > 0.0 && t.time > 0));
    assert!(!detail.weekly_pnl.is_empty());
}
