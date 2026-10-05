//! Bounded conversation-retention policy shared by managers and stores.
//!
//! Every `MAX_*` constant below is a **hard ceiling**, not a default waiting
//! to be replaced. A user may lower any of them through [`ChatLimits`], and
//! may never raise one: [`ChatLimits::clamped`] folds a configured value into
//! `1..=CEILING`, and the setters are the only way to install one, so a
//! setting cannot turn a memory bound into a suggestion.
//!
//! Every byte limit counts **UTF-8 bytes**, not characters — the same unit
//! the provider crate's limits use, because these numbers ultimately bound
//! what is held in memory and what goes on the wire.

use bc_ai_provider::limits::{
    serialized_len_limited, validate_message, validate_string, MAX_MESSAGE_BYTES, MAX_MODEL_BYTES,
    MAX_SYSTEM_PROMPT_BYTES, MAX_TOOL_ARGUMENT_BYTES, MAX_TOOL_CALLS_PER_MESSAGE,
    MAX_TOOL_CALL_ID_BYTES, MAX_TOOL_NAME_BYTES,
};
use bc_ai_provider::{MessageContent, ToolCall};

use crate::error::ChatError;
use crate::types::{ChatMessage, Conversation, MessageStatus};

pub const MAX_CONVERSATIONS: usize = 128;
pub const MAX_MESSAGES_PER_CONVERSATION: usize = 256;
pub const MAX_CHAT_MESSAGE_BYTES: usize = 1024 * 1024;
pub const MAX_CONVERSATION_BYTES: usize = 4 * 1024 * 1024;
pub const MAX_GLOBAL_RETAINED_BYTES: usize = 32 * 1024 * 1024;
pub const MAX_TITLE_BYTES: usize = 512;
pub const MAX_STATUS_ERROR_BYTES: usize = 64 * 1024;

/// How many retained items one write may evict to honour a *configured*
/// limit that sits below its hard ceiling.
///
/// The ceilings themselves are enforced with no such bound — they exist to
/// bound memory, so nothing may be retained above them. A configured limit is
/// a user preference, and a preference must not reach back and delete
/// history: lowering "max conversations" from 128 to 5 with 40 stored stops
/// the store growing immediately and then walks it down at most one
/// conversation per write, which is the same thing the ceiling would have
/// done on that write anyway. Typing a smaller number must never cost
/// somebody 35 transcripts.
pub const MAX_CONFIGURED_EVICTIONS_PER_WRITE: usize = 1;

/// User-configurable retention limits, each one bounded by the constant of
/// the same name above.
///
/// [`Default`] is every hard ceiling, so an install that configures nothing
/// behaves exactly as it did before these were configurable.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ChatLimits {
    /// Conversations retained at once.
    pub max_conversations: usize,
    /// Messages retained per conversation.
    pub max_messages_per_conversation: usize,
    /// UTF-8 bytes retained for one message. A message over this is
    /// **refused**, not trimmed: silently truncating what the user typed
    /// would be worse than telling them it is too long.
    pub max_chat_message_bytes: usize,
    /// UTF-8 bytes retained for one conversation.
    pub max_conversation_bytes: usize,
    /// UTF-8 bytes retained across every conversation.
    pub max_global_retained_bytes: usize,
    /// UTF-8 bytes in a conversation title.
    pub max_title_bytes: usize,
}

impl Default for ChatLimits {
    fn default() -> Self {
        Self {
            max_conversations: MAX_CONVERSATIONS,
            max_messages_per_conversation: MAX_MESSAGES_PER_CONVERSATION,
            max_chat_message_bytes: MAX_CHAT_MESSAGE_BYTES,
            max_conversation_bytes: MAX_CONVERSATION_BYTES,
            max_global_retained_bytes: MAX_GLOBAL_RETAINED_BYTES,
            max_title_bytes: MAX_TITLE_BYTES,
        }
    }
}

impl ChatLimits {
    /// Fold every field into `1..=CEILING`.
    ///
    /// Zero is not "unlimited", it is "retain nothing", which would make the
    /// store useless; and a value above the ceiling is the one case that must
    /// never be honoured, because the ceilings are what the code is built to
    /// survive. Clamping rather than rejecting is deliberate here: this is the
    /// last line, reached by stored configurations that were written before a
    /// ceiling moved and by any path that skipped validation.
    /// `AgentConfig::validate` rejects the same values by name first, so a
    /// user editing the settings form gets an error rather than a surprise.
    #[must_use]
    pub fn clamped(self) -> Self {
        Self {
            max_conversations: self.max_conversations.clamp(1, MAX_CONVERSATIONS),
            max_messages_per_conversation: self
                .max_messages_per_conversation
                .clamp(1, MAX_MESSAGES_PER_CONVERSATION),
            max_chat_message_bytes: self.max_chat_message_bytes.clamp(1, MAX_CHAT_MESSAGE_BYTES),
            max_conversation_bytes: self.max_conversation_bytes.clamp(1, MAX_CONVERSATION_BYTES),
            max_global_retained_bytes: self
                .max_global_retained_bytes
                .clamp(1, MAX_GLOBAL_RETAINED_BYTES),
            max_title_bytes: self.max_title_bytes.clamp(1, MAX_TITLE_BYTES),
        }
    }
}

fn provider_error(error: bc_ai_provider::AiProviderError) -> ChatError {
    match error {
        bc_ai_provider::AiProviderError::LimitExceeded {
            resource,
            limit,
            actual,
        } => ChatError::LimitExceeded {
            resource,
            limit,
            actual,
        },
        other => ChatError::InvalidField {
            field: "message",
            message: other.to_string(),
        },
    }
}

fn validate_tool_call(tool_call: &ToolCall) -> Result<usize, ChatError> {
    validate_string("tool-call id", &tool_call.id, MAX_TOOL_CALL_ID_BYTES)
        .map_err(provider_error)?;
    validate_string("tool name", &tool_call.name, MAX_TOOL_NAME_BYTES).map_err(provider_error)?;
    let arguments = serialized_len_limited(
        "tool-call arguments",
        &tool_call.arguments,
        MAX_TOOL_ARGUMENT_BYTES,
    )
    .map_err(provider_error)?;
    Ok(tool_call
        .id
        .len()
        .saturating_add(tool_call.name.len())
        .saturating_add(arguments))
}

pub(crate) fn validate_chat_message(
    message: &ChatMessage,
    limits: &ChatLimits,
) -> Result<(), ChatError> {
    validate_message(&message.message).map_err(provider_error)?;
    if let MessageStatus::Error { message } = &message.status {
        validate_string("message status error", message, MAX_STATUS_ERROR_BYTES)
            .map_err(provider_error)?;
    }
    if message.pending_tool_calls.len() > MAX_TOOL_CALLS_PER_MESSAGE {
        return Err(ChatError::LimitExceeded {
            resource: "pending tool calls",
            limit: MAX_TOOL_CALLS_PER_MESSAGE,
            actual: message.pending_tool_calls.len(),
        });
    }
    for tool_call in &message.pending_tool_calls {
        validate_tool_call(tool_call)?;
    }
    // The configured value is the one reported, so the error names the number
    // the user actually set rather than the ceiling they never see.
    let max_message_bytes = limits.clamped().max_chat_message_bytes;
    let retained_bytes = message_retained_bytes(message);
    if retained_bytes > max_message_bytes {
        return Err(ChatError::LimitExceeded {
            resource: "retained chat message",
            limit: max_message_bytes,
            actual: retained_bytes,
        });
    }
    Ok(())
}

pub(crate) fn message_retained_bytes(message: &ChatMessage) -> usize {
    let content_bytes = match &message.message.content {
        MessageContent::Text { text } => text.len(),
        MessageContent::ToolResult {
            tool_call_id,
            content,
            ..
        } => tool_call_id.len().saturating_add(content.len()),
        MessageContent::ToolUse { tool_calls } => tool_calls
            .iter()
            .map(|tool_call| validate_tool_call(tool_call).unwrap_or(MAX_MESSAGE_BYTES))
            .fold(0usize, usize::saturating_add),
    };
    let pending_bytes = message
        .pending_tool_calls
        .iter()
        .map(|tool_call| validate_tool_call(tool_call).unwrap_or(MAX_MESSAGE_BYTES))
        .fold(0usize, usize::saturating_add);
    let status_bytes = match &message.status {
        MessageStatus::Error { message } => message.len(),
        _ => 0,
    };
    128usize
        .saturating_add(content_bytes)
        .saturating_add(pending_bytes)
        .saturating_add(status_bytes)
        .saturating_add(message.message.tool_call_id.as_ref().map_or(0, String::len))
}

pub(crate) fn conversation_retained_bytes(conversation: &Conversation) -> usize {
    let message_bytes = conversation
        .messages
        .iter()
        .map(message_retained_bytes)
        .fold(0usize, usize::saturating_add);
    256usize
        .saturating_add(conversation.title.len())
        .saturating_add(conversation.model.len())
        .saturating_add(conversation.system_prompt.as_ref().map_or(0, String::len))
        .saturating_add(message_bytes)
}

pub(crate) fn validate_conversation_metadata(
    conversation: &Conversation,
    limits: &ChatLimits,
) -> Result<(), ChatError> {
    if conversation.model.is_empty() {
        return Err(ChatError::InvalidField {
            field: "model",
            message: "must not be empty".into(),
        });
    }
    // The provider is a user-defined profile id now, so it is bounded text
    // rather than a closed enum the deserializer could vet.
    bc_ai_provider::validate_provider_id(&conversation.provider).map_err(|error| match error {
        bc_ai_provider::AiProviderError::InvalidRequest { message, .. } => {
            ChatError::InvalidField {
                field: "provider",
                message,
            }
        }
        other => provider_error(other),
    })?;
    validate_string("conversation model", &conversation.model, MAX_MODEL_BYTES)
        .map_err(provider_error)?;
    validate_string(
        "conversation title",
        &conversation.title,
        limits.clamped().max_title_bytes,
    )
    .map_err(provider_error)?;
    if let Some(system_prompt) = &conversation.system_prompt {
        validate_string(
            "conversation system prompt",
            system_prompt,
            MAX_SYSTEM_PROMPT_BYTES,
        )
        .map_err(provider_error)?;
    }
    Ok(())
}

pub(crate) fn validate_conversation(
    conversation: &Conversation,
    limits: &ChatLimits,
) -> Result<(), ChatError> {
    validate_conversation_metadata(conversation, limits)?;
    for message in &conversation.messages {
        validate_chat_message(message, limits)?;
    }
    Ok(())
}

/// Trim one conversation back inside its retention limits, returning the ids
/// of the messages that were dropped.
///
/// Two passes, and the difference between them *is* the retention policy for
/// a lowered setting:
///
/// 1. The hard ceilings are enforced without bound, exactly as before these
///    limits became configurable. Memory stays bounded by the numbers the
///    code is built to survive.
/// 2. A configured limit below its ceiling is then enforced by a pass capped
///    at [`MAX_CONFIGURED_EVICTIONS_PER_WRITE`]. So a lowered setting stops
///    the conversation growing at once, and walks it down no faster than one
///    message per write — it never reaches back and deletes a history the
///    user already had.
pub(crate) fn enforce_conversation_limits(
    conversation: &mut Conversation,
    limits: &ChatLimits,
) -> Vec<uuid::Uuid> {
    let limits = limits.clamped();
    let mut evicted = evict_messages_until(
        conversation,
        MAX_MESSAGES_PER_CONVERSATION,
        MAX_CONVERSATION_BYTES,
        usize::MAX,
    );
    evicted.extend(evict_messages_until(
        conversation,
        limits.max_messages_per_conversation,
        limits.max_conversation_bytes,
        MAX_CONFIGURED_EVICTIONS_PER_WRITE,
    ));
    evicted
}

/// Drop the oldest messages until the conversation is inside both limits, or
/// `budget` messages have gone, whichever comes first.
fn evict_messages_until(
    conversation: &mut Conversation,
    max_messages: usize,
    max_bytes: usize,
    budget: usize,
) -> Vec<uuid::Uuid> {
    let mut evicted = Vec::new();
    while conversation.messages.len() > max_messages
        || conversation_retained_bytes(conversation) > max_bytes
    {
        if conversation.messages.is_empty() || evicted.len() >= budget {
            break;
        }
        evicted.push(conversation.messages.remove(0).id);
    }
    evicted
}
