//! Desktop notifications: the operating system's own, so a fill, an alert
//! or a liquidation warning lands while another app is in front. The page
//! decides what's worth one and sends the text; nothing here reads account
//! data, and the page gets no other access to the notification plugin.

use tauri::AppHandle;
use tauri_plugin_notification::NotificationExt;

/// The longest title and body shown, in characters.
const MAX_TITLE: usize = 80;
const MAX_BODY: usize = 240;

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

    #[test]
    fn bounds_and_cleans_the_text() {
        assert_eq!(clip("Filled\n\u{7} Buy", 80), "Filled Buy");
        assert_eq!(clip(&"a".repeat(500), MAX_BODY).chars().count(), MAX_BODY);
    }
}
