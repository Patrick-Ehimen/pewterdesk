//! How `pd` puts things for a person: what a line would send, orders,
//! algos, the account.

use pewterdesk_core::{
    AccountSnapshot, AlgoKind, AlgoView, ExitChange, Order, OrderKind, OrderRequest, PositionSide,
    RunsOn, Side, SliceStyle, VenueId,
};
use pewterdesk_protocol::action::Action;
use pewterdesk_protocol::rpc::Status;

pub fn venue(venue: VenueId) -> &'static str {
    match venue {
        VenueId::Hyperliquid => "Hyperliquid",
        VenueId::Aster => "Aster",
        VenueId::Bybit => "Bybit",
    }
}

fn side(side: Side) -> &'static str {
    match side {
        Side::Buy => "buy",
        Side::Sell => "sell",
    }
}

pub fn side_word(side: PositionSide) -> &'static str {
    match side {
        PositionSide::Long => "long",
        PositionSide::Short => "short",
    }
}

/// A bound in basis points as a percentage: 500 is "5.00%".
pub fn bps(bps: u32) -> String {
    format!("{}.{:02}%", bps / 100, bps % 100)
}

fn minutes(ms: u64) -> String {
    let m = ms / 60_000;
    let s = (ms % 60_000) / 1000;
    match (m / 60, m % 60, s) {
        (0, 0, s) => format!("{s}s"),
        (0, m, 0) => format!("{m}m"),
        (0, m, s) => format!("{m}m{s}s"),
        (h, 0, _) => format!("{h}h"),
        (h, m, _) => format!("{h}h{m}m"),
    }
}

/// A time as UTC, to the minute.
pub fn time(ms: u64) -> String {
    let secs = (ms / 1000) as i64;
    let days = secs.div_euclid(86_400);
    let rem = secs.rem_euclid(86_400);
    // Days since 1970-01-01 to a civil date.
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = yoe + era * 400 + i64::from(m <= 2);
    format!(
        "{y}-{m:02}-{d:02} {:02}:{:02} UTC",
        rem / 3600,
        (rem % 3600) / 60
    )
}

fn request(r: &OrderRequest) -> String {
    let mut text = format!("{} {} {}", side(r.side), r.size.0, r.market);
    match &r.kind {
        OrderKind::Market { max_slippage_bps } => {
            text += &format!(" at market, within {}", bps(*max_slippage_bps));
        }
        OrderKind::Limit { price, .. } => text += &format!(" at {} (limit)", price.0),
        OrderKind::Trigger { trigger_price, .. } => {
            text += &format!(" when {} trades", trigger_price.0)
        }
        OrderKind::Twap { minutes: m, .. } => text += &format!(" over {m}m (the venue's TWAP)"),
    }
    if r.reduce_only {
        text += ", reduce-only";
    }
    if let Some(sl) = r.stop_loss {
        text += &format!(", stop-loss {}", sl.0);
    }
    if let Some(tp) = r.take_profit {
        text += &format!(", take-profit {}", tp.0);
    }
    text
}

fn exit_change(name: &str, change: &ExitChange) -> Option<String> {
    match change {
        ExitChange::Keep => None,
        ExitChange::Remove => Some(format!("remove the {name}")),
        ExitChange::Set(price) => Some(format!("set the {name} at {}", price.0)),
    }
}

/// What an action would send, a line each.
pub fn action(action: &Action) -> Vec<String> {
    match action {
        Action::Orders(orders) => orders.iter().map(request).collect(),
        Action::Cancel(orders) => orders
            .iter()
            .map(|o| format!("cancel order {} on {}", o.id, o.market))
            .collect(),
        Action::Protect { market, protection } => [
            exit_change("take-profit", &protection.take_profit),
            exit_change("stop-loss", &protection.stop_loss),
        ]
        .into_iter()
        .flatten()
        .map(|change| format!("{change} on {market}"))
        .collect(),
        Action::Algo(spec) => vec![match &spec.kind {
            AlgoKind::Chaser {
                give_up_bps,
                finish_at_market,
                ..
            } => {
                let mut text = format!("chase {} {} {}", side(spec.side), spec.size.0, spec.market);
                if let Some(give_up) = give_up_bps {
                    text += &format!(", giving up {} away", bps(*give_up));
                    if *finish_at_market {
                        text += ", then the rest at market";
                    }
                }
                text
            }
            AlgoKind::Twap {
                duration_ms,
                slices,
                style,
                ..
            } => format!(
                "TWAP {} {} {} over {} in {slices} slices{} (on the venue where it can, else on the daemon)",
                side(spec.side),
                spec.size.0,
                spec.market,
                minutes(*duration_ms),
                if *style == SliceStyle::Chaser { ", each chased" } else { "" }
            ),
            AlgoKind::Scaled { from, to, count, .. } => format!(
                "ladder {} {} {} from {} to {} in {count}",
                side(spec.side),
                spec.size.0,
                spec.market,
                from.0,
                to.0
            ),
        }],
        Action::Halt => vec!["stop every algo and cancel what they placed".into()],
    }
}

pub fn order(o: &Order) -> String {
    let price = o.price.map(|p| format!(" at {}", p.0)).unwrap_or_default();
    format!(
        "{} {} {} {}{price} [{:?}] id {}",
        side(o.side),
        o.size.0,
        o.market,
        format!("{:?}", o.order_type).to_lowercase(),
        o.status,
        o.id
    )
}

pub fn algo(a: &AlgoView) -> String {
    let kind = match a.spec.kind {
        AlgoKind::Chaser { .. } => "chaser",
        AlgoKind::Twap { .. } => "twap",
        AlgoKind::Scaled { .. } => "ladder",
    };
    let at = match a.runs_on {
        RunsOn::Venue => "on the venue",
        RunsOn::Local => "on the daemon",
    };
    let reason = a
        .reason
        .as_deref()
        .map(|r| format!(" ({r})"))
        .unwrap_or_default();
    format!(
        "{}  {kind} {} {} {}  {:?}{reason}  filled {} of {}  {at}",
        a.id,
        side(a.spec.side),
        a.spec.size.0,
        a.spec.market,
        a.status,
        a.filled.0,
        a.spec.size.0
    )
}

pub fn status(s: &Status) -> String {
    let text = format!(
        "pdd {} (protocol {}), up since {}\n\
         event log: {}\n\
         algos running: {}\n\
         accounts held: {}",
        s.version,
        s.protocol,
        time(s.started_at),
        if s.log_open {
            "open"
        } else {
            "NOT open - no opening order is sent"
        },
        s.algos_running,
        if s.accounts.is_empty() {
            "none yet".into()
        } else {
            s.accounts.join(", ")
        }
    );
    println!("{text}");
    text
}

pub fn account(what: &str, a: &AccountSnapshot) {
    match what {
        "balance" => println!("equity {}  available {}", a.equity.0, a.available_margin.0),
        "positions" => {
            if a.positions.is_empty() {
                println!("no open positions");
            }
            for p in &a.positions {
                println!(
                    "{:<14} {:<5} {:>12}  entry {}  mark {}  uPnL {}",
                    p.market,
                    side_word(p.side),
                    p.size.0,
                    p.entry_price.0,
                    p.mark_price.0,
                    p.unrealized_pnl.0
                );
            }
        }
        _ => {
            if a.open_orders.is_empty() {
                println!("no open orders");
            }
            for o in &a.open_orders {
                println!("{}", order(o));
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn words_bounds_and_times() {
        assert_eq!(bps(500), "5.00%");
        assert_eq!(bps(50), "0.50%");
        assert_eq!(minutes(1_800_000), "30m");
        assert_eq!(minutes(5_400_000), "1h30m");
        assert_eq!(minutes(45_000), "45s");
        assert_eq!(time(0), "1970-01-01 00:00 UTC");
        assert_eq!(time(1_791_981_000_000), "2026-10-14 12:30 UTC");
    }
}
