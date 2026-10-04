//! Agent manager — bounded provider/task state and asynchronous turns.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use tokio::sync::{mpsc, oneshot, watch, RwLock};
use uuid::Uuid;

use bc_ai_chat::ChatManager;
use bc_ai_provider::anthropic::AnthropicProvider;
use bc_ai_provider::ollama::OllamaProvider;
use bc_ai_provider::openai::OpenAiProvider;
use bc_ai_provider::profile::MAX_PROVIDER_PROFILES;
use bc_ai_provider::{
    validate_provider_id, AiProvider, AiProviderError, AiProviderProfile, AiProviderProfileInput,
    ProviderProfile, ProviderProtocol,
};
use bc_ai_tools::executor::ToolExecutor;
use bc_ai_tools::permissions::{AiPermissions, AiToolDescriptor, ToolAvailability};
use bc_ai_tools::ToolRegistry;
use bc_mcp::McpGrantHandle;

use crate::agent;
use crate::config::{AgentConfig, AGENT_EVENT_CHANNEL_CAPACITY, DEFAULT_PERSONA_ID};
use crate::error::AgentError;
use crate::events::AgentEvent;
use crate::personas::{AiPersona, AiPersonaInput, PersonaStore};

const APPROVED_TOOL_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(120);

struct ActiveTurn {
    generation: Uuid,
    cancellation: watch::Sender<bool>,
    abort_handle: tokio::task::AbortHandle,
    /// Which provider profile this turn is generating against, so deleting a
    /// profile can stop exactly the turns still using it.
    provider_id: String,
}

struct ActiveApproval {
    generation: Uuid,
    cancellation: watch::Sender<bool>,
}

struct ApprovalGuard {
    approvals: Arc<Mutex<HashMap<Uuid, ActiveApproval>>>,
    conversation_id: Uuid,
    generation: Uuid,
}

impl Drop for ApprovalGuard {
    fn drop(&mut self) {
        if let Ok(mut approvals) = self.approvals.lock() {
            if approvals
                .get(&self.conversation_id)
                .is_some_and(|approval| approval.generation == self.generation)
            {
                approvals.remove(&self.conversation_id);
            }
        }
    }
}

/// Central AI agent manager, registered via `.manage()` in Tauri.
///
/// Both provider registries are keyed by a user-defined profile id, not by a
/// protocol: keying them by protocol gave an install exactly one OpenAI slot,
/// so configuring Groq evicted OpenAI and then displayed itself as OpenAI.
pub struct AgentManager {
    providers: RwLock<HashMap<String, Arc<dyn AiProvider + Send + Sync>>>,
    profiles: RwLock<HashMap<String, ProviderProfile>>,
    agent_config: RwLock<AgentConfig>,
    pub registry: Arc<ToolRegistry>,
    pub executor: Arc<ToolExecutor>,
    pub chat: Arc<ChatManager>,
    pub personas: Arc<PersonaStore>,
    active_turns: Arc<Mutex<HashMap<Uuid, ActiveTurn>>>,
    active_approvals: Arc<Mutex<HashMap<Uuid, ActiveApproval>>>,
}

impl Default for AgentManager {
    /// An agent with no MCP grant handle. Its executor holds an empty grant
    /// set, so every tool call is refused by the application layer — use
    /// [`AgentManager::with_mcp_grants`] to govern it by the grants the user
    /// actually configured.
    fn default() -> Self {
        Self::with_mcp_grants(McpGrantHandle::default())
    }
}

impl AgentManager {
    /// Build an agent governed by the application's live MCP grants.
    ///
    /// The handle is read-only: the agent observes what the user enabled in the
    /// MCP tool permissions and can narrow it, never widen it.
    pub fn with_mcp_grants(grants: McpGrantHandle) -> Self {
        // One enabled-tool set: the executor resolves permissions against the
        // same registry the provider tool list is built from.
        let registry = Arc::new(ToolRegistry::default());
        Self {
            providers: RwLock::new(HashMap::new()),
            profiles: RwLock::new(HashMap::new()),
            agent_config: RwLock::new(AgentConfig::default()),
            executor: Arc::new(ToolExecutor::with_registry_and_grants(
                Arc::clone(&registry),
                grants,
            )),
            registry,
            chat: Arc::new(ChatManager::default()),
            personas: Arc::new(PersonaStore::default()),
            active_turns: Arc::new(Mutex::new(HashMap::new())),
            active_approvals: Arc::new(Mutex::new(HashMap::new())),
        }
    }
}

/// Build the client for one profile. The protocol selects the implementation;
/// everything else about the endpoint comes from the profile.
fn build_provider(
    profile: &ProviderProfile,
) -> Result<Arc<dyn AiProvider + Send + Sync>, AgentError> {
    let config = profile.to_config();
    Ok(match profile.protocol {
        ProviderProtocol::OpenAi => Arc::new(OpenAiProvider::new(config)?),
        ProviderProtocol::Anthropic => Arc::new(AnthropicProvider::new(config)?),
        ProviderProtocol::Ollama => Arc::new(OllamaProvider::new(config)?),
    })
}

/// Pick an id for a profile the caller did not name.
///
/// The protocol's own name is used while it is free, so a first OpenAI profile
/// is `openai` — the same id a pre-profile payload migrates to. After that the
/// smallest free numeric suffix wins, and a profile is never given an id that
/// is already taken, which is the whole bug this change exists to fix.
fn generate_provider_id(
    taken: &HashMap<String, ProviderProfile>,
    protocol: ProviderProtocol,
) -> String {
    let base = protocol.as_str();
    if !taken.contains_key(base) {
        return base.to_string();
    }
    for suffix in 2..=(MAX_PROVIDER_PROFILES + 2) {
        let candidate = format!("{base}-{suffix}");
        if !taken.contains_key(&candidate) {
            return candidate;
        }
    }
    // Unreachable while the profile cap holds, but a collision here would
    // silently overwrite a stored credential, so fall back to a unique id.
    format!("{base}-{}", Uuid::new_v4().simple())
}

fn profile_limit(actual: usize) -> AgentError {
    AgentError::Provider(AiProviderError::LimitExceeded {
        resource: "provider profiles",
        limit: MAX_PROVIDER_PROFILES,
        actual,
    })
}

impl AgentManager {
    /// Create or update a provider profile, then store it with a live client.
    ///
    /// An input with no `id` creates; an input naming an id updates that
    /// profile, or creates it under exactly that id. Either way the write
    /// happens only after `health_check` succeeds, so a stored profile is one
    /// that answered.
    pub async fn configure_provider_profile(
        &self,
        input: AiProviderProfileInput,
    ) -> Result<AiProviderProfile, AgentError> {
        let profile = self.prepare_profile(input).await?;
        let provider = build_provider(&profile)?;
        provider.health_check().await?;
        self.store_profile(profile, provider).await
    }

    /// Decide the id and merge the input onto whatever is stored, without
    /// touching either registry.
    ///
    /// Split out from the write so the id, key-retention and cap rules can be
    /// exercised without a live endpoint to health-check against.
    async fn prepare_profile(
        &self,
        input: AiProviderProfileInput,
    ) -> Result<ProviderProfile, AgentError> {
        if let Some(id) = &input.id {
            validate_provider_id(id)?;
        }
        let profiles = self.profiles.read().await;
        let (id, existing) = match &input.id {
            Some(id) => (id.clone(), profiles.get(id).cloned()),
            None => (generate_provider_id(&profiles, input.protocol), None),
        };
        // Check the cap before the network call, so a refused create costs
        // nothing.
        if !profiles.contains_key(&id) && profiles.len() >= MAX_PROVIDER_PROFILES {
            return Err(profile_limit(profiles.len().saturating_add(1)));
        }
        drop(profiles);
        Ok(ProviderProfile::apply(id, existing.as_ref(), input)?)
    }

    /// Install a prepared profile together with its client, so the two
    /// registries cannot disagree about what is configured.
    async fn store_profile(
        &self,
        profile: ProviderProfile,
        provider: Arc<dyn AiProvider + Send + Sync>,
    ) -> Result<AiProviderProfile, AgentError> {
        let view = profile.view();
        let mut providers = self.providers.write().await;
        let mut profiles = self.profiles.write().await;
        if !profiles.contains_key(&profile.id) && profiles.len() >= MAX_PROVIDER_PROFILES {
            return Err(profile_limit(profiles.len().saturating_add(1)));
        }
        providers.insert(profile.id.clone(), provider);
        profiles.insert(profile.id.clone(), profile);
        Ok(view)
    }

    /// Remove a profile and every reference to it.
    ///
    /// Three things would otherwise dangle, so all three are handled here: the
    /// client instance, a `defaultProviderId` naming the profile, and any turn
    /// still generating against it. Returns whether a profile was removed.
    pub async fn delete_provider_profile(&self, id: &str) -> Result<bool, AgentError> {
        validate_provider_id(id)?;
        let removed = {
            let mut providers = self.providers.write().await;
            let mut profiles = self.profiles.write().await;
            providers.remove(id);
            profiles.remove(id).is_some()
        };
        if !removed {
            return Ok(false);
        }

        // A deletion must not leave the default pointing at nothing: a send
        // that silently fell through to another provider would ship the user's
        // prompt to an endpoint they did not choose.
        {
            let mut config = self.agent_config.write().await;
            if config.default_provider_id.as_deref() == Some(id) {
                config.default_provider_id = None;
            }
        }

        // A live turn holds its own `Arc` to the client, so it cannot dangle —
        // but it would keep streaming through a credential the user just
        // removed. Cancel it; the turn reports `Cancelled` to the renderer.
        let affected: Vec<Uuid> = self
            .active_turns
            .lock()
            .map_err(|_| AgentError::StateUnavailable)?
            .iter()
            .filter(|(_, turn)| turn.provider_id == id)
            .map(|(conversation_id, _)| *conversation_id)
            .collect();
        for conversation_id in affected {
            self.cancel(conversation_id).await?;
        }
        Ok(true)
    }

    pub async fn provider(&self, id: &str) -> Option<Arc<dyn AiProvider + Send + Sync>> {
        self.providers.read().await.get(id).cloned()
    }

    /// Every configured profile, in id order. Key-free by construction.
    pub async fn list_provider_profiles(&self) -> Vec<AiProviderProfile> {
        let mut profiles: Vec<AiProviderProfile> = self
            .profiles
            .read()
            .await
            .values()
            .map(ProviderProfile::view)
            .collect();
        profiles.sort_by(|left, right| left.id.cmp(&right.id));
        profiles
    }

    /// One configured profile, or `None`. Key-free by construction.
    pub async fn provider_profile(&self, id: &str) -> Option<AiProviderProfile> {
        self.profiles
            .read()
            .await
            .get(id)
            .map(ProviderProfile::view)
    }

    /// The profile a send should use.
    ///
    /// An explicit choice always wins. Otherwise the conversation's own
    /// profile is preferred — a transcript should keep talking to the
    /// connection it belongs to — and the configured default is the last
    /// resort. Resolving to nothing is an error: there is no "pick whatever is
    /// configured" case, because that would ship a prompt and a key to an
    /// endpoint the user did not choose.
    pub async fn resolve_provider_id(
        &self,
        conversation_id: Option<Uuid>,
        requested: Option<String>,
    ) -> Result<String, AgentError> {
        if let Some(id) = requested {
            validate_provider_id(&id)?;
            return Ok(id);
        }

        if let Some(conversation_id) = conversation_id {
            if let Some(id) = self.chat.provider(conversation_id).await {
                // Only when it still names something configured: an id left
                // over from a deleted profile must fall through rather than
                // fail a send the default could have served.
                if validate_provider_id(&id).is_ok() && self.provider(&id).await.is_some() {
                    return Ok(id);
                }
            }
        }

        let id = self
            .agent_config
            .read()
            .await
            .default_provider_id
            .clone()
            .ok_or_else(|| {
                AgentError::Provider(AiProviderError::NotConfigured(
                    "no default AI provider is selected".into(),
                ))
            })?;
        validate_provider_id(&id)?;
        Ok(id)
    }

    pub async fn agent_config(&self) -> AgentConfig {
        self.agent_config.read().await.clone()
    }

    pub async fn try_set_agent_config(&self, config: AgentConfig) -> Result<(), AgentError> {
        config.validate()?;
        let tools_enabled = config.tools_enabled;
        *self.agent_config.write().await = config;
        // Enforcement happens at dispatch, so the executor needs this flag too.
        self.executor.set_tools_enabled(tools_enabled).await;
        Ok(())
    }

    /// Current tool permission configuration.
    pub async fn permissions(&self) -> AiPermissions {
        self.executor.permissions().await
    }

    /// Validate and store a tool permission configuration, returning what was
    /// stored. The executor owns it, so a stored change takes effect at once.
    pub async fn try_set_permissions(
        &self,
        permissions: AiPermissions,
    ) -> Result<AiPermissions, AgentError> {
        Ok(self.executor.try_set_permissions(permissions).await?)
    }

    /// Every registered tool with its effective permission resolved.
    ///
    /// Deliberately does not touch the registry: reading the catalogue must
    /// not change which tools are enabled.
    pub async fn tool_catalog(&self) -> Vec<AiToolDescriptor> {
        self.executor.catalog().await
    }

    /// Whether tool dispatch is actually possible right now, and over how many
    /// tools. Resolving this runs no tool.
    pub async fn tool_availability(&self) -> ToolAvailability {
        self.executor.availability().await
    }

    pub async fn list_personas(&self) -> Vec<AiPersona> {
        self.personas.list().await
    }

    pub async fn create_persona(&self, input: AiPersonaInput) -> Result<AiPersona, AgentError> {
        self.personas.create(input).await
    }

    pub async fn update_persona(
        &self,
        id: &str,
        input: AiPersonaInput,
    ) -> Result<AiPersona, AgentError> {
        self.personas.update(id, input).await
    }

    /// Delete a custom persona, and stop pointing the configuration at it so a
    /// deletion cannot leave a dangling selection behind.
    pub async fn delete_persona(&self, id: &str) -> Result<(), AgentError> {
        self.personas.delete(id).await?;
        let mut config = self.agent_config.write().await;
        if config.persona_id == id {
            config.persona_id = DEFAULT_PERSONA_ID.to_string();
        }
        Ok(())
    }

    /// Start a turn against one provider profile and return its bounded event
    /// receiver immediately.
    pub async fn send_message(
        &self,
        conversation_id: Uuid,
        provider_id: &str,
    ) -> Result<mpsc::Receiver<AgentEvent>, AgentError> {
        validate_provider_id(provider_id)?;
        let provider = self.provider(provider_id).await.ok_or_else(|| {
            AgentError::Provider(AiProviderError::NotConfigured(provider_id.to_string()))
        })?;
        let config = self.agent_config.read().await.clone();
        config.validate()?;
        let disposal = self
            .chat
            .subscribe_disposal(conversation_id)
            .await
            .ok_or(bc_ai_chat::ChatError::ConversationNotFound(conversation_id))?;

        self.registry.init_all().await;
        self.executor.set_tools_enabled(config.tools_enabled).await;
        let persona_prompt = self.personas.system_prompt(&config.persona_id).await;
        let (event_tx, event_rx) = mpsc::channel(AGENT_EVENT_CHANNEL_CAPACITY);
        let (cancellation_tx, cancellation_rx) = watch::channel(false);
        let generation = Uuid::new_v4();

        let mut active_turns = self
            .active_turns
            .lock()
            .map_err(|_| AgentError::StateUnavailable)?;
        if let Ok(mut approvals) = self.active_approvals.lock() {
            if let Some(previous) = approvals.remove(&conversation_id) {
                let _ = previous.cancellation.send(true);
            }
        }
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
                persona_prompt,
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
                            error: error.public_message(),
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
                provider_id: provider_id.to_string(),
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
    ) -> Result<(), AgentError> {
        bc_ai_provider::limits::validate_string(
            "tool-call id",
            tool_call_id,
            bc_ai_provider::limits::MAX_TOOL_CALL_ID_BYTES,
        )?;
        let disposal = self
            .chat
            .subscribe_disposal(conversation_id)
            .await
            .ok_or(bc_ai_chat::ChatError::ConversationNotFound(conversation_id))?;
        let conversation = self
            .chat
            .get_conversation(conversation_id)
            .await
            .ok_or(bc_ai_chat::ChatError::ConversationNotFound(conversation_id))?;
        let pending = conversation
            .messages
            .iter()
            .flat_map(|message| message.pending_tool_calls.iter())
            .find(|tool_call| tool_call.id == tool_call_id)
            .cloned()
            .ok_or(AgentError::ToolCallNotFound)?;

        let result = self
            .run_approved_operation(
                conversation_id,
                disposal,
                self.executor.execute_approved(&pending),
            )
            .await?;
        match result {
            bc_ai_tools::executor::ExecutionResult::Success(result)
            | bc_ai_tools::executor::ExecutionResult::Error(result) => {
                self.push_tool_result(conversation_id, result).await?;
                Ok(())
            }
            // The permission changed while the call was pending. Record the
            // refusal so the transcript stays answerable, then fail the command
            // rather than reporting an approval that ran nothing.
            bc_ai_tools::executor::ExecutionResult::Denied(result) => {
                let reason = result.content.clone();
                self.push_tool_result(conversation_id, result).await?;
                Err(AgentError::ToolDenied { reason })
            }
            bc_ai_tools::executor::ExecutionResult::NeedsApproval { .. } => {
                Err(AgentError::UnexpectedApproval)
            }
            bc_ai_tools::executor::ExecutionResult::Rejected(error) => Err(error.into()),
        }
    }

    async fn push_tool_result(
        &self,
        conversation_id: Uuid,
        result: bc_ai_provider::ToolResult,
    ) -> Result<(), AgentError> {
        if result.content.len() > bc_ai_provider::limits::MAX_TOOL_RESULT_BYTES {
            return Err(AgentError::ToolOutputLimit {
                limit: bc_ai_provider::limits::MAX_TOOL_RESULT_BYTES,
                actual: result.content.len(),
            });
        }
        self.chat
            .try_push_message(conversation_id, agent::tool_result_message(result))
            .await?;
        Ok(())
    }

    async fn run_approved_operation<F>(
        &self,
        conversation_id: Uuid,
        disposal: watch::Receiver<bool>,
        operation: F,
    ) -> Result<bc_ai_tools::executor::ExecutionResult, AgentError>
    where
        F: std::future::Future<Output = bc_ai_tools::executor::ExecutionResult>,
    {
        self.run_approved_operation_with_timeout(
            conversation_id,
            disposal,
            operation,
            APPROVED_TOOL_TIMEOUT,
        )
        .await
    }

    async fn run_approved_operation_with_timeout<F>(
        &self,
        conversation_id: Uuid,
        mut disposal: watch::Receiver<bool>,
        operation: F,
        timeout: std::time::Duration,
    ) -> Result<bc_ai_tools::executor::ExecutionResult, AgentError>
    where
        F: std::future::Future<Output = bc_ai_tools::executor::ExecutionResult>,
    {
        if *disposal.borrow() {
            return Err(AgentError::ConversationDisposed(conversation_id));
        }
        let (cancellation_tx, mut cancellation_rx) = watch::channel(false);
        let generation = Uuid::new_v4();
        {
            let mut approvals = self
                .active_approvals
                .lock()
                .map_err(|_| AgentError::StateUnavailable)?;
            if let Some(previous) = approvals.remove(&conversation_id) {
                let _ = previous.cancellation.send(true);
            }
            approvals.insert(
                conversation_id,
                ActiveApproval {
                    generation,
                    cancellation: cancellation_tx,
                },
            );
        }
        let _guard = ApprovalGuard {
            approvals: Arc::clone(&self.active_approvals),
            conversation_id,
            generation,
        };

        tokio::pin!(operation);
        tokio::select! {
            result = &mut operation => Ok(result),
            _ = tokio::time::sleep(timeout) => {
                Err(AgentError::OperationTimedOut {
                    operation: "Approved AI tool operation",
                })
            }
            changed = cancellation_rx.changed() => {
                let _ = changed;
                Err(AgentError::Cancelled)
            }
            changed = disposal.changed() => {
                let _ = changed;
                Err(AgentError::ConversationDisposed(conversation_id))
            }
        }
    }

    /// Signal cancellation. The running task observes this even while blocked
    /// on provider or event-channel backpressure.
    pub async fn cancel(&self, conversation_id: Uuid) -> Result<bool, AgentError> {
        let turn_cancelled = self
            .active_turns
            .lock()
            .map_err(|_| AgentError::StateUnavailable)?
            .get(&conversation_id)
            .map(|turn| turn.cancellation.send(true).is_ok())
            .unwrap_or(false);
        let approval_cancelled = self
            .active_approvals
            .lock()
            .map_err(|_| AgentError::StateUnavailable)?
            .get(&conversation_id)
            .map(|approval| approval.cancellation.send(true).is_ok())
            .unwrap_or(false);
        Ok(turn_cancelled || approval_cancelled)
    }

    #[cfg(test)]
    async fn active_count(&self) -> usize {
        self.active_turns
            .lock()
            .map(|active_turns| active_turns.len())
            .unwrap_or_default()
    }

    #[cfg(test)]
    async fn active_approval_count(&self) -> usize {
        self.active_approvals
            .lock()
            .map(|approvals| approvals.len())
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
        if let Ok(mut approvals) = self.active_approvals.lock() {
            for (_, approval) in approvals.drain() {
                let _ = approval.cancellation.send(true);
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

    /// A user-chosen id, deliberately not a protocol name: every lookup in
    /// this module must go through the profile id.
    const MOCK_PROVIDER_ID: &str = "mock-lab";

    fn mock_provider(
        mode: MockMode,
    ) -> (
        Arc<dyn AiProvider + Send + Sync>,
        Arc<AtomicUsize>,
        Arc<AtomicBool>,
    ) {
        let produced = Arc::new(AtomicUsize::new(0));
        let stream_dropped = Arc::new(AtomicBool::new(false));
        let provider: Arc<dyn AiProvider + Send + Sync> = Arc::new(MockProvider {
            mode,
            produced: Arc::clone(&produced),
            stream_dropped: Arc::clone(&stream_dropped),
        });
        (provider, produced, stream_dropped)
    }

    async fn manager_with_provider(
        mode: MockMode,
    ) -> (AgentManager, Arc<AtomicUsize>, Arc<AtomicBool>) {
        let manager = AgentManager::default();
        let (provider, produced, stream_dropped) = mock_provider(mode);
        manager
            .store_profile(
                ProviderProfile::seed(MOCK_PROVIDER_ID, ProviderProtocol::Ollama),
                provider,
            )
            .await
            .expect("store the mock profile");
        (manager, produced, stream_dropped)
    }

    async fn create_conversation(manager: &AgentManager) -> Uuid {
        manager
            .chat
            .try_create_conversation(MOCK_PROVIDER_ID.into(), "mock".into(), None, None)
            .await
            .expect("conversation")
            .id
    }

    fn profile_input(protocol: ProviderProtocol, label: &str) -> AiProviderProfileInput {
        serde_json::from_value(serde_json::json!({
            "label": label,
            "protocol": protocol.as_str(),
            "model": "bounded-model",
            "temperature": 0.7,
            "maxTokens": 1024,
            "apiKey": "sk-secret-value",
        }))
        .expect("valid input")
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

    async fn wait_for_active_approval(manager: &AgentManager) {
        tokio::time::timeout(Duration::from_secs(2), async {
            while manager.active_approval_count().await != 1 {
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("approved operation must register");
    }

    #[tokio::test]
    async fn full_event_channel_applies_backpressure_until_drained() {
        let total = 1_000;
        let (manager, produced, _) = manager_with_provider(MockMode::Finite(total)).await;
        let conversation_id = create_conversation(&manager).await;
        let mut events = manager
            .send_message(conversation_id, MOCK_PROVIDER_ID)
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
            .send_message(conversation_id, MOCK_PROVIDER_ID)
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
            .send_message(conversation_id, MOCK_PROVIDER_ID)
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
            .send_message(conversation_id, MOCK_PROVIDER_ID)
            .await
            .expect("start turn");
        events.recv().await.expect("first event");

        assert!(manager
            .cancel(conversation_id)
            .await
            .expect("cancel generation"));
        wait_for_flag(&stream_dropped).await;
        wait_for_no_active_turns(&manager).await;
    }

    #[tokio::test]
    async fn manager_drop_terminates_endless_provider() {
        let (manager, _, stream_dropped) = manager_with_provider(MockMode::Endless).await;
        let conversation_id = create_conversation(&manager).await;
        let mut events = manager
            .send_message(conversation_id, MOCK_PROVIDER_ID)
            .await
            .expect("start turn");
        events.recv().await.expect("first event");

        drop(manager);
        wait_for_flag(&stream_dropped).await;
    }

    #[tokio::test]
    async fn conversation_disposal_terminates_pending_approved_operation() {
        let manager = Arc::new(AgentManager::default());
        let conversation_id = create_conversation(&manager).await;
        let disposal = manager
            .chat
            .subscribe_disposal(conversation_id)
            .await
            .expect("disposal subscription");
        let task_manager = Arc::clone(&manager);
        let task = tokio::spawn(async move {
            task_manager
                .run_approved_operation(
                    conversation_id,
                    disposal,
                    std::future::pending::<bc_ai_tools::executor::ExecutionResult>(),
                )
                .await
        });

        wait_for_active_approval(&manager).await;
        assert!(manager.chat.delete_conversation(conversation_id).await);
        assert!(matches!(
            task.await.expect("approval task"),
            Err(AgentError::ConversationDisposed(id)) if id == conversation_id
        ));
        assert_eq!(manager.active_approval_count().await, 0);
    }

    #[tokio::test]
    async fn explicit_cancellation_terminates_pending_approved_operation() {
        let manager = Arc::new(AgentManager::default());
        let conversation_id = create_conversation(&manager).await;
        let disposal = manager
            .chat
            .subscribe_disposal(conversation_id)
            .await
            .expect("disposal subscription");
        let task_manager = Arc::clone(&manager);
        let task = tokio::spawn(async move {
            task_manager
                .run_approved_operation(
                    conversation_id,
                    disposal,
                    std::future::pending::<bc_ai_tools::executor::ExecutionResult>(),
                )
                .await
        });

        wait_for_active_approval(&manager).await;
        assert!(manager
            .cancel(conversation_id)
            .await
            .expect("cancel approved operation"));
        assert!(matches!(
            task.await.expect("approval task"),
            Err(AgentError::Cancelled)
        ));
        assert_eq!(manager.active_approval_count().await, 0);
    }

    fn persona_input(name: &str) -> AiPersonaInput {
        AiPersonaInput {
            name: name.into(),
            description: "Bounded".into(),
            system_prompt: "You are bounded.".into(),
        }
    }

    /// `toolsEnabled` is configuration, but it has to be enforced where tools
    /// are dispatched. Setting it must move the gate, not just the record.
    #[tokio::test]
    async fn disabling_tools_in_the_configuration_reaches_the_dispatch_gate() {
        let manager = AgentManager::default();
        manager.registry.init_all().await;
        assert_eq!(
            manager.executor.decision("cf_list_zones").await,
            bc_ai_tools::permissions::PermissionDecision::Allow
        );

        let mut config = manager.agent_config().await;
        config.tools_enabled = false;
        manager
            .try_set_agent_config(config.clone())
            .await
            .expect("valid config");
        assert!(matches!(
            manager.executor.decision("cf_list_zones").await,
            bc_ai_tools::permissions::PermissionDecision::Deny { .. }
        ));

        config.tools_enabled = true;
        manager
            .try_set_agent_config(config)
            .await
            .expect("valid config");
        assert_eq!(
            manager.executor.decision("cf_list_zones").await,
            bc_ai_tools::permissions::PermissionDecision::Allow
        );
    }

    #[tokio::test]
    async fn permissions_round_trip_and_an_unknown_tool_is_not_stored() {
        let manager = AgentManager::default();
        let stored = manager
            .try_set_permissions(AiPermissions {
                mode: bc_ai_tools::permissions::AiPermissionMode::ReadOnly,
                tools: std::collections::BTreeMap::from([(
                    "cf_delete_dns_record".to_string(),
                    bc_ai_tools::permissions::AiToolPermission::Deny,
                )]),
            })
            .await
            .expect("valid permissions");
        assert_eq!(stored, manager.permissions().await);

        let error = manager
            .try_set_permissions(AiPermissions {
                mode: bc_ai_tools::permissions::AiPermissionMode::Autonomous,
                tools: std::collections::BTreeMap::from([(
                    "cf_not_a_tool".to_string(),
                    bc_ai_tools::permissions::AiToolPermission::Allow,
                )]),
            })
            .await
            .expect_err("unknown tool names must be refused");
        assert!(matches!(error, AgentError::Tool(_)));
        assert_eq!(manager.permissions().await, stored);
    }

    #[tokio::test]
    async fn deleting_the_selected_persona_resets_the_configuration() {
        let manager = AgentManager::default();
        let persona = manager
            .create_persona(persona_input("Selected"))
            .await
            .expect("create");

        let mut config = manager.agent_config().await;
        config.persona_id = persona.id.clone();
        manager
            .try_set_agent_config(config)
            .await
            .expect("a custom persona id is a valid selection");
        assert_eq!(
            manager.personas.system_prompt(&persona.id).await.as_deref(),
            Some("You are bounded.")
        );

        manager.delete_persona(&persona.id).await.expect("delete");
        assert_eq!(manager.agent_config().await.persona_id, DEFAULT_PERSONA_ID);
        assert_eq!(manager.personas.system_prompt(&persona.id).await, None);
    }

    #[tokio::test]
    async fn deleting_an_unselected_persona_leaves_the_selection_alone() {
        let manager = AgentManager::default();
        let keep = manager
            .create_persona(persona_input("Keep"))
            .await
            .expect("create");
        let drop = manager
            .create_persona(persona_input("Drop"))
            .await
            .expect("create");

        let mut config = manager.agent_config().await;
        config.persona_id = keep.id.clone();
        manager.try_set_agent_config(config).await.expect("valid");

        manager.delete_persona(&drop.id).await.expect("delete");
        assert_eq!(manager.agent_config().await.persona_id, keep.id);
    }

    #[tokio::test]
    async fn a_builtin_persona_survives_delete_attempts_through_the_manager() {
        let manager = AgentManager::default();
        assert!(matches!(
            manager.delete_persona("dns-expert").await,
            Err(AgentError::PersonaImmutable)
        ));
        assert!(matches!(
            manager
                .update_persona("dns-expert", persona_input("Hijacked"))
                .await,
            Err(AgentError::PersonaImmutable)
        ));
        assert!(manager
            .list_personas()
            .await
            .iter()
            .any(|persona| persona.id == "dns-expert" && persona.builtin));
        assert_eq!(manager.agent_config().await.persona_id, DEFAULT_PERSONA_ID);
    }

    /// Where the grants come from: the live MCP state, not a copy taken at
    /// construction. Editing the MCP tool permissions has to move the agent's
    /// availability, or the assistant would be governed by stale grants.
    #[tokio::test]
    async fn tool_availability_tracks_the_live_mcp_grants() {
        let mcp = bc_mcp::McpServerManager::default();
        let manager = AgentManager::with_mcp_grants(mcp.grant_handle());
        manager.registry.init_all().await;

        let before = manager.tool_availability().await;
        assert!(
            !before.dispatch_available,
            "nothing is granted until the user enables something"
        );
        assert_eq!(before.granted_tool_count, 0);
        assert_eq!(
            before.registered_tool_count,
            manager.registry.available_descriptors().len()
        );

        mcp.set_enabled_tools(vec!["dns_parse_spf".to_string()])
            .await
            .expect("grants stored");

        let after = manager.tool_availability().await;
        assert!(after.dispatch_available);
        assert_eq!(after.granted_tool_count, 1);
        assert_eq!(after.usable_tool_count, 1);
    }

    /// An agent built without a grant handle has no tools, rather than all of
    /// them: the fail-closed default.
    #[tokio::test]
    async fn an_agent_without_mcp_grants_reports_no_tools() {
        let manager = AgentManager::default();
        manager.registry.init_all().await;
        let availability = manager.tool_availability().await;
        assert!(!availability.dispatch_available);
        assert_eq!(availability.granted_tool_count, 0);
        assert!(availability.registered_tool_count > 0);
    }

    #[tokio::test]
    async fn the_catalog_covers_every_registered_tool() {
        let manager = AgentManager::default();
        let catalog = manager.tool_catalog().await;
        assert_eq!(
            catalog.len(),
            manager.registry.available_descriptors().len()
        );
        assert!(catalog
            .iter()
            .any(|descriptor| descriptor.name == "cf_list_zones"));
    }

    #[tokio::test]
    async fn approved_operation_timeout_releases_lifecycle_state() {
        let manager = AgentManager::default();
        let conversation_id = create_conversation(&manager).await;
        let disposal = manager
            .chat
            .subscribe_disposal(conversation_id)
            .await
            .expect("disposal subscription");

        let result = manager
            .run_approved_operation_with_timeout(
                conversation_id,
                disposal,
                std::future::pending::<bc_ai_tools::executor::ExecutionResult>(),
                Duration::from_millis(1),
            )
            .await;
        assert!(matches!(
            result,
            Err(AgentError::OperationTimedOut {
                operation: "Approved AI tool operation"
            })
        ));
        assert_eq!(manager.active_approval_count().await, 0);
    }

    /// The bug this change exists to fix: with one slot per protocol,
    /// configuring a second OpenAI-compatible endpoint evicted the first and
    /// then answered to its name.
    #[tokio::test]
    async fn two_profiles_can_share_one_protocol_without_evicting_each_other() {
        let manager = AgentManager::default();

        let official = manager
            .prepare_profile(profile_input(ProviderProtocol::OpenAi, "OpenAI"))
            .await
            .expect("prepare");
        manager
            .store_profile(official, mock_provider(MockMode::Finite(1)).0)
            .await
            .expect("store");

        let groq_input = AiProviderProfileInput {
            base_url: Some("https://api.groq.com/openai/v1".into()),
            model: "llama-3.3-70b-versatile".into(),
            ..profile_input(ProviderProtocol::OpenAi, "Groq")
        };
        let groq = manager.prepare_profile(groq_input).await.expect("prepare");
        assert_eq!(groq.id, "openai-2", "a generated id must not collide");
        manager
            .store_profile(groq, mock_provider(MockMode::Finite(1)).0)
            .await
            .expect("store");

        let profiles = manager.list_provider_profiles().await;
        assert_eq!(profiles.len(), 2);
        assert_eq!(profiles[0].id, "openai");
        assert_eq!(profiles[0].label, "OpenAI");
        assert_eq!(profiles[0].base_url, "https://api.openai.com/v1");
        assert_eq!(profiles[1].id, "openai-2");
        assert_eq!(profiles[1].label, "Groq");
        assert_eq!(profiles[1].base_url, "https://api.groq.com/openai/v1");
        assert_eq!(profiles[1].model, "llama-3.3-70b-versatile");
        assert!(profiles.iter().all(|profile| profile.has_api_key));
        assert!(manager.provider("openai").await.is_some());
        assert!(manager.provider("openai-2").await.is_some());

        // And no list the renderer receives can carry a key.
        let serialized = serde_json::to_string(&profiles).expect("serializes");
        assert!(!serialized.contains("sk-secret-value"), "{serialized}");
        assert!(!serialized.contains("apiKey"), "{serialized}");
    }

    #[tokio::test]
    async fn an_update_under_a_known_id_replaces_it_and_keeps_the_key() {
        let manager = AgentManager::default();
        let created = manager
            .prepare_profile(profile_input(ProviderProtocol::OpenAi, "First"))
            .await
            .expect("prepare");
        manager
            .store_profile(created, mock_provider(MockMode::Finite(1)).0)
            .await
            .expect("store");

        let update: AiProviderProfileInput = serde_json::from_value(serde_json::json!({
            "id": "openai",
            "label": "Renamed",
            "protocol": "openai",
            "model": "gpt-4o-mini",
            "temperature": 0.2,
            "maxTokens": 512,
        }))
        .expect("valid input");
        let updated = manager.prepare_profile(update).await.expect("prepare");
        assert_eq!(updated.id, "openai");
        assert_eq!(updated.label, "Renamed");
        assert_eq!(
            updated.api_key.as_deref(),
            Some("sk-secret-value"),
            "an absent apiKey must not wipe the stored credential"
        );
        manager
            .store_profile(updated, mock_provider(MockMode::Finite(1)).0)
            .await
            .expect("store");
        assert_eq!(
            manager.list_provider_profiles().await.len(),
            1,
            "an update must not add a second profile"
        );
    }

    #[tokio::test]
    async fn the_profile_count_is_capped() {
        let manager = AgentManager::default();
        for index in 0..MAX_PROVIDER_PROFILES {
            let profile = manager
                .prepare_profile(profile_input(
                    ProviderProtocol::OpenAi,
                    &format!("P{index}"),
                ))
                .await
                .expect("within the cap");
            manager
                .store_profile(profile, mock_provider(MockMode::Finite(1)).0)
                .await
                .expect("store");
        }
        let error = manager
            .prepare_profile(profile_input(ProviderProtocol::OpenAi, "one too many"))
            .await
            .expect_err("the cap must hold");
        assert!(matches!(
            error,
            AgentError::Provider(AiProviderError::LimitExceeded {
                resource: "provider profiles",
                limit: MAX_PROVIDER_PROFILES,
                ..
            })
        ));
        assert_eq!(
            manager.list_provider_profiles().await.len(),
            MAX_PROVIDER_PROFILES
        );

        // An update is not a create, so the cap must not block an edit.
        let update = AiProviderProfileInput {
            id: Some("openai".into()),
            ..profile_input(ProviderProtocol::OpenAi, "Edited at the cap")
        };
        let updated = manager.prepare_profile(update).await.expect("edit at cap");
        assert_eq!(updated.label, "Edited at the cap");
    }

    #[tokio::test]
    async fn a_malformed_id_is_refused_rather_than_rewritten() {
        let manager = AgentManager::default();
        for refused in ["my profile", "../../etc/passwd", "", &"i".repeat(65)] {
            let input = AiProviderProfileInput {
                id: Some(refused.into()),
                ..profile_input(ProviderProtocol::Ollama, "Bad id")
            };
            let error = manager
                .prepare_profile(input)
                .await
                .expect_err("a malformed id must be refused");
            assert!(
                matches!(
                    error,
                    AgentError::Provider(AiProviderError::InvalidRequest { field: "id", .. })
                ),
                "id {refused:?} produced {error:?}"
            );
        }
        assert!(manager.list_provider_profiles().await.is_empty());
        assert!(matches!(
            manager.delete_provider_profile("my profile").await,
            Err(AgentError::Provider(AiProviderError::InvalidRequest {
                field: "id",
                ..
            }))
        ));
    }

    /// A profile pointing at a non-HTTP scheme must be impossible to store,
    /// whichever way the write arrives.
    #[tokio::test]
    async fn a_profile_cannot_be_pointed_at_a_non_http_scheme() {
        let manager = AgentManager::default();
        for refused in ["file:///etc/passwd", "ftp://example.com", "javascript:x"] {
            let input = AiProviderProfileInput {
                base_url: Some(refused.into()),
                ..profile_input(ProviderProtocol::OpenAi, "Hostile")
            };
            let error = manager
                .prepare_profile(input)
                .await
                .expect_err("a non-HTTP base URL must be refused");
            assert!(
                matches!(
                    error,
                    AgentError::Provider(AiProviderError::InvalidRequest {
                        field: "baseUrl",
                        ..
                    })
                ),
                "base URL {refused:?} produced {error:?}"
            );
        }
        assert!(manager.list_provider_profiles().await.is_empty());
    }

    #[tokio::test]
    async fn deleting_the_default_profile_clears_the_selection() {
        let (manager, _, _) = manager_with_provider(MockMode::Finite(1)).await;
        let mut config = manager.agent_config().await;
        config.default_provider_id = Some(MOCK_PROVIDER_ID.into());
        manager
            .try_set_agent_config(config)
            .await
            .expect("a profile id is a valid selection");
        assert_eq!(
            manager
                .resolve_provider_id(None, None)
                .await
                .expect("the default resolves"),
            MOCK_PROVIDER_ID
        );

        assert!(manager
            .delete_provider_profile(MOCK_PROVIDER_ID)
            .await
            .expect("delete"));
        assert_eq!(manager.agent_config().await.default_provider_id, None);
        assert!(manager.provider(MOCK_PROVIDER_ID).await.is_none());
        assert!(manager.provider_profile(MOCK_PROVIDER_ID).await.is_none());

        // With nothing selected, a send must fail rather than fall through to
        // whatever other provider happens to be configured.
        assert!(matches!(
            manager.resolve_provider_id(None, None).await,
            Err(AgentError::Provider(AiProviderError::NotConfigured(_)))
        ));
        assert!(!manager
            .delete_provider_profile(MOCK_PROVIDER_ID)
            .await
            .expect("a second delete is not an error"));
    }

    #[tokio::test]
    async fn deleting_an_unselected_profile_leaves_the_selection_alone() {
        let (manager, _, _) = manager_with_provider(MockMode::Finite(1)).await;
        let other = manager
            .prepare_profile(profile_input(ProviderProtocol::Ollama, "Other"))
            .await
            .expect("prepare");
        let other_id = other.id.clone();
        manager
            .store_profile(other, mock_provider(MockMode::Finite(1)).0)
            .await
            .expect("store");

        let mut config = manager.agent_config().await;
        config.default_provider_id = Some(MOCK_PROVIDER_ID.into());
        manager.try_set_agent_config(config).await.expect("valid");

        assert!(manager
            .delete_provider_profile(&other_id)
            .await
            .expect("delete"));
        assert_eq!(
            manager.agent_config().await.default_provider_id.as_deref(),
            Some(MOCK_PROVIDER_ID)
        );
    }

    /// A turn holds its own `Arc` to the client, so deleting the profile
    /// cannot dangle — but it would keep streaming through a credential the
    /// user just removed. The turn using it stops; others carry on.
    #[tokio::test]
    async fn deleting_a_profile_stops_only_the_turns_using_it() {
        let (manager, _, deleted_stream_dropped) = manager_with_provider(MockMode::Endless).await;
        let survivor = manager
            .prepare_profile(profile_input(ProviderProtocol::Ollama, "Survivor"))
            .await
            .expect("prepare");
        let survivor_id = survivor.id.clone();
        let (survivor_provider, _, survivor_stream_dropped) = mock_provider(MockMode::Endless);
        manager
            .store_profile(survivor, survivor_provider)
            .await
            .expect("store");

        let doomed_conversation = create_conversation(&manager).await;
        let mut doomed_events = manager
            .send_message(doomed_conversation, MOCK_PROVIDER_ID)
            .await
            .expect("start the doomed turn");
        doomed_events.recv().await.expect("first event");

        let kept_conversation = create_conversation(&manager).await;
        let mut kept_events = manager
            .send_message(kept_conversation, &survivor_id)
            .await
            .expect("start the kept turn");
        kept_events.recv().await.expect("first event");

        assert!(manager
            .delete_provider_profile(MOCK_PROVIDER_ID)
            .await
            .expect("delete"));

        let cancelled = tokio::time::timeout(Duration::from_secs(2), async {
            while let Some(event) = doomed_events.recv().await {
                if matches!(event, AgentEvent::Cancelled { conversation_id } if conversation_id == doomed_conversation)
                {
                    return true;
                }
            }
            false
        })
        .await
        .expect("the deleted profile's turn must terminate");
        assert!(cancelled, "the renderer must be told the turn stopped");
        wait_for_flag(&deleted_stream_dropped).await;

        // The other turn was never touched: still streaming, still live.
        kept_events.recv().await.expect("the kept turn continues");
        assert!(!survivor_stream_dropped.load(Ordering::SeqCst));
        assert!(manager.provider(&survivor_id).await.is_some());
    }

    #[tokio::test]
    async fn a_turn_cannot_be_started_against_an_unknown_or_malformed_profile() {
        let (manager, _, _) = manager_with_provider(MockMode::Finite(1)).await;
        let conversation_id = create_conversation(&manager).await;

        assert!(matches!(
            manager
                .send_message(conversation_id, "not-configured")
                .await,
            Err(AgentError::Provider(AiProviderError::NotConfigured(_)))
        ));
        assert!(matches!(
            manager.send_message(conversation_id, "bad id").await,
            Err(AgentError::Provider(AiProviderError::InvalidRequest {
                field: "id",
                ..
            }))
        ));
        assert_eq!(manager.active_count().await, 0);
    }

    /// A transcript belongs to the connection it was started against, so a
    /// send that names no profile keeps talking to that one rather than to
    /// whatever the global default happens to be.
    #[tokio::test]
    async fn a_send_prefers_the_conversations_own_profile_over_the_default() {
        let (manager, _, _) = manager_with_provider(MockMode::Finite(1)).await;
        let own = manager
            .prepare_profile(profile_input(ProviderProtocol::Ollama, "Own"))
            .await
            .expect("prepare");
        let own_id = own.id.clone();
        manager
            .store_profile(own, mock_provider(MockMode::Finite(1)).0)
            .await
            .expect("store");

        let mut config = manager.agent_config().await;
        config.default_provider_id = Some(MOCK_PROVIDER_ID.into());
        manager.try_set_agent_config(config).await.expect("valid");

        let conversation_id = manager
            .chat
            .try_create_conversation(own_id.clone(), "mock".into(), None, None)
            .await
            .expect("conversation")
            .id;
        assert_eq!(
            manager
                .resolve_provider_id(Some(conversation_id), None)
                .await
                .expect("the conversation's own profile resolves"),
            own_id
        );

        // Once that profile is gone its id must not fail the send: the
        // configured default takes over.
        assert!(manager
            .delete_provider_profile(&own_id)
            .await
            .expect("delete"));
        assert_eq!(
            manager
                .resolve_provider_id(Some(conversation_id), None)
                .await
                .expect("the default takes over"),
            MOCK_PROVIDER_ID
        );
    }

    #[tokio::test]
    async fn an_explicit_provider_id_wins_over_the_default() {
        let (manager, _, _) = manager_with_provider(MockMode::Finite(1)).await;
        let mut config = manager.agent_config().await;
        config.default_provider_id = Some(MOCK_PROVIDER_ID.into());
        manager.try_set_agent_config(config).await.expect("valid");

        let conversation_id = create_conversation(&manager).await;
        assert_eq!(
            manager
                .resolve_provider_id(Some(conversation_id), Some("chosen-by-hand".into()))
                .await
                .expect("an explicit id is used as given"),
            "chosen-by-hand"
        );
        assert!(matches!(
            manager
                .resolve_provider_id(None, Some("bad id".into()))
                .await,
            Err(AgentError::Provider(AiProviderError::InvalidRequest {
                field: "id",
                ..
            }))
        ));
    }
}
