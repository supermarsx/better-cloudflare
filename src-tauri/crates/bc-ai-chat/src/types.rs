//! Chat-specific types for conversation management.

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use bc_ai_provider::{Message, ToolCall, Usage};

use crate::error::ChatError;
use crate::limits::{enforce_conversation_limits, validate_chat_message, ChatLimits};

/// Status of an individual chat message.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum MessageStatus {
    /// Being sent / waiting for response.
    Pending,
    /// Streaming in progress.
    Streaming,
    /// Completed successfully.
    Complete,
    /// An error occurred.
    Error { message: String },
    /// Cancelled by user.
    Cancelled,
}

/// What one turn ran under, recorded on the messages it produced.
///
/// **This is the attribution a transcript is read with.** The conversation's
/// own `provider`, `model` and `persona_id` say what the *next* turn will use;
/// once they can be changed mid-conversation they stop describing the
/// transcript, and an assistant answer credited to the wrong model is a
/// correctness problem rather than a cosmetic one. So the answer travels with
/// the message instead of being inferred from the conversation, which also
/// means retention cannot orphan it: evicting the oldest messages takes their
/// attribution with them and leaves every surviving message still able to say
/// which model wrote it.
///
/// The two `missing_*` fields are how a vanished selection degrades honestly.
/// A persona or a provider profile can be deleted while a conversation still
/// names it; the turn then runs under the fallback, and these record what was
/// asked for so the transcript shows the substitution rather than hiding it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MessageOrigin {
    /// Id of the provider profile the turn actually ran against.
    pub provider: String,
    /// The model the turn actually asked for.
    pub model: String,
    /// The persona whose system prompt the turn sent.
    ///
    /// `None` means no persona prompt was sent at all: either nothing
    /// resolved, or the conversation carries its own system prompt, which
    /// outranks a persona outright.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub persona_id: Option<String>,
    /// A persona the conversation named that no longer exists. The turn ran
    /// under [`Self::persona_id`] instead.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub missing_persona_id: Option<String>,
    /// A provider profile the conversation named that was no longer
    /// configured. The turn ran against [`Self::provider`] instead.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub missing_provider_id: Option<String>,
}

/// A single chat message with metadata.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatMessage {
    /// Unique message identifier.
    pub id: Uuid,
    /// The underlying provider message.
    pub message: Message,
    /// Current status.
    pub status: MessageStatus,
    /// When the message was created.
    pub created_at: DateTime<Utc>,
    /// Token usage (once response is complete).
    pub usage: Option<Usage>,
    /// Any pending tool calls requiring approval.
    pub pending_tool_calls: Vec<ToolCall>,
    /// What produced this message — see [`MessageOrigin`].
    ///
    /// `None` on a message recorded before the conversation's provider, model
    /// and persona could change, and on a tool result: a tool result is the
    /// mechanical record of a call rather than something a model said, and
    /// stamping one would need a second resolution on the approval path whose
    /// answer could disagree with the turn's.
    ///
    /// Skipped on the wire when absent rather than serialized as `null`, so
    /// an export of an older transcript is unchanged by this field existing.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub origin: Option<MessageOrigin>,
}

impl ChatMessage {
    /// Create a new user message.
    pub fn user(text: impl Into<String>) -> Self {
        Self {
            id: Uuid::new_v4(),
            message: Message::user(text),
            status: MessageStatus::Complete,
            created_at: Utc::now(),
            usage: None,
            pending_tool_calls: Vec::new(),
            origin: None,
        }
    }

    /// Create a pending assistant message (pre-stream).
    pub fn assistant_pending() -> Self {
        Self {
            id: Uuid::new_v4(),
            message: Message::assistant(""),
            status: MessageStatus::Pending,
            created_at: Utc::now(),
            usage: None,
            pending_tool_calls: Vec::new(),
            origin: None,
        }
    }

    /// Record what this message was produced under.
    ///
    /// A builder rather than a constructor parameter so that a caller with no
    /// turn to attribute — a tool result, or a test — keeps the shorter form
    /// and cannot be made to invent an origin to satisfy a signature.
    #[must_use]
    pub fn with_origin(mut self, origin: MessageOrigin) -> Self {
        self.origin = Some(origin);
        self
    }
}

/// Lightweight metadata for conversation listing.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConversationMeta {
    pub id: Uuid,
    pub title: String,
    /// Id of the provider profile the conversation will send through next.
    pub provider: String,
    pub model: String,
    /// The conversation's own persona, or `None` for the configured one.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub persona_id: Option<String>,
    pub message_count: usize,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

/// Full conversation including all messages.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Conversation {
    pub id: Uuid,
    pub title: String,
    /// Id of the provider profile the conversation will send through next.
    ///
    /// A profile id, not a protocol: provider identity is user-defined, so
    /// this names which connection the conversation is pointed at.
    /// Conversations stored before profiles existed hold a bare protocol name
    /// (`"openai"`), which is also a well-formed id, so both spellings load
    /// and validate.
    ///
    /// **This is the selection in force, not a description of the
    /// transcript.** It was both while provider and model were fixed at
    /// creation; now that they can be changed mid-conversation, what each
    /// individual message ran under is recorded on the message itself — see
    /// [`MessageOrigin`].
    pub provider: String,
    pub model: String,
    pub system_prompt: Option<String>,
    /// The persona this conversation is set to, or `None` to use the
    /// configured one.
    ///
    /// `None` is the pre-existing behaviour and must stay indistinguishable
    /// from it: a conversation that has never chosen a persona runs under
    /// `AgentConfig::persona_id` exactly as every conversation did before
    /// this field existed. An id naming a persona that has since been deleted
    /// is kept rather than scrubbed — the fallback and the substitution are
    /// reported at send time, which is more honest than silently rewriting
    /// the user's choice.
    ///
    /// Outranked by [`Self::system_prompt`], which is the conversation's
    /// literal prompt and therefore the more specific instruction of the two.
    #[serde(default)]
    pub persona_id: Option<String>,
    pub messages: Vec<ChatMessage>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

/// What a conversation is pointed at, read under one lock.
///
/// Exists so a turn resolves its provider, model, prompt and persona from one
/// consistent snapshot. Reading them one accessor at a time was harmless while
/// they were fixed at creation; with mid-conversation switching it would let a
/// turn mix a prompt from before a switch with a model from after it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ConversationRouting {
    pub provider: String,
    pub model: String,
    pub system_prompt: Option<String>,
    pub persona_id: Option<String>,
}

impl Conversation {
    /// Create a new conversation.
    pub fn new(provider: impl Into<String>, model: String) -> Self {
        let now = Utc::now();
        Self {
            id: Uuid::new_v4(),
            title: "New conversation".into(),
            provider: provider.into(),
            model,
            system_prompt: None,
            persona_id: None,
            messages: Vec::new(),
            created_at: now,
            updated_at: now,
        }
    }

    /// Create a conversation with a specific title.
    pub fn with_title(mut self, title: impl Into<String>) -> Self {
        self.title = title.into();
        self
    }

    /// Set the system prompt.
    pub fn with_system_prompt(mut self, prompt: impl Into<String>) -> Self {
        self.system_prompt = Some(prompt.into());
        self
    }

    /// Point the conversation at a persona.
    pub fn with_persona(mut self, persona_id: impl Into<String>) -> Self {
        self.persona_id = Some(persona_id.into());
        self
    }

    /// Add a message and update the timestamp.
    pub fn push_message(&mut self, msg: ChatMessage) {
        let _ = self.try_push_message(msg);
    }

    /// Add a validated message and evict the oldest retained messages as
    /// needed, against the hard ceilings.
    ///
    /// A conversation on its own knows nothing about the user's configured
    /// limits; [`Self::try_push_message_within`] is the variant that does.
    pub fn try_push_message(&mut self, msg: ChatMessage) -> Result<Vec<Uuid>, ChatError> {
        self.try_push_message_within(msg, &ChatLimits::default())
    }

    /// [`Self::try_push_message`] against the user's configured limits.
    pub fn try_push_message_within(
        &mut self,
        msg: ChatMessage,
        limits: &ChatLimits,
    ) -> Result<Vec<Uuid>, ChatError> {
        validate_chat_message(&msg, limits)?;
        self.updated_at = Utc::now();
        self.messages.push(msg);
        Ok(enforce_conversation_limits(self, limits))
    }

    /// Get lightweight metadata for listing.
    pub fn meta(&self) -> ConversationMeta {
        ConversationMeta {
            id: self.id,
            title: self.title.clone(),
            provider: self.provider.clone(),
            model: self.model.clone(),
            persona_id: self.persona_id.clone(),
            message_count: self.messages.len(),
            created_at: self.created_at,
            updated_at: self.updated_at,
        }
    }

    /// What the next turn in this conversation is pointed at.
    pub fn routing(&self) -> ConversationRouting {
        ConversationRouting {
            provider: self.provider.clone(),
            model: self.model.clone(),
            system_prompt: self.system_prompt.clone(),
            persona_id: self.persona_id.clone(),
        }
    }

    /// Extract provider-format messages for sending to LLM.
    pub fn provider_messages(&self) -> Vec<Message> {
        self.messages.iter().map(|m| m.message.clone()).collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The frontend reads an exported transcript and the live conversation
    /// through the same shapes, and it filters on camelCase keys. A
    /// snake_case field here is not a cosmetic slip: `personaId` arriving as
    /// `persona_id` makes the renderer see a conversation with no persona and
    /// quietly offer to set the one that is already set.
    #[test]
    fn the_new_fields_reach_the_wire_in_camel_case() {
        let message = ChatMessage::user("hi").with_origin(MessageOrigin {
            provider: "openai-main".into(),
            model: "gpt-4o-mini".into(),
            persona_id: Some("dns-expert".into()),
            missing_persona_id: Some("custom-gone".into()),
            missing_provider_id: Some("groq-fast".into()),
        });
        let value = serde_json::to_value(&message).expect("serializes");
        let origin = &value["origin"];
        assert_eq!(origin["provider"], "openai-main");
        assert_eq!(origin["model"], "gpt-4o-mini");
        assert_eq!(origin["personaId"], "dns-expert");
        assert_eq!(origin["missingPersonaId"], "custom-gone");
        assert_eq!(origin["missingProviderId"], "groq-fast");
        for snake in ["persona_id", "missing_persona_id", "missing_provider_id"] {
            assert!(
                origin.get(snake).is_none(),
                "snake_case field `{snake}` leaked: {value}"
            );
        }

        let conversation =
            Conversation::new("openai-main", "gpt-4o-mini".into()).with_persona("security-auditor");
        let value = serde_json::to_value(&conversation).expect("serializes");
        assert_eq!(value["personaId"], "security-auditor");
        assert!(value.get("persona_id").is_none(), "snake_case leaked");
        assert_eq!(
            serde_json::to_value(conversation.meta()).expect("serializes")["personaId"],
            "security-auditor"
        );
    }

    /// An absent attribution is absent from the wire, not present as `null`.
    ///
    /// Two reasons it is worth pinning. An export of a transcript recorded
    /// before attribution existed is byte-identical to what it was, so this
    /// field cannot be mistaken for a change to the records themselves. And
    /// the TypeScript side types it as an optional property, which `null`
    /// does not satisfy.
    #[test]
    fn an_unattributed_message_carries_no_origin_key_at_all() {
        let value = serde_json::to_value(ChatMessage::user("hi")).expect("serializes");
        assert!(
            value.get("origin").is_none(),
            "an absent origin must not serialize as null: {value}"
        );

        // And it round-trips from a payload that never had the key, which is
        // every stored transcript written before this field.
        let restored: ChatMessage = serde_json::from_value(value).expect("deserializes");
        assert_eq!(restored.origin, None);

        let meta =
            serde_json::to_value(Conversation::new("openai-main", "gpt-4o-mini".into()).meta())
                .expect("serializes");
        assert!(meta.get("personaId").is_none(), "{meta}");
    }

    /// A stored conversation loads the persona it carries, and loads as
    /// "use the configured one" when it carries none.
    ///
    /// Both halves, because only together do they pin anything: serde reads a
    /// missing `Option` field as `None` on its own, so the absent case alone
    /// would pass however this field were spelled. The present case is what
    /// fails if the wire name ever stops matching — and a transcript that
    /// quietly forgot its persona would run the next turn under a different
    /// prompt than the one the user chose.
    #[test]
    fn a_stored_conversation_round_trips_its_persona_and_its_absence() {
        let payload = |persona: Option<&str>| {
            let mut value = serde_json::json!({
                "id": uuid::Uuid::nil(),
                "title": "Stored transcript",
                "provider": "openai",
                "model": "gpt-4o-mini",
                "systemPrompt": null,
                "messages": [],
                "createdAt": "2026-01-01T00:00:00Z",
                "updatedAt": "2026-01-01T00:00:00Z",
            });
            if let Some(persona) = persona {
                value["personaId"] = serde_json::json!(persona);
            }
            value
        };

        let carried: Conversation =
            serde_json::from_value(payload(Some("dns-expert"))).expect("a stored persona loads");
        assert_eq!(carried.persona_id.as_deref(), Some("dns-expert"));
        assert_eq!(
            carried.routing().persona_id.as_deref(),
            Some("dns-expert"),
            "a turn resolves its persona through the routing snapshot"
        );

        // The pre-existing shape: no persona at all, which is indistinguishable
        // from every conversation stored before one could be chosen.
        let older: Conversation =
            serde_json::from_value(payload(None)).expect("an older payload still loads");
        assert_eq!(older.persona_id, None);
        assert_eq!(older.routing().persona_id, None);
    }
}
