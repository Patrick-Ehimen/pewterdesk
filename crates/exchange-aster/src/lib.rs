//! Aster adapter (Aster Chain, an order-book perp L1; deposits bridge in from
//! BNB Chain, Ethereum, Arbitrum and Solana). Reads come from the Futures v3
//! REST and WebSocket APIs; every private request is EIP-712 typed data signed
//! by an Aster API wallet. That API wallet is the trade-only key, but only when
//! created without withdraw permission: onboarding must check `canWithdraw` is
//! off before storing it. Not yet implemented — see
//! docs/adr/0002-launch-venues.md.
