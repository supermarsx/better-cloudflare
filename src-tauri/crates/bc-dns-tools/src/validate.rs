//! DNS record validation.
//!
//! Port of the TypeScript Zod-based `dnsRecordSchema` into pure Rust, extended
//! with the record-shape rules that every write path must satisfy before a
//! record is forwarded to Cloudflare.
//!
//! Rules are deliberately split into two classes:
//!
//! * **Strict** — the value is unambiguously invalid for the record type under
//!   the relevant RFC, so rejecting it can only ever block a request Cloudflare
//!   would have rejected anyway.
//! * **Permissive** — the rule is plan-specific, provider-specific, or
//!   genuinely ambiguous. Those are left unchecked so Cloudflare stays the final
//!   authority and a legitimate record is never blocked locally.

use serde::{Deserialize, Serialize};
use std::net::{Ipv4Addr, Ipv6Addr};

use bc_cloudflare_api::DNSRecordInput;

use crate::split_naptr_tokens;

/// Maximum bytes in one DNS name (RFC 1035 §2.3.4).
const MAX_NAME_BYTES: usize = 255;
/// Maximum bytes in a presentation-format hostname without the root label.
const MAX_HOSTNAME_BYTES: usize = 253;
/// Maximum bytes in one DNS label (RFC 1035 §2.3.4).
const MAX_LABEL_BYTES: usize = 63;
/// Maximum bytes in one DNS character-string (RFC 1035 §3.3).
const MAX_CHARACTER_STRING_BYTES: usize = 255;
/// Absolute ceiling on record data; no RDATA can exceed a 16-bit length.
const MAX_CONTENT_BYTES: usize = 65_535;
/// Highest value representable in the 31-bit DNS TTL field.
const MAX_TTL_SECONDS: u32 = 2_147_483_647;

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

impl DNSRecordValidationInput {
    /// Borrow the fields a Cloudflare write payload contributes to validation.
    pub fn from_record_input(record: &DNSRecordInput) -> Self {
        Self {
            r#type: record.r#type.clone(),
            name: record.name.clone(),
            content: record.content.clone(),
            ttl: record.ttl,
            priority: record.priority,
            proxied: record.proxied,
        }
    }
}

/// Result of validating a DNS record.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ValidationResult {
    pub ok: bool,
    pub issues: Vec<String>,
}

/// Supported DNS record types.
const VALID_TYPES: &[&str] = &[
    "A",
    "AAAA",
    "CNAME",
    "MX",
    "TXT",
    "SRV",
    "NS",
    "PTR",
    "CAA",
    "DS",
    "DNSKEY",
    "NAPTR",
    "SSHFP",
    "TLSA",
    "HINFO",
    "LOC",
    "SPF",
    "RP",
    "DNAME",
    "CERT",
    "SMIMEA",
    "OPENPGPKEY",
    "CDNSKEY",
    "AFSDB",
    "APL",
    "DCHID",
    "HIP",
    "IPSECKEY",
    "NSEC",
    "RRSIG",
    "SOA",
    "SVCB",
    "HTTPS",
    "URI",
    "ALIAS",
    "ANAME",
];

/// Record types whose content is a single domain name.
const HOSTNAME_CONTENT_TYPES: &[&str] = &["CNAME", "NS", "PTR", "ALIAS", "ANAME", "DNAME"];

/// Validate a Cloudflare write payload before it is sent.
pub fn validate_record_input(record: &DNSRecordInput) -> ValidationResult {
    validate_dns_record(&DNSRecordValidationInput::from_record_input(record))
}

/// Validate a DNS record input and return all issues found.
pub fn validate_dns_record(input: &DNSRecordValidationInput) -> ValidationResult {
    let mut issues = Vec::new();
    let record_type = input.r#type.trim();
    let content = input.content.trim();

    if !VALID_TYPES.contains(&record_type) {
        issues.push(format!("Unknown record type: {}", input.r#type));
    }

    validate_name(input.name.trim(), &mut issues);
    validate_content_size(content, &mut issues);
    validate_ttl(input.ttl, &mut issues);
    validate_content(record_type, content, input.priority, &mut issues);

    ValidationResult {
        ok: issues.is_empty(),
        issues,
    }
}

/// Strict: a record must be named, the name must fit a DNS name, and it must
/// not contain whitespace. Permissive: `@`, `*`, leading underscores, and
/// non-ASCII labels are all accepted because Cloudflare accepts them.
fn validate_name(name: &str, issues: &mut Vec<String>) {
    if name.is_empty() {
        issues.push("Record name must not be empty".to_string());
    } else if name.len() > MAX_NAME_BYTES {
        issues.push(format!(
            "Record name must be at most {MAX_NAME_BYTES} bytes"
        ));
    } else if name.chars().any(char::is_whitespace) {
        issues.push("Record name must not contain spaces".to_string());
    }
}

/// Strict: content is required, and no RDATA can exceed a 16-bit length.
fn validate_content_size(content: &str, issues: &mut Vec<String>) {
    if content.is_empty() {
        issues.push("Record content must not be empty".to_string());
    } else if content.len() > MAX_CONTENT_BYTES {
        issues.push(format!(
            "Record content must be at most {MAX_CONTENT_BYTES} bytes"
        ));
    }
}

/// Strict: zero and values above the 31-bit TTL field are always rejected by
/// DNS. Permissive: plan-specific floors (Cloudflare's 60 second free-plan
/// minimum, its 30 second enterprise minimum) are left to Cloudflare.
fn validate_ttl(ttl: Option<u32>, issues: &mut Vec<String>) {
    match ttl {
        Some(0) => {
            issues.push("TTL must be 1 for automatic or a positive number of seconds".to_string())
        }
        Some(seconds) if seconds > MAX_TTL_SECONDS => {
            issues.push(format!("TTL must be at most {MAX_TTL_SECONDS} seconds"));
        }
        _ => {}
    }
}

fn validate_content(
    record_type: &str,
    content: &str,
    priority: Option<u16>,
    issues: &mut Vec<String>,
) {
    match record_type {
        // Strict: an address record must hold an address literal of its family.
        "A" => validate_ipv4(content, issues),
        "AAAA" => validate_ipv6(content, issues),
        "MX" => validate_mx(content, priority, issues),
        "SRV" => validate_srv(content, priority, issues),
        "CAA" => validate_caa(content, issues),
        "TXT" | "SPF" => validate_text(record_type, content, issues),
        "TLSA" => validate_tlsa(content, issues),
        "SSHFP" => validate_sshfp(content, issues),
        "NAPTR" => validate_naptr(content, issues),
        _ => {}
    }

    // Strict: these record types carry exactly one domain name.
    if HOSTNAME_CONTENT_TYPES.contains(&record_type) {
        if let Some(issue) = hostname_issue(&format!("{record_type} content"), content) {
            issues.push(issue);
        }
    }

    if record_type == "SPF" {
        validate_spf_text(content, issues);
    }
}

fn validate_ipv4(content: &str, issues: &mut Vec<String>) {
    if content.parse::<Ipv4Addr>().is_err() {
        issues.push("A record content must be a valid IPv4 address".to_string());
    }
}

fn validate_ipv6(content: &str, issues: &mut Vec<String>) {
    if content.parse::<Ipv6Addr>().is_err() {
        issues.push("AAAA record content must be a valid IPv6 address".to_string());
    }
}

/// Strict: MX requires a priority and a single hostname. Permissive: the null
/// MX target `.` (RFC 7505) is accepted, and the priority's 0-65535 range is
/// already enforced by the `u16` field type at the IPC boundary.
fn validate_mx(content: &str, priority: Option<u16>, issues: &mut Vec<String>) {
    if priority.is_none() {
        issues.push("MX records must include an integer priority".to_string());
    }
    if content.is_empty() || content.contains(char::is_whitespace) {
        issues.push("MX content must be a non-empty hostname with no spaces".to_string());
    } else if content != "." {
        if let Some(issue) = hostname_issue("MX content", content) {
            issues.push(issue);
        }
    }
}

/// Strict: SRV content is `priority weight port target`, each numeric field is
/// a 16-bit integer, and the target is a hostname. Permissive: the "no such
/// service" target `.` (RFC 2782) is accepted, and trailing tokens are left to
/// Cloudflare rather than rejected locally.
///
/// Cloudflare returns SRV records with the priority in its own field and only
/// `weight port target` in the content, so that shape is accepted when a
/// priority is present. Rejecting it would make every SRV record read back
/// from the API unsavable, and the copy engine and the exporter already agree
/// that both shapes are real.
fn validate_srv(content: &str, priority: Option<u16>, issues: &mut Vec<String>) {
    let parts: Vec<&str> = content.split_whitespace().collect();
    let embeds_priority = match parts.len() {
        0..=2 => {
            issues.push(
                "SRV content must be: \"priority weight port target\", or \
                 \"weight port target\" when the priority is a separate field"
                    .to_string(),
            );
            return;
        }
        // Three tokens are only a complete record when the priority arrives
        // separately; otherwise the port or the target is missing.
        3 if priority.is_none() => {
            issues.push(
                "SRV content must be: \"priority weight port target\", or \
                 \"weight port target\" when the priority is a separate field"
                    .to_string(),
            );
            return;
        }
        3 => false,
        _ => true,
    };

    let numeric: &[(usize, &str)] = if embeds_priority {
        &[(0, "priority"), (1, "weight"), (2, "port")]
    } else {
        &[(0, "weight"), (1, "port")]
    };
    for (index, field) in numeric {
        if parts[*index].parse::<u16>().is_err() {
            issues.push(format!(
                "SRV {field} must be an integer between 0 and 65535"
            ));
        }
    }

    let target = parts[if embeds_priority { 3 } else { 2 }];
    if target != "." {
        if let Some(issue) = hostname_issue("SRV target", target) {
            issues.push(issue);
        }
    }
}

/// Strict: CAA content is `flags tag value`, flags is 0-255, and the tag is the
/// `1*(ALPHA / DIGIT)` token RFC 8659 defines. Permissive: the tag is not
/// checked against a known-tag list, so newly standardised tags still pass.
fn validate_caa(content: &str, issues: &mut Vec<String>) {
    let mut tokens = content.split_whitespace();
    let (Some(flags), Some(tag), true) = (tokens.next(), tokens.next(), tokens.next().is_some())
    else {
        issues.push("CAA content must be: \"flags tag value\"".to_string());
        return;
    };
    if flags.parse::<u8>().is_err() {
        issues.push("CAA flags must be an integer between 0 and 255".to_string());
    }
    if !tag
        .chars()
        .all(|character| character.is_ascii_alphanumeric())
    {
        issues.push(
            "CAA tag must be an alphanumeric token such as issue, issuewild, or iodef".to_string(),
        );
    }
}

/// Strict: when the value is written as an explicit sequence of quoted
/// character-strings, each string must fit the 255 byte character-string limit.
/// Permissive: a bare unquoted value longer than 255 bytes is accepted because
/// Cloudflare splits long DKIM and SPF values into character-strings itself.
fn validate_text(record_type: &str, content: &str, issues: &mut Vec<String>) {
    let Some(strings) = quoted_character_strings(content) else {
        return;
    };
    if strings
        .iter()
        .any(|string| string.len() > MAX_CHARACTER_STRING_BYTES)
    {
        issues.push(format!(
            "{record_type} character strings must be at most {MAX_CHARACTER_STRING_BYTES} bytes each"
        ));
    }
}

fn validate_tlsa(content: &str, issues: &mut Vec<String>) {
    let parts: Vec<&str> = content.split_whitespace().collect();
    let ok = parts.len() >= 4
        && parts[0].parse::<u8>().is_ok()
        && parts[1].parse::<u8>().is_ok()
        && parts[2].parse::<u8>().is_ok()
        && !parts[3].is_empty();
    if !ok {
        issues.push("TLSA content must be: \"usage selector matching-type data\"".to_string());
    }
}

fn validate_sshfp(content: &str, issues: &mut Vec<String>) {
    let parts: Vec<&str> = content.split_whitespace().collect();
    let ok = parts.len() >= 3
        && parts[0].parse::<u8>().is_ok()
        && parts[1].parse::<u8>().is_ok()
        && parts[2].chars().all(|c| c.is_ascii_hexdigit());
    if !ok {
        issues.push("SSHFP content must be: \"algorithm fptype fingerprint\"".to_string());
    }
}

fn validate_naptr(content: &str, issues: &mut Vec<String>) {
    let tokens = split_naptr_tokens(content);
    if tokens.len() < 6 {
        issues.push(
            "NAPTR content must be: \"order preference flags service regexp replacement\""
                .to_string(),
        );
        return;
    }
    if tokens[0].parse::<u16>().is_err() {
        issues.push("NAPTR order must be an integer".to_string());
    }
    if tokens[1].parse::<u16>().is_err() {
        issues.push("NAPTR preference must be an integer".to_string());
    }
    if tokens[2].trim().is_empty() {
        issues.push("NAPTR flags must be a non-empty token".to_string());
    }
    let service = &tokens[3];
    if service.trim().is_empty() || service.contains(' ') {
        issues.push("NAPTR service must be a non-empty token".to_string());
    }
    if tokens[4].trim().is_empty() {
        issues.push("NAPTR regexp must be non-empty".to_string());
    }
    if tokens[5].trim().is_empty() {
        issues.push("NAPTR replacement must be a non-empty token".to_string());
    }
}

fn validate_spf_text(content: &str, issues: &mut Vec<String>) {
    if !content.to_lowercase().starts_with("v=spf1") {
        issues.push("SPF: record must start with v=spf1".to_string());
    } else if bc_spf::parse_spf(content).is_none() {
        issues.push("SPF: failed to parse SPF record".to_string());
    }
}

/// Split a value written as a sequence of quoted character-strings.
///
/// Returns `None` — meaning "not a quoted sequence, do not measure it" —
/// whenever the value is bare, unbalanced, or contains a backslash escape whose
/// wire length cannot be measured from the presentation text.
fn quoted_character_strings(content: &str) -> Option<Vec<String>> {
    if !content.starts_with('"') || content.contains('\\') {
        return None;
    }
    let mut strings = Vec::new();
    let mut current = String::new();
    let mut in_quote = false;
    for character in content.chars() {
        match character {
            '"' if in_quote => {
                in_quote = false;
                strings.push(std::mem::take(&mut current));
            }
            '"' => in_quote = true,
            _ if in_quote => current.push(character),
            _ if character.is_whitespace() => {}
            // A bare token outside the quotes: not a clean quoted sequence.
            _ => return None,
        }
    }
    if in_quote || strings.is_empty() {
        return None;
    }
    Some(strings)
}

/// Why a value is not usable as a DNS host name.
#[derive(Debug, Clone, PartialEq, Eq)]
enum HostnameError {
    Empty,
    IpLiteral,
    NotEncodable,
    TooLong(usize),
    EmptyLabel,
    LabelTooLong(usize),
    HyphenAtLabelEdge,
    InvalidCharacter(char),
}

impl HostnameError {
    fn reason(&self) -> String {
        match self {
            Self::Empty => "the value is empty".to_string(),
            Self::IpLiteral => "an IP address literal is not a hostname".to_string(),
            Self::NotEncodable => {
                "the name cannot be encoded as an internationalised (punycode) hostname".to_string()
            }
            Self::TooLong(actual) => format!(
                "the encoded name is {actual} octets, over the {MAX_HOSTNAME_BYTES} octet limit"
            ),
            Self::EmptyLabel => "it contains an empty label (consecutive dots)".to_string(),
            Self::LabelTooLong(actual) => format!(
                "an encoded label is {actual} octets, over the {MAX_LABEL_BYTES} octet limit"
            ),
            Self::HyphenAtLabelEdge => "a label begins or ends with a hyphen".to_string(),
            Self::InvalidCharacter(character) => {
                format!("{character:?} is not allowed in a hostname label")
            }
        }
    }
}

/// Hostname validation (RFC 952 / 1123), applied to every record type whose
/// content is a domain name.
///
/// **Strict.** The octet ceilings (253 for the name, 63 per label), empty
/// labels, hyphens at a label edge, characters outside the letter/digit/hyphen
/// repertoire, and IP address literals where a name belongs — an `MX` or
/// `CNAME` pointing at an address is a frequent and silently damaging
/// misconfiguration.
///
/// **Internationalised names.** Unicode input is accepted and converted to its
/// A-label (punycode) form by the `idna` crate before it is measured, because
/// the octet ceilings apply to the encoded name rather than the display form.
/// Validation only measures: the caller's original string is what is sent to
/// Cloudflare, so nothing is silently rewritten.
///
/// **Permissive: underscores.** Underscore labels are accepted in targets as
/// well as owner names. They are required by ACME DNS-01 delegation
/// (`_acme-challenge.example.com CNAME _acme-challenge.example.com.acme-dns.io`)
/// and by Microsoft 365 DKIM, whose CNAME targets contain `._domainkey.`.
/// Rejecting them would block correct, widely deployed records, which is worse
/// than letting an unusual one through to Cloudflare.
fn check_hostname(value: &str) -> Result<(), HostnameError> {
    let value = value.trim();
    if value.is_empty() {
        return Err(HostnameError::Empty);
    }
    // Checked before encoding: `192.0.2.1` is a well-formed label sequence.
    if value.parse::<Ipv4Addr>().is_ok() || value.parse::<Ipv6Addr>().is_ok() {
        return Err(HostnameError::IpLiteral);
    }

    // One trailing dot denotes the root and is not part of the measured name.
    let candidate = value.strip_suffix('.').unwrap_or(value);
    if candidate.is_empty() {
        return Err(HostnameError::Empty);
    }
    let ascii = idna::domain_to_ascii(candidate).map_err(|_| HostnameError::NotEncodable)?;
    if ascii.is_empty() {
        return Err(HostnameError::Empty);
    }
    if ascii.len() > MAX_HOSTNAME_BYTES {
        return Err(HostnameError::TooLong(ascii.len()));
    }

    for label in ascii.split('.') {
        if label.is_empty() {
            return Err(HostnameError::EmptyLabel);
        }
        if label.len() > MAX_LABEL_BYTES {
            return Err(HostnameError::LabelTooLong(label.len()));
        }
        if label.starts_with('-') || label.ends_with('-') {
            return Err(HostnameError::HyphenAtLabelEdge);
        }
        if let Some(character) = label
            .chars()
            .find(|c| !c.is_ascii_alphanumeric() && *c != '-' && *c != '_')
        {
            return Err(HostnameError::InvalidCharacter(character));
        }
    }
    Ok(())
}

/// Describe why `value` is not a valid hostname for `subject`, if it is not.
fn hostname_issue(subject: &str, value: &str) -> Option<String> {
    check_hostname(value)
        .err()
        .map(|error| format!("{subject} must be a valid hostname: {}", error.reason()))
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

    fn accepts(rtype: &str, content: &str) {
        let result = validate_dns_record(&input(rtype, content));
        assert!(
            result.ok,
            "{rtype} {content:?} rejected: {:?}",
            result.issues
        );
    }

    fn rejects_with(rtype: &str, content: &str, expected: &str) {
        let result = validate_dns_record(&input(rtype, content));
        assert!(!result.ok, "{rtype} {content:?} was accepted");
        assert!(
            result.issues.iter().any(|issue| issue.contains(expected)),
            "{rtype} {content:?} issues {:?} did not mention {expected:?}",
            result.issues
        );
    }

    #[test]
    fn unknown_record_types_are_rejected() {
        rejects_with("NOTATYPE", "value", "Unknown record type");
        accepts("TXT", "hello");
    }

    #[test]
    fn a_records_require_an_ipv4_literal() {
        accepts("A", "1.2.3.4");
        // Surrounding whitespace is tolerated so pasted values are not rejected.
        accepts("A", "  1.2.3.4  ");
        rejects_with("A", "not-an-ip", "valid IPv4 address");
        rejects_with("A", "::1", "valid IPv4 address");
        rejects_with("A", "1.2.3.4.5", "valid IPv4 address");
    }

    #[test]
    fn aaaa_records_require_an_ipv6_literal() {
        accepts("AAAA", "::1");
        accepts("AAAA", "2606:4700:4700::1111");
        rejects_with("AAAA", "1.2.3.4", "valid IPv6 address");
        rejects_with("AAAA", "gggg::1", "valid IPv6 address");
    }

    #[test]
    fn hostname_records_require_a_hostname() {
        for record_type in HOSTNAME_CONTENT_TYPES {
            accepts(record_type, "example.com");
            accepts(record_type, "example.com.");
            rejects_with(record_type, "not a hostname!", "valid hostname");
        }
        rejects_with("CNAME", "-leading.example.com", "valid hostname");
        rejects_with("CNAME", "double..dot.example.com", "valid hostname");
    }

    #[test]
    fn underscore_and_idn_hostnames_stay_permitted() {
        // Rejecting these would break DKIM delegation and internationalised zones.
        accepts("CNAME", "selector1._domainkey.example.com");
        accepts("CNAME", "xn--bcher-kva.example.com");
        accepts("CNAME", "bücher.example.com");
    }

    /// The four record types the hostname rules were sharpened for.
    const HOSTNAME_TYPES: &[&str] = &["CNAME", "NS", "PTR", "MX"];

    /// Build a record of `record_type` whose content is `content`, supplying the
    /// MX priority so only the hostname rules can fail.
    fn hostname_record(record_type: &str, content: &str) -> DNSRecordValidationInput {
        let mut record = input(record_type, content);
        if record_type == "MX" {
            record.priority = Some(10);
        }
        record
    }

    fn hostname_accepts(record_type: &str, content: &str) {
        let result = validate_dns_record(&hostname_record(record_type, content));
        assert!(
            result.ok,
            "{record_type} {content:?} rejected: {:?}",
            result.issues
        );
    }

    fn hostname_rejects(record_type: &str, content: &str, expected: &str) {
        let result = validate_dns_record(&hostname_record(record_type, content));
        assert!(!result.ok, "{record_type} {content:?} was accepted");
        assert!(
            result.issues.iter().any(|issue| issue.contains(expected)),
            "{record_type} {content:?} issues {:?} did not mention {expected:?}",
            result.issues
        );
    }

    #[test]
    fn hostname_types_accept_well_formed_names() {
        for record_type in HOSTNAME_TYPES {
            hostname_accepts(record_type, "mail.example.com");
            hostname_accepts(record_type, "a.b.c.d.example.com");
            hostname_accepts(record_type, "xn--bcher-kva.example.com");
            hostname_accepts(record_type, "host-1.example.com");
            hostname_accepts(record_type, "EXAMPLE.COM");
        }
    }

    #[test]
    fn hostname_types_reject_malformed_names() {
        for record_type in HOSTNAME_TYPES {
            hostname_rejects(record_type, "not_a_hostname!", "valid hostname");
            hostname_rejects(record_type, "http://example.com", "valid hostname");
            // MX reports whitespace with its own message, so assert the shared word.
            hostname_rejects(record_type, "exam ple.com", "hostname");
        }
    }

    #[test]
    fn a_single_trailing_dot_is_the_root_and_is_accepted() {
        for record_type in HOSTNAME_TYPES {
            hostname_accepts(record_type, "mail.example.com.");
        }
    }

    #[test]
    fn consecutive_dots_are_rejected() {
        for record_type in HOSTNAME_TYPES {
            hostname_rejects(record_type, "mail..example.com", "empty label");
            hostname_rejects(record_type, "mail.example.com..", "empty label");
            hostname_rejects(record_type, ".example.com", "empty label");
        }
    }

    #[test]
    fn hyphens_at_a_label_edge_are_rejected() {
        for record_type in HOSTNAME_TYPES {
            hostname_rejects(
                record_type,
                "-mail.example.com",
                "begins or ends with a hyphen",
            );
            hostname_rejects(
                record_type,
                "mail-.example.com",
                "begins or ends with a hyphen",
            );
            hostname_rejects(
                record_type,
                "mail.example.com-",
                "begins or ends with a hyphen",
            );
        }
    }

    #[test]
    fn ip_literals_are_rejected_where_a_hostname_belongs() {
        for record_type in HOSTNAME_TYPES {
            hostname_rejects(record_type, "192.0.2.1", "IP address literal");
            hostname_rejects(record_type, "2001:db8::1", "IP address literal");
        }
        // The same guard covers the SRV target.
        rejects_with("SRV", "10 5 8080 192.0.2.1", "IP address literal");
        // A name that merely starts with digits is still a name.
        hostname_accepts("CNAME", "192-0-2-1.example.com");
        hostname_accepts("CNAME", "1.2.3.4.example.com");
    }

    #[test]
    fn label_length_boundary_accepts_63_and_rejects_64() {
        let exact = format!("{}.example.com", "a".repeat(MAX_LABEL_BYTES));
        let over = format!("{}.example.com", "a".repeat(MAX_LABEL_BYTES + 1));
        for record_type in HOSTNAME_TYPES {
            hostname_accepts(record_type, &exact);
            hostname_rejects(
                record_type,
                &over,
                &format!(
                    "{} octets, over the {MAX_LABEL_BYTES} octet limit",
                    MAX_LABEL_BYTES + 1
                ),
            );
        }
    }

    #[test]
    fn name_length_boundary_accepts_253_and_rejects_254() {
        // 63 + 1 + 63 + 1 + 63 + 1 + 61 == 253
        let exact = format!(
            "{}.{}.{}.{}",
            "a".repeat(63),
            "b".repeat(63),
            "c".repeat(63),
            "d".repeat(61)
        );
        assert_eq!(exact.len(), MAX_HOSTNAME_BYTES);
        let over = format!(
            "{}.{}.{}.{}",
            "a".repeat(63),
            "b".repeat(63),
            "c".repeat(63),
            "d".repeat(62)
        );
        assert_eq!(over.len(), MAX_HOSTNAME_BYTES + 1);

        for record_type in HOSTNAME_TYPES {
            hostname_accepts(record_type, &exact);
            // A trailing root dot does not count toward the limit.
            hostname_accepts(record_type, &format!("{exact}."));
            hostname_rejects(
                record_type,
                &over,
                &format!(
                    "{} octets, over the {MAX_HOSTNAME_BYTES} octet limit",
                    MAX_HOSTNAME_BYTES + 1
                ),
            );
        }
    }

    #[test]
    fn unicode_names_are_measured_in_their_encoded_form() {
        // Accepted, and short once encoded.
        hostname_accepts("CNAME", "bücher.example.com");
        assert_eq!(
            idna::domain_to_ascii("bücher.example.com").expect("the name should encode"),
            "xn--bcher-kva.example.com"
        );

        // A label of 80 Unicode characters is well under 63 *characters* but its
        // A-label form is over the 63 *octet* label limit, so it is rejected.
        let unicode_label = "ü".repeat(80);
        let name = format!("{unicode_label}.example.com");
        let encoded = idna::domain_to_ascii(&name).expect("the name should encode");
        let encoded_label = encoded.split('.').next().expect("a first label");
        assert!(
            encoded_label.len() > MAX_LABEL_BYTES,
            "precondition: encoded label was only {} octets",
            encoded_label.len()
        );
        hostname_rejects("CNAME", &name, "octet limit");
    }

    #[test]
    fn underscore_targets_stay_permitted_for_every_hostname_type() {
        // ACME DNS-01 delegation and Microsoft 365 DKIM both need these.
        hostname_accepts("CNAME", "_acme-challenge.example.com.acme-dns.io");
        hostname_accepts(
            "CNAME",
            "selector1-example-com._domainkey.example.onmicrosoft.com",
        );
        for record_type in HOSTNAME_TYPES {
            hostname_accepts(record_type, "_service.example.com");
        }
        // Underscore owner names are unrestricted too.
        let mut record = input("TXT", "\"v=DMARC1; p=none\"");
        record.name = "_dmarc.example.com".to_string();
        let result = validate_dns_record(&record);
        assert!(result.ok, "{:?}", result.issues);
    }

    #[test]
    fn mx_requires_priority_and_a_hostname() {
        let mut valid = input("MX", "mail.example.com");
        valid.priority = Some(10);
        assert!(validate_dns_record(&valid).ok);

        rejects_with("MX", "mail.example.com", "priority");
        rejects_with("MX", "mail server.example.com", "no spaces");

        let mut bad_host = input("MX", "not_a_host!");
        bad_host.priority = Some(10);
        let result = validate_dns_record(&bad_host);
        assert!(!result.ok);
        assert!(result
            .issues
            .iter()
            .any(|issue| issue.contains("MX content must be a valid hostname")));
    }

    #[test]
    fn null_mx_target_is_permitted() {
        let mut null_mx = input("MX", ".");
        null_mx.priority = Some(0);
        let result = validate_dns_record(&null_mx);
        assert!(result.ok, "{:?}", result.issues);
    }

    #[test]
    fn srv_validates_every_field() {
        accepts("SRV", "10 5 8080 target.example.com");
        accepts("SRV", "0 0 0 .");
        rejects_with("SRV", "10 5 8080", "priority weight port target");
        rejects_with("SRV", "x 5 8080 target.example.com", "SRV priority");
        rejects_with("SRV", "10 70000 8080 target.example.com", "SRV weight");
        rejects_with("SRV", "10 5 70000 target.example.com", "SRV port");
        rejects_with("SRV", "10 5 8080 not_a_host!", "SRV target");
    }

    /// Cloudflare returns SRV records with the priority in its own field and
    /// `weight port target` in the content. Rejecting that shape would make
    /// every SRV record read back from the API impossible to save again.
    #[test]
    fn srv_accepts_the_shape_cloudflare_returns() {
        let with_priority = |content: &str, priority: Option<u16>| {
            let mut record = input("SRV", content);
            record.priority = priority;
            validate_dns_record(&record)
        };

        let result = with_priority("5 8080 target.example.com", Some(10));
        assert!(result.ok, "{:?}", result.issues);

        // Zero is a legitimate priority and must not be read as absent.
        let result = with_priority("5 8080 target.example.com", Some(0));
        assert!(result.ok, "{:?}", result.issues);

        // The four-field form still validates its own priority field.
        let result = with_priority("10 5 8080 target.example.com", Some(10));
        assert!(result.ok, "{:?}", result.issues);

        // Without a separate priority, three tokens are still incomplete.
        let result = with_priority("5 8080 target.example.com", None);
        assert!(!result.ok);

        // The remaining numeric fields and the target are still checked in the
        // shortened form, at their shifted positions.
        let result = with_priority("70000 8080 target.example.com", Some(10));
        assert!(result
            .issues
            .iter()
            .any(|issue| issue.contains("SRV weight")));
        let result = with_priority("5 70000 target.example.com", Some(10));
        assert!(result.issues.iter().any(|issue| issue.contains("SRV port")));
        let result = with_priority("5 8080 not_a_host!", Some(10));
        assert!(result
            .issues
            .iter()
            .any(|issue| issue.contains("SRV target")));
        let result = with_priority("5 8080 192.0.2.1", Some(10));
        assert!(!result.ok, "an IP literal is not a valid SRV target");
    }

    #[test]
    fn caa_validates_flags_and_tag() {
        accepts("CAA", "0 issue \"letsencrypt.org\"");
        accepts("CAA", "128 iodef \"mailto:admin@example.com\"");
        // Unknown but well-formed tags stay permitted.
        accepts("CAA", "0 issuevmc \"example.com\"");
        rejects_with("CAA", "0 issue", "flags tag value");
        rejects_with("CAA", "300 issue \"example.com\"", "CAA flags");
        rejects_with("CAA", "0 iss-ue \"example.com\"", "CAA tag");
    }

    #[test]
    fn txt_character_strings_are_bounded_only_when_quoted() {
        let long = "x".repeat(400);
        // Bare long values stay permitted: Cloudflare splits them itself.
        accepts("TXT", &long);
        accepts(
            "TXT",
            &format!("\"{}\" \"{}\"", "a".repeat(200), "b".repeat(200)),
        );
        rejects_with(
            "TXT",
            &format!("\"{long}\""),
            "character strings must be at most 255 bytes",
        );
    }

    #[test]
    fn record_name_and_content_must_be_present() {
        let mut empty_name = input("A", "1.2.3.4");
        empty_name.name = "  ".to_string();
        rejects_issue(&empty_name, "Record name must not be empty");

        let mut spaced_name = input("A", "1.2.3.4");
        spaced_name.name = "www example.com".to_string();
        rejects_issue(&spaced_name, "Record name must not contain spaces");

        rejects_with("TXT", "", "Record content must not be empty");
    }

    #[test]
    fn ttl_bounds_reject_only_impossible_values() {
        let mut zero = input("A", "1.2.3.4");
        zero.ttl = Some(0);
        rejects_issue(&zero, "TTL must be 1 for automatic");

        let mut huge = input("A", "1.2.3.4");
        huge.ttl = Some(u32::MAX);
        rejects_issue(&huge, "TTL must be at most");

        // Automatic, sub-minute enterprise, and long TTLs all stay permitted.
        for seconds in [1_u32, 30, 60, 86_400, 604_800] {
            let mut ok = input("A", "1.2.3.4");
            ok.ttl = Some(seconds);
            let result = validate_dns_record(&ok);
            assert!(result.ok, "ttl {seconds} rejected: {:?}", result.issues);
        }
    }

    fn rejects_issue(record: &DNSRecordValidationInput, expected: &str) {
        let result = validate_dns_record(record);
        assert!(!result.ok, "record was accepted: {record:?}");
        assert!(
            result.issues.iter().any(|issue| issue.contains(expected)),
            "issues {:?} did not mention {expected:?}",
            result.issues
        );
    }

    #[test]
    fn structured_record_types_keep_their_rules() {
        accepts("TLSA", "3 1 1 abcdef");
        rejects_with("TLSA", "3 1", "usage selector matching-type data");
        accepts("SSHFP", "1 1 abcdef0123");
        rejects_with("SSHFP", "1 1 zzz", "algorithm fptype fingerprint");
        accepts(
            "NAPTR",
            "100 10 \"S\" \"SIP+D2U\" \"\" _sip._udp.example.com",
        );
        rejects_with("NAPTR", "100 10", "order preference flags");
    }

    #[test]
    fn spf_records_must_parse() {
        accepts("SPF", "v=spf1 include:example.com ~all");
        rejects_with("SPF", "not-an-spf-record", "must start with v=spf1");
    }

    #[test]
    fn record_input_conversion_validates_the_write_payload() {
        let record = DNSRecordInput {
            r#type: "A".to_string(),
            name: "www.example.com".to_string(),
            content: "not-an-ip".to_string(),
            comment: None,
            ttl: Some(300),
            priority: None,
            proxied: Some(false),
        };
        let result = validate_record_input(&record);
        assert!(!result.ok);
        assert!(result
            .issues
            .iter()
            .any(|issue| issue.contains("valid IPv4 address")));
    }

    #[test]
    fn permissive_types_are_not_second_guessed() {
        // No local rules exist for these, so Cloudflare stays the authority.
        for (record_type, content) in [
            ("HTTPS", "1 . alpn=\"h3,h2\""),
            ("SVCB", "0 svc.example.com."),
            ("DS", "2371 13 2 abcdef"),
            ("LOC", "37 46 29.000 N 122 23 1.000 W 0.00m"),
            ("URI", "10 1 \"https://example.com/\""),
        ] {
            accepts(record_type, content);
        }
    }
}
