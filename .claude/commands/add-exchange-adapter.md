---
description: Scaffold a new crates/exchange-<venue> Rust crate following the exchange-hyperliquid pattern
---

Scaffold a new venue adapter crate for the venue named in $ARGUMENTS
(e.g. `/add-exchange-adapter aevo` → `crates/exchange-aevo`). Venue adapters
are Rust, per `docs/adr/0001-venues-in-rust.md`.

Before writing anything, read `crates/exchange-hyperliquid` and `crates/core`
in full — the first is the reference pattern, the second the contract. Mirror
their shape exactly rather than reinventing it:

- `Cargo.toml` — package `pewterdesk-exchange-<venue>`, `edition.workspace`
  and `rust-version.workspace`, `publish = false`, depends on
  `pewterdesk-core = { path = "../core" }`. The root workspace picks up
  `crates/*` automatically.
- `src/constants.rs` — the venue's REST/WS (and RPC, if any) endpoints,
  mainnet + testnet if it has one. Check them against the venue's docs; don't
  write them from memory.
- `src/lib.rs` — a doc comment covering the venue's chain, execution model
  (order book or not, whether orders come back `Pending`) and its trade-only
  key mechanism, plus a struct implementing `ExchangeAdapter` that takes a
  `KeySource` (an `Arc<dyn KeySource>`) in its constructor and never
  constructs one. Implement every required method as
  `Err(VenueError::Unsupported("not implemented"))`, and leave the order-book
  defaults alone if the venue has none. Do NOT write real implementations
  unless the user explicitly asks for that in this same request.

Don't write signing code as part of the scaffold. It's security-sensitive and
gets its own task, reviewed against `.claude/commands/security-review.md`.

After scaffolding, run `cargo clippy -p pewterdesk-exchange-<venue> -- -D warnings`
to confirm it compiles cleanly before considering the task done.

Do not modify `crates/core` (the `ExchangeAdapter` trait or the domain types)
as part of this task. If the new venue needs something the contract doesn't
support, stop and flag it as a separate decision rather than changing the
shared contract inline.
