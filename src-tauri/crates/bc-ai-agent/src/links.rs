//! Typed, validated links the assistant can point the user at.
//!
//! The assistant is often most useful when it can say "here" rather than
//! describe where. That means a model-written string becoming something the
//! application navigates to or opens in a browser, which is exactly the kind
//! of string that must not be taken at its word.
//!
//! So nothing reaches the renderer untyped. A link names one of six
//! [`AiLinkKind`]s, and each kind has its own closed rule:
//!
//! * `workspace` must be one of [`WORKSPACE_IDS`] — a closed set, not a
//!   pattern.
//! * `zone` is an opaque id, and `record` is two of them — `"<zoneId>/<recordId>"`,
//!   because a record id alone is not navigable. Each id is bounded in length
//!   and restricted to a charset that cannot express a path, a scheme, a
//!   separator or an escape.
//! * `zoneTab` is a zone id and one of the zone's own tabs —
//!   `"<zoneId>/<tab>"`, parsed exactly like `record`, with the tab name
//!   checked against [`ZONE_TAB_IDS`].
//! * `domainRegistry` is a hostname, validated by exactly the functions
//!   `dns_check_registration` validates its argument with —
//!   [`bc_notify::normalize_domain`] then [`bc_notify::is_valid_hostname`],
//!   both called rather than reimplemented — so a link and a lookup can
//!   never disagree about what a domain is.
//! * `external` is an absolute `https:` URL, validated by
//!   [`bc_ai_provider::validate_base_url`] — the existing Rust-side
//!   validator for "a URL this process may be pointed at" — and then
//!   narrowed to `https:` only.
//!
//! A `javascript:`, `data:` or `file:` target is therefore impossible to
//! *store*, not merely impossible to render: [`LinkStore::offer`] rejects the
//! whole offer, so there is no state in which the renderer has to decide
//! whether a link is safe.

use std::collections::HashMap;

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use serde_json::json;
use tokio::sync::RwLock;
use uuid::Uuid;

use bc_ai_provider::limits::MAX_BASE_URL_BYTES;
use bc_ai_provider::{ToolCall, ToolDefinition, ToolResult};

use crate::error::AgentError;

// ─── Bounds ────────────────────────────────────────────────────────────────

/// Links one offer may carry.
///
/// A handful of places to look is help; a list is noise, and a long list is a
/// way for a model to fill the UI. The assistant replaces its offer rather
/// than adding to it, so this bounds what is on screen as well as what is
/// retained.
pub const MAX_LINKS_PER_OFFER: usize = 8;

/// Bytes of one link's label. One line of UI.
pub const MAX_LINK_LABEL_BYTES: usize = 120;

/// Bytes of one id. Cloudflare ids are 32 hex characters; the extra room is
/// for ids this application has not met yet, not for structure.
///
/// Per id, not per target: a `record` target carries two of them plus one
/// separator, so it can be `2 * MAX_LINK_ID_BYTES + 1` bytes long.
pub const MAX_LINK_ID_BYTES: usize = 64;

/// Bytes of a `domainRegistry` target: the DNS name ceiling, which
/// [`bc_notify::is_valid_hostname`] also enforces.
pub const MAX_LINK_HOSTNAME_BYTES: usize = 253;

/// Bytes of an `external` target.
///
/// Spelled as a literal so the frontend bounds contract test can read it, and
/// pinned by the assertion below to the ceiling the reused validator applies
/// anyway — drift becomes a build failure rather than a second opinion about
/// how long a URL may be.
pub const MAX_LINK_URL_BYTES: usize = 2 * 1024;
const _: () = assert!(
    MAX_LINK_URL_BYTES == MAX_BASE_URL_BYTES,
    "MAX_LINK_URL_BYTES must stay equal to bc_ai_provider::limits::MAX_BASE_URL_BYTES"
);

/// Conversations whose offered links are retained at once. The conversation
/// ceiling, so links cannot outlive the conversations that are retained.
pub const MAX_RETAINED_LINK_OFFERS: usize = bc_ai_chat::limits::MAX_CONVERSATIONS;

/// The app's workspaces, as the renderer addresses them.
///
/// A closed set, mirroring the non-`zone` members of `TabKind` in
/// `src/components/dns/DNSManager.tsx`. `zone` is deliberately absent: a zone
/// workspace needs a zone to open, which is what [`AiLinkKind::Zone`] is for.
///
/// Spelled out here rather than derived from anything, because the whole
/// point is that a target outside this list is refused instead of being
/// passed to the renderer to puzzle over.
pub const WORKSPACE_IDS: &[&str] = &[
    "settings",
    "audit",
    "tags",
    "registry",
    "notifications",
    "assistant",
];

/// The tabs a zone workspace has, as the renderer addresses them.
///
/// A closed set, mirroring the `ActionTab` union in
/// `src/components/dns/DNSManager.tsx`. These are *not* [`WORKSPACE_IDS`] and
/// must not be folded into it: every one of them is a view *of a zone*, so
/// `"records"` on its own is not a destination. That is what
/// [`AiLinkKind::ZoneTab`] carries a zone id for.
///
/// All fifteen are addressable from a zone id alone. `zone-compare` is the
/// one worth naming: it opens for the zone with the comparison target
/// unpicked, which is how `ZoneCompare` already behaves when its
/// `defaultCompareZoneId` is absent, so it is a real destination rather than
/// a half-built one.
pub const ZONE_TAB_IDS: &[&str] = &[
    "records",
    "import",
    "zone-settings",
    "cache",
    "ssl-tls",
    "domain-audit",
    "domain-registry",
    "topology",
    "analytics",
    "firewall",
    "workers",
    "email-routing",
    "propagation",
    "zone-compare",
    "reference",
];

/// The model-facing tool that offers links.
pub const LINK_OFFER_TOOL: &str = "link_offer";

/// What the model is told every time it offers links.
const LINK_TOOL_NOTE: &str =
    "Every link is validated against the application's own idea of what each kind can point at, \
     and an offer with one bad link is refused whole rather than partly accepted. Offering links \
     navigates nowhere and opens nothing: the user decides whether to follow one.";

// ─── Types ─────────────────────────────────────────────────────────────────

/// What a link points at. The kind decides how `target` is validated, so
/// there is no "some other string" kind.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum AiLinkKind {
    /// A Cloudflare zone, by id.
    Zone,
    /// A DNS record, by zone id and record id: `"<zoneId>/<recordId>"`.
    Record,
    /// One tab of a zone workspace: `"<zoneId>/<tab>"`, where the tab is one
    /// of [`ZONE_TAB_IDS`].
    ZoneTab,
    /// A domain's registry (RDAP) record, by hostname.
    DomainRegistry,
    /// One of the application's own workspaces, by id.
    Workspace,
    /// An absolute `https:` URL, opened outside the application.
    External,
}

impl AiLinkKind {
    /// Stable name for error messages, matching the wire spelling.
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Zone => "zone",
            Self::Record => "record",
            Self::ZoneTab => "zoneTab",
            Self::DomainRegistry => "domainRegistry",
            Self::Workspace => "workspace",
            Self::External => "external",
        }
    }
}

/// A validated link. Constructed only by [`validate_link`], so holding one is
/// evidence it passed its kind's rule.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiLink {
    pub kind: AiLinkKind,
    pub label: String,
    /// The validated target: a zone id for `zone`,
    /// `"<zoneId>/<recordId>"` for `record`, `"<zoneId>/<tab>"` for
    /// `zoneTab`, a hostname for `domainRegistry`, a member of
    /// [`WORKSPACE_IDS`] for `workspace`, an `https:` URL for `external`.
    ///
    /// Normalised for `domainRegistry` (trimmed, no root dot, lower-cased)
    /// and verbatim otherwise — the other kinds pass strict enough checks
    /// that there is nothing left to normalise away.
    pub target: String,
}

/// The model-supplied form of a link.
///
/// Separate from [`AiLink`] on purpose: this is untrusted input, that is a
/// validated value, and `deny_unknown_fields` makes a link carrying anything
/// else a refused call rather than a silently trimmed one.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AiLinkInput {
    pub kind: AiLinkKind,
    pub label: String,
    pub target: String,
}

/// Arguments of [`LINK_OFFER_TOOL`].
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AiLinkOffer {
    pub links: Vec<AiLinkInput>,
}

// ─── Validation ────────────────────────────────────────────────────────────

fn invalid(field: &'static str, message: impl Into<String>) -> AgentError {
    AgentError::InvalidLink {
        field,
        message: message.into(),
    }
}

/// Reject a label that would corrupt the UI it is rendered into.
///
/// A label is one line, so no control character is legal in it — not even the
/// tab and newline plan details allow.
fn validate_label(label: &str) -> Result<(), AgentError> {
    if label.len() > MAX_LINK_LABEL_BYTES {
        return Err(invalid(
            "label",
            format!("must not exceed {MAX_LINK_LABEL_BYTES} bytes"),
        ));
    }
    if label.trim().is_empty() {
        return Err(invalid("label", "must not be blank"));
    }
    if label.chars().any(char::is_control) {
        return Err(invalid("label", "must not contain control characters"));
    }
    Ok(())
}

/// Validate one opaque in-app id.
///
/// The charset is the whole defence: with no `.`, `/`, `\`, `:`, `%`, `?`,
/// `#`, whitespace, control byte or non-ASCII character admitted, the result
/// cannot express a traversal, a scheme, a query or an escape, whatever the
/// renderer later interpolates it into.
fn validate_id(noun: &'static str, value: &str) -> Result<(), AgentError> {
    if value.is_empty() {
        return Err(invalid("target", format!("the {noun} must not be empty")));
    }
    if value.len() > MAX_LINK_ID_BYTES {
        return Err(invalid(
            "target",
            format!("the {noun} must not exceed {MAX_LINK_ID_BYTES} bytes"),
        ));
    }
    if !value
        .bytes()
        .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_')
    {
        return Err(invalid(
            "target",
            format!("the {noun} must contain only letters, digits, '-' or '_'"),
        ));
    }
    Ok(())
}

/// Split a `"<zoneId>/<rest>"` target, validating the zone half.
///
/// The shape both in-zone kinds share. Neither a record nor a zone tab is
/// navigable without its zone — the application addresses both *within* a
/// zone — so the zone id travels in the one `target`, which keeps [`AiLink`]
/// flat and keeps the renderer's own re-validation a string check rather
/// than a shape check.
///
/// Written as two segments of the *same* charset rule rather than by
/// admitting `/` into that rule. `.` is still not a legal byte, and the
/// target must be exactly two non-empty halves, so a traversal, a third
/// segment, an empty half, a scheme or a query is refused —
/// `"zone/../../admin"` fails on the segment count, and `"zone/.."` fails on
/// the charset.
fn split_zone_pair<'a>(
    target: &'a str,
    shape: &'static str,
) -> Result<(&'a str, &'a str), AgentError> {
    let mut segments = target.split('/');
    let zone = segments.next().unwrap_or_default();
    let rest = segments.next().ok_or_else(|| invalid("target", shape))?;
    if segments.next().is_some() {
        return Err(invalid("target", shape));
    }
    validate_id("zone id", zone)?;
    Ok((zone, rest))
}

/// Validate a `record` target: `"<zoneId>/<recordId>"`.
fn validate_record_target(target: &str) -> Result<(), AgentError> {
    const SHAPE: &str = "a record link's target must be \"<zoneId>/<recordId>\"";
    let (_, record) = split_zone_pair(target, SHAPE)?;
    validate_id("record id", record)
}

/// Validate a `zoneTab` target: `"<zoneId>/<tab>"`.
///
/// The tab half is checked against the closed set rather than a charset:
/// these are fixed view names, not ids, and a name outside the set is a
/// destination the application does not have.
fn validate_zone_tab_target(target: &str) -> Result<(), AgentError> {
    const SHAPE: &str = "a zoneTab link's target must be \"<zoneId>/<tab>\"";
    let (_, tab) = split_zone_pair(target, SHAPE)?;
    if ZONE_TAB_IDS.contains(&tab) {
        return Ok(());
    }
    Err(invalid(
        "target",
        format!(
            "must name one of a zone's tabs: {}",
            ZONE_TAB_IDS.join(", ")
        ),
    ))
}

/// Validate a workspace id against the closed set.
fn validate_workspace_target(target: &str) -> Result<(), AgentError> {
    if WORKSPACE_IDS.contains(&target) {
        return Ok(());
    }
    Err(invalid(
        "target",
        format!(
            "must be one of the application's workspaces: {}",
            WORKSPACE_IDS.join(", ")
        ),
    ))
}

/// Validate a registry hostname exactly as `dns_check_registration` does.
///
/// Both halves are `bc_notify`'s own and are *called*, not reimplemented:
/// [`bc_notify::normalize_domain`] and then
/// [`bc_notify::is_valid_hostname`], the same pair the RDAP request path
/// uses. Repeating the three normalisation steps inline here would be a
/// second implementation that happens to agree today, which is how two
/// definitions of "a domain" drift apart. The length test comes first, on
/// the raw string, so a huge input is rejected before any allocation.
fn validate_hostname_target(target: &str) -> Result<String, AgentError> {
    if target.len() > MAX_LINK_HOSTNAME_BYTES {
        return Err(invalid(
            "target",
            format!("a hostname must not exceed {MAX_LINK_HOSTNAME_BYTES} bytes"),
        ));
    }
    let normalized = bc_notify::normalize_domain(target);
    if !bc_notify::is_valid_hostname(&normalized) {
        return Err(invalid(
            "target",
            "must be a bare registrable hostname such as 'example.com' — no scheme, path, port, \
             query or credentials, and internationalised names must be in punycode",
        ));
    }
    Ok(normalized)
}

/// Validate an external URL.
///
/// Reuses [`bc_ai_provider::validate_base_url`], the existing
/// Rust-side validator for a URL this process may be pointed at. It rejects
/// whitespace and control characters *before* parsing — `Url::parse` strips
/// tabs and newlines, so a scheme check on the parsed result can be walked
/// past with `ht\ttps://…` — then requires an absolute URL with a host, an
/// `http`/`https` scheme, and no embedded credentials.
///
/// One rule is added rather than reimplemented: a link the user clicks is
/// `https:` only, checked against the raw string so nothing can be
/// normalised into a pass.
fn validate_external_target(target: &str) -> Result<(), AgentError> {
    const RULE: &str = "must be an absolute https:// URL with a host, no embedded credentials, \
                        and no whitespace or control characters";
    if target.len() > MAX_LINK_URL_BYTES {
        return Err(invalid(
            "target",
            format!("a URL must not exceed {MAX_LINK_URL_BYTES} bytes"),
        ));
    }
    // The provider error names its own field, which would be nonsense here,
    // so the rule is restated rather than relayed.
    bc_ai_provider::validate_base_url(target).map_err(|_| invalid("target", RULE))?;
    if !target.starts_with("https://") {
        return Err(invalid("target", RULE));
    }
    Ok(())
}

/// Validate one model-supplied link.
pub fn validate_link(input: AiLinkInput) -> Result<AiLink, AgentError> {
    validate_label(&input.label)?;
    let target = match input.kind {
        AiLinkKind::Zone => {
            validate_id("zone id", &input.target)?;
            input.target
        }
        AiLinkKind::Record => {
            validate_record_target(&input.target)?;
            input.target
        }
        AiLinkKind::ZoneTab => {
            validate_zone_tab_target(&input.target)?;
            input.target
        }
        AiLinkKind::Workspace => {
            validate_workspace_target(&input.target)?;
            input.target
        }
        AiLinkKind::DomainRegistry => validate_hostname_target(&input.target)?,
        AiLinkKind::External => {
            validate_external_target(&input.target)?;
            input.target
        }
    };
    Ok(AiLink {
        kind: input.kind,
        label: input.label,
        target,
    })
}

/// Validate a whole offer.
///
/// All or nothing: one bad link refuses the offer. A partly-accepted offer
/// would leave the model believing it had pointed at something it had not,
/// and would leave the user with a list that silently lost an entry.
pub fn validate_links(inputs: Vec<AiLinkInput>) -> Result<Vec<AiLink>, AgentError> {
    if inputs.is_empty() {
        return Err(invalid("links", "an offer must contain at least one link"));
    }
    if inputs.len() > MAX_LINKS_PER_OFFER {
        return Err(invalid(
            "links",
            format!("at most {MAX_LINKS_PER_OFFER} links may be offered at once"),
        ));
    }
    inputs.into_iter().map(validate_link).collect()
}

// ─── Store ─────────────────────────────────────────────────────────────────

#[derive(Debug, Clone)]
struct LinkOffer {
    links: Vec<AiLink>,
    updated_at: DateTime<Utc>,
}

/// Bounded store of the links the assistant is currently pointing at, keyed
/// by conversation.
///
/// Offers replace rather than accumulate. An accumulating list would grow
/// retained state at the model's discretion and would keep showing links to
/// things the conversation has moved on from.
#[derive(Default)]
pub struct LinkStore {
    offers: RwLock<HashMap<Uuid, LinkOffer>>,
}

impl LinkStore {
    /// The links currently offered for a conversation. Empty when none are.
    pub async fn get(&self, conversation_id: Uuid) -> Vec<AiLink> {
        self.offers
            .read()
            .await
            .get(&conversation_id)
            .map(|offer| offer.links.clone())
            .unwrap_or_default()
    }

    /// Validate and store an offer, replacing any previous one.
    pub async fn offer(
        &self,
        conversation_id: Uuid,
        inputs: Vec<AiLinkInput>,
    ) -> Result<Vec<AiLink>, AgentError> {
        // Validation first, outside the lock: a refused offer must not
        // disturb what is already stored.
        let links = validate_links(inputs)?;
        let mut offers = self.offers.write().await;
        offers.insert(
            conversation_id,
            LinkOffer {
                links: links.clone(),
                updated_at: Utc::now(),
            },
        );
        evict_oldest_offers(&mut offers, conversation_id);
        Ok(links)
    }

    /// Drop a conversation's links. Returns whether there were any.
    pub async fn delete(&self, conversation_id: Uuid) -> bool {
        self.offers.write().await.remove(&conversation_id).is_some()
    }

    #[cfg(test)]
    async fn count(&self) -> usize {
        self.offers.read().await.len()
    }
}

/// Evict the least recently updated offers, never the one just written.
fn evict_oldest_offers(offers: &mut HashMap<Uuid, LinkOffer>, keep: Uuid) {
    while offers.len() > MAX_RETAINED_LINK_OFFERS {
        let Some(oldest) = offers
            .iter()
            .filter(|(conversation_id, _)| **conversation_id != keep)
            .min_by_key(|(conversation_id, offer)| (offer.updated_at, **conversation_id))
            .map(|(conversation_id, _)| *conversation_id)
        else {
            break;
        };
        offers.remove(&oldest);
    }
}

// ─── The model-facing offer tool ───────────────────────────────────────────

/// Whether a tool name is the assistant's own link tool.
pub fn is_link_tool(name: &str) -> bool {
    name == LINK_OFFER_TOOL
}

/// The link tool, as offered to the model.
pub fn tool_definitions() -> Vec<ToolDefinition> {
    vec![ToolDefinition {
        name: LINK_OFFER_TOOL.to_string(),
        description: format!(
            "Offer the user up to {MAX_LINKS_PER_OFFER} places to look, replacing any links you \
             offered earlier in this conversation. Use it to point at the zone, record, domain \
             registry entry, application workspace or web page you have been talking about, \
             instead of describing where it is. {LINK_TOOL_NOTE}"
        ),
        input_schema: json!({
            "type": "object",
            "properties": {
                "links": {
                    "type": "array",
                    "minItems": 1,
                    "maxItems": MAX_LINKS_PER_OFFER,
                    "items": {
                        "type": "object",
                        "properties": {
                            "kind": {
                                "type": "string",
                                "enum": ["zone", "record", "zoneTab", "domainRegistry", "workspace", "external"],
                                "description": "What the link points at, which decides how `target` is read."
                            },
                            "label": {
                                "type": "string",
                                "maxLength": MAX_LINK_LABEL_BYTES,
                                "description": "One line naming the destination, as the user should see it."
                            },
                            "target": {
                                "type": "string",
                                "description": "For `zone`, the zone id. For `record`, the zone id and record id joined by one slash, as \"zoneId/recordId\" — a record id alone cannot be opened. For `zoneTab`, the zone id and one of its tabs joined by one slash, as \"zoneId/zone-settings\"; the tabs are records, import, zone-settings, cache, ssl-tls, domain-audit, domain-registry, topology, analytics, firewall, workers, email-routing, propagation, zone-compare, reference. Ids use letters, digits, '-' and '_' only. For `domainRegistry`, a bare hostname in punycode. For `workspace`, one of: settings, audit, tags, registry, notifications, assistant. For `external`, an absolute https:// URL with no credentials."
                            }
                        },
                        "required": ["kind", "label", "target"],
                        "additionalProperties": false
                    }
                }
            },
            "required": ["links"],
            "additionalProperties": false
        }),
    }]
}

/// What the model is told about an accepted offer.
fn link_tool_report(links: &[AiLink]) -> String {
    json!({
        "offered": links.len(),
        "links": links.iter().map(|link| json!({
            "kind": link.kind,
            "target": link.target,
        })).collect::<Vec<_>>(),
        "note": LINK_TOOL_NOTE,
    })
    .to_string()
}

/// Serve the assistant's own link tool, or decline to.
///
/// Returns `None` for any other name, so the caller falls through to the tool
/// executor — which refuses it, because this is not an MCP tool and holds no
/// MCP permission. It dispatches nothing and reads nothing: it records
/// validated links and no more.
pub async fn try_execute_link_tool(
    links: &LinkStore,
    conversation_id: Uuid,
    tool_call: &ToolCall,
) -> Option<ToolResult> {
    if !is_link_tool(&tool_call.name) {
        return None;
    }
    let outcome = match serde_json::from_value::<AiLinkOffer>(tool_call.arguments.clone()) {
        Ok(offer) => links.offer(conversation_id, offer.links).await,
        Err(error) => Err(invalid("links", bounded_error(&error.to_string()))),
    };
    Some(match outcome {
        Ok(links) => ToolResult {
            tool_call_id: tool_call.id.clone(),
            content: link_tool_report(&links),
            is_error: false,
        },
        // A refused offer is reported as a tool error, the same way a refused
        // call is: the model can correct it in the same turn instead of
        // stalling, and it learns which rule it broke.
        Err(error) => ToolResult {
            tool_call_id: tool_call.id.clone(),
            content: format!("{} {LINK_TOOL_NOTE}", error.public_message()),
            is_error: true,
        },
    })
}

/// Keep a deserialization message short, cut on a character boundary.
fn bounded_error(text: &str) -> String {
    const CEILING: usize = 512;
    if text.len() <= CEILING {
        return text.to_string();
    }
    let mut end = CEILING;
    while end > 0 && !text.is_char_boundary(end) {
        end -= 1;
    }
    text[..end].to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn input(kind: AiLinkKind, target: &str) -> AiLinkInput {
        AiLinkInput {
            kind,
            label: "Look here".into(),
            target: target.into(),
        }
    }

    #[test]
    fn the_wire_format_is_camel_case() {
        let value = serde_json::to_value(AiLink {
            kind: AiLinkKind::DomainRegistry,
            label: "example.com at its registry".into(),
            target: "example.com".into(),
        })
        .expect("serializes");
        assert_eq!(value["kind"], "domainRegistry");
        assert_eq!(value["label"], "example.com at its registry");
        assert_eq!(value["target"], "example.com");

        let decoded: AiLinkInput = serde_json::from_value(json!({
            "kind": "external",
            "label": "Cloudflare docs",
            "target": "https://developers.cloudflare.com/dns/"
        }))
        .expect("deserializes");
        assert_eq!(decoded.kind, AiLinkKind::External);
    }

    #[test]
    fn a_link_cannot_carry_a_field_the_harness_owns() {
        for rejected in [
            json!({"kind": "zone", "label": "l", "target": "t", "href": "javascript:alert(1)"}),
            json!({"kind": "zone", "label": "l", "target": "t", "url": "file:///etc/passwd"}),
            json!({"kind": "zone", "label": "l", "target": "t", "validated": true}),
        ] {
            assert!(
                serde_json::from_value::<AiLinkInput>(rejected.clone()).is_err(),
                "{rejected} must be refused, not silently ignored"
            );
        }
    }

    /// The heart of the deliverable: a hostile target must fail to *store*.
    #[test]
    fn a_hostile_target_cannot_be_stored_under_any_in_app_kind() {
        const HOSTILE: &[&str] = &[
            "javascript:alert(1)",
            "JavaScript:alert(1)",
            "java\tscript:alert(1)",
            "data:text/html;base64,PHNjcmlwdD4=",
            "file:///etc/passwd",
            "vbscript:msgbox(1)",
            "../../etc/passwd",
            "..\\..\\windows\\system32",
            "..%2f..%2fetc%2fpasswd",
            "zone/../../admin",
            "a b",
            "a\nb",
            "a\u{0}b",
            "https://example.com/",
            "zone?next=javascript:alert(1)",
            "zone#javascript:alert(1)",
            "%6a%61%76%61%73%63%72%69%70%74:alert(1)",
        ];
        for kind in [
            AiLinkKind::Zone,
            AiLinkKind::Record,
            AiLinkKind::ZoneTab,
            AiLinkKind::Workspace,
            AiLinkKind::DomainRegistry,
        ] {
            for target in HOSTILE {
                assert!(
                    validate_link(input(kind, target)).is_err(),
                    "{} accepted {target:?}",
                    kind.as_str()
                );
            }
        }
    }

    #[test]
    fn an_external_target_must_be_an_absolute_https_url_without_credentials() {
        assert_eq!(
            validate_link(input(
                AiLinkKind::External,
                "https://developers.cloudflare.com/dns/"
            ))
            .expect("plain https URL")
            .target,
            "https://developers.cloudflare.com/dns/"
        );

        for rejected in [
            "javascript:alert(1)",
            "JAVASCRIPT:alert(1)",
            "data:text/html,<script>alert(1)</script>",
            "file:///etc/passwd",
            "vbscript:msgbox(1)",
            // http is permitted by the reused base-URL validator and refused
            // here: a link the user clicks does not downgrade.
            "http://example.com/",
            "HTTPS://example.com/",
            "https://user:pass@example.com/",
            "https://user@example.com/",
            // `Url::parse` would strip the tab and leave a valid https URL.
            "ht\ttps://example.com/",
            "https://exa\nmple.com/",
            " https://example.com/",
            "https://example.com/ ",
            "https:/example.com",
            "//example.com/",
            "/relative/path",
            "example.com",
            "",
        ] {
            assert!(
                validate_link(input(AiLinkKind::External, rejected)).is_err(),
                "external accepted {rejected:?}"
            );
        }

        assert!(
            validate_link(input(
                AiLinkKind::External,
                &format!("https://example.com/{}", "a".repeat(MAX_LINK_URL_BYTES))
            ))
            .is_err(),
            "an oversized URL must be refused"
        );
    }

    #[test]
    fn a_workspace_target_must_be_in_the_closed_set() {
        for id in WORKSPACE_IDS {
            assert!(
                validate_link(input(AiLinkKind::Workspace, id)).is_ok(),
                "{id}"
            );
        }
        for rejected in [
            // A real workspace, spelled differently.
            "Settings",
            "SETTINGS",
            " settings",
            "settings ",
            // A zone workspace needs a zone, so it is not a workspace id.
            "zone",
            // Plausible, and not a workspace.
            "records",
            "dashboard",
            "",
        ] {
            assert!(
                validate_link(input(AiLinkKind::Workspace, rejected)).is_err(),
                "workspace accepted {rejected:?}"
            );
        }
    }

    /// Not two implementations that agree: the link path calls the same
    /// `bc_notify` pair the RDAP request path calls, so this is a guarantee
    /// rather than a coincidence.
    #[test]
    fn a_registry_target_is_validated_and_normalised_like_a_registration_lookup() {
        for raw in ["  Example.COM.  ", "EXAMPLE.com", "example.com."] {
            assert_eq!(
                validate_link(input(AiLinkKind::DomainRegistry, raw))
                    .unwrap_or_else(|error| panic!("{raw}: {error:?}"))
                    .target,
                bc_notify::normalize_domain(raw),
                "the link path must normalise exactly as bc_notify does"
            );
        }
        assert_eq!(
            validate_link(input(AiLinkKind::DomainRegistry, "  Example.COM.  "))
                .expect("a hostname with a root dot and mixed case")
                .target,
            "example.com"
        );
        assert_eq!(
            validate_link(input(AiLinkKind::DomainRegistry, "xn--bcher-kva.example"))
                .expect("punycode")
                .target,
            "xn--bcher-kva.example"
        );
        for rejected in [
            "localhost",
            "example.com:443",
            "example.com/path",
            "https://example.com",
            "-example.com",
            "example-.com",
            "exam ple.com",
            "bücher.example",
            "",
        ] {
            assert!(
                validate_link(input(AiLinkKind::DomainRegistry, rejected)).is_err(),
                "domainRegistry accepted {rejected:?}"
            );
        }
        assert!(
            validate_link(input(
                AiLinkKind::DomainRegistry,
                &format!("{}.example.com", "a".repeat(MAX_LINK_HOSTNAME_BYTES))
            ))
            .is_err(),
            "an oversized hostname must be refused"
        );
    }

    #[test]
    fn a_zone_target_accepts_a_real_id_and_nothing_structural() {
        assert!(validate_link(input(AiLinkKind::Zone, "023e105f4ecef8ad9ca31a8372d0c353")).is_ok());
        assert!(validate_link(input(AiLinkKind::Zone, "zone-id_1")).is_ok());
        assert!(
            validate_link(input(AiLinkKind::Zone, &"a".repeat(MAX_LINK_ID_BYTES + 1))).is_err(),
            "an oversized id must be refused"
        );
        assert!(
            validate_link(input(AiLinkKind::Zone, "zone/record")).is_err(),
            "a zone link names one id, not a pair"
        );
    }

    /// A record is addressed within its zone, so the target carries both ids.
    /// Admitting `/` had to not weaken the charset: each half is checked by
    /// the same rule, and the shape is exactly two halves.
    #[test]
    fn a_record_target_carries_a_zone_id_and_a_record_id() {
        let link = validate_link(input(
            AiLinkKind::Record,
            "023e105f4ecef8ad9ca31a8372d0c353/372e67954025e0ba6aaa6d586b9e0b59",
        ))
        .expect("a zone id and a record id");
        assert_eq!(
            link.target,
            "023e105f4ecef8ad9ca31a8372d0c353/372e67954025e0ba6aaa6d586b9e0b59"
        );
        assert!(validate_link(input(AiLinkKind::Record, "zone-1/record_2")).is_ok());

        for rejected in [
            // One id is not enough to open a record.
            "372e67954025e0ba6aaa6d586b9e0b59",
            // Empty halves, extra segments, and traversal through the pair.
            "zone/",
            "/record",
            "zone//record",
            "zone/record/extra",
            "/",
            "",
            "../record",
            "zone/..",
            "zone/../../admin",
            "..%2frecord",
            // The separator does not smuggle anything else in.
            "zone/record?x=1",
            "zone/rec ord",
            "zone/record
next",
            "https://example.com/record",
        ] {
            assert!(
                validate_link(input(AiLinkKind::Record, rejected)).is_err(),
                "record accepted {rejected:?}"
            );
        }

        // The ceiling is per id, so one oversized half refuses the pair.
        let oversized = "a".repeat(MAX_LINK_ID_BYTES + 1);
        assert!(validate_link(input(AiLinkKind::Record, &format!("{oversized}/record"))).is_err());
        assert!(validate_link(input(AiLinkKind::Record, &format!("zone/{oversized}"))).is_err());
        assert!(
            validate_link(input(
                AiLinkKind::Record,
                &format!("{0}/{0}", "a".repeat(MAX_LINK_ID_BYTES))
            ))
            .is_ok(),
            "two ids at the exact ceiling are a valid pair"
        );
    }

    /// A zone tab is a view *of a zone*, so the target carries both. The tab
    /// half is a closed set, not a charset: these are fixed view names, and a
    /// name outside the set is a destination the application does not have.
    #[test]
    fn a_zone_tab_target_pairs_a_zone_id_with_one_of_its_tabs() {
        for tab in ZONE_TAB_IDS {
            let target = format!("023e105f4ecef8ad9ca31a8372d0c353/{tab}");
            let link = validate_link(input(AiLinkKind::ZoneTab, &target))
                .unwrap_or_else(|error| panic!("{tab} must be addressable: {error:?}"));
            assert_eq!(link.target, target);
        }

        for rejected in [
            // A tab with no zone is not a destination, which is the whole
            // reason this kind exists rather than widening `workspace`.
            "records",
            "zone-settings",
            // A zone with no tab is a `zone` link, not this.
            "023e105f4ecef8ad9ca31a8372d0c353",
            // Plausible names the application does not have.
            "zone1/dashboard",
            "zone1/Records",
            "zone1/RECORDS",
            "zone1/records ",
            "zone1/ records",
            "zone1/zone_settings",
            // A top-level workspace is not one of a zone's tabs.
            "zone1/settings",
            "zone1/notifications",
            "zone1/assistant",
            // Shape, traversal and smuggling, as for `record`.
            "zone1/",
            "/records",
            "zone1//records",
            "zone1/records/extra",
            "/",
            "",
            "../records",
            "zone1/..",
            "zone1/../../admin",
            "..%2frecords",
            "zone1/records?x=1",
            "zone1/records#x",
            "https://example.com/records",
            "javascript:alert(1)",
        ] {
            assert!(
                validate_link(input(AiLinkKind::ZoneTab, rejected)).is_err(),
                "zoneTab accepted {rejected:?}"
            );
        }

        // The zone half obeys the same id rule as everywhere else.
        assert!(validate_link(input(
            AiLinkKind::ZoneTab,
            &format!("{}/records", "a".repeat(MAX_LINK_ID_BYTES + 1))
        ))
        .is_err());
        assert!(validate_link(input(
            AiLinkKind::ZoneTab,
            &format!("{}/records", "a".repeat(MAX_LINK_ID_BYTES))
        ))
        .is_ok());
    }

    /// The two closed sets are different sets, and must stay that way: a
    /// zone tab is meaningless without a zone, and a top-level workspace
    /// takes no zone. Folding them together is how a link ends up opening
    /// somewhere plausible and wrong.
    #[test]
    fn the_zone_tabs_and_the_top_level_workspaces_stay_separate_sets() {
        for tab in ZONE_TAB_IDS {
            assert!(
                !WORKSPACE_IDS.contains(tab),
                "{tab} is in both sets; one of them is wrong"
            );
            assert!(
                validate_link(input(AiLinkKind::Workspace, tab)).is_err(),
                "a zone tab must not be accepted as a workspace: {tab}"
            );
        }
        for workspace in WORKSPACE_IDS {
            assert!(
                validate_link(input(AiLinkKind::ZoneTab, &format!("zone1/{workspace}"))).is_err(),
                "a workspace must not be accepted as a zone tab: {workspace}"
            );
        }
        // Spelled out so a tab added on one side is not quietly added to the
        // other: `domain-registry` is a zone tab, `registry` is a workspace,
        // and they are different screens.
        assert!(ZONE_TAB_IDS.contains(&"domain-registry"));
        assert!(WORKSPACE_IDS.contains(&"registry"));
        assert!(!ZONE_TAB_IDS.contains(&"registry"));
        assert!(!WORKSPACE_IDS.contains(&"domain-registry"));
    }

    #[test]
    fn a_label_is_bounded_blank_checked_and_control_free() {
        let mut oversized = input(AiLinkKind::Workspace, "settings");
        oversized.label = "l".repeat(MAX_LINK_LABEL_BYTES + 1);
        assert!(validate_link(oversized).is_err());

        for label in ["", "   ", "two\nlines", "forged\u{0}structure", "tab\there"] {
            let mut link = input(AiLinkKind::Workspace, "settings");
            link.label = label.into();
            assert!(validate_link(link).is_err(), "label accepted {label:?}");
        }
    }

    #[test]
    fn an_offer_is_bounded_and_all_or_nothing() {
        assert!(matches!(
            validate_links(Vec::new()),
            Err(AgentError::InvalidLink { field: "links", .. })
        ));
        assert!(matches!(
            validate_links(
                (0..=MAX_LINKS_PER_OFFER)
                    .map(|_| input(AiLinkKind::Workspace, "settings"))
                    .collect()
            ),
            Err(AgentError::InvalidLink { field: "links", .. })
        ));

        let mixed = vec![
            input(AiLinkKind::Workspace, "settings"),
            input(AiLinkKind::External, "javascript:alert(1)"),
        ];
        assert!(
            validate_links(mixed).is_err(),
            "one bad link refuses the offer"
        );
    }

    #[tokio::test]
    async fn a_refused_offer_leaves_the_previous_one_untouched() {
        let store = LinkStore::default();
        let conversation = Uuid::new_v4();
        store
            .offer(conversation, vec![input(AiLinkKind::Workspace, "audit")])
            .await
            .expect("a valid offer");

        let refused = store
            .offer(
                conversation,
                vec![
                    input(AiLinkKind::Workspace, "audit"),
                    input(AiLinkKind::External, "javascript:alert(1)"),
                ],
            )
            .await;
        assert!(refused.is_err());

        let stored = store.get(conversation).await;
        assert_eq!(stored.len(), 1);
        assert_eq!(stored[0].target, "audit");
        assert!(
            !stored.iter().any(|link| link.target.contains("javascript")),
            "a hostile target must never be stored"
        );
    }

    #[tokio::test]
    async fn an_offer_replaces_rather_than_accumulates_and_the_store_is_bounded() {
        let store = LinkStore::default();
        let conversation = Uuid::new_v4();
        store
            .offer(conversation, vec![input(AiLinkKind::Workspace, "audit")])
            .await
            .expect("first offer");
        store
            .offer(
                conversation,
                vec![input(AiLinkKind::Workspace, "notifications")],
            )
            .await
            .expect("second offer");
        let stored = store.get(conversation).await;
        assert_eq!(stored.len(), 1, "offers replace, they do not accumulate");
        assert_eq!(stored[0].target, "notifications");

        for _ in 0..MAX_RETAINED_LINK_OFFERS + 8 {
            store
                .offer(Uuid::new_v4(), vec![input(AiLinkKind::Workspace, "tags")])
                .await
                .expect("offer");
        }
        assert!(store.count().await <= MAX_RETAINED_LINK_OFFERS);

        assert!(store.delete(conversation).await || store.get(conversation).await.is_empty());
    }

    #[tokio::test]
    async fn the_link_tool_declines_every_other_name() {
        let store = LinkStore::default();
        let call = ToolCall {
            id: "call-1".into(),
            name: "cf_delete_dns_record".into(),
            arguments: json!({}),
        };
        assert!(try_execute_link_tool(&store, Uuid::new_v4(), &call)
            .await
            .is_none());
    }

    #[tokio::test]
    async fn the_link_tool_reports_a_refusal_as_a_tool_error() {
        let store = LinkStore::default();
        let conversation = Uuid::new_v4();
        let call = ToolCall {
            id: "call-1".into(),
            name: LINK_OFFER_TOOL.into(),
            arguments: json!({
                "links": [{"kind": "external", "label": "docs", "target": "javascript:alert(1)"}]
            }),
        };
        let result = try_execute_link_tool(&store, conversation, &call)
            .await
            .expect("the link tool serves its own name");
        assert!(result.is_error);
        assert!(store.get(conversation).await.is_empty());

        let accepted = ToolCall {
            id: "call-2".into(),
            name: LINK_OFFER_TOOL.into(),
            arguments: json!({
                "links": [{"kind": "zone", "label": "The zone", "target": "zone123"}]
            }),
        };
        let result = try_execute_link_tool(&store, conversation, &accepted)
            .await
            .expect("served");
        assert!(!result.is_error);
        assert_eq!(store.get(conversation).await[0].target, "zone123");
    }

    /// The link tool is not an MCP tool, so it must not be able to shadow
    /// one. Nothing in the catalogue may be called `link_offer`.
    #[test]
    fn the_link_tool_name_is_not_an_mcp_tool() {
        assert!(bc_mcp::permissions::permission_for_invocation(LINK_OFFER_TOOL).is_none());
        assert!(!bc_mcp::tools::all_tool_names()
            .iter()
            .any(|name| name == LINK_OFFER_TOOL));
    }
}
