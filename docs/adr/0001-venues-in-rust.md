# 0001 — Venue adapters run in Rust, with trade-only keys

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

Before this decision, the TypeScript exchange packages were going to sign.
`get_secret` hands the raw key to the webview, and each venue would have a
`signing.ts` built on viem, cosmjs or @solana/web3.js. Only the CSP protected
the key: `connect-src` allows `'self'` and IPC alone, so an injected script
can read the key but can't send it anywhere. That is one layer of defense,
and it fails silently the first time someone widens `connect-src`. It would
also put every key in the same process as the dYdX and Drift JS SDKs, whose
dependency trees are large.

We first considered moving only signing into Rust and keeping protocol logic
in TS. That split describes each venue twice. Rust has to build the payload
it signs, so it needs asset indices, nonces and order encoding, and the TS
adapter needs the same knowledge to create requests and parse responses. Two
copies of a venue in two languages drift apart, and the kind of drift that
matters here produces a valid signature for the wrong action.

## Decision

**1. Venue adapters are Rust crates.** Each venue is
`crates/exchange-<venue>` and implements the `ExchangeAdapter` trait from
`crates/core`. The adapter owns everything about its venue: REST/WS/RPC
traffic, parsing, state and signing. The frontend is TypeScript and React,
and it reaches venues only through Tauri commands and events.

**2. Rust owns the domain types.** `crates/core` defines them, and ts-rs
generates the TypeScript copies into `packages/core/src/generated/`. The
TypeScript is generated, never written by hand, so the two sides can't
disagree about the wire format. Prices and sizes are decimal strings, and
Rust rejects JSON numbers.

**3. Key material never leaves Rust.** Adapters get keys through the
`KeySource` trait. `core` defines it and the desktop app implements it on
top of the OS keychain. Keys come back as `Zeroizing<String>` and are held
only for the signing call. JS can store a key and check that it exists, but
never read it back.

**4. The adapter surface is the whole signing surface.** `ExchangeAdapter`
can place and cancel orders and nothing else. It has no withdraw, transfer
or key-approval method, and no way to sign caller-supplied bytes. Anything
that can drive the adapters, including a script injected into the webview,
can therefore place and cancel orders with a trade-only key and do nothing
more. Adding to that surface is a security-sensitive change.

**5. Store a trade-only key wherever the venue has one.** Onboarding has the
user approve a delegated key from their main wallet once, and pewterdesk
stores only that delegated key:

| Venue       | Mechanism                             |
| ----------- | ------------------------------------- |
| Hyperliquid | API / agent wallet                    |
| GMX         | v2 subaccount (one-click trading)     |
| dYdX v4     | permissioned key                      |
| Drift       | delegate account                      |

A complete compromise of the app then costs, at worst, bad trades. It does not
cost withdrawals.

## Consequences

- Most of the code is now Rust, and changes to it iterate more slowly than
  TS. Each venue has a Rust library to build on or check against:
  `hyperliquid-rust-sdk`, alloy (EIP-712 and GMX contract calls),
  `v4-client-rs` for dYdX, and `drift-rs` for Drift.
- Each venue crate talks only to its own hosts and to explicitly configured
  RPC endpoints. The webview needs no network access, so the CSP's
  `connect-src` stays `'self'` plus IPC permanently.
- Signing is tested in Rust against known vectors from each venue's official
  SDK. One passing end-to-end order is not enough.
- The dYdX and Drift JS SDKs stay out of the webview entirely.
- `get_secret` has no legitimate caller in JS any more. It stays registered
  only until the first adapter's `KeySource` implementation lands, and that
  PR removes the command and `withSecret`. `SecretStore` shrinks to
  write/check/delete.
- The web app (v2) can't reuse Rust adapters as they are. It will need a
  WASM build of the venue crates or its own implementation, plus a
  browser-wallet signer. It was already deferred and already needed a proxy
  for CORS.
- The Tauri command surface has to be reviewed like a public API. It exposes
  the adapter operations and nothing that signs arbitrary input.

## Alternatives considered

- **Adapters and signing in TS.** This keeps the stack in TypeScript and
  lets us use each venue's official JS SDK. We rejected it because keys sit
  in webview memory on every order, and the only protection is the CSP.
- **Signing in Rust, protocol logic in TS.** This keeps keys out of JS with
  less Rust. We rejected it because every venue is described twice, in two
  languages that have to stay in lockstep for signatures to be correct.
- **A generic `sign_typed_data` command in Rust.** This is the easiest to
  write. We rejected it because it signs whatever an injected script asks
  for, including withdrawals.
