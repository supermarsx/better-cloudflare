//! User-defined provider profiles.
//!
//! A profile is *identity* — a user-chosen id and label — paired with the
//! [`ProviderProtocol`] that says which client speaks to it. That split is the
//! point: "OpenAI-compatible" is a protocol, not a vendor, so several profiles
//! (`openai`, `groq`, `vllm-lab`) can share one protocol with different base
//! URLs and keys, and none of them evicts another.
//!
//! Three shapes appear here, and the difference between them is a security
//! boundary:
//!
//! * [`ProviderProfile`] — what the backend stores. It holds the API key, and
//!   deliberately implements neither `Serialize` nor a derived `Debug`, so it
//!   cannot be returned from a Tauri command or printed into a log.
//! * [`AiProviderProfile`] — what the renderer receives. It has **no** key
//!   field at all, only `hasApiKey`.
//! * [`AiProviderProfileInput`] — what the renderer sends. Its `apiKey` is a
//!   three-state value: absent keeps the stored key, `null` clears it, a
//!   string replaces it.

use std::collections::BTreeMap;

use serde::{Deserialize, Deserializer, Serialize};

use crate::config::{ProviderConfig, ProviderProtocol};
use crate::error::AiProviderError;
use crate::limits::{validate_string, MAX_API_KEY_BYTES, MAX_BASE_URL_BYTES};

/// Id bound. Ids are user-supplied and are used as map keys and as the
/// `providerId` on the wire, so they stay short and ASCII.
pub const MAX_PROVIDER_ID_BYTES: usize = 64;
/// Label bound. A label is display text only.
pub const MAX_PROVIDER_LABEL_BYTES: usize = 128;
/// How many profiles one install may hold.
pub const MAX_PROVIDER_PROFILES: usize = 32;

/// Sampling default for a stored payload that predates the field.
const DEFAULT_TEMPERATURE: f32 = 0.7;
/// Response-length default for a stored payload that predates the field.
const DEFAULT_MAX_TOKENS: u32 = 4096;

fn invalid(field: &'static str, message: impl Into<String>) -> AiProviderError {
    AiProviderError::InvalidRequest {
        field,
        message: message.into(),
    }
}

/// Reject an id that could not be used safely as a key or echoed back.
///
/// A malformed id is refused, never rewritten into something valid: silently
/// accepting `my profile` as `my-profile` would hand the renderer back an id
/// it never asked for and cannot predict.
pub fn validate_provider_id(id: &str) -> Result<(), AiProviderError> {
    if id.is_empty() || id.len() > MAX_PROVIDER_ID_BYTES {
        return Err(invalid(
            "id",
            format!("must contain between 1 and {MAX_PROVIDER_ID_BYTES} bytes"),
        ));
    }
    if !id
        .chars()
        .all(|value| value.is_ascii_alphanumeric() || value == '-' || value == '_')
    {
        return Err(invalid(
            "id",
            "must contain only letters, digits, '-' or '_'",
        ));
    }
    Ok(())
}

/// Reject a label that would corrupt the UI it is rendered into.
pub fn validate_provider_label(label: &str) -> Result<(), AiProviderError> {
    if label.len() > MAX_PROVIDER_LABEL_BYTES {
        return Err(invalid(
            "label",
            format!("must not exceed {MAX_PROVIDER_LABEL_BYTES} bytes"),
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

/// Reject a base URL the backend must not be pointed at.
///
/// This is the one field on a profile that decides where the process sends a
/// credential, so it is checked before `reqwest::Url` gets a chance to
/// normalise anything away: `Url::parse` silently strips tabs, newlines and
/// surrounding control characters, which would let `ht\ttps://…` or a
/// line-wrapped URL through a scheme check that reads the parsed result.
pub fn validate_base_url(value: &str) -> Result<(), AiProviderError> {
    validate_string("provider base URL", value, MAX_BASE_URL_BYTES)?;
    if value.is_empty() {
        return Err(invalid("baseUrl", "must not be empty"));
    }
    if value
        .chars()
        .any(|character| character.is_control() || character.is_whitespace())
    {
        return Err(invalid(
            "baseUrl",
            "must not contain whitespace or control characters",
        ));
    }

    let parsed =
        reqwest::Url::parse(value).map_err(|error| invalid("baseUrl", error.to_string()))?;
    if !matches!(parsed.scheme(), "http" | "https") {
        return Err(invalid("baseUrl", "scheme must be http or https"));
    }
    if parsed.cannot_be_a_base() {
        return Err(invalid("baseUrl", "must be an absolute URL with a host"));
    }
    if !parsed.username().is_empty() || parsed.password().is_some() {
        return Err(invalid("baseUrl", "must not embed credentials"));
    }
    if parsed.host_str().is_none_or(str::is_empty) {
        return Err(invalid("baseUrl", "must name a host"));
    }
    Ok(())
}

/// Validate a key before it is stored and later pasted into a header.
fn validate_api_key(key: &str) -> Result<(), AiProviderError> {
    validate_string("provider API key", key, MAX_API_KEY_BYTES)?;
    if key.chars().any(char::is_control) {
        return Err(invalid("apiKey", "must not contain control characters"));
    }
    Ok(())
}

/// Validate, then settle the one cosmetic difference that would otherwise
/// produce `https://host//chat/completions`: clients append their path with a
/// leading slash, so a stored base URL never keeps a trailing one.
fn normalize_base_url(value: &str) -> Result<String, AiProviderError> {
    validate_base_url(value)?;
    let trimmed = value.trim_end_matches('/');
    if trimmed.is_empty() {
        return Err(invalid("baseUrl", "must be an absolute URL with a host"));
    }
    Ok(trimmed.to_string())
}

/// One configured provider, as the backend holds it.
///
/// `Deserialize` accepts both this shape and the pre-profile one (a
/// `ProviderConfig` keyed by its `kind`), so reading a stored payload written
/// before profiles existed keeps the user's API key. See
/// [`StoredProviderProfile`].
#[derive(Clone, Deserialize)]
#[serde(try_from = "StoredProviderProfile")]
pub struct ProviderProfile {
    /// User-defined identity. Stable across edits; the wire `providerId`.
    pub id: String,
    /// Display name.
    pub label: String,
    /// Which client speaks to this endpoint.
    pub protocol: ProviderProtocol,
    /// Fully resolved base URL — never empty, never a bare default sentinel.
    pub base_url: String,
    /// Model used for new conversations against this profile.
    pub model: String,
    pub temperature: f32,
    pub max_tokens: u32,
    /// The credential. Never serialized, never printed, never returned.
    pub api_key: Option<String>,
}

/// Hand-written so a profile cannot carry its key into a log line or a panic
/// message. Every other field is safe to show.
impl std::fmt::Debug for ProviderProfile {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("ProviderProfile")
            .field("id", &self.id)
            .field("label", &self.label)
            .field("protocol", &self.protocol)
            .field("base_url", &self.base_url)
            .field("model", &self.model)
            .field("temperature", &self.temperature)
            .field("max_tokens", &self.max_tokens)
            .field(
                "api_key",
                &self.api_key.as_ref().map_or("None", |_| "<redacted>"),
            )
            .finish()
    }
}

impl ProviderProfile {
    /// Seed a profile from a protocol's defaults, for a caller that has only
    /// picked a protocol so far.
    pub fn seed(id: impl Into<String>, protocol: ProviderProtocol) -> Self {
        Self {
            id: id.into(),
            label: protocol.label().to_string(),
            protocol,
            base_url: protocol.default_base_url().to_string(),
            model: protocol.default_model().to_string(),
            temperature: DEFAULT_TEMPERATURE,
            max_tokens: DEFAULT_MAX_TOKENS,
            api_key: None,
        }
    }

    /// Build the profile a create-or-update produces, without touching any
    /// store. The id is decided by the caller, because uniqueness is a
    /// property of the store rather than of one profile.
    ///
    /// `existing` is the profile being updated, when there is one. It supplies
    /// the stored API key unless the input replaces or clears it, and the base
    /// URL unless the input gives one — but only while the protocol is
    /// unchanged, since an OpenAI base URL is meaningless to the Anthropic
    /// client.
    pub fn apply(
        id: String,
        existing: Option<&Self>,
        input: AiProviderProfileInput,
    ) -> Result<Self, AiProviderError> {
        validate_provider_id(&id)?;
        let protocol = input.protocol;
        let inherited = existing.filter(|profile| profile.protocol == protocol);

        let label = match input.label {
            Some(label) => label,
            None => existing
                .map(|profile| profile.label.clone())
                .unwrap_or_else(|| protocol.label().to_string()),
        };

        let base_url = match input
            .base_url
            .filter(|value| !value.trim().is_empty())
            .as_deref()
        {
            Some(value) => normalize_base_url(value)?,
            None => inherited
                .map(|profile| profile.base_url.clone())
                .unwrap_or_else(|| protocol.default_base_url().to_string()),
        };

        let api_key = match input.api_key {
            // Absent: keep whatever is stored. This is what lets the renderer
            // round-trip an `AiProviderProfile` back as an update.
            None => existing.and_then(|profile| profile.api_key.clone()),
            // Explicit null, or an empty string: the user cleared the field.
            Some(None) => None,
            Some(Some(key)) if key.is_empty() => None,
            Some(Some(key)) => Some(key),
        };

        let profile = Self {
            id,
            label,
            protocol,
            base_url,
            model: input.model,
            temperature: input.temperature,
            max_tokens: input.max_tokens,
            api_key,
        };
        profile.validate()?;
        Ok(profile)
    }

    /// Validate every user-controlled field. Called on each write, and on
    /// anything read back from a stored payload.
    pub fn validate(&self) -> Result<(), AiProviderError> {
        validate_provider_id(&self.id)?;
        validate_provider_label(&self.label)?;
        validate_base_url(&self.base_url)?;
        if let Some(key) = &self.api_key {
            validate_api_key(key)?;
        }
        // Model, temperature and max-token bounds live with the client
        // configuration, so a profile cannot validate here and be refused
        // there.
        self.to_config().validate()
    }

    /// The client-facing half: what a request needs, with no identity.
    pub fn to_config(&self) -> ProviderConfig {
        ProviderConfig {
            protocol: self.protocol,
            api_key: self.api_key.clone(),
            base_url: Some(self.base_url.clone()),
            model: self.model.clone(),
            temperature: self.temperature,
            max_tokens: self.max_tokens,
        }
    }

    /// The renderer-facing half: everything except the key.
    pub fn view(&self) -> AiProviderProfile {
        AiProviderProfile {
            id: self.id.clone(),
            label: self.label.clone(),
            protocol: self.protocol,
            base_url: self.base_url.clone(),
            model: self.model.clone(),
            temperature: self.temperature,
            max_tokens: self.max_tokens,
            has_api_key: self.api_key.is_some(),
        }
    }
}

/// A configured provider as the renderer sees it.
///
/// There is no `api_key` field here — not an `Option`, not a skipped one. The
/// renderer learns only whether a key is stored, so no future edit to a
/// serializer or a `skip_serializing_if` can start leaking one.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiProviderProfile {
    pub id: String,
    pub label: String,
    pub protocol: ProviderProtocol,
    pub base_url: String,
    pub model: String,
    pub temperature: f32,
    pub max_tokens: u32,
    pub has_api_key: bool,
}

/// The renderer-supplied half of a profile.
///
/// Extra fields are ignored rather than rejected, so a caller can send back an
/// [`AiProviderProfile`] it was given — `hasApiKey` is dropped, and the absent
/// `apiKey` leaves the stored key alone.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiProviderProfileInput {
    /// Absent creates; present updates (or creates under that exact id).
    #[serde(default)]
    pub id: Option<String>,
    /// Absent only in a pre-profile payload, where the protocol names it.
    #[serde(default)]
    pub label: Option<String>,
    /// `kind` is the pre-profile spelling of this field.
    #[serde(alias = "kind")]
    pub protocol: ProviderProtocol,
    /// Absent (or blank) keeps an unchanged protocol's stored URL, else falls
    /// back to the protocol default.
    #[serde(default)]
    pub base_url: Option<String>,
    pub model: String,
    pub temperature: f32,
    pub max_tokens: u32,
    /// Three-state: absent keeps the stored key, `null` clears it, a string
    /// replaces it.
    #[serde(default, deserialize_with = "deserialize_tri_state")]
    pub api_key: Option<Option<String>>,
}

/// Distinguish "field absent" from "field present and null".
///
/// `#[serde(default)]` supplies `None` for an absent field; this is reached
/// only when the field is present, so a `null` arrives as `Some(None)`.
fn deserialize_tri_state<'de, D>(deserializer: D) -> Result<Option<Option<String>>, D::Error>
where
    D: Deserializer<'de>,
{
    Option::<String>::deserialize(deserializer).map(Some)
}

/// The stored shape of a [`ProviderProfile`], used for backward-compatible
/// reads.
///
/// Payloads written before profiles existed are a `ProviderConfig` per
/// protocol: they carry `kind` instead of `protocol`, and no `id` or `label`.
/// Converting rather than rejecting them is the difference between an upgrade
/// that keeps a user's API key and one that silently discards it, so every
/// field is optional and every absence has an answer.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StoredProviderProfile {
    #[serde(default)]
    pub id: Option<String>,
    #[serde(default)]
    pub label: Option<String>,
    #[serde(default)]
    pub protocol: Option<ProviderProtocol>,
    /// Pre-profile spelling of `protocol`.
    #[serde(default)]
    pub kind: Option<ProviderProtocol>,
    #[serde(default)]
    pub api_key: Option<String>,
    #[serde(default)]
    pub base_url: Option<String>,
    #[serde(default)]
    pub model: Option<String>,
    #[serde(default)]
    pub temperature: Option<f32>,
    #[serde(default)]
    pub max_tokens: Option<u32>,
}

impl TryFrom<StoredProviderProfile> for ProviderProfile {
    type Error = &'static str;

    fn try_from(stored: StoredProviderProfile) -> Result<Self, Self::Error> {
        // The protocol is the only field with no safe default: guessing it
        // would point a stored key at the wrong endpoint.
        let protocol = stored
            .protocol
            .or(stored.kind)
            .ok_or("a stored provider profile needs a protocol (or a legacy kind)")?;
        let non_empty = |value: Option<String>| value.filter(|value| !value.trim().is_empty());
        Ok(Self {
            // A pre-profile payload has one connection per protocol, so the
            // protocol's own name is its id.
            id: non_empty(stored.id).unwrap_or_else(|| protocol.as_str().to_string()),
            label: non_empty(stored.label).unwrap_or_else(|| protocol.label().to_string()),
            protocol,
            base_url: non_empty(stored.base_url)
                .unwrap_or_else(|| protocol.default_base_url().to_string()),
            model: non_empty(stored.model).unwrap_or_else(|| protocol.default_model().to_string()),
            temperature: stored.temperature.unwrap_or(DEFAULT_TEMPERATURE),
            max_tokens: stored.max_tokens.unwrap_or(DEFAULT_MAX_TOKENS),
            api_key: non_empty(stored.api_key),
        })
    }
}

/// The pre-profile stored registry: one connection per protocol, keyed by the
/// protocol's wire name (`{"openai": {…}, "ollama": {…}}`).
#[derive(Debug, Deserialize)]
#[serde(transparent)]
pub struct LegacyProviderRegistry(BTreeMap<String, ProviderProfile>);

impl LegacyProviderRegistry {
    /// One profile per stored connection, in key order. The map key wins as
    /// the id when it is usable, so the migrated ids match the keys the user's
    /// payload already had.
    pub fn into_profiles(self) -> Vec<ProviderProfile> {
        self.0
            .into_iter()
            .map(|(key, mut profile)| {
                if validate_provider_id(&key).is_ok() {
                    profile.id = key;
                }
                profile
            })
            .collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn input(protocol: ProviderProtocol) -> AiProviderProfileInput {
        AiProviderProfileInput {
            id: None,
            label: Some("Bounded".into()),
            protocol,
            base_url: None,
            model: "test-model".into(),
            temperature: 0.7,
            max_tokens: 1024,
            api_key: Some(Some("sk-live-TOPSECRET".into())),
        }
    }

    fn profile(id: &str) -> ProviderProfile {
        ProviderProfile::apply(id.into(), None, input(ProviderProtocol::OpenAi))
            .expect("valid profile")
    }

    /// The renderer must not be able to learn a key from the shape it is
    /// handed, by any field name or any serializer path.
    #[test]
    fn a_serialized_profile_carries_no_key_material() {
        let profile = profile("openai");
        assert_eq!(profile.api_key.as_deref(), Some("sk-live-TOPSECRET"));

        let serialized = serde_json::to_string(&profile.view()).expect("view serializes");
        assert!(
            !serialized.contains("sk-live"),
            "key material leaked: {serialized}"
        );
        assert!(!serialized.contains("TOPSECRET"));
        for forbidden in ["apiKey", "api_key", "key\""] {
            assert!(
                !serialized.contains(forbidden),
                "{forbidden} leaked into {serialized}"
            );
        }

        let value = serde_json::to_value(profile.view()).expect("serializes");
        assert_eq!(value["hasApiKey"], true);
        assert_eq!(value["baseUrl"], "https://api.openai.com/v1");
        assert_eq!(value["protocol"], "openai");
        assert!(value.get("apiKey").is_none());
        assert!(value.get("base_url").is_none(), "snake_case leaked");
    }

    /// A key reaches a log line through `Debug` as easily as through serde.
    #[test]
    fn debug_output_redacts_the_key() {
        let rendered = format!("{:?}", profile("openai"));
        assert!(!rendered.contains("sk-live"), "{rendered}");
        assert!(!rendered.contains("TOPSECRET"));
        assert!(rendered.contains("<redacted>"));
        assert!(rendered.contains("openai"));
    }

    /// The pre-change stored shape: a `ProviderConfig` keyed by `kind`, with a
    /// key the user typed once and cannot retype. Every field must survive.
    #[test]
    fn a_pre_profile_stored_payload_migrates_without_losing_the_api_key() {
        let stored = r#"{
            "kind": "openai",
            "apiKey": "sk-legacy-DO-NOT-LOSE",
            "baseUrl": "https://api.groq.com/openai/v1",
            "model": "llama-3.3-70b-versatile",
            "temperature": 0.25,
            "maxTokens": 2048
        }"#;
        let profile: ProviderProfile =
            serde_json::from_str(stored).expect("a pre-profile payload must still load");

        assert_eq!(
            profile.api_key.as_deref(),
            Some("sk-legacy-DO-NOT-LOSE"),
            "the stored API key must survive the migration"
        );
        assert_eq!(profile.id, "openai");
        assert_eq!(profile.label, "OpenAI");
        assert_eq!(profile.protocol, ProviderProtocol::OpenAi);
        assert_eq!(profile.base_url, "https://api.groq.com/openai/v1");
        assert_eq!(profile.model, "llama-3.3-70b-versatile");
        assert_eq!(profile.temperature, 0.25);
        assert_eq!(profile.max_tokens, 2048);
        profile.validate().expect("a migrated profile is valid");
        assert!(profile.view().has_api_key);
    }

    /// The whole pre-change registry — one `ProviderConfig` per kind, keyed by
    /// the kind — becomes one profile per entry, each keeping its own key.
    #[test]
    fn a_pre_profile_registry_migrates_every_entry_and_every_key() {
        let stored = r#"{
            "openai": {
                "kind": "openai",
                "apiKey": "sk-openai-KEEP",
                "model": "gpt-4o",
                "temperature": 0.7,
                "maxTokens": 4096
            },
            "anthropic": {
                "kind": "anthropic",
                "apiKey": "sk-ant-KEEP",
                "baseUrl": "https://proxy.internal/anthropic",
                "model": "claude-sonnet-4-20250514",
                "temperature": 1.0,
                "maxTokens": 8192
            },
            "ollama": {
                "kind": "ollama",
                "model": "llama3",
                "temperature": 0.3,
                "maxTokens": 512
            }
        }"#;
        let registry: LegacyProviderRegistry =
            serde_json::from_str(stored).expect("a pre-profile registry must still load");
        let profiles = registry.into_profiles();

        assert_eq!(profiles.len(), 3);
        let ids: Vec<&str> = profiles.iter().map(|profile| profile.id.as_str()).collect();
        assert_eq!(ids, ["anthropic", "ollama", "openai"]);

        let anthropic = &profiles[0];
        assert_eq!(anthropic.api_key.as_deref(), Some("sk-ant-KEEP"));
        assert_eq!(anthropic.base_url, "https://proxy.internal/anthropic");
        assert_eq!(anthropic.max_tokens, 8192);

        let ollama = &profiles[1];
        assert_eq!(ollama.api_key, None, "Ollama never had a key to keep");
        assert_eq!(ollama.base_url, "http://localhost:11434");
        assert_eq!(ollama.temperature, 0.3);

        let openai = &profiles[2];
        assert_eq!(openai.api_key.as_deref(), Some("sk-openai-KEEP"));
        assert_eq!(openai.base_url, "https://api.openai.com/v1");
        assert_eq!(openai.model, "gpt-4o");

        for profile in &profiles {
            profile.validate().expect("every migrated profile is valid");
        }
    }

    /// A payload with no protocol in either spelling has nothing to migrate
    /// to; guessing one would point a stored key at the wrong endpoint.
    #[test]
    fn a_stored_payload_without_a_protocol_is_refused() {
        let error = serde_json::from_str::<ProviderProfile>(r#"{"model": "gpt-4o"}"#)
            .expect_err("a protocol cannot be guessed");
        assert!(error.to_string().contains("needs a protocol"));
    }

    #[test]
    fn the_new_spelling_wins_when_a_stored_payload_carries_both() {
        let profile: ProviderProfile = serde_json::from_str(
            r#"{"id": "lab", "label": "Lab", "protocol": "ollama", "kind": "openai",
                 "model": "llama3", "temperature": 0.1, "maxTokens": 64}"#,
        )
        .expect("both spellings must not be an error");
        assert_eq!(profile.protocol, ProviderProtocol::Ollama);
        assert_eq!(profile.id, "lab");
        assert_eq!(profile.label, "Lab");
    }

    #[test]
    fn an_absent_api_key_keeps_the_stored_one_and_null_clears_it() {
        let stored = profile("openai");

        let keep: AiProviderProfileInput = serde_json::from_value(serde_json::json!({
            "id": "openai",
            "label": "Renamed",
            "protocol": "openai",
            "model": "gpt-4o",
            "temperature": 0.5,
            "maxTokens": 256,
        }))
        .expect("an absent apiKey is legal");
        let updated =
            ProviderProfile::apply("openai".into(), Some(&stored), keep).expect("valid update");
        assert_eq!(updated.api_key.as_deref(), Some("sk-live-TOPSECRET"));
        assert_eq!(updated.label, "Renamed");
        assert_eq!(updated.model, "gpt-4o");

        let cleared: AiProviderProfileInput = serde_json::from_value(serde_json::json!({
            "id": "openai",
            "label": "Renamed",
            "protocol": "openai",
            "model": "gpt-4o",
            "temperature": 0.5,
            "maxTokens": 256,
            "apiKey": null,
        }))
        .expect("an explicit null is legal");
        let updated =
            ProviderProfile::apply("openai".into(), Some(&stored), cleared).expect("valid update");
        assert_eq!(updated.api_key, None);
        assert!(!updated.view().has_api_key);

        let replaced: AiProviderProfileInput = serde_json::from_value(serde_json::json!({
            "protocol": "openai",
            "label": "Renamed",
            "model": "gpt-4o",
            "temperature": 0.5,
            "maxTokens": 256,
            "apiKey": "sk-new",
        }))
        .expect("a string is legal");
        let updated =
            ProviderProfile::apply("openai".into(), Some(&stored), replaced).expect("valid update");
        assert_eq!(updated.api_key.as_deref(), Some("sk-new"));

        // An empty string is the cleared form of a text field, not a key.
        let blanked: AiProviderProfileInput = serde_json::from_value(serde_json::json!({
            "protocol": "openai",
            "label": "Renamed",
            "model": "gpt-4o",
            "temperature": 0.5,
            "maxTokens": 256,
            "apiKey": "",
        }))
        .expect("an empty string is legal");
        let updated =
            ProviderProfile::apply("openai".into(), Some(&stored), blanked).expect("valid update");
        assert_eq!(updated.api_key, None);
    }

    /// The view is the shape the renderer holds, so sending it straight back
    /// as an update must not be the thing that destroys the stored key.
    #[test]
    fn a_round_tripped_view_does_not_clear_the_stored_key() {
        let stored = profile("openai");
        let serialized = serde_json::to_string(&stored.view()).expect("serializes");
        let input: AiProviderProfileInput =
            serde_json::from_str(&serialized).expect("a view is a legal update");
        let updated =
            ProviderProfile::apply("openai".into(), Some(&stored), input).expect("valid update");
        assert_eq!(updated.api_key.as_deref(), Some("sk-live-TOPSECRET"));
        assert_eq!(updated.label, stored.label);
        assert_eq!(updated.base_url, stored.base_url);
    }

    #[test]
    fn changing_the_protocol_without_a_base_url_moves_to_the_new_default() {
        let stored = ProviderProfile::apply(
            "mine".into(),
            None,
            AiProviderProfileInput {
                base_url: Some("https://api.groq.com/openai/v1".into()),
                ..input(ProviderProtocol::OpenAi)
            },
        )
        .expect("valid");
        assert_eq!(stored.base_url, "https://api.groq.com/openai/v1");

        let switched = ProviderProfile::apply(
            "mine".into(),
            Some(&stored),
            input(ProviderProtocol::Anthropic),
        )
        .expect("valid");
        assert_eq!(
            switched.base_url,
            ProviderProtocol::Anthropic.default_base_url(),
            "an OpenAI base URL must not survive a switch to the Anthropic client"
        );

        let kept = ProviderProfile::apply(
            "mine".into(),
            Some(&stored),
            input(ProviderProtocol::OpenAi),
        )
        .expect("valid");
        assert_eq!(kept.base_url, "https://api.groq.com/openai/v1");
    }

    /// Every base URL the backend must refuse to be pointed at. A profile
    /// carrying one of these must be impossible to build.
    #[test]
    fn only_absolute_http_urls_without_credentials_are_accepted() {
        for accepted in [
            "http://localhost:11434",
            "https://api.openai.com/v1",
            "https://10.0.0.5:8443/v1",
            "https://api.groq.com/openai/v1/",
        ] {
            let profile = ProviderProfile::apply(
                "p".into(),
                None,
                AiProviderProfileInput {
                    base_url: Some(accepted.into()),
                    ..input(ProviderProtocol::OpenAi)
                },
            )
            .unwrap_or_else(|error| panic!("{accepted} must be accepted: {error}"));
            assert_eq!(
                profile.base_url,
                accepted.trim_end_matches('/'),
                "a trailing slash must not survive into a request path"
            );
        }

        for refused in [
            "file:///etc/passwd",
            "ftp://example.com",
            "javascript:fetch('/')",
            "data:text/plain,hi",
            "ws://example.com",
            "//example.com/v1",
            "example.com/v1",
            "/v1",
            "https://user:pass@example.com/v1",
            "https://user@example.com/v1",
            "ht\ttps://example.com/v1",
            "https://example.com/v1\n",
            " https://example.com/v1",
            "https://exa mple.com/v1",
            "https://example.com/v1\u{0}",
            "http://",
            "https://",
        ] {
            let error = ProviderProfile::apply(
                "p".into(),
                None,
                AiProviderProfileInput {
                    base_url: Some(refused.into()),
                    ..input(ProviderProtocol::OpenAi)
                },
            )
            .expect_err(&format!("{refused:?} must be refused"));
            assert!(
                matches!(
                    error,
                    AiProviderError::InvalidRequest {
                        field: "baseUrl",
                        ..
                    }
                ),
                "{refused:?} produced {error:?}"
            );
        }
    }

    /// `ProviderProfile::validate` also runs the client configuration's own
    /// scheme check, so the profile-layer one has to be pinned on its own —
    /// otherwise removing it looks harmless right up until some future caller
    /// validates a base URL without building a `ProviderConfig`.
    #[test]
    fn this_module_refuses_a_non_http_scheme_without_help_from_the_config() {
        for refused in [
            "ftp://example.com",
            "ws://example.com",
            "wss://example.com",
            "file:///etc/passwd",
            "javascript:fetch('/')",
            "data:text/plain,hi",
        ] {
            assert!(
                matches!(
                    validate_base_url(refused),
                    Err(AiProviderError::InvalidRequest {
                        field: "baseUrl",
                        ..
                    })
                ),
                "{refused:?} must be refused by validate_base_url itself"
            );
        }
        validate_base_url("https://api.openai.com/v1").expect("http(s) stays accepted");
        validate_base_url("http://localhost:11434").expect("http(s) stays accepted");
    }

    #[test]
    fn an_oversized_base_url_is_refused_at_the_byte_boundary() {
        let host = "https://example.com/";
        let exact = format!("{host}{}", "v".repeat(MAX_BASE_URL_BYTES - host.len()));
        assert_eq!(exact.len(), MAX_BASE_URL_BYTES);
        validate_base_url(&exact).expect("exact boundary");
        assert!(matches!(
            validate_base_url(&format!("{exact}v")),
            Err(AiProviderError::LimitExceeded {
                resource: "provider base URL",
                ..
            })
        ));
    }

    #[test]
    fn ids_are_bounded_and_conservatively_charactered() {
        validate_provider_id(&"i".repeat(MAX_PROVIDER_ID_BYTES)).expect("exact boundary");
        for refused in [
            "",
            "my profile",
            "../../etc/passwd",
            "openai/v1",
            "openai.v1",
            "öpenai",
            "open:ai",
            "open\u{0}ai",
        ] {
            assert!(
                matches!(
                    validate_provider_id(refused),
                    Err(AiProviderError::InvalidRequest { field: "id", .. })
                ),
                "id {refused:?} must be refused"
            );
        }
        assert!(matches!(
            validate_provider_id(&"i".repeat(MAX_PROVIDER_ID_BYTES + 1)),
            Err(AiProviderError::InvalidRequest { field: "id", .. })
        ));
    }

    #[test]
    fn labels_and_keys_are_bounded_and_control_free() {
        validate_provider_label(&"l".repeat(MAX_PROVIDER_LABEL_BYTES)).expect("exact boundary");
        for refused in ["", "   ", "two\nlines", "tab\there"] {
            assert!(
                matches!(
                    validate_provider_label(refused),
                    Err(AiProviderError::InvalidRequest { field: "label", .. })
                ),
                "label {refused:?} must be refused"
            );
        }
        assert!(matches!(
            validate_provider_label(&"l".repeat(MAX_PROVIDER_LABEL_BYTES + 1)),
            Err(AiProviderError::InvalidRequest { field: "label", .. })
        ));

        // A key with a newline in it is a header-injection attempt, not a key.
        let error = ProviderProfile::apply(
            "p".into(),
            None,
            AiProviderProfileInput {
                api_key: Some(Some("sk-live\r\nX-Admin: true".into())),
                ..input(ProviderProtocol::OpenAi)
            },
        )
        .expect_err("a control character in a key must be refused");
        assert!(matches!(
            error,
            AiProviderError::InvalidRequest {
                field: "apiKey",
                ..
            }
        ));
    }

    #[test]
    fn model_and_sampling_bounds_are_enforced_through_a_profile() {
        for (field, candidate) in [
            (
                "model",
                AiProviderProfileInput {
                    model: String::new(),
                    ..input(ProviderProtocol::OpenAi)
                },
            ),
            (
                "temperature",
                AiProviderProfileInput {
                    temperature: 2.5,
                    ..input(ProviderProtocol::OpenAi)
                },
            ),
            (
                "temperature",
                AiProviderProfileInput {
                    temperature: f32::NAN,
                    ..input(ProviderProtocol::OpenAi)
                },
            ),
            (
                "maxTokens",
                AiProviderProfileInput {
                    max_tokens: 0,
                    ..input(ProviderProtocol::OpenAi)
                },
            ),
            (
                "maxTokens",
                AiProviderProfileInput {
                    max_tokens: crate::limits::MAX_COMPLETION_TOKENS + 1,
                    ..input(ProviderProtocol::OpenAi)
                },
            ),
        ] {
            let error = ProviderProfile::apply("p".into(), None, candidate)
                .expect_err("an out-of-range field must be refused");
            match error {
                AiProviderError::InvalidRequest { field: actual, .. } => {
                    assert_eq!(actual, field)
                }
                other => panic!("expected an InvalidRequest for {field}, got {other:?}"),
            }
        }
    }

    #[test]
    fn a_seeded_profile_carries_the_protocol_defaults() {
        let seeded = ProviderProfile::seed("ollama", ProviderProtocol::Ollama);
        assert_eq!(seeded.base_url, "http://localhost:11434");
        assert_eq!(seeded.model, "llama3");
        assert_eq!(seeded.label, "Ollama");
        assert!(seeded.api_key.is_none());
        seeded.validate().expect("the seed is valid");
    }
}
