---
description: Focused review checklist for changes touching signing, key storage, or exchange auth
---

The diff for this task touches signing, key handling, or exchange auth code
(e.g. signing code in a `crates/exchange-<venue>`, the `ExchangeAdapter`
trait or the Tauri commands exposing it, `KeySource` or the keychain bridge,
onboarding, the live-trading switch or the trading rules, a data source's
module, the webview CSP, or anything that constructs or transmits an
authenticated request). The full list of security-sensitive files is in
`CLAUDE.md`. Review it against this checklist before considering the task done -
go through each point explicitly rather than skimming for "looks fine". The
rules come from `docs/adr/0001-venues-in-rust.md`.

1. **No key material leaves Rust.** No private key, seed, or
   signed-but-unsent payload is written to disk, logged (including error
   logs, `Debug` impls, `console.*` and the engine's event log in
   `crates/store`, which keeps no keychain reference either), returned to JS, put in a
   `VenueError`, sent over network to anywhere other than the intended venue
   endpoint, or stored anywhere but the OS keychain. Keys are held as
   `Zeroizing` and only for the signing call.
2. **Signing logic stays isolated.** A venue's signing module depends on
   nothing from networking code beyond the minimal types needed to describe
   what's being signed. If this boundary got blurred by the change, flag it.
3. **The signing surface doesn't grow.** `ExchangeAdapter`, the engine's
   router (`crates/engine`, the only caller of its trading methods) and the
   Tauri commands that wrap the router (`place_order`, `cancel_order`,
   `amend_order`, `set_position_protection`, `set_leverage`,
   `set_margin_mode` in `venues.rs`) are six operations and nothing else: place, cancel and amend
   orders (an open order's price, size or attached TP/SL - never its market,
   side or kind), a position's protective, reduce-only exits, leverage (1 to
   the market's maximum) and margin mode. Placing includes a venue-run TWAP
   (`OrderKind::Twap`, Hyperliquid's `twapOrder`) and cancelling includes
   the venue's dead-man's switch (`schedule_cancel`: Hyperliquid's
   `scheduleCancel`, Aster's `countdownCancelAll`), which can only cancel and
   which only the engine arms. Algos (`crates/engine/src/algo/`) send
   through the router like any caller, never an adapter directly. Nothing signs caller-supplied
   bytes, hashes or typed data; withdrawals, transfers and key approvals are
   absent. A new window, panel, palette or CLI command adds no command of
   its own: it goes through the same calls as the order ticket.
4. **Hosts stay pinned, and the CSP isn't widened.** A venue crate connects
   only to its own hosts and explicitly configured RPC endpoints - never a
   wildcard or a URL taken from a command argument.
5. **The signed payload matches the venue's documented spec exactly** -
   domain, types, and action shape for EIP-712 (Hyperliquid over the
   action's msgpack hash, Aster over the exact parameter string sent), and
   for Bybit an HMAC over exactly the bytes sent. Every field of an order is
   a constant or checked against the live market's rules. A subtly wrong
   field can produce a signature that's valid-looking but authorizes
   something other than what the user intended.
6. **Nonce / replay handling is correct** - no reused nonce, no way for a
   captured signed action to be replayed by an attacker.
7. **Errors fail closed.** If signing or auth fails, the order/action does
   NOT get sent in some partially-authenticated fallback path - it just
   fails.
8. **The trading gate holds.** Every one of the six operations goes
   through the engine's router, which builds the account's keychain
   reference itself (`trading_account`) and refuses unless live trading is
   on for that account (`crates/engine/src/live.rs`; a Bybit demo account
   excepted), then checks the trader's rules (`crates/engine/src/rules.rs`)
   before anything is signed. Nothing else calls an adapter's trading
   methods. The rules only ever
   refuse: an order that reduces a position, a cancel and a stop moved
   closer always pass, and anything the rules can't read (the account, its
   fills, the calendar for the news blackout) refuses an opening order.
   Loosening a rule waits for the next 00:00 UTC. Paper orders never reach
   a venue, and live ones never reach the paper account.
9. **Data sources stay data.** A data source (CoinGecko, OKX, news feeds,
   the news wire, the economic calendar) gets nothing signed and no venue
   key, reaches only its fixed hosts (no redirects, size caps), and its text
   reaches the UI bounded and plain. A link opens only through Rust, by id,
   as a URL Rust itself fetched, filtered by `safe_url` - never a URL from
   the UI. Adding a source or a host is security-relevant.
10. **Tests exist for the signing logic in isolation** (not just via an
   end-to-end flow), checked against known vectors from the venue's official
   SDK, covering at least one wrong-input case, not only the happy path.
11. **The PR description calls this out explicitly** under a
   "Security-relevant changes" heading - don't leave a reviewer to discover
   this touches signing on their own.

If any point can't be verified from the diff alone (e.g. because the
venue's signing spec isn't in this repo), say so explicitly rather than
assuming it's fine.
