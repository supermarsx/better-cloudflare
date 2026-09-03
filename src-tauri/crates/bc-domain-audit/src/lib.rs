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
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum AuditSeverity {
    Pass,
    Info,
    Warn,
    Fail,
}

/// Audit category.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum AuditCategory {
    Email,
    Security,
    Hygiene,
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

/// Options controlling which audit categories to run.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AuditOptions {
    #[serde(default = "default_categories")]
    pub include_categories: AuditCategories,
    #[serde(default)]
    pub domain_expires_at: Option<String>,
}

/// Which audit categories to include.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AuditCategories {
    #[serde(default = "default_true")]
    pub email: bool,
    #[serde(default = "default_true")]
    pub security: bool,
    #[serde(default = "default_true")]
    pub hygiene: bool,
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

impl Default for AuditOptions {
    fn default() -> Self {
        Self {
            include_categories: default_categories(),
            domain_expires_at: None,
        }
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
        audit_security(&mut items, records);
    }

    // ── Email checks ────────────────────────────────────────────────────

    if options.include_categories.email {
        audit_email(
            &mut items,
            records,
            normalized_zone,
            &apex,
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

    for item in &mut items {
        explain_finding(item);
    }

    items
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
    ("dmarc-missing-policy", "The p= tag is what tells receivers how to treat mail that fails your checks. A DMARC record without it is incomplete, and receivers disregard the record — including any reporting addresses set alongside it."),
    ("dmarc-policy-none", "p=none asks receivers to change nothing and only send you reports. That is the right place to start, because the reports show which of your senders would fail before enforcement can destroy their mail. On its own it does not stop anyone sending as your domain."),
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
            } else if days < 15 {
                items.push(item(
                    "domain-expiry",
                    AuditCategory::Hygiene,
                    AuditSeverity::Fail,
                    "Domain expiry critical (<15 days)",
                    format!(
                        "Expiry date: {} ({} days remaining). Renew now.",
                        full, days
                    ),
                ));
            } else if days < 30 {
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
        } else if ttl < 30 {
            ttl_critical.push(format!(
                "{} {}: TTL {}s is dangerously low (<30s should only be temporary)",
                r.r#type, r.name, ttl
            ));
        } else if ttl < 60 {
            ttl_issues.push(format!("{} {}: TTL {}s is very low", r.r#type, r.name, ttl));
        } else if r.r#type == "SOA" && ttl < 3600 {
            ttl_issues.push(format!(
                "SOA {}: TTL {}s is low (often 3600+).",
                r.name, ttl
            ));
        } else if (r.r#type == "NS" || r.r#type == "MX") && ttl < 300 {
            ttl_issues.push(format!(
                "{} {}: TTL {}s is low (often 300+).",
                r.r#type, r.name, ttl
            ));
        } else if ttl > 86400 {
            ttl_issues.push(format!(
                "{} {}: TTL {}s is very high (changes propagate slowly).",
                r.r#type, r.name, ttl
            ));
        }
    }
    if !ttl_critical.is_empty() {
        let detail = format!(
            "{}\n\nTTL <30s should only be used temporarily before DNS changes.",
            ttl_critical
                .iter()
                .take(8)
                .cloned()
                .collect::<Vec<_>>()
                .join("\n")
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
        } else if chain.hops >= 5 {
            chain_issues.push(format!(
                "{}: CNAME chain is {} hops ({})",
                r.name, chain.hops, chain_str
            ));
        } else if chain.hops >= 3 {
            chain_warnings.push(format!(
                "{}: CNAME chain is {} hops (best practice ≤2)",
                r.name, chain.hops
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
            "No excessive CNAME chains detected (all ≤2 hops).",
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
    } else if ns_at_apex.len() == 1 {
        items.push(item(
            "ns-single",
            AuditCategory::Hygiene,
            AuditSeverity::Fail,
            "Single NS record at apex",
            "Best practice requires ≥2 authoritative name servers for redundancy.",
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
        .filter(|(_, &count)| count > 5)
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
                issues.push(format!(
                    "SRV {}: content should be \"priority weight port target\".",
                    name
                ));
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

fn audit_security(items: &mut Vec<AuditItem>, records: &[DNSRecord]) {
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
        if distinct.len() > 3 {
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
        items.push(item(
            "caa-analysis",
            AuditCategory::Security,
            if issues.is_empty() {
                AuditSeverity::Pass
            } else {
                AuditSeverity::Warn
            },
            "CAA policy review",
            if issues.is_empty() {
                "CAA present and looks reasonable.".to_string()
            } else {
                issues.join("\n")
            },
        ));
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
    } else if mx_at_apex.len() > 10 {
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
            if count >= 10 {
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
        if p.is_empty() {
            items.push(item(
                "dmarc-missing-policy",
                AuditCategory::Email,
                AuditSeverity::Fail,
                "DMARC missing policy (p=)",
                "DMARC must include a p= policy tag.",
            ));
        } else if p == "none" && !mx_at_apex.is_empty() {
            items.push(item(
                "dmarc-policy-none",
                AuditCategory::Email,
                AuditSeverity::Warn,
                "DMARC policy is p=none",
                "p=none is monitoring-only. Consider moving to quarantine/reject once aligned.",
            ));
        } else {
            items.push(item(
                "dmarc-ok",
                AuditCategory::Email,
                AuditSeverity::Pass,
                "DMARC present",
                format!(
                    "DMARC is configured with p={}.",
                    if p.is_empty() { "?" } else { &p }
                ),
            ));
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
            domain_expires_at: None,
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
            record("TXT", "_dmarc.example.com", "v=DMARC1; p=reject"),
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
            ("bare", "_dmarc.example.com", "v=DMARC1; p=reject"),
            ("quoted", "_dmarc.example.com", "\"v=DMARC1; p=reject\""),
            (
                "split character-strings",
                "_dmarc.example.com",
                "\"v=DMARC1;\" \" p=reject\"",
            ),
            (
                "absolute owner name",
                "_dmarc.example.com.",
                "v=DMARC1; p=reject",
            ),
            (
                "uppercase owner name",
                "_DMARC.EXAMPLE.COM",
                "v=DMARC1; p=reject",
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
}
