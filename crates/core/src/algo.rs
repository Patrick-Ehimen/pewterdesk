//! Algo orders: orders the engine manages over time instead of sending once
//! (a chaser, a TWAP, a scaled ladder). What the page asks for (`AlgoSpec`)
//! and what it's shown (`AlgoView`). Every order an algo sends goes through
//! the engine's router and its gate, like any other.

use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::{Decimal, Origin, Side, VenueId};

const TS_FILE: &str = "domain.ts";

/// How a TWAP slice is sent.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = TS_FILE)]
pub enum SliceStyle {
    /// At market, as an IOC limit at the slippage bound.
    Market,
    /// Chased at the top of the book for the slice's window.
    Chaser,
}

/// What a TWAP does with a chased slice still unfilled when its window ends.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = TS_FILE)]
pub enum Unfilled {
    /// Send the rest at market.
    Market,
    /// Leave it, and go on to the next slice.
    Skip,
    /// Stop the TWAP.
    Stop,
}

/// How a scaled ladder spreads its size over its prices.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = TS_FILE)]
pub enum Distribution {
    /// The same size at every price.
    Flat,
    /// More at the far end (`to`).
    MoreFar,
    /// More at the near end (`from`).
    MoreNear,
}

/// Which algo, with its own settings.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, TS)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
#[ts(export, export_to = TS_FILE)]
pub enum AlgoKind {
    /// A limit order resting at the best bid (buy) or ask (sell), moved with
    /// the top of the book until it fills.
    Chaser {
        /// Only ever rest (a maker order); on by default.
        post_only: bool,
        /// Give up once the price is this far from where it started, in
        /// basis points; unset to chase without a limit.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        give_up_bps: Option<u32>,
        /// On giving up, send what's left at market rather than stop.
        finish_at_market: bool,
    },
    /// The size in equal slices over a time.
    Twap {
        #[ts(type = "number")]
        duration_ms: u64,
        slices: u32,
        /// Spread the slices' times a little, so they're harder to spot.
        randomize: bool,
        style: SliceStyle,
        unfilled: Unfilled,
    },
    /// Limit orders across a price range, placed at once and tracked as one.
    Scaled {
        /// The near end of the range.
        from: Decimal,
        /// The far end.
        to: Decimal,
        count: u32,
        distribution: Distribution,
        post_only: bool,
    },
}

/// An algo as the page starts it.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = TS_FILE)]
pub struct AlgoSpec {
    pub venue: VenueId,
    /// The account, as the trading commands name it.
    pub account: String,
    /// `Market::id`.
    pub market: String,
    pub side: Side,
    /// In base units.
    pub size: Decimal,
    pub reduce_only: bool,
    /// The bound for anything it sends at market, in basis points.
    pub max_slippage_bps: u32,
    /// Use the venue's own version where it has one (it keeps running while
    /// this machine sleeps). On unless the page says otherwise.
    #[serde(default = "yes")]
    pub prefer_native: bool,
    #[serde(flatten)]
    #[ts(flatten)]
    pub kind: AlgoKind,
}

fn yes() -> bool {
    true
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = TS_FILE)]
pub enum AlgoStatus {
    Running,
    Paused,
    /// Done: the size filled, or the ladder is gone.
    Finished,
    /// Stopped by the trader, a halt, a give-up, or the app closing.
    Stopped,
    Failed,
}

impl AlgoStatus {
    /// Whether it's over (nothing more will be sent).
    pub fn is_over(self) -> bool {
        matches!(self, Self::Finished | Self::Stopped | Self::Failed)
    }
}

/// How to stop an algo.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = TS_FILE)]
pub enum StopMode {
    /// Cancel what it has open, and leave the rest unfilled.
    Cancel,
    /// Cancel what it has open, then send the rest at market.
    FinishAtMarket,
}

/// Where an algo runs.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = TS_FILE)]
pub enum RunsOn {
    /// The venue runs it: it carries on while this machine sleeps.
    Venue,
    /// This machine runs it: it stops when the app does.
    Local,
}

/// An algo as the page shows it.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = TS_FILE)]
pub struct AlgoView {
    pub id: String,
    pub spec: AlgoSpec,
    pub origin: Origin,
    pub status: AlgoStatus,
    /// Why it's paused, stopped or failed: a code the page puts into words
    /// (`stale`, `disconnected`, `refused`, `venueError`, `gaveUp`, `halted`,
    /// `appClosed`, `user`, `unfilled`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub reason: Option<String>,
    /// The venue's or the gate's own words, where there are some.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub detail: Option<String>,
    pub runs_on: RunsOn,
    /// Filled so far, in base units.
    pub filled: Decimal,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub avg_price: Option<Decimal>,
    /// Fees paid on its fills so far, in the quote asset (negative for a
    /// rebate).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub fees: Option<Decimal>,
    /// The price when it started (mid of the book), for slippage.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub start_price: Option<Decimal>,
    /// Its orders open on the venue now.
    pub open_orders: u32,
    /// Milliseconds since the Unix epoch.
    #[ts(type = "number")]
    pub started_at: u64,
    /// When it's due to end (a TWAP).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(type = "number | undefined", optional)]
    pub ends_at: Option<u64>,
    /// When it next sends something (a TWAP's next slice).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(type = "number | undefined", optional)]
    pub next_at: Option<u64>,
    #[ts(type = "number")]
    pub updated_at: u64,
}
