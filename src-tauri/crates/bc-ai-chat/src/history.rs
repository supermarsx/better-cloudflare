//! Conversation persistence and retrieval.
//!
//! Provides a `ConversationStore` trait for pluggable storage backends.
//! The default `InMemoryStore` is used when no SQLite is configured.

use async_trait::async_trait;
use std::collections::HashMap;
use tokio::sync::RwLock;
use uuid::Uuid;

use crate::limits::{
    conversation_retained_bytes, validate_conversation_metadata, MAX_CONVERSATIONS,
    MAX_GLOBAL_RETAINED_BYTES, MAX_MESSAGES_PER_CONVERSATION,
};
use crate::types::{Conversation, ConversationMeta};

/// Abstract storage backend for conversations.
#[async_trait]
pub trait ConversationStore: Send + Sync {
    /// Save or update a conversation.
    async fn save(&self, conversation: &Conversation) -> Result<(), String>;

    /// Load a conversation by ID.
    async fn load(&self, id: Uuid) -> Result<Option<Conversation>, String>;

    /// List all conversations (metadata only).
    async fn list(&self) -> Result<Vec<ConversationMeta>, String>;

    /// Delete a conversation.
    async fn delete(&self, id: Uuid) -> Result<bool, String>;

    /// Export a conversation as JSON.
    async fn export(&self, id: Uuid) -> Result<Option<String>, String> {
        if let Some(conv) = self.load(id).await? {
            serde_json::to_string_pretty(&conv)
                .map(Some)
                .map_err(|e| e.to_string())
        } else {
            Ok(None)
        }
    }
}

/// In-memory conversation store for ephemeral sessions.
pub struct InMemoryStore {
    data: RwLock<HashMap<Uuid, Conversation>>,
}

impl Default for InMemoryStore {
    fn default() -> Self {
        Self {
            data: RwLock::new(HashMap::new()),
        }
    }
}

#[async_trait]
impl ConversationStore for InMemoryStore {
    async fn save(&self, conversation: &Conversation) -> Result<(), String> {
        validate_conversation_metadata(conversation).map_err(|error| error.to_string())?;
        let mut retained = Conversation {
            id: conversation.id,
            title: conversation.title.clone(),
            provider: conversation.provider.clone(),
            model: conversation.model.clone(),
            system_prompt: conversation.system_prompt.clone(),
            messages: Vec::new(),
            created_at: conversation.created_at,
            updated_at: conversation.updated_at,
        };
        let first_retained = conversation
            .messages
            .len()
            .saturating_sub(MAX_MESSAGES_PER_CONVERSATION);
        for message in &conversation.messages[first_retained..] {
            retained
                .try_push_message(message.clone())
                .map_err(|error| error.to_string())?;
        }
        retained.updated_at = conversation.updated_at;
        let mut data = self.data.write().await;
        data.insert(retained.id, retained);
        while data.len() > MAX_CONVERSATIONS
            || data
                .values()
                .map(conversation_retained_bytes)
                .fold(0usize, usize::saturating_add)
                > MAX_GLOBAL_RETAINED_BYTES
        {
            let Some(oldest_id) = data
                .values()
                .min_by_key(|conversation| {
                    (
                        conversation.updated_at,
                        conversation.created_at,
                        conversation.id,
                    )
                })
                .map(|conversation| conversation.id)
            else {
                break;
            };
            data.remove(&oldest_id);
        }
        Ok(())
    }

    async fn load(&self, id: Uuid) -> Result<Option<Conversation>, String> {
        let data = self.data.read().await;
        Ok(data.get(&id).cloned())
    }

    async fn list(&self) -> Result<Vec<ConversationMeta>, String> {
        let data = self.data.read().await;
        let mut metas: Vec<ConversationMeta> = data.values().map(|c| c.meta()).collect();
        metas.sort_by_key(|meta| std::cmp::Reverse((meta.updated_at, meta.id)));
        Ok(metas)
    }

    async fn delete(&self, id: Uuid) -> Result<bool, String> {
        let mut data = self.data.write().await;
        Ok(data.remove(&id).is_some())
    }
}

#[cfg(test)]
mod tests {
    use bc_ai_provider::ProviderKind;

    use super::*;
    use crate::limits::MAX_CONVERSATIONS;

    #[tokio::test]
    async fn store_evicts_deterministic_oldest_conversations() {
        let store = InMemoryStore::default();
        let mut ids = Vec::new();
        for index in 0..=MAX_CONVERSATIONS {
            let mut conversation = Conversation::new(ProviderKind::Ollama, "test".into())
                .with_title(format!("conversation-{index}"));
            conversation.created_at += chrono::Duration::milliseconds(index as i64);
            conversation.updated_at = conversation.created_at;
            ids.push(conversation.id);
            store.save(&conversation).await.expect("bounded save");
        }

        assert!(store.load(ids[0]).await.expect("load").is_none());
        assert!(store
            .load(*ids.last().expect("newest id"))
            .await
            .expect("load")
            .is_some());
        assert_eq!(store.list().await.expect("list").len(), MAX_CONVERSATIONS);
    }
}
