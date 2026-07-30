//! Bounded conversation-retention policy shared by managers and stores.

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

pub(crate) fn validate_chat_message(message: &ChatMessage) -> Result<(), ChatError> {
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
    let retained_bytes = message_retained_bytes(message);
    if retained_bytes > MAX_CHAT_MESSAGE_BYTES {
        return Err(ChatError::LimitExceeded {
            resource: "retained chat message",
            limit: MAX_CHAT_MESSAGE_BYTES,
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

pub(crate) fn validate_conversation_metadata(conversation: &Conversation) -> Result<(), ChatError> {
    if conversation.model.is_empty() {
        return Err(ChatError::InvalidField {
            field: "model",
            message: "must not be empty".into(),
        });
    }
    validate_string("conversation model", &conversation.model, MAX_MODEL_BYTES)
        .map_err(provider_error)?;
    validate_string("conversation title", &conversation.title, MAX_TITLE_BYTES)
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

pub(crate) fn validate_conversation(conversation: &Conversation) -> Result<(), ChatError> {
    validate_conversation_metadata(conversation)?;
    for message in &conversation.messages {
        validate_chat_message(message)?;
    }
    Ok(())
}

pub(crate) fn enforce_conversation_limits(conversation: &mut Conversation) -> Vec<uuid::Uuid> {
    let mut evicted = Vec::new();
    while conversation.messages.len() > MAX_MESSAGES_PER_CONVERSATION
        || conversation_retained_bytes(conversation) > MAX_CONVERSATION_BYTES
    {
        if conversation.messages.is_empty() {
            break;
        }
        evicted.push(conversation.messages.remove(0).id);
    }
    evicted
}
