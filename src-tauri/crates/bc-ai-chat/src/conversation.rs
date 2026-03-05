//! Conversation manager – the core state holder.
//!
//! Follows the `Manager` pattern used across the Tauri app: a struct with
//! `Default` implementation, interior `RwLock`-based mutability, registered
//! via `.manage()`.

use std::collections::HashMap;
use tokio::sync::RwLock;
use uuid::Uuid;

use crate::types::{ChatMessage, Conversation, ConversationMeta};
use bc_ai_provider::ProviderKind;

/// Chat manager holding all active conversations.
#[derive(Default)]
pub struct ChatManager {
    conversations: RwLock<HashMap<Uuid, Conversation>>,
}

impl ChatManager {
    /// Create a new conversation with the given provider and model.
    pub async fn create_conversation(
        &self,
        provider: ProviderKind,
        model: String,
        title: Option<String>,
        system_prompt: Option<String>,
    ) -> ConversationMeta {
        let mut conv = Conversation::new(provider, model);
        if let Some(t) = title {
            conv = conv.with_title(t);
        }
        if let Some(sp) = system_prompt {
            conv = conv.with_system_prompt(sp);
        }
        let meta = conv.meta();
        let mut convs = self.conversations.write().await;
        convs.insert(conv.id, conv);
        meta
    }

    /// List all conversations (metadata only).
    pub async fn list_conversations(&self) -> Vec<ConversationMeta> {
        let convs = self.conversations.read().await;
        let mut list: Vec<ConversationMeta> = convs.values().map(|c| c.meta()).collect();
        list.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
        list
    }

    /// Get a full conversation by ID.
    pub async fn get_conversation(&self, id: Uuid) -> Option<Conversation> {
        let convs = self.conversations.read().await;
        convs.get(&id).cloned()
    }

    /// Delete a conversation.
    pub async fn delete_conversation(&self, id: Uuid) -> bool {
        let mut convs = self.conversations.write().await;
        convs.remove(&id).is_some()
    }

    /// Add a message to a conversation.
    pub async fn push_message(&self, conversation_id: Uuid, message: ChatMessage) -> bool {
        let mut convs = self.conversations.write().await;
        if let Some(conv) = convs.get_mut(&conversation_id) {
            conv.push_message(message);
            true
        } else {
            false
        }
    }

    /// Update the last assistant message in a conversation (for streaming).
    pub async fn update_last_assistant_message<F>(&self, conversation_id: Uuid, updater: F) -> bool
    where
        F: FnOnce(&mut ChatMessage),
    {
        let mut convs = self.conversations.write().await;
        if let Some(conv) = convs.get_mut(&conversation_id) {
            if let Some(last) = conv.messages.last_mut() {
                if last.message.role == bc_ai_provider::Role::Assistant {
                    updater(last);
                    conv.updated_at = chrono::Utc::now();
                    return true;
                }
            }
        }
        false
    }

    /// Update conversation title.
    pub async fn set_title(&self, id: Uuid, title: String) -> bool {
        let mut convs = self.conversations.write().await;
        if let Some(conv) = convs.get_mut(&id) {
            conv.title = title;
            conv.updated_at = chrono::Utc::now();
            true
        } else {
            false
        }
    }

    /// Get provider messages for sending to LLM.
    pub async fn provider_messages(&self, id: Uuid) -> Option<Vec<bc_ai_provider::Message>> {
        let convs = self.conversations.read().await;
        convs.get(&id).map(|c| c.provider_messages())
    }

    /// Get conversation system prompt.
    pub async fn system_prompt(&self, id: Uuid) -> Option<String> {
        let convs = self.conversations.read().await;
        convs
            .get(&id)
            .and_then(|c| c.system_prompt.clone())
    }

    /// Count total conversations.
    pub async fn count(&self) -> usize {
        self.conversations.read().await.len()
    }

    /// Clear all conversations.
    pub async fn clear(&self) {
        self.conversations.write().await.clear();
    }
}
