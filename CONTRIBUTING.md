# Contributing to pewterdesk

Thanks for taking a look. pewterdesk is an early scaffold of a non-custodial
trading terminal, so the rules below are mostly about keeping keys safe and
the Rust/TypeScript boundary clean. Read the [README](README.md) and
[ADR 0001](docs/adr/0001-venues-in-rust.md) first; they explain why the code
is shaped the way it is.

## Setup

You need Node >= 22.12, pnpm 9 (`corepack enable`), and a Rust toolchain from
[rustup](https://rustup.rs) for anything under `crates/` or `apps/desktop`.

```sh
make install   # install the workspace and enable the git hooks
make doctor    # confirm node, pnpm, cargo and tauri all work
make dev       # run the desktop app in a native window
make dev-ui    # or: the desktop frontend in a browser, no Rust needed
```

Run `make` on its own for every target. The Makefile only wraps pnpm and
cargo, so either works.

## Before you open a PR

```sh
make check-all
```

`make check` is what CI runs: lint (Biome), typecheck, test, build. CI does
not build or test the Rust side yet, so `check-all` adds `cargo fmt --check`,
`clippy -D warnings` and `cargo test`. If you touched `crates/` or
`src-tauri/`, run it: nothing else will catch a broken Rust build.

The pre-commit hook runs lint and typecheck. `pnpm fix` and `make rust-fmt`
fix formatting.

Some tests are skipped by default because they touch real systems:

```sh
cargo test -p pewterdesk -- --ignored                      # the real OS keychain
cargo test -p pewterdesk-exchange-hyperliquid -- --ignored # Hyperliquid mainnet, read-only
```

## Architecture rules

- **`crates/core` owns the contracts.** The `ExchangeAdapter` trait, the
  domain types and `KeySource` live there and nowhere else. Venue crates
  depend on `core`, never the other way round.
- **Adding a venue means adding a crate.** It goes in
  `crates/exchange-<venue>`, implements `ExchangeAdapter`, and connects only
  to its own hosts and explicitly configured RPC endpoints.
- **The frontend reaches venues only through Tauri commands.** `packages/ui`
  and `apps/*` never import a venue crate or call a venue's API.
- **Generated types are never edited by hand.** `packages/core/src/generated/`
  comes from ts-rs. Change the Rust, run `make rust-bindings`, and commit the
  result. The serde attributes are the IPC wire format, so renaming a field
  breaks the frontend.
- **No tsconfig `references`.** Packages are consumed from source
  (`main`/`types` point at `./src/index.ts`). Project references make a clean
  checkout fail to typecheck.

## Security-sensitive code

These areas need a review against the
[security checklist](.claude/commands/security-review.md), and the PR
description must call them out under a **Security-relevant changes** heading:

- `apps/desktop/src-tauri/src/keychain.rs`: the only place key material is
  stored. Keys never touch disk, env vars or logs.
- Signing code in any `crates/exchange-<venue>`. Hold keys only as
  `Zeroizing`, and only for the signing call. Test signatures against known
  vectors from the venue's official SDK.
- The `ExchangeAdapter` trait and the Tauri commands that expose it. Together
  they are the whole signing surface: place and cancel orders. Never add
  withdraw, transfer, key approval, or anything that signs caller-supplied
  bytes or typed data.
- The webview CSP in `apps/desktop/src-tauri/tauri.conf.json`. `connect-src`
  stays `'self'` plus IPC.

Onboarding stores a venue's trade-only delegated key (Hyperliquid agent
wallet, GMX subaccount, dYdX permissioned key, Drift delegate), never a user's
main wallet key.

If you find a vulnerability, please report it privately to the maintainer
rather than opening a public issue.

## UI conventions

- **Strings:** every user-facing string goes through `t("key")` from
  `@pewterdesk/ui`. Add the key to `packages/ui/src/i18n/locales/en.ts` and to
  all seven other locales; the typecheck fails until every language has it.
  Never call `t` at module scope.
- **Colors:** use only the `--pd-*` variables from
  `.claude/brand/pewterdesk-tokens.css`, never raw hex. Brass is the accent
  and never means buy, sell or PnL; green and red are for market data only.
  See `.claude/brand/BRAND.md`.

## Commits and PRs

- Branch off `main` (`feat/…`, `fix/…`, `chore/…`) and open a PR.
- Commit messages follow Conventional Commits with a scope:
  `feat(hyperliquid): trade tape and market stats streams`,
  `fix(desktop): …`, `chore: …`.
- Keep PRs to one concern, and say in the description what you ran to test it.

## License

By contributing you agree that your contributions are licensed under the
[MIT License](LICENSE).
