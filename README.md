# pewterdesk

Non-custodial, multi-venue crypto derivatives trading terminal for desktop and
web. No backend, no custody — talks directly to exchange APIs from your own
machine. Launch venues: Hyperliquid, GMX, dYdX v4 and Drift. Rust adapters, a
TypeScript/React UI, Tauri in between.

> **Status: early scaffold.** The workspace, build tooling, and package
> boundaries are in place; the trading functionality is not. `crates/core`
> defines the `ExchangeAdapter` contract and domain types, but the four venue
> crates are empty and nothing signs yet. The `apps/desktop` Tauri shell builds
> and runs, but it opens a
> window containing one line of placeholder text — no chart, no order ticket,
> no exchange connection. Don't point this at a funded account; there's
> nothing there to point yet.

## Why it's built this way

Two decisions drive the rest of the design:

- **No backend.** Requests go from your machine straight to the exchange. There
  is no pewterdesk server to trust, to breach, or to go down. The desktop app
  can do this because Tauri's Rust side makes requests natively; the browser
  can't, which is why the web build is v2 (see below).
- **No custody, and keys stay in Rust.** Keys live in the OS keychain — never
  on disk, in env vars, or in logs. The venue adapters, signing included, are
  Rust, so the webview never holds a key at all. The adapters can place and
  cancel orders and nothing else, and the key they hold is a venue's
  trade-only delegated key rather than your main wallet key. See
  [ADR 0001](docs/adr/0001-venues-in-rust.md).

## Layout

```
crates/core                     domain types, the ExchangeAdapter trait, KeySource
crates/exchange-<venue>         one adapter per venue: hyperliquid, gmx, dydx, drift
packages/core                   TS domain types (generated from crates/core) + SecretStore
packages/ui                     shared React components (order ticket, position table, chart, hotkeys)
apps/desktop                    the shipped app: Tauri 2 shell (Rust) + its own Vite/React frontend
apps/web                        v2, deferred — same frontend stack; can't run the Rust adapters as-is
```

### The one architectural rule

`crates/core` owns the only cross-cutting contracts: the `ExchangeAdapter`
trait plus the domain types (`Order`, `Position`, `Market`, `OrderBook`, …).
Dependencies point one way:

```
apps/desktop (Tauri) ──→ crates/core ←── crates/exchange-<venue>
      │
      └─ frontend ──→ packages/ui ──→ packages/core (generated types)
```

Every venue crate implements `ExchangeAdapter` and depends on `core` — never
the reverse. The frontend reaches venues only through Tauri commands, and its
TypeScript types are generated from `crates/core` by ts-rs (`make
rust-bindings`), so the two sides can't disagree about the wire format. Adding
a venue should be a new crate, not a rewrite of the UI.

To start a new venue, use the `add-exchange-adapter` scaffold in
[.claude/commands/](.claude/commands/add-exchange-adapter.md).

## Getting started

Requires Node ≥ 20 and pnpm 9 (the repo pins `pnpm@9.12.0` via `packageManager`).
Running the desktop app additionally needs a Rust toolchain — install one via
[rustup](https://rustup.rs) if `cargo --version` doesn't answer.

```sh
pnpm install    # from the repo root — resolves the whole workspace
```

Copy [apps/web/.env.example](apps/web/.env.example) to `apps/web/.env` if you
need to override the Hyperliquid endpoints (e.g. to point at testnet).
**Non-secret config only** — Vite inlines these into client-side JS, so
anything you put there is effectively public. Keys never go in `.env`.

## Running the app

### Start

The desktop app, in a real native window — this is the one you want:

```sh
pnpm --filter @pewterdesk/desktop run tauri dev
```

The **first** run compiles the Rust dependency tree (~340 crates, a couple of
minutes, and it looks like it's hung when it isn't). Later runs reuse
`apps/desktop/src-tauri/target` and start in seconds.

Just the frontend in a browser — no Rust, starts instantly:

```sh
pnpm desktop:dev    # serves http://localhost:1420
```

Today these show you the same thing, because the Rust side registers no
commands yet: [src-tauri/src/main.rs](apps/desktop/src-tauri/src/main.rs) is a
bare `tauri::Builder`. That stops being true as soon as keychain access lands —
from then on, anything touching Tauri IPC will only work in the native window.

The web app (`apps/web`) is a separate, deferred v2 target:

```sh
pnpm --filter @pewterdesk/web dev
```

### Stop

**Close the app window.** That's a full, clean shutdown: the Rust process
exits, `tauri dev` tears down the Vite server it started, port 1420 is
released, and the command returns `0`. Nothing is left behind.

`Ctrl-C` in the terminal does the same thing from the other end, and is the
only way to stop the browser-only `pnpm desktop:dev`, which has no window to
close.

If a Vite server is ever orphaned — killing the terminal without letting Tauri
clean up will do it — the next start fails outright rather than quietly picking
another port, because [vite.config.ts](apps/desktop/vite.config.ts) sets
`strictPort: true`. Find and stop the stray process:

```sh
lsof -nP -iTCP:1420 -sTCP:LISTEN    # then: kill <pid>
```

### Workspace scripts

Run from the repo root; each fans out across every package with `pnpm -r`.

| Command | What it does |
| --- | --- |
| `pnpm typecheck` | typecheck every package |
| `pnpm build` | build every package (`tsc`, plus `vite build` for the web app) |
| `pnpm test` | run each package's `vitest run` |
| `pnpm lint` | run each package's `eslint src` |
| `pnpm desktop:dev` | serve the desktop frontend in a browser (Vite only, no native window) |

## Git hooks

`pnpm install` enables them automatically (the root `prepare` script points
`core.hooksPath` at [.githooks/](.githooks)). They're plain POSIX shell, no
npm dependency — deliberate, in a repo that will handle signing keys. Toggle
manually with `pnpm hooks:install` / `pnpm hooks:uninstall`.

| Hook | Runs |
| --- | --- |
| `pre-commit` | secret scan of staged changes, then `pnpm typecheck` — the typecheck is skipped unless a `.ts`/`.tsx` file is staged, so docs-only commits stay instant |
| `commit-msg` | Conventional Commits (`feat:`, `fix:`, `chore:` …), subject capped at 72 chars; merges, reverts and `fixup!` are exempt |
| `pre-push` | lint → typecheck → test → build, the same four steps as [ci.yml](.github/workflows/ci.yml), so CI failures surface before the push |

The secret scan blocks committed `.env` files (`.env.example` is fine), PEM
private key blocks, npm/GitHub/AWS tokens, and quoted literals assigned to
things named `privateKey`, `mnemonic`, `seedPhrase` and friends. A bare 32-byte
hex string is **warned** about rather than blocked, because in a trading
codebase that shape is just as likely to be a tx hash as a key.

It matches quoted literals only, so ordinary code like
`const privateKey = await keychain.get(...)` doesn't trip it. The flip side:
a test fixture with a throwaway key *will* be blocked. That's the intended
trade — use `--no-verify` for that commit and say why in the message.

Every hook can be bypassed with `--no-verify`. None of them are a substitute
for CI, which runs on a clean checkout.

## Security-sensitive code

The signing code in each `crates/exchange-<venue>` (not yet written) will be
the highest-stakes code in the repo: it turns a key into a signed venue
action. Changes there, to the `ExchangeAdapter` trait or the Tauri commands
that expose it, to the keychain bridge, or to the webview CSP need extra
scrutiny and should be called out explicitly in the PR description, under a
"Security-relevant changes" heading.

There's a `security-review` checklist in
[.claude/commands/](.claude/commands/security-review.md) covering signing, key
storage, and exchange auth. Run through it before opening any PR that touches
those paths.

## Roadmap

1. ~~Stand up the `apps/desktop` Tauri shell.~~ Done — it builds, runs, and
   opens a window; there's just nothing in it yet.
2. ~~OS keychain access from Tauri.~~ Done.
3. ~~Decide where venue logic and signing live.~~ Rust adapters, trade-only
   keys — [ADR 0001](docs/adr/0001-venues-in-rust.md).
4. ~~Define `ExchangeAdapter` and the domain types in `crates/core`.~~ Done,
   with generated TS types.
5. Hyperliquid adapter: ~~read-only market and account data first, exposed
   through Tauri commands~~ (done), then signing and order placement.
6. GMX, dYdX v4 and Drift adapters.
7. Build out `packages/ui` and wire it to the adapters.
8. Revisit `apps/web` once the desktop app ships — it can't run the Rust
   adapters as-is, needs a browser-wallet signer, and needs a thin proxy for
   most venues because browsers enforce CORS.

## License

MIT — see [LICENSE](LICENSE).
