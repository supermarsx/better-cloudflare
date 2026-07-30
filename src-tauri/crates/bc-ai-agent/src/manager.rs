//! Agent manager — bounded provider/task state and asynchronous turns.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use tokio::sync::{mpsc, oneshot, watch, RwLock};
use uuid::Uuid;

use bc_ai_chat::ChatManager;
use bc_ai_provider::anthropic::AnthropicProvider;
use bc_ai_provider::ollama::OllamaProvider;
use bc_ai_provider::openai::OpenAiProvider;
use bc_ai_provider::{AiProvider, ProviderConfig, ProviderKind};
use bc_ai_tools::executor::ToolExecutor;
use bc_ai_tools::ToolRegistry;

use crate::agent;
use crate::config::{AgentConfig, AGENT_EVENT_CHANNEL_CAPACITY};
use crate::error::AgentError;
use crate::events::AgentEvent;

struct ActiveTurn {
    generation: Uuid,
    cancellation: watch::Sender<bool>,
    abort_handle: tokio::task::AbortHandle,
}

/// Central AI agent manager, registered via `.manage()` in Tauri.
pub struct AgentManager {
    providers: RwLock<HashMap<ProviderKind, Arc<dyn AiProvider + Send + Sync>>>,
    configs: RwLock<HashMap<ProviderKind, ProviderConfig>>,
    agent_config: RwLock<AgentConfig>,
    pub registry: Arc<ToolRegistry>,
    pub executor: Arc<ToolExecutor>,
    pub chat: Arc<ChatManager>,
    active_turns: Arc<Mutex<HashMap<Uuid, ActiveTurn>>>,
}

impl Default for AgentManager {
    fn default() -> Self {
        Self {
            providers: RwLock::new(HashMap::new()),
            configs: RwLock::new(HashMap::new()),
            agent_config: RwLock::new(AgentConfig::default()),
            registry: Arc::new(ToolRegistry::default()),
            executor: Arc::new(ToolExecutor::default()),
            chat: Arc::new(ChatManager::default()),
            active_turns: Arc::new(Mutex::new(HashMap::new())),
        }
    }
}

impl AgentManager {
    /// Configure a provider. Creates (or replaces) the provider instance.
    pub async fn configure_provider(&self, config: ProviderConfig) -> Result<(), String> {
        config.validate().map_err(|error| error.to_string())?;
        let kind = config.kind.clone();
        let provider: Arc<dyn AiProvider + Send + Sync> = match kind {
            ProviderKind::OpenAi => {
                Arc::new(OpenAiProvider::new(config.clone()).map_err(|error| error.to_string())?)
            }
            ProviderKind::Anthropic => {
                Arc::new(AnthropicProvider::new(config.clone()).map_err(|error| error.to_string())?)
            }
            ProviderKind::Ollama => {
                Arc::new(OllamaProvider::new(config.clone()).map_err(|error| error.to_string())?)
            }
        };

        provider
            .health_check()
            .await
            .map_err(|error| format!("Provider health check failed: {error}"))?;

        self.providers.write().await.insert(kind.clone(), provider);
        self.configs.write().await.insert(kind, config);
        Ok(())
    }

    pub async fn provider(&self, kind: &ProviderKind) -> Option<Arc<dyn AiProvider + Send + Sync>> {
        self.providers.read().await.get(kind).cloned()
    }

    pub async fn configured_providers(&self) -> Vec<ProviderKind> {
        let mut providers: Vec<_> = self.configs.read().await.keys().cloned().collect();
        providers.sort_by_key(ProviderKind::as_str);
        providers
    }

    pub async fn agent_config(&self) -> AgentConfig {
        self.agent_config.read().await.clone()
    }

    /// Compatibility setter; invalid configurations are rejected without
    /// replacing the last known-good configuration.
    pub async fn set_agent_config(&self, config: AgentConfig) {
        let _ = self.try_set_agent_config(config).await;
    }

    pub async fn try_set_agent_config(&self, config: AgentConfig) -> Result<(), AgentError> {
        config.validate()?;
        *self.agent_config.write().await = config;
        Ok(())
    }

    pub async fn provider_config(&self, kind: &ProviderKind) -> Option<ProviderConfig> {
        self.configs.read().await.get(kind).cloned()
    }

    /// Start a turn and return its bounded event receiver immediately.
    pub async fn send_message(
        &self,
        conversation_id: Uuid,
        provider_kind: ProviderKind,
    ) -> Result<mpsc::Receiver<AgentEvent>, String> {
        let provider = self
            .provider(&provider_kind)
            .await
            .ok_or_else(|| format!("Provider {provider_kind:?} not configured"))?;
        let config = self.agent_config.read().await.clone();
        config.validate().map_err(|error| error.to_string())?;
        let disposal = self
            .chat
            .subscribe_disposal(conversation_id)
            .await
            .ok_or_else(|| format!("Conversation not found: {conversation_id}"))?;

        self.registry.init_all().await;
        let (event_tx, event_rx) = mpsc::channel(AGENT_EVENT_CHANNEL_CAPACITY);
        let (cancellation_tx, cancellation_rx) = watch::channel(false);
        let generation = Uuid::new_v4();

        let mut active_turns = self
            .active_turns
            .lock()
            .map_err(|_| "Active turn lock poisoned".to_string())?;
        if let Some(previous) = active_turns.remove(&conversation_id) {
            let _ = previous.cancellation.send(true);
            previous.abort_handle.abort();
        }

        let chat = Arc::clone(&self.chat);
        let registry = Arc::clone(&self.registry);
        let executor = Arc::clone(&self.executor);
        let task_active_turns = Arc::clone(&self.active_turns);
        let task_event_tx = event_tx.clone();
        let (start_tx, start_rx) = oneshot::channel();
        let task = tokio::spawn(async move {
            if start_rx.await.is_err() {
                return;
            }
            let result = agent::run_turn(
                provider.as_ref(),
                chat.as_ref(),
                registry.as_ref(),
                executor.as_ref(),
                &config,
                conversation_id,
                task_event_tx.clone(),
                cancellation_rx,
                disposal,
            )
            .await;

            match result {
                Err(AgentError::Cancelled) => {
                    let _ = task_event_tx.try_send(AgentEvent::Cancelled { conversation_id });
                }
                Err(AgentError::ConversationDisposed(_)) | Err(AgentError::ConsumerDropped) => {}
                Err(error) => {
                    let _ = task_event_tx
                        .send(AgentEvent::Error {
                            conversation_id,
                            error: error.to_string(),
                        })
                        .await;
                }
                Ok(_) => {}
            }

            if let Ok(mut active_turns) = task_active_turns.lock() {
                if active_turns
                    .get(&conversation_id)
                    .is_some_and(|turn| turn.generation == generation)
                {
                    active_turns.remove(&conversation_id);
                }
            }
        });
        let abort_handle = task.abort_handle();
        active_turns.insert(
            conversation_id,
            ActiveTurn {
                generation,
                cancellation: cancellation_tx,
                abort_handle,
            },
        );
        let _ = start_tx.send(());
        drop(active_turns);
        drop(event_tx);
        Ok(event_rx)
    }

    /// Approve a pending tool call and append its bounded result.
    pub async fn approve_tool_call(
        &self,
        tool_call_id: &str,
        conversation_id: Uuid,
    ) -> Result<(), String> {
        let conversation = self
            .chat
            .get_conversation(conversation_id)
            .await
            .ok_or("Conversation not found")?;
        let pending = conversation
            .messages
            .iter()
            .flat_map(|message| message.pending_tool_calls.iter())
            .find(|tool_call| tool_call.id == tool_call_id)
            .cloned()
            .ok_or("Tool call not found")?;

        let result = self.executor.execute_approved(&pending).await;
        match result {
            bc_ai_tools::executor::ExecutionResult::Success(result)
            | bc_ai_tools::executor::ExecutionResult::Error(result) => {
                if result.content.len() > bc_ai_provider::limits::MAX_TOOL_RESULT_BYTES {
                    return Err(AgentError::ToolOutputLimit {
                        limit: bc_ai_provider::limits::MAX_TOOL_RESULT_BYTES,
                        actual: result.content.len(),
                    }
                    .to_string());
                }
                let message = bc_ai_chat::ChatMessage {
                    id: Uuid::new_v4(),
                    message: bc_ai_provider::Message::tool_result(
                        result.tool_call_id,
                        result.content,
                        result.is_error,
                    ),
                    status: bc_ai_chat::MessageStatus::Complete,
                    created_at: chrono::Utc::now(),
                    usage: None,
                    pending_tool_calls: Vec::new(),
                };
                self.chat
                    .try_push_message(conversation_id, message)
                    .await
                    .map_err(|error| error.to_string())?;
                Ok(())
            }
            bc_ai_tools::executor::ExecutionResult::NeedsApproval { .. } => {
                Err("Unexpected: approved call still requires approval".into())
            }
        }
    }

    /// Signal cancellation. The running task observes this even while blocked
    /// on provider or event-channel backpressure.
    pub async fn cancel(&self, conversation_id: Uuid) -> bool {
        self.active_turns
            .lock()
            .ok()
            .and_then(|active_turns| {
                active_turns
                    .get(&conversation_id)
                    .map(|turn| turn.cancellation.send(true).is_ok())
            })
            .unwrap_or(false)
    }

    #[cfg(test)]
    async fn active_count(&self) -> usize {
        self.active_turns
            .lock()
            .map(|active_turns| active_turns.len())
            .unwrap_or_default()
    }
}

impl Drop for AgentManager {
    fn drop(&mut self) {
        if let Ok(mut active_turns) = self.active_turns.lock() {
            for (_, turn) in active_turns.drain() {
                let _ = turn.cancellation.send(true);
                turn.abort_handle.abort();
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
    use std::time::Duration;

    use async_trait::async_trait;
    use bc_ai_provider::{
        AiProviderError, CompletionRequest, CompletionResponse, Message, Model, StreamDelta,
    };

    use super::*;

    enum MockMode {
        Finite(usize),
        Endless,
    }

    struct MockProvider {
        mode: MockMode,
        produced: Arc<AtomicUsize>,
        stream_dropped: Arc<AtomicBool>,
    }

    struct DropFlag(Arc<AtomicBool>);

    impl Drop for DropFlag {
        fn drop(&mut self) {
            self.0.store(true, Ordering::SeqCst);
        }
    }

    #[async_trait]
    impl AiProvider for MockProvider {
        fn kind(&self) -> &str {
            "mock"
        }

        async fn complete(
            &self,
            _request: CompletionRequest,
        ) -> Result<CompletionResponse, AiProviderError> {
            Ok(CompletionResponse {
                message: Message::assistant("complete"),
                usage: None,
                model: "mock".into(),
                finish_reason: Some("stop".into()),
            })
        }

        async fn stream(
            &self,
            _request: CompletionRequest,
            tx: mpsc::Sender<StreamDelta>,
        ) -> Result<CompletionResponse, AiProviderError> {
            let _drop_flag = DropFlag(Arc::clone(&self.stream_dropped));
            let mut index = 0usize;
            loop {
                if matches!(self.mode, MockMode::Finite(limit) if index >= limit) {
                    tx.send(StreamDelta::Done)
                        .await
                        .map_err(|_| AiProviderError::Cancelled)?;
                    return Ok(CompletionResponse {
                        message: Message::assistant("complete"),
                        usage: None,
                        model: "mock".into(),
                        finish_reason: Some("stop".into()),
                    });
                }
                tx.send(StreamDelta::Text { text: "x".into() })
                    .await
                    .map_err(|_| AiProviderError::Cancelled)?;
                self.produced.fetch_add(1, Ordering::SeqCst);
                index += 1;
            }
        }

        async fn list_models(&self) -> Result<Vec<Model>, AiProviderError> {
            Ok(Vec::new())
        }

        async fn health_check(&self) -> Result<(), AiProviderError> {
            Ok(())
        }
    }

    async fn manager_with_provider(
        mode: MockMode,
    ) -> (AgentManager, Arc<AtomicUsize>, Arc<AtomicBool>) {
        let manager = AgentManager::default();
        let produced = Arc::new(AtomicUsize::new(0));
        let stream_dropped = Arc::new(AtomicBool::new(false));
        manager.providers.write().await.insert(
            ProviderKind::Ollama,
            Arc::new(MockProvider {
                mode,
                produced: Arc::clone(&produced),
                stream_dropped: Arc::clone(&stream_dropped),
            }),
        );
        (manager, produced, stream_dropped)
    }

    async fn create_conversation(manager: &AgentManager) -> Uuid {
        manager
            .chat
            .try_create_conversation(ProviderKind::Ollama, "mock".into(), None, None)
            .await
            .expect("conversation")
            .id
    }

    async fn wait_for_flag(flag: &AtomicBool) {
        tokio::time::timeout(Duration::from_secs(2), async {
            while !flag.load(Ordering::SeqCst) {
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("producer must terminate");
    }

    async fn wait_for_no_active_turns(manager: &AgentManager) {
        tokio::time::timeout(Duration::from_secs(2), async {
            while manager.active_count().await != 0 {
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("active turn cleanup");
    }

    #[tokio::test]
    async fn full_event_channel_applies_backpressure_until_drained() {
        let total = 1_000;
        let (manager, produced, _) = manager_with_provider(MockMode::Finite(total)).await;
        let conversation_id = create_conversation(&manager).await;
        let mut events = manager
            .send_message(conversation_id, ProviderKind::Ollama)
            .await
            .expect("start turn");

        tokio::time::sleep(Duration::from_millis(25)).await;
        let stalled_at = produced.load(Ordering::SeqCst);
        assert!(stalled_at > 0);
        assert!(
            stalled_at < total,
            "bounded stream and event channels must stop the producer"
        );

        let mut completed = false;
        tokio::time::timeout(Duration::from_secs(3), async {
            while let Some(event) = events.recv().await {
                if matches!(event, AgentEvent::TurnComplete { .. }) {
                    completed = true;
                    break;
                }
            }
        })
        .await
        .expect("drained turn");
        assert!(completed);
        assert_eq!(produced.load(Ordering::SeqCst), total);
        wait_for_no_active_turns(&manager).await;
    }

    #[tokio::test]
    async fn dropping_event_receiver_terminates_endless_provider() {
        let (manager, _, stream_dropped) = manager_with_provider(MockMode::Endless).await;
        let conversation_id = create_conversation(&manager).await;
        let mut events = manager
            .send_message(conversation_id, ProviderKind::Ollama)
            .await
            .expect("start turn");
        events.recv().await.expect("first event");
        drop(events);

        wait_for_flag(&stream_dropped).await;
        wait_for_no_active_turns(&manager).await;
    }

    #[tokio::test]
    async fn conversation_disposal_terminates_endless_provider() {
        let (manager, _, stream_dropped) = manager_with_provider(MockMode::Endless).await;
        let conversation_id = create_conversation(&manager).await;
        let mut events = manager
            .send_message(conversation_id, ProviderKind::Ollama)
            .await
            .expect("start turn");
        events.recv().await.expect("first event");

        assert!(manager.chat.delete_conversation(conversation_id).await);
        wait_for_flag(&stream_dropped).await;
        wait_for_no_active_turns(&manager).await;
    }

    #[tokio::test]
    async fn explicit_cancellation_terminates_endless_provider() {
        let (manager, _, stream_dropped) = manager_with_provider(MockMode::Endless).await;
        let conversation_id = create_conversation(&manager).await;
        let mut events = manager
            .send_message(conversation_id, ProviderKind::Ollama)
            .await
            .expect("start turn");
        events.recv().await.expect("first event");

        assert!(manager.cancel(conversation_id).await);
        wait_for_flag(&stream_dropped).await;
        wait_for_no_active_turns(&manager).await;
    }

    #[tokio::test]
    async fn manager_drop_terminates_endless_provider() {
        let (manager, _, stream_dropped) = manager_with_provider(MockMode::Endless).await;
        let conversation_id = create_conversation(&manager).await;
        let mut events = manager
            .send_message(conversation_id, ProviderKind::Ollama)
            .await
            .expect("start turn");
        events.recv().await.expect("first event");

        drop(manager);
        wait_for_flag(&stream_dropped).await;
    }
}
