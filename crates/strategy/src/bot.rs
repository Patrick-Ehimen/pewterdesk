//! A bot as the engine keeps it: which strategy, on which account and
//! market, its limits, and where it is on its way from paper to live.
//! Types only: the engine's bot host runs them.

use pewterdesk_core::{CandleInterval, VenueId};
use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::sim::Asked;
use crate::{StrategyConfig, TS_FILE};

/// Paper trading lasts this long before a bot may go live.
pub const PAPER_DAYS: u64 = 7;
pub const DAY_MS: u64 = 86_400_000;

/// A bot's own limits, on top of the account's trading rules. Hitting one
/// stops the bot (and flattens it, with `flatten_on_stop`); it never waits
/// and tries again.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export_to = TS_FILE)]
pub struct BotLimits {
    /// The largest position, as its notional in the quote asset.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub max_position: Option<f64>,
    /// The most it may lose in a UTC day, in the quote asset.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub daily_loss: Option<f64>,
    /// The most orders it may send in a minute (a loop's guard).
    pub orders_per_minute: u32,
    /// The UTC hours it may open positions in, from and to (to excluded).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub hours: Option<(u8, u8)>,
    /// On a limit, close the position too, not only stop.
    pub flatten_on_stop: bool,
}

impl Default for BotLimits {
    fn default() -> Self {
        Self {
            max_position: None,
            daily_loss: None,
            orders_per_minute: 20,
            hours: None,
            flatten_on_stop: true,
        }
    }
}

/// What a bot is.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export_to = TS_FILE)]
pub struct BotSpec {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub name: Option<String>,
    pub venue: VenueId,
    /// The account it trades live (as the app names it); paper needs none
    /// to be connected, but it's the one it will go live on.
    pub account: String,
    pub market: String,
    pub interval: CandleInterval,
    pub strategy: StrategyConfig,
    pub limits: BotLimits,
    /// The paper account's starting balance, in the quote asset.
    pub paper_capital: f64,
    /// The bound on its market orders, in basis points.
    #[serde(default = "default_slippage")]
    pub max_slippage_bps: u32,
}

fn default_slippage() -> u32 {
    500
}

/// The venue's fees, for paper trading: taker and maker, per side (the
/// app's `VENUES[venue].fees`), with a few basis points of slippage.
pub fn paper_costs(venue: VenueId, capital: f64) -> crate::sim::Costs {
    let (taker, maker) = match venue {
        VenueId::Bybit => (0.00055, 0.0002),
        VenueId::Hyperliquid => (0.00045, 0.00015),
        VenueId::Aster => (0.00035, 0.0001),
    };
    crate::sim::Costs {
        capital,
        fee: taker,
        maker_fee: Some(maker),
        slippage_bps: 5.0,
        funding_8h: 0.00005,
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export_to = TS_FILE)]
pub enum BotMode {
    /// Simulated fills on live candles (the backtester's fill model).
    Paper,
    /// Real orders, through the engine's router and gate.
    Live,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export_to = TS_FILE)]
pub enum BotStatus {
    Running,
    Paused,
    /// Stopped by the trader.
    Stopped,
    /// Stopped by one of its limits, or by its strategy (a grid's range left).
    Limit,
    /// Stopped by something going wrong (a refusal, data it couldn't read).
    Failed,
}

impl BotStatus {
    pub fn running(self) -> bool {
        self == BotStatus::Running
    }
}

/// A bot as the page and `pd` show it.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export_to = TS_FILE)]
pub struct BotView {
    pub id: String,
    pub spec: BotSpec,
    pub mode: BotMode,
    pub status: BotStatus,
    /// Why it stopped or paused, in the engine's words ("dailyLoss",
    /// "stopOut", "refused: ...").
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub reason: Option<String>,
    #[ts(type = "number")]
    pub created_at: u64,
    /// When its paper run began; it may go live `PAPER_DAYS` after.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional, type = "number")]
    pub paper_since: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional, type = "number")]
    pub live_since: Option<u64>,
    /// Its position on the market, in base units: above zero long.
    pub position: f64,
    pub entry: f64,
    /// P&L since the start of today (UTC), and since it started this mode.
    pub pnl_today: f64,
    pub pnl_total: f64,
    /// Equity of its paper account; for a live bot, the account's.
    pub equity: f64,
    pub trades: u32,
    /// Candles seen in this mode.
    pub candles: u32,
    /// What it last asked for.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub last: Option<Asked>,
}

impl BotView {
    /// Whether its paper run has been long enough to go live, at `now`.
    pub fn ready_for_live(&self, now: u64) -> bool {
        self.paper_since
            .is_some_and(|since| now >= since + PAPER_DAYS * DAY_MS)
    }
}
