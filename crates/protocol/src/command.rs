//! The command language: what a typed line asks for. The command palette,
//! the CLI panel and `pd` read the same lines (`docs/bots/cli.md`), and
//! `tests/fixtures/commands.json` is the contract every reader of them
//! passes.
//!
//! Parsing only: nothing here places, closes or cancels anything. A reader
//! shows what was understood and asks before it acts.

use pewterdesk_core::{Market, PositionSide, Side};
use rust_decimal::Decimal as D;
use serde::{Deserialize, Serialize};
use ts_rs::TS;

/// Where ts-rs writes these types (`make rust-bindings`). They're exported
/// one by one in `tests/bindings.rs`, never with their dependencies: those
/// are `crates/core`'s, in `domain.ts`, and exporting them from here would
/// overwrite that file with only the few this one uses.
const TS_FILE: &str = "protocol.ts";

/// Orders a scaled order is split into, when the line doesn't say.
const DEFAULT_SCALE: u32 = 5;
const MAX_SCALE: u32 = 10;
/// A TWAP's shortest and longest run, and its most slices (as the engine's).
pub const TWAP_MIN_MS: u64 = 10_000;
pub const TWAP_MAX_MS: u64 = 7 * 24 * 60 * 60_000;
pub const MAX_SLICES: u32 = 500;
/// The furthest a chaser may give up from where it started, in percent.
const MAX_GIVE_UP_PCT: u32 = 50;

/// An open position, as far as the language needs it.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export_to = TS_FILE)]
pub struct OpenPosition {
    pub market: String,
    pub side: PositionSide,
    /// Its size, for what closing or taking part of it sends; the parser
    /// itself doesn't need it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub size: Option<pewterdesk_core::Decimal>,
}

/// An open order, as far as the language needs it.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export_to = TS_FILE)]
pub struct OpenOrder {
    pub id: String,
    pub market: String,
}

/// What a line is read against: the venue's markets, the one on screen
/// (what "buy 100" means without a coin), and the account's positions and
/// open orders.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export_to = TS_FILE)]
pub struct CommandContext {
    pub markets: Vec<Market>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub current: Option<String>,
    #[serde(default)]
    pub positions: Vec<OpenPosition>,
    #[serde(default)]
    pub orders: Vec<OpenOrder>,
}

/// Which of a position's exits.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "lowercase")]
#[ts(export_to = TS_FILE)]
pub enum Exit {
    Tp,
    Sl,
}

/// What a trading line asks for. Markets and orders by id; sizes and prices
/// as decimal text (a size already cut to the market's step).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, TS)]
#[serde(tag = "kind", rename_all = "camelCase")]
#[ts(export_to = TS_FILE)]
pub enum Intent {
    /// "buy 100 hype at 38.2": at a limit with a price, at market without;
    /// "... to 37.8 x5" scales it; "... sl 36 tp 41" puts exits on it.
    #[serde(rename_all = "camelCase")]
    Order {
        side: Side,
        market: String,
        size: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        price: Option<String>,
        /// Scaled: the last order's price, with `count` orders from `price` to it.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        to: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        count: Option<u32>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        stop_loss: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        take_profit: Option<String>,
    },
    /// "sell 50% hype": that share of the open position, reduce-only.
    #[serde(rename_all = "camelCase")]
    Reduce {
        market: String,
        /// Of the position, above 0 and at most 1.
        fraction: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        price: Option<String>,
    },
    /// "tp hype 41", "sl off": a position's exit, set or removed.
    #[serde(rename_all = "camelCase")]
    Protect {
        market: String,
        exit: Exit,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        price: Option<String>,
    },
    /// "close eth": the open position on that market.
    #[serde(rename_all = "camelCase")]
    Close { market: String },
    /// "cancel all", "cancel hype": open orders, every one or one market's.
    #[serde(rename_all = "camelCase")]
    Cancel {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        market: Option<String>,
        orders: Vec<String>,
    },
    /// "chase buy 1 btc to 0.5% then market".
    #[serde(rename_all = "camelCase")]
    Chase {
        side: Side,
        market: String,
        size: String,
        /// Give up this far from the start, in percent.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        give_up_pct: Option<String>,
        /// On giving up, the rest at market.
        finish: bool,
    },
    /// "twap sell 10 eth over 30m x6 chase".
    #[serde(rename_all = "camelCase")]
    Twap {
        side: Side,
        market: String,
        size: String,
        #[ts(type = "number")]
        duration_ms: u64,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        slices: Option<u32>,
        /// Each slice chased at the top of the book rather than sent at market.
        chase: bool,
    },
    /// "halt": stop every algo and cancel what they placed.
    Halt,
}

/// What a line typed into the CLI panel asks for: a trading line, or one of
/// the panel's own.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, TS)]
#[serde(tag = "kind", rename_all = "camelCase")]
#[ts(export_to = TS_FILE)]
pub enum Line {
    Help,
    Clear,
    Positions,
    Orders,
    Balance,
    Price {
        market: String,
    },
    Market {
        market: String,
    },
    Page {
        page: String,
    },
    Trade {
        intent: Intent,
    },
    /// A coin or page that isn't one.
    Missing {
        what: Missing,
        word: String,
    },
    Unknown,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "lowercase")]
#[ts(export_to = TS_FILE)]
pub enum Missing {
    Market,
    Page,
}

fn side_of(word: &str) -> Option<Side> {
    match word {
        "buy" | "long" => Some(Side::Buy),
        "sell" | "short" => Some(Side::Sell),
        _ => None,
    }
}

/// A number as people type one: "1,250.5", "38.2", ".5". Positive, or
/// nothing; given back without its commas.
fn amount(word: Option<&str>) -> Option<String> {
    let plain: String = word?.chars().filter(|c| *c != ',').collect();
    let (whole, frac) = match plain.split_once('.') {
        Some((w, f)) => (w, Some(f)),
        None => (plain.as_str(), None),
    };
    let digits = |s: &str| s.chars().all(|c| c.is_ascii_digit());
    let well_formed = match frac {
        // "12." isn't one: a point needs digits after it.
        Some(f) => digits(whole) && !f.is_empty() && digits(f),
        None => !whole.is_empty() && digits(whole),
    };
    let positive = plain.parse::<D>().is_ok_and(|v| v > D::ZERO);
    (well_formed && positive).then_some(plain)
}

fn dec(text: &str) -> D {
    text.parse().unwrap_or(D::ZERO)
}

/// "50%" as a fraction, above 0 and at most 1.
fn percent(word: Option<&str>) -> Option<D> {
    let value = dec(&amount(word?.strip_suffix('%'))?);
    (value <= D::ONE_HUNDRED).then(|| (value / D::ONE_HUNDRED).normalize())
}

/// The decimal places a step is written with: "0.01" has 2.
fn decimals_of(step: &D) -> u32 {
    step.scale()
}

/// `value` cut down to a whole number of `step`s, written with the step's
/// decimals; nothing when that's zero or below the market's minimum.
fn on_step(value: D, market: &Market) -> Option<String> {
    let step = market.size_step.0;
    if step <= D::ZERO || value <= D::ZERO {
        return None;
    }
    let mut cut = (value / step).floor() * step;
    if cut <= D::ZERO || cut < market.min_size.0 {
        return None;
    }
    cut.rescale(decimals_of(&step));
    Some(cut.to_string())
}

/// The market a word names: its id ("BTCUSDT"), its symbol ("BTC-USDT") or
/// its coin ("btc"). A coin with several markets means the one on screen if
/// it's that coin's, else the USDT perpetual, else a USDT one, else the USDC
/// one, else the first listed.
pub fn find_market<'a>(
    word: &str,
    markets: &'a [Market],
    current: Option<&str>,
) -> Option<&'a Market> {
    let w = word.to_uppercase();
    if let Some(named) = markets
        .iter()
        .find(|m| m.id.to_uppercase() == w)
        .or_else(|| markets.iter().find(|m| m.symbol.to_uppercase() == w))
    {
        return Some(named);
    }
    let coins: Vec<&Market> = markets
        .iter()
        .filter(|m| m.base.to_uppercase() == w)
        .collect();
    coins
        .iter()
        .find(|m| Some(m.id.as_str()) == current)
        .or_else(|| {
            coins
                .iter()
                .find(|m| m.quote == "USDT" && !m.id.contains('-'))
        })
        .or_else(|| coins.iter().find(|m| m.quote == "USDT"))
        .or_else(|| coins.iter().find(|m| m.quote == "USDC"))
        .or_else(|| coins.first())
        .copied()
}

impl CommandContext {
    fn current_market(&self) -> Option<&Market> {
        let id = self.current.as_deref()?;
        self.markets.iter().find(|m| m.id == id)
    }

    fn market_named(&self, word: Option<&str>) -> Option<&Market> {
        match word {
            Some(word) => find_market(word, &self.markets, self.current.as_deref()),
            None => self.current_market(),
        }
    }

    fn position_on(&self, market: &str) -> Option<&OpenPosition> {
        self.positions.iter().find(|p| p.market == market)
    }
}

/// A duration as typed: "45s", "30m", "1h30m", "2d". Each unit once, in
/// that order; above zero.
pub fn parse_duration(word: &str) -> Option<u64> {
    let word = word.to_lowercase();
    let mut rest = word.as_str();
    if rest.is_empty() {
        return None;
    }
    let mut ms: u64 = 0;
    for (unit, scale) in [
        ('d', 86_400_000u64),
        ('h', 3_600_000),
        ('m', 60_000),
        ('s', 1_000),
    ] {
        let digits = rest.chars().take_while(char::is_ascii_digit).count();
        if digits > 0 && rest[digits..].starts_with(unit) {
            let n: u64 = rest[..digits].parse().ok()?;
            ms = ms.checked_add(n.checked_mul(scale)?)?;
            rest = &rest[digits + 1..];
        }
    }
    (rest.is_empty() && ms > 0).then_some(ms)
}

/// A whole number as JS's `Number` would read the text, if it's one.
fn whole(text: Option<&str>) -> Option<u32> {
    let v: f64 = text?.trim().parse().ok()?;
    (v.fract() == 0.0 && v >= 0.0 && v <= f64::from(u32::MAX)).then_some(v as u32)
}

/// How many orders "x5", "5" or "5 orders" (after "in", too) asks for: 2 to
/// `MAX_SCALE`; `DEFAULT_SCALE` when the line doesn't say.
fn scale_count(words: &[String]) -> Option<u32> {
    if words.is_empty() {
        return Some(DEFAULT_SCALE);
    }
    let lead_in = words[0] == "in";
    if words.len() > if lead_in { 3 } else { 2 } {
        return None;
    }
    let tail = if lead_in { &words[1..] } else { words };
    if tail.get(1).is_some_and(|w| w != "orders") {
        return None;
    }
    let count = whole(tail.first().map(|w| w.strip_prefix('x').unwrap_or(w)))?;
    (2..=MAX_SCALE).contains(&count).then_some(count)
}

/// Whether a scaled order can be laid out: prices above zero, and each
/// equal part at least the market's minimum.
fn ladder_fits(market: &Market, size: &str, price: &str, to: &str, count: u32) -> bool {
    if dec(price) <= D::ZERO || dec(to) <= D::ZERO || market.tick_size.0 <= D::ZERO || count < 2 {
        return false;
    }
    on_step(dec(size) / D::from(count), market).is_some()
}

/// The size and the coin, in either order, from what's left of an algo
/// line: the size cut to the market's step, and at least its minimum.
fn size_and_market<'a>(words: &[String], ctx: &'a CommandContext) -> Option<(String, &'a Market)> {
    if words.is_empty() || words.len() > 2 {
        return None;
    }
    let size_word = words.iter().find(|w| amount(Some(w)).is_some())?;
    let coin_word = words.iter().find(|w| amount(Some(w)).is_none());
    if words.len() - usize::from(coin_word.is_some()) != 1 {
        return None;
    }
    let market = ctx.market_named(coin_word.map(String::as_str))?;
    let size = on_step(dec(&amount(Some(size_word))?), market)?;
    Some((size, market))
}

fn remove_at(words: &mut Vec<String>, at: usize, n: usize) {
    let end = (at + n).min(words.len());
    words.drain(at..end);
}

/// "chase buy 1 btc to 0.5% then market".
fn parse_chase(words: &[String], ctx: &CommandContext) -> Option<Intent> {
    let side = side_of(words.first()?)?;
    let mut rest = words[1..].to_vec();
    let mut finish = false;
    if let Some(then) = rest.iter().position(|w| w == "then") {
        if rest.get(then + 1).map(String::as_str) != Some("market") {
            return None;
        }
        finish = true;
        remove_at(&mut rest, then, 2);
    }
    let mut give_up_pct = None;
    if let Some(to) = rest.iter().position(|w| w == "to") {
        let pct = rest
            .get(to + 1)
            .and_then(|w| w.strip_suffix('%'))
            .and_then(|w| amount(Some(w)))
            .map(|a| dec(&a))?;
        if pct <= D::ZERO || pct > D::from(MAX_GIVE_UP_PCT) {
            return None;
        }
        give_up_pct = Some(pct.normalize().to_string());
        remove_at(&mut rest, to, 2);
    }
    // Finishing at market only means something with a give-up distance.
    if finish && give_up_pct.is_none() {
        return None;
    }
    let (size, market) = size_and_market(&rest, ctx)?;
    Some(Intent::Chase {
        side,
        market: market.id.clone(),
        size,
        give_up_pct,
        finish,
    })
}

/// "twap sell 10 eth over 30m x6 chase".
fn parse_twap(words: &[String], ctx: &CommandContext) -> Option<Intent> {
    let side = side_of(words.first()?)?;
    let rest: Vec<String> = words[1..]
        .iter()
        .filter(|w| *w != "over" && *w != "in")
        .cloned()
        .collect();
    let chase = rest.iter().any(|w| w == "chase");
    let mut kept: Vec<String> = rest.into_iter().filter(|w| w != "chase").collect();
    let at = kept
        .iter()
        .position(|w| parse_duration(w).is_some() && amount(Some(w)).is_none())?;
    let duration_ms = parse_duration(&kept[at])?;
    if !(TWAP_MIN_MS..=TWAP_MAX_MS).contains(&duration_ms) {
        return None;
    }
    kept.remove(at);
    let mut slices = None;
    let is_slices = |w: &String| {
        w.strip_prefix('x')
            .is_some_and(|n| !n.is_empty() && n.chars().all(|c| c.is_ascii_digit()))
    };
    if let Some(at) = kept.iter().position(is_slices) {
        let n = whole(kept[at].strip_prefix('x'))?;
        if !(1..=MAX_SLICES).contains(&n) {
            return None;
        }
        slices = Some(n);
        kept.remove(at);
    }
    let (size, market) = size_and_market(&kept, ctx)?;
    Some(Intent::Twap {
        side,
        market: market.id.clone(),
        size,
        duration_ms,
        slices,
        chase,
    })
}

fn words_of(text: &str) -> Vec<String> {
    text.trim()
        .to_lowercase()
        .split_whitespace()
        .map(str::to_owned)
        .collect()
}

/// An order line: "buy 100 hype at 38.2", "sell 50% eth", "buy 100 hype at
/// 38.2 to 37.8 x5", "buy 1 eth sl 2300 tp 2600".
fn parse_order(side: Side, words: &[String], ctx: &CommandContext) -> Option<Intent> {
    let mut rest = words.to_vec();
    // "sl 2400" and "tp 2600", anywhere after the verb, go on with the order.
    let mut stop_loss = None;
    let mut take_profit = None;
    for exit in ["sl", "tp"] {
        let Some(i) = rest.iter().position(|w| w == exit) else {
            continue;
        };
        let price = amount(rest.get(i + 1).map(String::as_str))?;
        if exit == "sl" {
            stop_loss = Some(price);
        } else {
            take_profit = Some(price);
        }
        remove_at(&mut rest, i, 2);
    }
    let with_exits = stop_loss.is_some() || take_profit.is_some();
    // The price follows "at" or "@" ("@38.2" too); "to" and a second price
    // after it make it a scaled order.
    let mut price = None;
    let mut to = None;
    let mut count = None;
    if let Some(at) = rest.iter().position(|w| w == "at" || w.starts_with('@')) {
        let tail: Vec<String> = rest[at..]
            .iter()
            .flat_map(|w| match w.strip_prefix('@') {
                Some(after) => vec!["at".to_owned(), after.to_owned()],
                None => vec![w.clone()],
            })
            .filter(|w| !w.is_empty())
            .collect();
        let after = &tail[1.min(tail.len())..];
        price = Some(amount(after.first().map(String::as_str))?);
        if after.len() > 1 {
            to = if after[1] == "to" {
                amount(after.get(2).map(String::as_str))
            } else {
                None
            };
            count = scale_count(after.get(3..).unwrap_or(&[]));
            if to.is_none() || count.is_none() || to == price {
                return None;
            }
        }
        rest.truncate(at);
    }
    if rest.is_empty() || rest.len() > 2 {
        return None;
    }
    // The size and the coin, in either order.
    let is_size = |w: &String| amount(Some(w)).is_some() || percent(Some(w)).is_some();
    let size_word = rest.iter().find(|w| is_size(w))?;
    let coin_word = rest.iter().find(|w| !is_size(w));
    if rest.len() - usize::from(coin_word.is_some()) != 1 {
        return None;
    }
    let market = ctx.market_named(coin_word.map(String::as_str))?;
    if let Some(fraction) = percent(Some(size_word)) {
        // A share of the position: only the side that takes it off, never
        // scaled, and opening nothing for an exit to protect.
        let closing = match ctx.position_on(&market.id)?.side {
            PositionSide::Long => Side::Sell,
            PositionSide::Short => Side::Buy,
        };
        return (closing == side && to.is_none() && !with_exits).then(|| Intent::Reduce {
            market: market.id.clone(),
            fraction: fraction.to_string(),
            price,
        });
    }
    let size = on_step(dec(&amount(Some(size_word))?), market)?;
    if let (Some(to), Some(count)) = (&to, count) {
        if !ladder_fits(market, &size, price.as_deref().unwrap_or("0"), to, count) {
            return None;
        }
    }
    Some(Intent::Order {
        side,
        market: market.id.clone(),
        size,
        price,
        to,
        count,
        stop_loss,
        take_profit,
    })
}

/// Reads a trading line; `None` when it isn't one (it may still be a
/// search). The lines are listed in `docs/bots/cli.md`.
pub fn parse_command(text: &str, ctx: &CommandContext) -> Option<Intent> {
    let words = words_of(text);
    let verb = words.first()?.as_str();
    match verb {
        "halt" => return (words.len() == 1).then_some(Intent::Halt),
        "chase" => return parse_chase(&words[1..], ctx),
        "twap" => return parse_twap(&words[1..], ctx),
        _ => {}
    }
    if let Some(side) = side_of(verb) {
        return parse_order(side, &words[1..], ctx);
    }
    match verb {
        "tp" | "sl" if (2..=3).contains(&words.len()) => {
            let value = words.last()?;
            let market = ctx.market_named((words.len() == 3).then(|| words[1].as_str()))?;
            ctx.position_on(&market.id)?;
            let off = value == "off" || value == "remove";
            let price = if off { None } else { amount(Some(value)) };
            (off || price.is_some()).then(|| Intent::Protect {
                market: market.id.clone(),
                exit: if verb == "tp" { Exit::Tp } else { Exit::Sl },
                price,
            })
        }
        "close" if words.len() <= 2 => {
            let market = ctx.market_named(words.get(1).map(String::as_str))?;
            let position = ctx.position_on(&market.id)?;
            Some(Intent::Close {
                market: position.market.clone(),
            })
        }
        "cancel" if (2..=3).contains(&words.len()) => {
            let all = words[1] == "all";
            let coin = if all {
                words.get(2)
            } else if words.len() == 2 {
                words.get(1)
            } else {
                return None;
            };
            let market = match coin {
                Some(coin) => Some(find_market(coin, &ctx.markets, ctx.current.as_deref())?),
                None => None,
            };
            let orders: Vec<String> = ctx
                .orders
                .iter()
                .filter(|o| market.is_none_or(|m| o.market == m.id))
                .map(|o| o.id.clone())
                .collect();
            (!orders.is_empty()).then(|| Intent::Cancel {
                market: market.map(|m| m.id.clone()),
                orders,
            })
        }
        _ => None,
    }
}

/// Reads a line typed into the CLI panel: one of its own words, a market
/// or page by name (`pages` are the ones it can open), or a trading line.
/// `None` for an empty line.
pub fn parse_line(text: &str, ctx: &CommandContext, pages: &[String]) -> Option<Line> {
    let words = words_of(text);
    let first = words.first()?.as_str();
    let second = words.get(1).map(String::as_str);
    if words.len() == 1 {
        let plain = match first {
            "help" | "?" => Some(Line::Help),
            "clear" | "cls" => Some(Line::Clear),
            "positions" | "pos" => Some(Line::Positions),
            "orders" => Some(Line::Orders),
            "balance" | "bal" | "equity" => Some(Line::Balance),
            _ => None,
        };
        if plain.is_some() {
            return plain;
        }
    }
    match first {
        "price" | "p" | "market" | "m" => {
            let missing = || Line::Missing {
                what: Missing::Market,
                word: second.unwrap_or_default().to_owned(),
            };
            let Some(market) = ctx.market_named(second) else {
                return Some(missing());
            };
            let market = market.id.clone();
            Some(if first == "price" || first == "p" {
                Line::Price { market }
            } else {
                Line::Market { market }
            })
        }
        "go" | "page" => Some(
            match second.filter(|p| pages.iter().any(|page| page == p)) {
                Some(page) => Line::Page {
                    page: page.to_owned(),
                },
                None => Line::Missing {
                    what: Missing::Page,
                    word: second.unwrap_or_default().to_owned(),
                },
            },
        ),
        _ => Some(match parse_command(text, ctx) {
            Some(intent) => Line::Trade { intent },
            None => Line::Unknown,
        }),
    }
}

/// `fraction` of a position's `size`, cut to the market's step: what
/// "sell 50% eth" takes off. Nothing below the market's minimum.
pub fn share_of(size: D, fraction: &str, market: &Market) -> Option<String> {
    on_step(size.abs() * dec(fraction), market)
}

/// A whole-number percentage as a fraction's text ("0.5" for 50), for
/// callers building lines.
pub fn fraction_of_percent(pct: u32) -> String {
    (D::from(pct) / D::ONE_HUNDRED).normalize().to_string()
}

impl Intent {
    /// The market it acts on, where it acts on one.
    pub fn market(&self) -> Option<&str> {
        match self {
            Intent::Order { market, .. }
            | Intent::Reduce { market, .. }
            | Intent::Protect { market, .. }
            | Intent::Close { market }
            | Intent::Chase { market, .. }
            | Intent::Twap { market, .. } => Some(market),
            Intent::Cancel { market, .. } => market.as_deref(),
            Intent::Halt => None,
        }
    }
}
