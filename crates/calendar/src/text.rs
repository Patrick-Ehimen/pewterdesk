//! Somebody else's text, made safe to show: entities read, markup and
//! control characters dropped, lengths bounded. Shared by the news feeds,
//! the news wire and the economic calendar.

/// The character an entity stands for: `amp`, `#8217`, `#x2019`, and the
/// few named ones feeds use. Anything else isn't one.
fn entity(name: &str) -> Option<char> {
    if let Some(number) = name.strip_prefix('#') {
        let code = match number.strip_prefix(['x', 'X']) {
            Some(hex) => u32::from_str_radix(hex, 16).ok()?,
            None => number.parse().ok()?,
        };
        return char::from_u32(code);
    }
    Some(match name {
        "amp" => '&',
        "lt" => '<',
        "gt" => '>',
        "quot" => '"',
        "apos" => '\'',
        "nbsp" => ' ',
        "rsquo" => '\u{2019}',
        "lsquo" => '\u{2018}',
        "rdquo" => '\u{201d}',
        "ldquo" => '\u{201c}',
        "mdash" => '\u{2014}',
        "ndash" => '\u{2013}',
        "hellip" => '\u{2026}',
        _ => return None,
    })
}

/// `text` with its entities read ("&amp;" to "&").
pub fn unescape(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(at) = rest.find('&') {
        out.push_str(&rest[..at]);
        let after = &rest[at + 1..];
        let found = after
            .find(';')
            .filter(|end| *end <= 10)
            .and_then(|end| entity(&after[..end]).map(|ch| (ch, end)));
        match found {
            Some((ch, end)) => {
                out.push(ch);
                rest = &after[end + 1..];
            }
            None => {
                out.push('&');
                rest = after;
            }
        }
    }
    out.push_str(rest);
    out
}

/// Feed text as plain text: tags dropped, entities read, control characters
/// removed, runs of spaces closed up, and at most `max` characters.
pub fn plain(text: &str, max: usize) -> String {
    // Entities first where the markup itself came escaped ("&lt;p&gt;").
    let text = unescape(text);
    let mut bare = String::with_capacity(text.len());
    let mut in_tag = false;
    for ch in text.chars() {
        match ch {
            '<' => in_tag = true,
            '>' if in_tag => {
                in_tag = false;
                bare.push(' ');
            }
            _ if !in_tag => bare.push(ch),
            _ => {}
        }
    }
    let bare = unescape(&bare);
    let words: Vec<&str> = bare
        .split(|c: char| c.is_whitespace() || c.is_control())
        .filter(|w| !w.is_empty())
        .collect();
    words.join(" ").chars().take(max).collect()
}

/// Days from 1970-01-01 to a date (the proleptic Gregorian calendar).
pub fn days_from_civil(year: i64, month: i64, day: i64) -> i64 {
    let y = if month <= 2 { year - 1 } else { year };
    let era = y.div_euclid(400);
    let yoe = y.rem_euclid(400);
    let doy = (153 * (month + if month > 2 { -3 } else { 9 }) + 2) / 5 + day - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn strips_markup_and_bounds_text() {
        assert_eq!(plain("&lt;b&gt;Bold&lt;/b&gt; move", 80), "Bold move");
        assert_eq!(plain("a\u{7}\n\n  b", 80), "a b");
        assert_eq!(
            plain("AT&T & co &bogus; done", 80),
            "AT&T & co &bogus; done"
        );
        assert_eq!(plain(&"x".repeat(900), 300).chars().count(), 300);
    }

    #[test]
    fn counts_days_from_the_epoch() {
        assert_eq!(days_from_civil(1970, 1, 1), 0);
        assert_eq!(days_from_civil(2000, 3, 1), 11_017);
    }
}
