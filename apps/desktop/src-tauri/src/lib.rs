use tauri::Manager;

mod about;
mod ai_assistant;
mod ai_providers;
mod algos;
mod binance_key;
mod browser_connect;
mod bybit_key;
mod chart_window;
mod coin_info;
mod daemon;
mod econ_calendar;
mod float;
mod keychain;
mod keychain_notice;
mod live_trading;
mod menubar;
mod news_feeds;
mod news_wire;
mod notify;
mod okx_liquidations;
mod share;
mod splash;
mod trading_rules;
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
/// The engine's event log, in the app's data folder.
const EVENT_LOG: &str = "events.sqlite3";

pub fn run() {
    let venues = venues::Venues::new().expect("failed to set up venue adapters");

    tauri::Builder::default()
        // First, so a second launch hands over before anything else is set
        // up: two copies would each keep their own venue streams and
        // keychain prompts. Opening the app again just brings this one
        // forward; what the launch was given is ignored, never acted on.
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            splash::bring_forward(app);
        }))
        // Used from Rust only (`notify::notify`): the page is granted none of
        // the plugin's own commands.
        .plugin(tauri_plugin_notification::init())
        .manage(venues)
        .manage(coin_info::CoinInfoState::new().expect("failed to set up the coin info client"))
        .manage(okx_liquidations::OkxState::new().expect("failed to set up the OKX client"))
        .manage(news_feeds::NewsState::new().expect("failed to set up the news client"))
        .manage(
            econ_calendar::CalendarState::new(env!("CARGO_PKG_VERSION"))
                .expect("failed to set up the calendar client"),
        )
        .manage(news_wire::NewsWireState::new().expect("failed to set up the news wire client"))
        .manage(ai_assistant::AiState::new().expect("failed to set up the AI client"))
        .manage(wallet::Onboarding::default())
        .manage(browser_connect::BrowserConnect::default())
        .manage(daemon::DaemonLink::new())
        .setup(|app| {
            // The engine's router and its gate: which live accounts may
            // trade, and the trader's own rules, kept in the config folder;
            // and its event log, in the data folder. Without the log no
            // opening order is sent (the engine refuses it).
            let config = app.path().app_config_dir().ok();
            let data = app.path().app_data_dir().ok();
            let log = data
                .as_ref()
                .and_then(|dir| pewterdesk_engine::EventLog::open(&dir.join(EVENT_LOG)).ok());
            let mut engine = pewterdesk_engine::Engine::load(config.as_deref(), log);
            // One engine per account: an account the daemon (`pdd`) trades
            // is refused here, and the other way round.
            if let Some(dir) = &data {
                engine = engine.with_locks(dir.join(pewterdesk_engine::owner::LOCK_DIR));
            }
            app.manage(engine);
            // Before anything at start reads the keychain, the page may have
            // a note to show about the password prompt macOS is about to give.
            app.manage(keychain_notice::KeychainNotice::new(config));
            // Algos run on the engine here; any the app closed on are dealt
            // with now.
            algos::install(app.handle());
            // With always on, the link to pdd: kept up while the app runs.
            daemon::install(app.handle());
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
                } else if window.label() == "main" {
                    // Closing the main window quits here: its charts go too.
                    chart_window::close_all(window.app_handle());
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
            keychain_notice::keychain_notice,
            keychain_notice::dismiss_keychain_notice,
            keychain_notice::keychain_notice_cleared,
            tray::update_tray,
            tray::tray_open_main,
            tray::tray_quit,
            tray::resize_tray_panel,
            notify::notify,
            chart_window::open_chart_window,
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
            venues::long_short_ratio,
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
            binance_key::connect_binance_key,
            binance_key::binance_key_status,
            binance_key::disconnect_binance_key,
            live_trading::live_trading_accounts,
            live_trading::set_live_trading,
            live_trading::set_wallet_trading,
            live_trading::set_binance_trading,
            trading_rules::trading_rules,
            trading_rules::set_trading_rules,
            trading_rules::delete_trading_rules,
            trading_rules::trading_rules_status,
            trading_rules::check_trading_rules,
            algos::start_algo,
            algos::algos,
            algos::algo_history,
            algos::pause_algo,
            algos::resume_algo,
            algos::stop_algo,
            algos::halt_algos,
            daemon::daemon_state,
            daemon::set_always_on,
            daemon::daemon_pair,
            daemon::daemon_pair_status,
            coin_info::coin_info,
            coin_info::coin_logo,
            coin_info::coin_markets,
            okx_liquidations::okx_liquidation_markets,
            okx_liquidations::okx_liquidations,
            news_feeds::news_feed,
            news_feeds::open_news_article,
            econ_calendar::economic_calendar,
            news_wire::subscribe_news_wire,
            news_wire::set_news_key,
            news_wire::news_keys,
            news_wire::clear_news_key,
            news_wire::open_wire_link,
            ai_assistant::ai_ask,
            ai_assistant::set_ai_key,
            ai_assistant::ai_key_status,
            ai_assistant::clear_ai_key,
            ai_assistant::ai_models,
            ai_assistant::ai_account_access,
            ai_assistant::set_ai_account_access,
            ai_assistant::ai_gemini_paid,
            ai_assistant::set_ai_gemini_paid,
            ai_assistant::load_ai_chats,
            ai_assistant::save_ai_chats,
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
