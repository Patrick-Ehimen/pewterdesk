# 0001 — Sign in Rust, with trade-only keys

- Status: accepted
- Date: 2026-09-25

## Context

pewterdesk launches with four on-chain venues: Hyperliquid, GMX, dYdX v4 and
Drift. They use four signing schemes across three key types:

| Venue       | Chain                | Signing                              | Key       |
| ----------- | -------------------- | ------------------------------------ | --------- |
| Hyperliquid | own L1               | EIP-712 over a msgpack action hash   | secp256k1 |
| GMX         | Arbitrum / Avalanche | EVM transactions (contract calls)    | secp256k1 |
| dYdX v4     | Cosmos app-chain     | Cosmos SDK transactions (protobuf)   | secp256k1 |
| Drift       | Solana               | Solana transactions                  | ed25519   |

Up to now, the plan was that JS would sign. `get_secret` hands the raw key to
the webview, and a per-venue `signing.ts` signs with viem, cosmjs or
@solana/web3.js. Only the CSP protected the key: `connect-src` allows `'self'`
and IPC alone, so an injected script can read the key but can't send it
anywhere. That is one layer of defense, and it fails silently the first time
someone widens `connect-src`. It also puts every key in the same process as
the dYdX and Drift JS SDKs, whose dependency trees are large.

## Decision

**1. Key material never leaves Rust.** Signing moves to
`apps/desktop/src-tauri/src/signing/<venue>.rs`. JS stops receiving
secrets. Keys can be written and checked from JS, but never read back.

**2. Rust signs only specific, typed actions.** It has no command that signs
arbitrary bytes or arbitrary typed data. Each command takes structured
parameters (place order, cancel, modify, set leverage), builds the venue
payload itself and signs that. With a generic "sign this" command, an injected
script could not steal the key, but it could still get Rust to sign a
withdrawal. Withdrawals, transfers and approving new keys either aren't
supported or need a native OS confirmation dialog that the webview can't
drive.

**3. Store a trade-only key wherever the venue has one.** Onboarding has the
user approve a delegated key from their main wallet once, and pewterdesk
stores only that delegated key:

| Venue       | Mechanism                             |
| ----------- | ------------------------------------- |
| Hyperliquid | API / agent wallet                    |
| GMX         | v2 subaccount (one-click trading)     |
| dYdX v4     | permissioned key                      |
| Drift       | delegate account                      |

A complete compromise of the app then costs, at worst, bad trades. It does not
cost withdrawals. This matters more than whether signing happens in Rust or
JS, and it is independent of that choice.

**4. Adapters depend on a `Signer`, not a `SecretStore`.** `core` defines
`Signer`. On desktop it is backed by the Rust signing commands. On web (v2),
where there is no keychain, it would be backed by a browser wallet. The
exchange adapters keep the protocol logic (request shapes, parsing, state,
the `ExchangeAdapter` surface) in TypeScript. They reach the network through a
Rust transport that only allows each venue's hosts, which the CSP already
requires.

## Consequences

- There is more Rust, and changes to it iterate more slowly than TS. Each
  venue has solid Rust support to build on or check against: alloy
  (Hyperliquid EIP-712 and GMX), `hyperliquid-rust-sdk` as a reference for
  action hashing, `v4-client-rs` for dYdX, and `drift-rs` for Drift.
- Signing has to be tested in Rust against known vectors from each venue's
  official SDK. One passing end-to-end order is not enough.
- The dYdX and Drift JS SDKs stay out of the webview.
- `SecretStore` shrinks to write/check/delete. Until the Rust signer exists,
  `get_secret` stays registered because nothing depends on its removal. It
  is deleted in the PR that brings in the first Rust signer, along with
  `withSecret`.
- The security-sensitive surface moves: `keychain.rs`, `signing/*.rs`, the
  transport's host allowlist, and the CSP.
- The Tauri command surface has to be reviewed like a public API. Any new
  command that touches keys has to meet point 2.

## Alternatives considered

- **Sign in JS.** This keeps the whole stack in TypeScript and lets us use
  each venue's official JS SDK directly. We rejected it because the key sits
  in webview memory on every order and the only protection is the CSP.
- **Sign in Rust behind a generic `sign_typed_data` command.** This is easier
  to write, and it still keeps the key out of JS. We rejected it because it
  signs whatever an injected script asks for.
