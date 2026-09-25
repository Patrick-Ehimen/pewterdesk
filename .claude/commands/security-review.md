---
description: Focused review checklist for changes touching signing, key storage, or exchange auth
---

The diff for this task touches signing, key handling, or exchange auth code
(e.g. `apps/desktop/src-tauri/src/signing/`, the keychain bridge, the network
transport's host allowlist, the webview CSP, or anything that constructs or
transmits an authenticated request). Review it against this checklist before
considering the task done — go through each point explicitly rather than
skimming for "looks fine". The rules come from `docs/adr/0001-sign-in-rust.md`.

1. **No key material leaves Rust.** No private key, seed, or
   signed-but-unsent payload is written to disk, logged (including error
   logs, `Debug` impls and `console.*`), returned to JS, sent over network to
   anywhere other than the intended venue endpoint, or stored anywhere but
   the OS keychain.
2. **Signing logic stays isolated.** Signer modules depend on nothing from
   UI code, and nothing from networking code beyond the minimal types needed
   to describe what's being signed. If this boundary got blurred by the
   change, flag it.
3. **Signing commands take typed actions, never raw payloads.** Every Tauri
   command that signs accepts structured parameters and builds the venue
   payload itself. Nothing signs caller-supplied bytes, hashes or typed data.
   Withdrawals, transfers and key approvals are absent or gated behind a
   native OS confirmation the webview can't drive.
4. **The transport allowlist stays tight, and the CSP isn't widened.** New
   hosts are a specific venue or RPC endpoint, never a wildcard or a
   caller-supplied URL.
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
