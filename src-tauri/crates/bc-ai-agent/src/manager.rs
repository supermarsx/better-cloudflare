//! Agent manager — Tauri-managed singleton that holds provider instances,
//! configuration, and orchestrates the agent loop.

use std::collections::HashMap;
use std::sync::Arc;
use tokio::sync::{mpsc, RwLock};
use uuid::Uuid;

use bc_ai_chat::ChatManager;
use bc_ai_provider::openai::OpenAiProvider;
use bc_ai_provider::anthropic::AnthropicProvider;
use bc_ai_provider::ollama::OllamaProvider;
use bc_ai_provider::{AiProvider, ProviderConfig, ProviderKind};
use bc_ai_tools::executor::ToolExecutor;
use bc_ai_tools::ToolRegistry;

use crate::agent;
use crate::config::AgentConfig;
use crate::events::AgentEvent;

/// Central AI agent manager, registered via `.manage()` in Tauri.
pub struct AgentManager {
    /// Active provider instances by kind.
    providers: RwLock<HashMap<ProviderKind, Arc<dyn AiProvider + Send + Sync>>>,
    /// Provider configurations.
    configs: RwLock<HashMap<ProviderKind, ProviderConfig>>,
    /// Agent-level configuration.
    agent_config: RwLock<AgentConfig>,
    /// Tool registry shared with the chat system.
    pub registry: ToolRegistry,
    /// Tool executor.
    pub executor: ToolExecutor,
    /// Chat manager (conversations live here).
    pub chat: ChatManager,
    /// Active cancellation tokens by conversation ID.
    cancellations: RwLock<HashMap<Uuid, tokio::sync::watch::Sender<bool>>>,
}

impl Default for AgentManager {
    fn default() -> Self {
        Self {
            providers: RwLock::new(HashMap::new()),
            configs: RwLock::new(HashMap::new()),
            agent_config: RwLock::new(AgentConfig::default()),
            registry: ToolRegistry::default(),
            executor: ToolExecutor::default(),
            chat: ChatManager::default(),
            cancellations: RwLock::new(HashMap::new()),
        }
    }
}

impl AgentManager {
    /// Configure a provider. Creates (or replaces) the provider instance.
    pub async fn configure_provider(&self, config: ProviderConfig) -> Result<(), String> {
        let kind = config.kind.clone();
        let provider: Arc<dyn AiProvider + Send + Sync> = match kind {
            ProviderKind::OpenAi => Arc::new(
                OpenAiProvider::new(config.clone()).map_err(|e| e.to_string())?,
            ),
            ProviderKind::Anthropic => Arc::new(
                AnthropicProvider::new(config.clone()).map_err(|e| e.to_string())?,
            ),
            ProviderKind::Ollama => Arc::new(OllamaProvider::new(config.clone())),
        };

        // Health check
        provider
            .health_check()
            .await
            .map_err(|e| format!("Provider health check failed: {e}"))?;

        self.providers.write().await.insert(kind.clone(), provider);
        self.configs.write().await.insert(kind, config);
        Ok(())
    }

    /// Get the active provider for a kind.
    pub async fn provider(
        &self,
        kind: &ProviderKind,
    ) -> Option<Arc<dyn AiProvider + Send + Sync>> {
        self.providers.read().await.get(kind).cloned()
    }

    /// Get all configured provider kinds.
    pub async fn configured_providers(&self) -> Vec<ProviderKind> {
        self.configs.read().await.keys().cloned().collect()
    }

    /// Get current agent config.
    pub async fn agent_config(&self) -> AgentConfig {
        self.agent_config.read().await.clone()
    }

    /// Update agent config.
    pub async fn set_agent_config(&self, config: AgentConfig) {
        *self.agent_config.write().await = config;
    }

    /// Get provider config.
    pub async fn provider_config(&self, kind: &ProviderKind) -> Option<ProviderConfig> {
        self.configs.read().await.get(kind).cloned()
    }

    /// Send a message in a conversation, running the full agent loop.
    ///
    /// Returns a receiver for agent events (text deltas, tool calls, etc.).
    pub async fn send_message(
        &self,
        conversation_id: Uuid,
        provider_kind: ProviderKind,
    ) -> Result<mpsc::UnboundedReceiver<AgentEvent>, String> {
        let provider = self
            .provider(&provider_kind)
            .await
            .ok_or_else(|| format!("Provider {:?} not configured", provider_kind))?;

        let config = self.agent_config.read().await.clone();
        let (tx, rx) = mpsc::unbounded_channel();

        // Initialize the tool registry if needed
        self.registry.init_all().await;

        // Run the agent turn (provider is an Arc, so we deref)
        let chat = &self.chat;
        let registry = &self.registry;
        let executor = &self.executor;

        agent::run_turn(
            provider.as_ref(),
            chat,
            registry,
            executor,
            &config,
            conversation_id,
            tx,
        )
        .await?;

        Ok(rx)
    }

    /// Approve a pending tool call and resume the agent loop.
    pub async fn approve_tool_call(
        &self,
        tool_call_id: &str,
        conversation_id: Uuid,
    ) -> Result<(), String> {
        // Find the pending tool call in the conversation
        let conv = self
            .chat
            .get_conversation(conversation_id)
            .await
            .ok_or("Conversation not found")?;

        let pending = conv
            .messages
            .iter()
            .flat_map(|m| m.pending_tool_calls.iter())
            .find(|tc| tc.id == tool_call_id)
            .cloned()
            .ok_or("Tool call not found")?;

        // Execute with force
        let result = self.executor.execute_approved(&pending).await;

        match result {
            bc_ai_tools::executor::ExecutionResult::Success(tr) => {
                let msg = bc_ai_chat::ChatMessage {
                    id: Uuid::new_v4(),
                    message: bc_ai_provider::Message::tool_result(
                        tr.tool_call_id,
                        tr.content,
                        tr.is_error,
                    ),
                    status: bc_ai_chat::MessageStatus::Complete,
                    created_at: chrono::Utc::now(),
                    usage: None,
                    pending_tool_calls: Vec::new(),
                };
                self.chat.push_message(conversation_id, msg).await;
                Ok(())
            }
            bc_ai_tools::executor::ExecutionResult::Error(tr) => {
                let msg = bc_ai_chat::ChatMessage {
                    id: Uuid::new_v4(),
                    message: bc_ai_provider::Message::tool_result(
                        tr.tool_call_id,
                        tr.content,
                        tr.is_error,
                    ),
                    status: bc_ai_chat::MessageStatus::Complete,
                    created_at: chrono::Utc::now(),
                    usage: None,
                    pending_tool_calls: Vec::new(),
                };
                self.chat.push_message(conversation_id, msg).await;
                Ok(())
            }
            bc_ai_tools::executor::ExecutionResult::NeedsApproval { .. } => {
                Err("Unexpected: approved call still requires approval".into())
            }
        }
    }

    /// Cancel an in-progress generation.
    pub async fn cancel(&self, conversation_id: Uuid) -> bool {
        let cancellations = self.cancellations.read().await;
        if let Some(tx) = cancellations.get(&conversation_id) {
            let _ = tx.send(true);
            true
        } else {
            false
        }
    }
}
