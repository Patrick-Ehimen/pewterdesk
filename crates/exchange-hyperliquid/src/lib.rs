//! Hyperliquid adapter. The `ExchangeAdapter` implementation and its signer
//! (EIP-712 over the msgpack action hash, with an API/agent wallet as the
//! trade-only key) land here next. The signer is security-sensitive — see
//! docs/adr/0001-venues-in-rust.md.

pub mod constants;
