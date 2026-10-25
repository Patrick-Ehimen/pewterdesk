//! The commands that show and set the live-trading switch. The switch itself
//! is the engine's (`pewterdesk_engine::live`), checked by its router before
//! anything is signed.
//!
//! Security-relevant - review any change here against
//! `.claude/commands/security-review.md`: turning it on asks the venue again
//! what the stored key may do, and refuses a key that isn't trade-only
//! (Bybit's and Binance's `auth::ALLOWED`; on Hyperliquid and Aster, an API wallet still
//! approved for that account, which on Aster can't withdraw), belongs to
//! another account, or can't be checked (offline included): it fails closed.

use pewterdesk_core::{VenueError, VenueId};
use pewterdesk_engine::live::{binance_id, live_uid, wallet_id};
use pewterdesk_engine::Engine;
use tauri::State;

use crate::venues::Venues;
use crate::{binance_key, bybit_key, wallet};

/// The live accounts with trading on: Bybit UIDs, Binance accounts as
/// `binance:<uid>`, and Hyperliquid and Aster accounts as `<venue>:<address>`.
/// Public ids only.
#[tauri::command]
pub fn live_trading_accounts(engine: State<'_, Engine>) -> Vec<String> {
    engine.live().list()
}

/// Turns live trading on or off for Bybit account `uid`. Turning it on
/// checks the stored key with Bybit first: it must be this account's and
/// trade-only, or it stays off.
#[tauri::command]
pub async fn set_live_trading(
    venues: State<'_, Venues>,
    engine: State<'_, Engine>,
    uid: String,
    on: bool,
) -> Result<(), VenueError> {
    let bare = live_uid(&uid)?;
    if on {
        bybit_key::verify_trade_only(&venues, &bare).await?;
    }
    engine.live().set(&bare, on)
}

/// Turns live trading on or off for the Hyperliquid or Aster account
/// `address`. Turning it on checks the stored API wallet with the venue
/// first: it must still be that account's approved, trade-only wallet, or
/// it stays off.
#[tauri::command]
pub async fn set_wallet_trading(
    venues: State<'_, Venues>,
    engine: State<'_, Engine>,
    venue: VenueId,
    address: String,
    on: bool,
) -> Result<(), VenueError> {
    let address = wallet::normalize_address(&address)?;
    let id = wallet_id(venue, &address)?;
    if on {
        wallet::verify_trade_only(&venues, venue, &address).await?;
    }
    engine.live().set(&id, on)
}

/// Turns live trading on or off for Binance account `uid`. Turning it on
/// checks the stored key with Binance first: it must be this account's and
/// trade-only, or it stays off.
#[tauri::command]
pub async fn set_binance_trading(
    venues: State<'_, Venues>,
    engine: State<'_, Engine>,
    uid: String,
    on: bool,
) -> Result<(), VenueError> {
    let id = binance_id(&uid)?;
    if on {
        binance_key::verify_trade_only(&venues, uid.trim()).await?;
    }
    engine.live().set(&id, on)
}
