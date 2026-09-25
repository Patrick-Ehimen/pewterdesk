//! GMX v2 adapter (Arbitrum, Avalanche). Orders are contract calls executed
//! later by keepers, so `place_order` returns `Pending`; there is no order
//! book, and positions take isolated collateral. The trade-only key is a GMX
//! subaccount. Not yet implemented — see docs/adr/0001-venues-in-rust.md.
