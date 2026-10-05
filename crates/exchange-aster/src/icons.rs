//! Market logos. Aster lists every asset's logo (`all-asset-logo`, on its web
//! API) as a PNG on its image host. The adapter contract returns SVG markup,
//! so a downloaded image is wrapped in a one-element SVG that embeds it as a
//! `data:` URL. The UI shows that SVG only through an `<img>`, where nothing
//! in it can run or load anything; embedding keeps it self-contained.

/// A logo larger than this isn't one; Aster's are about 1 KB.
pub const MAX_ICON_BYTES: usize = 64 * 1024;

/// The coin a market's name starts with, for a market Aster doesn't list:
/// `ZECUSDT` is `ZEC`. `None` when the name has no quote coin on the end.
pub fn base_of(market: &str) -> Option<&str> {
    ["USDT", "USDC", "USD1", "USD"]
        .iter()
        .find_map(|quote| market.strip_suffix(quote))
        .filter(|base| !base.is_empty())
}

/// The image's type from its first bytes: only the raster formats Aster uses.
pub fn raster_type(bytes: &[u8]) -> Option<&'static str> {
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

/// `bytes` as an SVG, or `None` if they aren't a PNG, JPEG or WebP image
/// within the size cap.
pub fn as_svg(bytes: &[u8]) -> Option<String> {
    if bytes.len() > MAX_ICON_BYTES {
        return None;
    }
    let mime = raster_type(bytes)?;
    Some(format!(
        r#"<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><image width="64" height="64" href="data:{mime};base64,{}"/></svg>"#,
        base64(bytes)
    ))
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

    #[test]
    fn encodes_base64_like_rfc_4648() {
        assert_eq!(base64(b""), "");
        assert_eq!(base64(b"f"), "Zg==");
        assert_eq!(base64(b"fo"), "Zm8=");
        assert_eq!(base64(b"foo"), "Zm9v");
        assert_eq!(base64(b"foobar"), "Zm9vYmFy");
        assert_eq!(base64(&[0xFF, 0xFE]), "//4=");
    }

    #[test]
    fn wraps_a_png_and_nothing_else() {
        let png = b"\x89PNG\r\n\x1a\nrest";
        let svg = as_svg(png).unwrap();
        assert!(svg.starts_with("<svg"));
        assert!(svg.contains("href=\"data:image/png;base64,iVBORw0KGgpyZXN0\""));

        assert_eq!(as_svg(b"<svg onload=\"x()\"></svg>"), None);
        assert_eq!(as_svg(b"<html>not found</html>"), None);
        let mut huge = b"\x89PNG\r\n\x1a\n".to_vec();
        huge.resize(MAX_ICON_BYTES + 1, 0);
        assert_eq!(as_svg(&huge), None);
    }

    #[test]
    fn knows_jpeg_and_webp() {
        assert_eq!(raster_type(&[0xFF, 0xD8, 0xFF, 0xE0]), Some("image/jpeg"));
        assert_eq!(raster_type(b"RIFF\0\0\0\0WEBPVP8 "), Some("image/webp"));
        assert_eq!(raster_type(b"GIF89a"), None);
    }

    #[test]
    fn reads_the_coin_off_a_market_name() {
        assert_eq!(base_of("ZECUSDT"), Some("ZEC"));
        assert_eq!(base_of("BTCUSD1"), Some("BTC"));
        assert_eq!(base_of("USDT"), None);
        assert_eq!(base_of("BTCPERP"), None);
    }
}
