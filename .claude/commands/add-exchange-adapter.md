---
description: Scaffold a new packages/exchange-<venue> package following the exchange-hyperliquid pattern
---

Scaffold a new exchange adapter package for the venue named in $ARGUMENTS
(e.g. `/add-exchange-adapter dydx` → `packages/exchange-dydx`).

Before writing anything, read `packages/exchange-hyperliquid` in full — it's
the reference pattern, and this new package should mirror its shape exactly,
not reinvent it:

- `package.json` — name `@pewterdesk/exchange-<venue>`, depends on
  `@pewterdesk/core` (workspace:*), plus whatever signing/HTTP libs the venue
  actually needs
- `tsconfig.json` — extends the root `tsconfig.base.json`, references `../core`
- `src/constants.ts` — the venue's REST/WS URLs (mainnet + testnet if it has one)
- `src/signing.ts` — isolated signing logic ONLY, no networking or UI imports.
  If the venue doesn't need EIP-712 or a comparable signing scheme, say so
  explicitly rather than silently omitting the file.
- `src/client.ts` — a class implementing `ExchangeAdapter` from
  `@pewterdesk/core`. Match every method on the interface exactly. Stub each
  with `throw new Error("not implemented")` — do NOT write real
  implementations unless the user explicitly asks for that in this same
  request. The goal here is the scaffold, not the client.
- `src/index.ts` — re-exports from `client.ts` and `signing.ts`

After scaffolding, run `pnpm install` and `pnpm --filter @pewterdesk/exchange-<venue> run typecheck`
to confirm it resolves and compiles before considering the task done.

Do not modify `packages/core`'s `ExchangeAdapter` interface as part of this
task — if the new venue needs something the interface doesn't support, stop
and flag that as a separate decision rather than changing the shared contract
inline.
