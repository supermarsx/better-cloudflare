//! DNS record import: bounded CSV and BIND zone file parsing.

use serde::{Deserialize, Serialize};
use std::fmt;

use crate::{
    MAX_IMPORT_BYTES, MAX_IMPORT_FIELDS, MAX_IMPORT_FIELD_BYTES, MAX_IMPORT_LINES,
    MAX_IMPORT_LINE_BYTES, MAX_IMPORT_RECORDS, MAX_IMPORT_RETAINED_BYTES,
};

/// A partially-parsed DNS record from an import operation.
///
/// Fields that are missing or unparseable are set to `None`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PartialDNSRecord {
    pub r#type: Option<String>,
    pub name: Option<String>,
    pub content: Option<String>,
    pub ttl: Option<u32>,
    pub priority: Option<u16>,
    pub proxied: Option<bool>,
}

/// A deterministic import rejection raised before excessive parser allocation.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ImportLimitError {
    resource: &'static str,
    limit: usize,
    actual: usize,
}

impl ImportLimitError {
    fn new(resource: &'static str, limit: usize, actual: usize) -> Self {
        Self {
            resource,
            limit,
            actual,
        }
    }
}

impl fmt::Display for ImportLimitError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(
            formatter,
            "{} exceeds the safe import limit of {} bytes/items (actual: {})",
            self.resource, self.limit, self.actual
        )
    }
}

impl std::error::Error for ImportLimitError {}

fn validate_import_text(text: &str) -> Result<(), ImportLimitError> {
    if text.len() > MAX_IMPORT_BYTES {
        return Err(ImportLimitError::new(
            "DNS import text",
            MAX_IMPORT_BYTES,
            text.len(),
        ));
    }
    Ok(())
}

fn validate_line(line: &str, line_count: usize) -> Result<(), ImportLimitError> {
    if line_count > MAX_IMPORT_LINES {
        return Err(ImportLimitError::new(
            "DNS import line count",
            MAX_IMPORT_LINES,
            line_count,
        ));
    }
    if line.len() > MAX_IMPORT_LINE_BYTES {
        return Err(ImportLimitError::new(
            "DNS import line",
            MAX_IMPORT_LINE_BYTES,
            line.len(),
        ));
    }
    Ok(())
}

fn finish_csv_field(
    fields: &mut Vec<String>,
    current: &mut String,
) -> Result<(), ImportLimitError> {
    if fields.len() >= MAX_IMPORT_FIELDS {
        return Err(ImportLimitError::new(
            "CSV field count",
            MAX_IMPORT_FIELDS,
            fields.len() + 1,
        ));
    }
    let trimmed = current.trim();
    if trimmed.len() > MAX_IMPORT_FIELD_BYTES {
        return Err(ImportLimitError::new(
            "CSV field",
            MAX_IMPORT_FIELD_BYTES,
            trimmed.len(),
        ));
    }
    fields.push(trimmed.to_string());
    current.clear();
    Ok(())
}

/// Parse a single CSV line without first materializing a `Vec<char>`.
fn parse_csv_line(line: &str) -> Result<Vec<String>, ImportLimitError> {
    let mut result = Vec::with_capacity(8);
    let mut current = String::new();
    let mut in_quotes = false;
    let mut chars = line.chars().peekable();

    while let Some(ch) = chars.next() {
        if ch == '"' {
            if in_quotes && chars.peek() == Some(&'"') {
                if current.len() + 1 > MAX_IMPORT_FIELD_BYTES {
                    return Err(ImportLimitError::new(
                        "CSV field",
                        MAX_IMPORT_FIELD_BYTES,
                        current.len() + 1,
                    ));
                }
                current.push('"');
                chars.next();
            } else {
                in_quotes = !in_quotes;
            }
        } else if ch == ',' && !in_quotes {
            finish_csv_field(&mut result, &mut current)?;
        } else {
            let next_len = current.len().saturating_add(ch.len_utf8());
            if next_len > MAX_IMPORT_FIELD_BYTES {
                return Err(ImportLimitError::new(
                    "CSV field",
                    MAX_IMPORT_FIELD_BYTES,
                    next_len,
                ));
            }
            current.push(ch);
        }
    }
    finish_csv_field(&mut result, &mut current)?;
    Ok(result)
}

fn add_retained_bytes(total: &mut usize, value: &Option<String>) -> Result<(), ImportLimitError> {
    let next = total.saturating_add(value.as_ref().map_or(0, String::len));
    if next > MAX_IMPORT_RETAINED_BYTES {
        return Err(ImportLimitError::new(
            "retained DNS import fields",
            MAX_IMPORT_RETAINED_BYTES,
            next,
        ));
    }
    *total = next;
    Ok(())
}

/// Parse CSV text into partial DNS records with explicit resource ceilings.
pub fn try_parse_csv_records(text: &str) -> Result<Vec<PartialDNSRecord>, ImportLimitError> {
    validate_import_text(text)?;
    let mut line_count = 0usize;
    let mut lines = text.trim().lines().filter(|line| !line.is_empty());
    let Some(header_line) = lines.next() else {
        return Ok(Vec::new());
    };
    line_count += 1;
    validate_line(header_line, line_count)?;

    let headers: Vec<String> = parse_csv_line(header_line)?
        .into_iter()
        .map(|header| header.to_lowercase())
        .collect();
    let idx_type = headers.iter().position(|header| header == "type");
    let idx_name = headers.iter().position(|header| header == "name");
    let idx_content = headers.iter().position(|header| header == "content");
    let idx_ttl = headers.iter().position(|header| header == "ttl");
    let idx_priority = headers.iter().position(|header| header == "priority");
    let idx_proxied = headers.iter().position(|header| header == "proxied");

    let mut records = Vec::new();
    let mut retained_bytes = 0usize;
    for line in lines {
        line_count = line_count.saturating_add(1);
        validate_line(line, line_count)?;
        if records.len() >= MAX_IMPORT_RECORDS {
            return Err(ImportLimitError::new(
                "DNS import record count",
                MAX_IMPORT_RECORDS,
                records.len() + 1,
            ));
        }

        let values = parse_csv_line(line)?;
        let get = |index: Option<usize>| -> Option<String> {
            index
                .and_then(|index| values.get(index))
                .filter(|value| !value.is_empty())
                .cloned()
        };
        let record_type = get(idx_type);
        let name = get(idx_name);
        let content = get(idx_content);
        add_retained_bytes(&mut retained_bytes, &record_type)?;
        add_retained_bytes(&mut retained_bytes, &name)?;
        add_retained_bytes(&mut retained_bytes, &content)?;

        let ttl = get(idx_ttl).and_then(|value| {
            if value.eq_ignore_ascii_case("auto") {
                None
            } else {
                parse_ttl(&value)
            }
        });
        let priority = get(idx_priority).and_then(|value| parse_preference(&value));
        let proxied =
            get(idx_proxied).map(|value| matches!(value.to_lowercase().as_str(), "true" | "1"));

        records.push(PartialDNSRecord {
            // RFC 1035 §5.1 type mnemonics are case-insensitive; the canonical
            // form is upper case, and it is what every downstream check expects.
            r#type: record_type.map(|value| value.to_uppercase()),
            name,
            content,
            ttl,
            priority,
            proxied,
        });
    }
    Ok(records)
}

/// Compatibility entry point. Oversized input fails closed without partial data.
pub fn parse_csv_records(text: &str) -> Vec<PartialDNSRecord> {
    try_parse_csv_records(text).unwrap_or_default()
}

/// Zone file classes that may appear between the owner name and the type.
const BIND_CLASSES: &[&str] = &["IN", "CH", "HS", "CS"];

/// TTL used when a zone line omits one (the parser's documented default).
const DEFAULT_BIND_TTL: u32 = 300;

/// The most leading fields any zone line needs to be understood: the owner, a
/// `[ttl] [class]` prefix in either order, the type, and one lookahead for the
/// MX preference. Everything past that is RDATA and is sliced verbatim, so a
/// long TXT record is never tokenised.
const MAX_BIND_LEADING_FIELDS: usize = 6;

/// Read a zone-file TTL, mirroring `parseBINDTTL` in `dns-parsers.ts`.
///
/// Accepts a bare second count (RFC 1035 §5.1) and BIND's duration suffixes,
/// including combined forms such as `1w12h`. Returns `None` when the token is
/// not a TTL at all, so the caller falls through to the class and type fields
/// instead of inventing a value.
///
/// Zero is returned as `Some(0)`: RFC 2181 §8 makes it legal and meaningful
/// ("do not cache"), and silently substituting a default would change the
/// record. Validation rejects it later with a message that says so.
fn parse_ttl(token: &str) -> Option<u32> {
    if token.is_empty() {
        return None;
    }
    if token.bytes().all(|byte| byte.is_ascii_digit()) {
        return token.parse::<u32>().ok();
    }

    let mut total: u64 = 0;
    let mut digits: u64 = 0;
    let mut has_digits = false;
    let mut units = 0usize;
    for byte in token.bytes() {
        if byte.is_ascii_digit() {
            digits = digits
                .checked_mul(10)?
                .checked_add(u64::from(byte - b'0'))?;
            has_digits = true;
            continue;
        }
        if !has_digits {
            return None;
        }
        let seconds = match byte.to_ascii_lowercase() {
            b's' => 1,
            b'm' => 60,
            b'h' => 3_600,
            b'd' => 86_400,
            b'w' => 604_800,
            _ => return None,
        };
        total = total.checked_add(digits.checked_mul(seconds)?)?;
        if total > u64::from(u32::MAX) {
            return None;
        }
        digits = 0;
        has_digits = false;
        units += 1;
    }
    // A trailing count with no unit (`1h30`) is not a duration.
    if has_digits || units == 0 {
        return None;
    }
    u32::try_from(total).ok()
}

/// Read a 16-bit preference/priority, or `None` when the token is not one.
fn parse_preference(token: &str) -> Option<u16> {
    if token.is_empty() || !token.bytes().all(|byte| byte.is_ascii_digit()) {
        return None;
    }
    token.parse::<u16>().ok()
}

/// Strip a trailing zone-file comment.
///
/// In a zone file `;` starts a comment only outside a quoted character-string.
/// `;` is also the field separator inside DMARC and DKIM TXT values, so a
/// quote-blind split truncates `"v=DMARC1; p=reject; rua=..."` to `"v=DMARC1`
/// and silently destroys the policy. A backslash escapes the following
/// character, so `\"` does not flip the quote state and `\;` is not a comment.
fn strip_bind_comment(line: &str) -> &str {
    let mut in_quotes = false;
    let mut escaped = false;
    for (index, character) in line.char_indices() {
        if escaped {
            escaped = false;
            continue;
        }
        match character {
            '\\' => escaped = true,
            '"' => in_quotes = !in_quotes,
            ';' if !in_quotes => return &line[..index],
            _ => {}
        }
    }
    line
}

/// A record type token is alphabetic-leading; anything else is a malformed line.
fn is_record_type_token(token: &str) -> bool {
    let mut characters = token.chars();
    characters
        .next()
        .is_some_and(|first| first.is_ascii_alphabetic())
        && characters.all(|c| c.is_ascii_alphanumeric() || c == '-')
}

/// A whitespace-separated field plus the byte offset just past it.
struct BindField<'a> {
    value: &'a str,
    end: usize,
}

/// Split the leading fields of `line`, keeping each field's end offset.
///
/// At most [`MAX_BIND_LEADING_FIELDS`] fields are produced. The parser only
/// ever looks two fields past the type, so a truncated list is never
/// distinguishable from a complete one, and the RDATA — which is sliced from an
/// offset rather than rebuilt from tokens — costs nothing to skip.
fn split_bind_fields(line: &str) -> Vec<BindField<'_>> {
    let mut fields = Vec::with_capacity(MAX_BIND_LEADING_FIELDS);
    let mut start: Option<usize> = None;
    for (index, character) in line.char_indices() {
        if character.is_whitespace() {
            if let Some(begin) = start.take() {
                fields.push(BindField {
                    value: &line[begin..index],
                    end: index,
                });
                if fields.len() == MAX_BIND_LEADING_FIELDS {
                    return fields;
                }
            }
        } else if start.is_none() {
            start = Some(index);
        }
    }
    if let Some(begin) = start {
        fields.push(BindField {
            value: &line[begin..],
            end: line.len(),
        });
    }
    fields
}

/// The net `(` depth a line adds, and whether it held any grouping paren.
struct ParenScan {
    delta: i32,
    saw: bool,
}

/// Count the RFC 1035 §5.1 grouping parentheses in `line`.
///
/// A paren inside a quoted character-string is data, and a backslash escapes
/// the character after it, so neither flips the state.
fn scan_bind_parens(line: &str) -> ParenScan {
    let mut in_quotes = false;
    let mut escaped = false;
    let mut delta = 0i32;
    let mut saw = false;
    for character in line.chars() {
        if escaped {
            escaped = false;
            continue;
        }
        match character {
            '\\' => escaped = true,
            '"' => in_quotes = !in_quotes,
            '(' if !in_quotes => {
                delta = delta.saturating_add(1);
                saw = true;
            }
            ')' if !in_quotes => {
                delta = delta.saturating_sub(1);
                saw = true;
            }
            _ => {}
        }
    }
    ParenScan { delta, saw }
}

/// Flatten a logical line that used grouping parentheses.
///
/// The parens are removed and every run of whitespace *outside* a quoted
/// character-string collapses to one space, so the continuation lines of a
/// parenthesised SOA arrive as ordinary RDATA fields. Whitespace inside a
/// quoted string is significant and is preserved exactly. Mirrors
/// `flattenGroupedRDATA` in `dns-parsers.ts`.
fn flatten_grouped_rdata(line: &str) -> String {
    let mut flattened = String::with_capacity(line.len());
    let mut in_quotes = false;
    let mut pending_space = false;
    let mut characters = line.chars();

    while let Some(character) = characters.next() {
        match character {
            '\\' => {
                if pending_space && !flattened.is_empty() {
                    flattened.push(' ');
                }
                pending_space = false;
                flattened.push('\\');
                if let Some(escaped) = characters.next() {
                    flattened.push(escaped);
                }
            }
            '"' => {
                if pending_space && !flattened.is_empty() {
                    flattened.push(' ');
                }
                pending_space = false;
                in_quotes = !in_quotes;
                flattened.push('"');
            }
            '(' | ')' if !in_quotes => pending_space = true,
            character if !in_quotes && character.is_whitespace() => pending_space = true,
            character => {
                if pending_space && !flattened.is_empty() {
                    flattened.push(' ');
                }
                pending_space = false;
                flattened.push(character);
            }
        }
    }
    flattened
}

/// A logical zone line: physical lines joined across `( ... )`.
struct PendingLine {
    text: String,
    indented: bool,
}

/// Turn one logical zone line into a record, if it is one.
///
/// Mirrors `parseBINDZone` in `dns-parsers.ts` field for field. A line that
/// cannot be read as a record is skipped; malformed *RDATA* is passed through
/// whole, because the write-time validator is what judges it.
fn push_bind_record(
    line: &str,
    indented: bool,
    previous_owner: &mut Option<String>,
    records: &mut Vec<PartialDNSRecord>,
    retained_bytes: &mut usize,
) -> Result<(), ImportLimitError> {
    if records.len() >= MAX_IMPORT_RECORDS {
        return Err(ImportLimitError::new(
            "DNS import record count",
            MAX_IMPORT_RECORDS,
            records.len() + 1,
        ));
    }

    let fields = split_bind_fields(line);
    let (name, mut cursor) = if indented {
        // RFC 1035 §5.1: a line beginning with a blank keeps the previous
        // owner. Without one there is nothing to inherit, so the line is
        // dropped rather than having its TTL promoted to an owner name.
        let Some(owner) = previous_owner.clone() else {
            return Ok(());
        };
        (owner, 0usize)
    } else {
        if fields.len() < 2 {
            return Ok(());
        }
        (fields[0].value.to_string(), 1usize)
    };

    let mut ttl = DEFAULT_BIND_TTL;
    let mut seen_ttl = false;
    let mut seen_class = false;
    // Only a field with a successor can be the TTL or the class: the last
    // field is RDATA.
    while fields.get(cursor + 1).is_some() {
        let token = fields[cursor].value;
        if !seen_ttl {
            if let Some(seconds) = parse_ttl(token) {
                ttl = seconds;
                seen_ttl = true;
                cursor += 1;
                continue;
            }
        }
        if !seen_class
            && BIND_CLASSES
                .iter()
                .any(|class| token.eq_ignore_ascii_case(class))
        {
            seen_class = true;
            cursor += 1;
            continue;
        }
        break;
    }

    let Some(type_field) = fields.get(cursor) else {
        return Ok(());
    };
    if !is_record_type_token(type_field.value) {
        return Ok(());
    }
    let record_type = type_field.value.to_uppercase();

    let mut content_start = cursor;
    let mut priority = None;
    if record_type == "MX" && fields.get(cursor + 2).is_some() {
        if let Some(preference) = parse_preference(fields[cursor + 1].value) {
            priority = Some(preference);
            content_start = cursor + 1;
        }
    }

    let content = line[fields[content_start].end..].trim();
    // A record with no RDATA is not a record. `example.com. 3600 IN` arrives
    // here with "IN" read as the type and is dropped rather than retained.
    if content.is_empty() {
        return Ok(());
    }

    for (label, value) in [
        ("BIND name", name.as_str()),
        ("BIND type", record_type.as_str()),
        ("BIND content", content),
    ] {
        if value.len() > MAX_IMPORT_FIELD_BYTES {
            return Err(ImportLimitError::new(
                label,
                MAX_IMPORT_FIELD_BYTES,
                value.len(),
            ));
        }
    }

    let name = Some(name);
    let record_type = Some(record_type);
    let content = Some(content.to_string());
    add_retained_bytes(retained_bytes, &name)?;
    add_retained_bytes(retained_bytes, &record_type)?;
    add_retained_bytes(retained_bytes, &content)?;
    previous_owner.clone_from(&name);
    records.push(PartialDNSRecord {
        r#type: record_type,
        name,
        content,
        ttl: Some(ttl),
        priority,
        proxied: None,
    });
    Ok(())
}

/// Parse a simplified BIND zone file with explicit resource ceilings.
///
/// The accepted line is RFC 1035 §5.1's `[<owner>] [<ttl>] [<class>] <type>
/// <rdata>`: the TTL and the class are optional in either order, the TTL may
/// use BIND's duration suffixes, the type mnemonic is case-folded to upper
/// case, an owner elided as leading whitespace is inherited from the previous
/// record, and physical lines joined by `( ... )` are folded into one logical
/// line first. `$ORIGIN`, `$TTL`, `$INCLUDE` and `$GENERATE` are skipped rather
/// than interpreted.
pub fn try_parse_bind_zone(text: &str) -> Result<Vec<PartialDNSRecord>, ImportLimitError> {
    validate_import_text(text)?;
    let mut records = Vec::new();
    let mut line_count = 0usize;
    let mut retained_bytes = 0usize;
    let mut previous_owner: Option<String> = None;

    let mut pending: Option<PendingLine> = None;
    let mut grouped = false;
    let mut depth = 0i32;

    // The text is deliberately not trimmed as a whole: that would strip the
    // leading whitespace from the very first line and change its meaning.
    for raw in text.lines() {
        line_count = line_count.saturating_add(1);
        validate_line(raw, line_count)?;
        let stripped = strip_bind_comment(raw);
        let trimmed = stripped.trim();

        match pending.as_mut() {
            None => {
                // `$TTL`, `$ORIGIN`, `$INCLUDE` and `$GENERATE` are directives,
                // not records.
                if trimmed.is_empty() || trimmed.starts_with('$') {
                    continue;
                }
                pending = Some(PendingLine {
                    text: trimmed.to_string(),
                    indented: raw.starts_with([' ', '\t']),
                });
                grouped = false;
            }
            Some(open) => {
                if !trimmed.is_empty() {
                    let next_len = open
                        .text
                        .len()
                        .saturating_add(1)
                        .saturating_add(trimmed.len());
                    if next_len > MAX_IMPORT_LINE_BYTES {
                        return Err(ImportLimitError::new(
                            "DNS import line",
                            MAX_IMPORT_LINE_BYTES,
                            next_len,
                        ));
                    }
                    open.text.push(' ');
                    open.text.push_str(trimmed);
                }
            }
        }

        let scan = scan_bind_parens(stripped);
        if scan.saw {
            grouped = true;
        }
        depth = depth.saturating_add(scan.delta);
        if depth > 0 {
            continue;
        }
        depth = 0;

        let open = pending.take().expect("a pending line was just set");
        let text = if grouped {
            flatten_grouped_rdata(&open.text)
        } else {
            open.text
        };
        push_bind_record(
            &text,
            open.indented,
            &mut previous_owner,
            &mut records,
            &mut retained_bytes,
        )?;
    }

    // An unterminated `(` still yields the record it opened rather than nothing.
    if let Some(open) = pending {
        let text = flatten_grouped_rdata(&open.text);
        push_bind_record(
            &text,
            open.indented,
            &mut previous_owner,
            &mut records,
            &mut retained_bytes,
        )?;
    }
    Ok(records)
}

/// Compatibility entry point. Oversized input fails closed without partial data.
pub fn parse_bind_zone(text: &str) -> Vec<PartialDNSRecord> {
    try_parse_bind_zone(text).unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn csv_input_byte_limit_accepts_exact_and_rejects_plus_one() {
        let exact = " ".repeat(MAX_IMPORT_BYTES);
        assert!(try_parse_csv_records(&exact).is_ok());
        let oversized = " ".repeat(MAX_IMPORT_BYTES + 1);
        assert!(try_parse_csv_records(&oversized).is_err());
    }

    #[test]
    fn csv_field_limit_accepts_exact_and_rejects_plus_one() {
        let exact = format!(
            "Type,Name,Content\nA,example.com,{}",
            "x".repeat(MAX_IMPORT_FIELD_BYTES)
        );
        assert_eq!(try_parse_csv_records(&exact).unwrap().len(), 1);
        let oversized = format!(
            "Type,Name,Content\nA,example.com,{}",
            "x".repeat(MAX_IMPORT_FIELD_BYTES + 1)
        );
        assert!(try_parse_csv_records(&oversized).is_err());
    }

    #[test]
    fn csv_record_limit_accepts_exact_and_rejects_plus_one() {
        let mut text = String::from("Type,Name,Content\n");
        text.push_str(&"A,x,y\n".repeat(MAX_IMPORT_RECORDS));
        assert_eq!(
            try_parse_csv_records(&text).unwrap().len(),
            MAX_IMPORT_RECORDS
        );
        text.push_str("A,x,y\n");
        assert!(try_parse_csv_records(&text).is_err());
        assert!(parse_csv_records(&text).is_empty());
    }

    #[test]
    fn csv_parser_handles_escaped_quotes_without_char_vector() {
        let records =
            try_parse_csv_records("Type,Name,Content\nTXT,example.com,\"a \"\"quoted\"\" value\"")
                .unwrap();
        assert_eq!(records[0].content.as_deref(), Some("a \"quoted\" value"));
    }

    #[test]
    fn bind_content_limit_rejects_adversarial_line() {
        let exact = format!(
            "example.com 300 IN TXT {}",
            "x".repeat(MAX_IMPORT_FIELD_BYTES)
        );
        assert_eq!(try_parse_bind_zone(&exact).unwrap().len(), 1);
        let oversized = format!(
            "example.com 300 IN TXT {}",
            "x".repeat(MAX_IMPORT_FIELD_BYTES + 1)
        );
        assert!(try_parse_bind_zone(&oversized).is_err());
    }

    fn parse_one(line: &str) -> PartialDNSRecord {
        let mut records = try_parse_bind_zone(line).expect("line should parse");
        assert_eq!(records.len(), 1, "expected one record from {line:?}");
        records.remove(0)
    }

    #[test]
    fn bind_semicolons_inside_dmarc_values_are_not_comments() {
        let record = parse_one(
            r#"_dmarc.example.com. 3600 IN TXT "v=DMARC1; p=reject; rua=mailto:dmarc@example.com""#,
        );
        assert_eq!(record.r#type.as_deref(), Some("TXT"));
        assert_eq!(record.name.as_deref(), Some("_dmarc.example.com."));
        assert_eq!(
            record.content.as_deref(),
            Some(r#""v=DMARC1; p=reject; rua=mailto:dmarc@example.com""#)
        );
    }

    #[test]
    fn bind_semicolons_inside_dkim_keys_are_not_comments() {
        let record = parse_one(
            r#"default._domainkey.example.com. 3600 IN TXT "v=DKIM1; k=rsa; p=MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEA""#,
        );
        assert_eq!(
            record.content.as_deref(),
            Some(r#""v=DKIM1; k=rsa; p=MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEA""#)
        );
    }

    #[test]
    fn bind_comments_outside_quotes_are_still_stripped() {
        let record = parse_one("example.com. 300 IN A 1.2.3.4 ; primary origin");
        assert_eq!(record.content.as_deref(), Some("1.2.3.4"));

        let quoted = parse_one(r#"example.com. 300 IN TXT "v=DMARC1; p=none" ; reporting only"#);
        assert_eq!(quoted.content.as_deref(), Some(r#""v=DMARC1; p=none""#));
    }

    #[test]
    fn bind_escaped_quote_does_not_flip_comment_state() {
        let record = parse_one(r#"example.com. 300 IN TXT "a \" b; c" ; trailing"#);
        assert_eq!(record.content.as_deref(), Some(r#""a \" b; c""#));
    }

    #[test]
    fn bind_records_without_an_explicit_ttl_keep_their_type() {
        let record = parse_one("example.com. IN MX 10 mail.example.com.");
        assert_eq!(record.r#type.as_deref(), Some("MX"));
        assert_eq!(record.priority, Some(10));
        assert_eq!(record.content.as_deref(), Some("mail.example.com."));
        assert_eq!(record.ttl, Some(300));
    }

    #[test]
    fn bind_optional_ttl_and_class_orders_all_parse() {
        for line in [
            "example.com. 600 IN A 1.2.3.4",
            "example.com. IN 600 A 1.2.3.4",
            "example.com. 600 A 1.2.3.4",
            "example.com. IN A 1.2.3.4",
            "example.com. A 1.2.3.4",
        ] {
            let record = parse_one(line);
            assert_eq!(record.r#type.as_deref(), Some("A"), "line {line:?}");
            assert_eq!(record.content.as_deref(), Some("1.2.3.4"), "line {line:?}");
        }
        assert_eq!(parse_one("example.com. 600 IN A 1.2.3.4").ttl, Some(600));
        assert_eq!(parse_one("example.com. A 1.2.3.4").ttl, Some(300));
    }

    #[test]
    fn bind_directives_and_malformed_lines_produce_no_records() {
        let zone = concat!(
            "$ORIGIN example.com.\n",
            "$TTL 3600\n",
            "; a full line comment\n",
            "\n",
            "www 300 IN A 1.2.3.4\n",
        );
        let records = try_parse_bind_zone(zone).expect("zone should parse");
        assert_eq!(records.len(), 1);
        assert_eq!(records[0].r#type.as_deref(), Some("A"));
    }

    /// `$GENERATE` is a BIND extension with enough fields to look like a
    /// record. It is recognised by its `$` rather than by a field count, so it
    /// is skipped instead of becoming a record named `$GENERATE` of type
    /// `1-10`.
    #[test]
    fn bind_generate_directive_is_skipped_like_every_other_directive() {
        for directive in [
            "$ORIGIN example.com.",
            "$TTL 3600",
            "$INCLUDE sub.zone example.com.",
            "$GENERATE 1-10 host$ A 192.0.2.1",
            "$GENERATE 1-10/2 dhcp-$ A 192.0.2.$",
        ] {
            assert!(
                try_parse_bind_zone(directive)
                    .expect("directive should parse")
                    .is_empty(),
                "{directive:?} produced a record"
            );
        }
    }

    /// RFC 2181 §8 makes a TTL of zero legal and meaningful ("do not cache").
    /// A falsy check used to replace it with the 300 second default.
    #[test]
    fn bind_zero_ttl_is_preserved() {
        assert_eq!(parse_one("example.com. 0 IN A 192.0.2.1").ttl, Some(0));
        assert_eq!(parse_one(r#"version.bind. 0 CH TXT "9.18.1""#).ttl, Some(0));
        assert_eq!(parse_one("example.com. 0s IN A 192.0.2.1").ttl, Some(0));

        // The 32-bit ceiling still parses; wider is not a TTL and, since it is
        // not a type mnemonic either, the line is dropped rather than guessed.
        assert_eq!(
            parse_one("example.com. 4294967295 IN A 192.0.2.1").ttl,
            Some(4_294_967_295)
        );
        assert!(
            try_parse_bind_zone("example.com. 4294967296 IN A 192.0.2.1")
                .expect("line should parse")
                .is_empty()
        );
    }

    #[test]
    fn bind_duration_ttls_resolve_to_seconds() {
        for (token, seconds) in [
            ("60s", 60_u32),
            ("30m", 1_800),
            ("1h", 3_600),
            ("1H", 3_600),
            ("2d", 172_800),
            ("1w", 604_800),
            ("1w12h", 648_000),
            ("1h30m", 5_400),
        ] {
            assert_eq!(
                parse_one(&format!("example.com. {token} IN A 192.0.2.1")).ttl,
                Some(seconds),
                "{token}"
            );
            assert_eq!(
                parse_one(&format!("example.com. IN {token} A 192.0.2.1")).ttl,
                Some(seconds),
                "{token} after the class"
            );
        }

        // A token that only looks like a duration is read as the type, fails
        // the mnemonic check, and the line is dropped.
        for token in ["1h30", "1x", "1h-", "1.5h"] {
            assert!(
                try_parse_bind_zone(&format!("example.com. {token} IN A 192.0.2.1"))
                    .expect("line should parse")
                    .is_empty(),
                "{token}"
            );
        }
    }

    /// RFC 1035 §5.1: "if a line begins with a blank, then the owner is assumed
    /// to be the same as that of the previous RR". Consuming the TTL as the
    /// owner instead produced a record named "3600".
    #[test]
    fn bind_blank_owner_inherits_the_previous_record() {
        let records = try_parse_bind_zone(concat!(
            "example.com. 300 IN NS ns1.example.net.\n",
            "\t\t300 IN NS ns2.example.net.\n",
            "             IN NS ns3.example.net.\n",
            "www.example.com. 300 IN A 192.0.2.1\n",
            "  300 IN A 192.0.2.2\n",
        ))
        .expect("zone should parse");

        let owners: Vec<&str> = records
            .iter()
            .map(|record| record.name.as_deref().unwrap_or_default())
            .collect();
        assert_eq!(
            owners,
            [
                "example.com.",
                "example.com.",
                "example.com.",
                "www.example.com.",
                "www.example.com.",
            ]
        );

        // With no previous record there is nothing to inherit, so the line is
        // dropped rather than promoting its TTL to an owner name. That includes
        // the first line of the text, which is why it is not trimmed as a whole.
        assert!(try_parse_bind_zone("\t3600 IN A 192.0.2.2")
            .expect("line should parse")
            .is_empty());
        let records =
            try_parse_bind_zone("  3600 IN A 192.0.2.1\nexample.com. 3600 IN A 192.0.2.2")
                .expect("zone should parse");
        assert_eq!(records.len(), 1);
        assert_eq!(records[0].content.as_deref(), Some("192.0.2.2"));
    }

    #[test]
    fn bind_record_without_a_ttl_or_class_parses() {
        // RFC 1035 §5.1 permits "<name> <type> <rdata>" with both omitted.
        let record = parse_one("example.com. A 192.0.2.1");
        assert_eq!(record.r#type.as_deref(), Some("A"));
        assert_eq!(record.content.as_deref(), Some("192.0.2.1"));
        assert_eq!(record.ttl, Some(300));

        let record = parse_one("www.example.com. CNAME example.com.");
        assert_eq!(record.r#type.as_deref(), Some("CNAME"));
        assert_eq!(record.content.as_deref(), Some("example.com."));

        // A line with no RDATA at all is still not a record.
        for line in [
            "example.com. 3600 IN",
            "example.com. 3600 IN TXT",
            "example.com. A",
            "example.com.",
            "garbage",
        ] {
            assert!(
                try_parse_bind_zone(line)
                    .expect("line should parse")
                    .is_empty(),
                "{line:?}"
            );
        }
    }

    #[test]
    fn bind_type_mnemonic_is_case_folded() {
        assert_eq!(
            parse_one("example.com. 3600 in a 192.0.2.1")
                .r#type
                .as_deref(),
            Some("A")
        );
        assert_eq!(
            parse_one("example.com. 3600 In AaAa 2001:db8::1")
                .r#type
                .as_deref(),
            Some("AAAA")
        );
        let record = parse_one("example.com. 3600 in mx 10 inbound.example.net.");
        assert_eq!(record.r#type.as_deref(), Some("MX"));
        assert_eq!(record.priority, Some(10));

        // RFC 4343 makes owner names case-preserving, so the name is not folded.
        assert_eq!(
            parse_one("EXAMPLE.com. 3600 in a 192.0.2.1")
                .name
                .as_deref(),
            Some("EXAMPLE.com.")
        );
    }

    #[test]
    fn bind_parenthesised_rdata_is_joined_into_one_record() {
        let record = parse_one(concat!(
            "example.com. 3600 IN SOA ns1.example.net. hostmaster.example.com. (\n",
            "    2026080701 ; serial\n",
            "    7200       ; refresh\n",
            "    3600       ; retry\n",
            "    1209600    ; expire\n",
            "    3600 )     ; minimum\n",
        ));
        assert_eq!(record.r#type.as_deref(), Some("SOA"));
        assert_eq!(record.ttl, Some(3600));
        assert_eq!(
            record.content.as_deref(),
            Some("ns1.example.net. hostmaster.example.com. 2026080701 7200 3600 1209600 3600")
        );

        // A group opened and closed on one line is the same record without it.
        assert_eq!(
            parse_one("example.com. 3600 IN SOA ns1.example.net. root.example.com. ( 1 2 3 4 5 )")
                .content
                .as_deref(),
            Some("ns1.example.net. root.example.com. 1 2 3 4 5")
        );

        // A paren inside a quoted character-string is data, and an escaped one
        // in bare RDATA is too: neither opens a group nor is removed.
        assert_eq!(
            parse_one(r#"example.com. 3600 IN TXT "a (grouped)  value""#)
                .content
                .as_deref(),
            Some(r#""a (grouped)  value""#)
        );
        assert_eq!(
            parse_one(r"example.com. 3600 IN TXT bare\(value\)")
                .content
                .as_deref(),
            Some(r"bare\(value\)")
        );

        // An unterminated group yields the record it opened rather than nothing.
        assert_eq!(
            parse_one("example.com. 3600 IN SOA ns1.example.net. root.example.com. (\n  1")
                .content
                .as_deref(),
            Some("ns1.example.net. root.example.com. 1")
        );
    }

    /// RDATA is sliced from the line rather than rebuilt from its tokens, so
    /// whitespace inside a quoted character-string survives exactly — the same
    /// contract `parseBINDZone` has in `dns-parsers.ts`.
    #[test]
    fn bind_rdata_is_sliced_verbatim_not_rejoined() {
        assert_eq!(
            parse_one(r#"example.com. 3600 IN TXT "two  spaces  kept""#)
                .content
                .as_deref(),
            Some(r#""two  spaces  kept""#)
        );
        assert_eq!(
            parse_one(r#"example.com. 3600 IN TXT "one" "two""#)
                .content
                .as_deref(),
            Some(r#""one" "two""#)
        );
    }

    /// Quote one value for an RFC 4180 CSV cell.
    fn csv_cell(value: &str) -> String {
        format!("\"{}\"", value.replace('"', "\"\""))
    }

    /// Structured record types written in the presentation form of their
    /// defining RFC, mirroring `STRUCTURED_RDATA` in `rfc-rdata-formats.test.ts`.
    const STRUCTURED_RDATA: &[(&str, &str)] = &[
        ("LOC", "42 21 54.000 N 71 06 18.000 W -24m 30m 10m 2m"),
        ("APL", "1:192.0.2.0/24 !1:192.0.2.7/32 2:2001:db8::/32"),
        (
            "CERT",
            "1 12345 8 MIICajCCAdOgAwIBAgICBEUwDQYJKoZIhvcNAQEFBQAw",
        ),
        (
            "NAPTR",
            "100 10 \"S\" \"SIP+D2U\" \"\" _sip._udp.example.com.",
        ),
        ("SVCB", "1 svc.example.net. alpn=\"h2,h3\" port=8443"),
        ("HTTPS", "1 . alpn=\"h2,h3\" ipv4hint=192.0.2.1"),
        ("SSHFP", "4 2 0123456789abcdef"),
        ("TLSA", "3 1 1 0123456789abcdef"),
        (
            "DNSKEY",
            "257 3 8 AwEAAaHIwpx3w4VHKi6i1LHnTaWeHCL154Jug0Ykv",
        ),
        ("DS", "12345 8 2 49FD46E6C4B45C55D4AC69CBD3CD34AC1AFE51DE"),
        ("RP", "admin.example.com. contact.example.com."),
        ("AFSDB", "1 afsdb.example.com."),
        ("SMIMEA", "3 0 0 0123456789abcdef"),
        ("OPENPGPKEY", "mQINBGRhbmRvbUtleURhdGFGb3JUZXN0aW5nT25seQ=="),
        ("CAA", "0 issue \"ca.example.net\""),
        ("HINFO", "\"PC-Intel-700mhz\" \"FreeBSD 14.0\""),
        ("URI", "10 1 \"https://example.com/path?a=1&b=2\""),
    ];

    fn validation_of(
        record_type: &str,
        content: &str,
        ttl: Option<u32>,
    ) -> crate::ValidationResult {
        crate::validate_dns_record(&crate::DNSRecordValidationInput {
            r#type: record_type.to_string(),
            name: "example.com".to_string(),
            content: content.to_string(),
            ttl,
            priority: None,
            proxied: None,
        })
    }

    #[test]
    fn structured_rdata_imports_identically_from_bind_and_csv() {
        for (record_type, rdata) in STRUCTURED_RDATA {
            let from_zone = parse_one(&format!("example.com. 3600 IN {record_type} {rdata}"));
            assert_eq!(from_zone.r#type.as_deref(), Some(*record_type));
            assert_eq!(from_zone.ttl, Some(3600));
            assert_eq!(from_zone.content.as_deref(), Some(*rdata), "{record_type}");

            // Class omitted, TTL omitted, and a lower-case mnemonic are all
            // legal zone syntax for the same record.
            for line in [
                format!("example.com. 3600 {record_type} {rdata}"),
                format!("example.com. IN {record_type} {rdata}"),
                format!("example.com. {record_type} {rdata}"),
                format!(
                    "example.com. 3600 in {} {rdata}",
                    record_type.to_lowercase()
                ),
            ] {
                let parsed = parse_one(&line);
                assert_eq!(parsed.r#type.as_deref(), Some(*record_type), "{line}");
                assert_eq!(parsed.content.as_deref(), Some(*rdata), "{line}");
            }

            let csv = format!(
                "Type,Name,Content,TTL,Priority,Proxied\n{record_type},example.com,{},3600,,false",
                csv_cell(rdata)
            );
            let from_csv = try_parse_csv_records(&csv).expect("csv should parse");
            assert_eq!(from_csv.len(), 1, "{record_type}");
            assert_eq!(from_csv[0].r#type.as_deref(), Some(*record_type));
            assert_eq!(from_csv[0].ttl, Some(3600));
            // The two import paths must not disagree about the same record.
            assert_eq!(from_csv[0].content, from_zone.content, "{record_type}");

            // Nothing well-formed is refused by the write gate.
            let result = validation_of(record_type, rdata, Some(3600));
            assert!(result.ok, "{record_type} {rdata:?}: {:?}", result.issues);
        }
    }

    /// The parser deliberately does not judge RDATA: a record that imports and
    /// is then refused with a precise message is recoverable, one that is
    /// silently rewritten is not. These are the types the write gate has strict
    /// rules for, so a malformed value from either path is caught before a write.
    #[test]
    fn malformed_structured_rdata_is_refused_by_the_write_gate() {
        for (record_type, rdata, expected) in [
            ("TLSA", "3 1", "usage selector matching-type"),
            ("SSHFP", "4 2 nothex!", "algorithm fptype fingerprint"),
            ("NAPTR", "100 10 \"S\" \"SIP+D2U\" \"\"", "order preference"),
            ("CAA", "0 issue", "flags tag value"),
            ("CAA", "300 issue \"ca.example.net\"", "CAA flags"),
            (
                "SRV",
                "10 60 sip.example.com.",
                "priority weight port target",
            ),
        ] {
            let from_zone = parse_one(&format!("example.com. 3600 IN {record_type} {rdata}"));
            assert_eq!(from_zone.content.as_deref(), Some(rdata));

            let csv = format!(
                "Type,Name,Content\n{record_type},example.com,{}",
                csv_cell(rdata)
            );
            let from_csv = try_parse_csv_records(&csv).expect("csv should parse");
            assert_eq!(from_csv[0].content.as_deref(), Some(rdata));

            for source in [&from_zone, &from_csv[0]] {
                let result = validation_of(
                    record_type,
                    source.content.as_deref().unwrap_or_default(),
                    None,
                );
                assert!(!result.ok, "{record_type} {rdata:?} was accepted");
                assert!(
                    result.issues.iter().any(|issue| issue.contains(expected)),
                    "{record_type} {rdata:?} issues {:?} did not mention {expected:?}",
                    result.issues
                );
            }
        }

        // Case-folding the mnemonic on import is what makes a lower-case zone
        // export reach the gate as the known type `A` rather than as `a`.
        let folded = parse_one("example.com. 3600 in a 192.0.2.1");
        let result = validation_of(
            folded.r#type.as_deref().unwrap_or_default(),
            folded.content.as_deref().unwrap_or_default(),
            folded.ttl,
        );
        assert!(result.ok, "{:?}", result.issues);
        assert!(!validation_of("a", "192.0.2.1", Some(3600)).ok);
    }

    /// A TTL of zero survives import — the record is not silently rewritten —
    /// and the write gate then refuses it with a message that says why.
    #[test]
    fn a_zero_ttl_survives_import_and_is_refused_with_a_precise_message() {
        let record = parse_one("example.com. 0 IN A 192.0.2.1");
        assert_eq!(record.ttl, Some(0));
        let result = validation_of("A", "192.0.2.1", record.ttl);
        assert!(!result.ok);
        assert!(
            result
                .issues
                .iter()
                .any(|issue| issue.contains("TTL must be 1")),
            "{:?}",
            result.issues
        );
    }

    #[test]
    fn csv_ttl_and_priority_drop_values_that_are_not_numbers() {
        let records = try_parse_csv_records(concat!(
            "Type,Name,Content,TTL,Priority\n",
            "MX,example.com,mail.example.com,notanumber,alsonot\n",
            "MX,example.com,mail.example.com,1h,10\n",
            "MX,example.com,mail.example.com,auto,70000\n",
            "MX,example.com,mail.example.com,0,0\n",
        ))
        .expect("csv should parse");

        // A TTL or priority that is not a number is dropped rather than
        // retained as a sentinel; the field is simply absent.
        assert_eq!(records[0].ttl, None);
        assert_eq!(records[0].priority, None);
        // The CSV path accepts the same TTL grammar as the zone path.
        assert_eq!(records[1].ttl, Some(3600));
        assert_eq!(records[1].priority, Some(10));
        // "auto" has no numeric TTL, and a preference must fit 16 bits.
        assert_eq!(records[2].ttl, None);
        assert_eq!(records[2].priority, None);
        // Zero is a real value for both fields and is kept.
        assert_eq!(records[3].ttl, Some(0));
        assert_eq!(records[3].priority, Some(0));
    }

    #[test]
    fn csv_type_mnemonic_is_case_folded_like_the_zone_path() {
        let records = try_parse_csv_records("Type,Name,Content\na,example.com,192.0.2.1")
            .expect("csv should parse");
        assert_eq!(records[0].r#type.as_deref(), Some("A"));
    }
}
