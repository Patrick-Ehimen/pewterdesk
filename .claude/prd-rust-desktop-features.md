# PRD: Rust-side desktop features (backlog)

Status: not started — captured for later planning, nothing here is implemented yet.

Context: the Tauri shell (`apps/desktop/src-tauri`) currently only has the
default boilerplate `main.rs` — no custom Rust commands, plugins, or business
logic. This doc captures the candidate Rust-side features for PewterDesk's
desktop app, so we can pick this back up and scope real work later instead of
re-deriving the list from scratch.

## Candidates, roughly ordered by how core they are to the pitch

### 1. Secure key storage (highest priority)
Right now EIP-712 signing lives in `viem` on the TS side, but private
keys/API secrets still need to live somewhere safer than browser storage.
Options:
- `tauri-plugin-stronghold` — official encrypted vault plugin
- `keyring` crate — thin wrapper around macOS Keychain / Windows Credential
  Manager / Linux Secret Service

Either way, the shape is a few Rust-side commands (`store_secret`,
`get_secret`, `delete_secret`) invoked from the frontend via `invoke()`, so
key material never crosses into JS-land except at the moment of signing.
This is the natural home for the "security-sensitive code" section already
flagged in `CLAUDE.md`. The whole non-custodial pitch depends on this piece.

### 2. Native notifications
`tauri-plugin-notification` for order fills, liquidation warnings, funding
rate flips — useful for a trading terminal where alerts should still land
when the window isn't focused.

### 3. System tray
A persistent tray icon showing a ticker (price, PnL) with a right-click menu
(positions, quick actions), backed by Tauri v2's built-in `tauri::tray`. A
nice differentiator vs. a browser-tab tool, and cheap to build.

### 4. Single-instance + deep linking
- `tauri-plugin-single-instance` — launching the app twice just focuses the
  existing window instead of opening a second one
- `tauri-plugin-deep-link` — for `pewterdesk://` URLs later (shareable
  position links, OAuth-style callbacks for a future exchange integration)

### 5. Local persistence
`rusqlite` or `tauri-plugin-sql` for trade history, watchlists, and settings
that should survive restarts without hitting an external server — keeps the
app non-custodial/backend-less while still having local state.

### 6. Window/lifecycle stuff
- Autostart on login (`tauri-plugin-autostart`)
- Updater (`tauri-plugin-updater`) — relevant once shipping releases
- Global shortcuts for quick order entry

### 7. Performance-sensitive stuff (later, optional)
If a websocket-driven orderbook ever gets heavy enough that JS becomes the
bottleneck, move the raw WS connection and order-book diffing into a Rust
background task, pushing already-normalized snapshots to the frontend via
events. Premature right now with zero exchange logic wired up — noted as an
escape hatch, not a near-term task.

## Suggested sequencing

1. Secure key storage (keyring or Stronghold) — the whole non-custodial
   pitch depends on this
2. Notifications + system tray — cheap, visible payoff for demos/portfolio
3. Everything else — backlog, pull forward as needed

## Open decisions (revisit when picking this up)

- `keyring` crate vs. `tauri-plugin-stronghold` for key storage
- Whether to add plugin dependencies to `Cargo.toml` now (unimplemented) or
  wait until actually wiring up commands
