# Roadmap

What's left to build after v0.2.0 and the work on `main` since (as of
October 5, 2026). Roughly in priority order within each section.

## 1. Trading on more than demo

The biggest gap: Bybit demo accounts are still the only place an order can
be placed.

- **Live Bybit accounts.** The trading commands accept demo accounts only
  (`trading_account` in `apps/desktop/src-tauri/src/venues.rs`). A plan for
  the switch exists; open decisions:
  - whether margin mode stays demo-only at first
  - whether to cap order size at first
  - who runs the demo checklist before the gate is lifted

  Lifting the gate is a security-relevant change (see `CLAUDE.md`).
- **Hyperliquid orders.** The adapter is read-only; there is no signing code
  yet. This is the highest-stakes code in the repo and gets its own review
  against `.claude/commands/security-review.md`.
- **Aster.** Public market data only. Account data needs requests signed by
  an API wallet, and the UI doesn't show Aster yet.

## 2. Designed screens not built yet

From the local design mockups (`design/screens/`, gitignored).

- **Journal** (18) - still a placeholder page; to be built on the fill
  history (`fills`).
- **Command palette** (17).
- **Funding arbitrage** (20), **smart order routing** (38), **spread
  trading** (39) - need more than one live venue.
- **Multi-chart** (22), **venue health** (42), **chain switcher** (44, 45).
- **To check against the designs:** order ladder / DOM (06), scaled and
  TWAP orders (15), hotkeys (16), liquidation heatmap (19). Some related
  code exists for each; how far it matches the designs hasn't been checked.
- **Not to be built as designed:** Transfer (41) and Gas top-up (47) move
  funds. The signing surface must never include withdraw or transfer
  (`CLAUDE.md`).

## 3. Desktop features (Rust side)

From `.claude/prd-rust-desktop-features.md`; none started.

- **Single instance** - launching the app twice focuses the open window
  (`tauri-plugin-single-instance`).
- **Deep links** - `pewterdesk://` URLs, e.g. shareable position links
  (`tauri-plugin-deep-link`).
- **Local persistence** - trade history, watchlists and settings in SQLite
  (`rusqlite` or `tauri-plugin-sql`) rather than browser storage.
- **Autostart on login** (`tauri-plugin-autostart`) and **auto-update**
  (`tauri-plugin-updater`), the latter now that releases ship.

## 4. Open questions and loose ends

- **Limit orders priced through the market** fill at once, as the exchange
  executes them. Pick one: offer "place as a stop order", drop the warning,
  or add post-only.
- **Share card dates.** The footer can't show "Start | End" because neither
  a position nor a closed trade carries its opening time.
- **Bybit logo list** (`/v5/asset/exchange/query-coin-list`) is unverified
  with a demo key and with a contract-trading-only key.
- **Untested in the running app:** the float window (stays on top, Spaces,
  full screen, dragging, snapping, hotkey, hidden from screen sharing),
  native notifications, the liquidation notice's placement, TP/SL on a new
  Bybit demo order, and the share buttons.
- **v0.2.0 release** is a draft with 9 installers; publish or not.
- **`.claude/commands/security-review.md`** is out of date with the current
  signing surface.

## Suggested next steps

1. Live Bybit trading - mostly planned, and it turns the app into a working
   terminal.
2. The Journal, on the fill history.
3. The command palette.
