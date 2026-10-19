//! `pewterdesk-protocol`: what a client may ask the engine, and the command
//! language lines are typed in. The daemon (`pdd`) serves it, `pd` and the
//! app speak it; it holds types, parsing and where things live on this
//! machine (`local`), no I/O.
//!
//! Security-relevant (`docs/bots/safety.md`): it defines what a client can
//! ask for. Review any change against `.claude/commands/security-review.md`.

pub mod action;
pub mod command;
pub mod local;
pub mod rpc;

pub use command::{parse_command, parse_line, CommandContext, Intent, Line};
pub use rpc::{Call, Event, Id, Request, Response, RpcError, PROTOCOL_VERSION};
