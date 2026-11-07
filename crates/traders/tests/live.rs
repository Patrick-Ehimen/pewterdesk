//! Against Hyperliquid's and OKX's public data. Read-only, no key needed,
//! but they need the network (and the leaderboard is some 40 MB), so they're
//! skipped by default. Run them one at a time (`make rust-live`).

use pewterdesk_traders::{changes, hyperliquid::Hyperliquid, okx::Okx, Period, SortBy, Source};

#[tokio::test]
#[ignore = "reads Hyperliquid's leaderboard and a trader's account"]
async fn hyperliquid_board_and_a_trader() {
    let hl = Hyperliquid::new().unwrap();
    let rows = hl
        .leaderboard(Period::Month, SortBy::Pnl, 100_000.0, 50)
        .await
        .unwrap();
    assert_eq!(rows.len(), 50);
    assert!(rows.windows(2).all(|w| w[0].pnl >= w[1].pnl));
    assert!(rows
        .iter()
        .all(|r| r.source == Source::Hyperliquid && r.account_value >= 100_000.0));
    // Read again: from memory, not another 40 MB.
    let again = hl
        .leaderboard(Period::Week, SortBy::Roi, 1_000_000.0, 10)
        .await
        .unwrap();
    assert!(again.windows(2).all(|w| w[0].roi >= w[1].roi));

    let top = &rows[0].id;
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
    let rows = okx.leaderboard(SortBy::Pnl, 40).await.unwrap();
    assert_eq!(rows.len(), 40);
    assert!(rows
        .iter()
        .all(|r| r.source == Source::Okx && r.copiers.is_some()));
    let code = &rows[0].id;
    assert!(okx.row(code).is_some());
    let detail = okx.detail(code, Period::Month).await.unwrap();
    assert!(detail
        .holdings
        .iter()
        .all(|h| h.size > 0.0 && h.entry > 0.0));
    assert!(detail.closed.iter().all(|t| t.size > 0.0 && t.time > 0));
    assert!(!detail.weekly_pnl.is_empty());
}
