//! BloFin's market data as it comes over the wire, and its translation into
//! the domain's types. No network here.
//!
//! BloFin counts sizes in contracts: a market's `contractValue` is how much
//! of the base asset one contract is (0.001 BTC on BTC-USDT). The domain
//! counts in base units, so every size crossing this module is multiplied
//! by it on the way in, and an order's size divided by it on the way out
//! (`Spec::contracts`, which refuses a size that isn't a whole number of
//! lots). Numbers come as strings, sometimes empty or null for "none", and
//! the WebSocket book sends JSON numbers: [`num`] takes all of them.

use std::collections::HashMap;

use pewterdesk_core::{
    BookLevel, Candle, CandleInterval, Decimal, FundingRate, Market, MarketCategory, MarketStats,
    MarketSummary, OrderBook, Side, Trade, VenueError, VenueId,
};
use rust_decimal::Decimal as Raw;
use serde::{Deserialize, Deserializer};
use serde_json::Value;

/// The longest market id BloFin uses is 18 characters (`1000000MOG-USDT`).
const MAX_MARKET_LEN: usize = 32;

/// A market id as BloFin writes them: capitals and digits, a dash, the
/// quote. Checked before a request carries it.
pub fn validate_market(market: &str) -> Result<(), VenueError> {
    let ok = market.len() <= MAX_MARKET_LEN
        && market.split_once('-').is_some_and(|(base, quote)| {
            !base.is_empty()
                && !quote.is_empty()
                && (base.bytes().chain(quote.bytes()))
                    .all(|b| b.is_ascii_uppercase() || b.is_ascii_digit())
        });
    if ok {
        Ok(())
    } else {
        Err(VenueError::InvalidRequest(format!(
            "{market:?} isn't a BloFin market id (like BTC-USDT)"
        )))
    }
}

/// A number from BloFin: a string, a JSON number, or empty / null for none.
pub fn num(value: &Value) -> Option<Raw> {
    match value {
        Value::String(s) if !s.trim().is_empty() => s.trim().parse().ok(),
        Value::Number(n) => n.to_string().parse().ok(),
        _ => None,
    }
}

/// Deserializes a number field leniently: none reads as `None`.
pub fn opt_num<'de, D: Deserializer<'de>>(d: D) -> Result<Option<Decimal>, D::Error> {
    Ok(num(&Value::deserialize(d)?).map(Decimal))
}

/// A number field where none means zero.
pub fn zero_num<'de, D: Deserializer<'de>>(d: D) -> Result<Decimal, D::Error> {
    Ok(opt_num(d)?.unwrap_or_default())
}

/// A millisecond timestamp, sent as a string (or a number); none is 0.
pub fn ms<'de, D: Deserializer<'de>>(d: D) -> Result<u64, D::Error> {
    Ok(match Value::deserialize(d)? {
        Value::String(s) => s.trim().parse().unwrap_or(0),
        Value::Number(n) => n.as_u64().unwrap_or(0),
        _ => 0,
    })
}

/// A string field that may come as null.
pub fn text<'de, D: Deserializer<'de>>(d: D) -> Result<String, D::Error> {
    Ok(match Value::deserialize(d)? {
        Value::String(s) => s,
        Value::Number(n) => n.to_string(),
        _ => String::new(),
    })
}

/// BloFin's envelope: `code` "0" and `data`, or a refusal.
#[derive(Deserialize)]
pub struct Envelope {
    #[serde(default, deserialize_with = "text")]
    pub code: String,
    #[serde(default, deserialize_with = "text")]
    pub msg: String,
    #[serde(default)]
    pub data: Value,
}

/// One instrument, as `/api/v1/market/instruments` lists it.
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Instrument {
    pub inst_id: String,
    pub base_currency: String,
    pub quote_currency: String,
    #[serde(deserialize_with = "zero_num")]
    pub contract_value: Decimal,
    #[serde(default, deserialize_with = "ms")]
    pub list_time: u64,
    #[serde(default, deserialize_with = "text")]
    pub max_leverage: String,
    #[serde(deserialize_with = "zero_num")]
    pub min_size: Decimal,
    #[serde(deserialize_with = "zero_num")]
    pub lot_size: Decimal,
    #[serde(deserialize_with = "zero_num")]
    pub tick_size: Decimal,
    #[serde(default)]
    pub contract_type: String,
    #[serde(default)]
    pub state: String,
    #[serde(default)]
    pub asset_class: String,
}

impl Instrument {
    /// Live linear (USDT or USDC margined) perpetuals with a sane grid. The
    /// coin-margined (inverse) ones count in the quote and settle in the
    /// coin: left out.
    fn usable(&self) -> bool {
        self.state == "live"
            && self.contract_type == "linear"
            && validate_market(&self.inst_id).is_ok()
            && [
                self.contract_value,
                self.lot_size,
                self.min_size,
                self.tick_size,
            ]
            .iter()
            .all(|d| d.0 > Raw::ZERO)
    }

    fn max_leverage(&self) -> u32 {
        self.max_leverage.trim().parse().unwrap_or(1).max(1)
    }
}

/// A market's grid and contract size, for turning sizes into contracts and
/// checking an order against it.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Spec {
    /// Base units per contract.
    pub contract_value: Decimal,
    pub tick: Decimal,
    /// Contracts per lot: an order's contracts are a multiple of this.
    pub lot: Decimal,
    /// Fewest contracts in an order.
    pub min_contracts: Decimal,
    pub max_leverage: u32,
}

impl Spec {
    /// `contracts` of this market in base units.
    pub fn base(&self, contracts: Decimal) -> Decimal {
        Decimal(contracts.0 * self.contract_value.0)
    }

    /// `size` (base units) as contracts: refused unless it's a positive,
    /// whole number of lots and at least the market's smallest order.
    pub fn contracts(&self, size: Decimal) -> Result<Decimal, VenueError> {
        let step = self.base(self.lot);
        if size.0 <= Raw::ZERO {
            return Err(VenueError::InvalidRequest(
                "the size must be above zero".into(),
            ));
        }
        if (size.0 % step.0) != Raw::ZERO {
            return Err(VenueError::InvalidRequest(format!(
                "the size must be a multiple of {}",
                step.0.normalize()
            )));
        }
        let contracts = size.0 / self.contract_value.0;
        if contracts < self.min_contracts.0 {
            return Err(VenueError::InvalidRequest(format!(
                "the smallest order on this market is {}",
                self.base(self.min_contracts).0.normalize()
            )));
        }
        Ok(Decimal(contracts.normalize()))
    }
}

/// Every usable market's spec, by id.
pub type Specs = HashMap<String, Spec>;

pub fn specs(instruments: &[Instrument]) -> Specs {
    instruments
        .iter()
        .filter(|i| i.usable())
        .map(|i| {
            (
                i.inst_id.clone(),
                Spec {
                    contract_value: i.contract_value,
                    tick: i.tick_size,
                    lot: i.lot_size,
                    min_contracts: i.min_size,
                    max_leverage: i.max_leverage(),
                },
            )
        })
        .collect()
}

fn category(asset_class: &str) -> Option<MarketCategory> {
    match asset_class {
        "Stocks" => Some(MarketCategory::Stock),
        "Commodities" => Some(MarketCategory::Commodity),
        _ => None,
    }
}

pub fn markets(instruments: Vec<Instrument>) -> Vec<Market> {
    instruments
        .into_iter()
        .filter(Instrument::usable)
        .map(|i| {
            let step = Decimal((i.lot_size.0 * i.contract_value.0).normalize());
            let min = Decimal((i.min_size.0 * i.contract_value.0).normalize());
            Market {
                venue: VenueId::Blofin,
                symbol: i.inst_id.clone(),
                max_leverage: i.max_leverage(),
                category: category(&i.asset_class),
                listed_at: (i.list_time > 0).then_some(i.list_time),
                id: i.inst_id,
                base: i.base_currency,
                quote: i.quote_currency,
                tick_size: Decimal(i.tick_size.0.normalize()),
                size_step: step,
                min_size: min,
                listed_by: None,
            }
        })
        .collect()
}

/// A market's ticker, from REST or the `tickers` channel.
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Ticker {
    pub inst_id: String,
    #[serde(default, deserialize_with = "zero_num")]
    pub last: Decimal,
    #[serde(default, deserialize_with = "zero_num")]
    pub ask_price: Decimal,
    #[serde(default, deserialize_with = "zero_num")]
    pub bid_price: Decimal,
    #[serde(default, deserialize_with = "zero_num")]
    pub open24h: Decimal,
    #[serde(default, deserialize_with = "opt_num")]
    pub high24h: Option<Decimal>,
    #[serde(default, deserialize_with = "opt_num")]
    pub low24h: Option<Decimal>,
    /// The day's volume in the base asset.
    #[serde(default, deserialize_with = "zero_num")]
    pub vol_currency24h: Decimal,
}

impl Ticker {
    /// The day's traded value in the quote asset, near enough: base volume
    /// at the last price (BloFin gives no quote volume).
    pub fn quote_volume(&self) -> Decimal {
        Decimal((self.vol_currency24h.0 * self.last.0).round_dp(2))
    }

    pub fn mid(&self) -> Option<Decimal> {
        (self.bid_price.0 > Raw::ZERO && self.ask_price.0 >= self.bid_price.0)
            .then(|| Decimal((self.bid_price.0 + self.ask_price.0) / Raw::TWO))
    }
}

/// A market's mark and index, from `/api/v1/market/mark-price`.
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Mark {
    pub inst_id: String,
    #[serde(default, deserialize_with = "zero_num")]
    pub mark_price: Decimal,
    #[serde(default, deserialize_with = "opt_num")]
    pub index_price: Option<Decimal>,
}

/// A market's current funding, from REST or the `funding-rate` channel.
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Funding {
    pub inst_id: String,
    #[serde(default, deserialize_with = "zero_num")]
    pub funding_rate: Decimal,
    #[serde(default, deserialize_with = "ms")]
    pub funding_time: u64,
    #[serde(default, deserialize_with = "text")]
    pub funding_interval: String,
    #[serde(default)]
    pub funding_interval_unit: String,
}

/// Eight hours, BloFin's usual funding interval.
const DEFAULT_FUNDING_SECS: u32 = 8 * 3600;

impl Funding {
    pub fn interval_secs(&self) -> u32 {
        let n: u32 = self.funding_interval.trim().parse().unwrap_or(0);
        let unit = match self.funding_interval_unit.as_str() {
            "minute" => 60,
            "hour" => 3600,
            _ => 0,
        };
        match n.saturating_mul(unit) {
            0 => DEFAULT_FUNDING_SECS,
            secs => secs,
        }
    }
}

/// One past funding payment, from `/api/v1/market/funding-rate-history`.
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FundingEntry {
    pub inst_id: String,
    #[serde(default, deserialize_with = "zero_num")]
    pub funding_rate: Decimal,
    #[serde(default, deserialize_with = "ms")]
    pub funding_time: u64,
}

pub fn funding_rate(entry: FundingEntry) -> FundingRate {
    FundingRate {
        market: entry.inst_id,
        rate: entry.funding_rate,
        time: entry.funding_time,
    }
}

/// A market's open interest, from `/api/v1/market/open-interest` - an
/// endpoint BloFin serves but doesn't document (checked against the live API,
/// 2026-10): `openInterest` in contracts, `openInterestCurrency` in the base
/// asset.
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenInterest {
    pub inst_id: String,
    #[serde(default, deserialize_with = "zero_num")]
    pub open_interest_currency: Decimal,
}

/// Open interest in base units, by market.
pub fn open_interest(rows: Vec<OpenInterest>) -> HashMap<String, Decimal> {
    rows.into_iter()
        .map(|r| (r.inst_id, r.open_interest_currency))
        .collect()
}

/// The market's headline stats.
pub fn market_stats(
    market: &str,
    ticker: &Ticker,
    mark: Decimal,
    index: Option<Decimal>,
    funding: Option<&Funding>,
    open_interest: Decimal,
    time: u64,
) -> MarketStats {
    MarketStats {
        market: market.to_owned(),
        mark_price: if mark.0 > Raw::ZERO {
            mark
        } else {
            ticker.last
        },
        mid_price: ticker.mid(),
        index_price: index,
        prev_day_price: ticker.open24h,
        day_high: ticker.high24h,
        day_low: ticker.low24h,
        day_volume: ticker.quote_volume(),
        open_interest,
        funding_rate: funding.map(|f| f.funding_rate).unwrap_or_default(),
        funding_interval_secs: funding.map_or(DEFAULT_FUNDING_SECS, Funding::interval_secs),
        next_funding_time: funding.map_or(0, |f| f.funding_time),
        time,
    }
}

/// Every market's summary, in `order` (busiest first).
pub fn market_summaries(
    order: &[String],
    tickers: &HashMap<String, Ticker>,
    marks: &HashMap<String, Mark>,
    funding: &HashMap<String, Funding>,
    open_interest: &HashMap<String, Decimal>,
) -> Vec<MarketSummary> {
    order
        .iter()
        .filter_map(|id| {
            let t = tickers.get(id)?;
            let mark = marks
                .get(id)
                .map(|m| m.mark_price)
                .filter(|m| m.0 > Raw::ZERO)
                .unwrap_or(t.last);
            let f = funding.get(id);
            Some(MarketSummary {
                market: id.clone(),
                mark_price: mark,
                prev_day_price: t.open24h,
                day_volume: t.quote_volume(),
                open_interest: open_interest.get(id).copied().unwrap_or_default(),
                funding_rate: f.map(|f| f.funding_rate).unwrap_or_default(),
                funding_interval_secs: f.map_or(DEFAULT_FUNDING_SECS, Funding::interval_secs),
            })
        })
        .collect()
}

/// BloFin's name for an interval (`bar`, and the candle channel's suffix).
pub fn interval_code(interval: CandleInterval) -> &'static str {
    match interval {
        CandleInterval::OneMinute => "1m",
        CandleInterval::ThreeMinutes => "3m",
        CandleInterval::FiveMinutes => "5m",
        CandleInterval::FifteenMinutes => "15m",
        CandleInterval::ThirtyMinutes => "30m",
        CandleInterval::OneHour => "1H",
        CandleInterval::TwoHours => "2H",
        CandleInterval::FourHours => "4H",
        CandleInterval::EightHours => "8H",
        CandleInterval::TwelveHours => "12H",
        CandleInterval::OneDay => "1D",
        CandleInterval::ThreeDays => "3D",
        CandleInterval::OneWeek => "1W",
        CandleInterval::OneMonth => "1M",
        // Never asked of the venue: built from monthly candles (`CandleInterval::grouped`).
        CandleInterval::ThreeMonths | CandleInterval::SixMonths | CandleInterval::TwelveMonths => {
            "1M"
        }
    }
}

/// A candle row: `[ts, open, high, low, close, vol (contracts), volCurrency
/// (base), volCurrencyQuote, confirm]`. The volume kept is the base one.
pub fn candle(row: &Value) -> Option<Candle> {
    let row = row.as_array()?;
    let at = |i: usize| row.get(i).and_then(num).map(Decimal);
    let open_time = match row.first()? {
        Value::String(s) => s.parse().ok()?,
        Value::Number(n) => n.as_u64()?,
        _ => return None,
    };
    Some(Candle {
        open_time,
        open: at(1)?,
        high: at(2)?,
        low: at(3)?,
        close: at(4)?,
        volume: at(6).unwrap_or_default(),
    })
}

/// Candles from a REST answer (newest first), oldest first.
pub fn candles(data: &Value) -> Vec<Candle> {
    let mut out: Vec<Candle> = data
        .as_array()
        .map(|rows| rows.iter().filter_map(candle).collect())
        .unwrap_or_default();
    out.sort_by_key(|c| c.open_time);
    out.dedup_by_key(|c| c.open_time);
    out
}

/// One print, from REST or the `trades` channel.
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WireTrade {
    #[serde(deserialize_with = "text")]
    pub trade_id: String,
    #[serde(default, deserialize_with = "zero_num")]
    pub price: Decimal,
    #[serde(default, deserialize_with = "zero_num")]
    pub size: Decimal,
    #[serde(default)]
    pub side: String,
    #[serde(default, deserialize_with = "ms")]
    pub ts: u64,
}

pub fn trade(market: &str, t: WireTrade, spec: &Spec) -> Trade {
    Trade {
        market: market.to_owned(),
        id: t.trade_id,
        side: if t.side == "sell" {
            Side::Sell
        } else {
            Side::Buy
        },
        price: t.price,
        size: spec.base(t.size),
        time: t.ts,
    }
}

/// A book's side as BloFin sends it: `[[price, contracts], ...]`, strings
/// over REST and numbers over the WebSocket.
pub fn levels(side: &Value) -> Vec<(Raw, Raw)> {
    side.as_array()
        .map(|rows| {
            rows.iter()
                .filter_map(|row| {
                    let row = row.as_array()?;
                    Some((num(row.first()?)?, num(row.get(1)?)?))
                })
                .collect()
        })
        .unwrap_or_default()
}

/// A REST book snapshot, sizes in base units.
pub fn order_book(market: &str, data: &Value, spec: &Spec, time: u64) -> OrderBook {
    let book = data.as_array().and_then(|a| a.first()).unwrap_or(data);
    let side = |key: &str| -> Vec<BookLevel> {
        levels(&book[key])
            .into_iter()
            .filter(|(_, size)| *size > Raw::ZERO)
            .map(|(price, size)| BookLevel {
                price: Decimal(price),
                size: spec.base(Decimal(size)),
            })
            .collect()
    };
    let mut bids = side("bids");
    let mut asks = side("asks");
    bids.sort_by_key(|l| std::cmp::Reverse(l.price));
    asks.sort_by_key(|l| l.price);
    OrderBook {
        market: market.to_owned(),
        bids,
        asks,
        time,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn d(s: &str) -> Decimal {
        Decimal(s.parse().unwrap())
    }

    fn btc() -> Instrument {
        serde_json::from_value(json!({
            "instId":"BTC-USDT","baseCurrency":"BTC","quoteCurrency":"USDT","contractValue":"0.001",
            "listTime":"1673517600000","expireTime":"4918462709025","maxLeverage":"150",
            "assetClass":"Crypto","minSize":"0.1","lotSize":"0.1","tickSize":"0.1","instType":"SWAP",
            "contractType":"linear","maxLimitSize":"1000000","maxMarketSize":"100000","state":"live",
            "settleCurrency":"USDT","offTime":"","apiPermission":"full"
        }))
        .unwrap()
    }

    #[test]
    fn market_ids_are_checked() {
        for ok in ["BTC-USDT", "1000PEPE-USDT", "ETH-USDC"] {
            assert!(validate_market(ok).is_ok(), "{ok}");
        }
        for bad in [
            "",
            "BTCUSDT",
            "btc-usdt",
            "BTC-",
            "-USDT",
            "BTC-USDT&x=1",
            "BTC-USD-T",
        ] {
            assert!(validate_market(bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn markets_count_in_base_units() {
        let markets = markets(vec![btc()]);
        let m = &markets[0];
        assert_eq!(
            (m.id.as_str(), m.base.as_str(), m.quote.as_str()),
            ("BTC-USDT", "BTC", "USDT")
        );
        assert_eq!(
            (m.size_step, m.min_size, m.tick_size),
            (d("0.0001"), d("0.0001"), d("0.1"))
        );
        assert_eq!(m.max_leverage, 150);
        assert_eq!(m.listed_at, Some(1673517600000));
    }

    #[test]
    fn inverse_and_suspended_markets_are_left_out() {
        let mut inverse = btc();
        inverse.inst_id = "BTC-USD".into();
        inverse.contract_type = "inverse".into();
        let mut suspended = btc();
        suspended.state = "suspend".into();
        let mut stock = btc();
        stock.inst_id = "TSLA-USDT".into();
        stock.asset_class = "Stocks".into();
        let markets = markets(vec![inverse, suspended, stock]);
        assert_eq!(markets.len(), 1);
        assert_eq!(markets[0].category, Some(MarketCategory::Stock));
    }

    #[test]
    fn sizes_become_whole_lots_of_contracts() {
        let spec = specs(&[btc()])["BTC-USDT"];
        assert_eq!(spec.contracts(d("0.05")).unwrap(), d("50"));
        assert_eq!(spec.contracts(d("0.0001")).unwrap(), d("0.1"));
        assert_eq!(spec.base(d("50")), d("0.050"));
        for bad in ["0", "-0.1", "0.00005", "0.00015"] {
            assert!(spec.contracts(d(bad)).is_err(), "{bad}");
        }
        let big_min = Spec {
            min_contracts: d("1"),
            ..spec
        };
        assert!(big_min.contracts(d("0.0005")).is_err());
    }

    #[test]
    fn numbers_come_in_every_shape() {
        assert_eq!(num(&json!("1.50")), Some("1.50".parse().unwrap()));
        assert_eq!(num(&json!(1639.75)), Some("1639.75".parse().unwrap()));
        assert_eq!(num(&json!(392)), Some("392".parse().unwrap()));
        assert_eq!(num(&json!("")), None);
        assert_eq!(num(&Value::Null), None);
    }

    #[test]
    fn candles_turn_oldest_first_with_base_volume() {
        let data = json!([
            [
                "1793102400000",
                "79880.1",
                "80251",
                "79810.1",
                "80209.7",
                "32807",
                "32.8077",
                "2626043.21154",
                "0"
            ],
            [
                "1793098800000",
                "79953.1",
                "80126.8",
                "79827.1",
                "79880.4",
                "75506",
                "75.5065",
                "6036715.81935",
                "1"
            ]
        ]);
        let c = candles(&data);
        assert_eq!(c.len(), 2);
        assert_eq!(c[0].open_time, 1793098800000);
        assert_eq!(c[1].close, d("80209.7"));
        assert_eq!(c[1].volume, d("32.8077"));
    }

    #[test]
    fn books_sort_and_scale_from_strings_or_numbers() {
        let spec = specs(&[btc()])["BTC-USDT"];
        let rest = json!([{"asks":[["80240.2","30"],["80240.1","5959"]],"bids":[["80239.7","22809"],["80239.8","16021"]],"ts":"1"}]);
        let book = order_book("BTC-USDT", &rest, &spec, 1);
        assert_eq!(book.asks[0].price, d("80240.1"));
        assert_eq!(book.asks[0].size, d("5.959"));
        assert_eq!(book.bids[0].price, d("80239.8"));
        let ws = json!({"asks":[[1639.75,392]],"bids":[[1639.7,6817]]});
        assert_eq!(
            levels(&ws["asks"]),
            vec![("1639.75".parse().unwrap(), "392".parse().unwrap())]
        );
    }

    #[test]
    fn open_interest_is_read_in_base_units() {
        let rows: Vec<OpenInterest> = serde_json::from_value(json!([
            {"instId":"BTC-USDT","openInterest":"4184389","openInterestCurrency":"4184.389","ts":"1793125800000"}
        ]))
        .unwrap();
        assert_eq!(open_interest(rows)["BTC-USDT"], d("4184.389"));
    }

    #[test]
    fn funding_intervals_read_their_unit() {
        let f: Funding = serde_json::from_value(json!({
            "instId":"BTC-USDT","fundingRate":"0.00021566","fundingTime":"1793116800000",
            "fundingInterval":"8","fundingIntervalUnit":"hour"
        }))
        .unwrap();
        assert_eq!(f.interval_secs(), 28800);
        let ws: Funding = serde_json::from_value(json!({
            "fundingRate":"0.0001875391284828","fundingTime":"1700726400000","instId":"BTC-USDT"
        }))
        .unwrap();
        assert_eq!(ws.interval_secs(), 28800);
    }

    #[test]
    fn stats_fall_back_to_the_last_price_without_a_mark() {
        let t: Ticker = serde_json::from_value(json!({
            "instId":"BTC-USDT","last":"80240.1","askPrice":"80240.1","bidPrice":"80239.8",
            "high24h":"80815.8","open24h":"80362","low24h":"79432.6","volCurrency24h":"10","vol24h":"10000"
        }))
        .unwrap();
        let s = market_stats(
            "BTC-USDT",
            &t,
            Decimal::default(),
            None,
            None,
            Decimal::default(),
            5,
        );
        assert_eq!(s.mark_price, d("80240.1"));
        assert_eq!(s.mid_price, Some(d("80239.95")));
        assert_eq!(s.day_volume, d("802401.00"));
        assert_eq!(s.open_interest, Decimal::default());
    }
}
