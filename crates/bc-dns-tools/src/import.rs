//! DNS record import: CSV and BIND zone file parsing.

use serde::{Deserialize, Serialize};

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

// ── CSV parsing ─────────────────────────────────────────────────────────────

/// Parse a single CSV line respecting quoted values and escaped quotes.
fn parse_csv_line(line: &str) -> Vec<String> {
    let mut result = Vec::new();
    let mut current = String::new();
    let mut in_quotes = false;
    let chars: Vec<char> = line.chars().collect();
    let mut i = 0;
    while i < chars.len() {
        let ch = chars[i];
        if ch == '"' {
            if in_quotes && i + 1 < chars.len() && chars[i + 1] == '"' {
                current.push('"');
                i += 1;
            } else {
                in_quotes = !in_quotes;
            }
        } else if ch == ',' && !in_quotes {
            result.push(current.trim().to_string());
            current.clear();
        } else {
            current.push(ch);
        }
        i += 1;
    }
    result.push(current.trim().to_string());
    result
}

/// Parse CSV text into a list of partial DNS records.
///
/// Expected header columns (case-insensitive): Type, Name, Content, TTL,
/// Priority, Proxied.
pub fn parse_csv_records(text: &str) -> Vec<PartialDNSRecord> {
    let lines: Vec<&str> = text.trim().lines().filter(|l| !l.is_empty()).collect();
    if lines.is_empty() {
        return Vec::new();
    }

    let headers: Vec<String> = parse_csv_line(lines[0])
        .iter()
        .map(|h| h.to_lowercase())
        .collect();

    let idx_type = headers.iter().position(|h| h == "type");
    let idx_name = headers.iter().position(|h| h == "name");
    let idx_content = headers.iter().position(|h| h == "content");
    let idx_ttl = headers.iter().position(|h| h == "ttl");
    let idx_priority = headers.iter().position(|h| h == "priority");
    let idx_proxied = headers.iter().position(|h| h == "proxied");

    let mut records = Vec::new();
    for line in &lines[1..] {
        let values = parse_csv_line(line);
        if values.is_empty() {
            continue;
        }

        let get = |idx: Option<usize>| -> Option<String> {
            idx.and_then(|i| values.get(i))
                .map(|s| s.to_string())
                .filter(|s| !s.is_empty())
        };

        let ttl = get(idx_ttl).and_then(|s| {
            if s == "auto" {
                None
            } else {
                s.parse().ok()
            }
        });
        let priority = get(idx_priority).and_then(|s| s.parse().ok());
        let proxied = get(idx_proxied).map(|s| {
            matches!(s.to_lowercase().as_str(), "true" | "1")
        });

        records.push(PartialDNSRecord {
            r#type: get(idx_type),
            name: get(idx_name),
            content: get(idx_content),
            ttl,
            priority,
            proxied,
        });
    }

    records
}

/// Parse a simplified BIND zone file into a list of partial DNS records.
///
/// Expected line format: `<name> <ttl> IN <type> <content>`
/// Lines starting with `;` are comments. Empty lines are ignored.
pub fn parse_bind_zone(text: &str) -> Vec<PartialDNSRecord> {
    let mut records = Vec::new();
    for raw in text.trim().lines() {
        let line = raw.trim();
        if line.is_empty() || line.starts_with(';') {
            continue;
        }
        // Strip inline comments
        let no_comment = line.split(';').next().unwrap_or("").trim();
        let parts: Vec<&str> = no_comment.split_whitespace().collect();
        if parts.len() < 4 {
            continue;
        }
        let name = parts[0].to_string();
        let ttl: u32 = parts[1].parse().unwrap_or(300);
        // parts[2] == "IN"
        let rtype = parts[3].to_string();
        let rest = &parts[4..];

        let (priority, content_parts) = if rtype.eq_ignore_ascii_case("MX") && rest.len() >= 2 {
            (rest[0].parse::<u16>().ok(), &rest[1..])
        } else {
            (None, rest)
        };

        records.push(PartialDNSRecord {
            r#type: Some(rtype),
            name: Some(name),
            content: Some(content_parts.join(" ")),
            ttl: Some(ttl),
            priority,
            proxied: None,
        });
    }
    records
}
