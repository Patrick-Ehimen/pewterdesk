mod keychain;
mod venues;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let venues = venues::Venues::new().expect("failed to set up venue adapters");

    tauri::Builder::default()
        .manage(venues)
        .invoke_handler(tauri::generate_handler![
            keychain::store_secret,
            keychain::get_secret,
            keychain::has_secret,
            keychain::delete_secret,
            venues::markets,
            venues::order_book,
            venues::account,
            venues::subscribe_order_book,
            venues::subscribe_trades,
            venues::subscribe_market_stats,
            venues::subscribe_account,
            venues::unsubscribe,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
