//! Conversation manager – bounded state plus disposal signalling.

use std::collections::HashMap;

use tokio::sync::{watch, RwLock};
use uuid::Uuid;

use crate::error::ChatError;
use crate::limits::{
    conversation_retained_bytes, enforce_conversation_limits, validate_chat_message,
    validate_conversation, ChatLimits, MAX_CONFIGURED_EVICTIONS_PER_WRITE, MAX_CONVERSATIONS,
    MAX_GLOBAL_RETAINED_BYTES,
};
use crate::types::{ChatMessage, Conversation, ConversationMeta};

#[derive(Default)]
struct ChatState {
    conversations: HashMap<Uuid, Conversation>,
    disposal_senders: HashMap<Uuid, watch::Sender<bool>>,
    /// The user's configured retention limits, already clamped. Held here
    /// rather than beside the state so that enforcement, which runs under the
    /// same write lock as the mutation it follows, cannot read a different
    /// value than the one validated against.
    limits: ChatLimits,
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

    /// Trim the store back inside its retention limits.
    ///
    /// Two passes, and the difference between them *is* the retention policy
    /// for a lowered setting:
    ///
    /// 1. The hard ceilings, enforced without bound, exactly as before these
    ///    limits became configurable. `MAX_GLOBAL_RETAINED_BYTES` exists to
    ///    bound memory, so nothing may be retained above it.
    /// 2. A configured limit below its ceiling, enforced by a pass capped at
    ///    [`MAX_CONFIGURED_EVICTIONS_PER_WRITE`]. Lowering "max
    ///    conversations" to 5 with 40 stored therefore stops the store
    ///    growing at once and then walks it down at most one conversation per
    ///    write — never 35 transcripts at once because somebody typed a
    ///    smaller number. Usage falls to the configured value as the user
    ///    deletes conversations themselves.
    fn enforce_global_limits(&mut self) -> Vec<Uuid> {
        let limits = self.limits.clamped();
        let mut evicted =
            self.evict_until(MAX_CONVERSATIONS, MAX_GLOBAL_RETAINED_BYTES, usize::MAX);
        evicted.extend(self.evict_until(
            limits.max_conversations,
            limits.max_global_retained_bytes,
            MAX_CONFIGURED_EVICTIONS_PER_WRITE,
        ));
        evicted
    }

    /// Remove the deterministic oldest conversations until the store is
    /// inside both limits, or `budget` have gone, whichever comes first.
    fn evict_until(
        &mut self,
        max_conversations: usize,
        max_bytes: usize,
        budget: usize,
    ) -> Vec<Uuid> {
        let mut evicted = Vec::new();
        while self.conversations.len() > max_conversations
            || self.total_retained_bytes() > max_bytes
        {
            if evicted.len() >= budget {
                break;
            }
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
    /// The retention limits in force, already clamped to the hard ceilings.
    pub async fn limits(&self) -> ChatLimits {
        self.state.read().await.limits.clamped()
    }

    /// Install the user's configured retention limits.
    ///
    /// The value is clamped here, which is why this takes ownership and why
    /// there is no field to assign instead: a caller cannot install a limit
    /// above its ceiling even by mistake. Installing a *lower* limit deletes
    /// nothing — see [`ChatState::enforce_global_limits`] for what a lowered
    /// limit does instead.
    pub async fn set_limits(&self, limits: ChatLimits) -> ChatLimits {
        let mut state = self.state.write().await;
        state.limits = limits.clamped();
        state.limits
    }

    /// Create a validated conversation and evict the deterministic oldest
    /// conversations if global count or byte limits are exceeded.
    pub async fn try_create_conversation(
        &self,
        provider: String,
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
        let (disposal_tx, _disposal_rx) = watch::channel(false);
        let mut state = self.state.write().await;
        validate_conversation(&conversation, &state.limits)?;
        let meta = conversation.meta();
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

    /// Add one validated message, evicting oldest messages/conversations before
    /// returning.
    pub async fn try_push_message(
        &self,
        conversation_id: Uuid,
        message: ChatMessage,
    ) -> Result<Vec<Uuid>, ChatError> {
        let mut state = self.state.write().await;
        let limits = state.limits;
        validate_chat_message(&message, &limits)?;
        let conversation = state
            .conversations
            .get_mut(&conversation_id)
            .ok_or(ChatError::ConversationNotFound(conversation_id))?;
        let evicted_messages = conversation.try_push_message_within(message, &limits)?;
        state.enforce_global_limits();
        if !state.conversations.contains_key(&conversation_id) {
            return Err(ChatError::ConversationNotFound(conversation_id));
        }
        Ok(evicted_messages)
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
        let limits = state.limits;
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
        validate_chat_message(&updated, &limits)?;
        let Some(last) = conversation.messages.last_mut() else {
            return Ok(false);
        };
        *last = updated;
        conversation.updated_at = chrono::Utc::now();
        enforce_conversation_limits(conversation, &limits);
        state.enforce_global_limits();
        Ok(state.conversations.contains_key(&conversation_id))
    }

    /// Update a conversation title or return its bounded validation error.
    pub async fn try_set_title(&self, id: Uuid, title: String) -> Result<(), ChatError> {
        let mut state = self.state.write().await;
        let limits = state.limits;
        let conversation = state
            .conversations
            .get_mut(&id)
            .ok_or(ChatError::ConversationNotFound(id))?;
        let mut updated = conversation.clone();
        updated.title = title;
        updated.updated_at = chrono::Utc::now();
        validate_conversation(&updated, &limits)?;
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

    /// Id of the provider profile the conversation was created against.
    pub async fn provider(&self, id: Uuid) -> Option<String> {
        self.state
            .read()
            .await
            .conversations
            .get(&id)
            .map(|conversation| conversation.provider.clone())
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
            .try_create_conversation("ollama".into(), "test-model".into(), None, None)
            .await
            .expect("conversation")
            .id
    }

    // ── Configured limits ──────────────────────────────────────────────────

    /// The failure this policy exists to prevent: typing a smaller number
    /// must not cost the user their transcripts. Lowering the limit from 128
    /// to 5 with 40 stored deletes nothing at all, and the store then stops
    /// growing rather than collapsing to 5.
    #[tokio::test]
    async fn lowering_the_conversation_limit_below_current_usage_deletes_nothing() {
        let manager = ChatManager::default();
        for _ in 0..40 {
            conversation(&manager).await;
        }
        assert_eq!(manager.count().await, 40);

        let stored = manager
            .set_limits(ChatLimits {
                max_conversations: 5,
                ..ChatLimits::default()
            })
            .await;
        assert_eq!(stored.max_conversations, 5);
        assert_eq!(
            manager.count().await,
            40,
            "lowering a limit must not delete a single conversation"
        );
        assert_eq!(manager.list_conversations().await.len(), 40);

        // Growth stops: a create still succeeds, but the store does not grow
        // past where it was, and it loses exactly the one oldest conversation
        // the hard ceiling would have taken on that same write.
        for expected in [40, 40, 40] {
            conversation(&manager).await;
            assert_eq!(
                manager.count().await,
                expected,
                "a configured limit may evict at most {MAX_CONFIGURED_EVICTIONS_PER_WRITE} \
                 conversation per write"
            );
        }
    }

    /// The same for messages inside one conversation: continuing a long
    /// conversation stays possible, and it is not emptied down to the new
    /// limit in one push.
    #[tokio::test]
    async fn lowering_the_message_limit_below_current_usage_trims_one_per_write() {
        let manager = ChatManager::default();
        let id = conversation(&manager).await;
        for index in 0..40 {
            manager
                .try_push_message(id, ChatMessage::user(format!("message {index}")))
                .await
                .expect("push");
        }
        let before = manager
            .get_conversation(id)
            .await
            .expect("conversation")
            .messages
            .len();
        assert_eq!(before, 40);

        manager
            .set_limits(ChatLimits {
                max_messages_per_conversation: 10,
                ..ChatLimits::default()
            })
            .await;
        assert_eq!(
            manager
                .get_conversation(id)
                .await
                .expect("conversation")
                .messages
                .len(),
            40,
            "lowering a limit must not drop a single message"
        );

        // Each push trims one, so the history walks down visibly instead of
        // thirty messages vanishing at once.
        for expected in [40, 40, 40] {
            manager
                .try_push_message(id, ChatMessage::user("another"))
                .await
                .expect("a long conversation must stay usable");
            assert_eq!(
                manager
                    .get_conversation(id)
                    .await
                    .expect("conversation")
                    .messages
                    .len(),
                expected
            );
        }
    }

    /// A configured limit the store is *under* behaves exactly like the
    /// ceiling: it caps growth at the configured number.
    #[tokio::test]
    async fn a_configured_limit_caps_growth_at_the_configured_number() {
        let manager = ChatManager::default();
        manager
            .set_limits(ChatLimits {
                max_conversations: 5,
                ..ChatLimits::default()
            })
            .await;
        for _ in 0..5 {
            conversation(&manager).await;
        }
        assert_eq!(manager.count().await, 5);
        for _ in 0..4 {
            conversation(&manager).await;
            assert_eq!(
                manager.count().await,
                5,
                "the configured limit must hold once usage is inside it"
            );
        }
    }

    /// A lowered byte limit refuses an over-long message rather than
    /// truncating what the user typed, and names the configured number.
    #[tokio::test]
    async fn a_lowered_message_byte_limit_refuses_rather_than_truncating() {
        let manager = ChatManager::default();
        let id = conversation(&manager).await;
        manager
            .set_limits(ChatLimits {
                max_chat_message_bytes: 512,
                ..ChatLimits::default()
            })
            .await;

        let error = manager
            .try_push_message(id, ChatMessage::user("x".repeat(1024)))
            .await
            .expect_err("over the configured message limit");
        assert!(
            matches!(
                error,
                ChatError::LimitExceeded {
                    resource: "retained chat message",
                    limit: 512,
                    ..
                }
            ),
            "the error must name the configured limit, not the ceiling: {error}"
        );
        // A message inside the configured limit still goes through.
        manager
            .try_push_message(id, ChatMessage::user("short"))
            .await
            .expect("inside the configured limit");
    }

    /// A lowered title limit is enforced, in UTF-8 bytes, and reported as the
    /// configured number.
    #[tokio::test]
    async fn a_lowered_title_limit_is_enforced_in_utf8_bytes() {
        let manager = ChatManager::default();
        manager
            .set_limits(ChatLimits {
                max_title_bytes: 8,
                ..ChatLimits::default()
            })
            .await;
        // Four two-byte characters are eight bytes: at the limit, not over.
        manager
            .try_create_conversation("ollama".into(), "m".into(), Some("éééé".into()), None)
            .await
            .expect("eight UTF-8 bytes is inside an eight-byte limit");
        assert!(
            matches!(
                manager
                    .try_create_conversation(
                        "ollama".into(),
                        "m".into(),
                        Some("ééééé".into()),
                        None
                    )
                    .await,
                Err(ChatError::LimitExceeded {
                    resource: "conversation title",
                    limit: 8,
                    ..
                })
            ),
            "five two-byte characters are ten bytes and must be refused"
        );
    }

    /// Nothing a caller can pass may raise a ceiling. `set_limits` clamps,
    /// and it is the only way in.
    #[tokio::test]
    async fn set_limits_cannot_raise_a_hard_ceiling() {
        let manager = ChatManager::default();
        let stored = manager
            .set_limits(ChatLimits {
                max_conversations: usize::MAX,
                max_messages_per_conversation: usize::MAX,
                max_chat_message_bytes: usize::MAX,
                max_conversation_bytes: usize::MAX,
                max_global_retained_bytes: usize::MAX,
                max_title_bytes: usize::MAX,
            })
            .await;
        assert_eq!(stored, ChatLimits::default());
        assert_eq!(manager.limits().await, ChatLimits::default());

        // And zero clamps up to the floor rather than down to a store that
        // can hold nothing.
        let stored = manager
            .set_limits(ChatLimits {
                max_conversations: 0,
                max_messages_per_conversation: 0,
                max_chat_message_bytes: 0,
                max_conversation_bytes: 0,
                max_global_retained_bytes: 0,
                max_title_bytes: 0,
            })
            .await;
        assert_eq!(stored.max_conversations, 1);
        assert_eq!(stored.max_title_bytes, 1);

        // A one-*byte* retention budget really can hold nothing — one
        // conversation's own accounting overhead is larger than that — so the
        // create succeeds and the budget is then honoured. That is the
        // setting being obeyed, not the store wedging: nothing errors, and
        // raising the budget to something a conversation fits in makes it
        // retain again.
        manager
            .try_create_conversation("ollama".into(), "m".into(), Some("t".into()), None)
            .await
            .expect("a create under an absurd budget still succeeds");
        assert_eq!(manager.count().await, 0);

        let stored = manager
            .set_limits(ChatLimits {
                max_conversations: 1,
                max_title_bytes: 1,
                ..ChatLimits::default()
            })
            .await;
        assert_eq!(stored.max_conversations, 1);
        let id = manager
            .try_create_conversation("ollama".into(), "m".into(), Some("t".into()), None)
            .await
            .expect("the count floor must leave the store usable")
            .id;
        assert!(
            manager.get_conversation(id).await.is_some(),
            "a floor of one conversation must still retain that one conversation"
        );
    }

    /// The hard ceilings are still enforced without bound, so a configured
    /// limit cannot be used to retain more than the code is built to survive.
    #[tokio::test]
    async fn the_hard_ceilings_still_bound_the_store() {
        let manager = ChatManager::default();
        manager.set_limits(ChatLimits::default()).await;
        for _ in 0..(MAX_CONVERSATIONS + 8) {
            conversation(&manager).await;
        }
        assert_eq!(manager.count().await, MAX_CONVERSATIONS);
        assert!(manager.retained_bytes().await <= MAX_GLOBAL_RETAINED_BYTES);
    }

    #[tokio::test]
    async fn exact_title_boundary_is_accepted_and_one_more_is_rejected() {
        let manager = ChatManager::default();
        manager
            .try_create_conversation(
                "ollama".into(),
                "model".into(),
                Some("t".repeat(MAX_TITLE_BYTES)),
                None,
            )
            .await
            .expect("exact title boundary");
        assert!(matches!(
            manager
                .try_create_conversation(
                    "ollama".into(),
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
