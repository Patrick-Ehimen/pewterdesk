# pewterdesk

Non-custodial, multi-venue crypto derivatives trading terminal (desktop-first,
web later). No backend — talks directly to exchange APIs from the user's own
machine. Hyperliquid at launch. TypeScript throughout except the Tauri shell.

## Architecture rule (read this before touching packages/)

`packages/core` defines the cross-cutting contracts, and nothing else may:

- `ExchangeAdapter` plus the domain types (`Order`, `Position`, `Market`,
  `OrderBook`, ...) — not written yet. Every exchange package
  (`packages/exchange-hyperliquid`, and any future venue) implements that
  interface and depends on `core` — never the other way around.
- `SecretStore` — where private key material lives, independent of venue.

`packages/ui` and the two `apps/*` depend on `core` for types but should never
import a specific exchange package directly; that's what makes adding a second
venue a new adapter, not a rewrite of the UI.

`SecretStore` runs the same direction: `core` owns the interface, the app owns
the implementation. `apps/desktop/src/secrets/tauriSecretStore.ts` wires it to
the Rust keychain commands; `apps/web` has no implementation and is not meant
to get one. Exchange adapters receive a `SecretStore`, they never construct one.

## Layout

- `packages/core` — exchange-agnostic types, the `ExchangeAdapter` interface (not yet written), and the `SecretStore` contract
- `packages/exchange-hyperliquid` — Hyperliquid adapter (REST/WS client, EIP-712 signing via viem)
- `packages/ui` — shared React components (order ticket, position table, chart wrapper, hotkeys)
- `apps/desktop` — the shipped app: Tauri (Rust shell + OS keychain bridge) and this workspace's React frontend
- `apps/web` — v2, deferred. Same frontend stack, but browser CORS means most
  exchanges need a thin proxy in front of this build; the desktop app doesn't,
  since Tauri's Rust side makes requests natively.

## Commands

Run `make` on its own for the full menu. The Makefile is a thin wrapper over
pnpm and cargo, so it can't drift from the underlying scripts.

- `make install` — resolve the workspace and enable the git hooks
- `make check` — what CI runs, in CI's order: lint, typecheck, test, build
- `make check-all` — `check` plus the Rust side, which CI does not cover yet
- `make dev` — run the desktop app in a native window (needs Rust)
- `make dev-ui` — desktop frontend in a browser only, no Rust
- `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml -- --ignored` —
  the keychain tests that touch the real OS store, skipped by default

Packages are consumed from source: every `package.json` points `main`/`types`
at `./src/index.ts`, and the tsconfigs deliberately carry no `references`.
Don't add them back. Project references redirect module resolution to
`packages/*/dist`, which `tsc --noEmit` then requires to already exist — and
both CI and `make check` typecheck before they build, so it fails on any clean
checkout the moment one package actually imports another. `dist/` is build
output; nothing imports it.

## Security-sensitive code — extra care here

Two files. Any change to either needs review against
`.claude/commands/security-review.md`, and an explicit callout in the PR
description (see the org's `.github` PR template) — don't leave a reviewer to
discover it on their own.

- `apps/desktop/src-tauri/src/keychain.rs` — the OS keychain bridge, and the
  only place key material is stored. `get_secret` is the sole path by which it
  reaches JS; on the TS side it goes through `withSecret` so it is never parked
  in component state. Keys never touch disk, env vars, or logs. Note that
  keyring's `BadEncoding` and `Ambiguous` error variants carry credential
  material, which is why keyring errors are mapped by hand rather than
  formatted into a string.
- `packages/exchange-hyperliquid/src/signing.ts` (not yet written) — what turns
  a private key into a signed exchange action. The highest-stakes file in the
  repo once it exists.

The webview CSP in `apps/desktop/src-tauri/tauri.conf.json` is part of this
surface, not cosmetic. `connect-src` allows only `'self'` and IPC, so a script
injected into the webview can still call `get_secret` but has nowhere to send
the result. Widening it so the frontend can reach an exchange directly gives
that protection back — prefer routing venue traffic through Rust.

## Status

Early scaffold. `ExchangeAdapter` and the domain types don't exist yet, and
`packages/exchange-hyperliquid` and `packages/ui` are still empty.

What does work end to end: both apps build (`vite build`), and `apps/desktop`'s
Tauri shell runs with the keychain commands wired up. Secure key storage is the
only feature actually implemented. `.claude/prd-rust-desktop-features.md` has
the rest of the Rust-side backlog (notifications, tray, deep links, local
persistence), none of it started.

## Related repos (same org)

- `.github` — org profile, issue/PR templates, shared CI workflow
- `pewterdesk-docs` — install guide, security policy (not yet created)
