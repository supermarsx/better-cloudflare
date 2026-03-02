//! Structured record compose / parse helpers for SRV, TLSA, SSHFP, NAPTR.

use serde::{Deserialize, Serialize};

// ── SRV ─────────────────────────────────────────────────────────────────────

/// Parsed components of an SRV record's content field.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SRVFields {
    pub priority: Option<u16>,
    pub weight: Option<u16>,
    pub port: Option<u16>,
    pub target: String,
}

/// Parse an SRV content string (`priority weight port target`) into components.
pub fn parse_srv(content: &str) -> SRVFields {
    let content = content.trim();
    if content.is_empty() {
        return SRVFields {
            priority: None,
            weight: None,
            port: None,
            target: String::new(),
        };
    }
    let parts: Vec<&str> = content.split_whitespace().collect();
    if parts.len() < 4 {
        return SRVFields {
            priority: None,
            weight: None,
            port: None,
            target: content.to_string(),
        };
    }
    SRVFields {
        priority: parts[0].parse().ok(),
        weight: parts[1].parse().ok(),
        port: parts[2].parse().ok(),
        target: parts[3..].join(" "),
    }
}

/// Compose an SRV content string from fields.
pub fn compose_srv(priority: Option<u16>, weight: Option<u16>, port: Option<u16>, target: &str) -> String {
    format!(
        "{} {} {} {}",
        priority.unwrap_or(0),
        weight.unwrap_or(0),
        port.unwrap_or(0),
        target
    )
}

// ── TLSA ────────────────────────────────────────────────────────────────────

/// Parsed components of a TLSA record's content field.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TLSAFields {
    pub usage: Option<u8>,
    pub selector: Option<u8>,
    pub matching_type: Option<u8>,
    pub data: String,
}

/// Parse a TLSA content string (`usage selector matching_type data`).
pub fn parse_tlsa(content: &str) -> TLSAFields {
    let content = content.trim();
    if content.is_empty() {
        return TLSAFields {
            usage: None,
            selector: None,
            matching_type: None,
            data: String::new(),
        };
    }
    let parts: Vec<&str> = content.split_whitespace().collect();
    if parts.len() < 4 {
        return TLSAFields {
            usage: None,
            selector: None,
            matching_type: None,
            data: content.to_string(),
        };
    }
    TLSAFields {
        usage: parts[0].parse().ok(),
        selector: parts[1].parse().ok(),
        matching_type: parts[2].parse().ok(),
        data: parts[3..].join(" "),
    }
}

/// Compose a TLSA content string from fields.
pub fn compose_tlsa(usage: Option<u8>, selector: Option<u8>, matching_type: Option<u8>, data: &str) -> String {
    format!(
        "{} {} {} {}",
        usage.unwrap_or(0),
        selector.unwrap_or(0),
        matching_type.unwrap_or(0),
        data
    )
}

// ── SSHFP ───────────────────────────────────────────────────────────────────

/// Parsed components of an SSHFP record's content field.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SSHFPFields {
    pub algorithm: Option<u8>,
    pub fptype: Option<u8>,
    pub fingerprint: String,
}

/// Parse an SSHFP content string (`algorithm fptype fingerprint`).
pub fn parse_sshfp(content: &str) -> SSHFPFields {
    let content = content.trim();
    if content.is_empty() {
        return SSHFPFields {
            algorithm: None,
            fptype: None,
            fingerprint: String::new(),
        };
    }
    let parts: Vec<&str> = content.split_whitespace().collect();
    if parts.len() < 3 {
        return SSHFPFields {
            algorithm: None,
            fptype: None,
            fingerprint: content.to_string(),
        };
    }
    SSHFPFields {
        algorithm: parts[0].parse().ok(),
        fptype: parts[1].parse().ok(),
        fingerprint: parts[2..].join(" "),
    }
}

/// Compose an SSHFP content string from fields.
pub fn compose_sshfp(algorithm: Option<u8>, fptype: Option<u8>, fingerprint: &str) -> String {
    format!(
        "{} {} {}",
        algorithm.unwrap_or(0),
        fptype.unwrap_or(0),
        fingerprint
    )
}

// ── NAPTR ───────────────────────────────────────────────────────────────────

/// Parsed components of a NAPTR record's content field.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NAPTRFields {
    pub order: Option<u16>,
    pub preference: Option<u16>,
    pub flags: String,
    pub service: String,
    pub regexp: String,
    pub replacement: String,
}

/// Split NAPTR content into tokens, respecting quoted strings.
pub fn split_naptr_tokens(s: &str) -> Vec<String> {
    let mut tokens = Vec::new();
    let mut current = String::new();
    let mut in_quote = false;
    for ch in s.chars() {
        if ch == '"' {
            in_quote = !in_quote;
            current.push(ch);
            continue;
        }
        if ch == ' ' && !in_quote {
            let trimmed = current.trim().to_string();
            if !trimmed.is_empty() {
                tokens.push(trimmed);
                current.clear();
            }
            continue;
        }
        current.push(ch);
    }
    let trimmed = current.trim().to_string();
    if !trimmed.is_empty() {
        tokens.push(trimmed);
    }
    tokens
}

/// Parse a NAPTR content string.
pub fn parse_naptr(content: &str) -> NAPTRFields {
    let content = content.trim();
    if content.is_empty() {
        return NAPTRFields {
            order: None,
            preference: None,
            flags: String::new(),
            service: String::new(),
            regexp: String::new(),
            replacement: String::new(),
        };
    }
    let tokens = split_naptr_tokens(content);
    let order = tokens.first().and_then(|s| s.parse().ok());
    let preference = tokens.get(1).and_then(|s| s.parse().ok());
    let strip_quotes = |s: &str| s.trim_matches('"').to_string();
    let flags = tokens.get(2).map(|s| strip_quotes(s)).unwrap_or_default();
    let service = tokens.get(3).cloned().unwrap_or_default();
    let regexp = tokens.get(4).map(|s| strip_quotes(s)).unwrap_or_default();
    let replacement = tokens.get(5).cloned().unwrap_or_default();

    NAPTRFields {
        order,
        preference,
        flags,
        service,
        regexp,
        replacement,
    }
}

/// Compose a NAPTR content string from fields.
pub fn compose_naptr(
    order: Option<u16>,
    preference: Option<u16>,
    flags: &str,
    service: &str,
    regexp: &str,
    replacement: &str,
) -> String {
    let quote_if_needed = |s: &str| -> String {
        if s.is_empty() {
            return String::new();
        }
        if s.contains(' ') || s.contains('"') {
            format!("\"{}\"", s.replace('"', "\\\""))
        } else {
            s.to_string()
        }
    };
    format!(
        "{} {} {} {} {} {}",
        order.unwrap_or(0),
        preference.unwrap_or(0),
        flags,
        service,
        quote_if_needed(regexp),
        replacement
    )
}
