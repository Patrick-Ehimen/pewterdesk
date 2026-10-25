//! Binance's USDⓈ-M wire format (REST and streams) and its mapping to the
//! domain types. Prices and sizes arrive as strings and go straight into
//! `Decimal` without passing through a float. Shapes checked against the
//! live API (2026-10).

use std::collections::HashMap;
use std::fmt;

use pewterdesk_core::{
    Candle as DomainCandle, CandleInterval, Decimal, FundingRate, Liquidation, LongShortPoint,
    Market, MarketCategory, MarketStats, MarketSummary, OpenInterestPoint, PositionSide, Side,
    Trade, VenueError, VenueId,
};
use rust_decimal::prelude::ToPrimitive;
use rust_decimal::Decimal as RawDecimal;
use serde::de::{self, IgnoredAny, SeqAccess, Visitor};
use serde::{Deserialize, Deserializer};

/// Funding interval for a market `fundingInfo` doesn't list: Binance's
/// default (it lists only the markets that differ).
pub const DEFAULT_FUNDING_HOURS: u32 = 8;

#[derive(Deserialize)]
pub struct ExchangeInfo {
    pub symbols: Vec<SymbolInfo>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SymbolInfo {
    pub symbol: String,
    pub status: String,
    /// `PERPETUAL` for crypto, `TRADIFI_PERPETUAL` for stocks, metals and
    /// the like; dated futures are `CURRENT_QUARTER` and `NEXT_QUARTER`.
    pub contract_type: String,
    pub base_asset: String,
    pub quote_asset: String,
    /// `COIN`, `INDEX`, `EQUITY` (and `HK_`, `KR_`, `CN_EQUITY`),
    /// `COMMODITY`, `FX`, `PREMARKET`.
    #[serde(default)]
    pub underlying_type: String,
    /// When the market was listed, ms since the Unix epoch.
    #[serde(default)]
    pub onboard_date: Option<u64>,
    /// Initial margin at the lowest leverage bracket, in percent.
    pub required_margin_percent: Decimal,
    pub filters: Vec<Filter>,
}

impl SymbolInfo {
    /// Listed, trading and perpetual: settling, delisted, upcoming and dated
    /// markets are left out.
    pub fn is_live(&self) -> bool {
        self.status == "TRADING"
            && matches!(
                self.contract_type.as_str(),
                "PERPETUAL" | "TRADIFI_PERPETUAL"
            )
    }

    fn category(&self) -> Option<MarketCategory> {
        match self.underlying_type.as_str() {
            "EQUITY" | "HK_EQUITY" | "KR_EQUITY" | "CN_EQUITY" => Some(MarketCategory::Stock),
            "COMMODITY" => Some(MarketCategory::Commodity),
            "FX" => Some(MarketCategory::Forex),
            // Pre-IPO and pre-launch listings: new and set apart.
            "PREMARKET" => Some(MarketCategory::Innovation),
            _ => None,
        }
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
    /// How far a limit order's price may be from the mark: within
    /// `[mark * down, mark * up]`.
    #[serde(rename = "PERCENT_PRICE")]
    Band {
        multiplier_up: Decimal,
        multiplier_down: Decimal,
    },
    #[serde(other)]
    Other,
}

/// What the adapter keeps from `exchangeInfo` between calls: each market's
/// price decimals.
#[derive(Default)]
pub struct Meta {
    /// Decimal places of the market's tick size, e.g. 1 for BTCUSDT's 0.1.
    pub scales: HashMap<String, u32>,
}

pub fn meta(info: &ExchangeInfo) -> Meta {
    let mut meta = Meta::default();
    for s in &info.symbols {
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

/// A live market's grid: its tick, size step and smallest size, and the
/// band a limit price must sit in around the mark, where it has one.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Grid {
    pub tick: Decimal,
    pub step: Decimal,
    pub min_size: Decimal,
    /// `(down, up)` multipliers of the mark.
    pub band: Option<(Decimal, Decimal)>,
}

/// Live market `market`'s grid, for checking an order against. `None` for
/// a market that isn't listed and trading, or whose grid the venue didn't
/// give.
pub fn grid(info: &ExchangeInfo, market: &str) -> Option<Grid> {
    let symbol = info
        .symbols
        .iter()
        .find(|s| s.symbol == market && s.is_live())?;
    let mut tick = None;
    let mut lot = None;
    let mut band = None;
    for filter in &symbol.filters {
        match filter {
            Filter::Price { tick_size } => tick = Some(*tick_size),
            Filter::Lot { step_size, min_qty } => lot = Some((*step_size, *min_qty)),
            Filter::Band {
                multiplier_up,
                multiplier_down,
            } => band = Some((*multiplier_down, *multiplier_up)),
            Filter::Other => {}
        }
    }
    let (tick, (step, min_size)) = (tick?, lot?);
    let positive = |d: Decimal| d.0 > RawDecimal::ZERO;
    (positive(tick) && positive(step)).then_some(Grid {
        tick,
        step,
        min_size,
        band,
    })
}

/// A tick size's decimal places ("0.00010" → 4).
pub fn price_scale(tick: Decimal) -> u32 {
    tick.0.normalize().scale()
}

/// `d` rounded to exactly `scale` places ("80128.78553223" at 1 → "80128.8",
/// "80128" at 1 → "80128.0"), so a venue value reads like the others.
pub fn at_scale(d: Decimal, scale: u32) -> Decimal {
    let mut v = d.0.round_dp(scale);
    v.rescale(scale);
    Decimal(v)
}

/// Traded value, in the quote asset, always to the cent.
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
            Filter::Band { .. } | Filter::Other => {}
        }
    }
    let category = s.category();
    Market {
        venue: VenueId::Binance,
        symbol: format!("{}-{}", s.base_asset, s.quote_asset),
        max_leverage: max_leverage(s.required_margin_percent),
        listed_at: s.onboard_date.filter(|&t| t > 0),
        id: s.symbol,
        base: s.base_asset,
        quote: s.quote_asset,
        tick_size,
        size_step,
        min_size,
        listed_by: None,
        category,
    }
}

/// The leverage the lowest bracket's initial margin allows (5% → 20x). The
/// public figure, which is conservative on Binance (BTCUSDT's says 20 where
/// its first bracket allows far more); the account's own brackets
/// (`leverageBracket`, signed) are read where it matters.
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

/// A row of `GET /fapi/v1/leverageBracket?symbol=`: the account's brackets
/// on one market.
#[derive(Deserialize)]
pub struct Brackets {
    pub symbol: String,
    pub brackets: Vec<Bracket>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Bracket {
    pub initial_leverage: u32,
}

impl Brackets {
    /// The highest leverage the account may take on the market: its first
    /// (smallest) bracket's.
    pub fn max_leverage(&self) -> Option<u32> {
        self.brackets.iter().map(|b| b.initial_leverage).max()
    }
}

/// REST `depth`: a snapshot to start a local book from.
#[derive(Deserialize)]
pub struct Depth {
    #[serde(rename = "lastUpdateId")]
    pub last_update_id: u64,
    #[serde(rename = "T")]
    pub time: u64,
    pub bids: Vec<(Decimal, Decimal)>,
    pub asks: Vec<(Decimal, Decimal)>,
}

/// One message of the `<symbol>@depth@100ms` diff stream.
#[derive(Clone, Deserialize)]
pub struct DepthDiff {
    /// First and last update id in this event, and the last one of the
    /// event before it: `pu` must be the previous event's `u`.
    #[serde(rename = "U")]
    pub first: u64,
    #[serde(rename = "u")]
    pub last: u64,
    #[serde(rename = "pu")]
    pub prev: u64,
    #[serde(rename = "T")]
    pub time: u64,
    #[serde(rename = "b")]
    pub bids: Vec<(Decimal, Decimal)>,
    #[serde(rename = "a")]
    pub asks: Vec<(Decimal, Decimal)>,
}

/// One aggregate trade, from REST `aggTrades` or the `@aggTrade` stream
/// (the same fields). Binance's trade stream is aggregated: one print per
/// taker order and price.
#[derive(Deserialize)]
pub struct AggTrade {
    #[serde(rename = "a")]
    pub id: u64,
    #[serde(rename = "p")]
    pub price: Decimal,
    #[serde(rename = "q")]
    pub qty: Decimal,
    #[serde(rename = "T")]
    pub time: u64,
    #[serde(rename = "m")]
    pub is_buyer_maker: bool,
}

/// The maker was the buyer, so the aggressor sold.
fn aggressor(is_buyer_maker: bool) -> Side {
    if is_buyer_maker {
        Side::Sell
    } else {
        Side::Buy
    }
}

pub fn trade(market: &str, t: AggTrade) -> Trade {
    Trade {
        market: market.to_owned(),
        id: t.id.to_string(),
        side: aggressor(t.is_buyer_maker),
        price: t.price,
        size: t.qty,
        time: t.time,
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

/// A row of `/futures/data/openInterestHist`.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenInterestRow {
    pub sum_open_interest: Decimal,
    pub timestamp: u64,
}

pub fn open_interest_point(row: OpenInterestRow) -> OpenInterestPoint {
    OpenInterestPoint {
        time: row.timestamp,
        open_interest: row.sum_open_interest,
    }
}

/// A row of `/futures/data/globalLongShortAccountRatio`: the shares of
/// accounts net long and net short, which add up to one.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LongShortRow {
    pub long_account: Decimal,
    pub short_account: Decimal,
    pub timestamp: u64,
}

pub fn long_short_point(row: LongShortRow) -> LongShortPoint {
    LongShortPoint {
        time: row.timestamp,
        long_ratio: row.long_account,
        short_ratio: row.short_account,
    }
}

/// One push of the `!forceOrder@arr` stream: the latest liquidation on a
/// market (Binance sends at most one a second per market).
#[derive(Deserialize)]
pub struct ForceOrder {
    pub o: ForceOrderBody,
}

#[derive(Deserialize)]
pub struct ForceOrderBody {
    pub s: String,
    /// The liquidation order's side: a sell closes a long.
    #[serde(rename = "S")]
    pub side: String,
    /// Average fill price.
    pub ap: Decimal,
    /// Filled so far.
    pub z: Decimal,
    #[serde(rename = "T")]
    pub time: u64,
}

pub fn liquidation(f: ForceOrder) -> Option<Liquidation> {
    let o = f.o;
    let side = match o.side.as_str() {
        "SELL" => PositionSide::Long,
        "BUY" => PositionSide::Short,
        _ => return None,
    };
    let filled = o.z.0 > RawDecimal::ZERO && o.ap.0 > RawDecimal::ZERO;
    filled.then_some(Liquidation {
        market: o.s,
        side,
        price: o.ap,
        size: o.z,
        time: o.time,
    })
}

/// A market's stats from its latest ticker and mark.
///
/// Binance sends mark and index prices to 8 places whatever the market; with
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

/// Market ids are the venue's symbols, which can include non-ASCII letters
/// (`币安人生USDT`) and digits. Anything else is refused before it reaches
/// a URL.
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

    /// Rows trimmed from the live `exchangeInfo` (2026-10).
    fn info() -> ExchangeInfo {
        serde_json::from_value(json!({ "symbols": [
            {
                "symbol": "BTCUSDT", "pair": "BTCUSDT", "contractType": "PERPETUAL",
                "deliveryDate": 4133404800000u64, "onboardDate": 1567965300000u64,
                "status": "TRADING", "requiredMarginPercent": "5.0000",
                "baseAsset": "BTC", "quoteAsset": "USDT", "marginAsset": "USDT",
                "underlyingType": "COIN", "underlyingSubType": ["PoW", "Crypto"],
                "filters": [
                    {"minPrice": "556.80", "maxPrice": "4529764", "filterType": "PRICE_FILTER", "tickSize": "0.10"},
                    {"filterType": "LOT_SIZE", "minQty": "0.001", "maxQty": "1000", "stepSize": "0.001"},
                    {"maxQty": "120", "filterType": "MARKET_LOT_SIZE", "minQty": "0.001", "stepSize": "0.001"},
                    {"notional": "50", "filterType": "MIN_NOTIONAL"},
                    {"multiplierDown": "0.9700", "multiplierUp": "1.0300", "filterType": "PERCENT_PRICE", "multiplierDecimal": "4"}
                ]
            },
            {
                "symbol": "TSLAUSDT", "contractType": "TRADIFI_PERPETUAL", "status": "TRADING",
                "requiredMarginPercent": "10.0000", "baseAsset": "TSLA", "quoteAsset": "USDT",
                "underlyingType": "EQUITY", "onboardDate": 1760000000000u64,
                "filters": [
                    {"filterType": "PRICE_FILTER", "tickSize": "0.01"},
                    {"filterType": "LOT_SIZE", "minQty": "0.01", "stepSize": "0.01"}
                ]
            },
            {
                "symbol": "XAUUSDT", "contractType": "TRADIFI_PERPETUAL", "status": "TRADING",
                "requiredMarginPercent": "10", "baseAsset": "XAU", "quoteAsset": "USDT",
                "underlyingType": "COMMODITY", "filters": []
            },
            {
                "symbol": "OLDUSDT", "contractType": "PERPETUAL", "status": "SETTLING",
                "requiredMarginPercent": "5", "baseAsset": "OLD", "quoteAsset": "USDT",
                "underlyingType": "COIN", "filters": []
            },
            {
                "symbol": "BTCUSDT_261225", "contractType": "CURRENT_QUARTER", "status": "TRADING",
                "requiredMarginPercent": "5", "baseAsset": "BTC", "quoteAsset": "USDT",
                "underlyingType": "COIN", "filters": []
            }
        ]}))
        .unwrap()
    }

    #[test]
    fn maps_live_perpetuals_with_their_categories() {
        let markets = markets(info());
        let ids: Vec<&str> = markets.iter().map(|m| m.id.as_str()).collect();
        assert_eq!(ids, ["BTCUSDT", "TSLAUSDT", "XAUUSDT"]);
        let btc = &markets[0];
        assert_eq!(btc.venue, VenueId::Binance);
        assert_eq!(btc.symbol, "BTC-USDT");
        assert_eq!(btc.tick_size, dec("0.10"));
        assert_eq!(btc.size_step, dec("0.001"));
        assert_eq!(btc.max_leverage, 20);
        assert_eq!(btc.category, None);
        assert_eq!(btc.listed_at, Some(1567965300000));
        assert_eq!(markets[1].category, Some(MarketCategory::Stock));
        assert_eq!(markets[2].category, Some(MarketCategory::Commodity));
    }

    #[test]
    fn the_grid_carries_the_price_band() {
        let g = grid(&info(), "BTCUSDT").unwrap();
        assert_eq!(g.tick, dec("0.10"));
        assert_eq!(g.min_size, dec("0.001"));
        assert_eq!(g.band, Some((dec("0.9700"), dec("1.0300"))));
        assert_eq!(grid(&info(), "TSLAUSDT").unwrap().band, None);
        // Not trading, dated, or without a grid.
        assert!(grid(&info(), "OLDUSDT").is_none());
        assert!(grid(&info(), "BTCUSDT_261225").is_none());
        assert!(grid(&info(), "XAUUSDT").is_none());
    }

    #[test]
    fn brackets_give_the_accounts_highest_leverage() {
        let b: Vec<Brackets> = serde_json::from_value(json!([{
            "symbol": "BTCUSDT", "notionalCoef": 1.0,
            "brackets": [
                {"bracket": 1, "initialLeverage": 125, "notionalCap": 50000, "notionalFloor": 0, "maintMarginRatio": 0.004, "cum": 0},
                {"bracket": 2, "initialLeverage": 100, "notionalCap": 600000, "notionalFloor": 50000, "maintMarginRatio": 0.005, "cum": 50}
            ]
        }]))
        .unwrap();
        assert_eq!(b[0].max_leverage(), Some(125));
    }

    #[test]
    fn parses_the_book_snapshot_and_a_diff() {
        let depth: Depth = serde_json::from_value(json!({
            "lastUpdateId": 11917375194580u64, "E": 1792919715279u64, "T": 1792919715276u64,
            "bids": [["80122.40", "2.914"]], "asks": [["80122.50", "8.886"]]
        }))
        .unwrap();
        assert_eq!(depth.last_update_id, 11917375194580);
        assert_eq!(depth.bids[0], (dec("80122.40"), dec("2.914")));
        let diff: DepthDiff = serde_json::from_value(json!({
            "e": "depthUpdate", "E": 1, "T": 2, "s": "BTCUSDT",
            "U": 10, "u": 12, "pu": 9, "b": [["1", "0"]], "a": []
        }))
        .unwrap();
        assert_eq!((diff.first, diff.last, diff.prev), (10, 12, 9));
    }

    #[test]
    fn reads_aggregate_trades_from_rest_and_stream() {
        let rest: Vec<AggTrade> = serde_json::from_value(json!([{
            "a": 3495852003u64, "p": "80126.60", "q": "0.002", "nq": "0.002",
            "f": 8202750325u64, "l": 8202750326u64, "T": 1792919712062u64, "m": true
        }]))
        .unwrap();
        let stream: AggTrade = serde_json::from_value(json!({
            "e": "aggTrade", "E": 1, "a": 3495849365u64, "s": "BTCUSDT", "p": "80187.90",
            "q": "0.002", "nq": "0.002", "f": 1, "l": 1, "T": 1792919608647u64, "m": false, "st": 1
        }))
        .unwrap();
        let sold = trade("BTCUSDT", rest.into_iter().next().unwrap());
        assert_eq!((sold.side, sold.id.as_str()), (Side::Sell, "3495852003"));
        assert_eq!(trade("BTCUSDT", stream).side, Side::Buy);
    }

    #[test]
    fn parses_a_rest_kline_and_ignores_its_tail() {
        let klines: Vec<Kline> = serde_json::from_value(json!([[
            1792918800000u64,
            "80374.10",
            "80421.30",
            "80123.10",
            "80126.60",
            "2104.755",
            1792922399999u64,
            "168909534.82990",
            35385,
            "540.535",
            "43382434.91940",
            "0"
        ]]))
        .unwrap();
        let c = &klines[0].0;
        assert_eq!(c.open_time, 1792918800000);
        assert_eq!(c.close, dec("80126.60"));
        assert_eq!(c.volume, dec("2104.755"));
        assert!(serde_json::from_value::<Kline>(json!([1000, "1.0"])).is_err());
    }

    #[test]
    fn parses_tickers_and_marks_from_rest_and_streams() {
        let rest = Ticker::from_rest(json!({
            "symbol": "BTCUSDT", "priceChange": "-478.80", "openPrice": "80605.50",
            "highPrice": "80999.90", "lowPrice": "79178.60", "lastPrice": "80126.70",
            "volume": "110754.424", "quoteVolume": "8885035318.68"
        }))
        .unwrap();
        let stream = tickers_from_stream(json!([{
            "e": "24hrTicker", "s": "BTCUSDT", "o": "80605.50", "h": "80999.90",
            "l": "79178.60", "c": "80126.70", "q": "8885035318.68"
        }]))
        .unwrap();
        for t in [&rest[0], &stream[0]] {
            assert_eq!(t.open_price, dec("80605.50"));
            assert_eq!(t.quote_volume, dec("8885035318.68"));
        }
        let rest = Mark::from_rest(json!({
            "symbol": "BTCUSDT", "markPrice": "80128.78553223", "indexPrice": "80166.82478261",
            "estimatedSettlePrice": "80412.46215484", "lastFundingRate": "0.00006072",
            "interestRate": "0.00010000", "nextFundingTime": 1792944000000u64, "time": 1
        }))
        .unwrap();
        let stream = Mark::from_stream(json!({
            "e": "markPriceUpdate", "s": "BTCUSDT", "p": "80128.78553223",
            "i": "80166.82478261", "r": "0.00006072", "T": 1792944000000u64
        }))
        .unwrap();
        for m in [&rest[0], &stream[0]] {
            assert_eq!(m.funding_rate, dec("0.00006072"));
            assert_eq!(m.next_funding_time, 1792944000000);
        }
    }

    #[test]
    fn reads_positioning_history() {
        let oi: Vec<OpenInterestRow> = serde_json::from_value(json!([{
            "symbol": "BTCUSDT", "sumOpenInterest": "93229.44200000",
            "sumOpenInterestValue": "7518479027.14580000",
            "CMCCirculatingSupply": "20103081.00000000", "timestamp": 1792915200000u64
        }]))
        .unwrap();
        let p = open_interest_point(oi.into_iter().next().unwrap());
        assert_eq!(p.open_interest, dec("93229.44200000"));
        let ls: Vec<LongShortRow> = serde_json::from_value(json!([{
            "symbol": "BTCUSDT", "longAccount": "0.6750", "longShortRatio": "2.0769",
            "shortAccount": "0.3250", "timestamp": 1792915200000u64
        }]))
        .unwrap();
        let p = long_short_point(ls.into_iter().next().unwrap());
        assert_eq!(
            (p.long_ratio, p.short_ratio),
            (dec("0.6750"), dec("0.3250"))
        );
    }

    #[test]
    fn a_sell_liquidation_closed_a_long() {
        let push = |side: &str, filled: &str| -> ForceOrder {
            serde_json::from_value(json!({
                "e": "forceOrder", "E": 1, "o": {
                    "s": "BTCUSDT", "S": side, "o": "LIMIT", "f": "IOC", "q": "0.014",
                    "p": "9910", "ap": "9910", "X": "FILLED", "l": "0.014", "z": filled,
                    "T": 1568014460893u64
                }
            }))
            .unwrap()
        };
        let l = liquidation(push("SELL", "0.014")).unwrap();
        assert_eq!((l.side, l.size), (PositionSide::Long, dec("0.014")));
        assert_eq!(
            liquidation(push("BUY", "0.014")).unwrap().side,
            PositionSide::Short
        );
        assert!(liquidation(push("BUY", "0")).is_none());
    }

    #[test]
    fn stats_read_at_the_markets_precision() {
        let ticker = Ticker {
            symbol: "BTCUSDT".into(),
            open_price: dec("80605.50"),
            high_price: dec("80999.90"),
            low_price: dec("79178.60"),
            quote_volume: dec("8885035318.68"),
        };
        let mark = Mark {
            symbol: "BTCUSDT".into(),
            mark_price: dec("80128.78553223"),
            index_price: dec("80166.82478261"),
            funding_rate: dec("0.00006072"),
            next_funding_time: 0,
        };
        let stats = market_stats(
            &ticker,
            &mark,
            Some(dec("80122.45")),
            dec("1"),
            28800,
            Some(1),
            0,
        );
        assert_eq!(stats.mark_price.0.to_string(), "80128.8");
        assert_eq!(stats.mid_price.unwrap().0.to_string(), "80122.45");
        assert_eq!(stats.day_volume.0.to_string(), "8885035318.68");
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
        let summaries =
            market_summaries(&order, &tickers, &marks, &oi, &intervals, &HashMap::new());
        assert_eq!(summaries.len(), 1);
        assert_eq!(summaries[0].open_interest, dec("42"));
        assert_eq!(summaries[0].funding_interval_secs, 4 * 3600);
        assert_eq!(funding_interval_secs(&intervals, "BUSDT"), 8 * 3600);
    }

    #[test]
    fn accepts_venue_symbols_and_refuses_url_syntax() {
        for ok in ["BTCUSDT", "1000PEPEUSDT", "币安人生USDT", "BTCUSD1"] {
            assert!(validate_market(ok).is_ok(), "{ok}");
        }
        for bad in [
            "",
            "BTC/USDT",
            "btc@trade",
            "A?B",
            "A B",
            "A%20B",
            "A&B",
            "BTCUSDT_261225",
        ] {
            assert!(validate_market(bad).is_err(), "{bad}");
        }
        assert_eq!(stream_name("BTCUSDT"), "btcusdt");
        assert_eq!(
            stream_name("币安人生USDT"),
            "%E5%B8%81%E5%AE%89%E4%BA%BA%E7%94%9Fusdt"
        );
    }
}
