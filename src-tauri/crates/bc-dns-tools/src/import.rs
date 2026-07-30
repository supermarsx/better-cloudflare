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
        if line.is_empty() || line.starts_with(';') {
            continue;
        }
        if records.len() >= MAX_IMPORT_RECORDS {
            return Err(ImportLimitError::new(
                "DNS import record count",
                MAX_IMPORT_RECORDS,
                records.len() + 1,
            ));
        }

        let no_comment = line.split(';').next().unwrap_or("").trim();
        let mut parts = no_comment.split_whitespace();
        let (Some(name), Some(ttl_text), Some(_class), Some(record_type)) =
            (parts.next(), parts.next(), parts.next(), parts.next())
        else {
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

        let ttl = ttl_text.parse().unwrap_or(300);
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
}
