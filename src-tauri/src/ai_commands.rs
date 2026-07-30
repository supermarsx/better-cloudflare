//! Tauri commands for the AI assistant subsystem.
//!
//! Bounded delegates that preserve structured, secret-safe failures.

use std::future::Future;
use std::io::{self, Write};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, State};
use tokio::sync::mpsc;
use uuid::Uuid;

use bc_ai_agent::{AgentConfig, AgentError, AgentEvent, AgentManager};
use bc_ai_chat::{ChatError, ChatMessage, ConversationMeta};
use bc_ai_provider::{AiProviderError, Model, ProviderConfig, ProviderKind};
use bc_ai_tools::ToolExecutionError;
use bc_error::sanitize_error_text;

const MAX_MODEL_RESULTS: usize = 1_024;
const MAX_MODEL_DISPLAY_NAME_BYTES: usize = 512;
const MAX_CONVERSATION_EXPORT_BYTES: usize = 8 * 1024 * 1024;
const PROVIDER_COMMAND_TIMEOUT: Duration = Duration::from_secs(30);

/// Stable structured failure returned by every fallible AI Tauri command.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AiCommandError {
    pub code: &'static str,
    pub message: String,
    pub source: &'static str,
    pub operation: &'static str,
    pub retryable: bool,
    pub details: Box<AiCommandErrorDetails>,
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AiCommandErrorDetails {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub kind: Option<&'static str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub status: Option<u16>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub field: Option<&'static str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub resource: Option<&'static str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub limit: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub actual: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub remediation: Option<&'static str>,
}

impl AiCommandError {
    fn new(code: &'static str, message: impl AsRef<str>, operation: &'static str) -> Self {
        Self {
            code,
            message: sanitize_error_text(message.as_ref()),
            source: "tauri",
            operation,
            retryable: false,
            details: Box::default(),
        }
    }

    fn limit(resource: &'static str, limit: usize, actual: usize, operation: &'static str) -> Self {
        let mut error = Self::new(
            "AI_LIMIT_EXCEEDED",
            format!("{resource} exceeded the local safety limit."),
            operation,
        );
        error.details.resource = Some(resource);
        error.details.limit = Some(limit);
        error.details.actual = Some(actual);
        error.details.remediation = Some("Reduce the input or result size and try again.");
        error
    }

    fn validation(field: &'static str, message: impl AsRef<str>, operation: &'static str) -> Self {
        let mut error = Self::new(
            "AI_VALIDATION",
            format!(
                "Invalid {field}: {}.",
                sanitize_error_text(message.as_ref())
            ),
            operation,
        );
        error.details.field = Some(field);
        error.details.remediation = Some("Correct the bounded AI setting or input and retry.");
        error
    }

    fn timeout(operation: &'static str) -> Self {
        let mut error = Self::new(
            "AI_TIMEOUT",
            "The AI provider operation timed out.",
            operation,
        );
        error.retryable = true;
        error.details.kind = Some("timeout");
        error.details.remediation = Some("Check provider availability and retry once.");
        error
    }
}

impl std::fmt::Display for AiCommandError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(&self.message)
    }
}

impl std::error::Error for AiCommandError {}

fn map_provider_error(error: AiProviderError, operation: &'static str) -> AiCommandError {
    match error {
        AiProviderError::LimitExceeded {
            resource,
            limit,
            actual,
        } => AiCommandError::limit(resource, limit, actual, operation),
        AiProviderError::InvalidRequest { field, message } => {
            AiCommandError::validation(field, message, operation)
        }
        AiProviderError::AuthFailed(_) => {
            let mut error = AiCommandError::new(
                "AI_AUTH_FAILED",
                "AI provider authentication failed.",
                operation,
            );
            error.details.kind = Some("authentication");
            error.details.remediation = Some("Verify the provider credential and permissions.");
            error
        }
        AiProviderError::RateLimited { retry_after_ms } => {
            let mut error = AiCommandError::new(
                "AI_RATE_LIMITED",
                "The AI provider rate-limited the request.",
                operation,
            );
            error.details.kind = Some("rate_limited");
            error.details.status = Some(429);
            error.retryable = true;
            error.details.remediation = Some(match retry_after_ms {
                Some(_) => "Wait for the provider retry interval, then try again.",
                None => "Wait briefly, then try again.",
            });
            error
        }
        AiProviderError::Http(error) if error.is_timeout() => {
            let mut mapped = AiCommandError::new(
                "AI_TIMEOUT",
                "The AI provider request timed out.",
                operation,
            );
            mapped.details.kind = Some("timeout");
            mapped.retryable = true;
            mapped.details.remediation = Some("Check provider availability and retry once.");
            mapped
        }
        AiProviderError::Http(_) | AiProviderError::StreamClosed(_) => {
            let mut mapped = AiCommandError::new(
                "AI_NETWORK",
                "The AI provider could not be reached.",
                operation,
            );
            mapped.details.kind = Some("network");
            mapped.retryable = true;
            mapped.details.remediation = Some("Check connectivity and provider availability.");
            mapped
        }
        AiProviderError::Api { status, .. } => {
            let mut mapped = AiCommandError::new(
                "AI_PROVIDER",
                format!("The AI provider rejected the request (HTTP {status})."),
                operation,
            );
            mapped.details.kind = Some("provider");
            mapped.details.status = Some(status);
            mapped.retryable = status == 429 || status >= 500;
            mapped.details.remediation =
                Some("Inspect the status code and provider configuration.");
            mapped
        }
        AiProviderError::Parse(_) => {
            let mut mapped = AiCommandError::new(
                "AI_MALFORMED_RESPONSE",
                "The AI provider returned an invalid response.",
                operation,
            );
            mapped.details.kind = Some("malformed_response");
            mapped.retryable = true;
            mapped.details.remediation = Some("Retry once, then check provider compatibility.");
            mapped
        }
        AiProviderError::ModelNotFound(_) => {
            AiCommandError::validation("model", "the selected model is unavailable", operation)
        }
        AiProviderError::NotConfigured(_) => {
            let mut mapped = AiCommandError::new(
                "AI_NOT_CONFIGURED",
                "The selected AI provider is not configured.",
                operation,
            );
            mapped.details.remediation =
                Some("Configure and test the provider before sending a message.");
            mapped
        }
        AiProviderError::Cancelled => {
            AiCommandError::new("ERR_CANCELED", "The AI request was cancelled.", operation)
        }
        AiProviderError::TokenLimitExceeded(_) => {
            AiCommandError::validation("tokens", "the token budget was exceeded", operation)
        }
        AiProviderError::Other(_) => {
            AiCommandError::new("AI_PROVIDER", "The AI provider request failed.", operation)
        }
    }
}

fn map_chat_error(error: ChatError, operation: &'static str) -> AiCommandError {
    match error {
        ChatError::ConversationNotFound(_) => AiCommandError::new(
            "AI_CONVERSATION_NOT_FOUND",
            "The AI conversation was not found.",
            operation,
        ),
        ChatError::LimitExceeded {
            resource,
            limit,
            actual,
        } => AiCommandError::limit(resource, limit, actual, operation),
        ChatError::InvalidField { field, message } => {
            AiCommandError::validation(field, message, operation)
        }
    }
}

fn map_tool_error(error: ToolExecutionError, operation: &'static str) -> AiCommandError {
    match error {
        ToolExecutionError::LimitExceeded {
            resource,
            limit,
            actual,
        } => AiCommandError::limit(resource, limit, actual, operation),
        ToolExecutionError::InvalidInput { field, message } => {
            AiCommandError::validation(field, message, operation)
        }
        ToolExecutionError::Serialization => AiCommandError::new(
            "AI_TOOL_SERIALIZATION",
            "The AI tool result could not be serialized safely.",
            operation,
        ),
    }
}

fn map_agent_error(error: AgentError, operation: &'static str) -> AiCommandError {
    match error {
        AgentError::Provider(error) => map_provider_error(error, operation),
        AgentError::Chat(error) => map_chat_error(error, operation),
        AgentError::Tool(error) => map_tool_error(error, operation),
        AgentError::InvalidConfig { field, message } => {
            AiCommandError::validation(field, message, operation)
        }
        AgentError::ConversationDisposed(_) => AiCommandError::new(
            "AI_CONVERSATION_DISPOSED",
            "The AI conversation was closed while work was active.",
            operation,
        ),
        AgentError::Cancelled => {
            AiCommandError::new("ERR_CANCELED", "The AI request was cancelled.", operation)
        }
        AgentError::ConsumerDropped => AiCommandError::new(
            "AI_CONSUMER_DISCONNECTED",
            "The AI event consumer disconnected.",
            operation,
        ),
        AgentError::ToolRoundLimit(limit) => AiCommandError::limit(
            "tool rounds",
            limit as usize,
            limit.saturating_add(1) as usize,
            operation,
        ),
        AgentError::ToolOutputLimit { limit, actual } => {
            AiCommandError::limit("tool output", limit, actual, operation)
        }
        AgentError::ToolCallNotFound => AiCommandError::new(
            "AI_TOOL_CALL_NOT_FOUND",
            "The pending AI tool call was not found.",
            operation,
        ),
        AgentError::UnexpectedApproval => AiCommandError::new(
            "AI_TOOL_APPROVAL_INVALID",
            "The approved AI tool call could not be executed.",
            operation,
        ),
        AgentError::StateUnavailable => {
            let mut error = AiCommandError::new(
                "AI_STATE_UNAVAILABLE",
                "The AI subsystem is temporarily unavailable.",
                operation,
            );
            error.retryable = true;
            error
        }
        AgentError::OperationTimedOut { .. } => AiCommandError::timeout(operation),
    }
}

async fn run_bounded_command<T, E, F, M>(
    future: F,
    timeout: Duration,
    operation: &'static str,
    map_error: M,
) -> Result<T, AiCommandError>
where
    F: Future<Output = Result<T, E>>,
    M: FnOnce(E) -> AiCommandError,
{
    match tokio::time::timeout(timeout, future).await {
        Ok(result) => result.map_err(map_error),
        Err(_) => Err(AiCommandError::timeout(operation)),
    }
}

fn validate_models(models: &[Model], operation: &'static str) -> Result<(), AiCommandError> {
    if models.len() > MAX_MODEL_RESULTS {
        return Err(AiCommandError::limit(
            "model results",
            MAX_MODEL_RESULTS,
            models.len(),
            operation,
        ));
    }
    for model in models {
        bc_ai_provider::limits::validate_string(
            "model id",
            &model.id,
            bc_ai_provider::limits::MAX_MODEL_BYTES,
        )
        .map_err(|error| map_provider_error(error, operation))?;
        bc_ai_provider::limits::validate_string(
            "model display name",
            &model.name,
            MAX_MODEL_DISPLAY_NAME_BYTES,
        )
        .map_err(|error| map_provider_error(error, operation))?;
    }
    Ok(())
}

struct BoundedExportWriter {
    bytes: Vec<u8>,
    exceeded_at: Option<usize>,
}

impl BoundedExportWriter {
    fn new() -> Self {
        Self {
            bytes: Vec::new(),
            exceeded_at: None,
        }
    }
}

impl Write for BoundedExportWriter {
    fn write(&mut self, buffer: &[u8]) -> io::Result<usize> {
        let actual = self.bytes.len().saturating_add(buffer.len());
        if actual > MAX_CONVERSATION_EXPORT_BYTES {
            self.exceeded_at = Some(actual);
            return Err(io::Error::new(
                io::ErrorKind::FileTooLarge,
                "conversation export limit exceeded",
            ));
        }
        self.bytes.extend_from_slice(buffer);
        Ok(buffer.len())
    }

    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

// ─── Provider Management ───────────────────────────────────────────────────

/// List all supported provider kinds and which ones are configured.
#[tauri::command]
pub async fn ai_list_providers(
    agent: State<'_, AgentManager>,
) -> Result<Vec<ProviderStatus>, AiCommandError> {
    let configured = agent.configured_providers().await;
    let all = vec![
        ProviderKind::OpenAi,
        ProviderKind::Anthropic,
        ProviderKind::Ollama,
    ];
    let statuses = all
        .into_iter()
        .map(|kind| ProviderStatus {
            kind: kind.clone(),
            configured: configured.contains(&kind),
        })
        .collect();
    Ok(statuses)
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderStatus {
    pub kind: ProviderKind,
    pub configured: bool,
}

/// Configure (or reconfigure) a provider with the given settings.
#[tauri::command]
pub async fn ai_configure_provider(
    agent: State<'_, AgentManager>,
    config: ProviderConfig,
) -> Result<(), AiCommandError> {
    config
        .validate()
        .map_err(|error| map_provider_error(error, "ai:configure_provider"))?;
    run_bounded_command(
        agent.configure_provider(config),
        PROVIDER_COMMAND_TIMEOUT,
        "ai:configure_provider",
        |error| map_agent_error(error, "ai:configure_provider"),
    )
    .await
}

/// Test a provider connection (health check + list models).
#[tauri::command]
pub async fn ai_test_provider(
    agent: State<'_, AgentManager>,
    kind: ProviderKind,
) -> Result<Vec<Model>, AiCommandError> {
    let provider = agent.provider(&kind).await.ok_or_else(|| {
        map_provider_error(
            AiProviderError::NotConfigured(kind.to_string()),
            "ai:test_provider",
        )
    })?;

    run_bounded_command(
        provider.health_check(),
        PROVIDER_COMMAND_TIMEOUT,
        "ai:test_provider",
        |error| map_provider_error(error, "ai:test_provider"),
    )
    .await?;

    let models = run_bounded_command(
        provider.list_models(),
        PROVIDER_COMMAND_TIMEOUT,
        "ai:test_provider",
        |error| map_provider_error(error, "ai:test_provider"),
    )
    .await?;
    validate_models(&models, "ai:test_provider")?;
    Ok(models)
}

/// List available models for a configured provider.
#[tauri::command]
pub async fn ai_list_models(
    agent: State<'_, AgentManager>,
    kind: ProviderKind,
) -> Result<Vec<Model>, AiCommandError> {
    let provider = agent.provider(&kind).await.ok_or_else(|| {
        map_provider_error(
            AiProviderError::NotConfigured(kind.to_string()),
            "ai:list_models",
        )
    })?;

    let models = run_bounded_command(
        provider.list_models(),
        PROVIDER_COMMAND_TIMEOUT,
        "ai:list_models",
        |error| map_provider_error(error, "ai:list_models"),
    )
    .await?;
    validate_models(&models, "ai:list_models")?;
    Ok(models)
}

// ─── Agent Configuration ───────────────────────────────────────────────────

/// Get current agent configuration.
#[tauri::command]
pub async fn ai_get_config(agent: State<'_, AgentManager>) -> Result<AgentConfig, AiCommandError> {
    Ok(agent.agent_config().await)
}

async fn set_config_inner(agent: &AgentManager, config: AgentConfig) -> Result<(), AiCommandError> {
    agent
        .try_set_agent_config(config)
        .await
        .map_err(|error| map_agent_error(error, "ai:set_config"))
}

/// Update agent configuration.
#[tauri::command]
pub async fn ai_set_config(
    agent: State<'_, AgentManager>,
    config: AgentConfig,
) -> Result<(), AiCommandError> {
    set_config_inner(&agent, config).await
}

// ─── Conversation Management ───────────────────────────────────────────────

async fn create_conversation_inner(
    agent: &AgentManager,
    provider: ProviderKind,
    model: String,
    title: Option<String>,
    system_prompt: Option<String>,
) -> Result<ConversationMeta, AiCommandError> {
    agent
        .chat
        .try_create_conversation(provider, model, title, system_prompt)
        .await
        .map_err(|error| map_chat_error(error, "ai:create_conversation"))
}

/// Create a new conversation.
#[tauri::command]
pub async fn ai_create_conversation(
    agent: State<'_, AgentManager>,
    provider: ProviderKind,
    model: String,
    title: Option<String>,
    system_prompt: Option<String>,
) -> Result<ConversationMeta, AiCommandError> {
    create_conversation_inner(&agent, provider, model, title, system_prompt).await
}

/// List all conversations (metadata only).
#[tauri::command]
pub async fn ai_list_conversations(
    agent: State<'_, AgentManager>,
) -> Result<Vec<ConversationMeta>, AiCommandError> {
    Ok(agent.chat.list_conversations().await)
}

/// Get a full conversation with all messages.
#[tauri::command]
pub async fn ai_get_conversation(
    agent: State<'_, AgentManager>,
    id: Uuid,
) -> Result<bc_ai_chat::Conversation, AiCommandError> {
    agent
        .chat
        .get_conversation(id)
        .await
        .ok_or_else(|| map_chat_error(ChatError::ConversationNotFound(id), "ai:get_conversation"))
}

/// Delete a conversation.
#[tauri::command]
pub async fn ai_delete_conversation(
    agent: State<'_, AgentManager>,
    id: Uuid,
) -> Result<bool, AiCommandError> {
    Ok(agent.chat.delete_conversation(id).await)
}

async fn set_conversation_title_inner(
    agent: &AgentManager,
    id: Uuid,
    title: String,
) -> Result<bool, AiCommandError> {
    bc_ai_provider::limits::validate_string(
        "conversation title",
        &title,
        bc_ai_chat::limits::MAX_TITLE_BYTES,
    )
    .map_err(|error| map_provider_error(error, "ai:set_conversation_title"))?;
    agent
        .chat
        .try_set_title(id, title)
        .await
        .map_err(|error| map_chat_error(error, "ai:set_conversation_title"))?;
    Ok(true)
}

/// Update conversation title.
#[tauri::command]
pub async fn ai_set_conversation_title(
    agent: State<'_, AgentManager>,
    id: Uuid,
    title: String,
) -> Result<bool, AiCommandError> {
    set_conversation_title_inner(&agent, id, title).await
}

// ─── Messaging ─────────────────────────────────────────────────────────────

async fn start_message_inner(
    agent: &AgentManager,
    conversation_id: Uuid,
    text: String,
    provider: ProviderKind,
) -> Result<(Uuid, mpsc::Receiver<AgentEvent>), AiCommandError> {
    bc_ai_provider::limits::validate_string(
        "user message",
        &text,
        bc_ai_provider::limits::MAX_MESSAGE_BYTES,
    )
    .map_err(|error| map_provider_error(error, "ai:send_message"))?;
    if agent.provider(&provider).await.is_none() {
        return Err(map_provider_error(
            AiProviderError::NotConfigured(provider.to_string()),
            "ai:send_message",
        ));
    }
    agent
        .agent_config()
        .await
        .validate()
        .map_err(|error| map_agent_error(error, "ai:send_message"))?;

    let user_msg = ChatMessage::user(text);
    let user_msg_id = user_msg.id;
    agent
        .chat
        .try_push_message(conversation_id, user_msg)
        .await
        .map_err(|error| map_chat_error(error, "ai:send_message"))?;
    let receiver = agent
        .send_message(conversation_id, provider)
        .await
        .map_err(|error| map_agent_error(error, "ai:send_message"))?;
    Ok((user_msg_id, receiver))
}

/// Send a user message and start the agent loop.
///
/// The response streams back via Tauri events on channel `ai:event`.
#[tauri::command]
pub async fn ai_send_message(
    app: AppHandle,
    agent: State<'_, AgentManager>,
    conversation_id: Uuid,
    text: String,
    provider: ProviderKind,
) -> Result<Uuid, AiCommandError> {
    let (user_msg_id, mut rx) =
        start_message_inner(&agent, conversation_id, text, provider).await?;

    // Spawn a task to forward events to the frontend
    let app_clone = app.clone();
    tokio::spawn(async move {
        while let Some(event) = rx.recv().await {
            if app_clone.emit("ai:event", &event).is_err() {
                break;
            }
        }
    });

    Ok(user_msg_id)
}

/// Approve a pending tool call.
async fn approve_tool_call_inner(
    agent: &AgentManager,
    conversation_id: Uuid,
    tool_call_id: String,
) -> Result<(), AiCommandError> {
    bc_ai_provider::limits::validate_string(
        "tool-call id",
        &tool_call_id,
        bc_ai_provider::limits::MAX_TOOL_CALL_ID_BYTES,
    )
    .map_err(|error| map_provider_error(error, "ai:approve_tool_call"))?;
    agent
        .approve_tool_call(&tool_call_id, conversation_id)
        .await
        .map_err(|error| map_agent_error(error, "ai:approve_tool_call"))
}

#[tauri::command]
pub async fn ai_approve_tool_call(
    agent: State<'_, AgentManager>,
    conversation_id: Uuid,
    tool_call_id: String,
) -> Result<(), AiCommandError> {
    approve_tool_call_inner(&agent, conversation_id, tool_call_id).await
}

/// Cancel an in-progress generation.
#[tauri::command]
pub async fn ai_cancel_generation(
    agent: State<'_, AgentManager>,
    conversation_id: Uuid,
) -> Result<bool, AiCommandError> {
    agent
        .cancel(conversation_id)
        .await
        .map_err(|error| map_agent_error(error, "ai:cancel_generation"))
}

// ─── Presets ───────────────────────────────────────────────────────────────

/// List available agent persona presets.
#[tauri::command]
pub async fn ai_list_presets() -> Result<Vec<bc_ai_agent::presets::Preset>, AiCommandError> {
    Ok(bc_ai_agent::presets::available_presets())
}

/// Get a specific preset by ID.
#[tauri::command]
pub async fn ai_get_preset(id: String) -> Result<bc_ai_agent::presets::Preset, AiCommandError> {
    bc_ai_provider::limits::validate_string(
        "preset id",
        &id,
        bc_ai_agent::config::MAX_PRESET_BYTES,
    )
    .map_err(|error| map_provider_error(error, "ai:get_preset"))?;
    bc_ai_agent::presets::get_preset(&id).ok_or_else(|| {
        AiCommandError::new(
            "AI_PRESET_NOT_FOUND",
            "The AI preset was not found.",
            "ai:get_preset",
        )
    })
}

// ─── Export ────────────────────────────────────────────────────────────────

/// Export a conversation to JSON.
#[tauri::command]
pub async fn ai_export_conversation(
    agent: State<'_, AgentManager>,
    id: Uuid,
) -> Result<String, AiCommandError> {
    let conv = agent.chat.get_conversation(id).await.ok_or_else(|| {
        map_chat_error(
            ChatError::ConversationNotFound(id),
            "ai:export_conversation",
        )
    })?;

    let mut writer = BoundedExportWriter::new();
    if serde_json::to_writer_pretty(&mut writer, &conv).is_err() {
        if let Some(actual) = writer.exceeded_at {
            return Err(AiCommandError::limit(
                "conversation export",
                MAX_CONVERSATION_EXPORT_BYTES,
                actual,
                "ai:export_conversation",
            ));
        }
        return Err(AiCommandError::new(
            "AI_EXPORT_SERIALIZATION",
            "The AI conversation could not be exported safely.",
            "ai:export_conversation",
        ));
    }
    String::from_utf8(writer.bytes).map_err(|_| {
        AiCommandError::new(
            "AI_EXPORT_ENCODING",
            "The AI conversation export was not valid UTF-8.",
            "ai:export_conversation",
        )
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    async fn create_valid_conversation(agent: &AgentManager) -> Uuid {
        create_conversation_inner(
            agent,
            ProviderKind::Ollama,
            "bounded-model".into(),
            Some("Bounded conversation".into()),
            None,
        )
        .await
        .expect("conversation")
        .id
    }

    #[tokio::test]
    async fn invalid_agent_config_is_not_reported_as_success() {
        let agent = AgentManager::default();
        let original = agent.agent_config().await;
        let mut invalid = original.clone();
        invalid.max_tool_rounds = bc_ai_agent::config::MAX_TOOL_ROUNDS + 1;

        let error = set_config_inner(&agent, invalid)
            .await
            .expect_err("invalid config must fail");
        assert_eq!(error.code, "AI_VALIDATION");
        assert_eq!(error.details.field, Some("maxToolRounds"));
        assert_eq!(
            agent.agent_config().await.max_tool_rounds,
            original.max_tool_rounds
        );
    }

    #[tokio::test]
    async fn provider_command_timeout_is_structured_and_retryable() {
        let error = run_bounded_command(
            std::future::pending::<Result<(), AiProviderError>>(),
            Duration::from_millis(1),
            "ai:test_provider",
            |error| map_provider_error(error, "ai:test_provider"),
        )
        .await
        .expect_err("pending provider command must time out");

        assert_eq!(error.code, "AI_TIMEOUT");
        assert_eq!(error.details.kind, Some("timeout"));
        assert!(error.retryable);
    }

    #[tokio::test]
    async fn oversized_conversation_is_not_replaced_with_fallback_success() {
        let agent = AgentManager::default();
        let error = create_conversation_inner(
            &agent,
            ProviderKind::Ollama,
            "m".repeat(bc_ai_provider::limits::MAX_MODEL_BYTES + 1),
            None,
            None,
        )
        .await
        .expect_err("oversized model must fail");

        assert_eq!(error.code, "AI_LIMIT_EXCEEDED");
        assert_eq!(error.details.resource, Some("conversation model"));
        assert_eq!(agent.chat.count().await, 0);
    }

    #[tokio::test]
    async fn oversized_message_is_rejected_before_provider_lookup_or_retention() {
        let agent = AgentManager::default();
        let conversation_id = create_valid_conversation(&agent).await;
        let error = start_message_inner(
            &agent,
            conversation_id,
            "x".repeat(bc_ai_provider::limits::MAX_MESSAGE_BYTES + 1),
            ProviderKind::Ollama,
        )
        .await
        .expect_err("oversized message must fail before provider lookup");

        assert_eq!(error.code, "AI_LIMIT_EXCEEDED");
        assert_eq!(error.details.resource, Some("user message"));
        assert!(agent
            .chat
            .get_conversation(conversation_id)
            .await
            .expect("conversation")
            .messages
            .is_empty());
    }

    #[tokio::test]
    async fn oversized_title_is_not_hidden_as_false_success() {
        let agent = AgentManager::default();
        let conversation_id = create_valid_conversation(&agent).await;
        let original = agent
            .chat
            .get_conversation(conversation_id)
            .await
            .expect("conversation")
            .title;
        let error = set_conversation_title_inner(
            &agent,
            conversation_id,
            "t".repeat(bc_ai_chat::limits::MAX_TITLE_BYTES + 1),
        )
        .await
        .expect_err("oversized title must fail");

        assert_eq!(error.code, "AI_LIMIT_EXCEEDED");
        assert_eq!(error.details.resource, Some("conversation title"));
        assert_eq!(
            agent
                .chat
                .get_conversation(conversation_id)
                .await
                .expect("conversation")
                .title,
            original
        );
    }

    #[tokio::test]
    async fn oversized_tool_call_id_is_rejected_before_conversation_lookup() {
        let agent = AgentManager::default();
        let error = approve_tool_call_inner(
            &agent,
            Uuid::new_v4(),
            "x".repeat(bc_ai_provider::limits::MAX_TOOL_CALL_ID_BYTES + 1),
        )
        .await
        .expect_err("oversized tool-call id must fail before lookup");

        assert_eq!(error.code, "AI_LIMIT_EXCEEDED");
        assert_eq!(error.details.resource, Some("tool-call id"));
    }

    #[test]
    fn provider_errors_keep_structure_without_exposing_server_secrets() {
        let error = map_provider_error(
            AiProviderError::Api {
                status: 401,
                message: "Authorization: Bearer super-secret token=also-secret".into(),
                provider_code: Some("secret-code".into()),
            },
            "ai:test_provider",
        );
        let serialized = serde_json::to_string(&error).expect("serialize");
        assert_eq!(error.code, "AI_PROVIDER");
        assert_eq!(error.details.status, Some(401));
        assert!(!serialized.contains("super-secret"));
        assert!(!serialized.contains("also-secret"));
        assert!(!serialized.contains("secret-code"));
    }
}
