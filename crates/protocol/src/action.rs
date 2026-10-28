//! What a parsed line comes to, to send once it's confirmed: the requests
//! an intent turns into, as the app's CLI panel builds them
//! (`apps/desktop/src/lib/cli.ts`'s `actionFor`). A price makes a limit
//! order (or a ladder), none a market order within the venue's slippage
//! bound; closing and taking part off are reduce-only.
//!
//! Building only: nothing here sends anything.

use pewterdesk_core::{
    AlgoKind, AlgoSpec, Decimal, ExitChange, OrderKind, OrderRequest, PositionProtection,
    PositionSide, Side, SliceStyle, Unfilled, VenueId,
};
use rust_decimal::prelude::ToPrimitive;
use rust_decimal::Decimal as D;

use crate::command::{CommandContext, Exit, Intent, OpenOrder};

/// Orders a scaled order is split into, when the line doesn't say (as the parser's).
const DEFAULT_SCALE: u32 = 5;

/// The market-order bound pewterdesk uses on each venue, in basis points
/// (the app's `VENUES[venue].maxSlippage`).
pub fn default_slippage_bps(venue: VenueId) -> u32 {
    match venue {
        VenueId::Hyperliquid => 800,
        VenueId::Bybit | VenueId::Aster => 500,
        // Binance refuses a limit price outside the market's band around
        // the mark (3% on BTCUSDT), so a wider bound would only be pulled in.
        VenueId::Binance => 300,
        // BloFin refuses a price outside its limit range around the mark; a
        // bound outside it is pulled in by the adapter.
        VenueId::Blofin => 300,
    }
}

/// Slices for a TWAP of `duration_ms` when the line doesn't say: about one
/// a minute, 2 to 60 (as the app's `defaultSlices`).
pub fn default_slices(duration_ms: u64) -> u32 {
    let per_minute = (duration_ms as f64 / 60_000.0).round() as u32;
    per_minute.clamp(2, 60)
}

/// Who it's for.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct For {
    pub venue: VenueId,
    pub account: String,
    pub max_slippage_bps: u32,
}

/// What a line comes to.
#[derive(Clone, Debug, PartialEq)]
pub enum Action {
    Orders(Vec<OrderRequest>),
    Cancel(Vec<OpenOrder>),
    Protect {
        market: String,
        protection: PositionProtection,
    },
    Algo(Box<AlgoSpec>),
    Halt,
}

fn dec(text: &str) -> Result<Decimal, String> {
    text.parse()
        .map(Decimal)
        .map_err(|_| format!("{text:?} isn't a number"))
}

fn closing(side: PositionSide) -> Side {
    match side {
        PositionSide::Long => Side::Sell,
        PositionSide::Short => Side::Buy,
    }
}

/// The limit orders a scaled order comes to: its size in equal parts, at
/// prices spread evenly from `from` to `to`, each on the market's tick.
fn ladder(
    market: &pewterdesk_core::Market,
    side: Side,
    size: D,
    from: D,
    to: D,
    count: u32,
    exits: (Option<Decimal>, Option<Decimal>),
) -> Option<Vec<OrderRequest>> {
    let step = market.size_step.0;
    let tick = market.tick_size.0;
    if from <= D::ZERO || to <= D::ZERO || tick <= D::ZERO || count < 2 || step <= D::ZERO {
        return None;
    }
    let mut part = (size / D::from(count) / step).floor() * step;
    if part <= D::ZERO || part < market.min_size.0 {
        return None;
    }
    part.rescale(step.scale());
    let last = D::from(count - 1);
    Some(
        (0..count)
            .map(|i| {
                let raw = from + (to - from) * D::from(i) / last;
                let mut price = (raw / tick).round() * tick;
                price.rescale(tick.scale());
                OrderRequest {
                    market: market.id.clone(),
                    side,
                    size: Decimal(part),
                    reduce_only: false,
                    collateral: None,
                    client_id: None,
                    take_profit: exits.1,
                    stop_loss: exits.0,
                    kind: OrderKind::Limit {
                        price: Decimal(price),
                        time_in_force: None,
                    },
                }
            })
            .collect(),
    )
}

/// What `intent` comes to for `who`, read against `ctx` (the same context
/// it was parsed with).
pub fn action_for(intent: &Intent, ctx: &CommandContext, who: &For) -> Result<Action, String> {
    let market_of = |id: &str| {
        ctx.markets
            .iter()
            .find(|m| m.id == id)
            .ok_or_else(|| format!("{id} isn't a market here"))
    };
    let position_of = |id: &str| {
        ctx.positions
            .iter()
            .find(|p| p.market == id)
            .ok_or_else(|| format!("no open position on {id}"))
    };
    let market_order = |market: &str, side, size, reduce_only| OrderRequest {
        market: market.to_owned(),
        side,
        size,
        reduce_only,
        collateral: None,
        client_id: None,
        take_profit: None,
        stop_loss: None,
        kind: OrderKind::Market {
            max_slippage_bps: who.max_slippage_bps,
        },
    };
    Ok(match intent {
        Intent::Order {
            side,
            market,
            size,
            price,
            to,
            count,
            stop_loss,
            take_profit,
        } => {
            let stop_loss = stop_loss.as_deref().map(dec).transpose()?;
            let take_profit = take_profit.as_deref().map(dec).transpose()?;
            let size = dec(size)?;
            if let (Some(from), Some(to)) = (price, to) {
                let m = market_of(market)?;
                let orders = ladder(
                    m,
                    *side,
                    size.0,
                    dec(from)?.0,
                    dec(to)?.0,
                    count.unwrap_or(DEFAULT_SCALE),
                    (stop_loss, take_profit),
                )
                .ok_or("the ladder's parts would be under the market's minimum")?;
                return Ok(Action::Orders(orders));
            }
            let mut order = market_order(market, *side, size, false);
            order.stop_loss = stop_loss;
            order.take_profit = take_profit;
            if let Some(price) = price {
                order.kind = OrderKind::Limit {
                    price: dec(price)?,
                    time_in_force: None,
                };
            }
            Action::Orders(vec![order])
        }
        Intent::Reduce {
            market,
            fraction,
            price,
        } => {
            let position = position_of(market)?;
            let whole = position
                .size
                .ok_or("the position's size isn't known")?
                .0
                .abs();
            let m = market_of(market)?;
            let fraction = dec(fraction)?.0;
            // A share cut to the step; the whole of it when the share is all
            // or would be under the minimum (as the app's `closeRequest`).
            let step = m.size_step.0;
            let mut size = whole;
            if fraction < D::ONE && step > D::ZERO {
                let mut part = (whole * fraction / step).floor() * step;
                if part >= m.min_size.0 && part > D::ZERO {
                    part.rescale(step.scale());
                    size = part;
                }
            }
            let mut order = market_order(market, closing(position.side), Decimal(size), true);
            if let Some(price) = price {
                order.kind = OrderKind::Limit {
                    price: dec(price)?,
                    time_in_force: None,
                };
            }
            Action::Orders(vec![order])
        }
        Intent::Close { market } => {
            let position = position_of(market)?;
            let size = position.size.ok_or("the position's size isn't known")?;
            Action::Orders(vec![market_order(
                market,
                closing(position.side),
                Decimal(size.0.abs()),
                true,
            )])
        }
        Intent::Protect {
            market,
            exit,
            price,
        } => {
            let change = match price {
                Some(price) => ExitChange::Set(dec(price)?),
                None => ExitChange::Remove,
            };
            let mut protection = PositionProtection {
                take_profit: ExitChange::Keep,
                stop_loss: ExitChange::Keep,
                trailing_stop: ExitChange::Keep,
                trailing_activation: None,
            };
            match exit {
                Exit::Tp => protection.take_profit = change,
                Exit::Sl => protection.stop_loss = change,
            }
            Action::Protect {
                market: market.clone(),
                protection,
            }
        }
        Intent::Cancel { orders, .. } => Action::Cancel(
            ctx.orders
                .iter()
                .filter(|o| orders.contains(&o.id))
                .cloned()
                .collect(),
        ),
        Intent::Chase {
            side,
            market,
            size,
            give_up_pct,
            finish,
        } => {
            // Percent to basis points: 0.5% is 50.
            let give_up_bps = give_up_pct
                .as_deref()
                .map(dec)
                .transpose()?
                .and_then(|pct| (pct.0 * D::ONE_HUNDRED).round().to_u32());
            Action::Algo(Box::new(AlgoSpec {
                venue: who.venue,
                account: who.account.clone(),
                market: market.clone(),
                side: *side,
                size: dec(size)?,
                reduce_only: false,
                max_slippage_bps: who.max_slippage_bps,
                prefer_native: true,
                kind: AlgoKind::Chaser {
                    post_only: true,
                    give_up_bps,
                    finish_at_market: *finish,
                },
            }))
        }
        Intent::Twap {
            side,
            market,
            size,
            duration_ms,
            slices,
            chase,
        } => Action::Algo(Box::new(AlgoSpec {
            venue: who.venue,
            account: who.account.clone(),
            market: market.clone(),
            side: *side,
            size: dec(size)?,
            reduce_only: false,
            max_slippage_bps: who.max_slippage_bps,
            prefer_native: true,
            kind: AlgoKind::Twap {
                duration_ms: *duration_ms,
                slices: slices.unwrap_or_else(|| default_slices(*duration_ms)),
                randomize: true,
                style: if *chase {
                    SliceStyle::Chaser
                } else {
                    SliceStyle::Market
                },
                unfilled: Unfilled::Market,
            },
        })),
        Intent::Halt => Action::Halt,
    })
}
