//! Saving a P&L share card to the Downloads folder, and opening a social
//! site to post it. The page draws the card and sends its PNG bytes; Rust
//! checks they're a PNG of sensible size and writes them under a name it
//! chooses - the page picks neither the folder nor the file name.
//!
//! Sharing opens one of a fixed set of sites' post pages in the browser. The
//! page names the site and the caption; Rust builds the URL itself, the
//! caption percent-encoded into the one query value, so the page can't open
//! any other address. The image goes by the clipboard (the page copies it
//! first): no site's share link carries an image.

use std::time::{SystemTime, UNIX_EPOCH};

use serde::Deserialize;
use tauri::ipc::{InvokeBody, Request};
use tauri::{AppHandle, Manager};

use crate::about::open_url;

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

/// The sites a card can be shared to.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ShareTarget {
    X,
    Whatsapp,
    Telegram,
    Facebook,
    Instagram,
    Linkedin,
    Reddit,
    Line,
}

/// The longest caption passed on; longer ones are cut, on a character boundary.
const MAX_CAPTION: usize = 500;

/// `text` percent-encoded for a query value: everything but the unreserved
/// characters, so the URL holds nothing a shell or a URL parser reads specially.
fn encode(text: &str) -> String {
    let mut out = String::with_capacity(text.len() * 3);
    for b in text.bytes() {
        if b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'.' | b'~') {
            out.push(b as char);
        } else {
            out.push_str(&format!("%{b:02X}"));
        }
    }
    out
}

/// The caption as passed on: control characters (other than newlines) dropped,
/// trimmed, and cut to `MAX_CAPTION` characters.
fn caption(text: &str) -> String {
    text.chars()
        .filter(|c| *c == '\n' || !c.is_control())
        .collect::<String>()
        .trim()
        .chars()
        .take(MAX_CAPTION)
        .collect()
}

/// The post page for `target`, with the caption where the site takes one.
/// Each URL carries at most one query value, so no `&` (which the Windows
/// shell would read as a second command).
fn share_url(target: ShareTarget, text: &str) -> String {
    let text = encode(&caption(text));
    match target {
        ShareTarget::X => format!("https://x.com/intent/post?text={text}"),
        ShareTarget::Whatsapp => format!("https://wa.me/?text={text}"),
        ShareTarget::Telegram => format!("https://t.me/share/url?url={text}"),
        ShareTarget::Reddit => format!("https://www.reddit.com/submit?title={text}"),
        ShareTarget::Line => format!("https://line.me/R/share?text={text}"),
        // These take no caption in a link: the composer opens, and the
        // image and text are pasted in.
        ShareTarget::Linkedin => "https://www.linkedin.com/feed/?shareActive=true".to_owned(),
        ShareTarget::Facebook => "https://www.facebook.com/".to_owned(),
        ShareTarget::Instagram => "https://www.instagram.com/".to_owned(),
    }
}

/// Opens `target`'s post page in the system browser, with `text` as the
/// caption where the site takes one.
#[tauri::command]
pub fn open_share(target: ShareTarget, text: String) -> Result<(), String> {
    open_url(&share_url(target, &text))
}

#[cfg(test)]
mod tests {
    use super::*;

    const ALL: [ShareTarget; 8] = [
        ShareTarget::X,
        ShareTarget::Whatsapp,
        ShareTarget::Telegram,
        ShareTarget::Facebook,
        ShareTarget::Instagram,
        ShareTarget::Linkedin,
        ShareTarget::Reddit,
        ShareTarget::Line,
    ];
    const HOSTS: [&str; 8] = [
        "https://x.com/",
        "https://wa.me/",
        "https://t.me/",
        "https://www.facebook.com/",
        "https://www.instagram.com/",
        "https://www.linkedin.com/",
        "https://www.reddit.com/",
        "https://line.me/",
    ];

    #[test]
    fn a_caption_cant_change_where_it_goes() {
        let hostile = "a&b=c https://evil.example/?x#frag \"quoted\" <tag> | ^ % \u{0007}\n✓";
        for (target, host) in ALL.into_iter().zip(HOSTS) {
            let url = share_url(target, hostile);
            assert!(url.starts_with(host), "{url}");
            // Nothing the Windows shell or a URL parser reads specially, and
            // at most one query value.
            assert!(
                !url.contains(['&', '|', '^', '<', '>', '"', ' ', '#', '\n']),
                "{url}"
            );
            assert!(url.matches('?').count() <= 1, "{url}");
            assert!(!url.contains("evil.example/"), "{url}");
        }
    }

    #[test]
    fn captions_are_encoded_cleaned_and_capped() {
        assert_eq!(encode("+9.10% ROI"), "%2B9.10%25%20ROI");
        assert_eq!(caption("  hi\u{0007} there\n "), "hi there");
        assert_eq!(caption(&"✓".repeat(900)).chars().count(), MAX_CAPTION);
        assert_eq!(
            share_url(ShareTarget::X, "BTC +5%"),
            "https://x.com/intent/post?text=BTC%20%2B5%25"
        );
    }

    #[test]
    fn only_named_sites_are_accepted() {
        let parse = |s: &str| serde_json::from_str::<ShareTarget>(s);
        assert_eq!(parse("\"whatsapp\"").unwrap(), ShareTarget::Whatsapp);
        assert!(parse("\"https://evil.example\"").is_err());
        assert!(parse("\"X\"").is_err());
    }

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
