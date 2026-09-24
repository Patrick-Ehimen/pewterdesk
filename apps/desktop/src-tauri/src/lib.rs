mod keychain;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            keychain::store_secret,
            keychain::get_secret,
            keychain::has_secret,
            keychain::delete_secret,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
