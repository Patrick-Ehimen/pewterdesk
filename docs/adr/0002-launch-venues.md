# 0002 - Launch with Hyperliquid and Aster only

- Status: accepted
- Date: 2026-09-28
- Amends: [0001](0001-venues-in-rust.md) (the venue list and tables only)

## Context

ADR 0001 named four launch venues: Hyperliquid, GMX, dYdX v4 and Drift. Only
Hyperliquid had any code. The GMX, dYdX and Drift crates were empty stubs.

## Decision

**Launch with two venues: Hyperliquid and Aster.** dYdX v4 is replaced by
Aster. GMX and Drift are dropped for now, not ruled out. Either can come back
later as a new crate and a new `VenueId` variant.

- `crates/exchange-dydx` becomes `crates/exchange-aster`.
- `crates/exchange-gmx` and `crates/exchange-drift` are deleted.
- `VenueId` is `Hyperliquid | Aster` (wire values `"hyperliquid"`, `"aster"`).

With this change, ADR 0001's tables read:

| Venue       | Chain                | Signing                                  | Key       |
| ----------- | -------------------- | ---------------------------------------- | --------- |
| Hyperliquid | own L1               | EIP-712 over a msgpack action hash       | secp256k1 |
| Aster       | Aster Chain (own L1) | EIP-712 typed data over each API request | secp256k1 |

| Venue       | Trade-only key                                        |
| ----------- | ----------------------------------------------------- |
| Hyperliquid | API / agent wallet                                    |
| Aster       | API wallet, created with withdraw permission disabled |

Aster settles on its own order-book L1. Users deposit from BNB Chain,
Ethereum, Arbitrum or Solana. The adapter talks to Aster's Futures v3 API
(`fapi.asterdex.com` for REST, `fstream.asterdex.com` for WebSocket), where
every private request carries a nonce and an EIP-712 signature from an API
wallet that the main wallet approved.

## Consequences

- **Aster's API wallet is not trade-only by construction.** A Hyperliquid
  agent wallet can't withdraw at all. An Aster API wallet has per-wallet
  permissions (perp trading, spot trading, withdraw) that the user sets when
  creating it. ADR 0001's promise that a full compromise costs at worst bad
  trades holds for Aster only if withdraw is off. Onboarding must therefore
  read the API wallet's permissions and refuse to store a key that can
  withdraw, and the adapter should re-check before signing. This check is
  security-sensitive code, the same as the signer.
- Both venues sign EIP-712 with secp256k1 keys, so one stack (alloy) covers
  all signing. The Cosmos SDK and Solana stacks, `v4-client-rs` and
  `drift-rs`, aren't needed. Test each signer against vectors from the
  venue's official SDK or connectors, per ADR 0001.
- Both venues are order books that accept orders immediately. The domain
  types still carry what pool- and keeper-based venues need (the `Pending`
  order status, per-position `collateral`, the `order_book` capability), so a
  venue like GMX can return without changing the wire format.
- Aster's REST API is Binance-style (`BTCUSDT` symbols, Binance-shaped
  responses). Market ids stay opaque outside the adapter, as with any venue.
- No Aster JS SDK goes in the webview, for the same reasons as ADR 0001.
