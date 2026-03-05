//! Conversation persistence and retrieval.
//!
//! Provides a `ConversationStore` trait for pluggable storage backends.
//! The default `InMemoryStore` is used when no SQLite is configured.

use async_trait::async_trait;
use std::collections::HashMap;
use tokio::sync::RwLock;
use uuid::Uuid;

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
            serde_json::to_string_pretty(&conv).map(Some).map_err(|e| e.to_string())
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
        let mut data = self.data.write().await;
        data.insert(conversation.id, conversation.clone());
        Ok(())
    }

    async fn load(&self, id: Uuid) -> Result<Option<Conversation>, String> {
        let data = self.data.read().await;
        Ok(data.get(&id).cloned())
    }

    async fn list(&self) -> Result<Vec<ConversationMeta>, String> {
        let data = self.data.read().await;
        let mut metas: Vec<ConversationMeta> = data.values().map(|c| c.meta()).collect();
        metas.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
        Ok(metas)
    }

    async fn delete(&self, id: Uuid) -> Result<bool, String> {
        let mut data = self.data.write().await;
        Ok(data.remove(&id).is_some())
    }
}
