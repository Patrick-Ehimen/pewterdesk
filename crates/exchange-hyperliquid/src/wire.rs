//! Hyperliquid's own response shapes, and their mapping into the domain types.
//! Nothing outside this crate sees these.
//!
//! Numbers arrive as JSON strings ("84083.2"), so they parse straight into
//! `Decimal` without passing through a float.

use pewterdesk_core::{
    AccountSnapshot, BookLevel, Decimal, Market, MarketStats, Order, OrderBook, OrderStatus,
    OrderType, Position, PositionSide, Side, Trade, VenueError, VenueId,
};
use rust_decimal::Decimal as RawDecimal;
use serde::Deserialize;

/// Hyperliquid perps allow at most this many decimals in a price, minus the
/// asset's `szDecimals`.
const MAX_PERP_PRICE_DECIMALS: u32 = 6;

/// Hyperliquid settles every perp in USDC.
const QUOTE: &str = "USDC";

#[derive(Clone, Debug, Deserialize)]
pub struct Meta {
    pub universe: Vec<AssetMeta>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AssetMeta {
    pub name: String,
    pub sz_decimals: u32,
    pub max_leverage: u32,
    #[serde(default)]
    pub is_delisted: bool,
}

#[derive(Clone, Debug, Deserialize)]
pub struct L2Book {
    pub coin: String,
    pub time: u64,
    /// `[bids, asks]`, each best first.
    pub levels: [Vec<L2Level>; 2],
}

#[derive(Clone, Debug, Deserialize)]
pub struct L2Level {
    pub px: Decimal,
    pub sz: Decimal,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClearinghouseState {
    pub margin_summary: MarginSummary,
    pub withdrawable: Decimal,
    pub asset_positions: Vec<AssetPosition>,
    pub time: u64,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MarginSummary {
    pub account_value: Decimal,
}

#[derive(Clone, Debug, Deserialize)]
pub struct AssetPosition {
    pub position: PerpPosition,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PerpPosition {
    pub coin: String,
    /// Signed size: negative is short.
    pub szi: Decimal,
    pub entry_px: Decimal,
    pub position_value: Decimal,
    pub unrealized_pnl: Decimal,
    pub liquidation_px: Option<Decimal>,
    pub margin_used: Decimal,
}

/// The `frontendOpenOrders` shape, which the `openOrders` WS channel also uses.
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenOrder {
    pub coin: String,
    /// "B" (bid) or "A" (ask).
    pub side: String,
    pub limit_px: Decimal,
    /// Remaining size.
    pub sz: Decimal,
    pub orig_sz: Decimal,
    pub oid: u64,
    pub timestamp: u64,
    pub is_trigger: bool,
    pub trigger_px: Decimal,
    pub reduce_only: bool,
    /// "Limit", "Stop Market", "Take Profit Limit", ...
    pub order_type: String,
    pub cloid: Option<String>,
}

/// A WS push: `{"channel": "...", "data": ...}`.
#[derive(Clone, Debug, Deserialize)]
pub struct WsMessage {
    pub channel: String,
    #[serde(default)]
    pub data: serde_json::Value,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WsClearinghouseState {
    pub clearinghouse_state: ClearinghouseState,
}

#[derive(Clone, Debug, Deserialize)]
pub struct WsOpenOrders {
    pub orders: Vec<OpenOrder>,
}

/// A perp's live context: the `activeAssetCtx` push is `{coin, ctx}`, and the
/// same shape is the second half of a `metaAndAssetCtxs` response.
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PerpAssetCtx {
    pub funding: Decimal,
    pub open_interest: Decimal,
    pub prev_day_px: Decimal,
    pub day_ntl_vlm: Decimal,
    pub oracle_px: Decimal,
    pub mark_px: Decimal,
    pub mid_px: Option<Decimal>,
}

#[derive(Clone, Debug, Deserialize)]
pub struct WsActiveAssetCtx {
    pub coin: String,
    pub ctx: PerpAssetCtx,
}

/// A price candle, from `candleSnapshot` and the `candle` channel.
#[derive(Clone, Debug, Deserialize)]
pub struct Candle {
    /// Open time, milliseconds since the Unix epoch.
    pub t: u64,
    pub h: Decimal,
    pub l: Decimal,
}

/// One entry of a `trades` push; the channel's data is an array of these.
#[derive(Clone, Debug, Deserialize)]
pub struct WsTrade {
    pub coin: String,
    /// The aggressor's side: "B" (bought) or "A" (sold).
    pub side: String,
    pub px: Decimal,
    pub sz: Decimal,
    pub time: u64,
    pub tid: u64,
}

fn step(decimals: u32) -> Decimal {
    Decimal(RawDecimal::new(1, decimals))
}

/// Hyperliquid has no fixed tick size: a price may have at most five
/// significant figures and at most `6 - szDecimals` decimals. `tick_size` is
/// the finer of the two bounds — the adapter validates the significant-figure
/// rule itself when it places orders.
pub fn market(asset: &AssetMeta) -> Market {
    Market {
        venue: VenueId::Hyperliquid,
        id: asset.name.clone(),
        symbol: format!("{}-USD", asset.name),
        base: asset.name.clone(),
        quote: QUOTE.into(),
        tick_size: step(MAX_PERP_PRICE_DECIMALS.saturating_sub(asset.sz_decimals)),
        size_step: step(asset.sz_decimals),
        // The venue's minimum is a $10 notional, not a size; the smallest
        // representable size is the tightest bound that doesn't move with price.
        min_size: step(asset.sz_decimals),
        max_leverage: asset.max_leverage,
    }
}

pub fn markets(meta: Meta) -> Vec<Market> {
    meta.universe
        .iter()
        .filter(|asset| !asset.is_delisted)
        .map(market)
        .collect()
}

fn levels(levels: Vec<L2Level>) -> Vec<BookLevel> {
    levels
        .into_iter()
        .map(|l| BookLevel {
            price: l.px,
            size: l.sz,
        })
        .collect()
}

pub fn order_book(book: L2Book) -> OrderBook {
    let [bids, asks] = book.levels;
    OrderBook {
        market: book.coin,
        bids: levels(bids),
        asks: levels(asks),
        time: book.time,
    }
}

fn position(p: PerpPosition) -> Option<Position> {
    let size = p.szi.0.abs();
    if size.is_zero() {
        return None;
    }
    Some(Position {
        venue: VenueId::Hyperliquid,
        market: p.coin,
        side: if p.szi.0.is_sign_negative() {
            PositionSide::Short
        } else {
            PositionSide::Long
        },
        size: Decimal(size),
        entry_price: p.entry_px,
        // The state carries no mark price; the position value is marked.
        mark_price: Decimal(p.position_value.0 / size),
        liquidation_price: p.liquidation_px,
        unrealized_pnl: p.unrealized_pnl,
        margin: p.margin_used,
    })
}

/// Hyperliquid marks sides "B" (bid) and "A" (ask).
fn side(side: &str) -> Result<Side, VenueError> {
    match side {
        "B" => Ok(Side::Buy),
        "A" => Ok(Side::Sell),
        other => Err(VenueError::Network(format!("unexpected side {other:?}"))),
    }
}

/// Stats from the live context plus what's derived locally (the day's range
/// and the funding clock).
pub fn market_stats(
    coin: String,
    ctx: &PerpAssetCtx,
    day_range: Option<(Decimal, Decimal)>,
    now_ms: u64,
) -> MarketStats {
    MarketStats {
        market: coin,
        mark_price: ctx.mark_px,
        mid_price: ctx.mid_px,
        index_price: Some(ctx.oracle_px),
        prev_day_price: ctx.prev_day_px,
        day_high: day_range.map(|(high, _)| high),
        day_low: day_range.map(|(_, low)| low),
        day_volume: ctx.day_ntl_vlm,
        open_interest: ctx.open_interest,
        funding_rate: ctx.funding,
        funding_interval_secs: crate::stats::FUNDING_INTERVAL_SECS,
        next_funding_time: crate::stats::next_funding_time(now_ms),
        time: now_ms,
    }
}

pub fn trade(t: WsTrade) -> Result<Trade, VenueError> {
    Ok(Trade {
        side: side(&t.side)?,
        market: t.coin,
        id: t.tid.to_string(),
        price: t.px,
        size: t.sz,
        time: t.time,
    })
}

pub fn order(o: OpenOrder) -> Result<Order, VenueError> {
    let side = side(&o.side)?;
    // A trigger order's limit price only applies once it fires, and a
    // market trigger has none.
    let (order_type, price, trigger_price) = if o.is_trigger {
        let limit = o.order_type.ends_with("Limit").then_some(o.limit_px);
        (OrderType::Trigger, limit, Some(o.trigger_px))
    } else {
        (OrderType::Limit, Some(o.limit_px), None)
    };
    Ok(Order {
        venue: VenueId::Hyperliquid,
        id: o.oid.to_string(),
        client_id: o.cloid,
        market: o.coin,
        side,
        order_type,
        size: o.orig_sz,
        filled_size: Decimal(o.orig_sz.0 - o.sz.0),
        price,
        trigger_price,
        reduce_only: o.reduce_only,
        status: OrderStatus::Open,
        created_at: o.timestamp,
    })
}

pub fn account(
    address: &str,
    state: ClearinghouseState,
    orders: Vec<OpenOrder>,
) -> Result<AccountSnapshot, VenueError> {
    Ok(AccountSnapshot {
        venue: VenueId::Hyperliquid,
        address: address.to_owned(),
        equity: state.margin_summary.account_value,
        available_margin: state.withdrawable,
        positions: state
            .asset_positions
            .into_iter()
            .filter_map(|ap| position(ap.position))
            .collect(),
        open_orders: orders.into_iter().map(order).collect::<Result<_, _>>()?,
        time: state.time,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn dec(s: &str) -> Decimal {
        Decimal(s.parse().unwrap())
    }

    #[test]
    fn maps_markets_and_drops_delisted() {
        let meta: Meta = serde_json::from_value(json!({
            "universe": [
                { "szDecimals": 5, "name": "BTC", "maxLeverage": 40, "marginTableId": 56 },
                { "szDecimals": 1, "name": "MATIC", "maxLeverage": 20, "isDelisted": true }
            ],
            "marginTables": [],
            "collateralToken": 0
        }))
        .unwrap();

        let markets = markets(meta);
        assert_eq!(markets.len(), 1);
        let btc = &markets[0];
        assert_eq!(btc.id, "BTC");
        assert_eq!(btc.symbol, "BTC-USD");
        assert_eq!(btc.quote, "USDC");
        assert_eq!(btc.tick_size, dec("0.1"));
        assert_eq!(btc.size_step, dec("0.00001"));
        assert_eq!(btc.max_leverage, 40);
    }

    #[test]
    fn maps_market_stats() {
        // Shapes as sampled from mainnet (fields we don't use included).
        let pushed: WsActiveAssetCtx = serde_json::from_value(json!({
            "coin": "HYPE",
            "ctx": {
                "funding": "0.0000125", "openInterest": "20578685.7", "prevDayPx": "90.821",
                "dayNtlVlm": "205852676.89", "premium": "-0.00016", "oraclePx": "92.5447",
                "markPx": "92.5217", "midPx": "92.5285", "impactPxs": ["92.5244", "92.529"],
                "dayBaseVlm": "2243176.8"
            }
        }))
        .unwrap();
        let stats = market_stats(
            pushed.coin,
            &pushed.ctx,
            Some((dec("92.8"), dec("90.67"))),
            1_790_440_000_000,
        );
        assert_eq!(stats.market, "HYPE");
        assert_eq!(stats.mark_price, dec("92.5217"));
        assert_eq!(stats.index_price, Some(dec("92.5447")));
        assert_eq!(stats.prev_day_price, dec("90.821"));
        assert_eq!(stats.day_high, Some(dec("92.8")));
        assert_eq!(stats.day_volume, dec("205852676.89"));
        assert_eq!(stats.funding_rate, dec("0.0000125"));
        assert_eq!(stats.funding_interval_secs, 3600);
        assert_eq!(stats.next_funding_time, 1_790_442_000_000);

        let candle: Candle = serde_json::from_value(json!({
            "t": 1790438400000u64, "T": 1790441999999u64, "s": "HYPE", "i": "1h",
            "o": "92.521", "c": "92.528", "h": "92.575", "l": "92.503", "v": "1699.7", "n": 198
        }))
        .unwrap();
        assert_eq!(
            (candle.t, candle.h, candle.l),
            (1790438400000, dec("92.575"), dec("92.503"))
        );
    }

    #[test]
    fn a_missing_mid_is_absent_not_an_error() {
        let ctx: PerpAssetCtx = serde_json::from_value(json!({
            "funding": "0", "openInterest": "0", "prevDayPx": "1", "dayNtlVlm": "0",
            "oraclePx": "1", "markPx": "1", "midPx": null
        }))
        .unwrap();
        assert_eq!(ctx.mid_px, None);
    }

    #[test]
    fn maps_trades() {
        let trades: Vec<WsTrade> = serde_json::from_value(json!([{
            "coin": "BTC",
            "side": "A",
            "px": "83915.0",
            "sz": "0.0123",
            "hash": "0xabc",
            "time": 1790362349195u64,
            "tid": 887766,
            "users": ["0x1", "0x2"]
        }]))
        .unwrap();

        let trade = trade(trades.into_iter().next().unwrap()).unwrap();
        assert_eq!(trade.market, "BTC");
        assert_eq!(trade.id, "887766");
        assert_eq!(trade.side, Side::Sell);
        assert_eq!(trade.price, dec("83915.0"));
        assert_eq!(trade.size, dec("0.0123"));
        assert_eq!(trade.time, 1790362349195);
    }

    #[test]
    fn rejects_an_unknown_trade_side() {
        let t: WsTrade = serde_json::from_value(json!({
            "coin": "BTC", "side": "X", "px": "1", "sz": "1", "time": 0, "tid": 1
        }))
        .unwrap();
        assert!(matches!(trade(t), Err(VenueError::Network(_))));
    }

    #[test]
    fn maps_order_book() {
        let book: L2Book = serde_json::from_value(json!({
            "coin": "BTC",
            "time": 1790362349195u64,
            "levels": [
                [{ "px": "83915.0", "sz": "10.38358", "n": 48 }],
                [{ "px": "83916.0", "sz": "2.16208", "n": 9 }]
            ]
        }))
        .unwrap();

        let book = order_book(book);
        assert_eq!(book.market, "BTC");
        assert_eq!(book.bids[0].price, dec("83915.0"));
        assert_eq!(book.asks[0].size, dec("2.16208"));
        assert_eq!(book.time, 1790362349195);
    }

    #[test]
    fn rejects_float_prices() {
        let level = serde_json::from_value::<L2Level>(json!({ "px": 1.5, "sz": "1" }));
        assert!(level.is_err());
    }

    fn state() -> ClearinghouseState {
        serde_json::from_value(json!({
            "marginSummary": {
                "accountValue": "3005101.56", "totalNtlPos": "0", "totalRawUsd": "0",
                "totalMarginUsed": "0"
            },
            "crossMarginSummary": {
                "accountValue": "3005101.56", "totalNtlPos": "0", "totalRawUsd": "0",
                "totalMarginUsed": "0"
            },
            "crossMaintenanceMarginUsed": "0",
            "withdrawable": "2568265.34",
            "assetPositions": [
                { "type": "oneWay", "position": {
                    "coin": "BTC", "szi": "-0.5", "leverage": { "type": "cross", "value": 20 },
                    "entryPx": "84103.9", "positionValue": "42000.0",
                    "unrealizedPnl": "51.95", "returnOnEquity": "0.04",
                    "liquidationPx": "5176251.65", "marginUsed": "2100.0", "maxLeverage": 50,
                    "cumFunding": { "allTime": "0", "sinceOpen": "0", "sinceChange": "0" }
                }},
                { "type": "oneWay", "position": {
                    "coin": "ATOM", "szi": "7346.39", "leverage": { "type": "cross", "value": 20 },
                    "entryPx": "1.7798", "positionValue": "12978.867213",
                    "unrealizedPnl": "-96.28", "returnOnEquity": "-0.14",
                    "liquidationPx": null, "marginUsed": "648.94", "maxLeverage": 50,
                    "cumFunding": { "allTime": "0", "sinceOpen": "0", "sinceChange": "0" }
                }}
            ],
            "time": 1790362403443u64
        }))
        .unwrap()
    }

    fn open_order(extra: serde_json::Value) -> OpenOrder {
        let mut o = json!({
            "coin": "SOL", "side": "A", "limitPx": "122.24", "sz": "3.18", "origSz": "5.18",
            "oid": 556722616478u64, "timestamp": 1790362540710u64,
            "triggerCondition": "N/A", "isTrigger": false, "triggerPx": "0.0",
            "children": [], "isPositionTpsl": false, "reduceOnly": false,
            "orderType": "Limit", "tif": "Alo", "cloid": null
        });
        o.as_object_mut()
            .unwrap()
            .extend(extra.as_object().unwrap().clone());
        serde_json::from_value(o).unwrap()
    }

    #[test]
    fn maps_account() {
        let snapshot = account("0xabc", state(), vec![open_order(json!({}))]).unwrap();

        assert_eq!(snapshot.equity, dec("3005101.56"));
        assert_eq!(snapshot.available_margin, dec("2568265.34"));
        assert_eq!(snapshot.time, 1790362403443);

        let btc = &snapshot.positions[0];
        assert_eq!(btc.side, PositionSide::Short);
        assert_eq!(btc.size, dec("0.5"));
        assert_eq!(btc.mark_price, dec("84000"));
        assert_eq!(btc.liquidation_price, Some(dec("5176251.65")));
        assert_eq!(snapshot.positions[1].side, PositionSide::Long);
        assert_eq!(snapshot.positions[1].liquidation_price, None);

        let order = &snapshot.open_orders[0];
        assert_eq!(order.id, "556722616478");
        assert_eq!(order.side, Side::Sell);
        assert_eq!(order.order_type, OrderType::Limit);
        assert_eq!(order.size, dec("5.18"));
        assert_eq!(order.filled_size, dec("2.00"));
        assert_eq!(order.price, Some(dec("122.24")));
        assert_eq!(order.trigger_price, None);
    }

    #[test]
    fn maps_trigger_orders() {
        let stop = order(open_order(json!({
            "isTrigger": true, "triggerPx": "110.0", "orderType": "Stop Market"
        })))
        .unwrap();
        assert_eq!(stop.order_type, OrderType::Trigger);
        assert_eq!(stop.trigger_price, Some(dec("110.0")));
        assert_eq!(stop.price, None);

        let tp = order(open_order(json!({
            "isTrigger": true, "triggerPx": "130.0", "orderType": "Take Profit Limit"
        })))
        .unwrap();
        assert_eq!(tp.price, Some(dec("122.24")));
    }

    #[test]
    fn drops_flat_positions() {
        let mut state = state();
        state.asset_positions[0].position.szi = dec("0");
        let snapshot = account("0xabc", state, vec![]).unwrap();
        assert_eq!(snapshot.positions.len(), 1);
    }

    #[test]
    fn rejects_unknown_order_side() {
        assert!(order(open_order(json!({ "side": "X" }))).is_err());
    }
}
