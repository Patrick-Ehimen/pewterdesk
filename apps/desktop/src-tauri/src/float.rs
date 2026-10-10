//! The floating window: a small always-on-top widget (the same frontend, at
//! `#float`) that stays over other apps, on every Space, for watching and
//! trading without bringing the main window forward.
//!
//! Security-relevant - review against `.claude/commands/security-review.md`:
//! it's a second window that can reach the trading commands in `venues.rs`.
//! It adds none of its own: the commands here only show, hide, move and size
//! the window. It holds no key, and what it may sign is exactly what the
//! main window may. It's hidden from screen sharing unless the user turns
//! that off.

use std::sync::atomic::{AtomicBool, Ordering};

use tauri::{
    AppHandle, LogicalSize, Manager, PhysicalPosition, Runtime, WebviewUrl, WebviewWindow,
    WebviewWindowBuilder,
};

/// The window's label; the frontend renders the widget when loaded at `#float`.
pub const FLOAT_LABEL: &str = "float";
/// The size it opens at, before the page reports its own.
const START_WIDTH: f64 = 340.0;
const START_HEIGHT: f64 = 420.0;
/// Bounds for the size the page asks for (it fits its content).
const MIN_WIDTH: f64 = 160.0;
const MAX_WIDTH: f64 = 720.0;
const MIN_HEIGHT: f64 = 36.0;
const MAX_HEIGHT: f64 = 760.0;
/// Room kept between the window and a screen edge it sits against, in points.
const EDGE_GAP: f64 = 12.0;
/// How close to an edge a drag must end for the window to snap to it, in points.
const SNAP_WITHIN: f64 = 28.0;

/// Whether the window has been put somewhere yet; until then it opens in
/// the top-right corner.
#[derive(Default)]
pub struct FloatState {
    placed: AtomicBool,
}

/// A rectangle in physical pixels: a screen's usable area.
#[derive(Clone, Copy, Debug, PartialEq)]
struct Area {
    x: f64,
    y: f64,
    width: f64,
    height: f64,
}

/// One axis of a snap: `start` (the window's edge) pulled to either end of
/// the screen's span when it's within `within` of it, and kept inside it.
fn snap_axis(start: f64, len: f64, lo: f64, hi: f64, gap: f64, within: f64) -> f64 {
    let near = lo + gap;
    let far = hi - gap - len;
    if far < near {
        // Larger than the screen: pin it to the near edge.
        return near;
    }
    if (start - near).abs() <= within {
        near
    } else if (start - far).abs() <= within {
        far
    } else {
        start.clamp(near, far)
    }
}

/// Where a window of `size` at `pos` settles on `area`: pulled to an edge or
/// corner it was dropped near, and never off the screen.
fn snapped(pos: (f64, f64), size: (f64, f64), area: Area, gap: f64, within: f64) -> (f64, f64) {
    (
        snap_axis(pos.0, size.0, area.x, area.x + area.width, gap, within),
        snap_axis(pos.1, size.1, area.y, area.y + area.height, gap, within),
    )
}

/// Where the window goes when its size changes from `old` to `new`: an edge
/// resting against the right or bottom of the screen stays there, so growing
/// from the pill to the full widget doesn't push it off screen.
fn resized(pos: (f64, f64), old: (f64, f64), new: (f64, f64), area: Area, gap: f64) -> (f64, f64) {
    let right = area.x + area.width - gap;
    let bottom = area.y + area.height - gap;
    let x = if (pos.0 + old.0 - right).abs() <= 2.0 {
        right - new.0
    } else {
        pos.0
    };
    let y = if (pos.1 + old.1 - bottom).abs() <= 2.0 {
        bottom - new.1
    } else {
        pos.1
    };
    // Still on screen, without snapping anywhere new.
    snapped((x, y), new, area, gap, 0.0)
}

fn float<R: Runtime>(app: &AppHandle<R>) -> Option<WebviewWindow<R>> {
    app.get_webview_window(FLOAT_LABEL)
}

/// The usable area of the screen the window is on (or the main screen), and
/// that screen's scale factor.
fn screen<R: Runtime>(window: &WebviewWindow<R>) -> Option<(Area, f64)> {
    let monitor = window
        .current_monitor()
        .ok()
        .flatten()
        .or_else(|| window.primary_monitor().ok().flatten())?;
    let work = monitor.work_area();
    Some((
        Area {
            x: f64::from(work.position.x),
            y: f64::from(work.position.y),
            width: f64::from(work.size.width),
            height: f64::from(work.size.height),
        },
        monitor.scale_factor(),
    ))
}

fn geometry<R: Runtime>(window: &WebviewWindow<R>) -> Option<((f64, f64), (f64, f64))> {
    let pos = window.outer_position().ok()?;
    let size = window.outer_size().ok()?;
    Some((
        (f64::from(pos.x), f64::from(pos.y)),
        (f64::from(size.width), f64::from(size.height)),
    ))
}

fn move_to<R: Runtime>(window: &WebviewWindow<R>, pos: (f64, f64)) {
    let _ = window.set_position(PhysicalPosition::new(pos.0.round(), pos.1.round()));
}

pub fn install(app: &tauri::App) -> tauri::Result<()> {
    let name = app.handle().package_info().name.clone();
    let window =
        WebviewWindowBuilder::new(app, FLOAT_LABEL, WebviewUrl::App("index.html#float".into()))
            .title(format!("{name} floating window"))
            .inner_size(START_WIDTH, START_HEIGHT)
            .resizable(false)
            .decorations(false)
            // See-through, so the page's rounded card shapes the window.
            .transparent(true)
            .always_on_top(true)
            .skip_taskbar(true)
            .visible(false)
            .focused(false)
            .visible_on_all_workspaces(true)
            // The first click on it acts, rather than only bringing it forward.
            .accept_first_mouse(true)
            // Kept out of screen shares and recordings until the user says otherwise.
            .content_protected(true)
            .build()?;
    #[cfg(target_os = "macos")]
    crate::tray::float_over_everything(&window);
    #[cfg(not(target_os = "macos"))]
    let _ = window;
    app.manage(FloatState::default());
    Ok(())
}

/// Puts the window on screen where the user is - on macOS over a
/// full-screen app too, without bringing this app forward.
fn reveal<R: Runtime>(window: &WebviewWindow<R>) {
    #[cfg(target_os = "macos")]
    if crate::tray::show_in_place(window, false) {
        return;
    }
    let _ = window.show();
}

fn show<R: Runtime>(app: &AppHandle<R>) {
    let Some(window) = float(app) else {
        return;
    };
    let placed = app
        .try_state::<FloatState>()
        .is_some_and(|s| s.placed.swap(true, Ordering::Relaxed));
    if !placed {
        // First time: the top-right corner of the screen.
        if let (Some((area, scale)), Some((_, size))) = (screen(&window), geometry(&window)) {
            let gap = EDGE_GAP * scale;
            move_to(&window, (area.x + area.width - gap - size.0, area.y + gap));
        }
    }
    // Shown without taking focus: it's there to be glanced at.
    reveal(&window);
}

/// Shows the floating window, or hides it if it's showing. From the global
/// shortcut, the menu bar and the main window.
pub fn toggle<R: Runtime>(app: &AppHandle<R>) {
    match float(app) {
        Some(window) if window.is_visible().unwrap_or(false) => {
            let _ = window.hide();
        }
        Some(_) => show(app),
        None => {}
    }
}

#[tauri::command]
pub fn toggle_float(app: AppHandle) {
    toggle(&app);
}

/// From the widget itself: a risk alert brings it up over whatever is open.
#[tauri::command]
pub fn show_float(app: AppHandle) {
    show(&app);
}

/// From the widget: show it as a notification, in the top-right corner
/// where the system's own appear, if it isn't on screen already. Returns
/// whether this brought it up - then closing the notification hides it
/// again, rather than leaving the widget open where nobody asked for it.
#[tauri::command]
pub fn show_float_notice(app: AppHandle) -> bool {
    let Some(window) = float(&app) else {
        return false;
    };
    if window.is_visible().unwrap_or(false) {
        return false;
    }
    if let (Some((area, scale)), Some((_, size))) = (screen(&window), geometry(&window)) {
        let gap = EDGE_GAP * scale;
        move_to(&window, (area.x + area.width - gap - size.0, area.y + gap));
    }
    reveal(&window);
    true
}

#[tauri::command]
pub fn hide_float(app: AppHandle) {
    if let Some(window) = float(&app) {
        let _ = window.hide();
    }
}

/// From the widget: fit the window to its content (in points), within
/// bounds. An edge resting on the right or bottom of the screen stays put.
#[tauri::command]
pub fn resize_float(app: AppHandle, width: f64, height: f64) {
    let Some(window) = float(&app) else {
        return;
    };
    let bounded = |v: f64, lo: f64, hi: f64| if v.is_finite() { v.clamp(lo, hi) } else { lo };
    let width = bounded(width, MIN_WIDTH, MAX_WIDTH);
    // No taller than the screen it's on: the page scrolls past that.
    let tallest = screen(&window).map_or(MAX_HEIGHT, |(area, scale)| {
        (area.height / scale - 2.0 * EDGE_GAP).clamp(MIN_HEIGHT, MAX_HEIGHT)
    });
    let height = bounded(height, MIN_HEIGHT, tallest);
    let before = geometry(&window);
    let _ = window.set_size(LogicalSize::new(width, height));
    if let (Some((pos, old)), Some((area, scale))) = (before, screen(&window)) {
        let new = (width * scale, height * scale);
        move_to(&window, resized(pos, old, new, area, EDGE_GAP * scale));
    }
}

/// From the widget, once a drag has ended: snap to the edge or corner it was
/// dropped near. Returns where it settled, in physical pixels, for the page
/// to remember.
#[tauri::command]
pub fn snap_float(app: AppHandle) -> Option<(i32, i32)> {
    let window = float(&app)?;
    let (pos, size) = geometry(&window)?;
    let (area, scale) = screen(&window)?;
    let to = snapped(pos, size, area, EDGE_GAP * scale, SNAP_WITHIN * scale);
    if to != pos {
        move_to(&window, to);
    }
    Some((to.0.round() as i32, to.1.round() as i32))
}

/// From the widget, on start: go back to where it was last left, if that's
/// still on a screen (the display may have been unplugged since).
#[tauri::command]
pub fn place_float(app: AppHandle, x: i32, y: i32) {
    let Some(window) = float(&app) else {
        return;
    };
    let on_a_screen = window.available_monitors().is_ok_and(|monitors| {
        monitors.iter().any(|m| {
            let (p, s) = (m.position(), m.size());
            x >= p.x && y >= p.y && x < p.x + s.width as i32 && y < p.y + s.height as i32
        })
    });
    if !on_a_screen {
        return;
    }
    let _ = window.set_position(PhysicalPosition::new(x, y));
    if let Some(state) = app.try_state::<FloatState>() {
        state.placed.store(true, Ordering::Relaxed);
    }
}

/// From the widget: whether screen shares and recordings can see it.
#[tauri::command]
pub fn set_float_protected(app: AppHandle, protected: bool) {
    if let Some(window) = float(&app) {
        let _ = window.set_content_protected(protected);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const SCREEN: Area = Area {
        x: 0.0,
        y: 25.0,
        width: 1440.0,
        height: 875.0,
    };

    #[test]
    fn snaps_to_a_corner_it_was_dropped_near() {
        // Near the top-right corner: pulled into it, a gap from each edge.
        let to = snapped((1080.0, 40.0), (340.0, 400.0), SCREEN, 12.0, 28.0);
        assert_eq!(to, (1088.0, 37.0));
    }

    #[test]
    fn leaves_it_where_it_was_dropped_in_the_open() {
        let to = snapped((500.0, 300.0), (340.0, 400.0), SCREEN, 12.0, 28.0);
        assert_eq!(to, (500.0, 300.0));
    }

    #[test]
    fn never_ends_up_off_the_screen() {
        let to = snapped((2000.0, -300.0), (340.0, 400.0), SCREEN, 12.0, 28.0);
        assert_eq!(to, (1088.0, 37.0));
        // Wider than the screen: pinned to the near edge.
        let wide = snapped((50.0, 100.0), (3000.0, 100.0), SCREEN, 12.0, 28.0);
        assert_eq!(wide.0, 12.0);
    }

    #[test]
    fn keeps_the_right_and_bottom_edges_when_resized() {
        // The pill, in the bottom-right corner, growing into the full widget.
        let pill = (330.0, 44.0);
        let pos = (1440.0 - 12.0 - 330.0, 900.0 - 12.0 - 44.0);
        let to = resized(pos, pill, (340.0, 420.0), SCREEN, 12.0);
        assert_eq!(to, (1440.0 - 12.0 - 340.0, 900.0 - 12.0 - 420.0));
        // In the open, the top-left corner is what stays.
        let free = resized((200.0, 200.0), pill, (340.0, 420.0), SCREEN, 12.0);
        assert_eq!(free, (200.0, 200.0));
    }
}
