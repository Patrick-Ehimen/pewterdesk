---
description: Focused review checklist for changes touching signing, key storage, or exchange auth
---

The diff for this task touches signing, key handling, or exchange auth code
(e.g. `signing.ts` in any exchange package, Tauri keychain bridge code, or
anything that constructs or transmits an authenticated request). Review it
against this checklist before considering the task done — go through each
point explicitly rather than skimming for "looks fine":

1. **No key material leaves memory unexpectedly.** No private key, seed, or
   signed-but-unsent payload is written to disk, logged (including error
   logs and `console.*`), sent over network to anywhere other than the
   intended exchange endpoint, or stored anywhere but the OS keychore via the
   Tauri bridge.
2. **Signing logic stays isolated.** `signing.ts`-equivalent files import
   nothing from UI code, and nothing from networking code beyond the minimal
   types needed to describe what's being signed. If this boundary got
   blurred by the change, flag it.
3. **The signed payload matches the venue's documented spec exactly** —
   domain, types, and action shape for EIP-712 (or the venue's equivalent).
   A subtly wrong field can produce a signature that's valid-looking but
   authorizes something other than what the user intended.
4. **Nonce / replay handling is correct** — no reused nonce, no way for a
   captured signed action to be replayed by an attacker.
5. **Errors fail closed.** If signing or auth fails, the order/action does
   NOT get sent in some partially-authenticated fallback path — it just
   fails.
6. **Tests exist for the signing logic in isolation** (not just via an
   end-to-end flow), covering at least one wrong-input case, not only the
   happy path.
7. **The PR description calls this out explicitly**, per the org's
   `.github` pull request template's security-relevant-changes section —
   don't leave a reviewer to discover this touches signing on their own.

If any point can't be verified from the diff alone (e.g. because the
venue's signing spec isn't in this repo), say so explicitly rather than
assuming it's fine.
