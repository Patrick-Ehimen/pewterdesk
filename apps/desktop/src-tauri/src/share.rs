//! Saving a P&L share card to the Downloads folder. The page draws the card
//! and sends its PNG bytes; Rust checks they're a PNG of sensible size and
//! writes them under a name it chooses - the page picks neither the folder
//! nor the file name.

use std::time::{SystemTime, UNIX_EPOCH};

use tauri::ipc::{InvokeBody, Request};
use tauri::{AppHandle, Manager};

/// The eight bytes every PNG starts with.
const PNG_SIGNATURE: [u8; 8] = [0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A];
/// A share card is a few hundred KB; anything past this isn't one.
const MAX_BYTES: usize = 20 * 1024 * 1024;

/// Whether `bytes` look like a PNG worth saving.
fn is_png(bytes: &[u8]) -> bool {
    bytes.len() > PNG_SIGNATURE.len()
        && bytes.len() <= MAX_BYTES
        && bytes.starts_with(&PNG_SIGNATURE)
}

/// Saves the PNG in the request body to Downloads as
/// `pewterdesk-pnl-<ms>.png`, and returns where it went.
#[tauri::command]
pub async fn save_share_image(app: AppHandle, request: Request<'_>) -> Result<String, String> {
    let InvokeBody::Raw(bytes) = request.body() else {
        return Err("expected the image's bytes".into());
    };
    if !is_png(bytes) {
        return Err("that isn't a PNG image".into());
    }
    let dir = app
        .path()
        .download_dir()
        .map_err(|_| "couldn't find the Downloads folder".to_owned())?;
    let ms = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| d.as_millis());
    let path = dir.join(format!("pewterdesk-pnl-{ms}.png"));
    let bytes = bytes.clone();
    let target = path.clone();
    tauri::async_runtime::spawn_blocking(move || std::fs::write(&target, bytes))
        .await
        .map_err(|_| "couldn't save the image".to_owned())?
        .map_err(|_| "couldn't save the image".to_owned())?;
    Ok(path.display().to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_pngs_are_saved() {
        let mut png = PNG_SIGNATURE.to_vec();
        png.extend_from_slice(b"rest of the image");
        assert!(is_png(&png));
        assert!(!is_png(&PNG_SIGNATURE));
        assert!(!is_png(b"GIF89a not a png at all"));
        assert!(!is_png(b""));
        let mut huge = PNG_SIGNATURE.to_vec();
        huge.resize(MAX_BYTES + 1, 0);
        assert!(!is_png(&huge));
    }
}
