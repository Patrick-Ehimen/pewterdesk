//! Market logos. Bybit lists each coin's logo in its convert coin list
//! (`GET /v5/asset/exchange/query-coin-list`, a signed, read-only request),
//! as a file on its image host. The file names are hashes, so a logo can
//! only be found through that list.
//!
//! The adapter contract returns SVG markup. Bybit's logos are mostly SVG
//! already; a PNG, JPEG or WebP is wrapped in a one-element SVG that embeds
//! it as a `data:` URL. The UI shows either only through an `<img>`, where
//! nothing in it can run or load anything.

use std::collections::HashMap;

use serde::Deserialize;

/// Anything bigger isn't a coin logo.
pub const MAX_ICON_BYTES: usize = 256 * 1024;

/// The `result` of the convert coin list: only the logos are read.
#[derive(Deserialize)]
pub struct CoinList {
    #[serde(default)]
    pub coins: Vec<ListedCoin>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ListedCoin {
    #[serde(default)]
    pub coin: String,
    #[serde(default)]
    pub icon: String,
    /// The same logo drawn for a dark background.
    #[serde(default)]
    pub icon_night: String,
}

/// Logo URL by coin, keeping only those on `host` (Bybit's image host): a
/// logo listed anywhere else is ignored rather than fetched. The app is
/// dark by default, so the dark-background drawing is preferred.
pub fn logo_urls(list: CoinList, host: &str) -> HashMap<String, String> {
    let prefix = format!("{host}/");
    let on_host = |url: &str| {
        url.strip_prefix(&prefix).is_some_and(|path| {
            !path.is_empty() && !path.contains(['?', '#', '\\', ' ']) && !path.contains("..")
        })
    };
    list.coins
        .into_iter()
        .filter_map(|c| {
            let url = [c.icon_night, c.icon].into_iter().find(|u| on_host(u))?;
            (!c.coin.is_empty()).then(|| (c.coin.to_uppercase(), url))
        })
        .collect()
}

/// The coin behind a multiplied one: `1000PEPE` is `PEPE`. `None` for a
/// plain coin.
pub fn unmultiplied(base: &str) -> Option<&str> {
    ["1000000", "100000", "10000", "1000", "100"]
        .iter()
        .find_map(|m| base.strip_prefix(m))
        .filter(|coin| coin.starts_with(|c: char| c.is_ascii_alphabetic()))
}

/// The image's type from its first bytes: the raster formats a logo may be.
fn raster_type(bytes: &[u8]) -> Option<&'static str> {
    if bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
        Some("image/png")
    } else if bytes.starts_with(&[0xFF, 0xD8, 0xFF]) {
        Some("image/jpeg")
    } else if bytes.len() > 12 && &bytes[..4] == b"RIFF" && &bytes[8..12] == b"WEBP" {
        Some("image/webp")
    } else {
        None
    }
}

/// The body as SVG markup: an SVG as it is (by its content type and its
/// markup both), a raster image wrapped in one. `None` for anything else,
/// or anything too big to be a logo.
pub fn as_svg(content_type: Option<&str>, body: &[u8]) -> Option<String> {
    if body.len() > MAX_ICON_BYTES {
        return None;
    }
    if let Some(mime) = raster_type(body) {
        return Some(format!(
            r#"<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><image width="64" height="64" href="data:{mime};base64,{}"/></svg>"#,
            base64(body)
        ));
    }
    if !content_type.is_some_and(|t| t.trim().starts_with("image/svg+xml")) {
        return None;
    }
    let text = std::str::from_utf8(body).ok()?;
    let start = text.trim_start();
    (start.starts_with("<svg") || start.starts_with("<?xml")).then(|| text.to_owned())
}

/// Standard base64 with padding (RFC 4648).
fn base64(bytes: &[u8]) -> String {
    const ALPHABET: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let n = (u32::from(chunk[0]) << 16)
            | (u32::from(*chunk.get(1).unwrap_or(&0)) << 8)
            | u32::from(*chunk.get(2).unwrap_or(&0));
        let sextets = [n >> 18, n >> 12, n >> 6, n];
        for (i, s) in sextets.iter().enumerate() {
            if i <= chunk.len() {
                out.push(ALPHABET[(s & 63) as usize] as char);
            } else {
                out.push('=');
            }
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    const HOST: &str = "https://t1.bycsi.com";

    fn list(json: serde_json::Value) -> CoinList {
        serde_json::from_value(json).unwrap()
    }

    #[test]
    fn reads_logos_on_the_image_host_only() {
        let urls = logo_urls(
            list(serde_json::json!({ "coins": [
                { "coin": "BTC", "fullName": "BTC", "balance": "0.5",
                  "icon": "https://t1.bycsi.com/app/assets/token/day.svg",
                  "iconNight": "https://t1.bycsi.com/app/assets/token/night.svg" },
                { "coin": "eth", "icon": "https://t1.bycsi.com/app/assets/token/eth.svg", "iconNight": "" },
                // Somewhere else, a look-alike host, a path that climbs, a query: all ignored.
                { "coin": "A", "icon": "https://evil.example/a.svg" },
                { "coin": "B", "icon": "https://t1.bycsi.com.evil.example/b.svg" },
                { "coin": "C", "icon": "https://t1.bycsi.com/../c.svg" },
                { "coin": "D", "icon": "https://t1.bycsi.com/d.svg?x=1" },
                { "coin": "E", "icon": "http://t1.bycsi.com/e.svg" },
                { "coin": "", "icon": "https://t1.bycsi.com/app/assets/token/x.svg" }
            ]})),
            HOST,
        );
        assert_eq!(urls.len(), 2);
        assert_eq!(
            urls["BTC"],
            "https://t1.bycsi.com/app/assets/token/night.svg"
        );
        assert_eq!(urls["ETH"], "https://t1.bycsi.com/app/assets/token/eth.svg");
    }

    #[test]
    fn tolerates_an_empty_or_odd_list() {
        assert!(logo_urls(list(serde_json::json!({})), HOST).is_empty());
        assert!(logo_urls(list(serde_json::json!({ "coins": [{}] })), HOST).is_empty());
    }

    #[test]
    fn finds_the_coin_behind_a_multiplied_one() {
        assert_eq!(unmultiplied("1000PEPE"), Some("PEPE"));
        assert_eq!(unmultiplied("1000000MOG"), Some("MOG"));
        assert_eq!(unmultiplied("BTC"), None);
        // A name that is only digits after the multiplier isn't one.
        assert_eq!(unmultiplied("1000"), None);
        assert_eq!(unmultiplied("10001"), None);
    }

    #[test]
    fn accepts_svg_and_wraps_raster_images() {
        let svg = br#"<svg xmlns="http://www.w3.org/2000/svg"/>"#;
        assert_eq!(
            as_svg(Some("image/svg+xml"), svg).as_deref(),
            std::str::from_utf8(svg).ok()
        );
        let png = b"\x89PNG\r\n\x1a\nrest";
        let wrapped = as_svg(Some("image/png"), png).unwrap();
        assert!(
            wrapped.starts_with("<svg")
                && wrapped.contains("data:image/png;base64,iVBORw0KGgpyZXN0")
        );

        // An error page, markup without the type, and something far too big.
        assert_eq!(as_svg(Some("text/html"), b"<html>denied</html>"), None);
        assert_eq!(as_svg(None, svg), None);
        assert_eq!(as_svg(Some("image/svg+xml"), b"<html>"), None);
        let mut huge = b"\x89PNG\r\n\x1a\n".to_vec();
        huge.resize(MAX_ICON_BYTES + 1, 0);
        assert_eq!(as_svg(Some("image/png"), &huge), None);
    }
}
