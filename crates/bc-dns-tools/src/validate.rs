//! DNS record validation.
//!
//! Port of the TypeScript Zod-based `dnsRecordSchema` into pure Rust.
//! Returns a list of human-readable validation issues.

use serde::{Deserialize, Serialize};
use std::net::{Ipv4Addr, Ipv6Addr};

use crate::split_naptr_tokens;

/// Input for DNS record validation (mirrors the TS `dnsRecordSchema` shape).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DNSRecordValidationInput {
    pub r#type: String,
    pub name: String,
    pub content: String,
    #[serde(default)]
    pub ttl: Option<u32>,
    #[serde(default)]
    pub priority: Option<u16>,
    #[serde(default)]
    pub proxied: Option<bool>,
}

/// Result of validating a DNS record.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ValidationResult {
    pub ok: bool,
    pub issues: Vec<String>,
}

/// Supported DNS record types.
const VALID_TYPES: &[&str] = &[
    "A", "AAAA", "CNAME", "MX", "TXT", "SRV", "NS", "PTR", "CAA", "DS",
    "DNSKEY", "NAPTR", "SSHFP", "TLSA", "HINFO", "LOC", "SPF", "RP", "DNAME",
    "CERT", "SMIMEA", "OPENPGPKEY", "CDNSKEY", "AFSDB", "APL", "DCHID", "HIP",
    "IPSECKEY", "NSEC", "RRSIG", "SOA", "SVCB", "HTTPS", "URI", "ALIAS",
    "ANAME",
];

/// Validate a DNS record input and return all issues found.
pub fn validate_dns_record(input: &DNSRecordValidationInput) -> ValidationResult {
    let mut issues = Vec::new();

    // Type check
    if !VALID_TYPES.contains(&input.r#type.as_str()) {
        issues.push(format!("Unknown record type: {}", input.r#type));
    }

    // A record: must be valid IPv4
    if input.r#type == "A" && input.content.parse::<Ipv4Addr>().is_err() {
        issues.push("A record content must be a valid IPv4 address".to_string());
    }

    // AAAA record: must be valid IPv6
    if input.r#type == "AAAA" && input.content.parse::<Ipv6Addr>().is_err() {
        issues.push("AAAA record content must be a valid IPv6 address".to_string());
    }

    // MX record: needs integer priority + hostname content
    if input.r#type == "MX" {
        if input.priority.is_none() {
            issues.push("MX records must include an integer priority".to_string());
        }
        let content = input.content.trim();
        if content.is_empty() || content.contains(char::is_whitespace) {
            issues.push("MX content must be a non-empty hostname with no spaces".to_string());
        }
    }

    // SRV record: "priority weight port target"
    if input.r#type == "SRV" {
        let re_like = |s: &str| -> bool {
            let parts: Vec<&str> = s.split_whitespace().collect();
            parts.len() >= 4
                && parts[0].parse::<u16>().is_ok()
                && parts[1].parse::<u16>().is_ok()
                && parts[2].parse::<u16>().is_ok()
                && !parts[3].is_empty()
        };
        if !re_like(&input.content) {
            issues.push("SRV content must be: \"priority weight port target\"".to_string());
        }
    }

    // TLSA record: "usage selector matching-type data"
    if input.r#type == "TLSA" {
        let parts: Vec<&str> = input.content.split_whitespace().collect();
        let ok = parts.len() >= 4
            && parts[0].parse::<u8>().is_ok()
            && parts[1].parse::<u8>().is_ok()
            && parts[2].parse::<u8>().is_ok()
            && !parts[3].is_empty();
        if !ok {
            issues.push("TLSA content must be: \"usage selector matching-type data\"".to_string());
        }
    }

    // SSHFP record: "algorithm fptype fingerprint"
    if input.r#type == "SSHFP" {
        let parts: Vec<&str> = input.content.split_whitespace().collect();
        let ok = parts.len() >= 3
            && parts[0].parse::<u8>().is_ok()
            && parts[1].parse::<u8>().is_ok()
            && parts[2].chars().all(|c| c.is_ascii_hexdigit());
        if !ok {
            issues.push("SSHFP content must be: \"algorithm fptype fingerprint\"".to_string());
        }
    }

    // NAPTR record: "order preference flags service regexp replacement"
    if input.r#type == "NAPTR" {
        let tokens = split_naptr_tokens(input.content.trim());
        if tokens.len() < 6 {
            issues.push("NAPTR content must be: \"order preference flags service regexp replacement\"".to_string());
        } else {
            if tokens[0].parse::<u16>().is_err() {
                issues.push("NAPTR order must be an integer".to_string());
            }
            if tokens[1].parse::<u16>().is_err() {
                issues.push("NAPTR preference must be an integer".to_string());
            }
            if tokens[2].trim().is_empty() {
                issues.push("NAPTR flags must be a non-empty token".to_string());
            }
            let svc = &tokens[3];
            if svc.trim().is_empty() || svc.contains(' ') {
                issues.push("NAPTR service must be a non-empty token".to_string());
            }
            if tokens[4].trim().is_empty() {
                issues.push("NAPTR regexp must be non-empty".to_string());
            }
            if tokens[5].trim().is_empty() {
                issues.push("NAPTR replacement must be a non-empty token".to_string());
            }
        }
    }

    // Hostname-like records: CNAME, NS, PTR, ALIAS, ANAME
    if matches!(input.r#type.as_str(), "CNAME" | "NS" | "PTR" | "ALIAS" | "ANAME") {
        if !is_valid_hostname(&input.content) {
            issues.push(format!("{} content must be a valid hostname", input.r#type));
        }
    }

    // SPF record: must start with v=spf1 and parse
    if input.r#type == "SPF" {
        let content = input.content.trim().to_lowercase();
        if !content.starts_with("v=spf1") {
            issues.push("SPF: record must start with v=spf1".to_string());
        } else if bc_spf::parse_spf(&input.content).is_none() {
            issues.push("SPF: failed to parse SPF record".to_string());
        }
    }

    ValidationResult {
        ok: issues.is_empty(),
        issues,
    }
}

/// Basic hostname validation (RFC 952 / 1123).
fn is_valid_hostname(s: &str) -> bool {
    let s = s.trim().trim_end_matches('.');
    if s.is_empty() || s.len() > 253 {
        return false;
    }
    for label in s.split('.') {
        if label.is_empty() || label.len() > 63 {
            return false;
        }
        if label.starts_with('-') || label.ends_with('-') {
            return false;
        }
        if !label
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-')
        {
            return false;
        }
    }
    true
}

#[cfg(test)]
mod tests {
    use super::*;

    fn input(rtype: &str, content: &str) -> DNSRecordValidationInput {
        DNSRecordValidationInput {
            r#type: rtype.to_string(),
            name: "test".to_string(),
            content: content.to_string(),
            ttl: None,
            priority: None,
            proxied: None,
        }
    }

    #[test]
    fn valid_a_record() {
        let r = validate_dns_record(&input("A", "1.2.3.4"));
        assert!(r.ok, "{:?}", r.issues);
    }

    #[test]
    fn invalid_a_record() {
        let r = validate_dns_record(&input("A", "not-an-ip"));
        assert!(!r.ok);
    }

    #[test]
    fn valid_aaaa_record() {
        let r = validate_dns_record(&input("AAAA", "::1"));
        assert!(r.ok, "{:?}", r.issues);
    }

    #[test]
    fn valid_cname_record() {
        let r = validate_dns_record(&input("CNAME", "example.com"));
        assert!(r.ok, "{:?}", r.issues);
    }

    #[test]
    fn invalid_cname_record() {
        let r = validate_dns_record(&input("CNAME", "not a hostname!"));
        assert!(!r.ok);
    }

    #[test]
    fn valid_srv_record() {
        let r = validate_dns_record(&input("SRV", "10 5 8080 target.example.com"));
        assert!(r.ok, "{:?}", r.issues);
    }

    #[test]
    fn mx_without_priority() {
        let r = validate_dns_record(&input("MX", "mail.example.com"));
        assert!(!r.ok);
        assert!(r.issues.iter().any(|i| i.contains("priority")));
    }
}
