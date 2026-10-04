//! AI assistant personas: immutable builtins plus bounded custom entries.
//!
//! A persona is a named system prompt. The builtins are derived from
//! [`crate::presets`] so the two never drift, and they cannot be edited,
//! removed, or shadowed by a custom entry: custom ids are issued here and
//! always carry [`CUSTOM_PERSONA_ID_PREFIX`], which no builtin id uses.

use serde::{Deserialize, Serialize};
use tokio::sync::RwLock;
use uuid::Uuid;

use bc_ai_chat::system;

use crate::error::AgentError;

/// Id length bound, matched to the persona id field in [`crate::config`].
pub const MAX_PERSONA_ID_BYTES: usize = crate::config::MAX_PRESET_BYTES;
/// Same ceiling as a persona id, so a name can always carry one.
pub const MAX_PERSONA_NAME_BYTES: usize = crate::config::MAX_PRESET_BYTES;
pub const MAX_PERSONA_DESCRIPTION_BYTES: usize = 1024;
/// Exactly the provider's own system-prompt bound: a prompt that validates
/// here can never be refused downstream for its length.
pub const MAX_PERSONA_SYSTEM_PROMPT_BYTES: usize = bc_ai_provider::limits::MAX_SYSTEM_PROMPT_BYTES;
/// Caps retained persona text at roughly 16 MiB, in line with the retention
/// ceilings in `bc_ai_chat::limits`.
pub const MAX_CUSTOM_PERSONAS: usize = 64;

/// Every id this backend issues starts with this; no builtin id does.
pub const CUSTOM_PERSONA_ID_PREFIX: &str = "custom-";

/// A persona as exposed to the renderer.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiPersona {
    pub id: String,
    pub name: String,
    pub description: String,
    pub system_prompt: String,
    pub builtin: bool,
}

/// The renderer-supplied half of a persona.
///
/// `id` and `builtin` are deliberately absent: both are decided here, so a
/// create or update cannot claim an id or pass itself off as a builtin. Extra
/// fields are ignored rather than rejected, which lets a caller round-trip an
/// [`AiPersona`] straight back into an update.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiPersonaInput {
    pub name: String,
    pub description: String,
    pub system_prompt: String,
}

/// Builtin personas, in catalogue order.
pub fn builtin_personas() -> Vec<AiPersona> {
    crate::presets::available_presets()
        .into_iter()
        .map(|preset| AiPersona {
            id: preset.id,
            name: preset.name,
            description: preset.description,
            system_prompt: preset.system_prompt,
            builtin: true,
        })
        .collect()
}

/// Whether an id names a builtin persona.
pub fn is_builtin_id(id: &str) -> bool {
    system::available_presets()
        .into_iter()
        .any(|(builtin, _)| builtin == id)
}

fn generate_custom_id() -> String {
    format!("{CUSTOM_PERSONA_ID_PREFIX}{}", Uuid::new_v4().simple())
}

fn invalid(field: &'static str, message: impl Into<String>) -> AgentError {
    AgentError::InvalidPersona {
        field,
        message: message.into(),
    }
}

/// Reject ids that could not have come from this backend before they are used
/// as a lookup key or echoed back to the renderer.
pub fn validate_persona_id(id: &str) -> Result<(), AgentError> {
    if id.is_empty() || id.len() > MAX_PERSONA_ID_BYTES {
        return Err(invalid(
            "id",
            format!("must contain between 1 and {MAX_PERSONA_ID_BYTES} bytes"),
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

/// Control characters are refused in every persona field. A name or
/// description carrying them corrupts the UI, and a system prompt carrying
/// them can forge message structure in the prompt it is pasted into. Line
/// breaks and tabs stay legal in the prompt itself, which is prose.
fn validate_text(
    field: &'static str,
    value: &str,
    limit: usize,
    multiline: bool,
) -> Result<(), AgentError> {
    if value.len() > limit {
        return Err(invalid(field, format!("must not exceed {limit} bytes")));
    }
    let forbidden = value
        .chars()
        .any(|value| value.is_control() && !(multiline && matches!(value, '\n' | '\r' | '\t')));
    if forbidden {
        return Err(invalid(
            field,
            if multiline {
                "must not contain control characters other than tab, carriage return or newline"
            } else {
                "must not contain control characters"
            },
        ));
    }
    Ok(())
}

fn validate_input(input: &AiPersonaInput) -> Result<(), AgentError> {
    validate_text("name", &input.name, MAX_PERSONA_NAME_BYTES, false)?;
    if input.name.trim().is_empty() {
        return Err(invalid("name", "must not be empty"));
    }
    validate_text(
        "description",
        &input.description,
        MAX_PERSONA_DESCRIPTION_BYTES,
        false,
    )?;
    validate_text(
        "systemPrompt",
        &input.system_prompt,
        MAX_PERSONA_SYSTEM_PROMPT_BYTES,
        true,
    )?;
    if input.system_prompt.trim().is_empty() {
        return Err(invalid("systemPrompt", "must not be empty"));
    }
    Ok(())
}

/// Bounded store of custom personas. Builtins are not stored; they are
/// computed, so they cannot be mutated through this type at all.
#[derive(Default)]
pub struct PersonaStore {
    custom: RwLock<Vec<AiPersona>>,
}

impl PersonaStore {
    /// Builtins first, then custom personas in creation order.
    pub async fn list(&self) -> Vec<AiPersona> {
        let mut personas = builtin_personas();
        personas.extend(self.custom.read().await.iter().cloned());
        personas
    }

    /// Create a custom persona with a freshly issued id.
    pub async fn create(&self, input: AiPersonaInput) -> Result<AiPersona, AgentError> {
        validate_input(&input)?;
        let mut custom = self.custom.write().await;
        if custom.len() >= MAX_CUSTOM_PERSONAS {
            return Err(AgentError::PersonaLimit {
                limit: MAX_CUSTOM_PERSONAS,
                actual: custom.len().saturating_add(1),
            });
        }
        let persona = AiPersona {
            id: generate_custom_id(),
            name: input.name,
            description: input.description,
            system_prompt: input.system_prompt,
            builtin: false,
        };
        custom.push(persona.clone());
        Ok(persona)
    }

    /// Replace the editable fields of an existing custom persona.
    pub async fn update(&self, id: &str, input: AiPersonaInput) -> Result<AiPersona, AgentError> {
        validate_persona_id(id)?;
        if is_builtin_id(id) {
            return Err(AgentError::PersonaImmutable);
        }
        validate_input(&input)?;
        let mut custom = self.custom.write().await;
        let persona = custom
            .iter_mut()
            .find(|persona| persona.id == id)
            .ok_or(AgentError::PersonaNotFound)?;
        persona.name = input.name;
        persona.description = input.description;
        persona.system_prompt = input.system_prompt;
        Ok(persona.clone())
    }

    /// Remove a custom persona.
    pub async fn delete(&self, id: &str) -> Result<(), AgentError> {
        validate_persona_id(id)?;
        if is_builtin_id(id) {
            return Err(AgentError::PersonaImmutable);
        }
        let mut custom = self.custom.write().await;
        let before = custom.len();
        custom.retain(|persona| persona.id != id);
        if custom.len() == before {
            return Err(AgentError::PersonaNotFound);
        }
        Ok(())
    }

    /// System prompt for a persona id, or `None` when nothing matches.
    pub async fn system_prompt(&self, id: &str) -> Option<String> {
        if let Some(builtin) = builtin_personas()
            .into_iter()
            .find(|persona| persona.id == id)
        {
            return Some(builtin.system_prompt);
        }
        self.custom
            .read()
            .await
            .iter()
            .find(|persona| persona.id == id)
            .map(|persona| persona.system_prompt.clone())
    }

    /// Number of stored custom personas.
    pub async fn custom_count(&self) -> usize {
        self.custom.read().await.len()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn input(name: &str) -> AiPersonaInput {
        AiPersonaInput {
            name: name.into(),
            description: "A bounded persona".into(),
            system_prompt: "You are a careful DNS assistant.\nBe brief.".into(),
        }
    }

    #[tokio::test]
    async fn builtins_come_first_and_are_marked_builtin() {
        let store = PersonaStore::default();
        let created = store.create(input("Mine")).await.expect("create");
        let personas = store.list().await;

        let builtin_count = builtin_personas().len();
        assert_eq!(personas.len(), builtin_count + 1);
        assert!(personas[..builtin_count]
            .iter()
            .all(|persona| persona.builtin));
        assert_eq!(personas[0].id, crate::config::DEFAULT_PERSONA_ID);
        assert_eq!(personas[builtin_count].id, created.id);
        assert!(!personas[builtin_count].builtin);
        assert!(!personas[0].system_prompt.is_empty());
    }

    #[tokio::test]
    async fn builtins_cannot_be_updated_or_deleted() {
        let store = PersonaStore::default();
        for builtin in builtin_personas() {
            assert!(matches!(
                store.update(&builtin.id, input("Hijacked")).await,
                Err(AgentError::PersonaImmutable)
            ));
            assert!(matches!(
                store.delete(&builtin.id).await,
                Err(AgentError::PersonaImmutable)
            ));
        }
        // Nothing was shadowed or appended by the attempts.
        assert_eq!(store.custom_count().await, 0);
        assert_eq!(store.list().await.len(), builtin_personas().len());
        for builtin in builtin_personas() {
            assert_eq!(
                store.system_prompt(&builtin.id).await.as_deref(),
                Some(builtin.system_prompt.as_str())
            );
        }
    }

    #[tokio::test]
    async fn issued_ids_cannot_impersonate_a_builtin() {
        let store = PersonaStore::default();
        for index in 0..16 {
            let persona = store
                .create(input(&format!("P{index}")))
                .await
                .expect("create");
            assert!(persona.id.starts_with(CUSTOM_PERSONA_ID_PREFIX));
            assert!(!is_builtin_id(&persona.id));
            assert!(!persona.builtin);
            validate_persona_id(&persona.id).expect("issued ids are well formed");
        }
    }

    #[tokio::test]
    async fn a_create_cannot_claim_an_id_or_builtin_status() {
        let input: AiPersonaInput = serde_json::from_value(serde_json::json!({
            "id": "default",
            "builtin": true,
            "name": "Impostor",
            "description": "",
            "systemPrompt": "Pretend to be the default persona.",
        }))
        .expect("extra fields are ignored");
        let store = PersonaStore::default();
        let persona = store.create(input).await.expect("create");
        assert_ne!(persona.id, "default");
        assert!(persona.id.starts_with(CUSTOM_PERSONA_ID_PREFIX));
        assert!(!persona.builtin);
    }

    #[tokio::test]
    async fn oversized_and_control_character_fields_are_refused() {
        let store = PersonaStore::default();
        let cases: Vec<(&'static str, AiPersonaInput)> = vec![
            (
                "name",
                AiPersonaInput {
                    name: "n".repeat(MAX_PERSONA_NAME_BYTES + 1),
                    ..input("x")
                },
            ),
            (
                "name",
                AiPersonaInput {
                    name: "two\nlines".into(),
                    ..input("x")
                },
            ),
            (
                "name",
                AiPersonaInput {
                    name: "   ".into(),
                    ..input("x")
                },
            ),
            (
                "description",
                AiPersonaInput {
                    description: "d".repeat(MAX_PERSONA_DESCRIPTION_BYTES + 1),
                    ..input("x")
                },
            ),
            (
                "description",
                AiPersonaInput {
                    description: "tabbed\tdescription".into(),
                    ..input("x")
                },
            ),
            (
                "systemPrompt",
                AiPersonaInput {
                    system_prompt: "s".repeat(MAX_PERSONA_SYSTEM_PROMPT_BYTES + 1),
                    ..input("x")
                },
            ),
            (
                "systemPrompt",
                AiPersonaInput {
                    system_prompt: "nul\u{0}byte".into(),
                    ..input("x")
                },
            ),
            (
                "systemPrompt",
                AiPersonaInput {
                    system_prompt: "escape\u{1b}[0m".into(),
                    ..input("x")
                },
            ),
            (
                "systemPrompt",
                AiPersonaInput {
                    system_prompt: "\n\t ".into(),
                    ..input("x")
                },
            ),
        ];

        for (field, candidate) in cases {
            let error = store
                .create(candidate)
                .await
                .expect_err("invalid persona must be refused");
            match error {
                AgentError::InvalidPersona { field: actual, .. } => assert_eq!(actual, field),
                other => panic!("expected an InvalidPersona for {field}, got {other:?}"),
            }
        }
        assert_eq!(store.custom_count().await, 0);
    }

    #[tokio::test]
    async fn multiline_prompts_and_empty_descriptions_are_allowed() {
        let store = PersonaStore::default();
        let persona = store
            .create(AiPersonaInput {
                name: "Line breaks".into(),
                description: String::new(),
                system_prompt: "Line one.\r\n\tLine two.".into(),
            })
            .await
            .expect("prose is allowed in a prompt");
        assert_eq!(persona.system_prompt, "Line one.\r\n\tLine two.");
    }

    #[tokio::test]
    async fn the_custom_persona_limit_is_enforced() {
        let store = PersonaStore::default();
        for index in 0..MAX_CUSTOM_PERSONAS {
            store
                .create(input(&format!("P{index}")))
                .await
                .expect("within the limit");
        }
        assert!(matches!(
            store.create(input("one too many")).await,
            Err(AgentError::PersonaLimit {
                limit: MAX_CUSTOM_PERSONAS,
                ..
            })
        ));
        assert_eq!(store.custom_count().await, MAX_CUSTOM_PERSONAS);
    }

    #[tokio::test]
    async fn unknown_and_malformed_ids_are_distinguished() {
        let store = PersonaStore::default();
        assert!(matches!(
            store.update("custom-0123456789abcdef", input("x")).await,
            Err(AgentError::PersonaNotFound)
        ));
        assert!(matches!(
            store.delete("custom-0123456789abcdef").await,
            Err(AgentError::PersonaNotFound)
        ));
        assert!(matches!(
            store.delete("../../etc/passwd").await,
            Err(AgentError::InvalidPersona { field: "id", .. })
        ));
        assert!(matches!(
            store.delete(&"c".repeat(MAX_PERSONA_ID_BYTES + 1)).await,
            Err(AgentError::InvalidPersona { field: "id", .. })
        ));
        assert_eq!(store.system_prompt("custom-nope").await, None);
    }

    #[tokio::test]
    async fn an_update_rewrites_only_the_editable_fields() {
        let store = PersonaStore::default();
        let created = store.create(input("Before")).await.expect("create");
        let updated = store
            .update(
                &created.id,
                AiPersonaInput {
                    name: "After".into(),
                    description: "Updated".into(),
                    system_prompt: "New prompt.".into(),
                },
            )
            .await
            .expect("update");

        assert_eq!(updated.id, created.id);
        assert!(!updated.builtin);
        assert_eq!(updated.name, "After");
        assert_eq!(updated.system_prompt, "New prompt.");
        assert_eq!(
            store.system_prompt(&created.id).await.as_deref(),
            Some("New prompt.")
        );
        assert_eq!(store.custom_count().await, 1);
    }

    #[tokio::test]
    async fn an_invalid_update_leaves_the_stored_persona_untouched() {
        let store = PersonaStore::default();
        let created = store.create(input("Keep me")).await.expect("create");
        let error = store
            .update(
                &created.id,
                AiPersonaInput {
                    name: "Broken\u{0}".into(),
                    ..input("x")
                },
            )
            .await
            .expect_err("control characters must be refused");
        assert!(matches!(
            error,
            AgentError::InvalidPersona { field: "name", .. }
        ));
        assert_eq!(
            store.list().await.last().expect("custom persona").name,
            "Keep me"
        );
    }

    #[test]
    fn the_wire_format_is_camel_case() {
        let value = serde_json::to_value(AiPersona {
            id: "custom-1".into(),
            name: "Mine".into(),
            description: "Desc".into(),
            system_prompt: "Prompt".into(),
            builtin: false,
        })
        .expect("serializes");
        assert_eq!(value["systemPrompt"], "Prompt");
        assert_eq!(value["builtin"], false);
        assert!(value.get("system_prompt").is_none(), "snake_case leaked");
    }
}
