# pewterdesk

Non-custodial, multi-venue crypto derivatives trading terminal for desktop and
web. No backend, no custody — talks directly to exchange APIs from your own
machine. Hyperliquid first. TypeScript + Tauri.

> **Status: early scaffold.** The workspace, build tooling, and package
> boundaries are in place; the trading functionality is not. `packages/core`
> does not yet define `ExchangeAdapter`, and the Hyperliquid adapter is an
> empty module. The `apps/desktop` Tauri shell builds and runs, but it opens a
> window containing one line of placeholder text — no chart, no order ticket,
> no exchange connection. Don't point this at a funded account; there's
> nothing there to point yet.

## Why it's built this way

Two decisions drive the rest of the design:

- **No backend.** Requests go from your machine straight to the exchange. There
  is no pewterdesk server to trust, to breach, or to go down. The desktop app
  can do this because Tauri's Rust side makes requests natively; the browser
  can't, which is why the web build is v2 (see below).
- **No custody.** Keys are expected to live in the OS keychain and be read
  through the Tauri app layer — never from disk, env vars, or logs. Nothing in
  the TypeScript packages should ever hold a key longer than a signing call
  needs it.

## Layout

```
packages/core                   exchange-agnostic types + the ExchangeAdapter interface
packages/exchange-hyperliquid   Hyperliquid adapter (REST/WS client, EIP-712 signing via viem)
packages/ui                     shared React components (order ticket, position table, chart, hotkeys)
apps/desktop                    the shipped app: Tauri 2 shell (Rust) + its own Vite/React frontend
apps/web                        v2, deferred — same frontend stack, needs a proxy for CORS
```

### The one architectural rule

`packages/core` owns the only cross-cutting contract: the `ExchangeAdapter`
interface plus the domain types (`Order`, `Position`, `Market`, `OrderBook`,
…). Dependencies point one way:

```
apps/*  ─┬─→  packages/ui  ──→  packages/core  ←──  packages/exchange-hyperliquid
         └───────────────────────────────────┘
```

Every exchange package implements `ExchangeAdapter` and depends on `core` —
never the reverse. `packages/ui` and the apps depend on `core` for types and
must **not** import a specific exchange package. That constraint is the whole
point: adding a second venue should be a new adapter, not a rewrite of the UI.

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

`packages/exchange-hyperliquid/src/signing.ts` (not yet written) will be the
highest-stakes file in the repo: it turns a private key into a signed exchange
action. Changes there, or to key storage generally, need extra scrutiny and
should be called out explicitly in the PR description — see the org's `.github`
PR template.

There's a `security-review` checklist in
[.claude/commands/](.claude/commands/security-review.md) covering signing, key
storage, and exchange auth. Run through it before opening any PR that touches
those paths.

## Roadmap

1. ~~Stand up the `apps/desktop` Tauri shell.~~ Done — it builds, runs, and
   opens a window; there's just nothing in it yet.
2. Define `ExchangeAdapter` and the domain types in `packages/core`.
3. Implement the Hyperliquid adapter against it — REST/WS client, then signing.
4. Add the first Tauri command: OS keychain access, so a key can reach the
   signer without ever touching disk or an env var.
5. Build out `packages/ui` and wire it to the adapter.
6. Revisit `apps/web` once the desktop app ships — it needs a thin proxy in
   front of it for most venues, because browsers enforce CORS.

## Related repos

- `.github` — org profile, issue/PR templates, shared CI workflow
- `pewterdesk-docs` — install guide, security policy (not yet created)

## License

MIT — see [LICENSE](LICENSE).
