---
description: Focused review checklist for changes touching signing, key storage, or exchange auth
---

The diff for this task touches signing, key handling, or exchange auth code
(e.g. signing code in a `crates/exchange-<venue>`, the `ExchangeAdapter`
trait or the Tauri commands exposing it, `KeySource` or the keychain bridge,
the webview CSP, or anything that constructs or transmits an authenticated
request). Review it against this checklist before considering the task done —
go through each point explicitly rather than skimming for "looks fine". The
rules come from `docs/adr/0001-venues-in-rust.md`.

1. **No key material leaves Rust.** No private key, seed, or
   signed-but-unsent payload is written to disk, logged (including error
   logs, `Debug` impls and `console.*`), returned to JS, put in a
   `VenueError`, sent over network to anywhere other than the intended venue
   endpoint, or stored anywhere but the OS keychain. Keys are held as
   `Zeroizing` and only for the signing call.
2. **Signing logic stays isolated.** A venue's signing module depends on
   nothing from networking code beyond the minimal types needed to describe
   what's being signed. If this boundary got blurred by the change, flag it.
3. **The signing surface doesn't grow.** `ExchangeAdapter` and the Tauri
   commands that expose it place and cancel orders, nothing else. Nothing
   signs caller-supplied bytes, hashes or typed data; withdrawals, transfers
   and key approvals are absent.
4. **Hosts stay pinned, and the CSP isn't widened.** A venue crate connects
   only to its own hosts and explicitly configured RPC endpoints — never a
   wildcard or a URL taken from a command argument.
5. **The signed payload matches the venue's documented spec exactly** —
   domain, types, and action shape for EIP-712, the transaction for GMX,
   the Cosmos SDK message for dYdX, the instruction for Drift. A subtly
   wrong field can produce a signature that's valid-looking but authorizes
   something other than what the user intended.
6. **Nonce / replay handling is correct** — no reused nonce, no way for a
   captured signed action to be replayed by an attacker.
7. **Errors fail closed.** If signing or auth fails, the order/action does
   NOT get sent in some partially-authenticated fallback path — it just
   fails.
8. **Tests exist for the signing logic in isolation** (not just via an
   end-to-end flow), checked against known vectors from the venue's official
   SDK, covering at least one wrong-input case, not only the happy path.
9. **The PR description calls this out explicitly** under a
   "Security-relevant changes" heading — don't leave a reviewer to discover
   this touches signing on their own.

If any point can't be verified from the diff alone (e.g. because the
venue's signing spec isn't in this repo), say so explicitly rather than
assuming it's fine.
