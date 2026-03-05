//! Tauri commands for the AI assistant subsystem.
//!
//! Thin delegates that forward requests to the underlying AI crates.

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, State};
use uuid::Uuid;

use bc_ai_agent::{AgentConfig, AgentManager};
use bc_ai_chat::{ChatMessage, ConversationMeta};
use bc_ai_provider::{Model, ProviderConfig, ProviderKind};

// ─── Provider Management ───────────────────────────────────────────────────

/// List all supported provider kinds and which ones are configured.
#[tauri::command]
pub async fn ai_list_providers(
    agent: State<'_, AgentManager>,
) -> Result<Vec<ProviderStatus>, String> {
    let configured = agent.configured_providers().await;
    let all = vec![ProviderKind::OpenAi, ProviderKind::Anthropic, ProviderKind::Ollama];
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
) -> Result<(), String> {
    agent.configure_provider(config).await
}

/// Test a provider connection (health check + list models).
#[tauri::command]
pub async fn ai_test_provider(
    agent: State<'_, AgentManager>,
    kind: ProviderKind,
) -> Result<Vec<Model>, String> {
    let provider = agent
        .provider(&kind)
        .await
        .ok_or_else(|| format!("Provider {:?} not configured", kind))?;

    provider
        .health_check()
        .await
        .map_err(|e| format!("Health check failed: {e}"))?;

    provider
        .list_models()
        .await
        .map_err(|e| format!("Failed to list models: {e}"))
}

/// List available models for a configured provider.
#[tauri::command]
pub async fn ai_list_models(
    agent: State<'_, AgentManager>,
    kind: ProviderKind,
) -> Result<Vec<Model>, String> {
    let provider = agent
        .provider(&kind)
        .await
        .ok_or_else(|| format!("Provider {:?} not configured", kind))?;

    provider
        .list_models()
        .await
        .map_err(|e| format!("Failed to list models: {e}"))
}

// ─── Agent Configuration ───────────────────────────────────────────────────

/// Get current agent configuration.
#[tauri::command]
pub async fn ai_get_config(
    agent: State<'_, AgentManager>,
) -> Result<AgentConfig, String> {
    Ok(agent.agent_config().await)
}

/// Update agent configuration.
#[tauri::command]
pub async fn ai_set_config(
    agent: State<'_, AgentManager>,
    config: AgentConfig,
) -> Result<(), String> {
    agent.set_agent_config(config).await;
    Ok(())
}

// ─── Conversation Management ───────────────────────────────────────────────

/// Create a new conversation.
#[tauri::command]
pub async fn ai_create_conversation(
    agent: State<'_, AgentManager>,
    provider: ProviderKind,
    model: String,
    title: Option<String>,
    system_prompt: Option<String>,
) -> Result<ConversationMeta, String> {
    Ok(agent
        .chat
        .create_conversation(provider, model, title, system_prompt)
        .await)
}

/// List all conversations (metadata only).
#[tauri::command]
pub async fn ai_list_conversations(
    agent: State<'_, AgentManager>,
) -> Result<Vec<ConversationMeta>, String> {
    Ok(agent.chat.list_conversations().await)
}

/// Get a full conversation with all messages.
#[tauri::command]
pub async fn ai_get_conversation(
    agent: State<'_, AgentManager>,
    id: Uuid,
) -> Result<bc_ai_chat::Conversation, String> {
    agent
        .chat
        .get_conversation(id)
        .await
        .ok_or_else(|| "Conversation not found".into())
}

/// Delete a conversation.
#[tauri::command]
pub async fn ai_delete_conversation(
    agent: State<'_, AgentManager>,
    id: Uuid,
) -> Result<bool, String> {
    Ok(agent.chat.delete_conversation(id).await)
}

/// Update conversation title.
#[tauri::command]
pub async fn ai_set_conversation_title(
    agent: State<'_, AgentManager>,
    id: Uuid,
    title: String,
) -> Result<bool, String> {
    Ok(agent.chat.set_title(id, title).await)
}

// ─── Messaging ─────────────────────────────────────────────────────────────

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
) -> Result<Uuid, String> {
    // Push the user message
    let user_msg = ChatMessage::user(&text);
    let user_msg_id = user_msg.id;
    agent.chat.push_message(conversation_id, user_msg).await;

    // Start the agent loop — it returns a receiver for events
    let mut rx = agent.send_message(conversation_id, provider).await?;

    // Spawn a task to forward events to the frontend
    let app_clone = app.clone();
    tokio::spawn(async move {
        while let Some(event) = rx.recv().await {
            let _ = app_clone.emit("ai:event", &event);
        }
    });

    Ok(user_msg_id)
}

/// Approve a pending tool call.
#[tauri::command]
pub async fn ai_approve_tool_call(
    agent: State<'_, AgentManager>,
    conversation_id: Uuid,
    tool_call_id: String,
) -> Result<(), String> {
    agent
        .approve_tool_call(&tool_call_id, conversation_id)
        .await
}

/// Cancel an in-progress generation.
#[tauri::command]
pub async fn ai_cancel_generation(
    agent: State<'_, AgentManager>,
    conversation_id: Uuid,
) -> Result<bool, String> {
    Ok(agent.cancel(conversation_id).await)
}

// ─── Presets ───────────────────────────────────────────────────────────────

/// List available agent persona presets.
#[tauri::command]
pub async fn ai_list_presets() -> Result<Vec<bc_ai_agent::presets::Preset>, String> {
    Ok(bc_ai_agent::presets::available_presets())
}

/// Get a specific preset by ID.
#[tauri::command]
pub async fn ai_get_preset(id: String) -> Result<bc_ai_agent::presets::Preset, String> {
    bc_ai_agent::presets::get_preset(&id)
        .ok_or_else(|| format!("Preset '{}' not found", id))
}

// ─── Export ────────────────────────────────────────────────────────────────

/// Export a conversation to JSON.
#[tauri::command]
pub async fn ai_export_conversation(
    agent: State<'_, AgentManager>,
    id: Uuid,
) -> Result<String, String> {
    let conv = agent
        .chat
        .get_conversation(id)
        .await
        .ok_or_else(|| "Conversation not found".to_string())?;

    serde_json::to_string_pretty(&conv).map_err(|e| e.to_string())
}
