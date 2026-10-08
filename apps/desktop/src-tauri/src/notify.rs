//! Desktop notifications: the operating system's own, so a fill, an alert
//! or a liquidation warning lands while another app is in front. The page
//! decides what's worth one and sends the text; nothing here reads account
//! data, and the page gets no other access to the notification plugin.

use tauri::AppHandle;
use tauri_plugin_notification::NotificationExt;

/// The longest title and body shown, in characters.
const MAX_TITLE: usize = 80;
const MAX_BODY: usize = 240;

/// Makes macOS show the app's notifications properly. Call once, before the
/// first notification.
///
/// - A banner while the app is in front. macOS asks the notification
///   delegate whether to show one then, and the library's delegate has no
///   answer, which means no: "Send a test" would only ever reach
///   Notification Center. This adds the answer (yes).
/// - The app's own name on a development build. The plugin posts those as
///   Terminal; claiming the app's identifier first (it can be set once)
///   makes them PewterDesk's wherever the app is installed. Where it isn't,
///   this fails and the plugin's choice stands.
#[cfg(target_os = "macos")]
pub fn install(app: &AppHandle) {
    let _ = mac_notification_sys::set_application(&app.config().identifier);
    present_in_front();
}

/// Adds "show it even while the app is in front" to the library's
/// notification delegate. Returns whether the delegate now answers.
#[cfg(target_os = "macos")]
fn present_in_front() -> bool {
    use std::ffi::c_void;

    use objc2::ffi::class_addMethod;
    use objc2::runtime::{AnyClass, AnyObject, Bool, Imp, Sel};
    use objc2::sel;

    extern "C-unwind" fn should_present(
        _this: *mut AnyObject,
        _cmd: Sel,
        _center: *mut c_void,
        _notification: *mut c_void,
    ) -> Bool {
        Bool::YES
    }

    // The library's delegate class (`objc/notify.m`). If a later version
    // renames it, banners in front go missing again and nothing else does.
    let Some(class) = AnyClass::get(c"NotificationCenterDelegate") else {
        return false;
    };
    let selector = sel!(userNotificationCenter:shouldPresentNotification:);
    let function: extern "C-unwind" fn(*mut AnyObject, Sel, *mut c_void, *mut c_void) -> Bool =
        should_present;
    // BOOL is a C bool on Apple silicon and a signed char on Intel.
    let encoding = if cfg!(target_arch = "aarch64") {
        c"B@:@@"
    } else {
        c"c@:@@"
    };
    // SAFETY: `should_present` has the signature of
    // `-userNotificationCenter:shouldPresentNotification:` (BOOL, self,
    // _cmd, two objects, as `encoding` says), and adding a method the class
    // lacks is sound. If it already has one, this does nothing.
    unsafe {
        let imp: Imp = std::mem::transmute(function);
        class_addMethod(
            std::ptr::from_ref(class).cast_mut(),
            selector,
            imp,
            encoding.as_ptr(),
        );
    }
    class.instance_method(selector).is_some()
}

/// `text` without control characters, cut to `max` characters.
fn clip(text: &str, max: usize) -> String {
    text.chars().filter(|c| !c.is_control()).take(max).collect()
}

/// Shows a desktop notification. The text is bounded, and plain: the
/// system draws it, nothing in it is interpreted.
#[tauri::command]
pub fn notify(app: AppHandle, title: String, body: Option<String>) -> Result<(), String> {
    let title = clip(&title, MAX_TITLE);
    if title.is_empty() {
        return Ok(());
    }
    let mut notification = app.notification().builder().title(title);
    let body = body.map(|b| clip(&b, MAX_BODY)).unwrap_or_default();
    if !body.is_empty() {
        notification = notification.body(body);
    }
    notification
        .show()
        .map_err(|_| "couldn't show the notification".to_owned())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(target_os = "macos")]
    #[test]
    fn the_delegate_shows_banners_in_front() {
        assert!(present_in_front());
    }

    #[test]
    fn bounds_and_cleans_the_text() {
        assert_eq!(clip("Filled\n\u{7} Buy", 80), "Filled Buy");
        assert_eq!(clip(&"a".repeat(500), MAX_BODY).chars().count(), MAX_BODY);
    }
}
