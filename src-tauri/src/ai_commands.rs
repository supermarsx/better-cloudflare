//! Tauri commands for the AI assistant subsystem.
//!
//! Bounded delegates that preserve structured, secret-safe failures.

use std::collections::BTreeMap;
use std::future::Future;
use std::io::{self, Write};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, State};
use tokio::sync::mpsc;
use uuid::Uuid;

use bc_ai_agent::personas::{AiPersona, AiPersonaInput, MAX_PERSONA_ID_BYTES};
use bc_ai_agent::{AgentConfig, AgentError, AgentEvent, AgentManager};
use bc_ai_chat::{ChatError, ChatMessage, ConversationMeta};
use bc_ai_provider::{
    AdvancedField, AiProviderError, AiProviderProfile, AiProviderProfileInput, Model,
    MAX_PROVIDER_ID_BYTES,
};
use bc_ai_tools::permissions::{
    AiPermissionMode, AiPermissions, AiToolDescriptor, AiToolPermission, ToolAvailability,
};
use bc_ai_tools::ToolExecutionError;
use bc_error::sanitize_error_text;

/// Every AI command, checked against the invoke handler by a test in
/// `main.rs`. A command the renderer is written against but that was never
/// registered fails only at runtime, so the list is asserted at build time.
#[cfg(test)]
pub const COMMAND_NAMES: [&str; 25] = [
    "ai_list_providers",
    "ai_configure_provider",
    "ai_delete_provider",
    "ai_test_provider",
    "ai_list_models",
    "ai_get_config",
    "ai_set_config",
    "ai_protocol_capabilities",
    "ai_create_conversation",
    "ai_list_conversations",
    "ai_get_conversation",
    "ai_delete_conversation",
    "ai_set_conversation_title",
    "ai_send_message",
    "ai_approve_tool_call",
    "ai_cancel_generation",
    "ai_list_presets",
    "ai_get_preset",
    "ai_get_permissions",
    "ai_set_permissions",
    "ai_list_personas",
    "ai_create_persona",
    "ai_update_persona",
    "ai_delete_persona",
    "ai_export_conversation",
];

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
        // The streaming path bounds only the wait for a response head, so it
        // reports its own timeout; a one-shot call times out through reqwest
        // and lands in the arm below. Both are the same failure to a user.
        AiProviderError::Timeout { .. } => AiCommandError::timeout(operation),
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
        AgentError::InvalidConfig { field, message }
        | AgentError::InvalidPersona { field, message } => {
            AiCommandError::validation(field, message, operation)
        }
        AgentError::PersonaNotFound => AiCommandError::new(
            "AI_PERSONA_NOT_FOUND",
            "The AI persona was not found.",
            operation,
        ),
        AgentError::PersonaImmutable => {
            let mut error = AiCommandError::new(
                "AI_PERSONA_IMMUTABLE",
                "Built-in AI personas cannot be changed or removed.",
                operation,
            );
            error.details.remediation = Some("Create a custom persona instead.");
            error
        }
        AgentError::PersonaLimit { limit, actual } => {
            AiCommandError::limit("custom personas", limit, actual, operation)
        }
        AgentError::ToolDenied { reason } => {
            let mut error = AiCommandError::new("AI_TOOL_DENIED", reason, operation);
            error.details.kind = Some("permission_denied");
            error.details.remediation =
                Some("Allow the tool in the AI permission settings, then retry.");
            error
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

/// Every configured provider profile, in id order.
///
/// The returned [`AiProviderProfile`] has no key field of any kind, so this
/// cannot echo a credential back even for a profile that holds one — only
/// `hasApiKey`.
#[tauri::command]
pub async fn ai_list_providers(
    agent: State<'_, AgentManager>,
) -> Result<Vec<AiProviderProfile>, AiCommandError> {
    Ok(agent.list_provider_profiles().await)
}

/// Create or update a provider profile, and verify it in the same call.
///
/// An input with no `id` creates a profile under a generated id; an input
/// naming an `id` updates that profile. `apiKey` is three-state: absent keeps
/// the stored key, `null` clears it, a string replaces it.
#[tauri::command]
pub async fn ai_configure_provider(
    agent: State<'_, AgentManager>,
    profile: AiProviderProfileInput,
) -> Result<AiProviderProfile, AiCommandError> {
    run_bounded_command(
        agent.configure_provider_profile(profile),
        PROVIDER_COMMAND_TIMEOUT,
        "ai:configure_provider",
        |error| map_agent_error(error, "ai:configure_provider"),
    )
    .await
}

/// Delete a provider profile. Resolves `false` when no such profile exists.
///
/// The selection and any live generation are cleaned up with it; see
/// `AgentManager::delete_provider_profile`.
#[tauri::command]
pub async fn ai_delete_provider(
    agent: State<'_, AgentManager>,
    id: String,
) -> Result<bool, AiCommandError> {
    delete_provider_inner(&agent, id).await
}

async fn delete_provider_inner(agent: &AgentManager, id: String) -> Result<bool, AiCommandError> {
    validate_provider_id_bounds(&id, "ai:delete_provider")?;
    agent
        .delete_provider_profile(&id)
        .await
        .map_err(|error| map_agent_error(error, "ai:delete_provider"))
}

/// Reject an oversized id before it is used as a lookup key, so the limit is
/// reported as a limit rather than as a validation failure deeper in.
fn validate_provider_id_bounds(id: &str, operation: &'static str) -> Result<(), AiCommandError> {
    bc_ai_provider::limits::validate_string("provider id", id, MAX_PROVIDER_ID_BYTES)
        .map_err(|error| map_provider_error(error, operation))
}

async fn provider_for_id(
    agent: &AgentManager,
    id: &str,
    operation: &'static str,
) -> Result<std::sync::Arc<dyn bc_ai_provider::AiProvider + Send + Sync>, AiCommandError> {
    validate_provider_id_bounds(id, operation)?;
    agent.provider(id).await.ok_or_else(|| {
        map_provider_error(AiProviderError::NotConfigured(id.to_string()), operation)
    })
}

/// Test one profile's connection (health check + list models).
#[tauri::command]
pub async fn ai_test_provider(
    agent: State<'_, AgentManager>,
    id: String,
) -> Result<Vec<Model>, AiCommandError> {
    let provider = provider_for_id(&agent, &id, "ai:test_provider").await?;

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

/// List available models for one configured profile.
#[tauri::command]
pub async fn ai_list_models(
    agent: State<'_, AgentManager>,
    id: String,
) -> Result<Vec<Model>, AiCommandError> {
    let provider = provider_for_id(&agent, &id, "ai:list_models").await?;

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

/// Which advanced generation controls each provider protocol honours.
///
/// A configured control the selected provider cannot take is omitted from its
/// request rather than sent and rejected — so the renderer needs this to mark
/// the setting inapplicable instead of showing a value that does nothing. The
/// answer is derived from the same per-protocol table the clients build their
/// request bodies from, so the two cannot disagree.
///
/// Keys are protocol wire spellings (`openai`, `anthropic`, `ollama`); values
/// are camelCase control names (`topP`, `topK`, `stop`, `seed`,
/// `frequencyPenalty`, `presencePenalty`).
#[tauri::command]
pub async fn ai_protocol_capabilities(
) -> Result<BTreeMap<&'static str, Vec<AdvancedField>>, AiCommandError> {
    Ok(bc_ai_provider::protocol_capabilities())
}

// ─── Conversation Management ───────────────────────────────────────────────

async fn create_conversation_inner(
    agent: &AgentManager,
    provider: String,
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
///
/// `provider` is a provider profile id: the transcript records which
/// connection it belongs to, and a send with no `providerId` prefers it. A
/// conversation may name a profile that is not configured (or no longer is);
/// that is reported at send time, not here.
#[tauri::command]
pub async fn ai_create_conversation(
    agent: State<'_, AgentManager>,
    provider: String,
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
    provider_id: Option<String>,
) -> Result<(Uuid, mpsc::Receiver<AgentEvent>), AiCommandError> {
    bc_ai_provider::limits::validate_string(
        "user message",
        &text,
        bc_ai_provider::limits::MAX_MESSAGE_BYTES,
    )
    .map_err(|error| map_provider_error(error, "ai:send_message"))?;
    if let Some(id) = &provider_id {
        validate_provider_id_bounds(id, "ai:send_message")?;
    }
    // An absent id means "use the configured default"; nothing here falls
    // through to an arbitrary configured provider.
    let provider_id = agent
        .resolve_provider_id(Some(conversation_id), provider_id)
        .await
        .map_err(|error| map_agent_error(error, "ai:send_message"))?;
    if agent.provider(&provider_id).await.is_none() {
        return Err(map_provider_error(
            AiProviderError::NotConfigured(provider_id),
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
        .send_message(conversation_id, &provider_id)
        .await
        .map_err(|error| map_agent_error(error, "ai:send_message"))?;
    Ok((user_msg_id, receiver))
}

/// Send a user message and start the agent loop.
///
/// `providerId` names the profile to send through; omitting it uses the
/// configured `defaultProviderId`, and failing both is an error rather than a
/// guess. The response streams back via Tauri events on channel `ai:event`.
#[tauri::command]
pub async fn ai_send_message(
    app: AppHandle,
    agent: State<'_, AgentManager>,
    conversation_id: Uuid,
    text: String,
    provider_id: Option<String>,
) -> Result<Uuid, AiCommandError> {
    let (user_msg_id, mut rx) =
        start_message_inner(&agent, conversation_id, text, provider_id).await?;

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

// ─── Permissions ───────────────────────────────────────────────────────────

/// Current permission configuration plus the resolved tool catalogue.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiPermissionsView {
    pub mode: AiPermissionMode,
    pub tools: std::collections::BTreeMap<String, AiToolPermission>,
    /// Every registered tool with its *effective* permission already resolved.
    pub catalog: Vec<AiToolDescriptor>,
    /// Whether tool dispatch is possible at all right now, and over how many
    /// tools. The catalogue describes the assistant's own permissions; dispatch
    /// is also gated on the application's MCP grants, which the renderer cannot
    /// resolve for itself.
    pub availability: ToolAvailability,
}

async fn get_permissions_inner(agent: &AgentManager) -> AiPermissionsView {
    let permissions = agent.permissions().await;
    AiPermissionsView {
        mode: permissions.mode,
        tools: permissions.tools,
        catalog: agent.tool_catalog().await,
        availability: agent.tool_availability().await,
    }
}

/// Read the tool permission configuration and the resolved catalogue.
#[tauri::command]
pub async fn ai_get_permissions(
    agent: State<'_, AgentManager>,
) -> Result<AiPermissionsView, AiCommandError> {
    Ok(get_permissions_inner(&agent).await)
}

async fn set_permissions_inner(
    agent: &AgentManager,
    permissions: AiPermissions,
) -> Result<AiPermissions, AiCommandError> {
    agent
        .try_set_permissions(permissions)
        .await
        .map_err(|error| map_agent_error(error, "ai:set_permissions"))
}

/// Replace the tool permission configuration. Enforcement is server-side: the
/// stored value is what the dispatch boundary consults on the next tool call.
#[tauri::command]
pub async fn ai_set_permissions(
    agent: State<'_, AgentManager>,
    permissions: AiPermissions,
) -> Result<AiPermissions, AiCommandError> {
    set_permissions_inner(&agent, permissions).await
}

// ─── Personas ──────────────────────────────────────────────────────────────

/// List personas: builtins first, then custom ones in creation order.
#[tauri::command]
pub async fn ai_list_personas(
    agent: State<'_, AgentManager>,
) -> Result<Vec<AiPersona>, AiCommandError> {
    Ok(agent.list_personas().await)
}

async fn create_persona_inner(
    agent: &AgentManager,
    persona: AiPersonaInput,
) -> Result<AiPersona, AiCommandError> {
    agent
        .create_persona(persona)
        .await
        .map_err(|error| map_agent_error(error, "ai:create_persona"))
}

/// Create a custom persona. The id is issued here, never supplied.
#[tauri::command]
pub async fn ai_create_persona(
    agent: State<'_, AgentManager>,
    persona: AiPersonaInput,
) -> Result<AiPersona, AiCommandError> {
    create_persona_inner(&agent, persona).await
}

fn validate_persona_id(id: &str, operation: &'static str) -> Result<(), AiCommandError> {
    bc_ai_provider::limits::validate_string("persona id", id, MAX_PERSONA_ID_BYTES)
        .map_err(|error| map_provider_error(error, operation))
}

async fn update_persona_inner(
    agent: &AgentManager,
    id: String,
    persona: AiPersonaInput,
) -> Result<AiPersona, AiCommandError> {
    validate_persona_id(&id, "ai:update_persona")?;
    agent
        .update_persona(&id, persona)
        .await
        .map_err(|error| map_agent_error(error, "ai:update_persona"))
}

/// Update a custom persona. Built-in ids are refused.
#[tauri::command]
pub async fn ai_update_persona(
    agent: State<'_, AgentManager>,
    id: String,
    persona: AiPersonaInput,
) -> Result<AiPersona, AiCommandError> {
    update_persona_inner(&agent, id, persona).await
}

async fn delete_persona_inner(agent: &AgentManager, id: String) -> Result<bool, AiCommandError> {
    validate_persona_id(&id, "ai:delete_persona")?;
    agent
        .delete_persona(&id)
        .await
        .map_err(|error| map_agent_error(error, "ai:delete_persona"))?;
    Ok(true)
}

/// Delete a custom persona. Built-in ids are refused.
///
/// Resolves `true`; a missing or built-in id is a structured error rather than
/// a quiet `false`, so the caller never mistakes a refusal for a no-op.
#[tauri::command]
pub async fn ai_delete_persona(
    agent: State<'_, AgentManager>,
    id: String,
) -> Result<bool, AiCommandError> {
    delete_persona_inner(&agent, id).await
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
    use bc_ai_tools::permissions::ToolClassification;

    use super::*;

    async fn create_valid_conversation(agent: &AgentManager) -> Uuid {
        create_conversation_inner(
            agent,
            "ollama".into(),
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
            "ollama".into(),
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
            Some("ollama".into()),
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

    fn persona_input(name: &str) -> AiPersonaInput {
        AiPersonaInput {
            name: name.into(),
            description: "Bounded persona".into(),
            system_prompt: "You are bounded.\nBe brief.".into(),
        }
    }

    fn permissions(
        mode: AiPermissionMode,
        overrides: &[(&str, AiToolPermission)],
    ) -> AiPermissions {
        AiPermissions {
            mode,
            tools: overrides
                .iter()
                .map(|(name, permission)| ((*name).to_string(), *permission))
                .collect(),
        }
    }

    fn descriptor<'a>(view: &'a AiPermissionsView, name: &str) -> &'a AiToolDescriptor {
        view.catalog
            .iter()
            .find(|descriptor| descriptor.name == name)
            .expect("tool is registered")
    }

    #[tokio::test]
    async fn permissions_round_trip_with_a_resolved_catalog() {
        let agent = AgentManager::default();
        let stored = set_permissions_inner(
            &agent,
            permissions(
                AiPermissionMode::Ask,
                &[("cf_list_zones", AiToolPermission::Deny)],
            ),
        )
        .await
        .expect("valid permissions");
        assert_eq!(stored.mode, AiPermissionMode::Ask);

        let view = get_permissions_inner(&agent).await;
        assert_eq!(view.mode, AiPermissionMode::Ask);
        assert_eq!(
            view.tools.get("cf_list_zones"),
            Some(&AiToolPermission::Deny)
        );
        assert_eq!(view.catalog.len(), agent.tool_catalog().await.len());

        // The override wins; the mode governs everything it does not name.
        let overridden = descriptor(&view, "cf_list_zones");
        assert_eq!(overridden.permission, AiToolPermission::Deny);
        assert_eq!(overridden.classification, ToolClassification::Read);
        let read = descriptor(&view, "dns_parse_spf");
        assert_eq!(read.permission, AiToolPermission::Allow);
        let write = descriptor(&view, "cf_delete_dns_record");
        assert_eq!(write.permission, AiToolPermission::Ask);
        assert_eq!(write.classification, ToolClassification::Write);
        assert!(!write.description.is_empty());
    }

    #[tokio::test]
    async fn read_only_mode_resolves_writes_to_deny_in_the_catalog() {
        let agent = AgentManager::default();
        set_permissions_inner(&agent, permissions(AiPermissionMode::ReadOnly, &[]))
            .await
            .expect("valid permissions");
        let view = get_permissions_inner(&agent).await;
        assert_eq!(
            descriptor(&view, "cf_delete_dns_record").permission,
            AiToolPermission::Deny
        );
        assert_eq!(
            descriptor(&view, "cf_list_zones").permission,
            AiToolPermission::Allow
        );
    }

    #[tokio::test]
    async fn an_unknown_tool_override_is_rejected_and_not_stored() {
        let agent = AgentManager::default();
        let original = get_permissions_inner(&agent).await;
        let error = set_permissions_inner(
            &agent,
            permissions(
                AiPermissionMode::Autonomous,
                &[("cf_delete_everything", AiToolPermission::Allow)],
            ),
        )
        .await
        .expect_err("an unregistered tool name must be refused");

        assert_eq!(error.code, "AI_VALIDATION");
        assert_eq!(error.details.field, Some("permissions.tools"));
        let current = get_permissions_inner(&agent).await;
        assert_eq!(current.mode, original.mode);
        assert!(current.tools.is_empty());
    }

    #[tokio::test]
    async fn the_permissions_view_is_camel_case_on_the_wire() {
        let agent = AgentManager::default();
        set_permissions_inner(&agent, permissions(AiPermissionMode::ReadOnly, &[]))
            .await
            .expect("valid permissions");
        let value = serde_json::to_value(get_permissions_inner(&agent).await).expect("serializes");

        assert_eq!(value["mode"], "readOnly");
        assert!(value["tools"].is_object());
        let first = &value["catalog"][0];
        for key in ["name", "classification", "description", "permission"] {
            assert!(
                first.get(key).is_some(),
                "catalog entry missing {key}: {first}"
            );
        }
        assert!(first.get("system_prompt").is_none());

        let availability = &value["availability"];
        for key in [
            "dispatchAvailable",
            "grantedToolCount",
            "usableToolCount",
            "registeredToolCount",
        ] {
            assert!(
                availability.get(key).is_some(),
                "availability missing {key}: {availability}"
            );
        }
    }

    /// What the renderer needs to stop guessing: whether tool dispatch is
    /// possible at all, resolved from the application's MCP grants rather than
    /// from the assistant's own permissions.
    #[tokio::test]
    async fn the_permissions_view_reports_availability_from_the_mcp_grants() {
        let mcp = bc_mcp::McpServerManager::default();
        let agent = AgentManager::with_mcp_grants(mcp.grant_handle());

        let before = get_permissions_inner(&agent).await;
        assert!(
            !before.availability.dispatch_available,
            "no grants means no tools, and the UI must be told so"
        );
        assert_eq!(before.availability.granted_tool_count, 0);
        assert!(before.availability.registered_tool_count > 0);
        assert!(
            before
                .catalog
                .iter()
                .any(|descriptor| descriptor.permission != AiToolPermission::Deny),
            "the catalogue still describes the assistant's own permissions, \
             which is why availability has to be reported separately"
        );

        mcp.set_enabled_tools(vec!["cf_list_zones".to_string()])
            .await
            .expect("grants stored");

        let after = get_permissions_inner(&agent).await;
        assert!(after.availability.dispatch_available);
        assert_eq!(after.availability.granted_tool_count, 1);
        assert_eq!(after.availability.usable_tool_count, 1);
    }

    #[tokio::test]
    async fn disabling_tool_use_through_set_config_denies_every_tool() {
        let agent = AgentManager::default();
        let mut config = agent.agent_config().await;
        config.tools_enabled = false;
        set_config_inner(&agent, config)
            .await
            .expect("valid config");

        let view = get_permissions_inner(&agent).await;
        assert!(
            view.catalog
                .iter()
                .all(|descriptor| descriptor.permission == AiToolPermission::Deny),
            "tools_enabled: false must deny everything, not just hide it"
        );
    }

    #[tokio::test]
    async fn the_new_config_fields_are_validated_and_bounded() {
        let agent = AgentManager::default();
        let original = agent.agent_config().await;

        let mut invalid = original.clone();
        invalid.temperature = 2.5;
        let error = set_config_inner(&agent, invalid)
            .await
            .expect_err("out-of-range temperature must fail");
        assert_eq!(error.code, "AI_VALIDATION");
        assert_eq!(error.details.field, Some("temperature"));

        let mut invalid = original.clone();
        invalid.top_p = -0.1;
        let error = set_config_inner(&agent, invalid)
            .await
            .expect_err("out-of-range topP must fail");
        assert_eq!(error.details.field, Some("topP"));

        let mut invalid = original.clone();
        invalid.persona_id = String::new();
        let error = set_config_inner(&agent, invalid)
            .await
            .expect_err("empty persona id must fail");
        assert_eq!(error.details.field, Some("personaId"));

        assert_eq!(agent.agent_config().await.temperature, original.temperature);
        assert_eq!(agent.agent_config().await.persona_id, original.persona_id);

        let mut valid = original;
        valid.temperature = 1.5;
        valid.top_p = 0.25;
        valid.persona_id = "security-auditor".into();
        set_config_inner(&agent, valid).await.expect("valid config");
        let stored = agent.agent_config().await;
        assert_eq!(stored.temperature, 1.5);
        assert_eq!(stored.top_p, 0.25);
        assert_eq!(stored.persona_id, "security-auditor");
    }

    #[tokio::test]
    async fn personas_are_created_listed_updated_and_deleted() {
        let agent = AgentManager::default();
        let builtins = agent.list_personas().await.len();

        let created = create_persona_inner(&agent, persona_input("Mine"))
            .await
            .expect("create");
        assert!(!created.builtin);
        assert!(created.id.starts_with("custom-"));

        let listed = agent.list_personas().await;
        assert_eq!(listed.len(), builtins + 1);
        assert!(listed[0].builtin);

        let updated = update_persona_inner(
            &agent,
            created.id.clone(),
            AiPersonaInput {
                name: "Renamed".into(),
                description: String::new(),
                system_prompt: "Updated prompt.".into(),
            },
        )
        .await
        .expect("update");
        assert_eq!(updated.id, created.id);
        assert_eq!(updated.name, "Renamed");

        delete_persona_inner(&agent, created.id.clone())
            .await
            .expect("delete");
        assert_eq!(agent.list_personas().await.len(), builtins);

        let error = delete_persona_inner(&agent, created.id)
            .await
            .expect_err("a second delete must fail");
        assert_eq!(error.code, "AI_PERSONA_NOT_FOUND");
    }

    #[tokio::test]
    async fn builtin_personas_are_immutable_through_the_commands() {
        let agent = AgentManager::default();
        for id in [
            "default",
            "dns-expert",
            "security-auditor",
            "migration-helper",
        ] {
            let error = update_persona_inner(&agent, id.into(), persona_input("Hijacked"))
                .await
                .expect_err("builtins must not be editable");
            assert_eq!(error.code, "AI_PERSONA_IMMUTABLE");
            let error = delete_persona_inner(&agent, id.into())
                .await
                .expect_err("builtins must not be removable");
            assert_eq!(error.code, "AI_PERSONA_IMMUTABLE");
        }
        let personas = agent.list_personas().await;
        assert!(personas.iter().all(|persona| persona.builtin));
        assert!(personas
            .iter()
            .any(|persona| persona.id == "dns-expert" && persona.name == "Dns Expert"));
    }

    #[tokio::test]
    async fn persona_input_that_would_corrupt_a_prompt_is_refused() {
        let agent = AgentManager::default();
        let cases: Vec<(&'static str, AiPersonaInput)> = vec![
            (
                "name",
                AiPersonaInput {
                    name: "n".repeat(bc_ai_agent::personas::MAX_PERSONA_NAME_BYTES + 1),
                    ..persona_input("x")
                },
            ),
            (
                "systemPrompt",
                AiPersonaInput {
                    system_prompt: "forged\u{0}structure".into(),
                    ..persona_input("x")
                },
            ),
            (
                "systemPrompt",
                AiPersonaInput {
                    system_prompt: "s"
                        .repeat(bc_ai_agent::personas::MAX_PERSONA_SYSTEM_PROMPT_BYTES + 1),
                    ..persona_input("x")
                },
            ),
        ];
        for (field, input) in cases {
            let error = create_persona_inner(&agent, input)
                .await
                .expect_err("invalid persona input must fail");
            assert_eq!(error.code, "AI_VALIDATION");
            assert_eq!(error.details.field, Some(field));
        }
        assert_eq!(agent.personas.custom_count().await, 0);
    }

    #[tokio::test]
    async fn an_oversized_persona_id_is_rejected_before_lookup() {
        let agent = AgentManager::default();
        let error = delete_persona_inner(&agent, "i".repeat(MAX_PERSONA_ID_BYTES + 1))
            .await
            .expect_err("oversized id must fail");
        assert_eq!(error.code, "AI_LIMIT_EXCEEDED");
        assert_eq!(error.details.resource, Some("persona id"));
    }

    #[tokio::test]
    async fn the_custom_persona_count_is_capped() {
        let agent = AgentManager::default();
        for index in 0..bc_ai_agent::personas::MAX_CUSTOM_PERSONAS {
            create_persona_inner(&agent, persona_input(&format!("P{index}")))
                .await
                .expect("within the cap");
        }
        let error = create_persona_inner(&agent, persona_input("one too many"))
            .await
            .expect_err("the cap must hold");
        assert_eq!(error.code, "AI_LIMIT_EXCEEDED");
        assert_eq!(error.details.resource, Some("custom personas"));
    }

    #[test]
    fn a_denied_tool_call_maps_to_a_structured_permission_error() {
        let error = map_agent_error(
            AgentError::ToolDenied {
                reason:
                    "tool 'cf_delete_dns_record' writes, and the assistant is in read-only mode"
                        .into(),
            },
            "ai:approve_tool_call",
        );
        assert_eq!(error.code, "AI_TOOL_DENIED");
        assert_eq!(error.details.kind, Some("permission_denied"));
        assert!(error.message.contains("cf_delete_dns_record"));
    }

    fn profile_input(value: serde_json::Value) -> AiProviderProfileInput {
        serde_json::from_value(value).expect("valid input shape")
    }

    /// The renderer-facing shape of a profile has no key field, so the list
    /// command cannot echo a credential even for a profile that holds one.
    #[tokio::test]
    async fn listing_providers_has_no_field_that_could_carry_a_key() {
        let agent = AgentManager::default();
        assert!(agent.list_provider_profiles().await.is_empty());

        let listed = vec![bc_ai_provider::ProviderProfile::apply(
            "groq-prod".into(),
            None,
            profile_input(serde_json::json!({
                "label": "Groq",
                "protocol": "openai",
                "baseUrl": "https://api.groq.com/openai/v1",
                "model": "llama-3.3-70b-versatile",
                "temperature": 0.7,
                "maxTokens": 1024,
                "apiKey": "gsk-live-SECRET",
            })),
        )
        .expect("valid profile")
        .view()];
        let serialized = serde_json::to_string(&listed).expect("serializes");
        assert!(!serialized.contains("SECRET"), "{serialized}");
        assert!(!serialized.contains("apiKey"), "{serialized}");
        assert!(serialized.contains("\"hasApiKey\":true"), "{serialized}");
    }

    /// A base URL is attacker-influenced input that the backend then sends a
    /// credential to. A refused one must not reach the network or the store.
    #[tokio::test]
    async fn a_profile_pointing_at_a_non_http_scheme_is_refused_and_not_stored() {
        let agent = AgentManager::default();
        for refused in ["file:///etc/passwd", "ftp://example.com", "javascript:x"] {
            let error = agent
                .configure_provider_profile(profile_input(serde_json::json!({
                    "label": "Hostile",
                    "protocol": "openai",
                    "baseUrl": refused,
                    "model": "gpt-4o",
                    "temperature": 0.7,
                    "maxTokens": 1024,
                    "apiKey": "sk-test",
                })))
                .await
                .map_err(|error| map_agent_error(error, "ai:configure_provider"))
                .expect_err("a non-HTTP base URL must be refused");
            assert_eq!(error.code, "AI_VALIDATION");
            assert_eq!(error.details.field, Some("baseUrl"));
        }
        assert!(agent.list_provider_profiles().await.is_empty());
    }

    #[tokio::test]
    async fn deleting_an_unknown_provider_is_false_and_a_malformed_id_is_an_error() {
        let agent = AgentManager::default();
        assert!(!delete_provider_inner(&agent, "not-configured".into())
            .await
            .expect("an unknown id resolves false"),);

        let error = delete_provider_inner(&agent, "i".repeat(MAX_PROVIDER_ID_BYTES + 1))
            .await
            .expect_err("an oversized id must fail");
        assert_eq!(error.code, "AI_LIMIT_EXCEEDED");
        assert_eq!(error.details.resource, Some("provider id"));

        let error = delete_provider_inner(&agent, "../../etc/passwd".into())
            .await
            .expect_err("a malformed id must fail");
        assert_eq!(error.code, "AI_VALIDATION");
        assert_eq!(error.details.field, Some("id"));
    }

    /// With no provider named and no default selected, the send must fail —
    /// not fall through to whatever provider happens to be configured — and it
    /// must fail before the user's message is retained.
    #[tokio::test]
    async fn a_send_without_a_provider_or_a_default_is_refused_before_retention() {
        let agent = AgentManager::default();
        let conversation_id = create_valid_conversation(&agent).await;

        let error = start_message_inner(&agent, conversation_id, "hello".into(), None)
            .await
            .expect_err("no provider and no default must fail");
        assert_eq!(error.code, "AI_NOT_CONFIGURED");

        let error = start_message_inner(
            &agent,
            conversation_id,
            "hello".into(),
            Some("not-configured".into()),
        )
        .await
        .expect_err("an unknown profile must fail");
        assert_eq!(error.code, "AI_NOT_CONFIGURED");

        let error = start_message_inner(
            &agent,
            conversation_id,
            "hello".into(),
            Some("i".repeat(MAX_PROVIDER_ID_BYTES + 1)),
        )
        .await
        .expect_err("an oversized provider id must fail");
        assert_eq!(error.code, "AI_LIMIT_EXCEEDED");
        assert_eq!(error.details.resource, Some("provider id"));

        assert!(agent
            .chat
            .get_conversation(conversation_id)
            .await
            .expect("conversation")
            .messages
            .is_empty());
    }

    /// A conversation's `provider` is a user-supplied profile id now, so it is
    /// bounded text rather than a closed enum the deserializer could vet.
    #[tokio::test]
    async fn a_conversation_cannot_name_a_malformed_provider_profile() {
        let agent = AgentManager::default();
        for refused in ["", "my provider", "../../etc/passwd", &"i".repeat(65)] {
            let error = create_conversation_inner(
                &agent,
                refused.into(),
                "bounded-model".into(),
                None,
                None,
            )
            .await
            .expect_err("a malformed provider id must fail");
            assert_eq!(error.code, "AI_VALIDATION");
            assert_eq!(error.details.field, Some("provider"));
        }
        assert_eq!(agent.chat.count().await, 0);

        // A profile that is not configured is still a legal selection; that is
        // reported when the message is sent, not when the thread is opened.
        create_conversation_inner(
            &agent,
            "not-configured-yet".into(),
            "bounded-model".into(),
            None,
            None,
        )
        .await
        .expect("a well-formed id opens a conversation");
    }

    #[tokio::test]
    async fn the_default_provider_selection_is_validated_and_stored() {
        let agent = AgentManager::default();
        let mut config = agent.agent_config().await;
        assert_eq!(config.default_provider_id, None);

        config.default_provider_id = Some("my provider".into());
        let error = set_config_inner(&agent, config.clone())
            .await
            .expect_err("a malformed default must fail");
        assert_eq!(error.code, "AI_VALIDATION");
        assert_eq!(error.details.field, Some("defaultProviderId"));
        assert_eq!(agent.agent_config().await.default_provider_id, None);

        config.default_provider_id = Some("groq-prod".into());
        set_config_inner(&agent, config).await.expect("valid");
        assert_eq!(
            agent.agent_config().await.default_provider_id.as_deref(),
            Some("groq-prod")
        );
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
