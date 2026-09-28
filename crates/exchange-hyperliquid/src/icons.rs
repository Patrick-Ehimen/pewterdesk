//! Market logos, from the same asset path Hyperliquid's own web app uses.
//! It isn't a documented API, so anything unexpected is treated as "no logo".

/// Anything bigger isn't a coin logo. The largest seen are around 25 KB.
pub const MAX_ICON_BYTES: usize = 256 * 1024;

/// The file name for `market`'s logo, or `None` for names that can't have
/// one. Only an alphanumeric coin, optionally behind one alphanumeric
/// builder-exchange prefix ("xyz:TSLA"), passes, so a market id can never
/// change the request's path. Main-exchange markets quoted per thousand
/// (`kPEPE`) use the plain coin's logo (`PEPE`).
pub fn icon_name(market: &str) -> Option<&str> {
    let plain = |s: &str| !s.is_empty() && s.chars().all(|c| c.is_ascii_alphanumeric());
    if let Some((dex, coin)) = market.split_once(':') {
        // The web app names builder logos by the full id.
        return (plain(dex) && plain(coin)).then_some(market);
    }
    if !plain(market) {
        return None;
    }
    match market.strip_prefix('k') {
        Some(rest) if rest.starts_with(|c: char| c.is_ascii_uppercase()) => Some(rest),
        _ => Some(market),
    }
}

/// The body as SVG markup if it is one. An unknown coin gets the web app's
/// HTML page with a 200, so the content type and the markup are both checked.
pub fn as_svg(content_type: Option<&str>, body: &[u8]) -> Option<String> {
    let is_svg = content_type.is_some_and(|t| t.trim().starts_with("image/svg+xml"));
    if !is_svg || body.len() > MAX_ICON_BYTES {
        return None;
    }
    let text = std::str::from_utf8(body).ok()?;
    let start = text.trim_start();
    (start.starts_with("<svg") || start.starts_with("<?xml")).then(|| text.to_owned())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn maps_market_ids_to_logo_names() {
        assert_eq!(icon_name("BTC"), Some("BTC"));
        assert_eq!(icon_name("kPEPE"), Some("PEPE"));
        // A coin that merely starts with a lowercase k keeps its name.
        assert_eq!(icon_name("kaito"), Some("kaito"));
        assert_eq!(icon_name("0G"), Some("0G"));
        assert_eq!(icon_name("xyz:TSLA"), Some("xyz:TSLA"));
    }

    #[test]
    fn rejects_names_that_could_change_the_path() {
        for id in [
            "", "../info", ":TSLA", "xyz:", "a:b:c", "xyz:../x", "x/y:TSLA", "BTC/..", "BTC?x=1",
            "BTC.svg", "BT C",
        ] {
            assert_eq!(icon_name(id), None, "{id}");
        }
    }

    #[test]
    fn accepts_only_svg() {
        let svg = br#"<svg xmlns="http://www.w3.org/2000/svg"/>"#;
        assert!(as_svg(Some("image/svg+xml"), svg).is_some());
        assert!(as_svg(
            Some("image/svg+xml; charset=utf-8"),
            b"<?xml version=\"1.0\"?><svg/>"
        )
        .is_some());
        // The web app's fallback page for unknown coins.
        assert_eq!(as_svg(Some("text/html"), b"<!doctype html><html>"), None);
        assert_eq!(
            as_svg(Some("image/svg+xml"), b"<!doctype html><html>"),
            None
        );
        assert_eq!(as_svg(None, svg), None);
        assert_eq!(as_svg(Some("image/svg+xml"), &[0xff, 0xfe]), None);
    }

    #[test]
    fn rejects_oversized_bodies() {
        let mut big = b"<svg>".to_vec();
        big.resize(MAX_ICON_BYTES + 1, b' ');
        assert_eq!(as_svg(Some("image/svg+xml"), &big), None);
    }
}
