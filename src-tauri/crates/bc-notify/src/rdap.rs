//! RDAP lookup of a domain's registration data (via the rdap.org redirector).
//!
//! Two callers read the same documents for different reasons: the notification
//! service only needs the expiration date, while the MCP `dns_check_registration`
//! tool returns the operationally useful registry fields. Both go through
//! [`fetch_rdap_document`], so the hostname validation, the request timeout,
//! the redirect policy and the response-size bound are stated once here and
//! cannot drift apart later.
//!
//! Classic WHOIS (port 43) is deliberately not implemented. It is a different
//! transport from everything else in this crate, its replies are unstructured
//! per-registry prose, and following its referral chain means connecting to a
//! host named inside a response body. RDAP is the IETF replacement and carries
//! the same fields with structure; where a registry still has a WHOIS server,
//! its hostname is reported in [`RdapRegistration::whois_server`] and nothing
//! in this crate ever contacts it.

use std::time::Duration;

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use thiserror::Error;

use crate::expiry::{parse_flexible_date, parse_rdap_expiry};

pub const RDAP_BASE_URL: &str = "https://rdap.org/domain/";
pub const RDAP_TIMEOUT: Duration = Duration::from_secs(10);
pub const RDAP_MAX_BODY_BYTES: usize = 256 * 1024;
pub const RDAP_MIN_INTERVAL: Duration = Duration::from_secs(1);
/// Redirect hops followed before the chain is refused. `rdap.org` answers with
/// one redirect to the authoritative registry server, so the normal depth is 1.
pub const RDAP_MAX_REDIRECTS: usize = 5;
/// Ceilings on what a registry's answer can contribute to a caller's output.
/// The body bound alone would cap this, but these keep one hostile document
/// from turning into thousands of fields in a language model's context.
pub const RDAP_MAX_STATUSES: usize = 32;
pub const RDAP_MAX_NAMESERVERS: usize = 16;
pub const RDAP_MAX_FIELD_BYTES: usize = 255;
const RDAP_MAX_EVENTS: usize = 64;
const RDAP_MAX_ENTITIES: usize = 32;
const RDAP_MAX_VCARD_ENTRIES: usize = 64;
const MAX_HOSTNAME_LEN: usize = 253;
const MAX_LABEL_LEN: usize = 63;

#[derive(Debug, Error)]
pub enum RdapError {
    #[error("invalid domain name")]
    InvalidDomain,
    #[error("RDAP request timed out after {}s", RDAP_TIMEOUT.as_secs())]
    Timeout,
    #[error("RDAP request failed: {0}")]
    Http(String),
    #[error("RDAP returned HTTP {0}")]
    Status(u16),
    #[error("RDAP response exceeded {RDAP_MAX_BODY_BYTES} bytes")]
    TooLarge,
    #[error("RDAP response was not valid JSON: {0}")]
    Parse(String),
}

impl RdapError {
    /// 404 means "no RDAP data for this domain/TLD" — cache as unknown, do not retry eagerly.
    pub fn is_not_found(&self) -> bool {
        matches!(self, RdapError::Status(404))
    }
}

/// A hung request is as bad as a slow one for a bounded tool round, so a
/// timeout gets its own variant rather than arriving as reqwest prose.
fn describe_transport_error(error: reqwest::Error) -> RdapError {
    if error.is_timeout() {
        RdapError::Timeout
    } else {
        RdapError::Http(error.to_string())
    }
}

/// Strict hostname check: ASCII letters/digits/hyphens in 1–63 byte labels,
/// no leading/trailing hyphen, at least two labels, ≤ 253 bytes total.
///
/// Everything a URL could be steered with — `:`, `/`, `?`, `#`, `@`, `%`,
/// whitespace, control bytes, non-ASCII — fails the per-label byte test, so an
/// internationalised name has to arrive already in punycode.
pub fn is_valid_hostname(domain: &str) -> bool {
    if domain.is_empty() || domain.len() > MAX_HOSTNAME_LEN {
        return false;
    }
    let labels: Vec<&str> = domain.split('.').collect();
    if labels.len() < 2 {
        return false;
    }
    labels.iter().all(|label| {
        !label.is_empty()
            && label.len() <= MAX_LABEL_LEN
            && !label.starts_with('-')
            && !label.ends_with('-')
            && label
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b == b'-')
    })
}

/// Normalisation applied before validation: surrounding whitespace, the root
/// label's trailing dot, and ASCII case.
/// The one definition of how a domain is folded before it is looked up.
///
/// Public because a registry *link* has to agree with a registry *lookup*
/// about what counts as the same domain; `bc-ai-agent`'s link validation was
/// mirroring these three operations inline, which is one copy too many.
pub fn normalize_domain(domain: &str) -> String {
    domain.trim().trim_end_matches('.').to_ascii_lowercase()
}

/// Percent-encode one path segment, leaving only RFC 3986 unreserved bytes.
pub(crate) fn percent_encode_path_segment(segment: &str) -> String {
    const HEX: [u8; 16] = *b"0123456789ABCDEF";
    let mut encoded = String::with_capacity(segment.len());
    for byte in segment.bytes() {
        if byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'.' | b'_' | b'~') {
            encoded.push(byte as char);
        } else {
            encoded.push('%');
            encoded.push(HEX[usize::from(byte >> 4)] as char);
            encoded.push(HEX[usize::from(byte & 0x0f)] as char);
        }
    }
    encoded
}

/// Build the RDAP request URL for `domain` under `base_url` (`…/domain/`).
///
/// The domain is untrusted: it can reach here from a language model that has
/// just read a hostile DNS record. Two independent barriers stand between it
/// and the request — it must pass [`is_valid_hostname`], and whatever survives
/// that is percent-encoded into a single path segment. Either would be enough
/// on its own, which is the point: weakening one does not immediately hand an
/// attacker a request to a URL of their choosing.
pub fn rdap_domain_url(base_url: &str, domain: &str) -> Result<String, RdapError> {
    let domain = normalize_domain(domain);
    if !is_valid_hostname(&domain) {
        return Err(RdapError::InvalidDomain);
    }
    Ok(format!(
        "{base_url}{}",
        percent_encode_path_segment(&domain)
    ))
}

/// What the redirect policy does with one hop.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum RedirectDecision {
    Follow,
    /// A redirect away from HTTPS is not followed. The 3xx response is handed
    /// back instead, so the caller sees [`RdapError::Status`] rather than a
    /// request to the downgraded URL.
    StopNonHttps,
    TooDeep,
}

/// `rdap.org` is a redirector we do not control, so redirects are followed
/// deliberately and only to HTTPS, at most [`RDAP_MAX_REDIRECTS`] hops.
pub(crate) fn redirect_decision(previous_hops: usize, scheme: &str) -> RedirectDecision {
    if previous_hops > RDAP_MAX_REDIRECTS {
        RedirectDecision::TooDeep
    } else if !scheme.eq_ignore_ascii_case("https") {
        RedirectDecision::StopNonHttps
    } else {
        RedirectDecision::Follow
    }
}

/// Build the HTTP client used for RDAP: 10 s timeout, HTTPS-only redirects
/// bounded at [`RDAP_MAX_REDIRECTS`] hops.
pub fn default_client() -> reqwest::Client {
    reqwest::Client::builder()
        .timeout(RDAP_TIMEOUT)
        .redirect(reqwest::redirect::Policy::custom(
            |attempt| match redirect_decision(attempt.previous().len(), attempt.url().scheme()) {
                RedirectDecision::Follow => attempt.follow(),
                RedirectDecision::StopNonHttps => attempt.stop(),
                RedirectDecision::TooDeep => {
                    attempt.error("RDAP redirect chain exceeded its depth bound")
                }
            },
        ))
        .user_agent("better-cloudflare-notify/0.1")
        .build()
        .unwrap_or_else(|_| reqwest::Client::new())
}

/// Fetch one RDAP document, bounded in every direction: a validated and
/// percent-encoded hostname, a per-request timeout (restated here so a client
/// built without one still cannot hang a caller), and a streaming body read
/// that stops at [`RDAP_MAX_BODY_BYTES`] whether or not the registry declared
/// a length.
pub async fn fetch_rdap_document(
    client: &reqwest::Client,
    base_url: &str,
    domain: &str,
) -> Result<Value, RdapError> {
    let url = rdap_domain_url(base_url, domain)?;
    let response = client
        .get(&url)
        .header("Accept", "application/rdap+json, application/json")
        .timeout(RDAP_TIMEOUT)
        .send()
        .await
        .map_err(describe_transport_error)?;
    let status = response.status();
    if !status.is_success() {
        return Err(RdapError::Status(status.as_u16()));
    }
    if let Some(length) = response.content_length() {
        if length > RDAP_MAX_BODY_BYTES as u64 {
            return Err(RdapError::TooLarge);
        }
    }
    let mut body: Vec<u8> = Vec::new();
    let mut response = response;
    while let Some(chunk) = response.chunk().await.map_err(describe_transport_error)? {
        if body.len() + chunk.len() > RDAP_MAX_BODY_BYTES {
            return Err(RdapError::TooLarge);
        }
        body.extend_from_slice(&chunk);
    }
    serde_json::from_slice(&body).map_err(|e| RdapError::Parse(e.to_string()))
}

/// Fetch the expiry date for `domain` from the public rdap.org redirector.
pub async fn fetch_rdap_expiry(
    client: &reqwest::Client,
    domain: &str,
) -> Result<Option<DateTime<Utc>>, RdapError> {
    fetch_rdap_expiry_from(client, RDAP_BASE_URL, domain).await
}

/// Same as `fetch_rdap_expiry` with an explicit base URL (`…/domain/`).
pub async fn fetch_rdap_expiry_from(
    client: &reqwest::Client,
    base_url: &str,
    domain: &str,
) -> Result<Option<DateTime<Utc>>, RdapError> {
    let document = fetch_rdap_document(client, base_url, domain).await?;
    Ok(parse_rdap_expiry(&document))
}

/// Fetch the registry record for `domain` from the public rdap.org redirector.
pub async fn fetch_rdap_registration(
    client: &reqwest::Client,
    domain: &str,
) -> Result<RdapRegistration, RdapError> {
    fetch_rdap_registration_from(client, RDAP_BASE_URL, domain).await
}

/// Same as `fetch_rdap_registration` with an explicit base URL (`…/domain/`).
pub async fn fetch_rdap_registration_from(
    client: &reqwest::Client,
    base_url: &str,
    domain: &str,
) -> Result<RdapRegistration, RdapError> {
    let document = fetch_rdap_document(client, base_url, domain).await?;
    Ok(parse_rdap_registration(
        &normalize_domain(domain),
        &document,
    ))
}

/// The operationally useful half of an RDAP domain object.
///
/// Deliberately a projection and not a passthrough. The same response can
/// carry registrant, administrative and technical contact vCards — personal
/// names, postal addresses, email and phone numbers — plus registry notices
/// and terms-of-service prose. None of that answers "who is the registrar" or
/// "when does this expire", and all of it would land in a language model's
/// context, so the parser never reads those entities at all. The registrar's
/// abuse contact is included because it is an organisational role account
/// published for exactly this purpose.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RdapRegistration {
    /// The domain as queried, normalised (lowercase, no trailing dot).
    pub domain: String,
    /// The registry's own `ldhName`, when it is not just the queried name.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub registry_domain: Option<String>,
    /// `unicodeName`, for a punycode query that names an IDN.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub unicode_name: Option<String>,
    /// Registry object identifier (`handle`).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub handle: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub registrar: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub registrar_iana_id: Option<String>,
    /// EPP status codes verbatim (`clientTransferProhibited`, …).
    pub statuses: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub registered_at: Option<DateTime<Utc>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub expires_at: Option<DateTime<Utc>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub updated_at: Option<DateTime<Utc>>,
    pub nameservers: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub dnssec_signed: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub abuse_email: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub abuse_phone: Option<String>,
    /// `port43`: where classic WHOIS for this domain lives, if the registry
    /// says so. Reported for a human to use, never contacted.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub whois_server: Option<String>,
}

/// Project an RDAP domain object onto the fields this crate publishes.
///
/// `queried` is the normalised name that was asked for, so a caller can tell
/// which domain an answer belongs to without trusting the response for it.
pub fn parse_rdap_registration(queried: &str, document: &Value) -> RdapRegistration {
    let registrar = registrar_entity(document);
    let abuse = registrar.and_then(abuse_entity);
    RdapRegistration {
        domain: queried.to_string(),
        registry_domain: hostname_field(document, "ldhName").filter(|name| name != queried),
        unicode_name: string_field(document, "unicodeName"),
        handle: string_field(document, "handle"),
        registrar: registrar.and_then(|entity| vcard_text(entity, "fn")),
        registrar_iana_id: registrar.and_then(iana_registrar_id),
        statuses: statuses(document),
        registered_at: event_date(document, "registration"),
        // One definition of "expiry" in the crate: the notification service and
        // this projection cannot disagree about a domain's expiration date.
        expires_at: parse_rdap_expiry(document),
        updated_at: event_date(document, "last changed")
            .or_else(|| event_date(document, "last update of rdap database")),
        nameservers: nameservers(document),
        dnssec_signed: document
            .get("secureDNS")
            .and_then(|secure| secure.get("delegationSigned"))
            .and_then(Value::as_bool),
        abuse_email: abuse.and_then(|entity| vcard_text(entity, "email")),
        abuse_phone: abuse
            .and_then(|entity| vcard_text(entity, "tel"))
            .map(|tel| strip_tel_uri(&tel)),
        whois_server: hostname_field(document, "port43"),
    }
}

/// Trim, drop control characters, and cap at [`RDAP_MAX_FIELD_BYTES`]. Registry
/// text is attacker-influenceable prose heading for a model's context, so no
/// field reaches a caller unbounded or carrying terminal control bytes.
fn clean_field(value: &str) -> Option<String> {
    let filtered: String = value.chars().filter(|c| !c.is_control()).collect();
    let trimmed = filtered.trim();
    if trimmed.is_empty() {
        return None;
    }
    let mut cleaned = trimmed.to_string();
    if cleaned.len() > RDAP_MAX_FIELD_BYTES {
        let mut end = RDAP_MAX_FIELD_BYTES;
        while end > 0 && !cleaned.is_char_boundary(end) {
            end -= 1;
        }
        cleaned.truncate(end);
    }
    Some(cleaned)
}

fn string_field(document: &Value, key: &str) -> Option<String> {
    document
        .get(key)
        .and_then(Value::as_str)
        .and_then(clean_field)
}

/// A field the registry says is a host name, accepted only if it actually is
/// one. Keeps junk — and anything URL-shaped — out of the answer.
fn hostname_field(document: &Value, key: &str) -> Option<String> {
    string_field(document, key)
        .map(|value| value.trim_end_matches('.').to_ascii_lowercase())
        .filter(|value| is_valid_hostname(value))
}

/// The first `events[]` entry whose action is exactly `action`.
fn event_date(document: &Value, action: &str) -> Option<DateTime<Utc>> {
    let events = document.get("events")?.as_array()?;
    events.iter().take(RDAP_MAX_EVENTS).find_map(|event| {
        let found = event.get("eventAction").and_then(Value::as_str)?;
        if !found.trim().eq_ignore_ascii_case(action) {
            return None;
        }
        event
            .get("eventDate")
            .and_then(Value::as_str)
            .and_then(parse_flexible_date)
    })
}

fn statuses(document: &Value) -> Vec<String> {
    document
        .get("status")
        .and_then(Value::as_array)
        .map(|values| {
            values
                .iter()
                .filter_map(Value::as_str)
                .filter_map(clean_field)
                .take(RDAP_MAX_STATUSES)
                .collect()
        })
        .unwrap_or_default()
}

fn nameservers(document: &Value) -> Vec<String> {
    document
        .get("nameservers")
        .and_then(Value::as_array)
        .map(|values| {
            values
                .iter()
                .filter_map(|nameserver| hostname_field(nameserver, "ldhName"))
                .take(RDAP_MAX_NAMESERVERS)
                .collect()
        })
        .unwrap_or_default()
}

fn has_role(entity: &Value, role: &str) -> bool {
    entity
        .get("roles")
        .and_then(Value::as_array)
        .is_some_and(|roles| {
            roles
                .iter()
                .filter_map(Value::as_str)
                .any(|found| found.trim().eq_ignore_ascii_case(role))
        })
}

/// The entity whose `roles` contain "registrar". Entities in registrant,
/// administrative, technical or billing roles are never looked at, so there is
/// no path by which a contact vCard becomes part of the answer.
fn registrar_entity(document: &Value) -> Option<&Value> {
    document
        .get("entities")?
        .as_array()?
        .iter()
        .take(RDAP_MAX_ENTITIES)
        .find(|entity| has_role(entity, "registrar"))
}

/// The registrar's nested abuse-role entity.
fn abuse_entity(registrar: &Value) -> Option<&Value> {
    registrar
        .get("entities")?
        .as_array()?
        .iter()
        .take(RDAP_MAX_ENTITIES)
        .find(|entity| has_role(entity, "abuse"))
}

/// Read one property out of an entity's jCard: `["vcard", [[name, params,
/// type, value], …]]`.
fn vcard_text(entity: &Value, property: &str) -> Option<String> {
    let entries = entity.get("vcardArray")?.as_array()?.get(1)?.as_array()?;
    entries
        .iter()
        .take(RDAP_MAX_VCARD_ENTRIES)
        .find_map(|entry| {
            let entry = entry.as_array()?;
            let name = entry.first().and_then(Value::as_str)?;
            if !name.trim().eq_ignore_ascii_case(property) {
                return None;
            }
            entry.get(3).and_then(Value::as_str).and_then(clean_field)
        })
}

/// `publicIds[]` entry of type "IANA Registrar ID".
fn iana_registrar_id(registrar: &Value) -> Option<String> {
    registrar
        .get("publicIds")?
        .as_array()?
        .iter()
        .take(RDAP_MAX_ENTITIES)
        .find_map(|public_id| {
            let kind = public_id.get("type").and_then(Value::as_str)?;
            if !kind.to_ascii_lowercase().contains("iana") {
                return None;
            }
            let identifier = public_id.get("identifier")?;
            identifier
                .as_str()
                .map(str::to_string)
                .or_else(|| identifier.as_i64().map(|number| number.to_string()))
        })
        .as_deref()
        .and_then(clean_field)
}

/// vCard phone numbers arrive as a `tel:` URI; callers want the number.
fn strip_tel_uri(value: &str) -> String {
    value
        .strip_prefix("tel:")
        .or_else(|| value.strip_prefix("TEL:"))
        .unwrap_or(value)
        .trim()
        .to_string()
}
