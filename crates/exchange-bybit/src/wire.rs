//! Bybit's V5 wire format, mapped into the domain types. Every REST reply is
//! `{retCode, retMsg, result}`; a non-zero `retCode` is an error even on
//! HTTP 200. Numbers arrive as strings, already at the market's precision.

use std::collections::{BTreeMap, HashMap};

use pewterdesk_core::{
    BookLevel, Candle, CandleInterval, Decimal, FundingRate, Market, MarketStats, MarketSummary,
    OrderBook, Side, Trade, VenueError, VenueId,
};
use rust_decimal::prelude::ToPrimitive;
use serde::Deserialize;
use serde_json::Value;

/// 24h volume is shown to the cent.
const VOLUME_SCALE: u32 = 2;

/// Every reply's envelope. `result` is read only once `retCode` says it's
/// a success: on an error it's an empty object, not the expected shape.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Reply {
    pub ret_code: i64,
    pub ret_msg: String,
    #[serde(default)]
    pub result: Value,
}

/// The `result` of a reply as `T`, or the venue's message as an error.
pub fn result<T: serde::de::DeserializeOwned>(reply: Reply) -> Result<T, VenueError> {
    if reply.ret_code != 0 {
        return Err(VenueError::InvalidRequest(reply.ret_msg));
    }
    serde_json::from_value(reply.result)
        .map_err(|e| VenueError::Network(format!("unexpected Bybit response: {e}")))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Page<T> {
    pub list: Vec<T>,
    #[serde(default)]
    pub next_page_cursor: Option<String>,
}

/// A number Bybit sends as a string, where an empty string means none.
fn opt_decimal(s: &str) -> Option<Decimal> {
    s.parse::<rust_decimal::Decimal>().ok().map(Decimal)
}

fn decimal(s: &str) -> Decimal {
    opt_decimal(s).unwrap_or_default()
}

fn rounded(d: Decimal, scale: u32) -> Decimal {
    let mut v = d.0.round_dp(scale);
    v.rescale(scale);
    Decimal(v)
}

// Markets

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Instrument {
    pub symbol: String,
    pub contract_type: String,
    pub status: String,
    pub base_coin: String,
    pub quote_coin: String,
    pub leverage_filter: LeverageFilter,
    pub price_filter: PriceFilter,
    pub lot_size_filter: LotSizeFilter,
    /// Minutes between funding payments; 0 on dated futures.
    #[serde(default)]
    pub funding_interval: u32,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LeverageFilter {
    pub max_leverage: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PriceFilter {
    pub tick_size: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LotSizeFilter {
    pub qty_step: String,
    pub min_order_qty: String,
}

impl Instrument {
    /// A perpetual that's trading. Dated futures (`LinearFutures`) share the
    /// category but aren't perpetuals, which is all the terminal shows.
    pub fn is_live(&self) -> bool {
        self.contract_type == "LinearPerpetual" && self.status == "Trading"
    }
}

pub fn market(i: &Instrument) -> Market {
    Market {
        venue: VenueId::Bybit,
        id: i.symbol.clone(),
        symbol: format!("{}-{}", i.base_coin, i.quote_coin),
        base: i.base_coin.clone(),
        quote: i.quote_coin.clone(),
        tick_size: decimal(&i.price_filter.tick_size),
        size_step: decimal(&i.lot_size_filter.qty_step),
        min_size: decimal(&i.lot_size_filter.min_order_qty),
        max_leverage: decimal(&i.leverage_filter.max_leverage)
            .0
            .trunc()
            .to_u32()
            .unwrap_or(1)
            .max(1),
        listed_by: None,
    }
}

/// What the streams need from the instrument list: which markets are live
/// perpetuals, and each one's funding interval in seconds.
#[derive(Default)]
pub struct Meta {
    pub funding_secs: HashMap<String, u32>,
}

impl Meta {
    pub fn new(instruments: &[Instrument]) -> Self {
        Self {
            funding_secs: instruments
                .iter()
                .filter(|i| i.is_live())
                .map(|i| (i.symbol.clone(), i.funding_interval * 60))
                .collect(),
        }
    }

    pub fn is_live(&self, market: &str) -> bool {
        self.funding_secs.contains_key(market)
    }

    pub fn funding(&self, market: &str) -> u32 {
        self.funding_secs.get(market).copied().unwrap_or(8 * 3600)
    }
}

pub fn validate_market(market: &str) -> Result<(), VenueError> {
    let ok = !market.is_empty()
        && market.len() <= 32
        && market.chars().all(|c| c.is_ascii_alphanumeric());
    if ok {
        Ok(())
    } else {
        Err(VenueError::InvalidRequest(format!(
            "invalid market {market:?}"
        )))
    }
}

// Order book

/// `[price, size]` pairs, as REST and the stream send them.
#[derive(Deserialize)]
pub struct Depth {
    #[serde(default)]
    pub b: Vec<[String; 2]>,
    #[serde(default)]
    pub a: Vec<[String; 2]>,
}

/// A market's book kept from the stream: a snapshot, then deltas where a
/// size of "0" removes the level. A new snapshot (after a reconnect, or
/// when Bybit restarts the feed) replaces it whole.
#[derive(Default)]
pub struct Book {
    bids: BTreeMap<rust_decimal::Decimal, rust_decimal::Decimal>,
    asks: BTreeMap<rust_decimal::Decimal, rust_decimal::Decimal>,
}

impl Book {
    pub fn apply(&mut self, depth: &Depth, snapshot: bool) {
        if snapshot {
            self.bids.clear();
            self.asks.clear();
        }
        for (side, levels) in [(&mut self.bids, &depth.b), (&mut self.asks, &depth.a)] {
            for [price, size] in levels {
                let (Some(price), Some(size)) = (opt_decimal(price), opt_decimal(size)) else {
                    continue;
                };
                if size.0.is_zero() {
                    side.remove(&price.0);
                } else {
                    side.insert(price.0, size.0);
                }
            }
        }
    }

    /// The top `depth` levels a side: bids high to low, asks low to high.
    pub fn snapshot(&self, market: &str, depth: usize, time: u64) -> OrderBook {
        let level = |(price, size): (&rust_decimal::Decimal, &rust_decimal::Decimal)| BookLevel {
            price: Decimal(*price),
            size: Decimal(*size),
        };
        OrderBook {
            market: market.to_owned(),
            bids: self.bids.iter().rev().take(depth).map(level).collect(),
            asks: self.asks.iter().take(depth).map(level).collect(),
            time,
        }
    }
}

// Trades

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RestTrade {
    pub exec_id: String,
    pub price: String,
    pub size: String,
    pub side: String,
    pub time: String,
}

#[derive(Deserialize)]
pub struct WsTrade {
    #[serde(rename = "i")]
    pub id: String,
    #[serde(rename = "p")]
    pub price: String,
    #[serde(rename = "v")]
    pub size: String,
    #[serde(rename = "S")]
    pub side: String,
    #[serde(rename = "T")]
    pub time: u64,
    /// Block trades are negotiated off the book, so they stay off the tape.
    #[serde(rename = "BT", default)]
    pub block: bool,
}

/// The taker's side: "Buy" means a buyer lifted an ask.
pub fn trade(market: &str, id: String, price: &str, size: &str, side: &str, time: u64) -> Trade {
    Trade {
        market: market.to_owned(),
        id,
        side: if side == "Buy" { Side::Buy } else { Side::Sell },
        price: decimal(price),
        size: decimal(size),
        time,
    }
}

// Candles

/// Bybit's kline interval, or the one a missing width is built from: there
/// are no 8-hour or 3-day klines, so those come from 4-hour and daily ones.
pub fn interval_code(interval: CandleInterval) -> (&'static str, u64) {
    match interval {
        CandleInterval::OneMinute => ("1", 1),
        CandleInterval::ThreeMinutes => ("3", 1),
        CandleInterval::FiveMinutes => ("5", 1),
        CandleInterval::FifteenMinutes => ("15", 1),
        CandleInterval::ThirtyMinutes => ("30", 1),
        CandleInterval::OneHour => ("60", 1),
        CandleInterval::TwoHours => ("120", 1),
        CandleInterval::FourHours => ("240", 1),
        CandleInterval::EightHours => ("240", 2),
        CandleInterval::TwelveHours => ("720", 1),
        CandleInterval::OneDay => ("D", 1),
        CandleInterval::ThreeDays => ("D", 3),
        CandleInterval::OneWeek => ("W", 1),
    }
}

/// A REST kline: `[start, open, high, low, close, volume, turnover]`.
pub fn rest_candle(row: &[String]) -> Option<Candle> {
    if row.len() < 6 {
        return None;
    }
    Some(Candle {
        open_time: row[0].parse().ok()?,
        open: opt_decimal(&row[1])?,
        high: opt_decimal(&row[2])?,
        low: opt_decimal(&row[3])?,
        close: opt_decimal(&row[4])?,
        volume: opt_decimal(&row[5])?,
    })
}

#[derive(Deserialize)]
pub struct WsKline {
    pub start: u64,
    pub interval: String,
    pub open: String,
    pub high: String,
    pub low: String,
    pub close: String,
    pub volume: String,
}

impl From<&WsKline> for Candle {
    fn from(k: &WsKline) -> Self {
        Candle {
            open_time: k.start,
            open: decimal(&k.open),
            high: decimal(&k.high),
            low: decimal(&k.low),
            close: decimal(&k.close),
            volume: decimal(&k.volume),
        }
    }
}

/// Builds `width`-long candles out of shorter ones (oldest first), grouped
/// by open time rounded down to `width`. The oldest group is dropped when
/// its first part is missing, since it would start late; the newest may be
/// still forming, which is right.
pub fn aggregate(parts: &[Candle], width: u64) -> Vec<Candle> {
    let mut out: Vec<Candle> = Vec::new();
    for part in parts {
        let open = part.open_time - part.open_time % width;
        match out.last_mut() {
            Some(last) if last.open_time == open => {
                last.high = last.high.max(part.high);
                last.low = last.low.min(part.low);
                last.close = part.close;
                last.volume = Decimal(last.volume.0 + part.volume.0);
            }
            _ => out.push(Candle {
                open_time: open,
                ..part.clone()
            }),
        }
    }
    if parts.first().is_some_and(|p| p.open_time % width != 0) {
        out.remove(0);
    }
    out
}

/// The one candle containing `at`, built from the parts that fall in it.
pub fn aggregate_at(parts: &BTreeMap<u64, Candle>, width: u64, at: u64) -> Option<Candle> {
    let open = at - at % width;
    let group: Vec<Candle> = parts
        .range(open..open + width)
        .map(|(_, c)| c.clone())
        .collect();
    aggregate(&group, width).into_iter().next()
}

// Tickers

/// A ticker's fields, every one optional: the stream's deltas carry only
/// what changed, and `merge` lays them over the last full set.
#[derive(Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Ticker {
    #[serde(default)]
    pub symbol: String,
    #[serde(default)]
    pub mark_price: Option<String>,
    #[serde(default)]
    pub index_price: Option<String>,
    #[serde(default)]
    pub prev_price24h: Option<String>,
    #[serde(default)]
    pub high_price24h: Option<String>,
    #[serde(default)]
    pub low_price24h: Option<String>,
    #[serde(default)]
    pub turnover24h: Option<String>,
    #[serde(default)]
    pub open_interest: Option<String>,
    #[serde(default)]
    pub funding_rate: Option<String>,
    #[serde(default)]
    pub next_funding_time: Option<String>,
    #[serde(default)]
    pub bid1_price: Option<String>,
    #[serde(default)]
    pub ask1_price: Option<String>,
}

impl Ticker {
    pub fn merge(&mut self, delta: Ticker) {
        let keep = |old: &mut Option<String>, new: Option<String>| {
            if new.is_some() {
                *old = new;
            }
        };
        keep(&mut self.mark_price, delta.mark_price);
        keep(&mut self.index_price, delta.index_price);
        keep(&mut self.prev_price24h, delta.prev_price24h);
        keep(&mut self.high_price24h, delta.high_price24h);
        keep(&mut self.low_price24h, delta.low_price24h);
        keep(&mut self.turnover24h, delta.turnover24h);
        keep(&mut self.open_interest, delta.open_interest);
        keep(&mut self.funding_rate, delta.funding_rate);
        keep(&mut self.next_funding_time, delta.next_funding_time);
        keep(&mut self.bid1_price, delta.bid1_price);
        keep(&mut self.ask1_price, delta.ask1_price);
    }

    fn get(field: &Option<String>) -> Option<Decimal> {
        field.as_deref().and_then(opt_decimal)
    }

    pub fn turnover(&self) -> Decimal {
        Self::get(&self.turnover24h).unwrap_or_default()
    }

    fn mid(&self) -> Option<Decimal> {
        let (bid, ask) = (Self::get(&self.bid1_price)?, Self::get(&self.ask1_price)?);
        (bid.0 > rust_decimal::Decimal::ZERO && ask.0 > rust_decimal::Decimal::ZERO)
            .then(|| Decimal((bid.0 + ask.0) / rust_decimal::Decimal::TWO))
    }
}

pub fn market_stats(t: &Ticker, funding_secs: u32, now: u64) -> MarketStats {
    MarketStats {
        market: t.symbol.clone(),
        mark_price: Ticker::get(&t.mark_price).unwrap_or_default(),
        mid_price: t.mid(),
        index_price: Ticker::get(&t.index_price),
        prev_day_price: Ticker::get(&t.prev_price24h).unwrap_or_default(),
        day_high: Ticker::get(&t.high_price24h),
        day_low: Ticker::get(&t.low_price24h),
        day_volume: rounded(t.turnover(), VOLUME_SCALE),
        open_interest: Ticker::get(&t.open_interest).unwrap_or_default(),
        funding_rate: Ticker::get(&t.funding_rate).unwrap_or_default(),
        funding_interval_secs: funding_secs,
        next_funding_time: t
            .next_funding_time
            .as_deref()
            .and_then(|s| s.parse().ok())
            .unwrap_or(0),
        time: now,
    }
}

/// Every live market's summary, busiest (by 24h turnover) first.
pub fn market_summaries(tickers: Vec<Ticker>, meta: &Meta) -> Vec<MarketSummary> {
    let mut live: Vec<Ticker> = tickers
        .into_iter()
        .filter(|t| meta.is_live(&t.symbol))
        .collect();
    live.sort_by_key(|t| std::cmp::Reverse(t.turnover()));
    live.iter()
        .map(|t| MarketSummary {
            market: t.symbol.clone(),
            mark_price: Ticker::get(&t.mark_price).unwrap_or_default(),
            prev_day_price: Ticker::get(&t.prev_price24h).unwrap_or_default(),
            day_volume: rounded(t.turnover(), VOLUME_SCALE),
            open_interest: Ticker::get(&t.open_interest).unwrap_or_default(),
            funding_rate: Ticker::get(&t.funding_rate).unwrap_or_default(),
            funding_interval_secs: meta.funding(&t.symbol),
        })
        .collect()
}

/// The live markets, busiest first.
pub fn by_volume(tickers: &[Ticker], meta: &Meta) -> Vec<String> {
    let mut live: Vec<&Ticker> = tickers.iter().filter(|t| meta.is_live(&t.symbol)).collect();
    live.sort_by_key(|t| std::cmp::Reverse(t.turnover()));
    live.into_iter().map(|t| t.symbol.clone()).collect()
}

// Funding

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FundingEntry {
    pub symbol: String,
    pub funding_rate: String,
    pub funding_rate_timestamp: String,
}

pub fn funding_rate(e: &FundingEntry) -> Option<FundingRate> {
    Some(FundingRate {
        market: e.symbol.clone(),
        rate: opt_decimal(&e.funding_rate)?,
        time: e.funding_rate_timestamp.parse().ok()?,
    })
}

/// Parses a stream ticker; `Value` because it arrives inside a `Push`.
pub fn ticker(data: Value) -> Option<Ticker> {
    serde_json::from_value(data).ok()
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    fn d(s: &str) -> Decimal {
        decimal(s)
    }

    #[test]
    fn reads_replies_and_their_errors() {
        let ok: Reply = serde_json::from_value(
            json!({ "retCode": 0, "retMsg": "OK", "result": { "list": [] } }),
        )
        .unwrap();
        assert!(result::<Page<Value>>(ok).unwrap().list.is_empty());
        // An error's `result` is `{}`, which isn't the success shape: the
        // venue's message must still come through.
        let err: Reply = serde_json::from_value(
            json!({ "retCode": 10001, "retMsg": "params error: symbol invalid", "result": {} }),
        )
        .unwrap();
        assert_eq!(
            result::<Value>(err).unwrap_err(),
            VenueError::InvalidRequest("params error: symbol invalid".into())
        );
    }

    #[test]
    fn maps_perpetuals_and_skips_dated_futures() {
        let list: Vec<Instrument> = serde_json::from_value(json!([
            { "symbol": "BTCUSDT", "contractType": "LinearPerpetual", "status": "Trading",
              "baseCoin": "BTC", "quoteCoin": "USDT", "fundingInterval": 480,
              "leverageFilter": { "maxLeverage": "150.00" },
              "priceFilter": { "tickSize": "0.10" },
              "lotSizeFilter": { "qtyStep": "0.001", "minOrderQty": "0.001" } },
            { "symbol": "BTC-26DEC26", "contractType": "LinearFutures", "status": "Trading",
              "baseCoin": "BTC", "quoteCoin": "USDT", "fundingInterval": 0,
              "leverageFilter": { "maxLeverage": "100.00" },
              "priceFilter": { "tickSize": "0.50" },
              "lotSizeFilter": { "qtyStep": "0.001", "minOrderQty": "0.001" } }
        ]))
        .unwrap();
        let live: Vec<Market> = list.iter().filter(|i| i.is_live()).map(market).collect();
        assert_eq!(live.len(), 1);
        let btc = &live[0];
        assert_eq!(btc.symbol, "BTC-USDT");
        assert_eq!(btc.max_leverage, 150);
        assert_eq!(btc.tick_size, d("0.10"));
        let meta = Meta::new(&list);
        assert_eq!(meta.funding("BTCUSDT"), 8 * 3600);
        assert!(!meta.is_live("BTC-26DEC26"));
    }

    #[test]
    fn keeps_the_book_from_snapshot_and_deltas() {
        let mut book = Book::default();
        let snap: Depth = serde_json::from_value(json!({
            "b": [["100", "1"], ["99", "2"]], "a": [["101", "1"], ["102", "3"]]
        }))
        .unwrap();
        book.apply(&snap, true);
        let delta: Depth = serde_json::from_value(json!({
            "b": [["100", "0"], ["98", "5"]], "a": [["101", "4"]]
        }))
        .unwrap();
        book.apply(&delta, false);
        let ob = book.snapshot("BTCUSDT", 10, 1);
        let prices = |l: &[BookLevel]| l.iter().map(|x| x.price).collect::<Vec<_>>();
        assert_eq!(prices(&ob.bids), [d("99"), d("98")]);
        assert_eq!(prices(&ob.asks), [d("101"), d("102")]);
        assert_eq!(ob.asks[0].size, d("4"));
        // A fresh snapshot replaces everything.
        book.apply(
            &serde_json::from_value(json!({ "b": [["50", "1"]] })).unwrap(),
            true,
        );
        let ob = book.snapshot("BTCUSDT", 10, 2);
        assert_eq!(prices(&ob.bids), [d("50")]);
        assert!(ob.asks.is_empty());
    }

    fn candle(open_time: u64, o: &str, h: &str, l: &str, c: &str, v: &str) -> Candle {
        Candle {
            open_time,
            open: d(o),
            high: d(h),
            low: d(l),
            close: d(c),
            volume: d(v),
        }
    }

    #[test]
    fn builds_longer_candles_from_shorter() {
        const H4: u64 = 4 * 3_600_000;
        let parts = [
            candle(H4, "10", "12", "9", "11", "1"), // starts mid-group: dropped
            candle(2 * H4, "11", "15", "10", "14", "2"),
            candle(3 * H4, "14", "16", "13", "13", "3"),
            candle(4 * H4, "13", "13", "8", "9", "4"), // forming
        ];
        let eight = aggregate(&parts, 2 * H4);
        assert_eq!(
            eight,
            [
                candle(2 * H4, "11", "16", "10", "13", "5"),
                candle(4 * H4, "13", "13", "8", "9", "4"),
            ]
        );
        let map: BTreeMap<u64, Candle> = parts.iter().map(|c| (c.open_time, c.clone())).collect();
        assert_eq!(
            aggregate_at(&map, 2 * H4, 3 * H4 + 5),
            Some(candle(2 * H4, "11", "16", "10", "13", "5"))
        );
    }

    #[test]
    fn merges_ticker_deltas_into_stats() {
        let mut t: Ticker = serde_json::from_value(json!({
            "symbol": "BTCUSDT", "markPrice": "100", "indexPrice": "101", "prevPrice24h": "90",
            "highPrice24h": "110", "lowPrice24h": "85", "turnover24h": "1234.5678",
            "openInterest": "7", "fundingRate": "0.0001", "nextFundingTime": "1790870400000",
            "bid1Price": "99", "ask1Price": "100"
        }))
        .unwrap();
        t.merge(
            serde_json::from_value(json!({ "symbol": "BTCUSDT", "markPrice": "105" })).unwrap(),
        );
        let s = market_stats(&t, 8 * 3600, 5);
        assert_eq!(s.mark_price, d("105"));
        assert_eq!(s.index_price, Some(d("101")));
        assert_eq!(s.mid_price, Some(d("99.5")));
        assert_eq!(s.day_volume, d("1234.57"));
        assert_eq!(s.next_funding_time, 1_790_870_400_000);
    }

    #[test]
    fn ranks_summaries_by_turnover() {
        let meta = Meta {
            funding_secs: HashMap::from([("A".into(), 3600), ("B".into(), 28_800)]),
        };
        let t = |symbol: &str, turnover: &str| Ticker {
            symbol: symbol.into(),
            turnover24h: Some(turnover.into()),
            ..Ticker::default()
        };
        let rows = market_summaries(vec![t("A", "1"), t("B", "5"), t("FUT", "9")], &meta);
        assert_eq!(
            rows.iter().map(|r| r.market.as_str()).collect::<Vec<_>>(),
            ["B", "A"]
        );
        assert_eq!(rows[0].funding_interval_secs, 28_800);
    }

    #[test]
    fn reads_trades_and_funding() {
        let ws: WsTrade = serde_json::from_value(json!({
            "T": 5, "s": "BTCUSDT", "S": "Sell", "v": "0.5", "p": "100", "i": "x", "BT": false
        }))
        .unwrap();
        let t = trade("BTCUSDT", ws.id, &ws.price, &ws.size, &ws.side, ws.time);
        assert_eq!(t.side, Side::Sell);
        assert_eq!(t.size, d("0.5"));
        let f = funding_rate(&FundingEntry {
            symbol: "BTCUSDT".into(),
            funding_rate: "0.00004127".into(),
            funding_rate_timestamp: "1790841600000".into(),
        })
        .unwrap();
        assert_eq!(f.rate, d("0.00004127"));
        assert_eq!(f.time, 1_790_841_600_000);
    }

    #[test]
    fn checks_market_ids() {
        assert!(validate_market("BTCUSDT").is_ok());
        assert!(validate_market("1000PEPEUSDT").is_ok());
        assert!(validate_market("").is_err());
        assert!(validate_market("BTC/USDT").is_err());
        assert!(validate_market("BTC-26DEC26").is_err());
    }
}
