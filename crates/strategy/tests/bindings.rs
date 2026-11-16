//! Writes the strategy types to `packages/core/src/generated/strategy.ts`
//! (`make rust-bindings`), each on its own, without its dependencies.

use pewterdesk_strategy::bot::{BotLimits, BotMode, BotSpec, BotStatus, BotView};
use pewterdesk_strategy::lab::{Axis, Cell, LabRun, Summary, Sweep};
use pewterdesk_strategy::sim::{Asked, Costs, RunResult, StoppedOut, Study, Trade};
use pewterdesk_strategy::{
    Bar, Compare, Cond, CoolOff, CustomParams, DcaParams, Direction, EmaParams, Funnel, GridParams,
    Group, Guards, Hours, Intent, Match, Reason, Rule, Sizing, Source, StopRule, StrategyConfig,
    Target, Trail,
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
    Match::export(&cfg).unwrap();
    Group::export(&cfg).unwrap();
    Cond::export(&cfg).unwrap();
    Sizing::export(&cfg).unwrap();
    StopRule::export(&cfg).unwrap();
    Trail::export(&cfg).unwrap();
    Target::export(&cfg).unwrap();
    CoolOff::export(&cfg).unwrap();
    Guards::export(&cfg).unwrap();
    Hours::export(&cfg).unwrap();
    Funnel::export(&cfg).unwrap();
    Study::export(&cfg).unwrap();
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
    LabRun::export(&cfg).unwrap();
    Axis::export(&cfg).unwrap();
    Sweep::export(&cfg).unwrap();
    Summary::export(&cfg).unwrap();
    Cell::export(&cfg).unwrap();
}
