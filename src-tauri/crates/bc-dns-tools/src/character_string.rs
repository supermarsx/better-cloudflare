//! DNS `<character-string>` presentation format (RFC 1035 §3.3, §5.1).
//!
//! Record types whose RDATA is built from character-strings (TXT and the
//! TXT-shaped helpers SPF / DKIM / DMARC) are written in *presentation
//! format*: the payload may be bare, wrapped in double quotes, or expressed as
//! several adjacent quoted strings that concatenate into one logical value.
//!
//! This is the Rust mirror of `src/lib/dns/character-string.ts`. Semantic
//! parsers must call [`unquote_character_string`] before inspecting a payload,
//! so that quoted and unquoted input behave identically — otherwise a zone
//! that publishes `"v=spf1 mx -all"` reads as having no SPF record at all.

/// Decode a single `\X` / `\DDD` escape starting at `index`.
///
/// Returns the decoded text and the index just past the escape.
fn decode_escape_at(input: &[char], index: usize) -> (String, usize) {
    if index + 4 <= input.len() {
        let digits: String = input[index + 1..index + 4].iter().collect();
        if digits.len() == 3 && digits.chars().all(|c| c.is_ascii_digit()) {
            if let Ok(octet) = digits.parse::<u32>() {
                if octet <= 255 {
                    if let Some(decoded) = char::from_u32(octet) {
                        return (decoded.to_string(), index + 4);
                    }
                }
            }
        }
    }
    match input.get(index + 1) {
        None => ("\\".to_string(), index + 1),
        Some(next) => (next.to_string(), index + 2),
    }
}

/// Decode every escape sequence in `value`.
fn decode_escapes(value: &[char]) -> String {
    if !value.contains(&'\\') {
        return value.iter().collect();
    }
    let mut decoded = String::new();
    let mut index = 0;
    while index < value.len() {
        if value[index] == '\\' {
            let (text, next) = decode_escape_at(value, index);
            decoded.push_str(&text);
            index = next;
            continue;
        }
        decoded.push(value[index]);
        index += 1;
    }
    decoded
}

/// Count unescaped quotes and remember the position of the last one.
fn scan_quotes(value: &[char]) -> (usize, Option<usize>) {
    let mut count = 0usize;
    let mut last_index = None;
    let mut index = 0;
    while index < value.len() {
        if value[index] == '\\' {
            index += 2;
            continue;
        }
        if value[index] == '"' {
            count += 1;
            last_index = Some(index);
        }
        index += 1;
    }
    (count, last_index)
}

/// Whether `value` uses the quoted presentation form, including the damaged
/// shapes with only a leading or only a trailing quote.
fn is_quoted_form(value: &[char]) -> bool {
    if value.is_empty() {
        return false;
    }
    if value[0] == '"' {
        return true;
    }
    let (count, last_index) = scan_quotes(value);
    count % 2 == 1 && last_index == Some(value.len() - 1)
}

/// Read one quoted run starting just after its opening quote.
fn scan_quoted_run(input: &[char], start: usize) -> (String, usize, bool) {
    let mut value = String::new();
    let mut index = start;
    while index < input.len() {
        let character = input[index];
        if character == '\\' {
            let (text, next) = decode_escape_at(input, index);
            value.push_str(&text);
            index = next;
            continue;
        }
        if character == '"' {
            return (value, index + 1, true);
        }
        value.push(character);
        index += 1;
    }
    // Unmatched opening quote: repair by closing the string at end of input.
    (value, index, false)
}

/// Read one bare (unquoted) run up to the next unescaped quote.
fn scan_bare_run(input: &[char], start: usize) -> (String, usize) {
    let mut raw: Vec<char> = Vec::new();
    let mut index = start;
    while index < input.len() {
        let character = input[index];
        if character == '"' {
            break;
        }
        if character == '\\' {
            raw.extend_from_slice(&input[index..input.len().min(index + 2)]);
            index += 2;
            continue;
        }
        raw.push(character);
        index += 1;
    }
    (decode_escapes(&raw).trim().to_string(), index)
}

/// Parse presentation-format content into its logical character-strings.
///
/// Accepted shapes, all decoded to the same logical value:
/// - bare: `v=spf1 mx -all` → one string, kept verbatim
/// - quoted: `"v=spf1 mx -all"`
/// - adjacent strings: `"v=spf1 " "mx -all"` → two strings
/// - unmatched leading or trailing quote → repaired rather than rejected
pub fn parse_character_strings(raw: &str) -> Vec<String> {
    let trimmed: Vec<char> = raw.trim().chars().collect();
    if trimmed.is_empty() {
        return Vec::new();
    }

    if trimmed[0] != '"' {
        // Bare content is a single character-string: whitespace does not split it.
        if is_quoted_form(&trimmed) {
            // Unmatched trailing quote: repair by treating it as a quoted run.
            return vec![decode_escapes(&trimmed[..trimmed.len() - 1])];
        }
        return vec![trimmed.iter().collect()];
    }

    let mut parts = Vec::new();
    let mut index = 0;
    while index < trimmed.len() {
        let character = trimmed[index];
        if character.is_whitespace() {
            index += 1;
            continue;
        }
        if character == '"' {
            let (value, next, closed) = scan_quoted_run(&trimmed, index + 1);
            index = next;
            if closed || !value.is_empty() {
                parts.push(value);
            }
            continue;
        }
        let (value, next) = scan_bare_run(&trimmed, index);
        index = next;
        if !value.is_empty() {
            parts.push(value);
        }
    }
    parts
}

/// The logical value of presentation-format content: adjacent character-strings
/// concatenate without a separator, exactly like a resolver joins TXT strings.
///
/// Semantic parsers (SPF, DMARC, DKIM, …) should call this before inspecting
/// the payload so quoted and unquoted input behave identically.
pub fn unquote_character_string(raw: &str) -> String {
    parse_character_strings(raw).join("")
}

/// Whether a TXT payload is an SPF record.
///
/// The single SPF detector on the Rust side, mirroring `isSpfRecord` in
/// `src/lib/dns/spf.ts`. It lives here rather than in `bc-spf` because it needs
/// [`unquote_character_string`], and `bc-dns-tools` already depends on
/// `bc-spf` — the reverse edge would be a dependency cycle.
///
/// RFC 7208 §4.5: the version section is `v=spf1` followed by whitespace or the
/// end of the record, so `v=spf1foo` is a different record that merely shares a
/// prefix. Content may be bare, quoted, or split into adjacent
/// character-strings; all forms answer identically.
pub fn is_spf_record(content: &str) -> bool {
    let value = unquote_character_string(content);
    let value = value.trim();
    let Some(rest) = value.get(..6) else {
        return false;
    };
    if !rest.eq_ignore_ascii_case("v=spf1") {
        return false;
    }
    match value[6..].chars().next() {
        None => true,
        Some(next) => next.is_whitespace(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bare_content_is_returned_verbatim() {
        assert_eq!(unquote_character_string("v=spf1 mx -all"), "v=spf1 mx -all");
    }

    #[test]
    fn quoted_content_loses_its_quotes() {
        assert_eq!(
            unquote_character_string("\"v=spf1 mx -all\""),
            "v=spf1 mx -all"
        );
        assert_eq!(
            unquote_character_string("   \"v=spf1 mx -all\"  "),
            "v=spf1 mx -all"
        );
    }

    #[test]
    fn adjacent_character_strings_concatenate_without_a_separator() {
        assert_eq!(
            unquote_character_string("\"v=spf1 \" \"mx -all\""),
            "v=spf1 mx -all"
        );
        assert_eq!(parse_character_strings("\"a\" \"b\""), vec!["a", "b"]);
    }

    #[test]
    fn unmatched_quotes_are_repaired_rather_than_rejected() {
        assert_eq!(
            unquote_character_string("\"v=spf1 mx -all"),
            "v=spf1 mx -all"
        );
        assert_eq!(
            unquote_character_string("v=spf1 mx -all\""),
            "v=spf1 mx -all"
        );
    }

    #[test]
    fn escapes_inside_a_quoted_run_are_decoded_not_treated_as_delimiters() {
        assert_eq!(unquote_character_string("\"a\\\"b\""), "a\"b");
        assert_eq!(unquote_character_string("\"a\\\\b\""), "a\\b");
        assert_eq!(unquote_character_string("\"a\\032b\""), "a b");
    }

    #[test]
    fn whitespace_inside_quotes_is_preserved() {
        assert_eq!(unquote_character_string("\"a  b\""), "a  b");
    }

    #[test]
    fn empty_content_yields_no_strings() {
        assert!(parse_character_strings("").is_empty());
        assert!(parse_character_strings("   ").is_empty());
    }

    #[test]
    fn spf_is_detected_in_every_presentation_shape() {
        for content in [
            "v=spf1 mx -all",
            "\"v=spf1 mx -all\"",
            "  \"v=spf1 mx -all\"  ",
            "\"v=spf1 \" \"mx -all\"",
            "\"V=SPF1 MX -ALL\"",
            "v=spf1",
            "\"v=spf1\"",
        ] {
            assert!(
                is_spf_record(content),
                "expected SPF detection for {content}"
            );
        }
    }

    #[test]
    fn the_spf_version_token_needs_a_boundary() {
        for content in ["v=spf1foo bar", "v=spf2 mx -all", "", "\"\"", "v=spf"] {
            assert!(
                !is_spf_record(content),
                "expected no SPF match for {content}"
            );
        }
    }
}
