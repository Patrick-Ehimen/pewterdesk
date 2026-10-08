//! Aster's wire format (Binance-style REST and streams) and its mapping to the
//! domain types. Prices and sizes arrive as strings and go straight into
//! `Decimal` without passing through a float.

use std::collections::HashMap;
use std::fmt;

use pewterdesk_core::{
    BookLevel, Candle as DomainCandle, CandleInterval, Decimal, FundingRate, Market, MarketStats,
    MarketSummary, OrderBook, Side, Trade, VenueError, VenueId,
};
use rust_decimal::prelude::ToPrimitive;
use rust_decimal::Decimal as RawDecimal;
use serde::de::{self, IgnoredAny, SeqAccess, Visitor};
use serde::{Deserialize, Deserializer};

/// Funding interval for a market `fundingInfo` doesn't list: Aster's default.
pub const DEFAULT_FUNDING_HOURS: u32 = 8;

/// The error body Aster returns with a 4xx.
#[derive(Deserialize)]
pub struct ApiError {
    #[serde(default)]
    pub code: i64,
    pub msg: String,
}

#[derive(Deserialize)]
pub struct ExchangeInfo {
    pub symbols: Vec<SymbolInfo>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SymbolInfo {
    pub symbol: String,
    pub status: String,
    pub contract_type: String,
    pub base_asset: String,
    pub quote_asset: String,
    /// Initial margin at the lowest leverage bracket, in percent.
    pub required_margin_percent: Decimal,
    pub filters: Vec<Filter>,
}

impl SymbolInfo {
    /// Listed and trading: settling, delisted and upcoming markets are left out.
    pub fn is_live(&self) -> bool {
        self.status == "TRADING" && self.contract_type == "PERPETUAL"
    }
}

#[derive(Deserialize)]
#[serde(tag = "filterType", rename_all_fields = "camelCase")]
pub enum Filter {
    #[serde(rename = "PRICE_FILTER")]
    Price { tick_size: Decimal },
    #[serde(rename = "LOT_SIZE")]
    Lot {
        step_size: Decimal,
        min_qty: Decimal,
    },
    #[serde(other)]
    Other,
}

/// What the adapter keeps from `exchangeInfo` between calls: each market's
/// base asset (its logo is the asset's) and price decimals.
#[derive(Default)]
pub struct Meta {
    pub bases: HashMap<String, String>,
    /// Decimal places of the market's tick size, e.g. 1 for BTCUSDT's 0.1.
    pub scales: HashMap<String, u32>,
}

pub fn meta(info: &ExchangeInfo) -> Meta {
    let mut meta = Meta::default();
    for s in &info.symbols {
        meta.bases.insert(s.symbol.clone(), s.base_asset.clone());
        let tick = s.filters.iter().find_map(|f| match f {
            Filter::Price { tick_size } => Some(*tick_size),
            _ => None,
        });
        if let Some(tick) = tick {
            meta.scales.insert(s.symbol.clone(), price_scale(tick));
        }
    }
    meta
}

/// A tick size's decimal places ("0.00010" → 4).
pub fn price_scale(tick: Decimal) -> u32 {
    tick.0.normalize().scale()
}

/// `d` rounded to exactly `scale` places ("83252.10000000" at 1 → "83252.1",
/// "83252" at 1 → "83252.0"), so a venue value reads like the others.
pub fn at_scale(d: Decimal, scale: u32) -> Decimal {
    let mut v = d.0.round_dp(scale);
    v.rescale(scale);
    Decimal(v)
}

/// Traded value, in the quote asset, always to the cent: Aster sends
/// anywhere from 2 to 6 places.
const VOLUME_SCALE: u32 = 2;

/// The live perpetuals, in the venue's order.
pub fn markets(info: ExchangeInfo) -> Vec<Market> {
    info.symbols
        .into_iter()
        .filter(SymbolInfo::is_live)
        .map(market)
        .collect()
}

fn market(s: SymbolInfo) -> Market {
    let mut tick_size = Decimal::default();
    let mut size_step = Decimal::default();
    let mut min_size = Decimal::default();
    for filter in &s.filters {
        match filter {
            Filter::Price { tick_size: t } => tick_size = *t,
            Filter::Lot { step_size, min_qty } => {
                size_step = *step_size;
                min_size = *min_qty;
            }
            Filter::Other => {}
        }
    }
    Market {
        venue: VenueId::Aster,
        symbol: format!("{}-{}", s.base_asset, s.quote_asset),
        max_leverage: max_leverage(s.required_margin_percent),
        id: s.symbol,
        base: s.base_asset,
        quote: s.quote_asset,
        tick_size,
        size_step,
        min_size,
        listed_by: None,
        category: None,
        listed_at: None,
    }
}

/// The leverage the lowest bracket's initial margin allows (5% → 20x). The
/// full bracket table needs a signed request, so this is the public figure;
/// an account's own limit can differ.
pub fn max_leverage(required_margin_percent: Decimal) -> u32 {
    let percent = required_margin_percent.0;
    if percent <= RawDecimal::ZERO {
        return 1;
    }
    (RawDecimal::ONE_HUNDRED / percent)
        .floor()
        .to_u32()
        .unwrap_or(1)
        .max(1)
}

/// `depth` over REST and the partial-book stream share this shape, with
/// different field names.
#[derive(Deserialize)]
pub struct Depth {
    #[serde(rename = "T")]
    pub time: u64,
    #[serde(alias = "b")]
    pub bids: Vec<(Decimal, Decimal)>,
    #[serde(alias = "a")]
    pub asks: Vec<(Decimal, Decimal)>,
}

pub fn order_book(market: &str, depth: Depth) -> OrderBook {
    let levels = |side: Vec<(Decimal, Decimal)>| {
        side.into_iter()
            .map(|(price, size)| BookLevel { price, size })
            .collect()
    };
    OrderBook {
        market: market.to_owned(),
        bids: levels(depth.bids),
        asks: levels(depth.asks),
        time: depth.time,
    }
}

/// One print from REST `trades`.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RestTrade {
    pub id: u64,
    pub price: Decimal,
    pub qty: Decimal,
    pub time: u64,
    pub is_buyer_maker: bool,
}

/// One print from the `<symbol>@trade` stream.
#[derive(Deserialize)]
pub struct WsTrade {
    #[serde(rename = "t")]
    pub id: u64,
    #[serde(rename = "p")]
    pub price: Decimal,
    #[serde(rename = "q")]
    pub qty: Decimal,
    #[serde(rename = "T")]
    pub time: u64,
    #[serde(rename = "m")]
    pub is_buyer_maker: bool,
    /// "MARKET" for a trade on the book; liquidations and ADL are other kinds.
    #[serde(rename = "X", default)]
    pub kind: Option<String>,
}

impl WsTrade {
    pub fn on_book(&self) -> bool {
        self.kind.as_deref().is_none_or(|k| k == "MARKET")
    }
}

/// The maker was the buyer, so the aggressor sold.
fn aggressor(is_buyer_maker: bool) -> Side {
    if is_buyer_maker {
        Side::Sell
    } else {
        Side::Buy
    }
}

pub fn trade(
    market: &str,
    id: u64,
    price: Decimal,
    size: Decimal,
    time: u64,
    is_buyer_maker: bool,
) -> Trade {
    Trade {
        market: market.to_owned(),
        id: id.to_string(),
        side: aggressor(is_buyer_maker),
        price,
        size,
        time,
    }
}

pub fn interval_code(interval: CandleInterval) -> &'static str {
    match interval {
        CandleInterval::OneMinute => "1m",
        CandleInterval::ThreeMinutes => "3m",
        CandleInterval::FiveMinutes => "5m",
        CandleInterval::FifteenMinutes => "15m",
        CandleInterval::ThirtyMinutes => "30m",
        CandleInterval::OneHour => "1h",
        CandleInterval::TwoHours => "2h",
        CandleInterval::FourHours => "4h",
        CandleInterval::EightHours => "8h",
        CandleInterval::TwelveHours => "12h",
        CandleInterval::OneDay => "1d",
        CandleInterval::ThreeDays => "3d",
        CandleInterval::OneWeek => "1w",
    }
}

/// A REST kline: an array whose first six entries are the open time, OHLC
/// and base volume. The rest (close time, quote volume, counts) is skipped.
pub struct Kline(pub DomainCandle);

impl<'de> Deserialize<'de> for Kline {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        struct KlineVisitor;

        impl<'de> Visitor<'de> for KlineVisitor {
            type Value = Kline;

            fn expecting(&self, f: &mut fmt::Formatter) -> fmt::Result {
                f.write_str("a kline array")
            }

            fn visit_seq<A: SeqAccess<'de>>(self, mut seq: A) -> Result<Kline, A::Error> {
                let missing = |i| de::Error::invalid_length(i, &"at least 6 entries");
                let open_time = seq.next_element()?.ok_or_else(|| missing(0))?;
                let open = seq.next_element()?.ok_or_else(|| missing(1))?;
                let high = seq.next_element()?.ok_or_else(|| missing(2))?;
                let low = seq.next_element()?.ok_or_else(|| missing(3))?;
                let close = seq.next_element()?.ok_or_else(|| missing(4))?;
                let volume = seq.next_element()?.ok_or_else(|| missing(5))?;
                while seq.next_element::<IgnoredAny>()?.is_some() {}
                Ok(Kline(DomainCandle {
                    open_time,
                    open,
                    high,
                    low,
                    close,
                    volume,
                }))
            }
        }

        deserializer.deserialize_seq(KlineVisitor)
    }
}

/// The `<symbol>@kline_<interval>` stream.
#[derive(Deserialize)]
pub struct WsKline {
    pub k: WsKlineBody,
}

#[derive(Deserialize)]
pub struct WsKlineBody {
    pub t: u64,
    pub i: String,
    pub o: Decimal,
    pub h: Decimal,
    pub l: Decimal,
    pub c: Decimal,
    pub v: Decimal,
}

impl From<WsKlineBody> for DomainCandle {
    fn from(k: WsKlineBody) -> Self {
        DomainCandle {
            open_time: k.t,
            open: k.o,
            high: k.h,
            low: k.l,
            close: k.c,
            volume: k.v,
        }
    }
}

/// The last 24 hours, from REST `ticker/24hr` or the `@ticker` streams.
/// Deserializes from the stream's single-letter fields; REST goes through
/// `from_rest`.
#[derive(Clone, Deserialize)]
pub struct Ticker {
    #[serde(rename = "s")]
    pub symbol: String,
    /// The price 24 hours ago.
    #[serde(rename = "o")]
    pub open_price: Decimal,
    #[serde(rename = "h")]
    pub high_price: Decimal,
    #[serde(rename = "l")]
    pub low_price: Decimal,
    /// Traded value, in the quote asset.
    #[serde(rename = "q")]
    pub quote_volume: Decimal,
}

impl Ticker {
    pub fn from_rest(value: serde_json::Value) -> Result<Vec<Ticker>, serde_json::Error> {
        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase")]
        struct Rest {
            symbol: String,
            open_price: Decimal,
            high_price: Decimal,
            low_price: Decimal,
            quote_volume: Decimal,
        }
        let parse = |v| {
            serde_json::from_value::<Rest>(v).map(|r| Ticker {
                symbol: r.symbol,
                open_price: r.open_price,
                high_price: r.high_price,
                low_price: r.low_price,
                quote_volume: r.quote_volume,
            })
        };
        match value {
            serde_json::Value::Array(items) => items.into_iter().map(parse).collect(),
            one => parse(one).map(|t| vec![t]),
        }
    }
}

/// Mark price and funding, from REST `premiumIndex` or the `@markPrice` streams.
#[derive(Clone)]
pub struct Mark {
    pub symbol: String,
    pub mark_price: Decimal,
    pub index_price: Decimal,
    /// The current interval's rate, as a fraction.
    pub funding_rate: Decimal,
    pub next_funding_time: u64,
}

impl Mark {
    pub fn from_rest(value: serde_json::Value) -> Result<Vec<Mark>, serde_json::Error> {
        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase")]
        struct Rest {
            symbol: String,
            mark_price: Decimal,
            index_price: Decimal,
            last_funding_rate: Decimal,
            next_funding_time: u64,
        }
        let parse = |v| {
            serde_json::from_value::<Rest>(v).map(|r| Mark {
                symbol: r.symbol,
                mark_price: r.mark_price,
                index_price: r.index_price,
                funding_rate: r.last_funding_rate,
                next_funding_time: r.next_funding_time,
            })
        };
        match value {
            serde_json::Value::Array(items) => items.into_iter().map(parse).collect(),
            one => parse(one).map(|m| vec![m]),
        }
    }

    pub fn from_stream(value: serde_json::Value) -> Result<Vec<Mark>, serde_json::Error> {
        #[derive(Deserialize)]
        struct Ws {
            s: String,
            p: Decimal,
            i: Decimal,
            r: Decimal,
            #[serde(rename = "T")]
            next: u64,
        }
        let parse = |v| {
            serde_json::from_value::<Ws>(v).map(|w| Mark {
                symbol: w.s,
                mark_price: w.p,
                index_price: w.i,
                funding_rate: w.r,
                next_funding_time: w.next,
            })
        };
        match value {
            serde_json::Value::Array(items) => items.into_iter().map(parse).collect(),
            one => parse(one).map(|m| vec![m]),
        }
    }
}

/// Parses the `@ticker` / `!ticker@arr` stream payload.
pub fn tickers_from_stream(value: serde_json::Value) -> Result<Vec<Ticker>, serde_json::Error> {
    match value {
        serde_json::Value::Array(_) => serde_json::from_value(value),
        one => serde_json::from_value(one).map(|t| vec![t]),
    }
}

/// The best bid and ask, from the `@bookTicker` stream.
#[derive(Deserialize)]
pub struct BookTicker {
    #[serde(rename = "b")]
    pub bid: Decimal,
    #[serde(rename = "a")]
    pub ask: Decimal,
}

impl BookTicker {
    /// Absent when either side is empty (a zero price).
    pub fn mid(&self) -> Option<Decimal> {
        if self.bid.0.is_zero() || self.ask.0.is_zero() {
            return None;
        }
        Some(Decimal((self.bid.0 + self.ask.0) / RawDecimal::TWO))
    }
}

/// The best bid and ask over REST `ticker/bookTicker`.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RestBookTicker {
    pub bid_price: Decimal,
    pub ask_price: Decimal,
}

impl From<RestBookTicker> for BookTicker {
    fn from(r: RestBookTicker) -> Self {
        BookTicker {
            bid: r.bid_price,
            ask: r.ask_price,
        }
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FundingInfo {
    pub symbol: String,
    pub funding_interval_hours: u32,
}

/// Funding interval in seconds by market; markets not listed use the default.
pub fn funding_intervals(info: Vec<FundingInfo>) -> HashMap<String, u32> {
    info.into_iter()
        .map(|f| (f.symbol, f.funding_interval_hours * 3600))
        .collect()
}

pub fn funding_interval_secs(intervals: &HashMap<String, u32>, market: &str) -> u32 {
    intervals
        .get(market)
        .copied()
        .unwrap_or(DEFAULT_FUNDING_HOURS * 3600)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenInterest {
    pub open_interest: Decimal,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FundingEntry {
    pub symbol: String,
    pub funding_time: u64,
    pub funding_rate: Decimal,
}

pub fn funding_rate(e: FundingEntry) -> FundingRate {
    FundingRate {
        market: e.symbol,
        rate: e.funding_rate,
        time: e.funding_time,
    }
}

/// A market's stats from its latest ticker and mark.
///
/// Aster sends mark and index prices to 8 places whatever the market; with
/// the market's `scale` (its tick's places) prices are rounded to it, and the
/// mid to one place more (it can fall between ticks).
pub fn market_stats(
    ticker: &Ticker,
    mark: &Mark,
    mid_price: Option<Decimal>,
    open_interest: Decimal,
    funding_interval_secs: u32,
    scale: Option<u32>,
    now: u64,
) -> MarketStats {
    let price = |d: Decimal| scale.map_or(d, |s| at_scale(d, s));
    MarketStats {
        market: ticker.symbol.clone(),
        mark_price: price(mark.mark_price),
        mid_price: mid_price.map(|m| scale.map_or(m, |s| at_scale(m, s + 1))),
        index_price: Some(price(mark.index_price)),
        prev_day_price: price(ticker.open_price),
        day_high: Some(price(ticker.high_price)),
        day_low: Some(price(ticker.low_price)),
        day_volume: at_scale(ticker.quote_volume, VOLUME_SCALE),
        open_interest,
        funding_rate: mark.funding_rate,
        funding_interval_secs,
        next_funding_time: mark.next_funding_time,
        time: now,
    }
}

/// Every market's summary, in the order given, for markets that have both a
/// ticker and a mark. Open interest not fetched yet counts as zero. Prices
/// are rounded to each market's scale, as in `market_stats`.
pub fn market_summaries(
    order: &[String],
    tickers: &HashMap<String, Ticker>,
    marks: &HashMap<String, Mark>,
    open_interest: &HashMap<String, Decimal>,
    intervals: &HashMap<String, u32>,
    scales: &HashMap<String, u32>,
) -> Vec<MarketSummary> {
    order
        .iter()
        .filter_map(|market| {
            let ticker = tickers.get(market)?;
            let mark = marks.get(market)?;
            let scale = scales.get(market).copied();
            let price = |d: Decimal| scale.map_or(d, |s| at_scale(d, s));
            Some(MarketSummary {
                market: market.clone(),
                mark_price: price(mark.mark_price),
                prev_day_price: price(ticker.open_price),
                day_volume: at_scale(ticker.quote_volume, VOLUME_SCALE),
                open_interest: open_interest.get(market).copied().unwrap_or_default(),
                funding_rate: mark.funding_rate,
                funding_interval_secs: funding_interval_secs(intervals, market),
            })
        })
        .collect()
}

/// The web API's `all-asset-logo` response.
#[derive(Deserialize)]
pub struct LogoList {
    #[serde(default)]
    pub data: Option<Vec<LogoEntry>>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LogoEntry {
    pub asset_code: String,
    #[serde(default)]
    pub logo_url: Option<String>,
}

/// Logo URL by asset, keeping only URLs on `host` (the logo host, e.g.
/// "https://static.astherus.finance"): the list comes from the venue, but the
/// adapter only ever fetches from its own fixed hosts.
pub fn logo_urls(list: LogoList, host: &str) -> HashMap<String, String> {
    let prefix = format!("{host}/");
    list.data
        .unwrap_or_default()
        .into_iter()
        .filter_map(|e| {
            let url = e.logo_url?;
            let path = url.strip_prefix(&prefix)?;
            let plain = path
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || matches!(c, '/' | '-' | '_' | '.'));
            (plain && !path.contains("..")).then_some((e.asset_code, url))
        })
        .collect()
}

/// Market ids are the venue's symbols, which can include non-ASCII letters
/// (`币安人生USDT`) and hyphens (`B-MONEYUSDT`). Anything else is refused
/// before it reaches a URL.
pub fn validate_market(market: &str) -> Result<(), VenueError> {
    let ok = !market.is_empty()
        && market.len() <= 64
        && market.chars().all(|c| c.is_alphanumeric() || c == '-');
    if ok {
        Ok(())
    } else {
        Err(VenueError::InvalidRequest(format!(
            "invalid market {market:?}"
        )))
    }
}

/// A market's stream name prefix: lowercase, with anything outside
/// `[a-z0-9-]` percent-encoded for the URL.
pub fn stream_name(market: &str) -> String {
    let mut name = String::new();
    for byte in market.to_lowercase().bytes() {
        if byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'-' {
            name.push(byte as char);
        } else {
            name.push_str(&format!("%{byte:02X}"));
        }
    }
    name
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    fn dec(s: &str) -> Decimal {
        Decimal(s.parse().unwrap())
    }

    #[test]
    fn maps_live_perpetuals_only() {
        let info: ExchangeInfo = serde_json::from_value(json!({
            "symbols": [
                {
                    "symbol": "BTCUSDT", "status": "TRADING", "contractType": "PERPETUAL",
                    "baseAsset": "BTC", "quoteAsset": "USDT", "requiredMarginPercent": "5.0000",
                    "filters": [
                        { "filterType": "PRICE_FILTER", "tickSize": "0.1", "minPrice": "1" },
                        { "filterType": "LOT_SIZE", "stepSize": "0.001", "minQty": "0.001" },
                        { "filterType": "MIN_NOTIONAL", "notional": "5" }
                    ]
                },
                {
                    "symbol": "OLDUSDT", "status": "SETTLING", "contractType": "PERPETUAL",
                    "baseAsset": "OLD", "quoteAsset": "USDT", "requiredMarginPercent": "5",
                    "filters": []
                },
                {
                    "symbol": "NEWUSDT", "status": "PENDING_TRADING", "contractType": "",
                    "baseAsset": "NEW", "quoteAsset": "USDT", "requiredMarginPercent": "5",
                    "filters": []
                }
            ]
        }))
        .unwrap();
        let markets = markets(info);
        assert_eq!(markets.len(), 1);
        let btc = &markets[0];
        assert_eq!(btc.id, "BTCUSDT");
        assert_eq!(btc.symbol, "BTC-USDT");
        assert_eq!(btc.tick_size, dec("0.1"));
        assert_eq!(btc.size_step, dec("0.001"));
        assert_eq!(btc.min_size, dec("0.001"));
        assert_eq!(btc.max_leverage, 20);
    }

    #[test]
    fn leverage_comes_from_the_initial_margin() {
        assert_eq!(max_leverage(dec("5.0000")), 20);
        assert_eq!(max_leverage(dec("33.3300")), 3);
        assert_eq!(max_leverage(dec("1")), 100);
        assert_eq!(max_leverage(dec("0")), 1);
        assert_eq!(max_leverage(dec("150")), 1);
    }

    #[test]
    fn parses_rest_and_stream_books_alike() {
        let rest: Depth = serde_json::from_value(json!({
            "lastUpdateId": 1, "E": 2, "T": 3,
            "bids": [["100.5", "1.2"]], "asks": [["100.6", "0.4"]]
        }))
        .unwrap();
        let stream: Depth = serde_json::from_value(json!({
            "e": "depthUpdate", "E": 2, "T": 3, "s": "BTCUSDT",
            "b": [["100.5", "1.2"]], "a": [["100.6", "0.4"]]
        }))
        .unwrap();
        for depth in [rest, stream] {
            let book = order_book("BTCUSDT", depth);
            assert_eq!(book.time, 3);
            assert_eq!(book.bids[0].price, dec("100.5"));
            assert_eq!(book.asks[0].size, dec("0.4"));
        }
    }

    #[test]
    fn the_aggressor_is_the_side_that_wasnt_the_maker() {
        assert_eq!(aggressor(true), Side::Sell);
        assert_eq!(aggressor(false), Side::Buy);
    }

    #[test]
    fn skips_liquidation_prints() {
        let trade = |x: &str| -> WsTrade {
            serde_json::from_value(json!({
                "t": 1, "p": "1", "q": "1", "T": 1, "m": false, "X": x
            }))
            .unwrap()
        };
        assert!(trade("MARKET").on_book());
        assert!(!trade("INSURANCE_FUND").on_book());
    }

    #[test]
    fn parses_a_rest_kline_and_ignores_its_tail() {
        let klines: Vec<Kline> = serde_json::from_value(json!([[
            1000, "1.0", "2.0", "0.5", "1.5", "10.0", 1999, "15.0", 3, "5.0", "7.5", "0"
        ]]))
        .unwrap();
        let c = &klines[0].0;
        assert_eq!(c.open_time, 1000);
        assert_eq!(
            (c.open, c.high, c.low, c.close),
            (dec("1.0"), dec("2.0"), dec("0.5"), dec("1.5"))
        );
        assert_eq!(c.volume, dec("10.0"));
    }

    #[test]
    fn a_short_kline_is_an_error() {
        let short = serde_json::from_value::<Kline>(json!([1000, "1.0"]));
        assert!(short.is_err());
    }

    #[test]
    fn parses_tickers_and_marks_from_rest_and_streams() {
        let rest = Ticker::from_rest(json!([{
            "symbol": "BTCUSDT", "openPrice": "100", "highPrice": "110",
            "lowPrice": "90", "lastPrice": "105", "quoteVolume": "5000"
        }]))
        .unwrap();
        let stream = tickers_from_stream(json!({
            "e": "24hrTicker", "s": "BTCUSDT", "o": "100", "h": "110", "l": "90", "c": "105", "q": "5000"
        }))
        .unwrap();
        for t in [&rest[0], &stream[0]] {
            assert_eq!(t.symbol, "BTCUSDT");
            assert_eq!(t.open_price, dec("100"));
            assert_eq!(t.quote_volume, dec("5000"));
        }

        let rest = Mark::from_rest(json!({
            "symbol": "BTCUSDT", "markPrice": "105.1", "indexPrice": "105.0",
            "lastFundingRate": "0.0001", "nextFundingTime": 7
        }))
        .unwrap();
        let stream = Mark::from_stream(json!([{
            "e": "markPriceUpdate", "s": "BTCUSDT", "p": "105.1", "i": "105.0", "r": "0.0001", "T": 7
        }]))
        .unwrap();
        for m in [&rest[0], &stream[0]] {
            assert_eq!(m.mark_price, dec("105.1"));
            assert_eq!(m.funding_rate, dec("0.0001"));
            assert_eq!(m.next_funding_time, 7);
        }
    }

    #[test]
    fn mid_is_absent_without_both_sides() {
        let book = |b: &str, a: &str| BookTicker {
            bid: dec(b),
            ask: dec(a),
        };
        assert_eq!(book("100", "102").mid(), Some(dec("101")));
        assert_eq!(book("0", "102").mid(), None);
    }

    #[test]
    fn summaries_need_a_ticker_and_a_mark() {
        let ticker = |s: &str| Ticker {
            symbol: s.into(),
            open_price: dec("1"),
            high_price: dec("1"),
            low_price: dec("1"),
            quote_volume: dec("9"),
        };
        let mark = |s: &str| Mark {
            symbol: s.into(),
            mark_price: dec("2"),
            index_price: dec("2"),
            funding_rate: dec("0.0001"),
            next_funding_time: 0,
        };
        let order = vec!["AUSDT".to_owned(), "BUSDT".to_owned()];
        let tickers = HashMap::from([
            ("AUSDT".to_owned(), ticker("AUSDT")),
            ("BUSDT".to_owned(), ticker("BUSDT")),
        ]);
        let marks = HashMap::from([("AUSDT".to_owned(), mark("AUSDT"))]);
        let oi = HashMap::from([("AUSDT".to_owned(), dec("42"))]);
        let intervals = HashMap::from([("AUSDT".to_owned(), 4 * 3600)]);
        let scales = HashMap::from([("AUSDT".to_owned(), 1)]);
        let summaries = market_summaries(&order, &tickers, &marks, &oi, &intervals, &scales);
        assert_eq!(summaries.len(), 1);
        assert_eq!(summaries[0].open_interest, dec("42"));
        assert_eq!(summaries[0].funding_interval_secs, 4 * 3600);
        assert_eq!(funding_interval_secs(&intervals, "BUSDT"), 8 * 3600);
    }

    #[test]
    fn accepts_venue_symbols_and_refuses_url_syntax() {
        for ok in ["BTCUSDT", "1000SHIBUSDT", "B-MONEYUSDT", "币安人生USDT"] {
            assert!(validate_market(ok).is_ok(), "{ok}");
        }
        for bad in ["", "BTC/USDT", "btc@trade", "A?B", "A B", "A%20B", "A&B"] {
            assert!(validate_market(bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn stream_names_are_lowercase_and_encoded() {
        assert_eq!(stream_name("BTCUSDT"), "btcusdt");
        assert_eq!(stream_name("B-MONEYUSDT"), "b-moneyusdt");
        assert_eq!(stream_name("龙虾USDT"), "%E9%BE%99%E8%99%BEusdt");
    }

    #[test]
    fn prices_round_to_the_tick_and_volume_to_the_cent() {
        assert_eq!(at_scale(dec("83252.10000000"), 1).0.to_string(), "83252.1");
        assert_eq!(at_scale(dec("83252"), 1).0.to_string(), "83252.0");
        assert_eq!(at_scale(dec("0.70690000"), 4).0.to_string(), "0.7069");
        assert_eq!(
            at_scale(dec("1301045.860000"), 2).0.to_string(),
            "1301045.86"
        );
        assert_eq!(price_scale(dec("0.00010")), 4);
        assert_eq!(price_scale(dec("0.1")), 1);
        assert_eq!(price_scale(dec("1")), 0);
    }

    #[test]
    fn stats_read_at_the_markets_precision() {
        let ticker = Ticker {
            symbol: "BTCUSDT".into(),
            open_price: dec("84937.8"),
            high_price: dec("85126.7"),
            low_price: dec("82544.4"),
            quote_volume: dec("354107435.1"),
        };
        let mark = Mark {
            symbol: "BTCUSDT".into(),
            mark_price: dec("83359.90000000"),
            index_price: dec("83380.58586957"),
            funding_rate: dec("0.00008547"),
            next_funding_time: 0,
        };
        let stats = market_stats(
            &ticker,
            &mark,
            Some(dec("83254.45")),
            dec("1"),
            28800,
            Some(1),
            0,
        );
        assert_eq!(stats.mark_price.0.to_string(), "83359.9");
        assert_eq!(stats.index_price.unwrap().0.to_string(), "83380.6");
        assert_eq!(stats.mid_price.unwrap().0.to_string(), "83254.45");
        assert_eq!(stats.day_volume.0.to_string(), "354107435.10");
        // Without a scale (a market listed since the adapter looked), as sent.
        let raw = market_stats(&ticker, &mark, None, dec("1"), 28800, None, 0);
        assert_eq!(raw.mark_price.0.to_string(), "83359.90000000");
    }

    #[test]
    fn meta_keeps_bases_and_price_scales() {
        let info: ExchangeInfo = serde_json::from_value(json!({
            "symbols": [{
                "symbol": "ASTERUSDT", "status": "TRADING", "contractType": "PERPETUAL",
                "baseAsset": "ASTER", "quoteAsset": "USDT", "requiredMarginPercent": "25",
                "filters": [{ "filterType": "PRICE_FILTER", "tickSize": "0.00010" }]
            }]
        }))
        .unwrap();
        let meta = meta(&info);
        assert_eq!(meta.bases["ASTERUSDT"], "ASTER");
        assert_eq!(meta.scales["ASTERUSDT"], 4);
    }

    #[test]
    fn keeps_only_logos_on_the_logo_host() {
        let list: LogoList = serde_json::from_value(json!({ "data": [
            { "assetCode": "BTC", "logoUrl": "https://static.astherus.finance/image/a/1d7e-c3f.png" },
            { "assetCode": "EVIL", "logoUrl": "https://evil.example/x.png" },
            { "assetCode": "SNEAKY", "logoUrl": "https://static.astherus.finance.evil.example/x.png" },
            { "assetCode": "UP", "logoUrl": "https://static.astherus.finance/../x.png" },
            { "assetCode": "QUERY", "logoUrl": "https://static.astherus.finance/x.png?to=elsewhere" },
            { "assetCode": "NONE", "logoUrl": null }
        ]}))
        .unwrap();
        let urls = logo_urls(list, "https://static.astherus.finance");
        assert_eq!(urls.len(), 1);
        assert!(urls["BTC"].ends_with("1d7e-c3f.png"));
        let empty: LogoList = serde_json::from_value(json!({ "data": null })).unwrap();
        assert!(logo_urls(empty, "https://static.astherus.finance").is_empty());
    }
}
