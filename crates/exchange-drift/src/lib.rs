//! Drift adapter (Solana). Orders are Solana transactions filled by keepers
//! and JIT makers, so market orders can come back `Pending` during their
//! auction. The trade-only key is a Drift delegate. Not yet implemented — see
//! docs/adr/0001-venues-in-rust.md.
