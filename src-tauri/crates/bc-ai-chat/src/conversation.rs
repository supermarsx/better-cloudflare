//! Conversation manager – bounded state plus disposal signalling.

use std::collections::HashMap;

use tokio::sync::{watch, RwLock};
use uuid::Uuid;

use crate::error::ChatError;
use crate::limits::{
    conversation_retained_bytes, enforce_conversation_limits, validate_chat_message,
    validate_conversation, MAX_CONVERSATIONS, MAX_GLOBAL_RETAINED_BYTES,
};
use crate::types::{ChatMessage, Conversation, ConversationMeta};
use bc_ai_provider::ProviderKind;

#[derive(Default)]
struct ChatState {
    conversations: HashMap<Uuid, Conversation>,
    disposal_senders: HashMap<Uuid, watch::Sender<bool>>,
}

impl ChatState {
    fn remove(&mut self, id: Uuid) -> Option<Conversation> {
        if let Some(sender) = self.disposal_senders.remove(&id) {
            let _ = sender.send(true);
        }
        self.conversations.remove(&id)
    }

    fn total_retained_bytes(&self) -> usize {
        self.conversations
            .values()
            .map(conversation_retained_bytes)
            .fold(0usize, usize::saturating_add)
    }

    fn oldest_id(&self) -> Option<Uuid> {
        self.conversations
            .values()
            .min_by_key(|conversation| {
                (
                    conversation.updated_at,
                    conversation.created_at,
                    conversation.id,
                )
            })
            .map(|conversation| conversation.id)
    }

    fn enforce_global_limits(&mut self) -> Vec<Uuid> {
        let mut evicted = Vec::new();
        while self.conversations.len() > MAX_CONVERSATIONS
            || self.total_retained_bytes() > MAX_GLOBAL_RETAINED_BYTES
        {
            let Some(oldest_id) = self.oldest_id() else {
                break;
            };
            self.remove(oldest_id);
            evicted.push(oldest_id);
        }
        evicted
    }
}

/// Chat manager holding a bounded set of active conversations.
#[derive(Default)]
pub struct ChatManager {
    state: RwLock<ChatState>,
}

impl ChatManager {
    /// Compatibility entry point used by the existing command layer.
    ///
    /// New Rust callers should prefer [`Self::try_create_conversation`] so
    /// invalid oversized fields are returned as a structured error.
    pub async fn create_conversation(
        &self,
        provider: ProviderKind,
        model: String,
        title: Option<String>,
        system_prompt: Option<String>,
    ) -> ConversationMeta {
        let fallback_provider = provider.clone();
        match self
            .try_create_conversation(provider, model, title, system_prompt)
            .await
        {
            Ok(meta) => meta,
            Err(_) => Conversation::new(
                fallback_provider.clone(),
                fallback_provider.default_model().to_string(),
            )
            .with_title("Conversation rejected by retention limits")
            .meta(),
        }
    }

    /// Create a validated conversation and evict the deterministic oldest
    /// conversations if global count or byte limits are exceeded.
    pub async fn try_create_conversation(
        &self,
        provider: ProviderKind,
        model: String,
        title: Option<String>,
        system_prompt: Option<String>,
    ) -> Result<ConversationMeta, ChatError> {
        let mut conversation = Conversation::new(provider, model);
        if let Some(title) = title {
            conversation = conversation.with_title(title);
        }
        if let Some(system_prompt) = system_prompt {
            conversation = conversation.with_system_prompt(system_prompt);
        }
        validate_conversation(&conversation)?;
        let meta = conversation.meta();
        let (disposal_tx, _disposal_rx) = watch::channel(false);
        let mut state = self.state.write().await;
        state.disposal_senders.insert(conversation.id, disposal_tx);
        state.conversations.insert(conversation.id, conversation);
        state.enforce_global_limits();
        Ok(meta)
    }

    /// List all conversations (metadata only).
    pub async fn list_conversations(&self) -> Vec<ConversationMeta> {
        let state = self.state.read().await;
        let mut list: Vec<ConversationMeta> = state
            .conversations
            .values()
            .map(Conversation::meta)
            .collect();
        list.sort_by(|left, right| {
            right
                .updated_at
                .cmp(&left.updated_at)
                .then_with(|| right.id.cmp(&left.id))
        });
        list
    }

    /// Get a full conversation by ID.
    pub async fn get_conversation(&self, id: Uuid) -> Option<Conversation> {
        self.state.read().await.conversations.get(&id).cloned()
    }

    /// Delete a conversation and notify every task attached to its lifecycle.
    pub async fn delete_conversation(&self, id: Uuid) -> bool {
        self.state.write().await.remove(id).is_some()
    }

    /// Compatibility wrapper returning `false` for missing or rejected input.
    pub async fn push_message(&self, conversation_id: Uuid, message: ChatMessage) -> bool {
        self.try_push_message(conversation_id, message)
            .await
            .is_ok()
    }

    /// Add one validated message, evicting oldest messages/conversations before
    /// returning.
    pub async fn try_push_message(
        &self,
        conversation_id: Uuid,
        message: ChatMessage,
    ) -> Result<Vec<Uuid>, ChatError> {
        validate_chat_message(&message)?;
        let mut state = self.state.write().await;
        let conversation = state
            .conversations
            .get_mut(&conversation_id)
            .ok_or(ChatError::ConversationNotFound(conversation_id))?;
        let evicted_messages = conversation.try_push_message(message)?;
        state.enforce_global_limits();
        if !state.conversations.contains_key(&conversation_id) {
            return Err(ChatError::ConversationNotFound(conversation_id));
        }
        Ok(evicted_messages)
    }

    /// Compatibility wrapper returning `false` for missing or rejected input.
    pub async fn update_last_assistant_message<F>(&self, conversation_id: Uuid, updater: F) -> bool
    where
        F: FnOnce(&mut ChatMessage),
    {
        self.try_update_last_assistant_message(conversation_id, updater)
            .await
            .unwrap_or(false)
    }

    /// Validate a streaming update before replacing retained state.
    pub async fn try_update_last_assistant_message<F>(
        &self,
        conversation_id: Uuid,
        updater: F,
    ) -> Result<bool, ChatError>
    where
        F: FnOnce(&mut ChatMessage),
    {
        let mut state = self.state.write().await;
        let conversation = state
            .conversations
            .get_mut(&conversation_id)
            .ok_or(ChatError::ConversationNotFound(conversation_id))?;
        let Some(last) = conversation.messages.last() else {
            return Ok(false);
        };
        if last.message.role != bc_ai_provider::Role::Assistant {
            return Ok(false);
        }

        let mut updated = last.clone();
        updater(&mut updated);
        validate_chat_message(&updated)?;
        let Some(last) = conversation.messages.last_mut() else {
            return Ok(false);
        };
        *last = updated;
        conversation.updated_at = chrono::Utc::now();
        enforce_conversation_limits(conversation);
        state.enforce_global_limits();
        Ok(state.conversations.contains_key(&conversation_id))
    }

    /// Update conversation title.
    pub async fn set_title(&self, id: Uuid, title: String) -> bool {
        self.try_set_title(id, title).await.is_ok()
    }

    pub async fn try_set_title(&self, id: Uuid, title: String) -> Result<(), ChatError> {
        let mut state = self.state.write().await;
        let conversation = state
            .conversations
            .get_mut(&id)
            .ok_or(ChatError::ConversationNotFound(id))?;
        let mut updated = conversation.clone();
        updated.title = title;
        updated.updated_at = chrono::Utc::now();
        validate_conversation(&updated)?;
        *conversation = updated;
        state.enforce_global_limits();
        Ok(())
    }

    /// Get provider messages for sending to LLM.
    pub async fn provider_messages(&self, id: Uuid) -> Option<Vec<bc_ai_provider::Message>> {
        self.state
            .read()
            .await
            .conversations
            .get(&id)
            .map(Conversation::provider_messages)
    }

    /// Get conversation system prompt.
    pub async fn system_prompt(&self, id: Uuid) -> Option<String> {
        self.state
            .read()
            .await
            .conversations
            .get(&id)
            .and_then(|conversation| conversation.system_prompt.clone())
    }

    /// Get the conversation's selected model.
    pub async fn model(&self, id: Uuid) -> Option<String> {
        self.state
            .read()
            .await
            .conversations
            .get(&id)
            .map(|conversation| conversation.model.clone())
    }

    /// Subscribe to deletion/clear/drop for one conversation.
    pub async fn subscribe_disposal(&self, id: Uuid) -> Option<watch::Receiver<bool>> {
        self.state
            .read()
            .await
            .disposal_senders
            .get(&id)
            .map(watch::Sender::subscribe)
    }

    /// Count total conversations.
    pub async fn count(&self) -> usize {
        self.state.read().await.conversations.len()
    }

    /// Return total retained bytes under the shared accounting policy.
    pub async fn retained_bytes(&self) -> usize {
        self.state.read().await.total_retained_bytes()
    }

    /// Clear all conversations and notify attached tasks.
    pub async fn clear(&self) {
        let mut state = self.state.write().await;
        for (_, sender) in state.disposal_senders.drain() {
            let _ = sender.send(true);
        }
        state.conversations.clear();
    }
}

impl Drop for ChatManager {
    fn drop(&mut self) {
        let state = self.state.get_mut();
        for (_, sender) in state.disposal_senders.drain() {
            let _ = sender.send(true);
        }
    }
}

#[cfg(test)]
mod tests {
    use bc_ai_provider::limits::MAX_MESSAGE_BYTES;

    use super::*;
    use crate::limits::{MAX_CONVERSATION_BYTES, MAX_MESSAGES_PER_CONVERSATION, MAX_TITLE_BYTES};

    async fn conversation(manager: &ChatManager) -> Uuid {
        manager
            .try_create_conversation(ProviderKind::Ollama, "test-model".into(), None, None)
            .await
            .expect("conversation")
            .id
    }

    #[tokio::test]
    async fn exact_title_boundary_is_accepted_and_one_more_is_rejected() {
        let manager = ChatManager::default();
        manager
            .try_create_conversation(
                ProviderKind::Ollama,
                "model".into(),
                Some("t".repeat(MAX_TITLE_BYTES)),
                None,
            )
            .await
            .expect("exact title boundary");
        assert!(matches!(
            manager
                .try_create_conversation(
                    ProviderKind::Ollama,
                    "model".into(),
                    Some("t".repeat(MAX_TITLE_BYTES + 1)),
                    None,
                )
                .await,
            Err(ChatError::LimitExceeded {
                resource: "conversation title",
                ..
            })
        ));
    }

    #[tokio::test]
    async fn sustained_append_evicts_oldest_by_count() {
        let manager = ChatManager::default();
        let id = conversation(&manager).await;
        let mut appended_ids = Vec::new();
        for index in 0..(MAX_MESSAGES_PER_CONVERSATION * 3) {
            let message = ChatMessage::user(format!("message-{index}"));
            appended_ids.push(message.id);
            manager
                .try_push_message(id, message)
                .await
                .expect("bounded append");
        }

        let retained = manager.get_conversation(id).await.expect("retained");
        assert_eq!(retained.messages.len(), MAX_MESSAGES_PER_CONVERSATION);
        assert_eq!(
            retained.messages.first().expect("oldest retained").id,
            appended_ids[appended_ids.len() - MAX_MESSAGES_PER_CONVERSATION]
        );
        assert_eq!(
            retained.messages.last().expect("newest retained").id,
            *appended_ids.last().expect("last appended")
        );
    }

    #[tokio::test]
    async fn sustained_large_append_stays_within_conversation_and_global_bytes() {
        let manager = ChatManager::default();
        let id = conversation(&manager).await;
        let payload = "x".repeat(MAX_MESSAGE_BYTES / 4);
        for _ in 0..64 {
            manager
                .try_push_message(id, ChatMessage::user(payload.clone()))
                .await
                .expect("bounded append");
        }

        let retained = manager.get_conversation(id).await.expect("retained");
        assert!(crate::limits::conversation_retained_bytes(&retained) <= MAX_CONVERSATION_BYTES);
        assert!(manager.retained_bytes().await <= MAX_GLOBAL_RETAINED_BYTES);
        assert!(retained.messages.len() < 64);
    }

    #[tokio::test]
    async fn one_message_cannot_hide_unbounded_pending_tool_arguments() {
        let manager = ChatManager::default();
        let id = conversation(&manager).await;
        let mut message = ChatMessage::assistant_pending();
        message.pending_tool_calls = (0..5)
            .map(|index| bc_ai_provider::ToolCall {
                id: format!("call-{index}"),
                name: "lookup".into(),
                arguments: serde_json::json!({
                    "payload": "x".repeat(
                        bc_ai_provider::limits::MAX_TOOL_ARGUMENT_BYTES - 64
                    )
                }),
            })
            .collect();

        assert!(matches!(
            manager.try_push_message(id, message).await,
            Err(ChatError::LimitExceeded {
                resource: "retained chat message",
                ..
            })
        ));
    }

    #[tokio::test]
    async fn global_count_evicts_oldest_and_notifies_disposal() {
        let manager = ChatManager::default();
        let oldest = conversation(&manager).await;
        let mut disposal = manager
            .subscribe_disposal(oldest)
            .await
            .expect("disposal subscription");

        for _ in 0..MAX_CONVERSATIONS {
            conversation(&manager).await;
        }

        disposal.changed().await.expect("eviction signal");
        assert!(*disposal.borrow());
        assert!(manager.get_conversation(oldest).await.is_none());
        assert_eq!(manager.count().await, MAX_CONVERSATIONS);
    }

    #[tokio::test]
    async fn global_bytes_evict_oldest_conversation_deterministically() {
        let manager = ChatManager::default();
        let payload = "x".repeat(MAX_MESSAGE_BYTES / 4);
        let mut ids = Vec::new();
        for _ in 0..10 {
            let id = conversation(&manager).await;
            ids.push(id);
            for _ in 0..32 {
                manager
                    .try_push_message(id, ChatMessage::user(payload.clone()))
                    .await
                    .expect("bounded append");
            }
        }

        assert!(manager.retained_bytes().await <= MAX_GLOBAL_RETAINED_BYTES);
        assert!(manager.get_conversation(ids[0]).await.is_none());
        assert!(manager
            .get_conversation(*ids.last().expect("newest"))
            .await
            .is_some());
    }

    #[tokio::test]
    async fn deletion_and_clear_notify_lifecycle_subscribers() {
        let manager = ChatManager::default();
        let deleted = conversation(&manager).await;
        let cleared = conversation(&manager).await;
        let mut deleted_rx = manager
            .subscribe_disposal(deleted)
            .await
            .expect("deleted rx");
        let mut cleared_rx = manager
            .subscribe_disposal(cleared)
            .await
            .expect("cleared rx");

        assert!(manager.delete_conversation(deleted).await);
        deleted_rx.changed().await.expect("delete signal");
        assert!(*deleted_rx.borrow());

        manager.clear().await;
        cleared_rx.changed().await.expect("clear signal");
        assert!(*cleared_rx.borrow());
    }
}
