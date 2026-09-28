//! The menu-bar (tray) item and its panel. The item is the pewterdesk mark
//! with live text beside it (the page formats it and sends it with
//! `update_tray`); clicking it opens a small panel window under it (the same
//! frontend, at `#tray`) with the watchlist, the account and a few actions.
//! Nothing here can trade.

use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde::Deserialize;
use tauri::image::Image;
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{
    AppHandle, Manager, PhysicalPosition, PhysicalSize, Runtime, WebviewUrl, WebviewWindow,
    WebviewWindowBuilder,
};

const TRAY_ID: &str = "main";
/// The panel window's label; the frontend renders the panel when loaded at `#tray`.
pub const PANEL_LABEL: &str = "tray-panel";
const PANEL_WIDTH: f64 = 370.0;
/// Bounds for the height the panel asks for (it fits its content).
const PANEL_MIN_HEIGHT: f64 = 160.0;
const PANEL_MAX_HEIGHT: f64 = 640.0;
/// Gap between the menu bar and the panel, in points.
const PANEL_GAP: f64 = 6.0;
/// Longest text shown anywhere in the tray, in characters.
const MAX_TEXT: usize = 80;

/// When the panel last hid because it lost focus. A click on the tray icon
/// while the panel is open blurs it first (hiding it), then arrives as a
/// click; without this, that click would open it straight back up.
#[derive(Default)]
pub struct PanelState(Mutex<Option<Instant>>);

fn clip(text: &str) -> String {
    text.chars()
        .filter(|c| !c.is_control())
        .take(MAX_TEXT)
        .collect()
}

/// How a piece of the title is coloured.
#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum Tone {
    Plain,
    /// Green: a rise, or a profit.
    Up,
    /// Red: a fall, or a loss.
    Down,
}

/// A run of the title in one colour.
#[derive(Clone, Debug, Deserialize)]
pub struct TitlePart {
    text: String,
    tone: Tone,
}

#[derive(Debug, Deserialize)]
pub struct TrayUpdate {
    /// Beside the icon, in coloured runs; empty for the icon alone.
    title: Vec<TitlePart>,
}

/// The title as its runs, bounded like everything else from the page.
fn sanitize_title(parts: Vec<TitlePart>) -> Vec<TitlePart> {
    let mut left = MAX_TEXT;
    let mut out = Vec::new();
    for part in parts.into_iter().take(8) {
        let text: String = clip(&part.text).chars().take(left).collect();
        left -= text.chars().count();
        if !text.is_empty() {
            out.push(TitlePart { text, ..part });
        }
    }
    out
}

/// On macOS, redraws the status item's title with its runs coloured, over
/// the plain title the tray library keeps (and sizes the item from).
#[cfg(target_os = "macos")]
fn colour_title<R: Runtime>(tray: &tauri::tray::TrayIcon<R>, parts: Vec<TitlePart>) {
    use objc2::runtime::AnyObject;
    use objc2_app_kit::{NSColor, NSFont, NSFontAttributeName, NSForegroundColorAttributeName};
    use objc2_foundation::{
        MainThreadMarker, NSAttributedString, NSDictionary, NSMutableAttributedString, NSString,
    };

    let _ = tray.with_inner_tray_icon(move |inner| {
        let (Some(item), Some(mtm)) = (inner.ns_status_item(), MainThreadMarker::new()) else {
            return;
        };
        let Some(button) = item.button(mtm) else {
            return;
        };
        let title = NSMutableAttributedString::new();
        // The menu bar's own font, so the title doesn't change size.
        let font = NSFont::menuBarFontOfSize(0.0);
        for part in &parts {
            let colour = match part.tone {
                Tone::Up => NSColor::systemGreenColor(),
                Tone::Down => NSColor::systemRedColor(),
                // Follows the menu bar's light or dark appearance.
                Tone::Plain => NSColor::controlTextColor(),
            };
            let values: [&AnyObject; 2] = [&colour, &font];
            let attrs = NSDictionary::<NSString, AnyObject>::from_slices(
                unsafe { &[NSForegroundColorAttributeName, NSFontAttributeName] },
                &values,
            );
            let run = unsafe {
                NSAttributedString::new_with_attributes(&NSString::from_str(&part.text), &attrs)
            };
            title.appendAttributedString(&run);
        }
        button.setAttributedTitle(&title);
    });
}

/// On macOS, lets the panel open over anything, full-screen apps included,
/// like the menu bar it hangs from: it joins every Space (including another
/// app's full-screen one) and sits at the menu bar's own level. Mission
/// Control leaves it be, and ⌘` skips it.
#[cfg(target_os = "macos")]
fn float_over_everything<R: Runtime>(panel: &WebviewWindow<R>) {
    use objc2_app_kit::{NSStatusWindowLevel, NSWindow, NSWindowCollectionBehavior};

    let Ok(ptr) = panel.ns_window() else {
        return;
    };
    // SAFETY: Tauri hands back the panel's live NSWindow, and setup (where
    // this runs) is on the main thread, as AppKit requires.
    let window: &NSWindow = unsafe { &*ptr.cast::<NSWindow>() };
    window.setCollectionBehavior(
        NSWindowCollectionBehavior::CanJoinAllSpaces
            | NSWindowCollectionBehavior::FullScreenAuxiliary
            | NSWindowCollectionBehavior::Stationary
            | NSWindowCollectionBehavior::IgnoresCycle,
    );
    window.setLevel(NSStatusWindowLevel);
}

/// Brings the main window back (from hidden or minimised) and focuses it.
pub fn show_main<R: Runtime>(app: &AppHandle<R>) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
}

fn panel<R: Runtime>(app: &AppHandle<R>) -> Option<WebviewWindow<R>> {
    app.get_webview_window(PANEL_LABEL)
}

fn hide_panel<R: Runtime>(app: &AppHandle<R>) {
    if let Some(panel) = panel(app) {
        let _ = panel.hide();
    }
}

/// The panel lost focus (a click elsewhere): hide it, and note when.
pub fn panel_blurred<R: Runtime>(app: &AppHandle<R>) {
    hide_panel(app);
    if let Some(state) = app.try_state::<PanelState>() {
        *state.0.lock().unwrap() = Some(Instant::now());
    }
}

/// Opens the panel under the tray icon at `rect`, or closes it if open.
fn toggle_panel<R: Runtime>(app: &AppHandle<R>, rect: tauri::Rect) {
    let Some(panel) = panel(app) else {
        return;
    };
    if panel.is_visible().unwrap_or(false) {
        let _ = panel.hide();
        return;
    }
    // Just hidden by this same click's blur: leave it closed.
    let recently = app
        .try_state::<PanelState>()
        .and_then(|s| *s.0.lock().unwrap())
        .is_some_and(|at| at.elapsed() < Duration::from_millis(250));
    if recently {
        return;
    }
    let scale = panel.scale_factor().unwrap_or(1.0);
    let icon: PhysicalPosition<f64> = rect.position.to_physical(scale);
    let icon_size: PhysicalSize<f64> = rect.size.to_physical(scale);
    let width = PANEL_WIDTH * scale;
    let gap = PANEL_GAP * scale;
    // Centred under the icon, kept on its screen.
    let mut x = icon.x + icon_size.width / 2.0 - width / 2.0;
    if let Ok(Some(monitor)) = panel.current_monitor() {
        let left = f64::from(monitor.position().x);
        let right = left + f64::from(monitor.size().width);
        x = x.clamp(left + gap, (right - width - gap).max(left + gap));
    }
    let y = icon.y + icon_size.height + gap;
    let _ = panel.set_position(PhysicalPosition::new(x, y));
    let _ = panel.show();
    let _ = panel.set_focus();
}

pub fn install(app: &tauri::App) -> tauri::Result<()> {
    let handle = app.handle();
    let name = handle.package_info().name.clone();

    // The panel: the same frontend at #tray, hidden until the icon is clicked.
    let panel =
        WebviewWindowBuilder::new(app, PANEL_LABEL, WebviewUrl::App("index.html#tray".into()))
            .title(&name)
            .inner_size(PANEL_WIDTH, 420.0)
            .resizable(false)
            .decorations(false)
            // See-through, so the page's rounded card shapes the window.
            .transparent(true)
            .always_on_top(true)
            .skip_taskbar(true)
            .visible(false)
            .focused(false)
            .visible_on_all_workspaces(true)
            .build()?;
    #[cfg(target_os = "macos")]
    float_over_everything(&panel);
    #[cfg(not(target_os = "macos"))]
    let _ = panel;
    app.manage(PanelState::default());

    // A monochrome template: macOS draws it white on a dark menu bar and
    // black on a light one.
    let icon = Image::from_bytes(include_bytes!("../icons/tray-template.png"))?;
    TrayIconBuilder::with_id(TRAY_ID)
        .icon(icon)
        .icon_as_template(true)
        .tooltip(&name)
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                rect,
                ..
            } = event
            {
                toggle_panel(tray.app_handle(), rect);
            }
        })
        .build(app)?;
    Ok(())
}

/// Redraws the menu-bar item's title from the page's latest numbers.
#[tauri::command]
pub fn update_tray(app: AppHandle, update: TrayUpdate) -> Result<(), String> {
    let Some(tray) = app.tray_by_id(TRAY_ID) else {
        return Ok(());
    };
    let parts = sanitize_title(update.title);
    let plain: String = parts.iter().map(|p| p.text.as_str()).collect();
    // The tray library sizes the item from the plain title; an empty one
    // leaves the icon alone.
    tray.set_title(Some(plain.as_str()))
        .map_err(|_| "couldn't update the menu bar item".to_owned())?;
    #[cfg(target_os = "macos")]
    if !parts.is_empty() {
        colour_title(&tray, parts);
    }
    Ok(())
}

/// From the panel: open the main window (and close the panel).
#[tauri::command]
pub fn tray_open_main(app: AppHandle) {
    hide_panel(&app);
    show_main(&app);
}

/// From the panel: quit the app.
#[tauri::command]
pub fn tray_quit(app: AppHandle) {
    app.exit(0);
}

/// From the panel: fit the window to its content, within bounds.
#[tauri::command]
pub fn resize_tray_panel(app: AppHandle, height: f64) {
    if let Some(panel) = panel(&app) {
        let height = if height.is_finite() {
            height.clamp(PANEL_MIN_HEIGHT, PANEL_MAX_HEIGHT)
        } else {
            PANEL_MIN_HEIGHT
        };
        let _ = panel.set_size(tauri::LogicalSize::new(PANEL_WIDTH, height));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn part(text: &str) -> TitlePart {
        TitlePart {
            text: text.into(),
            tone: Tone::Up,
        }
    }

    #[test]
    fn bounds_the_title_as_a_whole() {
        let parts = sanitize_title(vec![part(&"a".repeat(60)), part(&"b".repeat(60)), part("")]);
        let total: usize = parts.iter().map(|p| p.text.chars().count()).sum();
        assert_eq!(total, MAX_TEXT);
        // Runs cut to nothing are dropped.
        assert_eq!(parts.len(), 2);
        let tone: Tone = serde_json::from_str("\"down\"").unwrap();
        assert_eq!(tone, Tone::Down);
    }

    #[test]
    fn strips_control_characters() {
        assert_eq!(clip("a\u{7}b\nc"), "abc");
    }
}
