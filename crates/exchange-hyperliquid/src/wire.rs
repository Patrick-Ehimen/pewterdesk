//! Hyperliquid's own response shapes, and their mapping into the domain types.
//! Nothing outside this crate sees these.
//!
//! Numbers arrive as JSON strings ("84083.2"), so they parse straight into
//! `Decimal` without passing through a float.

use pewterdesk_core::{
    AccountSnapshot, BookLevel, Candle as DomainCandle, CandleInterval, Decimal, Fill, FillEffect,
    FundingPayment, FundingRate, Market, MarketStats, MarketSummary, Order, OrderBook, OrderStatus,
    OrderType, Position, PositionSide, Side, Trade, VenueError, VenueId,
};
use rust_decimal::Decimal as RawDecimal;
use serde::Deserialize;

/// Hyperliquid perps allow at most this many decimals in a price, minus the
/// asset's `szDecimals`.
const MAX_PERP_PRICE_DECIMALS: u32 = 6;

/// The main perp exchange settles in USDC (spot token 0). Builder-deployed
/// exchanges (HIP-3) each choose their own collateral token.
pub const USDC_TOKEN: u32 = 0;
const USDC: &str = "USDC";

/// One perp exchange's markets: `meta`, or one entry of `allPerpMetas`.
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Meta {
    pub universe: Vec<AssetMeta>,
    /// The spot token positions settle in.
    #[serde(default)]
    pub collateral_token: u32,
}

impl Meta {
    /// The builder-deployed exchange this is, or `None` for the main one.
    /// Builder markets are named "<dex>:<coin>", so the first one says.
    pub fn dex(&self) -> Option<&str> {
        self.universe
            .first()
            .and_then(|a| a.name.split_once(':'))
            .map(|(dex, _)| dex)
    }

    pub fn has_live_markets(&self) -> bool {
        self.universe.iter().any(|a| !a.is_delisted)
    }
}

/// `spotMeta`, for naming a builder exchange's collateral token.
#[derive(Clone, Debug, Deserialize)]
pub struct SpotMeta {
    pub tokens: Vec<SpotToken>,
}

#[derive(Clone, Debug, Deserialize)]
pub struct SpotToken {
    pub name: String,
    pub index: u32,
}

/// The collateral token's name, e.g. "USDC".
pub fn quote_name(token: u32, spot: Option<&SpotMeta>) -> String {
    if token == USDC_TOKEN {
        return USDC.into();
    }
    spot.and_then(|s| s.tokens.iter().find(|t| t.index == token))
        .map_or_else(|| USDC.into(), |t| t.name.clone())
}

/// An `allDexsAssetCtxs` push: every perp exchange's contexts, each in its
/// `Meta::universe` order. The main exchange is named "". Contexts stay raw
/// so one exchange with an odd entry can't spoil the rest.
#[derive(Clone, Debug, Deserialize)]
pub struct WsAllDexsAssetCtxs {
    pub ctxs: Vec<(String, Vec<serde_json::Value>)>,
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

/// One entry of a `historicalOrders` response.
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoricalOrder {
    pub order: OpenOrder,
    /// "open", "filled", "canceled", "triggered", or one of the venue's many
    /// specific "...Canceled" / "...Rejected" reasons.
    pub status: String,
}

/// One entry of a `userFills` response.
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UserFill {
    pub coin: String,
    pub px: Decimal,
    pub sz: Decimal,
    /// "B" (bought) or "A" (sold).
    pub side: String,
    pub time: u64,
    /// "Open Long", "Close Short", "Long > Short", ...
    pub dir: String,
    pub closed_pnl: Decimal,
    pub oid: u64,
    /// Took liquidity.
    pub crossed: bool,
    pub fee: Decimal,
    pub tid: u64,
    pub fee_token: String,
}

/// One entry of a `userFunding` response.
#[derive(Clone, Debug, Deserialize)]
pub struct UserFunding {
    pub time: u64,
    pub delta: FundingDelta,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FundingDelta {
    pub coin: String,
    /// Positive when the account received it.
    pub usdc: Decimal,
    /// Signed position size: negative for a short.
    pub szi: Decimal,
    pub funding_rate: Decimal,
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
    /// The coin and interval, so a push can be matched to its subscription.
    #[serde(default)]
    pub s: String,
    #[serde(default)]
    pub i: String,
    pub o: Decimal,
    pub h: Decimal,
    pub l: Decimal,
    pub c: Decimal,
    /// Volume in base units.
    pub v: Decimal,
}

/// Hyperliquid's name for a candle interval.
pub fn interval_code(interval: CandleInterval) -> &'static str {
    match interval {
        CandleInterval::OneMinute => "1m",
        CandleInterval::FiveMinutes => "5m",
        CandleInterval::FifteenMinutes => "15m",
        CandleInterval::OneHour => "1h",
        CandleInterval::FourHours => "4h",
        CandleInterval::OneDay => "1d",
        CandleInterval::OneWeek => "1w",
    }
}

pub fn candle(c: Candle) -> DomainCandle {
    DomainCandle {
        open_time: c.t,
        open: c.o,
        high: c.h,
        low: c.l,
        close: c.c,
        volume: c.v,
    }
}

/// A `metaAndAssetCtxs` response pairs the universe with one context per
/// asset, in the same order. Delisted markets are dropped, as in `markets`.
pub fn market_summaries(meta: Meta, ctxs: Vec<PerpAssetCtx>) -> Vec<MarketSummary> {
    meta.universe
        .into_iter()
        .zip(ctxs)
        .filter(|(asset, _)| !asset.is_delisted)
        .map(|(asset, ctx)| MarketSummary {
            market: asset.name,
            mark_price: ctx.mark_px,
            prev_day_price: ctx.prev_day_px,
            day_volume: ctx.day_ntl_vlm,
            open_interest: ctx.open_interest,
            funding_rate: ctx.funding,
            funding_interval_secs: crate::stats::FUNDING_INTERVAL_SECS,
        })
        .collect()
}

/// One entry of a `fundingHistory` response.
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FundingEntry {
    pub coin: String,
    pub funding_rate: Decimal,
    pub time: u64,
}

pub fn funding_rate(f: FundingEntry) -> FundingRate {
    FundingRate {
        market: f.coin,
        rate: f.funding_rate,
        time: f.time,
    }
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
pub fn market(asset: &AssetMeta, quote: &str) -> Market {
    // Builder-deployed markets are "<dex>:<coin>"; the id keeps the prefix.
    let (listed_by, base) = match asset.name.split_once(':') {
        Some((dex, coin)) => (Some(dex.to_owned()), coin),
        None => (None, asset.name.as_str()),
    };
    Market {
        venue: VenueId::Hyperliquid,
        id: asset.name.clone(),
        symbol: format!("{base}-{quote}"),
        base: base.to_owned(),
        quote: quote.to_owned(),
        tick_size: step(MAX_PERP_PRICE_DECIMALS.saturating_sub(asset.sz_decimals)),
        size_step: step(asset.sz_decimals),
        // The venue's minimum is a $10 notional, not a size; the smallest
        // representable size is the tightest bound that doesn't move with price.
        min_size: step(asset.sz_decimals),
        max_leverage: asset.max_leverage,
        listed_by,
    }
}

/// Every exchange's live markets, the main exchange's first.
pub fn markets(metas: Vec<Meta>, spot: Option<&SpotMeta>) -> Vec<Market> {
    metas
        .iter()
        .flat_map(|meta| {
            let quote = quote_name(meta.collateral_token, spot);
            meta.universe
                .iter()
                .filter(|asset| !asset.is_delisted)
                .map(move |asset| market(asset, &quote))
                .collect::<Vec<_>>()
        })
        .collect()
}

/// Summaries for the builder-deployed exchanges in an `allDexsAssetCtxs`
/// push, matched to `metas` by exchange name. The main exchange ("") is
/// skipped: it's polled separately, more often than this feed pushes.
///
/// Also returns whether `metas` looks out of date: an exchange it doesn't
/// know, or a context count that doesn't match its universe (a new listing),
/// in which case that exchange is left out rather than mismatched.
pub fn builder_summaries(metas: &[Meta], pushed: WsAllDexsAssetCtxs) -> (Vec<MarketSummary>, bool) {
    let mut stale = false;
    let mut summaries = Vec::new();
    for (dex, ctxs) in pushed.ctxs {
        if dex.is_empty() {
            continue;
        }
        let Some(meta) = metas.iter().find(|m| m.dex() == Some(dex.as_str())) else {
            // An exchange with no markets yet has no name to match on.
            stale |= !ctxs.is_empty();
            continue;
        };
        if !meta.has_live_markets() {
            continue;
        }
        if ctxs.len() != meta.universe.len() {
            stale = true;
            continue;
        }
        let Ok(ctxs) = serde_json::from_value::<Vec<PerpAssetCtx>>(ctxs.into()) else {
            continue;
        };
        summaries.extend(market_summaries(meta.clone(), ctxs));
    }
    (summaries, stale)
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

/// The venue's order state, folded into ours. Anything ending an order
/// without a fill that isn't a rejection counts as cancelled.
fn history_status(status: &str) -> OrderStatus {
    match status {
        "open" | "triggered" => OrderStatus::Open,
        "filled" => OrderStatus::Filled,
        s if s.to_ascii_lowercase().contains("rejected") => OrderStatus::Rejected,
        _ => OrderStatus::Cancelled,
    }
}

pub fn historical_order(h: HistoricalOrder) -> Result<Order, VenueError> {
    let status = history_status(&h.status);
    Ok(Order {
        status,
        ..order(h.order)?
    })
}

fn fill_effect(dir: &str) -> FillEffect {
    match dir {
        "Open Long" => FillEffect::OpenLong,
        "Close Long" => FillEffect::CloseLong,
        "Open Short" => FillEffect::OpenShort,
        "Close Short" => FillEffect::CloseShort,
        "Long > Short" => FillEffect::LongToShort,
        "Short > Long" => FillEffect::ShortToLong,
        _ => FillEffect::Other,
    }
}

pub fn fill(f: UserFill) -> Result<Fill, VenueError> {
    Ok(Fill {
        venue: VenueId::Hyperliquid,
        id: f.tid.to_string(),
        order_id: f.oid.to_string(),
        side: side(&f.side)?,
        effect: fill_effect(&f.dir),
        market: f.coin,
        price: f.px,
        size: f.sz,
        closed_pnl: f.closed_pnl,
        fee: f.fee,
        fee_asset: f.fee_token,
        taker: f.crossed,
        time: f.time,
    })
}

pub fn funding_payment(f: UserFunding) -> FundingPayment {
    FundingPayment {
        venue: VenueId::Hyperliquid,
        market: f.delta.coin,
        amount: f.delta.usdc,
        position_size: f.delta.szi,
        rate: f.delta.funding_rate,
        time: f.time,
    }
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

        let markets = markets(vec![meta], None);
        assert_eq!(markets.len(), 1);
        let btc = &markets[0];
        assert_eq!(btc.id, "BTC");
        assert_eq!(btc.symbol, "BTC-USDC");
        assert_eq!(btc.quote, "USDC");
        assert_eq!(btc.tick_size, dec("0.1"));
        assert_eq!(btc.size_step, dec("0.00001"));
        assert_eq!(btc.max_leverage, 40);
        assert_eq!(btc.listed_by, None);
    }

    fn builder_meta() -> Meta {
        serde_json::from_value(json!({
            "universe": [
                { "szDecimals": 3, "name": "xyz:TSLA", "maxLeverage": 20, "marginTableId": 20 },
                { "szDecimals": 4, "name": "xyz:GOLD", "maxLeverage": 20, "isDelisted": true }
            ],
            "collateralToken": 360
        }))
        .unwrap()
    }

    #[test]
    fn maps_builder_markets() {
        let spot: SpotMeta = serde_json::from_value(json!({
            "tokens": [{ "name": "USDC", "index": 0 }, { "name": "USDH", "index": 360 }]
        }))
        .unwrap();
        let markets = markets(vec![builder_meta()], Some(&spot));
        assert_eq!(markets.len(), 1);
        let tsla = &markets[0];
        // The id keeps the prefix: it's what every other request takes.
        assert_eq!(tsla.id, "xyz:TSLA");
        assert_eq!(tsla.base, "TSLA");
        assert_eq!(tsla.symbol, "TSLA-USDH");
        assert_eq!(tsla.listed_by.as_deref(), Some("xyz"));
        assert_eq!(tsla.quote, "USDH");
        assert_eq!(builder_meta().dex(), Some("xyz"));
    }

    fn ctx(mark: &str) -> serde_json::Value {
        json!({
            "funding": "0.00000625", "openInterest": "10", "prevDayPx": "370",
            "dayNtlVlm": "1000", "oraclePx": mark, "markPx": mark, "midPx": mark
        })
    }

    #[test]
    fn builder_summaries_skip_main_and_catch_new_listings() {
        let metas = vec![builder_meta()];
        let pushed: WsAllDexsAssetCtxs = serde_json::from_value(json!({
            "ctxs": [
                ["", [ctx("84000")]],
                ["xyz", [ctx("371.5"), ctx("2400")]]
            ]
        }))
        .unwrap();
        let (summaries, stale) = builder_summaries(&metas, pushed);
        assert!(!stale);
        // The main exchange is skipped; the delisted GOLD is dropped.
        assert_eq!(summaries.len(), 1);
        assert_eq!(summaries[0].market, "xyz:TSLA");
        assert_eq!(summaries[0].mark_price, dec("371.5"));

        // A third context: xyz listed something the metas don't have yet.
        let pushed: WsAllDexsAssetCtxs = serde_json::from_value(json!({
            "ctxs": [["xyz", [ctx("371.5"), ctx("2400"), ctx("1")]], ["new", [ctx("1")]]]
        }))
        .unwrap();
        let (summaries, stale) = builder_summaries(&metas, pushed);
        assert!(stale);
        assert!(summaries.is_empty());
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
    fn maps_candles_and_intervals() {
        let c: Candle = serde_json::from_value(json!({
            "t": 1790438400000u64, "T": 1790441999999u64, "s": "HYPE", "i": "1h",
            "o": "92.521", "c": "92.528", "h": "92.575", "l": "92.503", "v": "1699.7", "n": 198
        }))
        .unwrap();
        assert_eq!((c.s.as_str(), c.i.as_str()), ("HYPE", "1h"));
        let c = candle(c);
        assert_eq!(c.open_time, 1790438400000);
        assert_eq!((c.open, c.close), (dec("92.521"), dec("92.528")));
        assert_eq!(
            (c.high, c.low, c.volume),
            (dec("92.575"), dec("92.503"), dec("1699.7"))
        );
        assert_eq!(interval_code(CandleInterval::FourHours), "4h");
        assert_eq!(interval_code(CandleInterval::OneWeek), "1w");
    }

    #[test]
    fn maps_market_summaries_in_universe_order_without_delisted() {
        let meta: Meta = serde_json::from_value(json!({ "universe": [
            { "szDecimals": 5, "name": "BTC", "maxLeverage": 40 },
            { "szDecimals": 1, "name": "OLD", "maxLeverage": 3, "isDelisted": true },
            { "szDecimals": 2, "name": "HYPE", "maxLeverage": 10 }
        ]}))
        .unwrap();
        let ctx = |mark: &str| -> PerpAssetCtx {
            serde_json::from_value(json!({
                "funding": "0.0000125", "openInterest": "10", "prevDayPx": "1",
                "dayNtlVlm": "100", "oraclePx": mark, "markPx": mark, "midPx": null
            }))
            .unwrap()
        };
        let summaries = market_summaries(meta, vec![ctx("84000"), ctx("0.1"), ctx("92.5")]);
        let ids: Vec<_> = summaries.iter().map(|s| s.market.as_str()).collect();
        assert_eq!(ids, ["BTC", "HYPE"]);
        assert_eq!(summaries[1].mark_price, dec("92.5"));
        assert_eq!(summaries[0].funding_rate, dec("0.0000125"));
        assert_eq!(summaries[0].funding_interval_secs, 3600);
    }

    #[test]
    fn maps_funding_history() {
        let entries: Vec<FundingEntry> = serde_json::from_value(json!([{
            "coin": "HYPE", "fundingRate": "0.0000125", "premium": "-0.00018", "time": 1790442000074u64
        }]))
        .unwrap();
        let f = funding_rate(entries.into_iter().next().unwrap());
        assert_eq!(f.market, "HYPE");
        assert_eq!(f.rate, dec("0.0000125"));
        assert_eq!(f.time, 1790442000074);
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

    // Shapes as sampled from mainnet.
    #[test]
    fn maps_fills() {
        let f: UserFill = serde_json::from_value(json!({
            "coin": "AZTEC", "px": "0.017024", "sz": "685.0", "side": "A",
            "time": 1790508444030u64, "startPosition": "912224.0", "dir": "Close Long",
            "closedPnl": "-0.044525", "hash": "0x00", "oid": 557900683331u64,
            "crossed": false, "fee": "0.0", "tid": 727578724900554u64,
            "feeToken": "USDC", "twapId": null
        }))
        .unwrap();
        let fill = fill(f).unwrap();
        assert_eq!(fill.side, Side::Sell);
        assert_eq!(fill.effect, FillEffect::CloseLong);
        assert_eq!(fill.closed_pnl, dec("-0.044525"));
        assert_eq!(fill.order_id, "557900683331");
        assert!(!fill.taker);
        assert_eq!(fill_effect("Liquidated Cross Long"), FillEffect::Other);
    }

    #[test]
    fn maps_funding_payments() {
        let f: UserFunding = serde_json::from_value(json!({
            "time": 1789905600043u64, "hash": "0x00",
            "delta": { "type": "funding", "coin": "BTC", "usdc": "0.541099",
                       "szi": "-0.53783", "fundingRate": "0.0000125", "nSamples": null }
        }))
        .unwrap();
        let p = funding_payment(f);
        // A short received funding while the rate was positive.
        assert_eq!(p.amount, dec("0.541099"));
        assert_eq!(p.position_size, dec("-0.53783"));
        assert_eq!(p.market, "BTC");
    }

    #[test]
    fn maps_order_history_statuses() {
        let h = |status: &str| -> HistoricalOrder {
            serde_json::from_value(json!({
                "order": { "coin": "NIL", "side": "A", "limitPx": "0.10784", "sz": "0.0",
                           "oid": 557900731425u64, "timestamp": 1790508447133u64,
                           "triggerCondition": "N/A", "isTrigger": false, "triggerPx": "0.0",
                           "children": [], "isPositionTpsl": false, "reduceOnly": false,
                           "orderType": "Limit", "origSz": "1667.0", "tif": "Alo", "cloid": null },
                "status": status, "statusTimestamp": 1790508448212u64
            }))
            .unwrap()
        };
        let filled = historical_order(h("filled")).unwrap();
        assert_eq!(filled.status, OrderStatus::Filled);
        assert_eq!(filled.filled_size, dec("1667.0"));
        for (raw, want) in [
            ("open", OrderStatus::Open),
            ("canceled", OrderStatus::Cancelled),
            ("reduceOnlyCanceled", OrderStatus::Cancelled),
            ("iocCancelRejected", OrderStatus::Rejected),
            ("tickRejected", OrderStatus::Rejected),
        ] {
            assert_eq!(historical_order(h(raw)).unwrap().status, want, "{raw}");
        }
    }
}
