//! Chat-specific types for conversation management.

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use bc_ai_provider::{Message, ProviderKind, ToolCall, Usage};

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
        }
    }
}

/// Lightweight metadata for conversation listing.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConversationMeta {
    pub id: Uuid,
    pub title: String,
    pub provider: ProviderKind,
    pub model: String,
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
    pub provider: ProviderKind,
    pub model: String,
    pub system_prompt: Option<String>,
    pub messages: Vec<ChatMessage>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

impl Conversation {
    /// Create a new conversation.
    pub fn new(provider: ProviderKind, model: String) -> Self {
        let now = Utc::now();
        Self {
            id: Uuid::new_v4(),
            title: "New conversation".into(),
            provider,
            model,
            system_prompt: None,
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

    /// Add a message and update the timestamp.
    pub fn push_message(&mut self, msg: ChatMessage) {
        self.updated_at = Utc::now();
        self.messages.push(msg);
    }

    /// Get lightweight metadata for listing.
    pub fn meta(&self) -> ConversationMeta {
        ConversationMeta {
            id: self.id,
            title: self.title.clone(),
            provider: self.provider.clone(),
            model: self.model.clone(),
            message_count: self.messages.len(),
            created_at: self.created_at,
            updated_at: self.updated_at,
        }
    }

    /// Extract provider-format messages for sending to LLM.
    pub fn provider_messages(&self) -> Vec<Message> {
        self.messages.iter().map(|m| m.message.clone()).collect()
    }
}
