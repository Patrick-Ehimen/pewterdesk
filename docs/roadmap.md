# Roadmap

What's left to build on `main` (as of October 17, 2026). Roughly in priority
order within each section.

## 1. Trading

Orders can be placed on all three venues: Bybit (demo accounts, and live
accounts with live trading turned on), and Hyperliquid and Aster (the
connected API wallet, once live trading is turned on for it). Rust enforces
the switch (`live_trading.rs`) and the trader's rules (`trading_rules.rs`).

Every venue now implements all six trading operations (place, cancel and
change orders, a position's exits, leverage, margin mode), but for a
trailing stop on Hyperliquid and Aster, and the trading rules check all
three (Hyperliquid's and Aster's closed trades are built from their fills).

- **Try each venue with a real, small order.** None has placed a live
  mainnet order from the app yet: not Bybit with a live key, not Hyperliquid,
  not Aster. Hyperliquid's signing is checked against the official Python
  SDK's vectors (its leverage and order-change actions too) and Aster's
  against `eth_account` and its live API, but on each: a place and a
  cancel, changing an order's price, setting and removing a stop-loss, and
  changing leverage.
- **Aster's signed reads** (fills, closed trades, order history, funding)
  follow its docs but haven't run against Aster: check them with a
  connected account, and whether its trade fees come signed as the docs
  show.
- **Trailing stops on Hyperliquid and Aster.** Hyperliquid has none; Aster's
  moves by a percentage, which the app's price distance doesn't map onto
  exactly. Either offer the percentage on Aster or leave it.
- **Aster can't attach a TP / SL to a new order**; it's set on the position
  once it's open.
- **Binance against a real account.** Its public data is checked live
  (`make rust-live`), and a made-up key is refused as it should be, but no
  key has connected yet. With a Demo Trading key first: that the UID comes
  back from Demo Trading's spot host (`/api/v3/account` on
  `demo-api.binance.com`), the account and history reads, a place and a
  cancel, a trigger order and a position's TP / SL through the Algo Service
  (`/fapi/v1/algoOrder`, whose open-order list is read whether it answers
  with the list or under `orders`), changing a limit order, leverage and
  margin mode. Then a live key with Enable Futures only, and one with
  withdrawals on (it must be refused).
- **Binance's account is polled**, every 10 seconds (about 95 request
  weight a time), not streamed: its user data stream (a listen key on the
  `/private` route) would cut that to near nothing.
- **Binance in Hedge Mode** refuses pewterdesk's orders (they're one-way);
  the key's details say so. Orders could send `positionSide` instead.
- **Binance's demo book has its own prices**, unlike Bybit's: a demo order
  is priced from the demo host, but the charts and book show mainnet's.
- **Paper trading** (Hyperliquid and Aster, on the Trade page) only moves
  while the app runs and the venue is on screen, and fills at the best bid
  and ask only; trading rules aren't checked on paper orders.

## 2. Designed screens not built yet

From the local design mockups (`design/screens/`, gitignored).

- **Funding arbitrage** (20), **smart order routing** (38), **spread
  trading** (39) - possible now that three venues trade.
- **Venue health** (42), **chain switcher** (44, 45).
- **To check against the designs:** order ladder / DOM (06), scaled and
  TWAP orders (15), hotkeys (16), liquidation heatmap (19). Some related
  code exists for each; how far it matches the designs hasn't been checked.
- **Not to be built as designed:** Transfer (41) and Gas top-up (47) move
  funds. The signing surface must never include withdraw or transfer
  (`CLAUDE.md`).

Built since the last version of this list: the command palette (17), the
CLI panel, and Multi-chart (22). Dropped: the Journal (18) won't be built,
and its placeholder page is gone.

## 3. The price chart

The price chart is OpenAlgo Charts (`openalgo-charts`, `OpenAlgoChart`) on the
Trade page, every multi-chart cell and popped-out charts.

- **Untried in the running app:** the snapshot button in the Tauri webview,
  "Fill the workspace", popped-out chart windows, and drawings syncing
  between two charts of one market.
- **The library's own dialogs** (indicator settings, chart settings, the
  indicator picker) are English only; it takes a translation callback.

## 4. Desktop features (Rust side)

From `.claude/prd-rust-desktop-features.md`. Built: keychain storage,
native notifications, the tray, single instance and the floating window's
global shortcut.

- **Deep links** - `pewterdesk://` URLs, e.g. shareable position links
  (`tauri-plugin-deep-link`).
- **Local persistence** - trade history, watchlists and settings in SQLite
  (`rusqlite` or `tauri-plugin-sql`) rather than browser storage.
- **Autostart on login** (`tauri-plugin-autostart`) and **auto-update**
  (`tauri-plugin-updater`), the latter now that releases ship.

## 5. Open questions and loose ends

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
- **Housekeeping:** two open Dependabot PRs (#48, #50), both green; #48
  takes TypeScript from 6 to 7. And the local `feat/tealchart` branch, a
  trial OpenAlgo Charts replaced, can go.

## 6. Algos and the `pd` command line

The engine (routing and the trading gate), algo orders (chaser, TWAP,
scaled), native venue algos and venue-side protection, and the `pdd`
daemon with the `pd` command line are built (`docs/bots/plan.md`, ADR
0003). Bots are not part of pewterdesk: automated strategies run in
FreqTrade, on its own, with its own key. The bot engine that was built
here is kept, unmerged, on the `bots-engine` branch; the bots' UI and the
NautilusTrader backtests and signals on `archive/bots-signals`.

## Suggested next steps

1. A small live order on each venue, from the app: place, change, cancel,
   a stop-loss set and removed, and a leverage change.
