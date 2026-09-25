//! dYdX v4 adapter. Reads come from the indexer; orders are Cosmos SDK
//! transactions to the validators, with short-term vs stateful orders and
//! block-height expiry. The trade-only key is a dYdX permissioned key. Not yet
//! implemented — see docs/adr/0001-venues-in-rust.md.
