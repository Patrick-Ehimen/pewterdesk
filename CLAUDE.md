# pewterdesk

Non-custodial, multi-venue crypto derivatives trading terminal (desktop-first,
web later). No backend — talks directly to exchange APIs from the user's own
machine. Launch venues: Hyperliquid, GMX, dYdX v4 and Drift — all on-chain.
TypeScript throughout except the Tauri shell, which also owns all signing
(see `docs/adr/0001-sign-in-rust.md`).

## Architecture rule (read this before touching packages/)

`packages/core` defines the cross-cutting contracts, and nothing else may:

- `ExchangeAdapter` plus the domain types (`Order`, `Position`, `Market`,
  `OrderBook`, ...). Every exchange package (`packages/exchange-<venue>`)
  implements that interface and depends on `core` — never the other way around.
- `Signer` — what an adapter calls to get a typed venue action signed.
- `SecretStore` — where private key material lives, independent of venue.

`packages/ui` and the two `apps/*` depend on `core` for types but should never
import a specific exchange package directly; that's what makes adding a venue
a new adapter, not a rewrite of the UI.

`Signer` and `SecretStore` run the same direction: `core` owns the interface,
the app owns the implementation. Exchange adapters receive a `Signer`, they
never construct one, and they never see a `SecretStore` or a key. On desktop
the `Signer` is backed by typed Rust signing commands; on web (v2) it would be
a browser wallet. `SecretStore` is only for onboarding a key into the
keychain (`apps/desktop/src/secrets/tauriSecretStore.ts`); `apps/web` has no
implementation and is not meant to get one.

## Layout

- `packages/core` — exchange-agnostic types, the `ExchangeAdapter` and `Signer` interfaces, and the `SecretStore` contract
- `packages/exchange-hyperliquid` — Hyperliquid adapter (REST/WS protocol logic; signing is in Rust).
  `exchange-gmx`, `exchange-dydx` and `exchange-drift` follow the same pattern (not yet scaffolded)
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

Any change to the files below needs review against
`.claude/commands/security-review.md`, and an explicit callout in the PR
description under a "Security-relevant changes" heading — don't leave a reviewer to
discover it on their own. The reasoning behind the rules is in
`docs/adr/0001-sign-in-rust.md`.

- `apps/desktop/src-tauri/src/keychain.rs` — the OS keychain bridge, and the
  only place key material is stored. Keys never touch disk, env vars, or logs.
  Note that keyring's `BadEncoding` and `Ambiguous` error variants carry
  credential material, which is why keyring errors are mapped by hand rather
  than formatted into a string. `get_secret` still returns a key to JS; it is
  removed (with `withSecret`) in the PR that lands the first Rust signer, and
  nothing new may depend on it.
- `apps/desktop/src-tauri/src/signing/<venue>.rs` (not yet written) — what
  turns a key into a signed venue action. The highest-stakes code in the repo.
  Commands take typed parameters and build the payload themselves; never add
  one that signs caller-supplied bytes or typed data. Withdrawals, transfers
  and key approvals are unsupported or gated behind a native confirmation.
- Onboarding stores a venue's trade-only delegated key (Hyperliquid agent
  wallet, GMX subaccount, dYdX permissioned key, Drift delegate), not the
  user's main wallet key.

The webview CSP in `apps/desktop/src-tauri/tauri.conf.json` is part of this
surface, not cosmetic. `connect-src` allows only `'self'` and IPC. Don't widen
it — venue and RPC traffic goes through a Rust transport that allows only
each venue's hosts, and that allowlist is security-sensitive too.

## Status

Early scaffold. `packages/exchange-hyperliquid` and `packages/ui` are still
empty, and no Rust signer or transport exists yet.

What does work end to end: both apps build (`vite build`), and `apps/desktop`'s
Tauri shell runs with the keychain commands wired up. Secure key storage is the
only feature actually implemented. `.claude/prd-rust-desktop-features.md` has
the rest of the Rust-side backlog (notifications, tray, deep links, local
persistence), none of it started.

## Brand

UI colors come only from the `--pd-*` variables in `.claude/brand/pewterdesk-tokens.css`;
never hardcode hex. Brass is the sole accent and never means buy/sell/PnL; green and red
are market data only. Full rules and palette: `.claude/brand/BRAND.md`. Logos: `assets/`.

## Repo

Everything lives in this one repo (`Patrick-Ehimen/pewterdesk`); there are no
companion repos. CI and Dependabot config are in `.github/` here. The install
guide and security policy, once written, belong here too.
