//! # bc-domain-audit
//!
//! DNS domain health audit engine that analyses a zone's records across
//! three categories: **email** (SPF / DMARC / DKIM / MX), **security**
//! (CAA policy review), and **hygiene** (TTL outliers, CNAME conflicts /
//! chains / cycles, bogon IPs, NS redundancy, SOA review, TXT sprawl,
//! SRV format, deprecated SPF RR type, domain expiry).
//!
//! This is a pure-computation crate — no network or filesystem I/O.

use bc_cloudflare_api::DNSRecord;
use bc_dns_tools::{is_spf_record, parse_srv, unquote_character_string};
use bc_spf::{ip_matches_cidr, parse_spf};
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::net::IpAddr;

// ── Public types ────────────────────────────────────────────────────────────

/// Severity level for an audit finding.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum AuditSeverity {
    Pass,
    Info,
    Warn,
    Fail,
}

impl AuditSeverity {
    /// The wire name, matching the serde representation.
    pub fn as_str(self) -> &'static str {
        match self {
            AuditSeverity::Pass => "pass",
            AuditSeverity::Info => "info",
            AuditSeverity::Warn => "warn",
            AuditSeverity::Fail => "fail",
        }
    }

    /// How serious this finding is, low to high. Spelled out rather than derived
    /// from the variant order so that reordering the enum cannot silently
    /// reorder severity for callers that filter on a threshold.
    pub fn rank(self) -> u8 {
        match self {
            AuditSeverity::Pass => 0,
            AuditSeverity::Info => 1,
            AuditSeverity::Warn => 2,
            AuditSeverity::Fail => 3,
        }
    }
}

/// Audit category.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum AuditCategory {
    Email,
    Security,
    Hygiene,
}

impl AuditCategory {
    pub const fn all() -> &'static [AuditCategory] {
        &[
            AuditCategory::Email,
            AuditCategory::Security,
            AuditCategory::Hygiene,
        ]
    }

    /// The wire name, matching the serde representation.
    pub fn as_str(self) -> &'static str {
        match self {
            AuditCategory::Email => "email",
            AuditCategory::Security => "security",
            AuditCategory::Hygiene => "hygiene",
        }
    }

    pub fn parse(value: &str) -> Option<Self> {
        AuditCategory::all()
            .iter()
            .copied()
            .find(|category| category.as_str() == value)
    }
}

/// Optional suggestion to fix an issue.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AuditSuggestion {
    pub record_type: String,
    pub name: String,
    pub content: String,
}

/// A single audit finding.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AuditItem {
    pub id: String,
    pub category: AuditCategory,
    pub severity: AuditSeverity,
    pub title: String,
    pub details: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub suggestion: Option<AuditSuggestion>,
}

/// How the audit is configured.
///
/// Every field has a default that is the behaviour this crate had before any of
/// it was configurable, so `AuditOptions::default()` — or a stored object from a
/// build that knew about fewer of these fields — runs exactly the audit the app
/// has always run.
///
/// Mirrors `DomainAuditOptions` in `src/lib/audit/domain-audit.ts`; the two are
/// one wire format, which is why the threshold keys are camelCase on this side
/// too. `test/domain-audit-config.test.ts` pins the threshold table — keys,
/// defaults and bounds — against the TypeScript one.
///
/// ## Deserialisation is deliberately forgiving
///
/// This type is read from stored settings that a *newer* build may have written,
/// so a field it does not recognise, or a value of the wrong shape, must leave
/// the rest of the config intact rather than failing the whole parse and
/// throwing away the user's other choices. Every field is lenient
/// independently, and unknown keys inside `checks` and `thresholds` are simply
/// never looked up.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AuditOptions {
    #[serde(default = "default_categories", deserialize_with = "lenient")]
    pub include_categories: AuditCategories,
    /// Per-check settings keyed by the finding id. Unknown ids are ignored.
    #[serde(default, deserialize_with = "lenient_check_map")]
    pub checks: HashMap<String, AuditCheckSettings>,
    /// Threshold overrides keyed by the names in [`AUDIT_THRESHOLDS`]. Unknown
    /// keys and out-of-range values are ignored.
    #[serde(default, deserialize_with = "lenient_threshold_map")]
    pub thresholds: HashMap<String, f64>,
    #[serde(default, deserialize_with = "lenient")]
    pub domain_expires_at: Option<String>,
}

/// Which audit categories to include.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AuditCategories {
    #[serde(default = "default_true", deserialize_with = "lenient_bool_true")]
    pub email: bool,
    #[serde(default = "default_true", deserialize_with = "lenient_bool_true")]
    pub security: bool,
    #[serde(default = "default_true", deserialize_with = "lenient_bool_true")]
    pub hygiene: bool,
}

/// Per-check configuration, keyed by the finding id the audit emits.
///
/// The unit of configuration is the finding id, not the "check" as a reader
/// might group it: `cname-chains-warn` and `cname-chains-fail` are two ids and
/// configure separately, as do `ns-single` and `ns-redundancy`.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AuditCheckSettings {
    /// `Some(false)` drops the finding entirely. Anything else runs the check.
    #[serde(
        default,
        deserialize_with = "lenient",
        skip_serializing_if = "Option::is_none"
    )]
    pub enabled: Option<bool>,
    /// Report this check's problems at this severity instead of the computed
    /// one. Applied only to findings that are not already `Pass`, and
    /// [`AuditSeverity::Pass`] is not accepted here: see
    /// [`AuditCheckSettings::severity_override`].
    #[serde(
        default,
        deserialize_with = "lenient",
        skip_serializing_if = "Option::is_none"
    )]
    pub severity: Option<AuditSeverity>,
}

impl AuditCheckSettings {
    /// The severity this check's problems should be reported at, if any.
    ///
    /// `Pass` is rejected rather than honoured. A severity override changes how
    /// loudly a *problem* is reported, and a finding forced to `Pass` would be a
    /// problem presented as healthy, with `details` still describing it — the UI
    /// hides passing findings by default, so the text would vanish while the
    /// condition stayed. Silencing a check entirely is `enabled: false`, which
    /// removes the finding instead of disguising it.
    pub fn severity_override(&self) -> Option<AuditSeverity> {
        match self.severity {
            Some(AuditSeverity::Pass) | None => None,
            Some(severity) => Some(severity),
        }
    }
}

fn default_true() -> bool {
    true
}

fn default_categories() -> AuditCategories {
    AuditCategories {
        email: true,
        security: true,
        hygiene: true,
    }
}

/// All three categories on — which is also what `AuditOptions::default()`
/// derives from, and what [`lenient`] falls back to for an unreadable value.
impl Default for AuditCategories {
    fn default() -> Self {
        default_categories()
    }
}

// ── Lenient deserialisation ─────────────────────────────────────────────────
//
// Same shape as `bc-notify`'s settings helpers: decode to a `Value` first, then
// fall back rather than propagate the error, so one unreadable field cannot
// discard a whole stored config.

/// Deserialize `T`, falling back to `T::default()` when the JSON does not fit
/// (unknown enum string, wrong type). Missing keys are handled by
/// `#[serde(default)]`.
fn lenient<'de, D, T>(deserializer: D) -> Result<T, D::Error>
where
    D: serde::Deserializer<'de>,
    T: serde::de::DeserializeOwned + Default,
{
    let value = serde_json::Value::deserialize(deserializer)?;
    Ok(T::deserialize(value).unwrap_or_default())
}

/// A category flag, where anything that is not literally `false` runs the
/// category — matching the TypeScript side's `!== false`.
fn lenient_bool_true<'de, D>(deserializer: D) -> Result<bool, D::Error>
where
    D: serde::Deserializer<'de>,
{
    let value = serde_json::Value::deserialize(deserializer)?;
    Ok(value.as_bool().unwrap_or(true))
}

/// Per-check settings, keeping every entry and defaulting the unreadable ones.
fn lenient_check_map<'de, D>(
    deserializer: D,
) -> Result<HashMap<String, AuditCheckSettings>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    let value = serde_json::Value::deserialize(deserializer)?;
    let serde_json::Value::Object(entries) = value else {
        return Ok(HashMap::new());
    };
    Ok(entries
        .into_iter()
        .map(|(id, raw)| (id, AuditCheckSettings::deserialize(raw).unwrap_or_default()))
        .collect())
}

/// Threshold overrides, keeping only the entries that are numbers at all. The
/// range check happens in [`AuditThresholds::resolve`], against each key's spec.
fn lenient_threshold_map<'de, D>(deserializer: D) -> Result<HashMap<String, f64>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    let value = serde_json::Value::deserialize(deserializer)?;
    let serde_json::Value::Object(entries) = value else {
        return Ok(HashMap::new());
    };
    Ok(entries
        .into_iter()
        .filter_map(|(key, raw)| raw.as_f64().map(|number| (key, number)))
        .collect())
}

// ── Thresholds ──────────────────────────────────────────────────────────────

/// A tunable number: its default, and the range a stored value must fall in.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct AuditThresholdSpec {
    /// The key a stored config uses. camelCase, shared with TypeScript.
    pub key: &'static str,
    pub default: u32,
    pub min: u32,
    pub max: u32,
}

/// Fewer days remaining than this fails `domain-expiry` outright.
pub const DOMAIN_EXPIRY_CRITICAL_DAYS: AuditThresholdSpec = AuditThresholdSpec {
    key: "domainExpiryCriticalDays",
    default: 15,
    min: 1,
    max: 365,
};
/// Fewer days remaining than this warns, once past the critical band.
pub const DOMAIN_EXPIRY_WARN_DAYS: AuditThresholdSpec = AuditThresholdSpec {
    key: "domainExpiryWarnDays",
    default: 30,
    min: 1,
    max: 1095,
};
/// A TTL under this many seconds is `ttl-critical`.
pub const TTL_CRITICAL_BELOW_SECONDS: AuditThresholdSpec = AuditThresholdSpec {
    key: "ttlCriticalBelowSeconds",
    default: 30,
    min: 1,
    max: 3600,
};
/// A TTL under this many seconds is a `ttl-hygiene` outlier.
pub const TTL_LOW_BELOW_SECONDS: AuditThresholdSpec = AuditThresholdSpec {
    key: "ttlLowBelowSeconds",
    default: 60,
    min: 1,
    max: 86400,
};
/// An NS or MX TTL under this many seconds is a `ttl-hygiene` outlier.
pub const TTL_DELEGATION_LOW_BELOW_SECONDS: AuditThresholdSpec = AuditThresholdSpec {
    key: "ttlDelegationLowBelowSeconds",
    default: 300,
    min: 1,
    max: 86400,
};
/// An SOA TTL under this many seconds is a `ttl-hygiene` outlier.
pub const TTL_SOA_LOW_BELOW_SECONDS: AuditThresholdSpec = AuditThresholdSpec {
    key: "ttlSoaLowBelowSeconds",
    default: 3600,
    min: 1,
    max: 604800,
};
/// A TTL above this many seconds is a `ttl-hygiene` outlier.
pub const TTL_HIGH_ABOVE_SECONDS: AuditThresholdSpec = AuditThresholdSpec {
    key: "ttlHighAboveSeconds",
    default: 86400,
    min: 300,
    max: 2419200,
};
/// A CNAME chain of this many hops or more is `cname-chains-warn`.
pub const CNAME_CHAIN_WARN_HOPS: AuditThresholdSpec = AuditThresholdSpec {
    key: "cnameChainWarnHops",
    default: 3,
    min: 2,
    max: 20,
};
/// A CNAME chain of this many hops or more is `cname-chains-fail`.
pub const CNAME_CHAIN_FAIL_HOPS: AuditThresholdSpec = AuditThresholdSpec {
    key: "cnameChainFailHops",
    default: 5,
    min: 2,
    max: 20,
};
/// More than this many TXT records at one name is `txt-sprawl`.
pub const TXT_RECORDS_PER_NAME_LIMIT: AuditThresholdSpec = AuditThresholdSpec {
    key: "txtRecordsPerNameLimit",
    default: 5,
    min: 1,
    max: 100,
};
/// Fewer than this many NS records at the apex is a failure.
pub const NS_MINIMUM_AT_APEX: AuditThresholdSpec = AuditThresholdSpec {
    key: "nsMinimumAtApex",
    default: 2,
    min: 2,
    max: 13,
};
/// More than this many MX records at the apex is `mx-too-many`.
pub const MX_MANY_AT_APEX_LIMIT: AuditThresholdSpec = AuditThresholdSpec {
    key: "mxManyAtApexLimit",
    default: 10,
    min: 1,
    max: 100,
};
/// This many estimated SPF lookups or more warns.
pub const SPF_LOOKUP_WARN_COUNT: AuditThresholdSpec = AuditThresholdSpec {
    key: "spfLookupWarnCount",
    default: 10,
    min: 1,
    max: 10,
};
/// More than this many distinct CAA issuers is reported.
pub const CAA_ISSUER_LIMIT: AuditThresholdSpec = AuditThresholdSpec {
    key: "caaIssuerLimit",
    default: 3,
    min: 1,
    max: 50,
};

/// Every number a check compares against that is a preference rather than a
/// protocol constant.
///
/// Deliberately *not* here: the SOA timer bands, SPF's ten-lookup ceiling, the
/// SRV port range, and the caps on how many lines a finding lists. The first
/// three are RFC constants or prose-bound ranges rather than preferences, and
/// the last is presentation. Adding a row later is this table plus one call
/// site.
pub const AUDIT_THRESHOLDS: &[AuditThresholdSpec] = &[
    DOMAIN_EXPIRY_CRITICAL_DAYS,
    DOMAIN_EXPIRY_WARN_DAYS,
    TTL_CRITICAL_BELOW_SECONDS,
    TTL_LOW_BELOW_SECONDS,
    TTL_DELEGATION_LOW_BELOW_SECONDS,
    TTL_SOA_LOW_BELOW_SECONDS,
    TTL_HIGH_ABOVE_SECONDS,
    CNAME_CHAIN_WARN_HOPS,
    CNAME_CHAIN_FAIL_HOPS,
    TXT_RECORDS_PER_NAME_LIMIT,
    NS_MINIMUM_AT_APEX,
    MX_MANY_AT_APEX_LIMIT,
    SPF_LOOKUP_WARN_COUNT,
    CAA_ISSUER_LIMIT,
];

/// Every threshold, resolved to the value the audit will actually compare.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct AuditThresholds {
    pub domain_expiry_critical_days: u32,
    pub domain_expiry_warn_days: u32,
    pub ttl_critical_below_seconds: u32,
    pub ttl_low_below_seconds: u32,
    pub ttl_delegation_low_below_seconds: u32,
    pub ttl_soa_low_below_seconds: u32,
    pub ttl_high_above_seconds: u32,
    pub cname_chain_warn_hops: u32,
    pub cname_chain_fail_hops: u32,
    pub txt_records_per_name_limit: u32,
    pub ns_minimum_at_apex: u32,
    pub mx_many_at_apex_limit: u32,
    pub spf_lookup_warn_count: u32,
    pub caa_issuer_limit: u32,
}

/// Resolve one stored value against its spec.
///
/// Anything that is not a finite number, or that falls outside the spec's
/// bounds, leaves the default in place: a stored config from a newer build, a
/// hand-edited file or a half-finished form field must not be able to turn a
/// check off or push it somewhere meaningless. Fractional values are truncated
/// rather than rejected, because a number input that reads `30.0` is a `30`
/// that took a different route — and because the TypeScript side, where every
/// JSON number is a float, cannot tell the two apart either.
fn resolve_threshold(spec: &AuditThresholdSpec, overrides: &HashMap<String, f64>) -> u32 {
    let Some(&stored) = overrides.get(spec.key) else {
        return spec.default;
    };
    if !stored.is_finite() {
        return spec.default;
    }
    let whole = stored.trunc();
    if whole < f64::from(spec.min) || whole > f64::from(spec.max) {
        return spec.default;
    }
    whole as u32
}

impl AuditThresholds {
    /// The effective value of every threshold.
    pub fn resolve(overrides: &HashMap<String, f64>) -> Self {
        Self {
            domain_expiry_critical_days: resolve_threshold(&DOMAIN_EXPIRY_CRITICAL_DAYS, overrides),
            domain_expiry_warn_days: resolve_threshold(&DOMAIN_EXPIRY_WARN_DAYS, overrides),
            ttl_critical_below_seconds: resolve_threshold(&TTL_CRITICAL_BELOW_SECONDS, overrides),
            ttl_low_below_seconds: resolve_threshold(&TTL_LOW_BELOW_SECONDS, overrides),
            ttl_delegation_low_below_seconds: resolve_threshold(
                &TTL_DELEGATION_LOW_BELOW_SECONDS,
                overrides,
            ),
            ttl_soa_low_below_seconds: resolve_threshold(&TTL_SOA_LOW_BELOW_SECONDS, overrides),
            ttl_high_above_seconds: resolve_threshold(&TTL_HIGH_ABOVE_SECONDS, overrides),
            cname_chain_warn_hops: resolve_threshold(&CNAME_CHAIN_WARN_HOPS, overrides),
            cname_chain_fail_hops: resolve_threshold(&CNAME_CHAIN_FAIL_HOPS, overrides),
            txt_records_per_name_limit: resolve_threshold(&TXT_RECORDS_PER_NAME_LIMIT, overrides),
            ns_minimum_at_apex: resolve_threshold(&NS_MINIMUM_AT_APEX, overrides),
            mx_many_at_apex_limit: resolve_threshold(&MX_MANY_AT_APEX_LIMIT, overrides),
            spf_lookup_warn_count: resolve_threshold(&SPF_LOOKUP_WARN_COUNT, overrides),
            caa_issuer_limit: resolve_threshold(&CAA_ISSUER_LIMIT, overrides),
        }
    }
}

impl Default for AuditThresholds {
    fn default() -> Self {
        Self::resolve(&HashMap::new())
    }
}

// ── Helpers ─────────────────────────────────────────────────────────────────

fn normalize_name(name: &str, zone_name: &str) -> String {
    let trimmed = name.trim().to_lowercase();
    if trimmed.is_empty() {
        return String::new();
    }
    if trimmed == "@" {
        return zone_name.trim().to_lowercase();
    }
    if trimmed.ends_with('.') {
        trimmed[..trimmed.len() - 1].to_string()
    } else {
        trimmed
    }
}

fn zone_apex(zone_name: &str) -> String {
    normalize_name(zone_name, zone_name)
}

fn record_name_is_apex(record_name: &str, zone_name: &str) -> bool {
    normalize_name(record_name, zone_name) == zone_apex(zone_name)
}

fn normalize_target_domain(value: &str, zone_name: &str) -> String {
    let raw = value.trim();
    if raw.is_empty() {
        return String::new();
    }
    let stripped = raw.strip_suffix('.').unwrap_or(raw);
    normalize_name(stripped, zone_name)
}

/// The logical value of a TXT record, with presentation quoting removed.
///
/// Cloudflare and zone-file imports hand back the same record as
/// `v=spf1 -all`, `"v=spf1 -all"` or `"v=spf1 " "-all"` depending on the path
/// it came in through. Every content check below runs on this, so the audit
/// never reports a record missing purely because of how it was written down.
fn txt_value(content: &str) -> String {
    unquote_character_string(content).trim().to_string()
}

fn get_txt_contents_by_name(records: &[DNSRecord], name: &str, zone_name: &str) -> Vec<String> {
    let needle = normalize_name(name, zone_name);
    records
        .iter()
        .filter(|r| r.r#type == "TXT")
        .filter(|r| normalize_name(&r.name, zone_name) == needle)
        .map(|r| txt_value(&r.content))
        .filter(|s| !s.is_empty())
        .collect()
}

fn parse_tag_record(txt: &str) -> HashMap<String, String> {
    let mut tags = HashMap::new();
    for part in txt.split(';') {
        let raw = part.trim();
        if raw.is_empty() {
            continue;
        }
        if let Some(idx) = raw.find('=') {
            let k = raw[..idx].trim().to_lowercase();
            let v = raw[idx + 1..].trim().to_string();
            if !k.is_empty() {
                tags.insert(k, v);
            }
        }
    }
    tags
}

fn get_ttl_seconds(record: &DNSRecord) -> Option<u32> {
    record.ttl
}

fn is_ipv4(s: &str) -> bool {
    s.parse::<std::net::Ipv4Addr>().is_ok()
}

/// IPv4 special-use / bogon ranges.
const IPV4_SPECIAL: &[(&str, &str)] = &[
    ("0.0.0.0/8", "This network (0.0.0.0/8)"),
    ("10.0.0.0/8", "RFC1918 private (10.0.0.0/8)"),
    ("100.64.0.0/10", "CGNAT (100.64.0.0/10)"),
    ("127.0.0.0/8", "Loopback (127.0.0.0/8)"),
    ("169.254.0.0/16", "Link-local (169.254.0.0/16)"),
    ("172.16.0.0/12", "RFC1918 private (172.16.0.0/12)"),
    ("192.0.0.0/24", "IETF protocol assignments (192.0.0.0/24)"),
    ("192.0.2.0/24", "Documentation (192.0.2.0/24)"),
    ("192.88.99.0/24", "6to4 relay anycast (192.88.99.0/24)"),
    ("192.168.0.0/16", "RFC1918 private (192.168.0.0/16)"),
    ("198.18.0.0/15", "Benchmarking (198.18.0.0/15)"),
    ("198.51.100.0/24", "Documentation (198.51.100.0/24)"),
    ("203.0.113.0/24", "Documentation (203.0.113.0/24)"),
    ("224.0.0.0/4", "Multicast (224.0.0.0/4)"),
    ("233.252.0.0/24", "Multicast test net (233.252.0.0/24)"),
    ("240.0.0.0/4", "Reserved (240.0.0.0/4)"),
    ("255.255.255.255/32", "Limited broadcast (255.255.255.255)"),
];

/// IPv6 special-use / bogon ranges.
const IPV6_SPECIAL: &[(&str, &str)] = &[
    ("::/128", "Unspecified (::)"),
    ("::1/128", "Loopback (::1)"),
    ("fc00::/7", "ULA private (fc00::/7)"),
    ("fe80::/10", "Link-local (fe80::/10)"),
    ("ff00::/8", "Multicast (ff00::/8)"),
    ("2001:db8::/32", "Documentation (2001:db8::/32)"),
    ("2002::/16", "6to4 (2002::/16, deprecated)"),
    ("2001:10::/28", "ORCHID (2001:10::/28, deprecated)"),
];

fn classify_special_ip(ip: &str) -> Option<String> {
    let s = ip.trim();
    if s.is_empty() {
        return None;
    }
    let Ok(addr) = s.parse::<IpAddr>() else {
        return None;
    };
    let ranges = if is_ipv4(s) {
        IPV4_SPECIAL
    } else {
        IPV6_SPECIAL
    };
    for &(cidr, label) in ranges {
        if ip_matches_cidr(addr, cidr) {
            return Some(label.to_string());
        }
    }
    None
}

fn is_dmarc_record(txt: &str) -> bool {
    txt.trim().to_lowercase().starts_with("v=dmarc1")
}

fn is_dkim_record(txt: &str) -> bool {
    txt.trim().to_lowercase().contains("v=dkim1")
}

fn get_spf_all_qualifier(spf: &str) -> Option<char> {
    let s = spf.to_lowercase();
    let bytes = s.as_bytes();
    // Match pattern: space + qualifier + "all" + (space or end)
    for (i, ch) in s.char_indices() {
        if i > 0 && matches!(ch, '~' | '-' | '+' | '?') && s[i + ch.len_utf8()..].starts_with("all")
        {
            let after = i + ch.len_utf8() + 3;
            if after >= s.len() || bytes[after] == b' ' {
                // Check preceding char is space
                if bytes[i - 1] == b' ' {
                    return Some(ch);
                }
            }
        }
    }
    None
}

fn estimate_spf_lookup_count(spf: &str) -> Option<u32> {
    let parsed = parse_spf(spf)?;
    let mut lookups = 0u32;
    for mech in &parsed.mechanisms {
        if matches!(
            mech.mechanism.as_str(),
            "include" | "a" | "mx" | "ptr" | "exists"
        ) {
            lookups += 1;
        }
    }
    for m in &parsed.modifiers {
        if m.key == "redirect" {
            lookups += 1;
        }
    }
    Some(lookups)
}

fn build_cname_map(zone_name: &str, records: &[DNSRecord]) -> HashMap<String, String> {
    let mut map = HashMap::new();
    for r in records {
        if r.r#type != "CNAME" {
            continue;
        }
        let from = normalize_name(&r.name, zone_name);
        let to = normalize_target_domain(&r.content, zone_name);
        if from.is_empty() || to.is_empty() {
            continue;
        }
        map.insert(from, to);
    }
    map
}

struct CnameChain {
    hops: usize,
    cyclic: bool,
    chain: Vec<String>,
}

fn compute_cname_chain(
    start: &str,
    cname_map: &HashMap<String, String>,
    max_hops: usize,
) -> CnameChain {
    let mut seen = HashSet::new();
    seen.insert(start.to_string());
    let mut chain = vec![start.to_string()];
    let mut current = start.to_string();
    let mut hops = 0;
    while hops < max_hops {
        let Some(next) = cname_map.get(&current) else {
            break;
        };
        hops += 1;
        chain.push(next.clone());
        if seen.contains(next) {
            return CnameChain {
                hops,
                cyclic: true,
                chain,
            };
        }
        seen.insert(next.clone());
        current = next.clone();
    }
    CnameChain {
        hops,
        cyclic: false,
        chain,
    }
}

fn parse_caa(content: &str) -> (Option<u8>, Option<String>, Option<String>) {
    let parts: Vec<&str> = content.split_whitespace().collect();
    if parts.len() < 3 {
        return (None, None, None);
    }
    let flag = parts[0].parse::<u8>().ok();
    let tag = Some(parts[1].to_lowercase());
    let rest = parts[2..].join(" ");
    let value = rest.trim_matches('"').to_string();
    (flag, tag, Some(value))
}

fn parse_mx_record(record: &DNSRecord, zone_name: &str) -> (Option<u16>, Option<String>) {
    // Cloudflare API returns MX priority as a separate field; content is just the target hostname.
    // Fall back to parsing "priority target" from content for compatibility with other sources.
    let content = record.content.trim();
    let parts: Vec<&str> = content.split_whitespace().collect();
    if parts.len() >= 2 {
        // Legacy format: "priority target"
        let priority = record.priority.or_else(|| parts[0].parse::<u16>().ok());
        let target_raw = parts[1..].join(" ");
        let target = normalize_target_domain(&target_raw, zone_name);
        (priority, Some(target))
    } else if !content.is_empty() {
        // Cloudflare API format: content is just the target, priority is separate
        let target = normalize_target_domain(content, zone_name);
        (record.priority, Some(target))
    } else {
        (record.priority, None)
    }
}

/// Whether a ten-digit SOA serial reads as a plausible `YYYYMMDDnn` date.
///
/// Serials shorter or longer than ten digits are not read as dates at all, so
/// they are plausible by default — `SOA serial should be numeric` already
/// covers a serial that is not a number.
///
/// Mirrors the TypeScript test
/// `/^20\d{2}(0[1-9]|1[0-2])([0-2]\d|3[01])\d{2}$/`, whose day alternation
/// spans `00`–`31`.
fn serial_date_is_plausible(serial: &str) -> bool {
    if serial.len() != 10 || !serial.chars().all(|c| c.is_ascii_digit()) {
        return true;
    }
    if !serial.starts_with("20") {
        return false;
    }
    let month: u32 = serial[4..6].parse().unwrap_or(0);
    let day: u32 = serial[6..8].parse().unwrap_or(99);
    (1..=12).contains(&month) && day <= 31
}

fn item(
    id: &str,
    cat: AuditCategory,
    sev: AuditSeverity,
    title: &str,
    details: impl Into<String>,
) -> AuditItem {
    AuditItem {
        id: id.to_string(),
        category: cat,
        severity: sev,
        title: title.to_string(),
        details: details.into(),
        suggestion: None,
    }
}

#[allow(clippy::too_many_arguments)]
fn item_with_suggestion(
    id: &str,
    cat: AuditCategory,
    sev: AuditSeverity,
    title: &str,
    details: impl Into<String>,
    rtype: &str,
    name: &str,
    content: &str,
) -> AuditItem {
    AuditItem {
        id: id.to_string(),
        category: cat,
        severity: sev,
        title: title.to_string(),
        details: details.into(),
        suggestion: Some(AuditSuggestion {
            record_type: rtype.to_string(),
            name: name.to_string(),
            content: content.to_string(),
        }),
    }
}

// ── Main audit function ─────────────────────────────────────────────────────

/// Run a comprehensive domain health audit on the given zone.
///
/// Returns a list of audit findings sorted by category and severity.
pub fn run_domain_audit(
    zone_name: &str,
    records: &[DNSRecord],
    options: &AuditOptions,
) -> Vec<AuditItem> {
    let apex = zone_apex(zone_name);
    let normalized_zone = &apex;
    let mut items = Vec::new();
    let limits = AuditThresholds::resolve(&options.thresholds);

    let mx: Vec<&DNSRecord> = records.iter().filter(|r| r.r#type == "MX").collect();
    let mx_at_apex: Vec<&DNSRecord> = mx
        .iter()
        .filter(|r| record_name_is_apex(&r.name, normalized_zone))
        .copied()
        .collect();

    let spf_txt_at_apex: Vec<String> = records
        .iter()
        .filter(|r| r.r#type == "TXT")
        .filter(|r| record_name_is_apex(&r.name, normalized_zone))
        .map(|r| txt_value(&r.content))
        .filter(|s| !s.is_empty())
        .filter(|s| is_spf_record(s))
        .collect();

    let spf_type_records: Vec<&DNSRecord> = records.iter().filter(|r| r.r#type == "SPF").collect();

    let dmarc_name = format!("_dmarc.{}", normalized_zone);
    let dmarc_txt: Vec<String> = get_txt_contents_by_name(records, &dmarc_name, normalized_zone)
        .into_iter()
        .filter(|s| is_dmarc_record(s))
        .collect();

    let has_any_dkim = records.iter().filter(|r| r.r#type == "TXT").any(|r| {
        let name = normalize_name(&r.name, normalized_zone);
        name.contains("._domainkey.") && is_dkim_record(&txt_value(&r.content))
    });

    let soa_records: Vec<&DNSRecord> = records.iter().filter(|r| r.r#type == "SOA").collect();
    let srv_records: Vec<&DNSRecord> = records.iter().filter(|r| r.r#type == "SRV").collect();
    let cname_records: Vec<&DNSRecord> = records.iter().filter(|r| r.r#type == "CNAME").collect();
    let cname_map = build_cname_map(normalized_zone, records);

    let mut a_by_name: HashMap<String, usize> = HashMap::new();
    let mut aaaa_by_name: HashMap<String, usize> = HashMap::new();
    for r in records {
        let n = normalize_name(&r.name, normalized_zone);
        if n.is_empty() {
            continue;
        }
        if r.r#type == "A" {
            *a_by_name.entry(n.clone()).or_insert(0) += 1;
        }
        if r.r#type == "AAAA" {
            *aaaa_by_name.entry(n).or_insert(0) += 1;
        }
    }

    let mut by_name: HashMap<String, Vec<&DNSRecord>> = HashMap::new();
    for r in records {
        let n = normalize_name(&r.name, normalized_zone);
        if n.is_empty() {
            continue;
        }
        by_name.entry(n).or_default().push(r);
    }

    // ── Hygiene checks ──────────────────────────────────────────────────

    if options.include_categories.hygiene {
        audit_hygiene(
            &mut items,
            records,
            normalized_zone,
            options,
            &limits,
            &spf_type_records,
            &cname_records,
            &cname_map,
            &by_name,
            &soa_records,
            &srv_records,
        );
    }

    // ── Security checks ─────────────────────────────────────────────────

    if options.include_categories.security {
        audit_security(&mut items, records, &apex, &limits);
    }

    // ── Email checks ────────────────────────────────────────────────────

    if options.include_categories.email {
        audit_email(
            &mut items,
            records,
            normalized_zone,
            &apex,
            &limits,
            &mx,
            &mx_at_apex,
            &spf_txt_at_apex,
            &dmarc_txt,
            &dmarc_name,
            has_any_dkim,
            &cname_map,
            &a_by_name,
            &aaaa_by_name,
        );
    }

    // Per-check settings are applied to the assembled list rather than threaded
    // through the branches that build it. No check reads another's findings, so
    // dropping one here is indistinguishable from never running it — and a
    // check added later is configurable the moment it has an id, with nothing
    // to wire.
    items.retain(|item| check_is_enabled(options, &item.id));
    for item in &mut items {
        if let Some(severity) = severity_override(options, item) {
            item.severity = severity;
        }
        explain_finding(item);
    }

    items
}

/// Whether this finding id is configured off. Unknown ids are on.
fn check_is_enabled(options: &AuditOptions, id: &str) -> bool {
    options
        .checks
        .get(id)
        .and_then(|settings| settings.enabled)
        .unwrap_or(true)
}

/// The severity this finding should be re-reported at, if it is overridden.
///
/// `Pass` findings are left alone: a healthy check stays `Pass` rather than
/// being promoted into a finding nobody asked for.
fn severity_override(options: &AuditOptions, item: &AuditItem) -> Option<AuditSeverity> {
    if item.severity == AuditSeverity::Pass {
        return None;
    }
    options
        .checks
        .get(&item.id)
        .and_then(AuditCheckSettings::severity_override)
        .filter(|&severity| severity != item.severity)
}

// ── Finding explanations ────────────────────────────────────────────────────

/// What each flagged record actually does, and what follows from its absence or
/// misconfiguration — appended to the finding's `details`.
///
/// Written for a domain owner who knows DNS but not email authentication. The
/// register is deliberately flat: state the consequence and let the severity the
/// audit already assigns carry the weight. A missing SPF record does not mean
/// mail *will* be spoofed, it means nothing prevents it and receivers have less
/// to go on — overstating that in a tool the user is trusting to describe their
/// own zone is worse than saying nothing.
///
/// Keyed by finding id and applied only to non-`Pass` findings, so an id whose
/// `Pass` variant reuses the same key (`caa-analysis`, `dkim-missing`,
/// `cname-conflicts`, `spf-type-deprecated`, …) stays silent when it passes.
///
/// `special-a` / `special-aaaa` are deliberately absent: they report a record
/// that exists with a bad address rather than an absence, and the UI renders
/// `SpecialIpAuditFindings` in place of `details` for them, so text added here
/// would never be shown.
///
/// **Mirrored verbatim from `FINDING_EXPLANATIONS` in
/// `src/lib/audit/domain-audit.ts`**, which is the source of truth; this copy is
/// generated from it. `test/domain-audit-explanations.test.ts` reads this file
/// and fails if the two tables drift, in either direction.
const FINDING_EXPLANATIONS: &[(&str, &str)] = &[
    ("spf-missing", "An SPF record lists the servers allowed to send mail using your domain. Without one, receiving servers have nothing to check a sender against, so mail claiming to come from your domain is harder for them to tell apart from mail that genuinely does, and your own mail has one less signal working in its favour."),
    ("spf-multiple", "A domain may publish only one SPF record. When receivers find more than one they are required to treat the result as a permanent error, so none of your SPF rules apply at all — the effect is the same as publishing no SPF record."),
    ("spf-all-missing", "The all mechanism at the end of an SPF record says what receivers should do about servers the record did not list. Without it they treat unlisted senders as neutral, so the record documents your own senders without asking receivers to act on anyone else."),
    ("spf-too-permissive", "+all tells receivers that any server on the internet is authorised to send as your domain. That is broader than publishing no SPF record at all, because it actively vouches for senders you do not control."),
    ("spf-neutral", "?all asks receivers to treat unlisted senders as neither authorised nor unauthorised, which is the answer they would reach with no SPF record at all. Listed servers still pass; nothing is asked about anyone else."),
    ("spf-softfail", "~all asks receivers to accept mail from unlisted servers but mark it as suspect. It is the usual setting while you are still learning which of your senders would fail. -all asks receivers to reject them outright, once you are confident the list is complete."),
    ("spf-ptr", "The ptr mechanism asks receivers to look up the sending server's address in reverse and check the name it returns. RFC 7208 discourages it: the lookups are slow, the answers are controlled by whoever owns the address block, and some receivers skip the mechanism entirely."),
    ("spf-lookups-estimate", "Each include, a, mx, ptr, exists and redirect term makes receivers perform another DNS lookup, and SPF allows ten in total. Past that limit receivers stop evaluating and return a permanent error, at which point the record authorises nothing — including the senders listed before the limit was reached."),
    ("spf-type-deprecated", "The dedicated SPF record type was retired by RFC 7208 in 2014. Receivers look for SPF policies in TXT records and most never query the SPF type at all, so a policy published only under this type is effectively invisible."),
    ("dmarc-missing", "A DMARC record tells receiving servers what to do with mail that fails your SPF and DKIM checks, and asks them to send you reports on who is sending as your domain. Without one, receivers decide for themselves and most will still deliver the mail, and you get no reports, so you cannot see whether anyone is sending as you."),
    ("dmarc-multiple", "A domain may publish only one DMARC record. Receivers that find several ignore the policy entirely, so the effect is the same as publishing none."),
    ("dmarc-missing-policy", "The p= tag is what tells receivers how to treat mail that fails your checks. A DMARC record without it is incomplete, and receivers ignore the record — including any reporting addresses set alongside it."),
    ("dmarc-policy-none", "p=none asks receivers to change nothing: mail that fails your checks is delivered just as it would be if it had passed. It is a reasonable place to start while you confirm your own senders pass, but on its own it does not stop anyone sending as your domain."),
    ("dmarc-no-rua", "An rua= address is where receivers send the daily summaries naming every server that sent mail as your domain and whether it passed. Without one nothing is sent anywhere, so there is no way to find out which of your senders would fail — or, once receivers are enforcing, which of your legitimate mail is being quarantined or thrown away."),
    ("dkim-missing", "DKIM adds a signature to outgoing mail that receivers verify against a public key published in your DNS, showing the message really came from your mail system and was not altered on the way. Without it your mail rests on SPF alone, which breaks when a message is forwarded. Selectors are chosen by the mail provider, so this may instead mean yours publishes them somewhere this zone cannot see."),
    ("mx-single", "MX records name the servers that accept mail for your domain, in priority order. With only one, delivery depends entirely on that host being reachable; senders retry for a while, so mail queues rather than arriving. Many providers cover this behind a single name that resolves to several hosts."),
    ("mx-too-many", "MX records name the servers that accept mail for your domain. An unusually long list often means old entries were never removed, and a retired host still listed collects delivery attempts until senders give up on it."),
    ("mx-cname-target", "An MX record must point at a hostname that has its own A or AAAA record. Pointing it at an alias is not permitted by the DNS specification, and some receiving servers decline to deliver rather than follow it."),
    ("mx-duplicate-priority", "The priority number decides which mail server senders try first, and equal numbers leave them free to choose between those hosts. That is how round-robin delivery is set up deliberately; if it was not intended, mail will not favour the server you expect."),
    ("mx-no-resolution", "Senders reach a mail server by resolving its hostname to an address. These targets have no A or AAAA record in this zone, which is fine if they resolve elsewhere, but if nothing answers for them anywhere then mail has nowhere to go."),
    ("caa-analysis", "CAA records name the certificate authorities allowed to issue certificates for your domain. Where no CAA record applies, any public authority may issue for the name, subject only to its own validation checks. CAA does not affect certificates that have already been issued."),
    ("ns-missing", "NS records delegate the zone to the name servers that answer for it. Cloudflare serves these itself and does not always list them among the editable records, so their absence here usually reflects that rather than a delegation problem — what actually decides delegation is the set of name servers recorded at your registrar."),
    ("ns-single", "NS records tell the rest of the internet which servers answer for your domain. With one listed, every lookup depends on that server; if it stops answering, the domain stops resolving altogether rather than slowing down. Two or more give resolvers somewhere to fall back to."),
    ("soa-missing", "The SOA record carries the zone's administrative parameters: the primary name server, the contact address, and the timers other servers use when refreshing or caching it. Cloudflare generates and serves this automatically, so it is normal for it not to appear among the editable records."),
    ("soa-multiple", "A zone has exactly one SOA record by definition. More than one means resolvers may read different administrative parameters depending on which they get, and some will treat the zone as malformed."),
    ("soa-review", "The SOA timers govern how long other servers wait before refreshing the zone, how long they keep serving it when the primary is unreachable, and how long a negative answer stays cached. Values well outside the usual ranges mainly affect how quickly your changes propagate and how long a stale copy survives an outage."),
    ("apex-single-ip", "The A records at the apex are what the bare domain resolves to. With a single address, reachability rests entirely on that host and resolvers have nothing to fall back to if it stops answering. One address is normal when a proxy or load balancer sits in front of it."),
    ("apex-single-ipv6", "The AAAA records at the apex are what the bare domain resolves to over IPv6. With a single address, IPv6 reachability rests entirely on that host. One address is normal when a proxy or load balancer sits in front of it."),
    ("ttl-critical", "The TTL is how long resolvers may cache an answer before asking again. Under 30 seconds they ask constantly, which puts steady load on the authoritative servers and leaves almost no cached copy to serve if those servers briefly stop answering. Very short TTLs earn their keep in the hours around a planned change, less so as a standing setting."),
    ("ttl-hygiene", "The TTL is how long resolvers may cache an answer before asking again. Longer values mean fewer lookups and a zone that rides out brief outages; shorter ones make changes take effect sooner. The values listed here are only unusual relative to the rest of this zone, which is often deliberate."),
    ("cname-conflicts", "A CNAME makes a name an alias for another name, and RFC 1034 requires that no other data exist at that name. Where it does, servers and resolvers disagree about which answer to return, so what a client gets back depends on which server it happens to ask."),
    ("cname-at-apex", "A CNAME at the apex is not permitted by the DNS specification, because the apex has to carry SOA and NS records too. Cloudflare works around this by answering with the target's addresses directly, so it behaves correctly here; the constraint returns if the zone moves to a provider that does not do the same."),
    ("cname-chains-fail", "Each CNAME in a chain costs a resolver another lookup before it reaches an address, and a cycle never reaches one at all. Resolvers abandon chains they judge too long, so the name fails to resolve rather than resolving slowly."),
    ("cname-chains-warn", "Each CNAME hop is another lookup a resolver makes before it reaches an address. That adds delay to every request that is not already cached, and one more link that can break the chain."),
    ("txt-sprawl", "All TXT records at a name are returned together, and each service picks out the one it recognises by its prefix. Several at one name is not an error in itself, but it makes it easy to leave behind verification strings for services you no longer use."),
    ("srv-review", "An SRV record tells clients which host and port serve a particular service, along with the priority and weight used to choose between several. Where the fields are malformed, clients that cannot read the record fall back to whatever default they have, or do not find the service at all."),
    ("domain-expiry", "Domain registration is separate from the DNS hosting configured here. If the registration lapses, the registry stops delegating the domain and it stops resolving regardless of the records in this zone. Registrars differ in how long they hold an expired name before it is released."),
];
/// Append the explanation for a finding, if one applies.
///
/// Only non-`Pass` findings are explained: a passing check has nothing whose
/// absence needs describing.
fn explain_finding(item: &mut AuditItem) {
    if item.severity == AuditSeverity::Pass {
        return;
    }
    if let Some((_, explanation)) = FINDING_EXPLANATIONS
        .iter()
        .find(|(id, _)| *id == item.id.as_str())
    {
        item.details = format!(
            "{}

{}",
            item.details, explanation
        );
    }
}

// ── Hygiene ─────────────────────────────────────────────────────────────────

#[allow(clippy::too_many_arguments)]
fn audit_hygiene(
    items: &mut Vec<AuditItem>,
    records: &[DNSRecord],
    normalized_zone: &str,
    options: &AuditOptions,
    limits: &AuditThresholds,
    spf_type_records: &[&DNSRecord],
    cname_records: &[&DNSRecord],
    cname_map: &HashMap<String, String>,
    by_name: &HashMap<String, Vec<&DNSRecord>>,
    soa_records: &[&DNSRecord],
    srv_records: &[&DNSRecord],
) {
    // Domain expiry
    if let Some(ref expiry_str) = options.domain_expires_at {
        if let Ok(expiry) = chrono::DateTime::parse_from_rfc3339(expiry_str) {
            let now = chrono::Utc::now();
            let days = (expiry.signed_duration_since(now)).num_days();
            let full = expiry.format("%Y-%m-%d %H:%M:%S UTC").to_string();
            if days < 0 {
                items.push(item(
                    "domain-expiry",
                    AuditCategory::Hygiene,
                    AuditSeverity::Fail,
                    "Domain appears expired",
                    format!("Expiry date: {} ({} days). Renew immediately.", full, days),
                ));
            } else if days < i64::from(limits.domain_expiry_critical_days) {
                items.push(item(
                    "domain-expiry",
                    AuditCategory::Hygiene,
                    AuditSeverity::Fail,
                    &format!(
                        "Domain expiry critical (<{} days)",
                        limits.domain_expiry_critical_days
                    ),
                    format!(
                        "Expiry date: {} ({} days remaining). Renew now.",
                        full, days
                    ),
                ));
            } else if days < i64::from(limits.domain_expiry_warn_days) {
                items.push(item(
                    "domain-expiry",
                    AuditCategory::Hygiene,
                    AuditSeverity::Warn,
                    "Domain expiry approaching",
                    format!("Expiry date: {} ({} days remaining).", full, days),
                ));
            } else {
                items.push(item(
                    "domain-expiry",
                    AuditCategory::Hygiene,
                    AuditSeverity::Pass,
                    "Domain expiry",
                    format!("Expiry date: {} ({} days remaining).", full, days),
                ));
            }
        } else {
            items.push(item(
                "domain-expiry",
                AuditCategory::Hygiene,
                AuditSeverity::Info,
                "Domain expiry check",
                "Domain expiry date is unavailable. Run a registry lookup to evaluate expiry risk.",
            ));
        }
    } else {
        items.push(item(
            "domain-expiry",
            AuditCategory::Hygiene,
            AuditSeverity::Info,
            "Domain expiry check",
            "Domain expiry date is unavailable. Run a registry lookup to evaluate expiry risk.",
        ));
    }

    // TTL review
    let mut ttl_issues = Vec::new();
    let mut ttl_critical = Vec::new();
    for r in records {
        let Some(ttl) = get_ttl_seconds(r) else {
            continue;
        };
        if ttl == 0 {
            ttl_critical.push(format!("{} {}: invalid TTL {}", r.r#type, r.name, ttl));
        } else if ttl < limits.ttl_critical_below_seconds {
            ttl_critical.push(format!(
                "{} {}: TTL {}s is dangerously low (<{}s should only be temporary)",
                r.r#type, r.name, ttl, limits.ttl_critical_below_seconds
            ));
        } else if ttl < limits.ttl_low_below_seconds {
            ttl_issues.push(format!("{} {}: TTL {}s is very low", r.r#type, r.name, ttl));
        } else if r.r#type == "SOA" && ttl < limits.ttl_soa_low_below_seconds {
            ttl_issues.push(format!(
                "SOA {}: TTL {}s is low (often {}+).",
                r.name, ttl, limits.ttl_soa_low_below_seconds
            ));
        } else if (r.r#type == "NS" || r.r#type == "MX")
            && ttl < limits.ttl_delegation_low_below_seconds
        {
            ttl_issues.push(format!(
                "{} {}: TTL {}s is low (often {}+).",
                r.r#type, r.name, ttl, limits.ttl_delegation_low_below_seconds
            ));
        } else if ttl > limits.ttl_high_above_seconds {
            ttl_issues.push(format!(
                "{} {}: TTL {}s is very high (changes propagate slowly).",
                r.r#type, r.name, ttl
            ));
        }
    }
    if !ttl_critical.is_empty() {
        let detail = format!(
            "{}\n\nTTL <{}s should only be used temporarily before DNS changes.",
            ttl_critical
                .iter()
                .take(8)
                .cloned()
                .collect::<Vec<_>>()
                .join("\n"),
            limits.ttl_critical_below_seconds
        );
        items.push(item(
            "ttl-critical",
            AuditCategory::Hygiene,
            AuditSeverity::Fail,
            "TTL dangerously low",
            detail,
        ));
    }
    items.push(item(
        "ttl-hygiene",
        AuditCategory::Hygiene,
        if ttl_issues.is_empty() {
            AuditSeverity::Pass
        } else {
            AuditSeverity::Info
        },
        "TTL review",
        if ttl_issues.is_empty() {
            "No obvious TTL outliers detected.".to_string()
        } else {
            ttl_issues
                .iter()
                .take(12)
                .cloned()
                .collect::<Vec<_>>()
                .join("\n")
        },
    ));

    // CNAME conflicts
    let mut cname_conflicts = Vec::new();
    let mut cname_at_apex_warnings = Vec::new();
    for (name, rrset) in by_name {
        let has_cname = rrset.iter().any(|r| r.r#type == "CNAME");
        if !has_cname {
            continue;
        }
        let others: Vec<&&DNSRecord> = rrset.iter().filter(|r| r.r#type != "CNAME").collect();
        if !others.is_empty() {
            let types: HashSet<&str> = others.iter().map(|r| r.r#type.as_str()).collect();
            let types_str = types.into_iter().collect::<Vec<_>>().join(", ");
            if name == normalized_zone {
                cname_at_apex_warnings.push(format!(
                    "{}: CNAME at apex with {}. Cloudflare flattens this to ANAME/ALIAS, which works but may not be portable.",
                    name, types_str
                ));
            } else {
                cname_conflicts.push(format!(
                    "{}: CNAME coexists with {} at the same name (RFC violation)",
                    name, types_str
                ));
            }
        }
    }
    if !cname_conflicts.is_empty() {
        let detail = format!(
            "{}\n\nRFC 1034: If a CNAME record is present at a name, no other data should exist at that exact same name.",
            cname_conflicts.iter().take(10).cloned().collect::<Vec<_>>().join("\n")
        );
        items.push(item(
            "cname-conflicts",
            AuditCategory::Hygiene,
            AuditSeverity::Fail,
            "CNAME conflicts",
            detail,
        ));
    }
    if !cname_at_apex_warnings.is_empty() {
        let detail = format!(
            "{}\n\nCloudflare automatically flattens CNAME records at the apex to ANAME/ALIAS records, which works correctly. However, this is Cloudflare-specific behavior. If you migrate to another DNS provider, you may need to convert these to A/AAAA records.",
            cname_at_apex_warnings.iter().take(5).cloned().collect::<Vec<_>>().join("\n")
        );
        items.push(item(
            "cname-at-apex",
            AuditCategory::Hygiene,
            AuditSeverity::Warn,
            "CNAME at apex (Cloudflare-specific behavior)",
            detail,
        ));
    }
    if cname_conflicts.is_empty() && cname_at_apex_warnings.is_empty() {
        items.push(item(
            "cname-conflicts",
            AuditCategory::Hygiene,
            AuditSeverity::Pass,
            "CNAME conflicts",
            "No names have both CNAME and other record types.",
        ));
    }

    // CNAME chains
    let mut chain_issues = Vec::new();
    let mut chain_warnings = Vec::new();
    for r in cname_records {
        let from = normalize_name(&r.name, normalized_zone);
        if from.is_empty() {
            continue;
        }
        let chain = compute_cname_chain(&from, cname_map, 20);
        let chain_str = chain.chain.join(" → ");
        if chain.cyclic {
            chain_issues.push(format!("{}: CNAME cycle detected ({})", r.name, chain_str));
        } else if chain.hops >= limits.cname_chain_fail_hops as usize {
            chain_issues.push(format!(
                "{}: CNAME chain is {} hops ({})",
                r.name, chain.hops, chain_str
            ));
        } else if chain.hops >= limits.cname_chain_warn_hops as usize {
            chain_warnings.push(format!(
                "{}: CNAME chain is {} hops (best practice ≤{})",
                r.name,
                chain.hops,
                limits.cname_chain_warn_hops - 1
            ));
        }
    }
    if !chain_issues.is_empty() {
        items.push(item(
            "cname-chains-fail",
            AuditCategory::Hygiene,
            AuditSeverity::Fail,
            "CNAME chains or cycles",
            chain_issues
                .iter()
                .take(8)
                .cloned()
                .collect::<Vec<_>>()
                .join("\n"),
        ));
    }
    if !chain_warnings.is_empty() {
        items.push(item(
            "cname-chains-warn",
            AuditCategory::Hygiene,
            AuditSeverity::Warn,
            "CNAME chains exceed best practice",
            chain_warnings
                .iter()
                .take(8)
                .cloned()
                .collect::<Vec<_>>()
                .join("\n"),
        ));
    }
    if chain_issues.is_empty() && chain_warnings.is_empty() {
        items.push(item(
            "cname-chains",
            AuditCategory::Hygiene,
            AuditSeverity::Pass,
            "CNAME chaining",
            format!(
                "No excessive CNAME chains detected (all ≤{} hops).",
                limits.cname_chain_warn_hops - 1
            ),
        ));
    }

    // Deprecated SPF RR type
    if !spf_type_records.is_empty() {
        items.push(item(
            "spf-type-deprecated",
            AuditCategory::Hygiene,
            AuditSeverity::Warn,
            "SPF record type present",
            "The SPF RR type is deprecated. Publish SPF as a TXT record instead.",
        ));
    } else {
        items.push(item(
            "spf-type-deprecated",
            AuditCategory::Hygiene,
            AuditSeverity::Pass,
            "No deprecated SPF RR type",
            "No SPF-type records found.",
        ));
    }

    // Special / bogon A records
    let bad_a: Vec<String> = records
        .iter()
        .filter(|r| r.r#type == "A")
        .filter_map(|r| {
            let ip = r.content.trim();
            classify_special_ip(ip).map(|issue| format!("{}: {} ({})", r.name, ip, issue))
        })
        .collect();
    items.push(item(
        "special-a",
        AuditCategory::Hygiene,
        if bad_a.is_empty() {
            AuditSeverity::Pass
        } else {
            AuditSeverity::Warn
        },
        "A records (special/private/bogon IPs)",
        if bad_a.is_empty() {
            "No obvious special-use/bogon IPv4 addresses detected in A records.".to_string()
        } else {
            bad_a.iter().take(8).cloned().collect::<Vec<_>>().join("\n")
        },
    ));

    // Special / bogon AAAA records
    let bad_aaaa: Vec<String> = records
        .iter()
        .filter(|r| r.r#type == "AAAA")
        .filter_map(|r| {
            let ip = r.content.trim();
            classify_special_ip(ip).map(|issue| format!("{}: {} ({})", r.name, ip, issue))
        })
        .collect();
    items.push(item(
        "special-aaaa",
        AuditCategory::Hygiene,
        if bad_aaaa.is_empty() {
            AuditSeverity::Pass
        } else {
            AuditSeverity::Warn
        },
        "AAAA records (special/private/bogon IPs)",
        if bad_aaaa.is_empty() {
            "No obvious special-use/bogon IPv6 addresses detected in AAAA records.".to_string()
        } else {
            bad_aaaa
                .iter()
                .take(8)
                .cloned()
                .collect::<Vec<_>>()
                .join("\n")
        },
    ));

    // NS redundancy
    let ns_at_apex: Vec<&DNSRecord> = records
        .iter()
        .filter(|r| r.r#type == "NS" && record_name_is_apex(&r.name, normalized_zone))
        .collect();
    if ns_at_apex.is_empty() {
        items.push(item(
            "ns-missing",
            AuditCategory::Hygiene,
            AuditSeverity::Info,
            "NS records at apex",
            "No NS records visible at apex (Cloudflare manages these automatically).",
        ));
    } else if ns_at_apex.len() < limits.ns_minimum_at_apex as usize {
        items.push(item(
            "ns-single",
            AuditCategory::Hygiene,
            AuditSeverity::Fail,
            // The id and the one-record title are what this finding has always
            // been. A raised minimum reaches it with more than one NS record,
            // where "Single NS record at apex" would be an outright false
            // statement, so that case gets its own title rather than a
            // reworded shared one.
            if ns_at_apex.len() == 1 {
                "Single NS record at apex"
            } else {
                "Too few NS records at apex"
            },
            format!(
                "Best practice requires ≥{} authoritative name servers for redundancy.",
                limits.ns_minimum_at_apex
            ),
        ));
    } else {
        items.push(item(
            "ns-redundancy",
            AuditCategory::Hygiene,
            AuditSeverity::Pass,
            "NS redundancy",
            format!("Found {} NS records at apex.", ns_at_apex.len()),
        ));
    }

    // Single A/AAAA at apex
    let apex_a = records
        .iter()
        .filter(|r| r.r#type == "A" && record_name_is_apex(&r.name, normalized_zone))
        .count();
    let apex_aaaa = records
        .iter()
        .filter(|r| r.r#type == "AAAA" && record_name_is_apex(&r.name, normalized_zone))
        .count();
    if apex_a == 1 && apex_aaaa == 0 {
        items.push(item(
            "apex-single-ip",
            AuditCategory::Hygiene,
            AuditSeverity::Warn,
            "Single A record at apex",
            "Apex has only one A record. Consider adding redundancy for critical services.",
        ));
    }
    if apex_aaaa == 1 && apex_a == 0 {
        items.push(item(
            "apex-single-ipv6",
            AuditCategory::Hygiene,
            AuditSeverity::Warn,
            "Single AAAA record at apex",
            "Apex has only one AAAA record. Consider adding redundancy for critical services.",
        ));
    }

    // SOA review
    if soa_records.is_empty() {
        items.push(item(
            "soa-missing",
            AuditCategory::Hygiene,
            AuditSeverity::Info,
            "SOA record",
            "No SOA record found (Cloudflare may manage SOA automatically).",
        ));
    } else if soa_records.len() > 1 {
        items.push(item(
            "soa-multiple",
            AuditCategory::Hygiene,
            AuditSeverity::Warn,
            "Multiple SOA records",
            format!(
                "Found {} SOA records; typically there should be exactly one.",
                soa_records.len()
            ),
        ));
    } else {
        let soa = soa_records[0];
        let parts: Vec<&str> = soa.content.split_whitespace().collect();
        let mut issues = Vec::new();
        if !record_name_is_apex(&soa.name, normalized_zone) {
            issues.push("SOA name is usually \"@\".".to_string());
        }
        if parts.len() < 7 {
            issues.push(
                "SOA content should have 7 fields: mname rname serial refresh retry expire minimum."
                    .to_string(),
            );
        } else {
            let mname = parts[0];
            let rname = parts[1];
            let serial = parts[2];
            let refresh: Option<u32> = parts[3].parse().ok();
            let retry: Option<u32> = parts[4].parse().ok();
            let expire: Option<u32> = parts[5].parse().ok();
            let minimum: Option<u32> = parts[6].parse().ok();

            if !mname.contains('.') {
                issues.push("SOA mname does not look like a hostname.".to_string());
            }
            if !rname.contains('.') {
                issues.push(
                    "SOA rname should look like an email with '.' instead of '@'.".to_string(),
                );
            }
            if serial.len() < 6 || !serial.chars().all(|c| c.is_ascii_digit()) {
                issues.push("SOA serial should be numeric (often YYYYMMDDnn).".to_string());
            }
            if !serial_date_is_plausible(serial) {
                issues.push(
                    "SOA serial looks like YYYYMMDDnn but the date part is unusual.".to_string(),
                );
            }
            // The range checks below read each timer as a `u32`, so a field that
            // is not a number at all disappears into `None` and skips every one
            // of them. Report it instead of falling silent.
            if [parts[3], parts[4], parts[5], parts[6]]
                .iter()
                .any(|field| !field.parse::<f64>().is_ok_and(|n| n.is_finite()))
            {
                issues.push("SOA timers must be numeric.".to_string());
            }
            if let Some(r) = refresh {
                if r < 3600 {
                    issues.push(
                        "SOA refresh <3600s violates best practice (should be ≥3600).".to_string(),
                    );
                }
                if r > 86400 {
                    issues.push("SOA refresh is very high (>86400).".to_string());
                }
            }
            if let Some(r) = retry {
                if !(600..=900).contains(&r) {
                    issues.push("SOA retry outside recommended range 600-900s.".to_string());
                }
            }
            if let Some(e) = expire {
                if e < 604800 {
                    issues.push(
                        "SOA expire <7 days violates best practice (should be ≥604800)."
                            .to_string(),
                    );
                }
                if e > 2419200 {
                    issues.push("SOA expire is very high (>28 days).".to_string());
                }
            }
            if let Some(m) = minimum {
                if !(60..=86400).contains(&m) {
                    issues.push("SOA minimum is unusual (typical 60–86400).".to_string());
                }
            }
            if let (Some(rf), Some(rt)) = (refresh, retry) {
                if rf > 0 && rt > 0 && rt >= rf {
                    issues.push("SOA retry is >= refresh (should be smaller).".to_string());
                }
            }
            if let Some(m) = minimum {
                let lowest_ttl = records
                    .iter()
                    .filter_map(get_ttl_seconds)
                    .filter(|&t| t > 0)
                    .min();
                if let Some(lt) = lowest_ttl {
                    if m < lt {
                        issues.push(format!(
                            "SOA minimum ({}s) is less than lowest record TTL ({}s). Best practice: SOA minimum ≥ lowest TTL.",
                            m, lt
                        ));
                    }
                }
            }
        }
        items.push(item(
            "soa-review",
            AuditCategory::Hygiene,
            if issues.is_empty() {
                AuditSeverity::Pass
            } else {
                AuditSeverity::Info
            },
            "SOA best-practice review",
            if issues.is_empty() {
                "SOA record looks structurally valid.".to_string()
            } else {
                issues.join("\n")
            },
        ));
    }

    // TXT sprawl
    let mut txt_by_name: HashMap<String, usize> = HashMap::new();
    for r in records.iter().filter(|r| r.r#type == "TXT") {
        let n = normalize_name(&r.name, normalized_zone);
        if n.is_empty() {
            continue;
        }
        *txt_by_name.entry(n).or_insert(0) += 1;
    }
    let txt_sprawl: Vec<String> = txt_by_name
        .iter()
        .filter(|(_, &count)| count > limits.txt_records_per_name_limit as usize)
        .map(|(name, count)| format!("{}: {} TXT records", name, count))
        .collect();
    if !txt_sprawl.is_empty() {
        let detail = format!(
            "{}\n\nMultiple TXT records at the same name can make management difficult. Ensure each serves a purpose.",
            txt_sprawl.iter().take(8).cloned().collect::<Vec<_>>().join("\n")
        );
        items.push(item(
            "txt-sprawl",
            AuditCategory::Hygiene,
            AuditSeverity::Info,
            "TXT record sprawl detected",
            detail,
        ));
    }

    // SRV review
    if !srv_records.is_empty() {
        let mut issues = Vec::new();
        for r in srv_records.iter().take(50) {
            let name = r.name.trim();
            if !name.starts_with('_')
                || (!name.to_lowercase().contains("._tcp")
                    && !name.to_lowercase().contains("._udp"))
            {
                issues.push(format!(
                    "SRV {}: name should be like _service._tcp (or _udp).",
                    name
                ));
            }
            let parsed = parse_srv(&r.content);
            if parsed.priority.is_none() || parsed.weight.is_none() || parsed.port.is_none() {
                // `parse_srv` yields `Option<u16>`, so a port outside the u16
                // range is indistinguishable from a missing one. TypeScript's
                // `Number()` has no such ceiling and names the port, so recover
                // that case from the raw field rather than blaming the layout.
                //
                // Only when the record has all four fields: with fewer than
                // four the layout really is the problem, and `parse_srv` hands
                // back the whole content as the target rather than splitting it.
                let mut fields = r.content.split_whitespace();
                let port_field = fields.nth(2);
                let has_target = fields.next().is_some();
                if has_target
                    && parsed.port.is_none()
                    && port_field.is_some_and(|field| field.parse::<i64>().is_ok())
                {
                    issues.push(format!("SRV {}: port out of range.", name));
                } else {
                    issues.push(format!(
                        "SRV {}: content should be \"priority weight port target\".",
                        name
                    ));
                }
                continue;
            }
            let tgt = parsed.target.trim();
            if tgt.is_empty() {
                issues.push(format!("SRV {}: target missing.", name));
            }
            if tgt == "." && parsed.port != Some(0) {
                issues.push(format!(
                    "SRV {}: target '.' indicates service not available; port should be 0.",
                    name
                ));
            }
        }
        items.push(item(
            "srv-review",
            AuditCategory::Hygiene,
            if issues.is_empty() {
                AuditSeverity::Pass
            } else {
                AuditSeverity::Info
            },
            "SRV best-practice review",
            if issues.is_empty() {
                "No obvious SRV issues detected.".to_string()
            } else {
                issues
                    .iter()
                    .take(12)
                    .cloned()
                    .collect::<Vec<_>>()
                    .join("\n")
            },
        ));
    }
}

// ── Security ────────────────────────────────────────────────────────────────

/// What the iodef suggestion on `caa-analysis` does *not* cover.
///
/// `caa-analysis` is one finding built from several independent CAA problems
/// joined into one `details` block, but a finding carries at most one
/// `suggestion` and the UI offers it under a generic "Add suggested record…"
/// label. Of the three problems it reports, only the missing iodef tag is fixed
/// by adding a record; the other two ask for existing records to be changed or
/// removed. Without this sentence a user reading a three-line finding with one
/// button has no way to tell which line the button addresses.
///
/// Kept as its own literal, joined with `\n\n` at the call site rather than
/// written into the surrounding `format!`, so that it fingerprints identically
/// to the TypeScript template literal that `test/domain-audit-parity.test.ts`
/// compares it against.
const CAA_IODEF_SUGGESTION_SCOPE: &str = "The suggested record adds the iodef tag only; the other points listed here each need a separate change.";

fn audit_security(
    items: &mut Vec<AuditItem>,
    records: &[DNSRecord],
    apex: &str,
    limits: &AuditThresholds,
) {
    let caa_records: Vec<&DNSRecord> = records.iter().filter(|r| r.r#type == "CAA").collect();
    if !caa_records.is_empty() {
        let parsed: Vec<(Option<u8>, Option<String>, Option<String>)> =
            caa_records.iter().map(|r| parse_caa(&r.content)).collect();
        let has_iodef = parsed
            .iter()
            .any(|(_, tag, val)| tag.as_deref() == Some("iodef") && val.is_some());
        let mut issues = Vec::new();
        if !has_iodef {
            issues.push(
                "No iodef CAA tag detected (consider adding an incident contact URL/email)."
                    .to_string(),
            );
        }
        let issue_values: Vec<String> = parsed
            .iter()
            .filter(|(_, tag, _)| {
                tag.as_deref() == Some("issue") || tag.as_deref() == Some("issuewild")
            })
            .filter_map(|(_, _, val)| val.clone())
            .filter(|v| !v.trim().is_empty())
            .collect();
        let distinct: HashSet<&str> = issue_values.iter().map(|s| s.as_str()).collect();
        if distinct.len() > limits.caa_issuer_limit as usize {
            issues.push(format!(
                "CAA allows many issuers ({}). Consider tightening to fewer CAs.",
                distinct.len()
            ));
        }
        let has_deny_all = parsed.iter().any(|(_, tag, val)| {
            tag.as_deref() == Some("issue") && val.as_deref().map(|v| v.trim()) == Some(";")
        });
        if !has_deny_all && distinct.is_empty() {
            issues.push(
                "CAA exists but contains no issue/issuewild tags (may be ineffective).".to_string(),
            );
        }
        // The note belongs on the finding only when the suggestion is offered
        // *and* there is another line beside the iodef one. With the iodef line
        // alone there is nothing for a reader to mistake the button for, and the
        // sentence would not be true.
        let scope_note = !has_iodef && issues.len() > 1;
        let details = if issues.is_empty() {
            "CAA present and looks reasonable.".to_string()
        } else if scope_note {
            format!("{}\n\n{}", issues.join("\n"), CAA_IODEF_SUGGESTION_SCOPE)
        } else {
            issues.join("\n")
        };
        let severity = if issues.is_empty() {
            AuditSeverity::Pass
        } else {
            AuditSeverity::Warn
        };
        // Of the three problems this finding reports, only a missing iodef tag
        // is repaired by adding a record, so the suggestion is offered on
        // exactly that condition. The other two ask for records that already
        // exist to be changed or removed, which a pre-filled add-record form
        // cannot express.
        //
        // Flags `0` is not a style choice. A CA that does not recognise a tag
        // marked critical must refuse to issue (RFC 8659 §4.1), so `128 iodef`
        // would hand the zone an outage in exchange for a contact address. The
        // mailbox is a template the user edits before saving — the app cannot
        // know the real contact — and `security@` is the local part RFC 9116
        // already uses for exactly this purpose.
        items.push(if has_iodef {
            item(
                "caa-analysis",
                AuditCategory::Security,
                severity,
                "CAA policy review",
                details,
            )
        } else {
            item_with_suggestion(
                "caa-analysis",
                AuditCategory::Security,
                severity,
                "CAA policy review",
                details,
                "CAA",
                "@",
                &format!("0 iodef \"mailto:security@{}\"", apex),
            )
        });
    } else {
        items.push(item(
            "caa-analysis",
            AuditCategory::Security,
            AuditSeverity::Info,
            "CAA policy review",
            "No CAA records detected.",
        ));
    }
}

// ── Email ───────────────────────────────────────────────────────────────────

#[allow(clippy::too_many_arguments)]
fn audit_email(
    items: &mut Vec<AuditItem>,
    _records: &[DNSRecord],
    normalized_zone: &str,
    apex: &str,
    limits: &AuditThresholds,
    mx: &[&DNSRecord],
    mx_at_apex: &[&DNSRecord],
    spf_txt_at_apex: &[String],
    dmarc_txt: &[String],
    dmarc_name: &str,
    has_any_dkim: bool,
    cname_map: &HashMap<String, String>,
    a_by_name: &HashMap<String, usize>,
    aaaa_by_name: &HashMap<String, usize>,
) {
    // MX presence
    if !mx_at_apex.is_empty() {
        items.push(item(
            "mx-present",
            AuditCategory::Email,
            AuditSeverity::Info,
            "MX records detected at apex",
            format!("Found {} MX record(s) at {}.", mx_at_apex.len(), apex),
        ));
    } else {
        items.push(item(
            "mx-present",
            AuditCategory::Email,
            if !mx.is_empty() {
                AuditSeverity::Info
            } else {
                AuditSeverity::Pass
            },
            "MX records",
            if !mx.is_empty() {
                format!("Found {} MX record(s) (not at apex).", mx.len())
            } else {
                "No MX records detected.".to_string()
            },
        ));
    }

    // MX redundancy
    if mx_at_apex.len() == 1 {
        items.push(item(
            "mx-single",
            AuditCategory::Email,
            AuditSeverity::Warn,
            "Single MX record at apex",
            "Having only one MX can be a single point of failure. Consider adding a secondary MX (or ensuring provider HA).",
        ));
    } else if mx_at_apex.len() > limits.mx_many_at_apex_limit as usize {
        items.push(item(
            "mx-too-many",
            AuditCategory::Email,
            AuditSeverity::Warn,
            "Many MX records at apex",
            format!(
                "Found {} MX records at apex; this is unusual and may be misconfigured.",
                mx_at_apex.len()
            ),
        ));
    } else if mx_at_apex.len() > 1 {
        items.push(item(
            "mx-redundancy",
            AuditCategory::Email,
            AuditSeverity::Pass,
            "MX redundancy",
            format!(
                "Multiple MX records detected at apex ({}).",
                mx_at_apex.len()
            ),
        ));
    }

    // MX → CNAME target check
    let cname_names: HashSet<&str> = cname_map.keys().map(|s| s.as_str()).collect();
    let mx_cname_targets: Vec<String> = mx_at_apex
        .iter()
        .map(|r| normalize_target_domain(&r.content, normalized_zone))
        .filter(|t| cname_names.contains(t.as_str()))
        .collect();
    if !mx_cname_targets.is_empty() {
        let unique: HashSet<&str> = mx_cname_targets.iter().map(|s| s.as_str()).collect();
        items.push(item(
            "mx-cname-target",
            AuditCategory::Email,
            AuditSeverity::Fail,
            "MX points at a CNAME target",
            format!(
                "One or more MX targets are CNAMEs in this zone: {}",
                unique.into_iter().collect::<Vec<_>>().join(", ")
            ),
        ));
    } else if !mx_at_apex.is_empty() {
        items.push(item(
            "mx-cname-target",
            AuditCategory::Email,
            AuditSeverity::Pass,
            "MX targets are not CNAMEs (within zone)",
            "No MX targets match CNAME names in this zone.",
        ));
    }

    // MX duplicate priority & resolution
    if mx_at_apex.len() > 1 {
        let parsed: Vec<(Option<u16>, Option<String>)> = mx_at_apex
            .iter()
            .map(|r| parse_mx_record(r, normalized_zone))
            .collect();
        let priorities: Vec<u16> = parsed.iter().filter_map(|(p, _)| *p).collect();
        let unique_priorities: HashSet<u16> = priorities.iter().copied().collect();
        if priorities.len() > 1 && unique_priorities.len() < priorities.len() {
            items.push(item(
                "mx-duplicate-priority",
                AuditCategory::Email,
                AuditSeverity::Warn,
                "MX records have duplicate priorities",
                "Multiple MX records share the same priority. Ensure this is intentional for round-robin.",
            ));
        }

        let unresolved: Vec<String> = parsed
            .iter()
            .filter_map(|(_, t)| t.as_ref())
            .filter(|t| !t.is_empty())
            .filter(|t| {
                !a_by_name.contains_key(t.as_str()) && !aaaa_by_name.contains_key(t.as_str())
            })
            .cloned()
            .collect();
        if !unresolved.is_empty() {
            let unique: HashSet<&str> = unresolved.iter().map(|s| s.as_str()).collect();
            items.push(item(
                "mx-no-resolution",
                AuditCategory::Email,
                AuditSeverity::Info,
                "MX targets without A/AAAA in zone",
                format!(
                    "The following MX targets have no A or AAAA records in this zone: {}. This is OK if they resolve externally, but verify they're reachable.",
                    unique.into_iter().collect::<Vec<_>>().join(", ")
                ),
            ));
        }
    }

    // SPF
    if spf_txt_at_apex.is_empty() {
        items.push(item_with_suggestion(
            "spf-missing",
            AuditCategory::Email,
            if !mx_at_apex.is_empty() {
                AuditSeverity::Fail
            } else {
                AuditSeverity::Warn
            },
            "SPF missing at apex",
            if !mx_at_apex.is_empty() {
                "MX exists at the zone apex but no SPF TXT record was found at @."
            } else {
                "No SPF TXT record was found at @."
            },
            "TXT",
            "@",
            "v=spf1 -all",
        ));
    } else if spf_txt_at_apex.len() > 1 {
        items.push(item(
            "spf-multiple",
            AuditCategory::Email,
            AuditSeverity::Fail,
            "Multiple SPF TXT records at apex",
            "Multiple SPF records can cause permerror. Combine mechanisms into a single SPF TXT record.",
        ));
    } else {
        let spf = &spf_txt_at_apex[0];
        let qualifier = get_spf_all_qualifier(spf);
        let lookup_estimate = estimate_spf_lookup_count(spf);

        match qualifier {
            None => {
                items.push(item(
                    "spf-all-missing",
                    AuditCategory::Email,
                    AuditSeverity::Warn,
                    "SPF missing an all mechanism",
                    "SPF should typically end with one of -all or ~all.",
                ));
            }
            Some('+') => {
                items.push(item(
                    "spf-too-permissive",
                    AuditCategory::Email,
                    AuditSeverity::Fail,
                    "SPF is too permissive (+all)",
                    "SPF with +all authorizes any sender and is usually a serious misconfiguration.",
                ));
            }
            Some('?') => {
                items.push(item(
                    "spf-neutral",
                    AuditCategory::Email,
                    AuditSeverity::Warn,
                    "SPF ends with ?all (neutral)",
                    "Neutral SPF provides weak protection. Prefer -all or ~all once confident.",
                ));
            }
            Some('~') => {
                items.push(item(
                    "spf-softfail",
                    AuditCategory::Email,
                    if !mx_at_apex.is_empty() {
                        AuditSeverity::Warn
                    } else {
                        AuditSeverity::Info
                    },
                    "SPF ends with ~all (softfail)",
                    "Softfail is common during rollout. Consider moving to -all once aligned.",
                ));
            }
            Some('-') => {
                items.push(item(
                    "spf-ok",
                    AuditCategory::Email,
                    AuditSeverity::Pass,
                    "SPF present at apex",
                    "Found one SPF TXT record at @ with an all mechanism.",
                ));
            }
            _ => {}
        }

        // ptr mechanism
        if let Some(parsed) = parse_spf(spf) {
            if parsed.mechanisms.iter().any(|m| m.mechanism == "ptr") {
                items.push(item(
                    "spf-ptr",
                    AuditCategory::Email,
                    AuditSeverity::Warn,
                    "SPF uses ptr mechanism",
                    "The ptr mechanism is discouraged; it is slow and unreliable.",
                ));
            }
        }

        // Lookup estimate
        if let Some(count) = lookup_estimate {
            if count >= limits.spf_lookup_warn_count {
                items.push(item(
                    "spf-lookups-estimate",
                    AuditCategory::Email,
                    AuditSeverity::Warn,
                    "SPF may exceed DNS lookup budget",
                    format!(
                        "Estimated lookup-triggering mechanisms: {}. SPF has a 10 DNS lookup limit; consider flattening or simplifying.",
                        count
                    ),
                ));
            } else {
                items.push(item(
                    "spf-lookups-estimate",
                    AuditCategory::Email,
                    AuditSeverity::Info,
                    "SPF lookup estimate",
                    format!(
                        "Estimated lookup-triggering mechanisms: {}. Use the SPF graph check for an exact count.",
                        count
                    ),
                ));
            }
        }
    }

    // DMARC
    if dmarc_txt.is_empty() {
        items.push(item_with_suggestion(
            "dmarc-missing",
            AuditCategory::Email,
            if !mx_at_apex.is_empty() {
                AuditSeverity::Fail
            } else {
                AuditSeverity::Warn
            },
            "DMARC record missing",
            format!("No DMARC TXT record found at {}.", dmarc_name),
            "TXT",
            "_dmarc",
            &format!("v=DMARC1; p=none; rua=mailto:postmaster@{}; fo=1", apex),
        ));
    } else if dmarc_txt.len() > 1 {
        items.push(item(
            "dmarc-multiple",
            AuditCategory::Email,
            AuditSeverity::Fail,
            "Multiple DMARC TXT records",
            format!(
                "Multiple DMARC records found at {}. Keep exactly one.",
                dmarc_name
            ),
        ));
    } else {
        let dmarc = &dmarc_txt[0];
        let tags = parse_tag_record(dmarc);
        let p = tags.get("p").map(|s| s.to_lowercase()).unwrap_or_default();
        let has_rua = tags.get("rua").map(|v| !v.trim().is_empty()) == Some(true);
        if p.is_empty() {
            // Receivers ignore a record with no p= at all, so there is nothing
            // to say about its reporting: the record is not in effect either
            // way.
            items.push(item(
                "dmarc-missing-policy",
                AuditCategory::Email,
                AuditSeverity::Fail,
                "DMARC missing policy (p=)",
                "DMARC must include a p= policy tag.",
            ));
        } else {
            // Reporting is a separate question from policy strength, and it is
            // the one the audit used to be silent about. A record with no rua=
            // sends nothing anywhere: under p=none that makes it inert, and
            // under an enforcing policy it means receivers are acting on mail
            // the domain cannot see. Both deserve saying once, here, rather
            // than in fragments attached to the policy findings.
            if !has_rua {
                items.push(item(
                    "dmarc-no-rua",
                    AuditCategory::Email,
                    AuditSeverity::Warn,
                    "DMARC has no report address (rua=)",
                    // Reporting consequence only. What p=none does to
                    // delivery is dmarc-policy-none's job, and that finding now
                    // fires for every p=none domain, so repeating it here would
                    // say the same thing twice in adjacent findings.
                    if p == "none" {
                        format!(
                            "No rua= address is set at {}, so no aggregate reports are being sent.",
                            dmarc_name
                        )
                    } else {
                        format!(
                            "No rua= address is set at {}, so no aggregate reports are being sent. Receivers are acting on mail that fails your checks under p={}, and you have no way to see which mail that is.",
                            dmarc_name, p
                        )
                    },
                ));
            }
            // Not gated on an apex MX. DMARC governs what receivers do with
            // mail *claiming* to be from the domain; whether the domain
            // *accepts* mail is a separate question. Parked and web-only
            // domains are attractive spoofing targets precisely because nobody
            // is watching them.
            if p == "none" {
                items.push(item(
                    "dmarc-policy-none",
                    AuditCategory::Email,
                    AuditSeverity::Warn,
                    "DMARC policy is p=none",
                    // Consequence, not instruction: name the two policies
                    // that would change what receivers do, and let the reader
                    // decide. The severity already carries the weight.
                    "Only quarantine and reject ask receivers to act on mail that fails your checks.",
                ));
            } else if has_rua {
                items.push(item(
                    "dmarc-ok",
                    AuditCategory::Email,
                    AuditSeverity::Pass,
                    "DMARC present",
                    format!(
                        "DMARC is configured with p={} and an aggregate report address.",
                        p
                    ),
                ));
            }
        }
    }

    // DKIM
    if !mx.is_empty() && !has_any_dkim {
        items.push(item(
            "dkim-missing",
            AuditCategory::Email,
            AuditSeverity::Warn,
            "No DKIM records detected",
            "No DKIM TXT records (v=DKIM1) detected under selector._domainkey.*. DKIM selectors are provider-specific.",
        ));
    } else {
        items.push(item(
            "dkim-missing",
            AuditCategory::Email,
            if !mx.is_empty() {
                AuditSeverity::Pass
            } else {
                AuditSeverity::Info
            },
            "DKIM records",
            if !mx.is_empty() {
                "DKIM TXT records detected."
            } else {
                "No MX detected; DKIM may be unnecessary."
            },
        ));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const ZONE: &str = "example.com";

    fn record(record_type: &str, name: &str, content: &str) -> DNSRecord {
        DNSRecord {
            id: None,
            r#type: record_type.to_string(),
            name: name.to_string(),
            content: content.to_string(),
            comment: None,
            ttl: Some(300),
            priority: None,
            proxied: None,
            zone_id: "zone-id".to_string(),
            zone_name: ZONE.to_string(),
            created_on: String::new(),
            modified_on: String::new(),
        }
    }

    fn mx(target: &str, priority: u16) -> DNSRecord {
        let mut record = record("MX", ZONE, target);
        record.priority = Some(priority);
        record
    }

    fn options(email: bool, security: bool, hygiene: bool) -> AuditOptions {
        AuditOptions {
            include_categories: AuditCategories {
                email,
                security,
                hygiene,
            },
            ..AuditOptions::default()
        }
    }

    fn finding<'a>(items: &'a [AuditItem], id: &str) -> &'a AuditItem {
        items
            .iter()
            .find(|item| item.id == id)
            .unwrap_or_else(|| panic!("expected audit finding {id}"))
    }

    #[test]
    fn disabled_categories_produce_no_findings() {
        let records = vec![record("A", ZONE, "10.0.0.1")];

        let items = run_domain_audit(ZONE, &records, &options(false, false, false));

        assert!(items.is_empty());
    }

    #[test]
    fn healthy_email_configuration_has_no_warn_or_fail_findings() {
        let records = vec![
            mx("mail1.example.com", 10),
            mx("mail2.example.com", 20),
            record("A", "mail1.example.com", "1.1.1.1"),
            record("A", "mail2.example.com", "8.8.8.8"),
            record("TXT", ZONE, "v=spf1 -all"),
            record(
                "TXT",
                "_dmarc.example.com",
                "v=DMARC1; p=reject; rua=mailto:dmarc@example.com",
            ),
            record(
                "TXT",
                "selector._domainkey.example.com",
                "v=DKIM1; k=rsa; p=test-key",
            ),
        ];

        let items = run_domain_audit(ZONE, &records, &options(true, false, false));

        assert!(!items.is_empty());
        assert!(items
            .iter()
            .all(|item| item.category == AuditCategory::Email));
        assert!(items
            .iter()
            .all(|item| !matches!(item.severity, AuditSeverity::Warn | AuditSeverity::Fail)));
        assert_eq!(finding(&items, "spf-ok").severity, AuditSeverity::Pass);
        assert_eq!(finding(&items, "dmarc-ok").severity, AuditSeverity::Pass);
        assert_eq!(
            finding(&items, "mx-redundancy").severity,
            AuditSeverity::Pass
        );
        assert_eq!(
            finding(&items, "dkim-missing").severity,
            AuditSeverity::Pass
        );
    }

    #[test]
    fn email_misconfigurations_report_actionable_failures() {
        let records = vec![
            mx("mail.example.com", 10),
            record("CNAME", "mail.example.com", "origin.example.net"),
            record("TXT", ZONE, "v=spf1 +all"),
        ];

        let items = run_domain_audit(ZONE, &records, &options(true, false, false));

        assert_eq!(finding(&items, "mx-single").severity, AuditSeverity::Warn);
        assert_eq!(
            finding(&items, "mx-cname-target").severity,
            AuditSeverity::Fail
        );
        assert_eq!(
            finding(&items, "spf-too-permissive").severity,
            AuditSeverity::Fail
        );
        assert_eq!(
            finding(&items, "dmarc-missing").severity,
            AuditSeverity::Fail
        );
        assert_eq!(
            finding(&items, "dkim-missing").severity,
            AuditSeverity::Warn
        );

        let suggestion = finding(&items, "dmarc-missing")
            .suggestion
            .as_ref()
            .expect("missing DMARC should include a repair suggestion");
        assert_eq!(suggestion.record_type, "TXT");
        assert_eq!(suggestion.name, "_dmarc");
        assert!(suggestion.content.contains("postmaster@example.com"));
    }

    #[test]
    fn caa_policy_requires_an_incident_contact_for_a_clean_result() {
        let issuer = record("CAA", ZONE, "0 issue \"letsencrypt.org\"");
        let contact = record("CAA", ZONE, "0 iodef \"mailto:security@example.com\"");

        let complete = run_domain_audit(
            ZONE,
            &[issuer.clone(), contact],
            &options(false, true, false),
        );
        let incomplete = run_domain_audit(ZONE, &[issuer], &options(false, true, false));

        assert_eq!(complete.len(), 1);
        assert_eq!(complete[0].category, AuditCategory::Security);
        assert_eq!(complete[0].severity, AuditSeverity::Pass);
        assert_eq!(incomplete.len(), 1);
        assert_eq!(incomplete[0].severity, AuditSeverity::Warn);
        assert!(incomplete[0].details.contains("iodef"));
    }

    /// The suggested iodef record has to survive the round trip the app will
    /// put it through: `parse_caa` reads it back as the tag the finding asked
    /// for, and re-auditing the zone with it published clears the finding. A
    /// suggestion this crate's own parser could not read would be worse than
    /// offering none, and only the second half proves that end to end.
    #[test]
    fn the_suggested_iodef_record_parses_and_clears_the_finding() {
        let issuer = record("CAA", ZONE, "0 issue \"letsencrypt.org\"");
        let items = run_domain_audit(
            ZONE,
            std::slice::from_ref(&issuer),
            &options(false, true, false),
        );
        let caa = finding(&items, "caa-analysis");
        let suggestion = caa
            .suggestion
            .as_ref()
            .expect("a missing iodef tag should carry a repair suggestion");

        assert_eq!(suggestion.record_type, "CAA");
        assert_eq!(suggestion.name, "@");
        assert_eq!(
            suggestion.content,
            "0 iodef \"mailto:security@example.com\""
        );

        let (flags, tag, value) = parse_caa(&suggestion.content);
        assert_eq!(
            flags,
            Some(0),
            "an iodef tag marked critical can block issuance outright"
        );
        assert_eq!(tag.as_deref(), Some("iodef"));
        assert_eq!(value.as_deref(), Some("mailto:security@example.com"));

        let repaired = run_domain_audit(
            ZONE,
            &[issuer, record("CAA", ZONE, &suggestion.content)],
            &options(false, true, false),
        );
        let repaired_caa = finding(&repaired, "caa-analysis");
        assert_eq!(repaired_caa.severity, AuditSeverity::Pass);
        assert!(
            repaired_caa.suggestion.is_none(),
            "a zone that already has an iodef tag has nothing to add"
        );
    }

    /// The suggestion repairs one line of a finding that can report several, so
    /// a finding carrying more than the iodef line has to say which line the
    /// generic "Add suggested record…" button addresses — and a finding
    /// carrying only that line must not say it.
    #[test]
    fn the_caa_finding_scopes_its_suggestion_only_when_it_reports_more() {
        let four_issuers = [
            "0 issue \"letsencrypt.org\"",
            "0 issue \"digicert.com\"",
            "0 issue \"sectigo.com\"",
            "0 issue \"globalsign.com\"",
        ]
        .map(|content| record("CAA", ZONE, content));

        let crowded = run_domain_audit(ZONE, &four_issuers, &options(false, true, false));
        let crowded_caa = finding(&crowded, "caa-analysis");
        assert!(
            crowded_caa.details.contains("CAA allows many issuers (4)"),
            "expected the issuer count alongside the iodef line: {}",
            crowded_caa.details
        );
        assert!(
            crowded_caa.details.contains(CAA_IODEF_SUGGESTION_SCOPE),
            "a finding reporting more than the iodef line must scope its suggestion: {}",
            crowded_caa.details
        );
        assert!(crowded_caa.suggestion.is_some());

        let only_iodef = run_domain_audit(
            ZONE,
            &[record("CAA", ZONE, "0 issue \"letsencrypt.org\"")],
            &options(false, true, false),
        );
        let only_iodef_caa = finding(&only_iodef, "caa-analysis");
        assert!(
            !only_iodef_caa.details.contains(CAA_IODEF_SUGGESTION_SCOPE),
            "with nothing else listed there is nothing to scope against: {}",
            only_iodef_caa.details
        );
        assert!(only_iodef_caa.suggestion.is_some());

        // An issuer problem on its own is not something adding a record fixes.
        let mut with_contact = four_issuers.to_vec();
        with_contact.push(record(
            "CAA",
            ZONE,
            "0 iodef \"mailto:security@example.com\"",
        ));
        let no_suggestion = run_domain_audit(ZONE, &with_contact, &options(false, true, false));
        let no_suggestion_caa = finding(&no_suggestion, "caa-analysis");
        assert_eq!(no_suggestion_caa.severity, AuditSeverity::Warn);
        assert!(no_suggestion_caa.suggestion.is_none());
        assert!(!no_suggestion_caa
            .details
            .contains(CAA_IODEF_SUGGESTION_SCOPE));
    }

    /// The suggested record names the zone it was generated for, not the zone
    /// the fixtures happen to use.
    #[test]
    fn the_suggested_iodef_mailbox_follows_the_zone_apex() {
        let items = run_domain_audit(
            "sub.example.org.",
            &[record(
                "CAA",
                "sub.example.org",
                "0 issue \"letsencrypt.org\"",
            )],
            &options(false, true, false),
        );
        let suggestion = finding(&items, "caa-analysis")
            .suggestion
            .as_ref()
            .expect("a missing iodef tag should carry a repair suggestion");
        assert_eq!(
            suggestion.content,
            "0 iodef \"mailto:security@sub.example.org\""
        );
    }

    #[test]
    fn hygiene_detects_special_addresses_zero_ttl_and_cname_cycles() {
        let mut private_ipv4 = record("A", "internal.example.com", "10.10.10.10");
        private_ipv4.ttl = Some(0);
        let records = vec![
            private_ipv4,
            record("AAAA", "loopback.example.com", "::1"),
            record("CNAME", "a.example.com", "b.example.com"),
            record("CNAME", "b.example.com", "a.example.com"),
        ];

        let items = run_domain_audit(ZONE, &records, &options(false, false, true));
        let expected_findings = [
            ("ttl-critical", AuditSeverity::Fail),
            ("cname-chains-fail", AuditSeverity::Fail),
            ("special-a", AuditSeverity::Warn),
            ("special-aaaa", AuditSeverity::Warn),
        ];

        for (id, expected_severity) in expected_findings {
            let audit_item = finding(&items, id);
            assert_eq!(audit_item.id, id);
            assert_eq!(audit_item.category, AuditCategory::Hygiene, "{id}");
            assert_eq!(audit_item.severity, expected_severity, "{id}");
        }
    }

    #[test]
    fn expired_domain_is_a_failure() {
        let mut audit_options = options(false, false, true);
        audit_options.domain_expires_at = Some("2000-01-01T00:00:00Z".to_string());

        let items = run_domain_audit(ZONE, &[], &audit_options);
        let expiry = finding(&items, "domain-expiry");

        assert_eq!(expiry.category, AuditCategory::Hygiene);
        assert_eq!(expiry.severity, AuditSeverity::Fail);
        assert!(expiry.details.contains("Renew immediately"));
    }

    // ── TXT presentation shapes ─────────────────────────────────────────────
    //
    // Regression: a published `v=spf1 mx -all` at the apex was reported as
    // "SPF missing at apex" whenever the content arrived quoted, because the
    // detector inspected the raw presentation text rather than the logical
    // TXT value.

    /// Every presentation shape of the same logical `v=spf1 mx -all` record.
    const SPF_SHAPES: &[(&str, &str)] = &[
        ("bare", "v=spf1 mx -all"),
        ("quoted", "\"v=spf1 mx -all\""),
        ("padded quoted", "  \"v=spf1 mx -all\"  "),
        ("split character-strings", "\"v=spf1 \" \"mx -all\""),
        ("quoted uppercase", "\"V=SPF1 MX -ALL\""),
    ];

    #[test]
    fn apex_spf_is_detected_in_every_presentation_shape() {
        for (label, content) in SPF_SHAPES {
            let records = vec![record("TXT", ZONE, content)];
            let items = run_domain_audit(ZONE, &records, &options(true, false, false));

            assert_eq!(
                finding(&items, "spf-ok").severity,
                AuditSeverity::Pass,
                "expected spf-ok for {label} ({content})"
            );
            assert!(
                !items.iter().any(|item| item.id == "spf-missing"),
                "expected no spf-missing for {label} ({content})"
            );
        }
    }

    #[test]
    fn apex_spf_is_detected_for_every_apex_owner_name() {
        for name in ["example.com", "@", "example.com.", "EXAMPLE.COM"] {
            let records = vec![record("TXT", name, "\"v=spf1 mx -all\"")];
            let items = run_domain_audit(ZONE, &records, &options(true, false, false));

            assert_eq!(
                finding(&items, "spf-ok").severity,
                AuditSeverity::Pass,
                "expected spf-ok for owner name {name}"
            );
        }
    }

    #[test]
    fn quoted_spf_still_reports_its_lookup_estimate() {
        let records = vec![record("TXT", ZONE, "\"v=spf1 mx -all\"")];
        let items = run_domain_audit(ZONE, &records, &options(true, false, false));

        assert!(finding(&items, "spf-lookups-estimate")
            .details
            .contains("mechanisms: 1"));
    }

    #[test]
    fn a_txt_record_that_only_looks_like_spf_is_not_treated_as_spf() {
        // RFC 7208 §4.5: `v=spf1` must be followed by whitespace or the end of
        // the record, so `v=spf1foo` is a different record entirely.
        let records = vec![record("TXT", ZONE, "v=spf1foo bar")];
        let items = run_domain_audit(ZONE, &records, &options(true, false, false));

        assert_eq!(finding(&items, "spf-missing").severity, AuditSeverity::Warn);
    }

    #[test]
    fn multiple_spf_records_are_counted_across_presentation_shapes() {
        let records = vec![
            record("TXT", ZONE, "v=spf1 mx -all"),
            record("TXT", ZONE, "\"v=spf1 include:_spf.example.net -all\""),
        ];
        let items = run_domain_audit(ZONE, &records, &options(true, false, false));

        assert_eq!(
            finding(&items, "spf-multiple").severity,
            AuditSeverity::Fail
        );
    }

    #[test]
    fn dmarc_is_detected_in_every_presentation_shape() {
        let cases: &[(&str, &str, &str)] = &[
            (
                "bare",
                "_dmarc.example.com",
                "v=DMARC1; p=reject; rua=mailto:dmarc@example.com",
            ),
            (
                "quoted",
                "_dmarc.example.com",
                "\"v=DMARC1; p=reject; rua=mailto:dmarc@example.com\"",
            ),
            (
                "split character-strings",
                "_dmarc.example.com",
                "\"v=DMARC1; p=reject;\" \" rua=mailto:dmarc@example.com\"",
            ),
            (
                "absolute owner name",
                "_dmarc.example.com.",
                "v=DMARC1; p=reject; rua=mailto:dmarc@example.com",
            ),
            (
                "uppercase owner name",
                "_DMARC.EXAMPLE.COM",
                "v=DMARC1; p=reject; rua=mailto:dmarc@example.com",
            ),
        ];

        for (label, name, content) in cases {
            let records = vec![record("TXT", name, content)];
            let items = run_domain_audit(ZONE, &records, &options(true, false, false));

            assert_eq!(
                finding(&items, "dmarc-ok").severity,
                AuditSeverity::Pass,
                "expected dmarc-ok for {label} ({name} / {content})"
            );
        }
    }

    #[test]
    fn dkim_is_detected_in_every_presentation_shape() {
        let cases: &[(&str, &str, &str)] = &[
            (
                "bare",
                "sel._domainkey.example.com",
                "v=DKIM1; k=rsa; p=key",
            ),
            (
                "quoted",
                "sel._domainkey.example.com",
                "\"v=DKIM1; k=rsa; p=key\"",
            ),
            (
                "split character-strings",
                "sel._domainkey.example.com",
                "\"v=DKIM1; k=rsa; \" \"p=key\"",
            ),
            (
                "absolute owner name",
                "sel._domainkey.example.com.",
                "v=DKIM1; p=key",
            ),
        ];

        for (label, name, content) in cases {
            let records = vec![mx("mail.example.com", 10), record("TXT", name, content)];
            let items = run_domain_audit(ZONE, &records, &options(true, false, false));

            assert_eq!(
                finding(&items, "dkim-missing").severity,
                AuditSeverity::Pass,
                "expected DKIM detection for {label} ({name} / {content})"
            );
        }
    }

    // ── Finding explanations ────────────────────────────────────────────────

    #[test]
    fn a_missing_record_explains_what_it_does() {
        let records = vec![mx("mail.example.com", 10)];
        let items = run_domain_audit(ZONE, &records, &options(true, false, false));

        let spf = finding(&items, "spf-missing");
        assert!(spf.details.contains("no SPF TXT record was found at @"));
        assert!(spf
            .details
            .contains("lists the servers allowed to send mail using your domain"));

        let dmarc = finding(&items, "dmarc-missing");
        assert!(dmarc
            .details
            .contains("what to do with mail that fails your SPF and DKIM checks"));

        let dkim = finding(&items, "dkim-missing");
        assert!(dkim
            .details
            .contains("verify against a public key published in your DNS"));
    }

    #[test]
    fn an_explained_finding_keeps_its_original_details_first() {
        let records = vec![mx("mail.example.com", 10)];
        let items = run_domain_audit(ZONE, &records, &options(true, false, false));

        let details = &finding(&items, "spf-missing").details;
        let first = details
            .split(
                "

",
            )
            .next()
            .expect("a first paragraph");

        assert_eq!(
            first,
            "MX exists at the zone apex but no SPF TXT record was found at @."
        );
    }

    #[test]
    fn a_passing_finding_carries_no_explanation() {
        let records = vec![
            mx("mail1.example.com", 10),
            mx("mail2.example.com", 20),
            record("A", "mail1.example.com", "1.1.1.1"),
            record("A", "mail2.example.com", "8.8.8.8"),
            record("TXT", ZONE, "v=spf1 -all"),
            record("TXT", "_dmarc.example.com", "v=DMARC1; p=reject"),
            record("TXT", "sel._domainkey.example.com", "v=DKIM1; k=rsa; p=key"),
        ];
        let items = run_domain_audit(ZONE, &records, &options(true, false, false));

        for item in &items {
            if item.severity != AuditSeverity::Pass {
                continue;
            }
            if let Some((_, explanation)) = FINDING_EXPLANATIONS
                .iter()
                .find(|(id, _)| *id == item.id.as_str())
            {
                assert!(
                    !item.details.contains(explanation),
                    "passing finding {} should not be explained",
                    item.id
                );
            }
        }
    }

    #[test]
    fn the_explanation_table_has_no_duplicate_or_stray_keys() {
        let mut seen = HashSet::new();
        for (id, text) in FINDING_EXPLANATIONS {
            assert!(seen.insert(*id), "duplicate explanation for {id}");
            assert!(!text.is_empty(), "empty explanation for {id}");
            // The UI recovers an overridden finding's severity out of `details`
            // with /Original severity: (\w+)/; explanations must not collide.
            assert!(
                !text.contains("Original severity:"),
                "{id} collides with the override marker"
            );
        }
        assert!(!seen.contains("special-a"));
        assert!(!seen.contains("special-aaaa"));
    }

    #[test]
    fn the_reporting_statement_lives_on_the_reporting_finding() {
        // This invariant used to sit on dmarc-policy-none, which carried a
        // conditional rua clause. It moved to its own finding rather than
        // disappearing.
        let records = vec![
            mx("mail.example.com", 10),
            record("TXT", "_dmarc.example.com", "v=DMARC1; p=none;"),
        ];
        let items = run_domain_audit(ZONE, &records, &options(true, false, false));

        assert!(finding(&items, "dmarc-no-rua")
            .details
            .contains("no aggregate reports are being sent"));
    }

    #[test]
    fn p_none_with_rua_is_not_told_its_reports_are_missing() {
        let records = vec![
            mx("mail.example.com", 10),
            record(
                "TXT",
                "_dmarc.example.com",
                "v=DMARC1; p=none; rua=mailto:dmarc@example.com",
            ),
        ];
        let items = run_domain_audit(ZONE, &records, &options(true, false, false));

        assert!(!items.iter().any(|item| item.id == "dmarc-no-rua"));
        assert!(finding(&items, "dmarc-policy-none")
            .details
            .contains("Only quarantine and reject ask receivers to act"));
    }

    // ── DMARC reporting visibility ──────────────────────────────────────────
    //
    // A record with no `rua=` sends no reports anywhere. Under an enforcing
    // policy receivers are quarantining or destroying mail that fails the
    // domain's checks and the domain cannot see which mail that is. The audit
    // used to call that `dmarc-ok`/Pass.

    fn dmarc_items(dmarc: &str, with_mx: bool) -> Vec<AuditItem> {
        let mut records = vec![record("TXT", "_dmarc.example.com", dmarc)];
        if with_mx {
            records.insert(0, mx("mail.example.com", 10));
        }
        run_domain_audit(ZONE, &records, &options(true, false, false))
    }

    fn severity_of(dmarc: &str, id: &str, with_mx: bool) -> Option<AuditSeverity> {
        dmarc_items(dmarc, with_mx)
            .into_iter()
            .find(|item| item.id == id)
            .map(|item| item.severity)
    }

    fn details_of(dmarc: &str, id: &str, with_mx: bool) -> String {
        dmarc_items(dmarc, with_mx)
            .into_iter()
            .find(|item| item.id == id)
            .unwrap_or_else(|| panic!("expected finding {id} for {dmarc}"))
            .details
    }

    #[test]
    fn enforcing_without_a_report_address_is_reported_not_passed() {
        for policy in ["reject", "quarantine"] {
            let dmarc = format!("v=DMARC1; p={policy};");

            assert_eq!(
                severity_of(&dmarc, "dmarc-no-rua", true),
                Some(AuditSeverity::Warn),
                "enforcing with no report address should warn ({policy})"
            );
            assert_eq!(
                severity_of(&dmarc, "dmarc-ok", true),
                None,
                "a domain enforcing blind is not a clean DMARC pass ({policy})"
            );

            let details = details_of(&dmarc, "dmarc-no-rua", true);
            assert!(details.contains("no aggregate reports are being sent"));
            assert!(details.contains("no way to see which mail that is"));
            assert!(details.contains(&format!("p={policy}")));
        }
    }

    #[test]
    fn monitoring_without_a_report_address_reports_only_the_reporting_half() {
        let details = details_of("v=DMARC1; p=none;", "dmarc-no-rua", true);

        assert!(details.contains("no aggregate reports are being sent"));
        assert!(!details.contains("p=none"));
    }

    #[test]
    fn a_report_address_is_required_regardless_of_apex_mx() {
        // The p=none policy finding is gated on an apex MX; the reporting
        // finding must not be.
        assert_eq!(
            severity_of("v=DMARC1; p=none;", "dmarc-no-rua", false),
            Some(AuditSeverity::Warn)
        );
        assert_eq!(severity_of("v=DMARC1; p=none;", "dmarc-ok", false), None);
    }

    #[test]
    fn a_policy_with_a_report_address_still_passes() {
        let dmarc = "v=DMARC1; p=reject; rua=mailto:dmarc@example.com";

        assert_eq!(severity_of(dmarc, "dmarc-no-rua", true), None);
        assert_eq!(
            severity_of(dmarc, "dmarc-ok", true),
            Some(AuditSeverity::Pass)
        );
    }

    #[test]
    fn an_empty_rua_value_counts_as_no_report_address() {
        assert_eq!(
            severity_of("v=DMARC1; p=reject; rua=", "dmarc-no-rua", true),
            Some(AuditSeverity::Warn)
        );
        assert_eq!(
            severity_of("v=DMARC1; p=reject; rua=   ", "dmarc-no-rua", true),
            Some(AuditSeverity::Warn)
        );
    }

    #[test]
    fn a_quoted_dmarc_record_is_read_the_same_way() {
        assert_eq!(
            severity_of("\"v=DMARC1; p=reject;\"", "dmarc-no-rua", true),
            Some(AuditSeverity::Warn)
        );
    }

    #[test]
    fn the_policy_none_finding_no_longer_talks_about_reports() {
        let details = details_of("v=DMARC1; p=none;", "dmarc-policy-none", true);

        assert!(!details.contains("rua"));
        assert!(!details.to_lowercase().contains("report"));
        assert!(details.contains("Only quarantine and reject ask receivers to act"));
    }

    #[test]
    fn a_record_missing_p_is_reported_for_the_policy_not_the_reporting() {
        assert_eq!(
            severity_of("v=DMARC1;", "dmarc-missing-policy", true),
            Some(AuditSeverity::Fail)
        );
        assert_eq!(severity_of("v=DMARC1;", "dmarc-no-rua", true), None);
    }

    #[test]
    fn policy_findings_are_not_gated_on_receiving_mail() {
        // DMARC governs what receivers do with mail *claiming* to be from the
        // domain. Whether the domain *accepts* mail is a separate question,
        // and parked or web-only domains are attractive spoofing targets
        // precisely because nobody is watching them.
        let dmarc = "v=DMARC1; p=none; rua=mailto:dmarc@example.com";

        assert_eq!(
            severity_of(dmarc, "dmarc-policy-none", false),
            Some(AuditSeverity::Warn)
        );
        assert_eq!(severity_of(dmarc, "dmarc-ok", false), None);
        assert_eq!(
            severity_of(dmarc, "dmarc-policy-none", true),
            Some(AuditSeverity::Warn)
        );
    }

    #[test]
    fn an_enforcing_policy_without_an_apex_mx_still_passes() {
        // Removing the MX gate must not turn every no-MX domain into a finding.
        let dmarc = "v=DMARC1; p=reject; rua=mailto:dmarc@example.com";

        assert_eq!(severity_of(dmarc, "dmarc-policy-none", false), None);
        assert_eq!(
            severity_of(dmarc, "dmarc-ok", false),
            Some(AuditSeverity::Pass)
        );
    }

    // ── Checks TypeScript had and this crate did not ────────────────────────
    //
    // Found by `test/domain-audit-parity.test.ts`, which pins every `details`
    // literal in this file against `src/lib/audit/domain-audit.ts`. Each of the
    // three strings below existed only in TypeScript, so this crate could never
    // report the condition at all.

    fn hygiene_details(records: Vec<DNSRecord>, id: &str) -> String {
        let items = run_domain_audit(ZONE, &records, &options(false, false, true));
        finding(&items, id).details.clone()
    }

    #[test]
    fn a_ten_digit_soa_serial_with_an_impossible_date_is_reported() {
        // 2024130101 is ten digits, so it reads as YYYYMMDDnn, but there is no
        // thirteenth month. TypeScript reported this; this crate did not.
        let details = hygiene_details(
            vec![record(
                "SOA",
                ZONE,
                "ns.example.com. hostmaster.example.com. 2024130101 7200 700 604800 3600",
            )],
            "soa-review",
        );

        assert!(
            details.contains("SOA serial looks like YYYYMMDDnn but the date part is unusual."),
            "got: {details}"
        );
    }

    #[test]
    fn a_plausible_ten_digit_soa_serial_is_not_reported() {
        let details = hygiene_details(
            vec![record(
                "SOA",
                ZONE,
                "ns.example.com. hostmaster.example.com. 2024013101 7200 700 604800 3600",
            )],
            "soa-review",
        );

        assert!(
            !details.contains("the date part is unusual"),
            "got: {details}"
        );
    }

    #[test]
    fn non_numeric_soa_timers_are_reported() {
        // `parse().ok()` turned an unparseable timer into `None`, and every
        // timer check is guarded by `if let Some(..)`, so a non-numeric timer
        // silently skipped every check instead of being reported.
        let details = hygiene_details(
            vec![record(
                "SOA",
                ZONE,
                "ns.example.com. hostmaster.example.com. 2024010101 abc 700 604800 3600",
            )],
            "soa-review",
        );

        assert!(
            details.contains("SOA timers must be numeric."),
            "got: {details}"
        );
    }

    #[test]
    fn numeric_soa_timers_are_not_reported_as_non_numeric() {
        let details = hygiene_details(
            vec![record(
                "SOA",
                ZONE,
                "ns.example.com. hostmaster.example.com. 2024010101 7200 700 604800 3600",
            )],
            "soa-review",
        );

        assert!(!details.contains("must be numeric"), "got: {details}");
    }

    #[test]
    fn an_srv_port_above_the_u16_range_is_reported_as_out_of_range() {
        // `parse_srv` returns `Option<u16>`, so it cannot represent 70000 and
        // returns `None` — the same answer it gives for a missing field. This
        // crate therefore blamed the content layout; TypeScript, whose
        // `Number()` has no such limit, named the port.
        let details = hygiene_details(
            vec![record(
                "SRV",
                "_sip._tcp.example.com",
                "10 5 70000 sip.example.com",
            )],
            "srv-review",
        );

        assert!(
            details.contains("SRV _sip._tcp.example.com: port out of range."),
            "got: {details}"
        );
        assert!(
            !details.contains("content should be"),
            "the layout is fine; only the port is wrong: {details}"
        );
    }

    #[test]
    fn an_srv_record_with_too_few_fields_still_blames_the_layout() {
        // The out-of-range branch must not swallow the genuine layout error.
        let details = hygiene_details(
            vec![record("SRV", "_sip._tcp.example.com", "10 5 5060")],
            "srv-review",
        );

        assert!(details.contains("content should be"), "got: {details}");
        assert!(!details.contains("port out of range"), "got: {details}");
    }

    #[test]
    fn an_in_range_srv_port_is_not_reported() {
        let details = hygiene_details(
            vec![record(
                "SRV",
                "_sip._tcp.example.com",
                "10 5 5060 sip.example.com",
            )],
            "srv-review",
        );

        assert!(!details.contains("port out of range"), "got: {details}");
    }

    // ── Configuration ───────────────────────────────────────────────────────
    //
    // Three mechanisms, and one property that matters more than any of them:
    // an absent or empty config must produce exactly the findings this audit
    // produced before it was configurable. Every default below is checked
    // twice — once as a value in the spec table, and once as the text a user
    // actually reads, written out here rather than derived from the table, so
    // that a default and the sentence describing it cannot drift together.

    fn record_with_ttl(record_type: &str, name: &str, content: &str, ttl: u32) -> DNSRecord {
        let mut r = record(record_type, name, content);
        r.ttl = Some(ttl);
        r
    }

    fn thresholds(pairs: &[(&str, f64)]) -> HashMap<String, f64> {
        pairs
            .iter()
            .map(|(key, value)| ((*key).to_string(), *value))
            .collect()
    }

    fn checks(pairs: &[(&str, AuditCheckSettings)]) -> HashMap<String, AuditCheckSettings> {
        pairs
            .iter()
            .map(|(id, settings)| ((*id).to_string(), settings.clone()))
            .collect()
    }

    fn disabled() -> AuditCheckSettings {
        AuditCheckSettings {
            enabled: Some(false),
            severity: None,
        }
    }

    fn reported_at(severity: AuditSeverity) -> AuditCheckSettings {
        AuditCheckSettings {
            enabled: None,
            severity: Some(severity),
        }
    }

    /// A hygiene-only audit with some thresholds overridden.
    fn hygiene_thresholds(pairs: &[(&str, f64)]) -> AuditOptions {
        AuditOptions {
            thresholds: thresholds(pairs),
            ..options(false, false, true)
        }
    }

    fn maybe_finding<'a>(items: &'a [AuditItem], id: &str) -> Option<&'a AuditItem> {
        items.iter().find(|item| item.id == id)
    }

    /// Everything a reader of one finding can see, in one comparable line.
    fn snapshot(items: &[AuditItem]) -> Vec<String> {
        items
            .iter()
            .map(|item| {
                format!(
                    "{}|{}|{}|{}|{}",
                    item.id,
                    item.category.as_str(),
                    item.severity.as_str(),
                    item.title,
                    item.details
                )
            })
            .chain(items.iter().filter_map(|item| {
                item.suggestion.as_ref().map(|s| {
                    format!(
                        "{}|suggests|{}|{}|{}",
                        item.id, s.record_type, s.name, s.content
                    )
                })
            }))
            .collect()
    }

    /// A zone that reaches as many checks at once as can be compared exactly.
    ///
    /// Findings whose `details` list several lines gathered out of a `HashMap`
    /// — the CNAME conflict list with more than one offending name, TXT sprawl
    /// with more than one — are deliberately not triggered here: their line
    /// order is whatever the map iterates in, so they cannot be pinned by
    /// equality. One conflicting name with one other record type is stable.
    fn configurable_zone() -> Vec<DNSRecord> {
        vec![
            mx("mail1.example.com", 10),
            mx("mail2.example.com", 10),
            record("A", "mail1.example.com", "1.1.1.1"),
            record("A", ZONE, "192.0.2.5"),
            record("NS", ZONE, "ns1.example.com"),
            record("CAA", ZONE, "0 issue \"letsencrypt.org\""),
            record("TXT", ZONE, "v=spf1 include:_spf.example.net mx ~all"),
            record("TXT", "_dmarc.example.com", "v=DMARC1; p=none;"),
            record(
                "SOA",
                ZONE,
                "ns.example.com. hostmaster.example.com. 2024010101 7200 700 604800 3600",
            ),
            record("CNAME", "a.example.com", "b.example.com"),
            record("CNAME", "b.example.com", "c.example.com"),
            record("CNAME", "alias.example.com", "elsewhere.example.net"),
            record("A", "alias.example.com", "198.51.100.7"),
            record_with_ttl("A", "slow.example.com", "203.0.113.9", 100_000),
            record("SRV", "_sip._tcp.example.com", "10 5 5060 sip.example.com"),
        ]
    }

    #[test]
    fn an_absent_config_runs_the_audit_this_app_has_always_run() {
        let records = configurable_zone();
        let baseline = snapshot(&run_domain_audit(ZONE, &records, &AuditOptions::default()));

        // Every shape a stored config can arrive in that asks for no change:
        // the categories spelled out, every threshold set to its own default,
        // a check entry that says nothing, and entries this build has never
        // heard of.
        let every_default: Vec<(&str, f64)> = AUDIT_THRESHOLDS
            .iter()
            .map(|spec| (spec.key, f64::from(spec.default)))
            .collect();
        let no_op_configs = [
            options(true, true, true),
            AuditOptions {
                thresholds: thresholds(&every_default),
                ..Default::default()
            },
            AuditOptions {
                checks: checks(&[("caa-analysis", AuditCheckSettings::default())]),
                ..Default::default()
            },
            AuditOptions {
                checks: checks(&[("no-such-check", disabled())]),
                thresholds: thresholds(&[("noSuchThreshold", 1.0)]),
                ..Default::default()
            },
            AuditOptions {
                // Out of range in both directions, and not a number at all.
                thresholds: thresholds(&[
                    ("nsMinimumAtApex", 1.0),
                    ("ttlHighAboveSeconds", 99_999_999.0),
                    ("cnameChainWarnHops", f64::NAN),
                ]),
                ..Default::default()
            },
        ];

        for (index, config) in no_op_configs.iter().enumerate() {
            assert_eq!(
                snapshot(&run_domain_audit(ZONE, &records, config)),
                baseline,
                "config {index} asked for no change but got one"
            );
        }
    }

    /// The sentences the shipped defaults render, written out rather than built
    /// from the table. Every one of these numbers used to be a literal in the
    /// line beside it; this is what pins that the move to a threshold did not
    /// change a word of what a user reads.
    #[test]
    fn the_default_bands_render_the_text_they_always_rendered() {
        let records = vec![
            record_with_ttl("A", "fast.example.com", "198.51.100.1", 15),
            record_with_ttl("NS", ZONE, "ns1.example.com", 120),
            record_with_ttl(
                "SOA",
                ZONE,
                "ns.example.com. hostmaster.example.com. 2024010101 7200 700 604800 3600",
                1800,
            ),
        ];
        let items = run_domain_audit(ZONE, &records, &options(false, false, true));

        let critical = &finding(&items, "ttl-critical").details;
        assert!(
            critical.contains(
                "A fast.example.com: TTL 15s is dangerously low (<30s should only be temporary)"
            ),
            "got: {critical}"
        );
        assert!(
            critical.contains("TTL <30s should only be used temporarily before DNS changes."),
            "got: {critical}"
        );

        let hygiene = &finding(&items, "ttl-hygiene").details;
        assert!(
            hygiene.contains("NS example.com: TTL 120s is low (often 300+)."),
            "got: {hygiene}"
        );
        assert!(
            hygiene.contains("SOA example.com: TTL 1800s is low (often 3600+)."),
            "got: {hygiene}"
        );

        assert_eq!(
            finding(&items, "ns-single").details.lines().next(),
            Some("Best practice requires ≥2 authoritative name servers for redundancy.")
        );
        assert_eq!(
            finding(&items, "ns-single").title,
            "Single NS record at apex"
        );

        let chains = run_domain_audit(
            ZONE,
            &[
                record("CNAME", "a.example.com", "b.example.com"),
                record("CNAME", "b.example.com", "c.example.com"),
                record("CNAME", "c.example.com", "d.example.com"),
            ],
            &options(false, false, true),
        );
        assert!(
            finding(&chains, "cname-chains-warn")
                .details
                .contains("CNAME chain is 3 hops (best practice ≤2)"),
            "got: {}",
            finding(&chains, "cname-chains-warn").details
        );
        assert_eq!(
            finding(&items, "cname-chains").details,
            "No excessive CNAME chains detected (all ≤2 hops)."
        );
    }

    #[test]
    fn the_default_expiry_bands_render_the_text_they_always_rendered() {
        let soon = (chrono::Utc::now() + chrono::Duration::days(7)).to_rfc3339();
        let items = run_domain_audit(
            ZONE,
            &[],
            &AuditOptions {
                domain_expires_at: Some(soon),
                ..options(false, false, true)
            },
        );

        assert_eq!(
            finding(&items, "domain-expiry").title,
            "Domain expiry critical (<15 days)"
        );
        assert_eq!(
            finding(&items, "domain-expiry").severity,
            AuditSeverity::Fail
        );
    }

    // ── Per-check enable / disable ──────────────────────────────────────────

    #[test]
    fn a_check_switched_off_is_the_only_finding_that_disappears() {
        let records = configurable_zone();
        let baseline = snapshot(&run_domain_audit(ZONE, &records, &AuditOptions::default()));
        let without_caa = snapshot(&run_domain_audit(
            ZONE,
            &records,
            &AuditOptions {
                checks: checks(&[("caa-analysis", disabled())]),
                ..Default::default()
            },
        ));

        let expected: Vec<String> = baseline
            .iter()
            .filter(|line| !line.starts_with("caa-analysis|"))
            .cloned()
            .collect();
        assert!(
            expected.len() < baseline.len(),
            "the fixture must emit caa-analysis for this to mean anything"
        );
        assert_eq!(without_caa, expected);
    }

    #[test]
    fn switching_off_one_variant_leaves_its_siblings_reporting() {
        // `cname-chains-warn` and `cname-chains-fail` are separate ids, so they
        // configure separately — the unit is the finding, not the subject.
        let records = vec![
            record("CNAME", "a.example.com", "b.example.com"),
            record("CNAME", "b.example.com", "c.example.com"),
            record("CNAME", "c.example.com", "d.example.com"),
        ];
        let items = run_domain_audit(
            ZONE,
            &records,
            &AuditOptions {
                checks: checks(&[("cname-chains-warn", disabled())]),
                ..options(false, false, true)
            },
        );

        assert!(maybe_finding(&items, "cname-chains-warn").is_none());
        assert!(maybe_finding(&items, "cname-chains").is_none());
        assert_eq!(
            maybe_finding(&items, "soa-missing").map(|item| item.severity),
            Some(AuditSeverity::Info),
            "an unrelated finding must survive"
        );
    }

    #[test]
    fn an_explicitly_enabled_check_still_reports() {
        let items = run_domain_audit(
            ZONE,
            &configurable_zone(),
            &AuditOptions {
                checks: checks(&[(
                    "caa-analysis",
                    AuditCheckSettings {
                        enabled: Some(true),
                        severity: None,
                    },
                )]),
                ..Default::default()
            },
        );

        assert!(maybe_finding(&items, "caa-analysis").is_some());
    }

    // ── Per-check severity override ─────────────────────────────────────────

    #[test]
    fn a_finding_can_be_reported_at_a_lower_severity() {
        let items = run_domain_audit(
            ZONE,
            &configurable_zone(),
            &AuditOptions {
                checks: checks(&[("caa-analysis", reported_at(AuditSeverity::Info))]),
                ..Default::default()
            },
        );

        assert_eq!(
            finding(&items, "caa-analysis").severity,
            AuditSeverity::Info
        );
    }

    #[test]
    fn a_finding_can_be_reported_at_a_higher_severity() {
        let items = run_domain_audit(
            ZONE,
            &configurable_zone(),
            &AuditOptions {
                checks: checks(&[("caa-analysis", reported_at(AuditSeverity::Fail))]),
                ..Default::default()
            },
        );

        assert_eq!(
            finding(&items, "caa-analysis").severity,
            AuditSeverity::Fail
        );
    }

    #[test]
    fn an_overridden_finding_says_exactly_what_it_said_before() {
        // Only the severity moves. The explanation still applies, the
        // suggestion survives, and the UI's own per-zone override marker —
        // which it recovers out of `details` — is not written here.
        let records = configurable_zone();
        let before = finding(
            &run_domain_audit(ZONE, &records, &AuditOptions::default()),
            "caa-analysis",
        )
        .clone();
        let items = run_domain_audit(
            ZONE,
            &records,
            &AuditOptions {
                checks: checks(&[("caa-analysis", reported_at(AuditSeverity::Info))]),
                ..Default::default()
            },
        );
        let after = finding(&items, "caa-analysis");

        assert_eq!(before.severity, AuditSeverity::Warn);
        assert_eq!(after.severity, AuditSeverity::Info);
        assert_eq!(after.title, before.title);
        assert_eq!(after.details, before.details);
        assert!(!after.details.contains("Original severity:"));
        assert_eq!(
            after.suggestion.as_ref().map(|s| s.content.clone()),
            before.suggestion.as_ref().map(|s| s.content.clone())
        );
    }

    #[test]
    fn a_passing_finding_is_never_promoted_by_an_override() {
        // A healthy check has nothing to report, so an override asking for
        // `fail` must not invent a failure — and must not attach the
        // explanation a real failure would carry.
        let items = run_domain_audit(
            ZONE,
            &[
                record("CAA", ZONE, "0 issue \"letsencrypt.org\""),
                record("CAA", ZONE, "0 iodef \"mailto:security@example.com\""),
            ],
            &AuditOptions {
                checks: checks(&[("caa-analysis", reported_at(AuditSeverity::Fail))]),
                ..options(false, true, false)
            },
        );
        let caa = finding(&items, "caa-analysis");

        assert_eq!(caa.severity, AuditSeverity::Pass);
        assert_eq!(caa.details, "CAA present and looks reasonable.");
    }

    #[test]
    fn pass_is_not_an_accepted_override() {
        // Forcing `pass` would leave a live problem labelled healthy, with the
        // text describing it hidden behind the UI's "show passed" filter.
        // Silencing a check is `enabled: false`, which removes the finding.
        let items = run_domain_audit(
            ZONE,
            &configurable_zone(),
            &AuditOptions {
                checks: checks(&[("caa-analysis", reported_at(AuditSeverity::Pass))]),
                ..Default::default()
            },
        );

        assert_eq!(
            finding(&items, "caa-analysis").severity,
            AuditSeverity::Warn
        );
    }

    // ── Thresholds: each one reaches the check it belongs to ────────────────

    #[test]
    fn every_threshold_spec_is_read_by_the_resolver() {
        // A key in the table that nothing resolves is a setting the UI would
        // offer and the audit would ignore.
        for spec in AUDIT_THRESHOLDS {
            assert!(
                spec.min <= spec.default && spec.default <= spec.max,
                "{}: default {} is outside its own bounds {}..={}",
                spec.key,
                spec.default,
                spec.min,
                spec.max
            );
            assert!(
                spec.min < spec.max,
                "{}: bounds leave nothing to configure",
                spec.key
            );

            let at_min = AuditThresholds::resolve(&thresholds(&[(spec.key, f64::from(spec.min))]));
            let at_max = AuditThresholds::resolve(&thresholds(&[(spec.key, f64::from(spec.max))]));
            assert_ne!(
                at_min, at_max,
                "{} is in the table but no resolved field reads it",
                spec.key
            );
        }
    }

    #[test]
    fn the_expiry_bands_follow_their_thresholds() {
        let in_twenty_days = (chrono::Utc::now() + chrono::Duration::days(20)).to_rfc3339();
        let audit = |pairs: &[(&str, f64)]| {
            let items = run_domain_audit(
                ZONE,
                &[],
                &AuditOptions {
                    domain_expires_at: Some(in_twenty_days.clone()),
                    thresholds: thresholds(pairs),
                    ..options(false, false, true)
                },
            );
            finding(&items, "domain-expiry").severity
        };

        assert_eq!(audit(&[]), AuditSeverity::Warn);
        assert_eq!(
            audit(&[("domainExpiryCriticalDays", 30.0)]),
            AuditSeverity::Fail
        );
        assert_eq!(
            audit(&[("domainExpiryWarnDays", 10.0)]),
            AuditSeverity::Pass
        );
    }

    #[test]
    fn the_ttl_bands_follow_their_thresholds() {
        let ttl_finding = |ttl: u32, record_type: &str, pairs: &[(&str, f64)], id: &str| {
            let items = run_domain_audit(
                ZONE,
                &[record_with_ttl(
                    record_type,
                    "host.example.com",
                    "1.1.1.1",
                    ttl,
                )],
                &hygiene_thresholds(pairs),
            );
            maybe_finding(&items, id).map(|item| item.details.clone())
        };

        // Critical: 45s is an outlier by default, a failure at a raised floor.
        assert!(ttl_finding(45, "A", &[], "ttl-critical").is_none());
        assert!(ttl_finding(
            45,
            "A",
            &[("ttlCriticalBelowSeconds", 60.0)],
            "ttl-critical"
        )
        .is_some_and(|details| details.contains("(<60s should only be temporary)")));

        // Low, high, and the two record-type-specific floors.
        assert!(ttl_finding(90, "A", &[], "ttl-hygiene")
            .is_some_and(|details| details.contains("No obvious TTL outliers")));
        assert!(
            ttl_finding(90, "A", &[("ttlLowBelowSeconds", 120.0)], "ttl-hygiene")
                .is_some_and(|details| details.contains("TTL 90s is very low"))
        );
        assert!(ttl_finding(
            100_000,
            "A",
            &[("ttlHighAboveSeconds", 200_000.0)],
            "ttl-hygiene"
        )
        .is_some_and(|details| details.contains("No obvious TTL outliers")));
        assert!(ttl_finding(100_000, "A", &[], "ttl-hygiene")
            .is_some_and(|details| details.contains("is very high")));
        assert!(ttl_finding(
            400,
            "NS",
            &[("ttlDelegationLowBelowSeconds", 600.0)],
            "ttl-hygiene"
        )
        .is_some_and(|details| details.contains("TTL 400s is low (often 600+).")));
        assert!(ttl_finding(
            1800,
            "SOA",
            &[("ttlSoaLowBelowSeconds", 900.0)],
            "ttl-hygiene"
        )
        .is_some_and(|details| details.contains("No obvious TTL outliers")));
    }

    #[test]
    fn the_cname_chain_bands_follow_their_thresholds() {
        let records = vec![
            record("CNAME", "a.example.com", "b.example.com"),
            record("CNAME", "b.example.com", "c.example.com"),
        ];
        let at = |pairs: &[(&str, f64)]| {
            let items = run_domain_audit(ZONE, &records, &hygiene_thresholds(pairs));
            ["cname-chains", "cname-chains-warn", "cname-chains-fail"]
                .iter()
                .filter_map(|id| maybe_finding(&items, id).map(|item| item.id.clone()))
                .collect::<Vec<_>>()
        };

        assert_eq!(at(&[]), vec!["cname-chains"]);
        assert_eq!(
            at(&[("cnameChainWarnHops", 2.0)]),
            vec!["cname-chains-warn"]
        );
        assert_eq!(
            at(&[("cnameChainWarnHops", 2.0), ("cnameChainFailHops", 2.0)]),
            vec!["cname-chains-fail"]
        );

        let warned = run_domain_audit(
            ZONE,
            &records,
            &hygiene_thresholds(&[("cnameChainWarnHops", 2.0)]),
        );
        assert!(
            finding(&warned, "cname-chains-warn")
                .details
                .contains("(best practice ≤1)"),
            "the advice has to follow the threshold it came from: {}",
            finding(&warned, "cname-chains-warn").details
        );
    }

    #[test]
    fn the_txt_sprawl_limit_follows_its_threshold() {
        let records: Vec<DNSRecord> = (0..4)
            .map(|n| record("TXT", "many.example.com", &format!("note-{n}")))
            .collect();

        let items = run_domain_audit(ZONE, &records, &hygiene_thresholds(&[]));
        assert!(maybe_finding(&items, "txt-sprawl").is_none());

        let tightened = run_domain_audit(
            ZONE,
            &records,
            &hygiene_thresholds(&[("txtRecordsPerNameLimit", 3.0)]),
        );
        assert!(finding(&tightened, "txt-sprawl")
            .details
            .contains("many.example.com: 4 TXT records"));
    }

    #[test]
    fn the_ns_minimum_follows_its_threshold() {
        let records = vec![
            record("NS", ZONE, "ns1.example.com"),
            record("NS", ZONE, "ns2.example.com"),
        ];

        let items = run_domain_audit(ZONE, &records, &hygiene_thresholds(&[]));
        assert_eq!(
            finding(&items, "ns-redundancy").severity,
            AuditSeverity::Pass
        );

        let stricter = run_domain_audit(
            ZONE,
            &records,
            &hygiene_thresholds(&[("nsMinimumAtApex", 3.0)]),
        );
        let ns = finding(&stricter, "ns-single");
        assert_eq!(ns.severity, AuditSeverity::Fail);
        assert_eq!(
            ns.title, "Too few NS records at apex",
            "with two records present, \"Single NS record at apex\" would be false"
        );
        assert!(ns
            .details
            .contains("requires ≥3 authoritative name servers"));
    }

    #[test]
    fn the_mx_and_spf_and_caa_limits_follow_their_thresholds() {
        let mail = vec![
            mx("mail1.example.com", 10),
            mx("mail2.example.com", 20),
            mx("mail3.example.com", 30),
            record("TXT", ZONE, "v=spf1 mx a -all"),
        ];
        let email = |pairs: &[(&str, f64)]| {
            run_domain_audit(
                ZONE,
                &mail,
                &AuditOptions {
                    thresholds: thresholds(pairs),
                    ..options(true, false, false)
                },
            )
        };

        assert!(maybe_finding(&email(&[]), "mx-too-many").is_none());
        assert_eq!(
            maybe_finding(&email(&[("mxManyAtApexLimit", 2.0)]), "mx-too-many")
                .map(|item| item.severity),
            Some(AuditSeverity::Warn)
        );

        assert_eq!(
            finding(&email(&[]), "spf-lookups-estimate").severity,
            AuditSeverity::Info
        );
        assert_eq!(
            finding(
                &email(&[("spfLookupWarnCount", 2.0)]),
                "spf-lookups-estimate"
            )
            .severity,
            AuditSeverity::Warn
        );

        let caa_records = vec![
            record("CAA", ZONE, "0 issue \"letsencrypt.org\""),
            record("CAA", ZONE, "0 issue \"digicert.com\""),
            record("CAA", ZONE, "0 iodef \"mailto:security@example.com\""),
        ];
        let caa = |pairs: &[(&str, f64)]| {
            let items = run_domain_audit(
                ZONE,
                &caa_records,
                &AuditOptions {
                    thresholds: thresholds(pairs),
                    ..options(false, true, false)
                },
            );
            finding(&items, "caa-analysis").clone()
        };

        assert_eq!(caa(&[]).severity, AuditSeverity::Pass);
        let tightened = caa(&[("caaIssuerLimit", 1.0)]);
        assert_eq!(tightened.severity, AuditSeverity::Warn);
        assert!(tightened.details.contains("CAA allows many issuers (2)"));
    }

    // ── Threshold resolution rules ──────────────────────────────────────────

    #[test]
    fn an_out_of_range_threshold_leaves_the_default_in_place() {
        for spec in AUDIT_THRESHOLDS {
            for value in [
                f64::from(spec.min) - 1.0,
                f64::from(spec.max) + 1.0,
                f64::NAN,
                f64::INFINITY,
                -1.0,
            ] {
                let resolved = AuditThresholds::resolve(&thresholds(&[(spec.key, value)]));
                assert_eq!(
                    resolved,
                    AuditThresholds::default(),
                    "{} accepted {value}",
                    spec.key
                );
            }
        }
    }

    #[test]
    fn a_fractional_threshold_is_truncated_rather_than_rejected() {
        // Every JSON number is a float on the TypeScript side, so `30.0` and
        // `30` arrive indistinguishably; rejecting fractions would mean the two
        // implementations disagreed about the same stored file.
        let resolved = AuditThresholds::resolve(&thresholds(&[("ttlLowBelowSeconds", 90.7)]));

        assert_eq!(resolved.ttl_low_below_seconds, 90);
    }

    // ── Reading a config a newer build wrote ────────────────────────────────

    fn parse(json: &str) -> AuditOptions {
        serde_json::from_str(json).expect("stored audit config should always parse")
    }

    #[test]
    fn a_config_from_a_newer_build_keeps_the_fields_this_one_understands() {
        let options = parse(
            r#"{
                "includeCategories": { "email": false },
                "checks": {
                    "caa-analysis": { "severity": "info" },
                    "check-from-the-future": { "enabled": false, "mood": "cross" }
                },
                "thresholds": { "nsMinimumAtApex": 4, "thresholdFromTheFuture": 7 },
                "somethingElseEntirely": [1, 2, 3]
            }"#,
        );

        assert!(!options.include_categories.email);
        assert!(options.include_categories.security, "unnamed stays on");
        assert!(options.include_categories.hygiene, "unnamed stays on");
        assert_eq!(
            options.checks["caa-analysis"].severity,
            Some(AuditSeverity::Info)
        );
        assert_eq!(options.checks["check-from-the-future"].enabled, Some(false));
        assert_eq!(
            AuditThresholds::resolve(&options.thresholds).ns_minimum_at_apex,
            4
        );
    }

    #[test]
    fn values_of_the_wrong_shape_are_ignored_rather_than_fatal() {
        // None of these may fail the parse: one unreadable field would discard
        // every other choice the user had stored.
        let options = parse(
            r#"{
                "includeCategories": { "email": "yes", "security": null, "hygiene": false },
                "checks": { "caa-analysis": { "enabled": "maybe", "severity": "catastrophic" } },
                "thresholds": { "nsMinimumAtApex": "four", "cnameChainWarnHops": null },
                "domainExpiresAt": 1757
            }"#,
        );

        assert!(options.include_categories.email, "not false, so it runs");
        assert!(options.include_categories.security, "not false, so it runs");
        assert!(!options.include_categories.hygiene);
        assert_eq!(options.checks["caa-analysis"].enabled, None);
        assert_eq!(options.checks["caa-analysis"].severity, None);
        assert_eq!(
            AuditThresholds::resolve(&options.thresholds),
            AuditThresholds::default()
        );
        assert_eq!(options.domain_expires_at, None);
    }

    #[test]
    fn whole_sections_of_the_wrong_shape_are_ignored() {
        let options = parse(r#"{ "includeCategories": true, "checks": [], "thresholds": "none" }"#);

        assert!(options.include_categories.email);
        assert!(options.include_categories.security);
        assert!(options.include_categories.hygiene);
        assert!(options.checks.is_empty());
        assert!(options.thresholds.is_empty());
    }

    #[test]
    fn an_empty_object_is_the_default_config() {
        let options = parse("{}");
        let records = configurable_zone();

        assert_eq!(
            snapshot(&run_domain_audit(ZONE, &records, &options)),
            snapshot(&run_domain_audit(ZONE, &records, &AuditOptions::default()))
        );
    }

    #[test]
    fn a_config_this_crate_wrote_reads_back_the_same_way() {
        let written = AuditOptions {
            checks: checks(&[
                ("caa-analysis", disabled()),
                ("ns-single", reported_at(AuditSeverity::Info)),
            ]),
            thresholds: thresholds(&[("nsMinimumAtApex", 3.0)]),
            ..Default::default()
        };

        let json = serde_json::to_string(&written).expect("options should serialize");
        let read: AuditOptions = serde_json::from_str(&json).expect("and read back");

        assert_eq!(read.checks["caa-analysis"].enabled, Some(false));
        assert_eq!(read.checks["ns-single"].severity, Some(AuditSeverity::Info));
        assert_eq!(
            AuditThresholds::resolve(&read.thresholds).ns_minimum_at_apex,
            3
        );
    }
}
