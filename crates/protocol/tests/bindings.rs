//! Writes the protocol's TS types to `packages/core/src/generated/protocol.ts`
//! (`make rust-bindings`). Each on its own, without its dependencies: those
//! live in `domain.ts`, which `crates/core` writes.

use pewterdesk_protocol::command::{
    CommandContext, Exit, Intent, Line, Missing, OpenOrder, OpenPosition,
};
use ts_rs::{Config, TS};

#[test]
fn export_bindings() {
    // TS_RS_EXPORT_DIR, from .cargo/config.toml.
    let cfg = Config::from_env();
    CommandContext::export(&cfg).unwrap();
    OpenPosition::export(&cfg).unwrap();
    OpenOrder::export(&cfg).unwrap();
    Exit::export(&cfg).unwrap();
    Intent::export(&cfg).unwrap();
    Line::export(&cfg).unwrap();
    Missing::export(&cfg).unwrap();
}
