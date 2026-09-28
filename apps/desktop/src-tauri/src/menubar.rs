//! The macOS menu bar: the app menu (with our own About), File, Edit, View,
//! Window and Help. Edit matters beyond looks: without it, copy and paste
//! don't reach the app's text fields on macOS.

#[cfg(target_os = "macos")]
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem, Submenu};
use tauri::{AppHandle, Emitter, Runtime};

use crate::about::{self, AboutLink};

const HELP_REPOSITORY: &str = "help:repository";
const HELP_ISSUES: &str = "help:issues";

#[cfg(target_os = "macos")]
pub fn install(app: &tauri::App) -> tauri::Result<()> {
    let h = app.handle();
    let name = h.package_info().name.clone();
    let sep = || PredefinedMenuItem::separator(h);

    let about = MenuItem::with_id(
        h,
        about::ABOUT_MENU_ID,
        format!("About {name}"),
        true,
        None::<&str>,
    )?;
    let app_menu = Submenu::with_items(
        h,
        &name,
        true,
        &[
            &about,
            &sep()?,
            &PredefinedMenuItem::services(h, None)?,
            &sep()?,
            &PredefinedMenuItem::hide(h, None)?,
            &PredefinedMenuItem::hide_others(h, None)?,
            &PredefinedMenuItem::show_all(h, None)?,
            &sep()?,
            &PredefinedMenuItem::quit(h, None)?,
        ],
    )?;
    let file = Submenu::with_items(
        h,
        "File",
        true,
        &[&PredefinedMenuItem::close_window(h, None)?],
    )?;
    let edit = Submenu::with_items(
        h,
        "Edit",
        true,
        &[
            &PredefinedMenuItem::undo(h, None)?,
            &PredefinedMenuItem::redo(h, None)?,
            &sep()?,
            &PredefinedMenuItem::cut(h, None)?,
            &PredefinedMenuItem::copy(h, None)?,
            &PredefinedMenuItem::paste(h, None)?,
            &PredefinedMenuItem::select_all(h, None)?,
        ],
    )?;
    let view = Submenu::with_items(
        h,
        "View",
        true,
        &[&PredefinedMenuItem::fullscreen(h, None)?],
    )?;
    let window = Submenu::with_items(
        h,
        "Window",
        true,
        &[
            &PredefinedMenuItem::minimize(h, None)?,
            &PredefinedMenuItem::maximize(h, None)?,
            &sep()?,
            &PredefinedMenuItem::close_window(h, None)?,
        ],
    )?;
    let help = Submenu::with_items(
        h,
        "Help",
        true,
        &[
            &MenuItem::with_id(
                h,
                HELP_REPOSITORY,
                format!("{name} on GitHub"),
                true,
                None::<&str>,
            )?,
            &MenuItem::with_id(h, HELP_ISSUES, "Report a Bug…", true, None::<&str>)?,
        ],
    )?;
    app.set_menu(Menu::with_items(
        h,
        &[&app_menu, &file, &edit, &view, &window, &help],
    )?)?;
    Ok(())
}

/// Handles the menu bar's own items; the predefined ones act by themselves.
pub fn on_menu<R: Runtime>(app: &AppHandle<R>, id: &str) {
    match id {
        about::ABOUT_MENU_ID => {
            // The page opens its dialog; nothing to do if it isn't listening.
            let _ = app.emit(about::OPEN_ABOUT_EVENT, ());
        }
        HELP_REPOSITORY => {
            let _ = about::open(AboutLink::Repository);
        }
        HELP_ISSUES => {
            let _ = about::open(AboutLink::Issues);
        }
        _ => {}
    }
}
