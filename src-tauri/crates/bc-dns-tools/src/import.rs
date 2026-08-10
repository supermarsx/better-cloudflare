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
                value.parse().ok()
            }
        });
        let priority = get(idx_priority).and_then(|value| value.parse().ok());
        let proxied =
            get(idx_proxied).map(|value| matches!(value.to_lowercase().as_str(), "true" | "1"));

        records.push(PartialDNSRecord {
            r#type: record_type,
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

/// Resolve the optional `[ttl] [class]` / `[class] [ttl]` prefix that may sit
/// between a zone-file owner name and its record type.
///
/// BIND lets both fields be omitted, so `example.com. IN MX 10 mail.example.com.`
/// and `example.com. 300 A 1.2.3.4` are both well-formed. Assuming a fixed
/// `name ttl class type` layout shifts every field left and yields a record
/// whose type is the next token — `MX` becomes the type `10`.
fn split_bind_prefix<'a, I>(tokens: &mut I) -> Option<(Option<u32>, &'a str)>
where
    I: Iterator<Item = &'a str>,
{
    let mut ttl = None;
    let mut seen_class = false;
    for _ in 0..3 {
        let token = tokens.next()?;
        if ttl.is_none() && token.chars().all(|c| c.is_ascii_digit()) {
            ttl = Some(token.parse().unwrap_or(300));
            continue;
        }
        if !seen_class
            && BIND_CLASSES
                .iter()
                .any(|class| token.eq_ignore_ascii_case(class))
        {
            seen_class = true;
            continue;
        }
        return is_record_type_token(token).then_some((ttl, token));
    }
    None
}

/// Parse a simplified BIND zone file with explicit resource ceilings.
pub fn try_parse_bind_zone(text: &str) -> Result<Vec<PartialDNSRecord>, ImportLimitError> {
    validate_import_text(text)?;
    let mut records = Vec::new();
    let mut line_count = 0usize;
    let mut retained_bytes = 0usize;

    for raw in text.trim().lines() {
        line_count = line_count.saturating_add(1);
        validate_line(raw, line_count)?;
        let line = raw.trim();
        // `$TTL`, `$ORIGIN`, and friends are directives, not records.
        if line.is_empty() || line.starts_with(';') || line.starts_with('$') {
            continue;
        }
        if records.len() >= MAX_IMPORT_RECORDS {
            return Err(ImportLimitError::new(
                "DNS import record count",
                MAX_IMPORT_RECORDS,
                records.len() + 1,
            ));
        }

        let no_comment = strip_bind_comment(line).trim();
        let mut parts = no_comment.split_whitespace();
        let Some(name) = parts.next() else {
            continue;
        };
        let Some((parsed_ttl, record_type)) = split_bind_prefix(&mut parts) else {
            continue;
        };
        for (label, value) in [("BIND name", name), ("BIND type", record_type)] {
            if value.len() > MAX_IMPORT_FIELD_BYTES {
                return Err(ImportLimitError::new(
                    label,
                    MAX_IMPORT_FIELD_BYTES,
                    value.len(),
                ));
            }
        }

        let ttl = parsed_ttl.unwrap_or(300);
        let mut priority = None;
        let mut content = String::new();
        if record_type.eq_ignore_ascii_case("MX") {
            if let Some(priority_text) = parts.next() {
                priority = priority_text.parse::<u16>().ok();
            }
        }
        for value in parts {
            let separator = usize::from(!content.is_empty());
            let next_len = content
                .len()
                .saturating_add(separator)
                .saturating_add(value.len());
            if next_len > MAX_IMPORT_FIELD_BYTES {
                return Err(ImportLimitError::new(
                    "BIND content",
                    MAX_IMPORT_FIELD_BYTES,
                    next_len,
                ));
            }
            if separator == 1 {
                content.push(' ');
            }
            content.push_str(value);
        }

        let name = Some(name.to_string());
        let record_type = Some(record_type.to_string());
        let content = Some(content);
        add_retained_bytes(&mut retained_bytes, &name)?;
        add_retained_bytes(&mut retained_bytes, &record_type)?;
        add_retained_bytes(&mut retained_bytes, &content)?;
        records.push(PartialDNSRecord {
            r#type: record_type,
            name,
            content,
            ttl: Some(ttl),
            priority,
            proxied: None,
        });
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
}
