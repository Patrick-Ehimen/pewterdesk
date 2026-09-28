//! The launch splash: a small window (splash.html) with the animated mark,
//! shown while the hidden main window loads. The page calls `app_ready`
//! once it has something to show; a fallback reveals it anyway, so a slow
//! or broken frontend can't leave the app without a window.

use std::time::Duration;

use tauri::{AppHandle, Manager, Runtime};

const SPLASH_LABEL: &str = "splash";
/// Revealed by then whether or not the page said it was ready.
const FALLBACK: Duration = Duration::from_secs(10);

/// Closes the splash and shows the main window. Only the first time: once
/// the splash is gone (e.g. a language switch reloads the page) it does
/// nothing, so it never pops a window the user closed to the menu bar.
pub fn reveal_main<R: Runtime>(app: &AppHandle<R>) {
    let Some(splash) = app.get_webview_window(SPLASH_LABEL) else {
        return;
    };
    if let Some(main) = app.get_webview_window("main") {
        let _ = main.show();
        let _ = main.set_focus();
    }
    let _ = splash.close();
}

/// Reveals the main window after `FALLBACK` if the page hasn't by then.
pub fn arm_fallback<R: Runtime>(app: &AppHandle<R>) {
    let app = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(FALLBACK);
        reveal_main(&app);
    });
}

/// From the main window: it's loaded, so swap the splash for it.
#[tauri::command]
pub fn app_ready(app: AppHandle) {
    reveal_main(&app);
}
