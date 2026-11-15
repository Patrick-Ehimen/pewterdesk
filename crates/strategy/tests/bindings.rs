//! Writes the strategy types to `packages/core/src/generated/strategy.ts`
//! (`make rust-bindings`), each on its own, without its dependencies.

use pewterdesk_strategy::bot::{BotLimits, BotMode, BotSpec, BotStatus, BotView};
use pewterdesk_strategy::sim::{Asked, Costs, RunResult, StoppedOut, Trade};
use pewterdesk_strategy::{
    Bar, Compare, CustomParams, DcaParams, Direction, EmaParams, GridParams, Intent, Reason, Rule,
    Source, StrategyConfig,
};
use ts_rs::{Config, TS};

#[test]
fn export_bindings() {
    let cfg = Config::from_env();
    Bar::export(&cfg).unwrap();
    Reason::export(&cfg).unwrap();
    Intent::export(&cfg).unwrap();
    Direction::export(&cfg).unwrap();
    EmaParams::export(&cfg).unwrap();
    GridParams::export(&cfg).unwrap();
    DcaParams::export(&cfg).unwrap();
    Source::export(&cfg).unwrap();
    Compare::export(&cfg).unwrap();
    Rule::export(&cfg).unwrap();
    CustomParams::export(&cfg).unwrap();
    StrategyConfig::export(&cfg).unwrap();
    Costs::export(&cfg).unwrap();
    Trade::export(&cfg).unwrap();
    Asked::export(&cfg).unwrap();
    StoppedOut::export(&cfg).unwrap();
    RunResult::export(&cfg).unwrap();
    BotLimits::export(&cfg).unwrap();
    BotSpec::export(&cfg).unwrap();
    BotMode::export(&cfg).unwrap();
    BotStatus::export(&cfg).unwrap();
    BotView::export(&cfg).unwrap();
}
