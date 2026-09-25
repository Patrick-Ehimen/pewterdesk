---
description: Scaffold a new packages/exchange-<venue> package following the exchange-hyperliquid pattern
---

Scaffold a new exchange adapter package for the venue named in $ARGUMENTS
(e.g. `/add-exchange-adapter dydx` → `packages/exchange-dydx`).

Before writing anything, read `packages/exchange-hyperliquid` in full — it's
the reference pattern, and this new package should mirror its shape exactly,
not reinvent it:

- `package.json` — name `@pewterdesk/exchange-<venue>`, depends on
  `@pewterdesk/core` (workspace:*). No signing or crypto libraries (viem,
  cosmjs, @solana/web3.js, venue SDKs): signing happens in Rust, per
  `docs/adr/0001-sign-in-rust.md`.
- `tsconfig.json` — extends the root `tsconfig.base.json`. No `references`
  (CLAUDE.md explains why).
- `src/constants.ts` — the venue's REST/WS URLs (mainnet + testnet if it has one)
- `src/client.ts` — a class implementing `ExchangeAdapter` from
  `@pewterdesk/core`, constructed with a `Signer` (never a `SecretStore` or a
  key). Match every method on the interface exactly. Stub each with
  `throw new Error("not implemented")` — do NOT write real implementations
  unless the user explicitly asks for that in this same request. The goal
  here is the scaffold, not the client.
- `src/index.ts` — re-exports from `client.ts` and `constants.ts`

There is no `signing.ts`. The venue's signer is a separate Rust module,
`apps/desktop/src-tauri/src/signing/<venue>.rs`, and it's security-sensitive
work that gets its own task and review. Don't create it as part of the
scaffold. If the venue needs a `SignRequest` variant that `core` doesn't
define yet, flag it (see below).

After scaffolding, run `pnpm install` and `pnpm --filter @pewterdesk/exchange-<venue> run typecheck`
to confirm it resolves and compiles before considering the task done.

Do not modify `packages/core`'s `ExchangeAdapter` interface as part of this
task — if the new venue needs something the interface doesn't support, stop
and flag that as a separate decision rather than changing the shared contract
inline.
