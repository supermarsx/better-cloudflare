//! Bounded DNS record export: CSV, BIND zone, and JSON formatters.

use bc_cloudflare_api::DNSRecord;
use std::fmt;
use std::io::{self, Write as IoWrite};

use crate::{
    MAX_EXPORT_FIELD_BYTES, MAX_EXPORT_INPUT_BYTES, MAX_EXPORT_OUTPUT_BYTES, MAX_EXPORT_RECORDS,
};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ExportLimitError {
    resource: &'static str,
    limit: usize,
    actual: usize,
}

impl ExportLimitError {
    fn new(resource: &'static str, limit: usize, actual: usize) -> Self {
        Self {
            resource,
            limit,
            actual,
        }
    }
}

impl fmt::Display for ExportLimitError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(
            formatter,
            "{} exceeds the safe export limit of {} bytes/items (actual: {})",
            self.resource, self.limit, self.actual
        )
    }
}

impl std::error::Error for ExportLimitError {}

fn validate_records(records: &[DNSRecord]) -> Result<(), ExportLimitError> {
    if records.len() > MAX_EXPORT_RECORDS {
        return Err(ExportLimitError::new(
            "DNS export record count",
            MAX_EXPORT_RECORDS,
            records.len(),
        ));
    }

    let mut aggregate = 0usize;
    for record in records {
        for (label, value) in [
            ("DNS record id", record.id.as_deref().unwrap_or("")),
            ("DNS record type", record.r#type.as_str()),
            ("DNS record name", record.name.as_str()),
            ("DNS record content", record.content.as_str()),
            (
                "DNS record comment",
                record.comment.as_deref().unwrap_or(""),
            ),
            ("DNS record zone id", record.zone_id.as_str()),
            ("DNS record zone name", record.zone_name.as_str()),
            ("DNS record created timestamp", record.created_on.as_str()),
            ("DNS record modified timestamp", record.modified_on.as_str()),
        ] {
            if value.len() > MAX_EXPORT_FIELD_BYTES {
                return Err(ExportLimitError::new(
                    label,
                    MAX_EXPORT_FIELD_BYTES,
                    value.len(),
                ));
            }
            aggregate = aggregate.saturating_add(value.len());
            if aggregate > MAX_EXPORT_INPUT_BYTES {
                return Err(ExportLimitError::new(
                    "aggregate DNS export fields",
                    MAX_EXPORT_INPUT_BYTES,
                    aggregate,
                ));
            }
        }
    }
    Ok(())
}

fn ensure_output_room(current: usize, additional: usize) -> Result<(), ExportLimitError> {
    let next = current.saturating_add(additional);
    if next > MAX_EXPORT_OUTPUT_BYTES {
        return Err(ExportLimitError::new(
            "DNS export output",
            MAX_EXPORT_OUTPUT_BYTES,
            next,
        ));
    }
    Ok(())
}

fn push_bounded(output: &mut String, value: &str) -> Result<(), ExportLimitError> {
    ensure_output_room(output.len(), value.len())?;
    output
        .try_reserve(value.len())
        .map_err(|_| ExportLimitError::new("DNS export allocation", value.len(), value.len()))?;
    output.push_str(value);
    Ok(())
}

fn push_csv_value(output: &mut String, value: &str) -> Result<(), ExportLimitError> {
    let maximum_growth = value.len().saturating_mul(2).saturating_add(2);
    ensure_output_room(output.len(), maximum_growth)?;
    output.try_reserve(maximum_growth).map_err(|_| {
        ExportLimitError::new("DNS export allocation", maximum_growth, maximum_growth)
    })?;
    output.push('"');
    for character in value.chars() {
        if character == '"' {
            output.push('"');
        }
        output.push(character);
        if output.len() > MAX_EXPORT_OUTPUT_BYTES {
            return Err(ExportLimitError::new(
                "DNS export output",
                MAX_EXPORT_OUTPUT_BYTES,
                output.len(),
            ));
        }
    }
    output.push('"');
    Ok(())
}

pub fn try_records_to_csv(records: &[DNSRecord]) -> Result<String, ExportLimitError> {
    validate_records(records)?;
    let mut output = String::new();
    push_bounded(
        &mut output,
        "\"Type\",\"Name\",\"Content\",\"TTL\",\"Priority\",\"Proxied\"\n",
    )?;
    for (index, record) in records.iter().enumerate() {
        let ttl = record
            .ttl
            .map(|value| value.to_string())
            .unwrap_or_default();
        let priority = record
            .priority
            .map(|value| value.to_string())
            .unwrap_or_default();
        let proxied = record.proxied.unwrap_or(false).to_string();
        for (field_index, value) in [
            record.r#type.as_str(),
            record.name.as_str(),
            record.content.as_str(),
            ttl.as_str(),
            priority.as_str(),
            proxied.as_str(),
        ]
        .into_iter()
        .enumerate()
        {
            if field_index > 0 {
                push_bounded(&mut output, ",")?;
            }
            push_csv_value(&mut output, value)?;
        }
        if index + 1 < records.len() {
            push_bounded(&mut output, "\n")?;
        }
    }
    Ok(output)
}

pub fn try_records_to_bind(records: &[DNSRecord]) -> Result<String, ExportLimitError> {
    validate_records(records)?;
    let mut output = String::new();
    for (index, record) in records.iter().enumerate() {
        if index > 0 {
            push_bounded(&mut output, "\n")?;
        }
        let ttl = record.ttl.unwrap_or(300);
        let priority = record
            .priority
            .map(|value| format!("{value} "))
            .unwrap_or_default();
        let line = format!(
            "{}\t{}\tIN\t{}\t{}{}",
            record.name, ttl, record.r#type, priority, record.content
        );
        push_bounded(&mut output, &line)?;
    }
    Ok(output)
}

struct CappedWriter {
    bytes: Vec<u8>,
}

impl CappedWriter {
    fn new() -> Self {
        Self { bytes: Vec::new() }
    }
}

impl IoWrite for CappedWriter {
    fn write(&mut self, buffer: &[u8]) -> io::Result<usize> {
        if self.bytes.len().saturating_add(buffer.len()) > MAX_EXPORT_OUTPUT_BYTES {
            return Err(io::Error::new(
                io::ErrorKind::OutOfMemory,
                "DNS export output limit exceeded",
            ));
        }
        self.bytes
            .try_reserve(buffer.len())
            .map_err(|_| io::Error::new(io::ErrorKind::OutOfMemory, "allocation failed"))?;
        self.bytes.extend_from_slice(buffer);
        Ok(buffer.len())
    }

    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

pub fn try_records_to_json(records: &[DNSRecord]) -> Result<String, ExportLimitError> {
    validate_records(records)?;
    let mut writer = CappedWriter::new();
    serde_json::to_writer_pretty(&mut writer, records).map_err(|error| {
        ExportLimitError::new(
            "DNS JSON export",
            MAX_EXPORT_OUTPUT_BYTES,
            if error.is_io() {
                MAX_EXPORT_OUTPUT_BYTES.saturating_add(1)
            } else {
                0
            },
        )
    })?;
    String::from_utf8(writer.bytes)
        .map_err(|_| ExportLimitError::new("DNS JSON UTF-8 output", 0, 0))
}

/// Compatibility entry point. Oversized data fails closed without partial output.
pub fn records_to_csv(records: &[DNSRecord]) -> String {
    try_records_to_csv(records).unwrap_or_default()
}

/// Compatibility entry point. Oversized data fails closed without partial output.
pub fn records_to_bind(records: &[DNSRecord]) -> String {
    try_records_to_bind(records).unwrap_or_default()
}

/// Compatibility entry point. Oversized data fails closed without partial output.
pub fn records_to_json(records: &[DNSRecord]) -> String {
    try_records_to_json(records).unwrap_or_else(|_| "[]".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn record(content: String) -> DNSRecord {
        DNSRecord {
            id: Some("id".to_string()),
            r#type: "TXT".to_string(),
            name: "example.com".to_string(),
            content,
            comment: None,
            ttl: Some(300),
            priority: None,
            proxied: Some(false),
            zone_id: "zone".to_string(),
            zone_name: "example.com".to_string(),
            created_on: String::new(),
            modified_on: String::new(),
        }
    }

    #[test]
    fn export_field_limit_accepts_exact_and_rejects_plus_one() {
        assert!(try_records_to_csv(&[record("x".repeat(MAX_EXPORT_FIELD_BYTES))]).is_ok());
        assert!(try_records_to_csv(&[record("x".repeat(MAX_EXPORT_FIELD_BYTES + 1))]).is_err());
    }

    #[test]
    fn export_record_limit_accepts_exact_and_rejects_plus_one() {
        let exact = vec![record("x".to_string()); MAX_EXPORT_RECORDS];
        assert!(try_records_to_bind(&exact).is_ok());
        let oversized = vec![record("x".to_string()); MAX_EXPORT_RECORDS + 1];
        assert!(try_records_to_bind(&oversized).is_err());
        assert!(records_to_bind(&oversized).is_empty());
    }

    #[test]
    fn json_writer_rejects_escape_amplification_at_output_ceiling() {
        let content = "\u{0001}".repeat(MAX_EXPORT_FIELD_BYTES);
        let records = vec![record(content); MAX_EXPORT_INPUT_BYTES / MAX_EXPORT_FIELD_BYTES - 1];
        assert!(try_records_to_json(&records).is_err());
    }

    #[test]
    fn csv_escapes_quotes_without_row_vector() {
        let csv = try_records_to_csv(&[record("a\"b".to_string())]).unwrap();
        assert!(csv.contains("\"a\"\"b\""));
    }
}
