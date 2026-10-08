use tauri::Manager;

mod about;
mod browser_connect;
mod bybit_key;
mod coin_info;
mod float;
mod keychain;
mod menubar;
mod news_feeds;
mod notify;
mod okx_liquidations;
mod share;
mod splash;
mod tray;
mod venues;
mod wallet;

/// Control+Option+Space shows or hides the floating window from any app.
/// If another app already holds the shortcut, the window still opens from
/// the menu bar and the main window: registering is best-effort.
fn float_shortcut(app: &tauri::App) {
    use tauri_plugin_global_shortcut::{
        Builder, Code, GlobalShortcutExt, Modifiers, Shortcut, ShortcutState,
    };

    let toggle = Shortcut::new(Some(Modifiers::CONTROL | Modifiers::ALT), Code::Space);
    let plugin = Builder::new()
        .with_handler(move |app, shortcut, event| {
            if shortcut == &toggle && event.state() == ShortcutState::Pressed {
                float::toggle(app);
            }
        })
        .build();
    if app.handle().plugin(plugin).is_ok() {
        let _ = app.global_shortcut().register(toggle);
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let venues = venues::Venues::new().expect("failed to set up venue adapters");

    tauri::Builder::default()
        // Used from Rust only (`notify::notify`): the page is granted none of
        // the plugin's own commands.
        .plugin(tauri_plugin_notification::init())
        .manage(venues)
        .manage(coin_info::CoinInfoState::new().expect("failed to set up the coin info client"))
        .manage(okx_liquidations::OkxState::new().expect("failed to set up the OKX client"))
        .manage(news_feeds::NewsState::new().expect("failed to set up the news client"))
        .manage(wallet::Onboarding::default())
        .manage(browser_connect::BrowserConnect::default())
        .setup(|app| {
            #[cfg(target_os = "macos")]
            {
                menubar::install(app)?;
                notify::install(app.handle());
            }
            tray::install(app)?;
            float::install(app)?;
            float_shortcut(app);
            splash::arm_fallback(app.handle());
            Ok(())
        })
        // A page starting to load (a reload, a language switch) drops the old
        // page's streams, which it can no longer unsubscribe from.
        .on_page_load(|webview, payload| {
            if payload.event() == tauri::webview::PageLoadEvent::Started {
                webview
                    .state::<venues::Venues>()
                    .end_streams_for(webview.label());
            }
        })
        .on_menu_event(|app, event| menubar::on_menu(app, event.id().as_ref()))
        // Closing the main window keeps the app in the menu bar (tray), where
        // prices and PnL stay live; Quit really quits. Linux trays aren't
        // dependable, so there closing still quits. The panel only ever hides.
        .on_window_event(|window, event| match event {
            // Only the main window and the panel stay alive when closed; the
            // splash closes for good.
            tauri::WindowEvent::CloseRequested { api, .. } => {
                let keep = window.label() == tray::PANEL_LABEL
                    || window.label() == float::FLOAT_LABEL
                    || (window.label() == "main"
                        && cfg!(any(target_os = "macos", target_os = "windows")));
                if keep {
                    api.prevent_close();
                    let _ = window.hide();
                }
            }
            // The panel closes when you click anywhere else.
            tauri::WindowEvent::Focused(false) if window.label() == tray::PANEL_LABEL => {
                tray::panel_blurred(window.app_handle());
            }
            _ => {}
        })
        .invoke_handler(tauri::generate_handler![
            about::app_info,
            about::open_about_link,
            splash::app_ready,
            tray::update_tray,
            tray::tray_open_main,
            tray::tray_quit,
            tray::resize_tray_panel,
            notify::notify,
            float::toggle_float,
            float::show_float,
            float::show_float_notice,
            float::hide_float,
            float::resize_float,
            float::snap_float,
            float::place_float,
            float::set_float_protected,
            keychain::store_secret,
            keychain::has_secret,
            keychain::delete_secret,
            venues::markets,
            venues::order_book,
            venues::account,
            venues::fills,
            venues::closed_trades,
            share::save_share_image,
            share::open_share,
            venues::funding_payments,
            venues::order_history,
            venues::subscribe_order_book,
            venues::subscribe_trades,
            venues::subscribe_market_stats,
            venues::subscribe_candles,
            venues::subscribe_market_summaries,
            venues::subscribe_market_history,
            venues::subscribe_liquidations,
            venues::open_interest_history,
            venues::funding_history,
            venues::candles,
            venues::market_icon,
            venues::subscribe_account,
            venues::place_order,
            venues::cancel_order,
            venues::amend_order,
            venues::set_position_protection,
            venues::trade_settings,
            venues::announcements,
            venues::set_leverage,
            venues::set_margin_mode,
            venues::unsubscribe,
            wallet::connect_wallet,
            wallet::wallet_status,
            wallet::disconnect_wallet,
            wallet::begin_agent_approval,
            wallet::finish_agent_approval,
            wallet::cancel_agent_approval,
            browser_connect::start_browser_connect,
            browser_connect::reopen_browser_connect,
            browser_connect::cancel_browser_connect,
            bybit_key::connect_bybit_key,
            bybit_key::bybit_key_status,
            bybit_key::disconnect_bybit_key,
            coin_info::coin_info,
            coin_info::coin_logo,
            coin_info::coin_markets,
            okx_liquidations::okx_liquidation_markets,
            okx_liquidations::okx_liquidations,
            news_feeds::news_feed,
            news_feeds::open_news_article,
            coin_info::open_coin_link,
            coin_info::set_coingecko_key,
            coin_info::has_coingecko_key,
            coin_info::clear_coingecko_key,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|_app, _event| {
            // The Dock icon brings a hidden window back.
            #[cfg(target_os = "macos")]
            if let tauri::RunEvent::Reopen { .. } = _event {
                tray::show_main(_app);
            }
        });
}
